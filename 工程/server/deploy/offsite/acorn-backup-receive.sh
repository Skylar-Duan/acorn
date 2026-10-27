#!/bin/bash
# acorn-backup-receive.sh — 装在 11 的 preferred-web-01 上，接收橡果库的异地备份。
#
# 专用账号 acornbak 的 authorized_keys 里把这把钥匙钉死为
#   restrict,from="47.85.52.202",command="/usr/local/bin/acorn-backup-receive" ssh-ed25519 ...
# 所以这把钥匙只能做一件事：从标准输入收一个 .db.gz，验过后存下，只留最近 3 份。
# 对方传什么命令（SSH_ORIGINAL_COMMAND）一律不理。
#
# 输出一行 "OK <文件名> <字节数> <sha256>"，发送端拿它和本地校验和对账。

set -euo pipefail
umask 077
cd /

DIR="/home/acornbak/backups"
KEEP=3
MAX_BYTES=$((500 * 1024 * 1024))   # 现在 ~200KB；设上限防有人灌满公司机器的盘

mkdir -p "$DIR"
cd "$DIR"
exec 9>.lock
flock -n 9 || { echo "ERR busy"; exit 75; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="acorn-${STAMP}.db.gz"
PART="${NAME}.part"
trap 'rm -f -- "$PART"' EXIT

head -c $((MAX_BYTES + 1)) > "$PART"
SIZE="$(stat -c %s "$PART")"
if [ "$SIZE" -le 0 ] || [ "$SIZE" -gt "$MAX_BYTES" ]; then
    echo "ERR bad size $SIZE"
    exit 3
fi
gzip -t "$PART" 2>/dev/null || { echo "ERR not a valid gzip"; exit 3; }
SHA="$(sha256sum "$PART" | cut -d' ' -f1)"
mv -f -- "$PART" "$NAME"
trap - EXIT

ls -1 acorn-*.db.gz | sort -r | tail -n +$((KEEP + 1)) | while IFS= read -r f; do rm -f -- "$f"; done
find . -maxdepth 1 -name '*.part' -mmin +720 -delete
echo "OK $NAME $SIZE $SHA"
