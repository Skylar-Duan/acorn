#!/bin/bash
# acorn-backup.sh — 橡果云同步库（SQLite）每日自动备份
#
# 由 acorn-backup.timer 每天北京 03:40 拉起 acorn-backup.service（oneshot，User=acorn）。
# 安装 / 手动跑一次：deploy/install-backup.sh。照抄 10 的 cdp-pgbackup.sh 的形状（2026-10-07 10 的 INBOX 建议）。
#
# 为什么以 acorn 身份跑：库是 WAL 模式，最后一个连接关闭时 -wal/-shm 会被删掉；
# 若此时 root 打开库，会新建出属主 root 的 -wal/-shm，同步服务（acorn）随即写不进 → 全员同步挂掉。
#
# 做什么（任何一步失败 → 整次失败：删 .part、写 backup.failed，不碰上一份成功的 backup-last.json）：
#   0. 预检：备份盘剩余 ≥ 1GB 且使用率 ≤ 85%
#   1. sqlite3 .backup：SQLite 在线备份 API，同步服务照常读写也能拿到一致快照（不是 cp）
#   2. 校验：PRAGMA integrity_check = ok，并数出每张表的行数（恢复演练拿它对账）
#   3. gzip 压缩 + gzip -t 自检 + sha256
#   4. 保留最近 14 份
#   5. 原子写 /var/lib/acorn-sync/backup-last.json（644）：{last_ok_at, file, size_bytes, sha256, ...}
#      10 的服务器上报脚本直接读它
#
# 恢复：gunzip -c <备份>.db.gz > /tmp/acorn.db，停 acorn-sync，替换 /var/lib/acorn-sync/acorn.db
#       （同时删掉旧的 acorn.db-wal / acorn.db-shm），chown acorn:acorn，再启动。

set -euo pipefail
umask 077
cd /    # 手动 runuser 时当前目录可能是 acorn 进不去的 /root，find 会因此报错退出
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"

DB="${ACORN_DB:-/var/lib/acorn-sync/acorn.db}"
DIR="${ACORN_BACKUP_DIR:-/var/backups/acorn/daily}"
STATE_DIR="${ACORN_BACKUP_STATE_DIR:-/var/lib/acorn-sync}"
LAST_JSON="$STATE_DIR/backup-last.json"
FAILED_FILE="$STATE_DIR/backup.failed"
KEEP="${ACORN_BACKUP_KEEP:-14}"
MIN_FREE_KB=1048576
MAX_USE_PCT=85
LOCK_FILE="$STATE_DIR/.backup.lock"

STEP="init"
PART=""
START_TS=$(date +%s)

log() { echo "[acorn-backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

case "$KEEP" in ''|*[!0-9]*) log "保留数必须是正整数（拿到 '$KEEP'）"; exit 2 ;; esac
[ "$KEEP" -ge 1 ] || KEEP=1
PY="$(command -v python3 || true)"
[ -n "$PY" ] || { log "找不到 python3（只用来写 JSON）"; exit 2; }
[ -f "$DB" ] || { log "找不到数据库 $DB"; exit 2; }

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "另一个备份正在运行，本次退出"
    exit 75
fi

on_exit() {
    local rc=$?
    trap - EXIT
    set +e
    if [ "$rc" -ne 0 ]; then
        [ -n "$PART" ] && rm -f -- "$PART" "${PART%.gz}"
        rm -f -- "$LAST_JSON.tmp"
        log "失败：step=${STEP} exit=${rc}"
        printf '{"failed_at": "%s", "step": "%s", "exit_code": %d}\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STEP" "$rc" > "$FAILED_FILE.tmp" \
            && chmod 644 "$FAILED_FILE.tmp" && mv -f "$FAILED_FILE.tmp" "$FAILED_FILE"
    fi
    exit "$rc"
}
trap on_exit EXIT
trap 'exit 143' TERM INT

# ── 0. 磁盘预检 ──────────────────────────────────────────────────────────────
STEP="disk_check"
mkdir -p "$DIR"
read -r AVAIL_KB USE_PCT <<EOF
$(df -Pk "$DIR" | awk 'NR==2{gsub("%","",$5); print $4, $5}')
EOF
case "${AVAIL_KB:-}${USE_PCT:-}" in ''|*[!0-9]*) log "读不出 $DIR 所在盘的剩余空间"; exit 5 ;; esac
if [ "$AVAIL_KB" -lt "$MIN_FREE_KB" ] || [ "$USE_PCT" -gt "$MAX_USE_PCT" ]; then
    log "备份盘空间不足：剩 $((AVAIL_KB / 1024)) MB、已用 ${USE_PCT}%"
    exit 5
fi

# ── 1. 在线一致性快照 ────────────────────────────────────────────────────────
STEP="snapshot"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$DIR/acorn-${STAMP}.db.gz"
RAW="$DIR/acorn-${STAMP}.db.part"
PART="${RAW}.gz"           # on_exit 会连带删掉 $RAW
sqlite3 -bail "$DB" ".timeout 30000" ".backup '$RAW'"

# ── 2. 校验 + 行数 ───────────────────────────────────────────────────────────
STEP="verify"
CHECK="$(sqlite3 -bail "$RAW" "PRAGMA integrity_check;")"
if [ "$CHECK" != "ok" ]; then
    log "integrity_check 未通过：$(printf '%s' "$CHECK" | head -c 300)"
    exit 3
fi
COUNTS=""
for t in $(sqlite3 -bail "$RAW" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"); do
    case "$t" in *[!A-Za-z0-9_]*) continue ;; esac
    COUNTS="$COUNTS $t=$(sqlite3 -bail "$RAW" "SELECT count(*) FROM \"$t\";")"
done
log "行数：${COUNTS# }"
RAW_BYTES="$(stat -c %s "$RAW")"

# ── 3. 压缩 + 自检 + 校验和 ──────────────────────────────────────────────────
STEP="compress"
gzip -6 -c "$RAW" > "$PART"
gzip -t "$PART"
rm -f -- "$RAW"
SIZE="$(stat -c %s "$PART")"
SHA="$(sha256sum "$PART" | cut -d' ' -f1)"
mv -f -- "$PART" "$FINAL"
PART=""
log "OK $FINAL（${SIZE} 字节，解压后 ${RAW_BYTES}，sha256 ${SHA}）"

# ── 4. 保留策略（文件名按时间可排序；最新的永远保留） ─────────────────────────
STEP="retention"
find "$DIR" -maxdepth 1 -type f -name 'acorn-*.db.gz' -printf '%f\n' | sort -r | tail -n +"$((KEEP + 1))" \
    | while IFS= read -r f; do
        rm -f -- "${DIR:?}/$f"
        log "保留策略删除 $DIR/$f"
    done
find "$DIR" -maxdepth 1 -type f -name '*.part*' -mmin +720 -delete

# ── 5. backup-last.json（同目录临时文件 + rename，读者永远看不到半截） ─────────
STEP="last_json"
DURATION=$(( $(date +%s) - START_TS ))
A_FILE="$FINAL" A_SIZE="$SIZE" A_RAW="$RAW_BYTES" A_SHA="$SHA" A_COUNTS="$COUNTS" \
A_DURATION="$DURATION" A_KEEP="$KEEP" A_DB="$DB" \
"$PY" - "$LAST_JSON" <<'PY'
import datetime, json, os, sys

env = os.environ
path = sys.argv[1]
counts = {}
for kv in env["A_COUNTS"].split():
    k, v = kv.split("=", 1)
    counts[k] = int(v)
data = {
    "kind": "sqlite",
    "source": env["A_DB"],
    "last_ok_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "file": env["A_FILE"],
    "size_bytes": int(env["A_SIZE"]),
    "raw_bytes": int(env["A_RAW"]),
    "sha256": env["A_SHA"],
    "row_counts": counts,
    "duration_s": int(env["A_DURATION"]),
    "keep": {"daily": int(env["A_KEEP"])},
}
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=2, sort_keys=True)
    fh.write("\n")
    fh.flush()
    os.fsync(fh.fileno())
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY

rm -f -- "$FAILED_FILE"
STEP="done"
log "完成（${DURATION}s）"
