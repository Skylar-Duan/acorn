#!/usr/bin/env bash
#
# 把一个安卓安装包发到服务器，让手机上的橡果自己能查到、自己能下。
#
# 做三件事：
#   1. 把 APK 传到 /var/lib/acorn-sync/public/android/
#   2. 写 latest.json（版本号、大小、sha256、更新说明）
#   3. 把老包留着但只留最近 3 个（有人正在下旧包的路上，别当场抽走）
#
# 用法：
#   bash server/deploy/publish-apk.sh <apk 路径> [更新说明文件]
#
# 客户端那头：GET /api/android/latest 拿到这份清单 → 比版本号 → 自己下 → 拉起安装。
set -euo pipefail

APK="${1:?用法: publish-apk.sh <apk 路径> [更新说明文件]}"
NOTES_FILE="${2:-}"
[ -f "$APK" ] || { echo "找不到 $APK"; exit 1; }

HOST="${ACORN_DEPLOY_HOST:-root@47.85.52.202}"
SSH_KEY="${ACORN_SSH_KEY:-/s/AI/Claude Code/claude-home/resources/ssh/id_ed25519}"
REMOTE_DIR="/var/www/acorn-public/android"
KEEP=3

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$HOST")
SCP=(scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

NAME="$(basename "$APK")"
# 版本号从文件名里取：Acorn_1.7.0_arm64.apk -> 1.7.0
VER="$(printf '%s' "$NAME" | sed -n 's/^[Aa]corn_\([0-9][0-9.]*\)_.*/\1/p')"
[ -n "$VER" ] || { echo "文件名里读不出版本号（要形如 Acorn_1.7.0_arm64.apk）"; exit 1; }
SIZE="$(stat -c %s "$APK")"
SHA="$(sha256sum "$APK" | cut -d' ' -f1)"
NOTES=""
[ -n "$NOTES_FILE" ] && [ -f "$NOTES_FILE" ] && NOTES="$(cat "$NOTES_FILE")"
# 这个包认的数据模型版本，直接从代码里抠——客户端拿它判断「这次是不是非升不可」
SCHEMA="$(sed -n 's/^export const DATA_VERSION = \([0-9][0-9]*\);.*/\1/p' "$(dirname "$0")/../../src/core/model.ts" | head -1)"
[ -n "$SCHEMA" ] || { echo "从 model.ts 里读不出 DATA_VERSION"; exit 1; }

echo "=== 要发的包"
echo "  $NAME  版本 $VER  数据模型 v$SCHEMA  $((SIZE / 1048576)) MB"
echo "  sha256 $SHA"

echo "=== 上传"
"${SSH[@]}" "mkdir -p '$REMOTE_DIR' && chmod 755 /var/www/acorn-public"
"${SCP[@]}" "$APK" "$HOST:$REMOTE_DIR/$NAME"

echo "=== 写版本清单"
# 清单用 python 生成：更新说明里有中文和换行，shell 拼 JSON 迟早出事。
# **必须让 python 自己写文件，不能重定向 stdout**：Windows 上 stdout 走的是控制台
# 代码页（GBK），中文会被写成非 UTF-8 字节，服务端 read_text 直接 UnicodeDecodeError，
# 表现成「发了包但查不到更新」（2026-08-24 踩过）。
python - "$NAME" "$VER" "$SIZE" "$SHA" "$NOTES" "$SCHEMA" /tmp/acorn-latest.json <<'PY'
import json, sys, datetime, io
name, ver, size, sha, notes, schema, out = sys.argv[1:8]
io.open(out, "w", encoding="utf-8").write(json.dumps({
    "file": name,
    "version": ver,
    "schema": int(schema),
    "size": int(size),
    "sha256": sha,
    "notes": notes,
    "publishedAt": datetime.datetime.now(datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "pageUrl": "https://github.com/Skylar-Duan/acorn/releases/latest",
}, ensure_ascii=False, indent=2))
PY
# 写完自己验一遍是不是合法 UTF-8，不合法当场停，别推一份服务端读不了的清单上去
python -c "import io,json,sys; json.load(io.open(sys.argv[1],encoding='utf-8')); print('  清单是合法 UTF-8 JSON')" /tmp/acorn-latest.json
"${SCP[@]}" /tmp/acorn-latest.json "$HOST:$REMOTE_DIR/latest.json"
rm -f /tmp/acorn-latest.json

echo "=== 清理老包（留最近 $KEEP 个）"
"${SSH[@]}" bash -s <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR"
ls -1t *.apk 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  echo "  删掉 \$old"
  rm -f -- "\$old"
done
chmod -R a+rX /var/www/acorn-public
ls -1 *.apk
REMOTE

echo
echo "=== 外网自测"
curl -s -m 15 "https://acorn.cdpandas.com/api/android/latest"; echo
curl -s -m 15 -o /dev/null -w "APK 直链 HTTP %{http_code}（%{size_download} 字节头）\n" -r 0-1023 \
  "https://acorn.cdpandas.com/download/android/$NAME"
