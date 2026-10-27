#!/usr/bin/env bash
#
# 把橡果库的每日备份装到 cdpandas-prod，并立刻跑一次验证。只新增自己的东西：
#   /usr/local/sbin/acorn-backup.sh
#   /etc/systemd/system/acorn-backup.{service,timer}
#   /var/backups/acorn/daily/            备份文件（acorn:acorn 700）
#   /var/lib/acorn-sync/backup-last.json 最近一次成功（10 的上报脚本读它）
# 不重启同步服务，不碰别人的 timer。
#
# 用法：bash install-backup.sh
set -euo pipefail

HOST="${ACORN_DEPLOY_HOST:-root@47.85.52.202}"
SSH_KEY="${ACORN_SSH_KEY:-$HOME/.ssh/id_ed25519}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes "$HOST")
SCP=(scp -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes)

"${SCP[@]}" "$HERE/acorn-backup.sh" "$HERE/acorn-backup.service" "$HERE/acorn-backup.timer" "$HOST:/tmp/"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
install -m 755 -o root -g root /tmp/acorn-backup.sh /usr/local/sbin/acorn-backup.sh
install -m 644 -o root -g root /tmp/acorn-backup.service /etc/systemd/system/acorn-backup.service
install -m 644 -o root -g root /tmp/acorn-backup.timer /etc/systemd/system/acorn-backup.timer
rm -f /tmp/acorn-backup.sh /tmp/acorn-backup.service /tmp/acorn-backup.timer
install -d -m 700 -o acorn -g acorn /var/backups/acorn/daily
# 脚本若在 Windows 上被改成 CRLF，bash 会报怪错：装进去前统一成 LF
sed -i 's/\r$//' /usr/local/sbin/acorn-backup.sh
systemctl daemon-reload
systemctl enable --now acorn-backup.timer
echo "--- 立即跑一次"
systemctl start acorn-backup.service
systemctl show acorn-backup.service -p Result -p ExecMainStatus
journalctl -u acorn-backup.service -n 8 --no-pager -o cat
echo "--- backup-last.json"
cat /var/lib/acorn-sync/backup-last.json
echo "--- 库文件属主（应全是 acorn）"
ls -la /var/lib/acorn-sync/ | grep acorn.db
echo "--- 同步服务"
systemctl is-active acorn-sync.service
systemctl list-timers --no-pager acorn-backup.timer
REMOTE
