#!/usr/bin/env bash
#
# 装橡果库的异地备份：cdpandas-prod（阿里云）每 7 天推一份到 11 的 preferred-web-01（腾讯云新加坡）。
# 本机要同时有两台的登录钥匙（~/.ssh/id_ed25519、~/.ssh/preferred_web_01）。重复跑无害。
#
#   prod 侧：/etc/acorn-sync/offsite/{id_ed25519,known_hosts}（acorn 700，私钥服务器上生成、不出机）
#            /usr/local/sbin/acorn-offsite.sh + acorn-offsite.{service,timer}
#   11 侧：  专用账号 acornbak（独立用户，符合 preferred-web-01 共用规矩），
#            /usr/local/bin/acorn-backup-receive，备份落 /home/acornbak/backups/（只留 3 份）
#            钥匙限死：restrict + from=prod IP + 强制命令，不能登录、不能干别的
#
# 用法：bash install-offsite.sh
set -euo pipefail

PROD="root@47.85.52.202"
PROD_IP="47.85.52.202"
PF="ubuntu@43.156.230.45"
PF_IP="43.156.230.45"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

P_SSH=(ssh -i "$HOME/.ssh/id_ed25519" -o BatchMode=yes -o StrictHostKeyChecking=yes -o LogLevel=ERROR "$PROD")
P_SCP=(scp -q -i "$HOME/.ssh/id_ed25519" -o BatchMode=yes -o StrictHostKeyChecking=yes -o LogLevel=ERROR)
F_SSH=(ssh -i "$HOME/.ssh/preferred_web_01" -o BatchMode=yes -o StrictHostKeyChecking=yes -o LogLevel=ERROR "$PF")
F_SCP=(scp -q -i "$HOME/.ssh/preferred_web_01" -o BatchMode=yes -o StrictHostKeyChecking=yes -o LogLevel=ERROR)

echo "=== 1. prod：生成（或沿用）推送钥匙"
PUB="$("${P_SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
install -d -m 700 -o acorn -g acorn /etc/acorn-sync/offsite
if [ ! -f /etc/acorn-sync/offsite/id_ed25519 ]; then
  runuser -u acorn -- ssh-keygen -q -t ed25519 -N "" -C "acorn-offsite@cdpandas-prod" -f /etc/acorn-sync/offsite/id_ed25519
fi
cat /etc/acorn-sync/offsite/id_ed25519.pub
REMOTE
)"
case "$PUB" in ssh-ed25519\ *) ;; *) echo "拿不到公钥：$PUB"; exit 1 ;; esac

echo "=== 2. 11：专用账号 + 接收脚本 + 限死的钥匙"
"${F_SCP[@]}" "$HERE/acorn-backup-receive.sh" "$PF:/tmp/acorn-backup-receive"
HOSTKEY="$("${F_SSH[@]}" "PUB='$PUB' PROD_IP='$PROD_IP' bash -s" <<'REMOTE'
set -euo pipefail
sudo sed -i 's/\r$//' /tmp/acorn-backup-receive
sudo install -m 755 -o root -g root /tmp/acorn-backup-receive /usr/local/bin/acorn-backup-receive
rm -f /tmp/acorn-backup-receive
id acornbak >/dev/null 2>&1 || sudo useradd -m -s /bin/bash -c "Acorn offsite backup (16-Acorn)" acornbak
sudo passwd -l acornbak >/dev/null
sudo chmod 700 /home/acornbak
sudo install -d -m 700 -o acornbak -g acornbak /home/acornbak/.ssh /home/acornbak/backups
printf 'restrict,from="%s",command="/usr/local/bin/acorn-backup-receive" %s\n' "$PROD_IP" "$PUB" \
  | sudo tee /home/acornbak/.ssh/authorized_keys >/dev/null
sudo chown acornbak:acornbak /home/acornbak/.ssh/authorized_keys
sudo chmod 600 /home/acornbak/.ssh/authorized_keys
cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub
REMOTE
)"
case "$HOSTKEY" in ssh-ed25519\ *) ;; *) echo "拿不到 11 的主机钥匙：$HOSTKEY"; exit 1 ;; esac

echo "=== 3. prod：钉住 11 的主机钥匙、装脚本与定时器、立刻推一次"
"${P_SCP[@]}" "$HERE/acorn-offsite.sh" "$HERE/acorn-offsite.service" "$HERE/acorn-offsite.timer" "$PROD:/tmp/"
"${P_SSH[@]}" "HOSTLINE='$PF_IP $HOSTKEY' bash -s" <<'REMOTE'
set -euo pipefail
printf '%s\n' "$HOSTLINE" > /etc/acorn-sync/offsite/known_hosts
chown acorn:acorn /etc/acorn-sync/offsite/known_hosts
chmod 644 /etc/acorn-sync/offsite/known_hosts
install -m 755 -o root -g root /tmp/acorn-offsite.sh /usr/local/sbin/acorn-offsite.sh
install -m 644 -o root -g root /tmp/acorn-offsite.service /etc/systemd/system/acorn-offsite.service
install -m 644 -o root -g root /tmp/acorn-offsite.timer /etc/systemd/system/acorn-offsite.timer
rm -f /tmp/acorn-offsite.sh /tmp/acorn-offsite.service /tmp/acorn-offsite.timer
sed -i 's/\r$//' /usr/local/sbin/acorn-offsite.sh
systemctl daemon-reload
systemctl enable --now acorn-offsite.timer
systemctl start acorn-offsite.service || true
systemctl show acorn-offsite.service -p Result -p ExecMainStatus
journalctl -u acorn-offsite.service -n 5 --no-pager -o cat
cat /var/lib/acorn-sync/offsite-last.json 2>/dev/null || cat /var/lib/acorn-sync/offsite.failed
systemctl is-active acorn-sync.service
systemctl list-timers --no-pager acorn-offsite.timer | head -2
REMOTE

echo "=== 4. 11：落地情况"
"${F_SSH[@]}" 'sudo ls -la /home/acornbak/backups/'
