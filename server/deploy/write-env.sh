#!/usr/bin/env bash
#
# 在服务器上写 /etc/acorn-sync/env。**SMTP 那几行从标准输入进来**，
# 不出现在命令行、不落中间文件、不进日志、不打印。
#
# 必须是独立文件而不是 `ssh bash -s <<EOF` 里的一段：那样 heredoc 和管道会抢同一个
# stdin，脚本自己的后半段会被 $(cat) 吞掉（2026-08-21 部署时踩过这个坑）。
set -euo pipefail
umask 077

SMTP_BLOCK="$(cat || true)"
if [ -z "$SMTP_BLOCK" ]; then
  echo "!! 没收到 SMTP_* —— 验证码将发不出去（服务照常起，只是不能注册）" >&2
fi

mkdir -p /etc/acorn-sync

# JWT 密钥只生成一次：重新生成 = 把所有人登出
if [ -f /etc/acorn-sync/env ] && grep -q '^ACORN_JWT_SECRET=' /etc/acorn-sync/env; then
  JWT_LINE="$(grep '^ACORN_JWT_SECRET=' /etc/acorn-sync/env)"
  echo "沿用已有的 JWT 密钥（重生成会把所有人登出）"
else
  JWT_LINE="ACORN_JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n=+/')"
  echo "新生成了 JWT 密钥"
fi

{
  echo "$JWT_LINE"
  [ -n "$SMTP_BLOCK" ] && echo "$SMTP_BLOCK"
  echo "ACORN_MAIL_FROM=noreply@cdpandas.com"
  echo "ACORN_MAIL_FROM_NAME=橡果 Acorn"
  echo "ACORN_DB=/var/lib/acorn-sync/acorn.db"
} > /etc/acorn-sync/env

chown root:root /etc/acorn-sync/env
chmod 600 /etc/acorn-sync/env
echo "已写入 /etc/acorn-sync/env（$(wc -l < /etc/acorn-sync/env) 行，权限 $(stat -c %a /etc/acorn-sync/env)，含 SMTP：$(grep -qc '^SMTP_PASSWORD=' /etc/acorn-sync/env && echo 是 || echo 否)）"
