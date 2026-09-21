#!/usr/bin/env bash
#
# 把网页版发到服务器，让 https://acorn.cdpandas.com/ 变成最新那一版。
# （2026-09-21 起网页版挂根路径 /，原来的 /app/ 在 nginx 里 301 到根；介绍页挪到 /intro/，归 10 管。）
# publish-exe.sh / publish-apk.sh 的网页版：那两个发的是「一个包」，这个发的是「一整个目录」。
#
# 做四件事：
#   1. 本地构建（npx vite build --mode web → dist-web/）
#   2. 自检产物：index.html / manifest / 图标 / 字体都在，路径前缀是根路径 /
#   3. 写 version.json（网页版靠它发现「服务器上换新版了」，见 src/core/webUpdate.ts）
#   4. 传上去，整目录原子替换，装上 nginx 配置，再从外网 curl 自测一遍（不是 200 就当场失败）
#
# 用法：
#   bash server/deploy/publish-web.sh              # 构建 + 发布
#   bash server/deploy/publish-web.sh --dry-run    # 只构建 + 自检，一个字节都不往服务器传
#   bash server/deploy/publish-web.sh --skip-build # 用现成的 dist-web 直接发
#
# **不要走 10-Platform 的 publish_utility.py**：那条通道会校验「页面必须挂工具页模板」，
# 网页版是 App 本体不是介绍页，过不了也不该过。介绍页仍归 10 发，两边互不打扰。
set -euo pipefail

DRY_RUN=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "不认得的参数：$arg"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/dist-web"
HOST="${ACORN_DEPLOY_HOST:-root@47.85.52.202}"
SSH_KEY="${ACORN_SSH_KEY:-/s/AI/Claude Code/claude-home/resources/ssh/id_ed25519}"
REMOTE_DIR="/var/www/acorn-web"
SITE="https://acorn.cdpandas.com"
NGINX_CONF="$ROOT/server/deploy/nginx-acorn.conf"

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$HOST")
SCP=(scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

# 号码真源是 versions.json 里网页版那一格（2026-09-18 起三端各排各的号，见 src/core/version.ts）。
# 网页版没有测试版这回事：发出去就是公开的，所以只认 public
VER="$(python -c "import io,json,sys; print(json.load(io.open(sys.argv[1],encoding='utf-8'))['public']['web'])" "$ROOT/versions.json")"
[ -n "$VER" ] || { echo "从 versions.json 里读不出网页版的版本号"; exit 1; }
case "$VER" in *-*) echo "网页版不发测试版号：$VER"; exit 1 ;; esac

echo "=== 构建"
if [ "$SKIP_BUILD" = "1" ]; then
  echo "  （跳过，直接用现成的 dist-web）"
else
  (cd "$ROOT" && ACORN_BUILD_PLATFORM=web ACORN_BUILD_VERSION="$VER" npx vite build --mode web)
fi

echo "=== 自检产物"
[ -f "$DIST/index.html" ] || { echo "dist-web/index.html 不在，构建没成"; exit 1; }
[ -f "$DIST/manifest.webmanifest" ] || { echo "少了 manifest.webmanifest，加到主屏幕会退化成普通书签"; exit 1; }
for ico in icons/acorn-192.png icons/acorn-512.png icons/apple-touch-icon-180.png; do
  [ -f "$DIST/$ico" ] || { echo "少了 $ico（重跑 node scripts/make-icons.mjs）"; exit 1; }
done
# base 写歪过一次就满盘皆错：所有资源都会 404，页面是白的。这里直接看产物里的路径前缀。
grep -q 'src="/assets/' "$DIST/index.html" || { echo "index.html 里的资源路径不是 /assets/ 开头（根路径），base 配错了"; exit 1; }
grep -q '"/manifest.webmanifest"' "$DIST/index.html" || { echo "index.html 里没有指向根路径的 /manifest.webmanifest"; exit 1; }
# 还残留 /app/ 前缀就是 base 没改干净（/app/ 在 nginx 里只剩 301，资源会多绕一跳甚至丢 hash 缓存）
if grep -q '"/app/' "$DIST/index.html"; then echo "index.html 里还有 /app/ 开头的路径，base 没改干净"; exit 1; fi
# 光传产物不够：根路径那几段只写在仓库这份 nginx 配置里，不一起推上去，发完照样是 404
[ -f "$NGINX_CONF" ] || { echo "找不到 $NGINX_CONF，没有它发上去就是 404"; exit 1; }
grep -q 'root /var/www/acorn-web;' "$NGINX_CONF" || { echo "nginx-acorn.conf 里没有根路径网页版那一段（root /var/www/acorn-web）"; exit 1; }
grep -q 'try_files $uri $uri/ /index.html;' "$NGINX_CONF" || { echo "nginx-acorn.conf 里的 location / 不是网页版（没有 try_files … /index.html）"; exit 1; }
# 字体是网页版最大的一笔流量，顺手把数目和体积念出来，胀回去了人能看见
FONT_BYTES="$(find "$DIST/assets" -name '*.woff2' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')"
echo "  产物 $(du -sh "$DIST" | cut -f1)，其中字体 $((FONT_BYTES / 1024)) KB"
if [ "$FONT_BYTES" -gt 3000000 ]; then
  echo "  ！字体超过 3 MB——文楷是不是又被打进网页版了？见 src/styles/fonts-web.css"
  exit 1
fi

echo "=== 写 version.json（网页版靠它发现有新版）"
# 跟 publish-exe.sh 同一个理由：**必须让 python 自己写文件，不能重定向 stdout**。
# Windows 上 stdout 走控制台代码页（GBK），中文会被写成非 UTF-8 字节（2026-08-24 踩过）。
python - "$VER" "$DIST/version.json" <<'PY'
import json, sys, datetime, io
ver, out = sys.argv[1:3]
io.open(out, "w", encoding="utf-8").write(json.dumps({
    "version": ver,
    "publishedAt": datetime.datetime.now(datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
}, ensure_ascii=False, indent=2))
PY
# 这句自检故意只打 ASCII：Windows 的控制台代码页是 GBK，python 往 stdout 打中文会花屏，
# 看着像出错了其实没有（文件是 python 自己用 utf-8 写的，没经过 stdout）
python -c "import io,json,sys; d=json.load(io.open(sys.argv[1],encoding='utf-8')); print('  version.json ok (valid UTF-8 JSON):', d['version'])" "$DIST/version.json"

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "=== --dry-run：到此为止，没往服务器传任何东西"
  echo "    真发的话去掉 --dry-run；会把 $DIST 整个替换掉 $HOST:$REMOTE_DIR，"
  echo "    并把 server/deploy/nginx-acorn.conf 装成服务器上的 /etc/nginx/conf.d/acorn.conf"
  exit 0
fi

echo "=== 打包上传"
TGZ="$(mktemp -t acorn-web-XXXXXX).tgz"
tar -czf "$TGZ" -C "$DIST" .
echo "  $(du -h "$TGZ" | cut -f1)"
"${SCP[@]}" "$TGZ" "$HOST:/tmp/acorn-web.tgz"
rm -f "$TGZ"

echo "=== 换上新的一份（整目录换，不是逐个文件覆盖）"
# 逐个文件覆盖有个真问题：新的 index.html 已经上去了、它要的新 js 还没上去，
# 这中间谁打开页面就是一片白。所以先在旁边解包，再一次 mv 换过去，中间那一下是毫秒级的。
"${SSH[@]}" bash -s <<REMOTE
set -euo pipefail
rm -rf "$REMOTE_DIR.new" "$REMOTE_DIR.old"
mkdir -p "$REMOTE_DIR.new"
tar xzf /tmp/acorn-web.tgz -C "$REMOTE_DIR.new"
chmod -R a+rX "$REMOTE_DIR.new"
if [ -d "$REMOTE_DIR" ]; then mv "$REMOTE_DIR" "$REMOTE_DIR.old"; fi
mv "$REMOTE_DIR.new" "$REMOTE_DIR"
rm -rf "$REMOTE_DIR.old"
rm -f /tmp/acorn-web.tgz
echo "  现在 \$(ls -1 "$REMOTE_DIR" | wc -l) 个条目，\$(du -sh "$REMOTE_DIR" | cut -f1)"
REMOTE

echo "=== 装 nginx 配置"
# 只传产物是不够的：根路径的网页版那几段 location（/ /assets/ /icons/ /manifest.webmanifest）
# 和 /app/ 的 301 只写在仓库这份 conf 里。不推这份配置，线上还是旧的地址规划。
# 回滚写法照抄 deploy.sh 第 5 节：坏配置绝不让 nginx 重载，这台机器上还有别人的站。
"${SCP[@]}" "$NGINX_CONF" "$HOST:/tmp/acorn.conf"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
CONF=/etc/nginx/conf.d/acorn.conf
BAK=/tmp/acorn.conf.bak
HAD=0
if [ -f "$CONF" ]; then cp "$CONF" "$BAK"; HAD=1; fi
cp /tmp/acorn.conf "$CONF"
rm -f /tmp/acorn.conf
if ! nginx -t; then
  echo "!! 新配置没过 nginx -t，已回退到发布前那份，其他站不受影响" >&2
  if [ "$HAD" = "1" ]; then cp "$BAK" "$CONF"; else rm -f "$CONF"; fi
  nginx -t && systemctl reload nginx
  exit 1
fi
systemctl reload nginx
rm -f "$BAK"
echo "  nginx 配置已装上并重载"
REMOTE

echo
echo "=== 外网自测（任何一条不是 200 就算没发成）"
# 以前这里只打印 %{http_code} 不判分，404 照样打印「发完了」——踩过，别再改回去。
FAILED=""
check() { # check 路径 这条是干嘛的
  local code
  # curl 自己连不上时 %{http_code} 就是 000，再 || echo 000 会打成 000000
  code="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$SITE$1" || true)"
  [ -n "$code" ] || code="000"
  printf '  %-26s HTTP %s  %s\n' "$1" "$code" "$2"
  [ "$code" = "200" ] || FAILED="$FAILED $1"
}
check / "网页版本体"
check /manifest.webmanifest "加到主屏幕靠它"
check /version.json "网页版靠它发现有新版"
check /intro/ "介绍页——我没把别人的站弄坏"
# 旧地址 /app/ 必须是 301（不跟跳转，-L 不能加：加了看到的是落地页的 200，跳转坏了也发现不了）
APP_CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$SITE/app/" || true)"
[ -n "$APP_CODE" ] || APP_CODE="000"
printf '  %-26s HTTP %s  %s\n' "/app/" "$APP_CODE" "旧地址跳根路径（要 301）"
[ "$APP_CODE" = "301" ] || FAILED="$FAILED /app/(要301)"
if [ -n "$FAILED" ]; then
  echo >&2
  echo "!! 这几条不对：$FAILED" >&2
  echo "   别当成发完了。先上服务器看 /etc/nginx/conf.d/acorn.conf 里的 location / 是不是网页版、/app/ 是不是 301。" >&2
  exit 1
fi
echo "  /version.json 里是：$(curl -s -m 15 "$SITE/version.json" | tr -d '\n')"
echo
echo "发完了。手机上打开 $SITE/ ，分享 → 添加到主屏幕。"
