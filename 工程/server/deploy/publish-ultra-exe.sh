#!/usr/bin/env bash
# Ultra 只上传私有目录。网站必须经账号、今日验证码及完整下载确认；不创建公开直链。
# 用法：publish-ultra-exe.sh <AcornUltra_x.y.z[-beta.N]_x64-setup.exe> [说明文件] [--beta]
set -euo pipefail
BETA=0
ARGS=()
for a in "$@"; do
  case "$a" in --beta) BETA=1 ;; *) ARGS+=("$a") ;; esac
done
EXE="${ARGS[0]:?缺少 Ultra 安装包}"
NOTES_FILE="${ARGS[1]:-}"
[ -f "$EXE" ] || { echo "找不到安装包"; exit 1; }
NAME="$(basename "$EXE")"
if [ "$BETA" = 1 ]; then
  PATTERN='^AcornUltra_([0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+)_x64-setup\.exe$'
else
  PATTERN='^AcornUltra_([0-9]+\.[0-9]+\.[0-9]+)_x64-setup\.exe$'
fi
[[ "$NAME" =~ $PATTERN ]] || { echo "Ultra 包名/通道不符"; exit 1; }
VER="${BASH_REMATCH[1]}"
SIZE="$(stat -c %s "$EXE")"
SHA="$(sha256sum "$EXE" | cut -d' ' -f1)"
SCHEMA="$(sed -n 's/^export const DATA_VERSION = \([0-9][0-9]*\);.*/\1/p' "$(dirname "$0")/../../src/core/model.ts" | head -1)"
[ -n "$SCHEMA" ] || { echo "数据版本缺失"; exit 1; }
HOST="${ACORN_DEPLOY_HOST:-root@47.85.52.202}"
SSH_KEY="${ACORN_SSH_KEY:-/s/AI/Claude Code/claude-home/resources/ssh/id_ed25519}"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$HOST")
SCP=(scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)
REMOTE_DIR="/var/lib/acorn-sync/private/windows/ultra"
if [ "$BETA" = 1 ]; then REMOTE_DIR="$REMOTE_DIR/beta"; fi
MANIFEST="$(mktemp "$(dirname "$EXE")/ultra-manifest.XXXXXX")"
trap 'rm -f "$MANIFEST"' EXIT
python - "$NAME" "$VER" "$SIZE" "$SHA" "$SCHEMA" "$NOTES_FILE" "$MANIFEST" <<'PY'
import datetime,json,pathlib,sys
name,version,size,sha,schema,notes,out=sys.argv[1:]
payload=dict(file=name,version=version,size=int(size),sha256=sha,schema=int(schema),
             edition='ultra',notes=pathlib.Path(notes).read_text(encoding='utf-8') if notes else '',
             publishedAt=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
             pageUrl='https://acorn.cdpandas.com/intro/')
pathlib.Path(out).write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
assert json.loads(pathlib.Path(out).read_text(encoding='utf-8'))['sha256']==sha
PY
echo "上传私有 Ultra 包 $NAME ($SIZE bytes / SHA256 $SHA)"
"${SSH[@]}" "install -d -o acorn -g acorn -m 750 '$REMOTE_DIR'"
"${SCP[@]}" "$EXE" "$HOST:$REMOTE_DIR/$NAME.upload"
"${SCP[@]}" "$MANIFEST" "$HOST:$REMOTE_DIR/latest.json.upload"
"${SSH[@]}" bash -s -- "$REMOTE_DIR" "$NAME" "$SHA" <<'REMOTE'
set -euo pipefail
dir="$1"; name="$2"; sha="$3"
case "$dir" in /var/lib/acorn-sync/private/windows/ultra|/var/lib/acorn-sync/private/windows/ultra/beta) ;; *) exit 1 ;; esac
cd "$dir"
printf '%s  %s\n' "$sha" "$name.upload" | sha256sum -c -
chown acorn:acorn "$name.upload" latest.json.upload
chmod 640 "$name.upload" latest.json.upload
mv -f -- "$name.upload" "$name"
mv -f -- latest.json.upload latest.json
find . -maxdepth 1 -type f -name 'AcornUltra_*.exe' -printf '%T@ %f\n' | sort -rn | tail -n +4 | cut -d' ' -f2- | while IFS= read -r old; do
  case "$old" in AcornUltra_*_x64-setup.exe) rm -f -- "$old" ;; *) exit 1 ;; esac
done
REMOTE
code="$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://acorn.cdpandas.com/api/ultra/status)"
[ "$code" = 401 ] || { echo "未登录门禁异常 HTTP $code"; exit 1; }
echo "已发布私有 Ultra 包；未登录接口返回 401。"
