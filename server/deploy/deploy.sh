#!/usr/bin/env bash
#
# 把橡果云同步服务推到 cdpandas-prod（阿里云 47.85.52.202）。
#
# 这台机器上还跑着 finance / sbg / osmoeng / petlink —— 本脚本**只新增**自己的东西：
#   /var/www/acorn-sync        代码 + venv
#   /var/lib/acorn-sync        数据库（只有本服务能写）
#   /etc/acorn-sync/env        凭据（chmod 600，属主 root）
#   /etc/systemd/system/acorn-sync.service
#   /etc/nginx/conf.d/acorn.conf   ← 新文件，不改任何已有 conf
# 全程不动别人的配置；nginx 只做 `nginx -t` 通过后的 reload。
#
# 凭据怎么进服务器（CC 全程不看值）：
#   · JWT 密钥：在**服务器上**用 openssl 现生成，本地永远看不到
#   · SMTP 口令：从资产中枢 api_keys.env 读出来，直接管道进 ssh 写进 env 文件，
#     不落任何中间文件、不打印、不进日志
#
# 用法：bash deploy.sh            全量部署
#       bash deploy.sh --code     只推代码 + 重启（日常改完用这个）
set -euo pipefail

HOST="${ACORN_DEPLOY_HOST:-root@47.85.52.202}"
SSH_KEY="${ACORN_SSH_KEY:-/s/AI/Claude Code/claude-home/resources/ssh/id_ed25519}"
DOMAIN="acorn.cdpandas.com"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRV="$(dirname "$HERE")"

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$HOST")
SCP=(scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

say() { printf '\n=== %s\n' "$*"; }

# ---------- 1. 代码 ----------
push_code() {
  say "打包并上传代码"
  tar -czf /tmp/acorn-sync.tgz -C "$SRV" app tests requirements.txt
  "${SCP[@]}" /tmp/acorn-sync.tgz "$HOST:/tmp/acorn-sync.tgz"
  "${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p /var/www/acorn-sync
rm -rf /var/www/acorn-sync/app
tar -xzf /tmp/acorn-sync.tgz -C /var/www/acorn-sync
rm -f /tmp/acorn-sync.tgz
REMOTE
}

if [ "${1:-}" = "--code" ]; then
  push_code
  "${SSH[@]}" 'systemctl restart acorn-sync && sleep 2 && systemctl is-active acorn-sync'
  "${SSH[@]}" "curl -s -m 5 https://$DOMAIN/api/health || curl -s -m 5 http://127.0.0.1:8021/api/health"
  echo
  say "只推代码完成"
  exit 0
fi

# ---------- 2. 系统准备 ----------
say "服务器上建用户、目录、虚拟环境"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
id acorn >/dev/null 2>&1 || useradd --system --home /var/www/acorn-sync --shell /usr/sbin/nologin acorn
mkdir -p /var/www/acorn-sync /var/lib/acorn-sync /etc/acorn-sync \
         /var/www/acorn-public/android /var/www/acorn-public/windows
# 公开目录（安卓 APK / 桌面 exe + 各自的版本清单）：nginx 要读得到，
# 所以 755 且不在 acorn 的私有目录里
chmod 755 /var/www/acorn-public
chown -R acorn:acorn /var/lib/acorn-sync
chmod 750 /var/lib/acorn-sync
REMOTE

push_code

"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
cd /var/www/acorn-sync
# 这台机器的 python3 是 3.6（系统自带，动不得），FastAPI 与本服务要 3.11
PY=$(command -v python3.11 || command -v python3.12 || true)
[ -n "$PY" ] || { echo "服务器上没有 python3.11+，先 dnf install python3.11"; exit 1; }
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv
fi
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt
chown -R acorn:acorn /var/www/acorn-sync
echo "python: $(.venv/bin/python -V)"
REMOTE

# ---------- 3. 凭据 ----------
say "写入运行配置（值不经过屏幕）"
# 资产中枢的查找顺序，与各脚本一致
KEYS=""
for cand in "${CLAUDE_CONFIG_DIR:-}/api_keys.env" \
            "/s/AI/Claude Code/claude-home/resources/api_keys.env" \
            "$HOME/.claude/resources/api_keys.env"; do
  [ -n "$cand" ] && [ -f "$cand" ] && { KEYS="$cand"; break; }
done
[ -n "$KEYS" ] || { echo "找不到 api_keys.env，先确认 S 盘挂上了"; exit 1; }

# 写 env 的脚本先传上去，再把 SMTP 那几行从管道喂给它。
# 不能写成 `ssh bash -s <<EOF` 里内联一段——heredoc 和管道会抢同一个 stdin，
# 脚本后半段会被 $(cat) 吞掉（2026-08-21 踩过）。
"${SCP[@]}" "$HERE/write-env.sh" "$HOST:/tmp/acorn-write-env.sh"
grep -E '^(SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASSWORD)=' "$KEYS" \
  | "${SSH[@]}" 'bash /tmp/acorn-write-env.sh; rc=$?; rm -f /tmp/acorn-write-env.sh; exit $rc'

# ---------- 4. systemd ----------
say "安装并启动服务"
"${SCP[@]}" "$HERE/acorn-sync.service" "$HOST:/etc/systemd/system/acorn-sync.service"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
systemctl daemon-reload
systemctl enable acorn-sync
# 必须是 restart 不能是 `enable --now`：服务已经在跑时 --now 什么都不做，
# 新推上来的代码根本不会生效（2026-08-24 踩过，接口 404 查了半天）
systemctl restart acorn-sync
sleep 2
systemctl is-active acorn-sync
curl -s -m 5 http://127.0.0.1:8021/api/health; echo
REMOTE

# ---------- 5. nginx + 证书 ----------
# 分两步：先只放 80 端口那半段让 certbot 过 HTTP 验证，签下证书再换成完整配置。
# 一步到位不行——完整配置里引用的证书文件那会儿还不存在，nginx -t 直接不过。
say "配 nginx 与证书（只新增文件，不改任何已有 conf）"
"${SCP[@]}" "$HERE/proxy_params_acorn" "$HOST:/etc/nginx/proxy_params_acorn"
"${SCP[@]}" "$HERE/nginx-acorn.conf" "$HOST:/tmp/acorn.conf"
"${SSH[@]}" ACORN_DOMAIN="$DOMAIN" bash -s <<'REMOTE'
set -euo pipefail
D="${ACORN_DOMAIN:?}"
mkdir -p /var/www/html/.well-known/acme-challenge

cat > /etc/nginx/conf.d/acorn.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${D};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF
nginx -t && systemctl reload nginx

if [ ! -f "/etc/letsencrypt/live/${D}/fullchain.pem" ]; then
  certbot certonly --webroot -w /var/www/html -d "${D}" \
    --non-interactive --agree-tos -m skylarduan@cdpandas.com
fi

cp /tmp/acorn.conf /etc/nginx/conf.d/acorn.conf
rm -f /tmp/acorn.conf
# 万一完整配置有问题，回退到刚才那半段，绝不让 nginx 带着坏配置重载（会连累这台机器上所有站）
if ! nginx -t; then
  echo "!! 完整配置没过 nginx -t，已回退，其他站不受影响" >&2
  cat > /etc/nginx/conf.d/acorn.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${D};
    location / { return 404; }
}
EOF
  nginx -t && systemctl reload nginx
  exit 1
fi
systemctl reload nginx
echo "nginx 已重载"
REMOTE

# ---------- 6. 验收 ----------
say "外网自测"
curl -s -m 10 "https://$DOMAIN/api/health"; echo
echo
say "部署完成：https://$DOMAIN"
