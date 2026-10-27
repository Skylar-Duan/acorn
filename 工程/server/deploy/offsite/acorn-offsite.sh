#!/bin/bash
# acorn-offsite.sh — 橡果库的唯一备份：每 7 天拍一张快照，推到 11 的 preferred-web-01，本机不留
#
# 由 acorn-offsite.timer 每周日北京 04:10 拉起，User=acorn。
# 2026-10-27 用户定：每七天推一次到 11，对方最多留三份；cdpandas 本机的每日备份撤掉、本机不留备份。
# 安装：deploy/offsite/install-offsite.sh
#
# 为什么以 acorn 跑：库是 WAL 模式，root 打开可能新建属主 root 的 -wal/-shm，同步服务随即写不进。
# 钥匙 /etc/acorn-sync/offsite/id_ed25519 在本机生成、从不出机；对方只认它做「收备份」这一件事。
# 对方主机钥匙钉死在 /etc/acorn-sync/offsite/known_hosts，换了钥匙直接失败，不会把备份交给冒充者。
#
# 步骤（任何一步失败 → 整次失败，写 offsite.failed，不碰上一次成功的 offsite-last.json）：
#   1. sqlite3 .backup 在线快照（同步服务照常读写也拿得到一致的一份，不是 cp）到私有临时目录
#   2. PRAGMA integrity_check = ok，数各表行数
#   3. gzip + gzip -t + sha256
#   4. ssh 推给对方的接收脚本，对方回执的字节数与 sha256 必须和本地一致
#   5. 写 /var/lib/acorn-sync/offsite-last.json（644）；临时文件随 PrivateTmp 与 trap 一起清掉
#
# 恢复：到 preferred-web-01 取 /home/acornbak/backups/ 里的一份，gunzip 后停 acorn-sync，
#       替换 /var/lib/acorn-sync/acorn.db（删掉旧的 -wal/-shm），chown acorn:acorn，再启动。

set -euo pipefail
umask 077
cd /
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"

DB="${ACORN_DB:-/var/lib/acorn-sync/acorn.db}"
STATE_DIR="${ACORN_BACKUP_STATE_DIR:-/var/lib/acorn-sync}"
KEY_DIR="/etc/acorn-sync/offsite"
DEST="${ACORN_OFFSITE_DEST:-acornbak@43.156.230.45}"
LAST_JSON="$STATE_DIR/offsite-last.json"
FAILED_FILE="$STATE_DIR/offsite.failed"
LOCK_FILE="$STATE_DIR/.offsite.lock"
STEP="init"
WORK=""

log() { echo "[acorn-offsite] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

[ -f "$DB" ] || { log "找不到数据库 $DB"; exit 2; }
exec 9>"$LOCK_FILE"
flock -n 9 || { log "另一次推送正在运行，本次退出"; exit 75; }

on_exit() {
    local rc=$?
    trap - EXIT
    set +e
    [ -n "$WORK" ] && rm -rf -- "$WORK"
    if [ "$rc" -ne 0 ]; then
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

# ── 1. 在线一致性快照 ────────────────────────────────────────────────────────
STEP="snapshot"
WORK="$(mktemp -d /tmp/acorn-offsite.XXXXXX)"
RAW="$WORK/acorn.db"
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
RAW_BYTES="$(stat -c %s "$RAW")"

# ── 3. 压缩 + 自检 + 校验和 ──────────────────────────────────────────────────
STEP="compress"
FILE="$WORK/acorn.db.gz"
gzip -6 -c "$RAW" > "$FILE"
gzip -t "$FILE"
SIZE="$(stat -c %s "$FILE")"
SHA="$(sha256sum "$FILE" | cut -d' ' -f1)"

# ── 4. 推送 + 对账 ───────────────────────────────────────────────────────────
STEP="push"
REPLY="$(ssh -F /dev/null -i "$KEY_DIR/id_ed25519" \
    -o UserKnownHostsFile="$KEY_DIR/known_hosts" -o StrictHostKeyChecking=yes \
    -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 \
    -o LogLevel=ERROR "$DEST" < "$FILE")"

STEP="verify_remote"
read -r R_OK R_NAME R_SIZE R_SHA _ <<EOF
$REPLY
EOF
if [ "${R_OK:-}" != "OK" ] || [ "${R_SIZE:-}" != "$SIZE" ] || [ "${R_SHA:-}" != "$SHA" ]; then
    log "对方回执不符：本地 ${SIZE} ${SHA}；对方「$(printf '%s' "$REPLY" | head -c 200)」"
    exit 3
fi
log "OK → $DEST:$R_NAME（${SIZE} 字节，解压后 ${RAW_BYTES}，sha256 一致）行数：${COUNTS# }"

# ── 5. offsite-last.json ─────────────────────────────────────────────────────
STEP="last_json"
O_DEST="$DEST" O_NAME="$R_NAME" O_SIZE="$SIZE" O_RAW="$RAW_BYTES" O_SHA="$SHA" O_COUNTS="$COUNTS" O_DB="$DB" \
python3 - "$LAST_JSON" <<'PY'
import datetime, json, os, sys

env = os.environ
path = sys.argv[1]
counts = {}
for kv in env["O_COUNTS"].split():
    k, v = kv.split("=", 1)
    counts[k] = int(v)
data = {
    "kind": "offsite",
    "source": env["O_DB"],
    "last_ok_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "remote": env["O_DEST"],
    "remote_file": env["O_NAME"],
    "size_bytes": int(env["O_SIZE"]),
    "raw_bytes": int(env["O_RAW"]),
    "sha256": env["O_SHA"],
    "row_counts": counts,
    "remote_keep": 3,
    "interval_days": 7,
}
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=2, sort_keys=True)
    fh.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
rm -f -- "$FAILED_FILE"
STEP="done"
