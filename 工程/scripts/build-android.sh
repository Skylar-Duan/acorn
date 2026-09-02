#!/usr/bin/env bash
#
# 打安卓 APK。
#
# 为什么不能就地打：**S 盘是 exFAT，不支持符号链接**。Tauri 打安卓时要把编译好的
# libacorn_lib.so 用符号链接放进 gen/android/.../jniLibs/，在 exFAT 上直接
# "IO error: 函数不正确 (os error 1)"。Rust 本身编译得好好的，就死在这一步。
#
# 所以：把工程镜像到 C 盘（NTFS）上打，产物再拷回项目 target 目录。
# 镜像目录是可丢弃的，删了下次自动重建（代价是 Rust 全量重编，约 4 分钟）。
#
# 前置（这台机器上已装好，换机器要重来一遍）：
#   JDK 17          %LOCALAPPDATA%\Programs\dev\jdk-17.x
#   Android SDK 34  %LOCALAPPDATA%\Android\Sdk（platform-tools / build-tools;34 / ndk;27.1）
#   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
#
# 用法：
#   bash scripts/build-android.sh              # arm64（绝大多数手机），release
#   bash scripts/build-android.sh --universal  # 四种架构全打，包大很多
#   bash scripts/build-android.sh --debug      # debug 包，自带 debug 签名可直接装
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$(cygpath -u "${LOCALAPPDATA:-C:/Users/$USERNAME/AppData/Local}")"
# 镜像目录**故意不放在 %LOCALAPPDATA% 下面**：这台机器上 CC 进程写 AppData 会被
# MSIX 容器悄悄重定向到 ...\Packages\Claude_*\LocalCache\，路径对不上很难查。
# 放家目录下就是实打实的位置。
HOME_WIN="$(cygpath -u "${USERPROFILE:-C:/Users/$USERNAME}")"
MIRROR="${ACORN_ANDROID_MIRROR:-$HOME_WIN/acorn-android-build}"
OUT="$HERE/src-tauri/target/release/bundle/android"

export JAVA_HOME="${JAVA_HOME:-$LOCAL/Programs/dev/jdk-17.0.20.1+1}"
export ANDROID_HOME="${ANDROID_HOME:-$LOCAL/Android/Sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.1.12297006}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

[ -x "$JAVA_HOME/bin/java" ] || { echo "找不到 JDK：$JAVA_HOME"; exit 1; }
[ -d "$NDK_HOME" ] || { echo "找不到 NDK：$NDK_HOME"; exit 1; }

TARGET_ARGS=(--target aarch64)
PROFILE_ARGS=()
for a in "$@"; do
  case "$a" in
    --universal) TARGET_ARGS=() ;;
    --debug) PROFILE_ARGS=(--debug) ;;
    *) echo "不认识的参数：$a"; exit 1 ;;
  esac
done

GEN_SRC="$HERE/src-tauri/gen/android"
if [ ! -d "$GEN_SRC" ]; then
  echo "=== 首次：生成安卓工程"
  (cd "$HERE" && npx tauri android init)
fi

# gen/ 是可再生的（不入库），所以每次都把我们需要的那点定制**幂等地**打回去。
# 目前只有一处：允许 App 自己拉起安装器装新版（App 内更新那条路要用）。
MANIFEST="$GEN_SRC/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ] && ! grep -q "REQUEST_INSTALL_PACKAGES" "$MANIFEST"; then
  echo "=== 给 AndroidManifest 补上「允许安装应用」权限"
  python - "$MANIFEST" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
anchor = '<uses-permission android:name="android.permission.INTERNET" />'
add = (anchor + "\n"
       "    <!-- App 内更新：下完新版直接交给系统安装器，不用让人去浏览器翻下载目录 -->\n"
       '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />')
if anchor not in s:
    raise SystemExit("AndroidManifest 里找不到 INTERNET 那行，权限没打上")
io.open(p, "w", encoding="utf-8", newline="").write(s.replace(anchor, add, 1))
print("  已补上 REQUEST_INSTALL_PACKAGES")
PY
fi

# 安卓启动图标必须是橡果自己的：gen/android 里的 mipmap 是 `tauri android init` 时放的 Tauri 默认图标，
# 用户 2026-09-02 在手机上一眼看到的就是那个黄蓝圈。每次打包前从桌面同一张源图重生成一遍（幂等，10 秒），
# 顺手删掉它一起生成的 ios/ 与 icon.icns（Windows 项目用不上，别进仓库）。
echo "=== 重生成图标（含安卓 mipmap）"
(cd "$HERE" && npx tauri icon src-tauri/icons/app-icon.png >/dev/null 2>&1 && rm -rf src-tauri/icons/ios src-tauri/icons/icon.icns) || echo "  图标重生成失败（继续打包，但要检查安卓图标）"

echo "=== 镜像到 NTFS：$MIRROR"
mkdir -p "$MIRROR"
# robocopy 的退出码 0-7 都算成功（8 起才是真错），所以要手动放行
MIRROR_WIN="$(cygpath -w "$MIRROR")"
HERE_WIN="$(cygpath -w "$HERE")"
set +e
# 排除项只给目录名的话 robocopy 会在**任意层级**匹配：写 "dist" 会连
# node_modules/vite/dist 一起排掉，然后 vite 根本跑不起来（踩过）。所以给全路径。
robocopy "$HERE_WIN" "$MIRROR_WIN" //MIR //NFL //NDL //NJH //NJS //NP //MT:16 \
  //XD "$HERE_WIN\\.git" "$HERE_WIN\\dist" "$HERE_WIN\\src-tauri\\target" >/dev/null
rc=$?
set -e
[ "$rc" -lt 8 ] || { echo "robocopy 失败（$rc）"; exit 1; }

echo "=== 打包（$( [ ${#TARGET_ARGS[@]} -eq 0 ] && echo 四架构 || echo arm64 )${PROFILE_ARGS:+ · debug}）"
cd "$MIRROR"
set +e
npx tauri android build --apk "${TARGET_ARGS[@]}" "${PROFILE_ARGS[@]}"
tauri_rc=$?
set -e

if [ "$tauri_rc" -ne 0 ]; then
  # 第二道坎：Tauri 要用**符号链接**把编译好的 .so 放进 jniLibs，而 Windows 默认
  # 不允许普通用户建符号链接（要开「开发者模式」——那是系统设置，不替用户动）。
  # 好在这时 Rust 已经编译完了，手动拷进去，再让 Gradle 直接打包（跳过它自己那步 rustBuild）。
  echo
  echo "--- tauri 在符号链接那步停了，改用「拷 .so + 直接 gradle」这条路 ---"
  GEN="$MIRROR/src-tauri/gen/android"
  declare -A ABI=( [aarch64-linux-android]=arm64-v8a [armv7-linux-androideabi]=armeabi-v7a
                   [i686-linux-android]=x86 [x86_64-linux-android]=x86_64 )
  profile=$([ ${#PROFILE_ARGS[@]} -gt 0 ] && echo debug || echo release)
  copied=0
  for triple in "${!ABI[@]}"; do
    so="$MIRROR/src-tauri/target/$triple/$profile/libacorn_lib.so"
    [ -f "$so" ] || continue
    mkdir -p "$GEN/app/src/main/jniLibs/${ABI[$triple]}"
    cp -f "$so" "$GEN/app/src/main/jniLibs/${ABI[$triple]}/"
    echo "  拷入 ${ABI[$triple]}"
    copied=$((copied + 1))
  done
  [ "$copied" -gt 0 ] || { echo "一个 .so 都没有，说明 Rust 那步就没过，看上面的报错"; exit 1; }

  flavor=$([ ${#TARGET_ARGS[@]} -eq 0 ] && echo Universal || echo Arm64)
  buildType=$([ "$profile" = debug ] && echo Debug || echo Release)
  cd "$GEN"
  ./gradlew "assemble${flavor}${buildType}" -x "rustBuild${flavor}${buildType}" --console=plain
  cd "$MIRROR"
fi

echo "=== 签名"
# release 包出来是未签名的，不签装不上。用安卓官方的 debug 密钥签：
#   口令固定是 "android"，这是公开约定值，不是任何人的凭据。
# 上架商店要换成你自己的正式密钥（那把钥匙一旦丢了就再也无法更新已上架的应用，
# 必须由你本人生成保管，我不代劳）。
KS="$HOME_WIN/.android/debug.keystore"
if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -v -keystore "$(cygpath -w "$KS")" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
  echo "  新建了 debug keystore"
fi
BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
# 直接抠 package.json 的版本号：不能用 node -p require()，MSYS 的 /c/... 路径 node 认不出来
VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -1)"

echo "=== 收产物"
mkdir -p "$OUT"
found=0
while IFS= read -r apk; do
  case "$apk" in *-unsigned.apk) ;; *) continue ;; esac
  arch="$(basename "$(dirname "$(dirname "$apk")")")"
  aligned="$OUT/.aligned.apk"
  final="$OUT/Acorn_${VER}_${arch}.apk"
  "$BT/zipalign.exe" -p -f 4 "$(cygpath -w "$apk")" "$(cygpath -w "$aligned")"
  "$BT/apksigner.bat" sign --ks "$(cygpath -w "$KS")" --ks-pass pass:android \
    --key-pass pass:android --ks-key-alias androiddebugkey \
    --out "$(cygpath -w "$final")" "$(cygpath -w "$aligned")"
  rm -f "$aligned" "$aligned.idsig" "$final.idsig"
  echo "  $(basename "$final")  $(du -h "$final" | cut -f1)"
  found=1
done < <(find "$MIRROR/src-tauri/gen/android/app/build/outputs/apk" -name "*.apk" 2>/dev/null)
[ "$found" = 1 ] || { echo "没找到 APK，去 $MIRROR/src-tauri/gen/android/app/build/outputs/ 看看"; exit 1; }

echo
echo "APK 在：$OUT"
