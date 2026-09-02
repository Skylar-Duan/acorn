#!/usr/bin/env bash
#
# 把一个 Windows 安装包发到服务器，让电脑上的橡果自己能查到、自己能下。
# publish-apk.sh 的桌面版，除了目录和文件名规则以外一模一样。
#
# 做三件事：
#   1. 把 exe 传到 /var/www/acorn-public/windows/
#   2. 写 latest.json（版本号、大小、sha256、更新说明）
#   3. 把老包留着但只留最近 3 个（有人正在下旧包的路上，别当场抽走）
#
# 用法：
#   bash server/deploy/publish-exe.sh <exe 路径> [更新说明文件]
#
# 包在 npm run build 之后躺在 src-tauri/target/release/bundle/nsis/Acorn_1.9.0_x64-setup.exe。
# 客户端那头：GET /api/desktop/latest 拿到这份清单 → 比版本号 → 自己下 → 拉起安装 → 自己退出。
set -euo pipefail

EXE="${1:?用法: publish-exe.sh <exe 路径> [更新说明文件]}"
NOTES_FILE="${2:-}"
[ -f "$EXE" ] || { echo "找不到 $EXE"; exit 1; }

HOST="${ACORN_DEPLOY_HOST:-root@47.85.52.202}"
SSH_KEY="${ACORN_SSH_KEY:-/s/AI/Claude Code/claude-home/resources/ssh/id_ed25519}"
REMOTE_DIR="/var/www/acorn-public/windows"
KEEP=3

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$HOST")
SCP=(scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

NAME="$(basename "$EXE")"
# 版本号从文件名里取：Acorn_1.9.0_x64-setup.exe -> 1.9.0
VER="$(printf '%s' "$NAME" | sed -n 's/^[Aa]corn_\([0-9][0-9.]*\)_.*\.exe$/\1/p')"
[ -n "$VER" ] || { echo "文件名里读不出版本号（要形如 Acorn_1.9.0_x64-setup.exe）"; exit 1; }
SIZE="$(stat -c %s "$EXE")"
SHA="$(sha256sum "$EXE" | cut -d' ' -f1)"
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
"${SCP[@]}" "$EXE" "$HOST:$REMOTE_DIR/$NAME"

echo "=== 写版本清单"
# 清单用 python 生成：更新说明里有中文和换行，shell 拼 JSON 迟早出事。
# **必须让 python 自己写文件，不能重定向 stdout**：Windows 上 stdout 走的是控制台
# 代码页（GBK），中文会被写成非 UTF-8 字节，服务端 read_text 直接 UnicodeDecodeError，
# 表现成「发了包但查不到更新」（2026-08-24 踩过）。
python - "$NAME" "$VER" "$SIZE" "$SHA" "$NOTES" "$SCHEMA" /tmp/acorn-latest-exe.json <<'PY'
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
python -c "import io,json,sys; json.load(io.open(sys.argv[1],encoding='utf-8')); print('  清单是合法 UTF-8 JSON')" /tmp/acorn-latest-exe.json
"${SCP[@]}" /tmp/acorn-latest-exe.json "$HOST:$REMOTE_DIR/latest.json"
rm -f /tmp/acorn-latest-exe.json

echo "=== 清理老包（留最近 $KEEP 个）"
"${SSH[@]}" bash -s <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR"
ls -1t *.exe 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  echo "  删掉 \$old"
  rm -f -- "\$old"
done
# 固定文件名永远指向最新的包：网站上的下载链接写这个名字就不用每版改（2026-09-02 用户要求网站随发版同步）
ln -sfn "$NAME" Acorn-latest-x64-setup.exe
chmod -R a+rX /var/www/acorn-public
ls -1 *.exe
REMOTE

echo
echo "=== 外网自测"
curl -s -m 15 "https://acorn.cdpandas.com/api/desktop/latest"; echo
curl -s -m 15 -o /dev/null -w "exe 直链 HTTP %{http_code}（%{size_download} 字节头）\n" -r 0-1023 \
  "https://acorn.cdpandas.com/download/windows/$NAME"
curl -s -m 15 -o /dev/null -w "固定名直链 HTTP %{http_code}
" -r 0-1023 "https://acorn.cdpandas.com/download/windows/Acorn-latest-x64-setup.exe"
