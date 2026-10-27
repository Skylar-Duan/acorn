#!/bin/bash
# acorn-offsite.sh — 每 7 天把最新一份每日备份推到 11 的 preferred-web-01（异地，防整台服务器坏掉）
#
# 由 acorn-offsite.timer 每周日北京 04:10 拉起（每日备份 03:40 已跑完），User=acorn。
# 2026-10-27 用户定：每七天推一次到 11，对方最多留三份。安装：deploy/offsite/install-offsite.sh
#
# 钥匙 /etc/acorn-sync/offsite/id_ed25519 在本机生成、从不出机；对方只认它做「收备份」这一件事。
# 对方主机钥匙钉死在 /etc/acorn-sync/offsite/known_hosts，换了钥匙直接失败，不会把备份交给冒充者。
#
# 成功写 /var/lib/acorn-sync/offsite-last.json；失败写 offsite.failed（成功后删）。

set -euo pipefail
umask 077
cd /
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"

SRC_DIR="${ACORN_BACKUP_DIR:-/var/backups/acorn/daily}"
STATE_DIR="${ACORN_BACKUP_STATE_DIR:-/var/lib/acorn-sync}"
KEY_DIR="/etc/acorn-sync/offsite"
DEST="${ACORN_OFFSITE_DEST:-acornbak@43.156.230.45}"
MAX_AGE_H=48                     # 最新一份每日备份超过两天 = 每日备份自己坏了，别把旧货当新货推
LAST_JSON="$STATE_DIR/offsite-last.json"
FAILED_FILE="$STATE_DIR/offsite.failed"
STEP="init"

log() { echo "[acorn-offsite] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

on_exit() {
    local rc=$?
    trap - EXIT
    set +e
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

STEP="pick"
LATEST="$(find "$SRC_DIR" -maxdepth 1 -type f -name 'acorn-*.db.gz' -printf '%f\n' | sort -r | head -n 1)"
[ -n "$LATEST" ] || { log "$SRC_DIR 里没有每日备份"; exit 2; }
FILE="$SRC_DIR/$LATEST"
AGE_H=$(( ($(date +%s) - $(stat -c %Y "$FILE")) / 3600 ))
if [ "$AGE_H" -gt "$MAX_AGE_H" ]; then
    log "最新每日备份已是 ${AGE_H} 小时前（$LATEST），每日备份可能坏了，本次不推"
    exit 4
fi
SIZE="$(stat -c %s "$FILE")"
SHA="$(sha256sum "$FILE" | cut -d' ' -f1)"

STEP="push"
REPLY="$(ssh -F /dev/null -i "$KEY_DIR/id_ed25519" \
    -o UserKnownHostsFile="$KEY_DIR/known_hosts" -o StrictHostKeyChecking=yes \
    -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 \
    -o LogLevel=ERROR "$DEST" < "$FILE")"

STEP="verify"
read -r R_OK R_NAME R_SIZE R_SHA _ <<EOF
$REPLY
EOF
if [ "${R_OK:-}" != "OK" ] || [ "${R_SIZE:-}" != "$SIZE" ] || [ "${R_SHA:-}" != "$SHA" ]; then
    log "对方回执不符：本地 ${SIZE} ${SHA}；对方「$(printf '%s' "$REPLY" | head -c 200)」"
    exit 3
fi
log "OK $LATEST → $DEST:$R_NAME（${SIZE} 字节，sha256 一致）"

STEP="last_json"
O_SRC="$FILE" O_DEST="$DEST" O_NAME="$R_NAME" O_SIZE="$SIZE" O_SHA="$SHA" \
python3 - "$LAST_JSON" <<'PY'
import datetime, json, os, sys

env = os.environ
path = sys.argv[1]
data = {
    "kind": "offsite",
    "last_ok_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "source_file": env["O_SRC"],
    "remote": env["O_DEST"],
    "remote_file": env["O_NAME"],
    "size_bytes": int(env["O_SIZE"]),
    "sha256": env["O_SHA"],
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
