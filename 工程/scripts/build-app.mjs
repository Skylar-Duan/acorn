#!/usr/bin/env node
// 给某一端打包，号码一律从 versions.json 拿（2026-09-18 起三端各排各的号，见 src/core/version.ts）。
//
//   node scripts/build-app.mjs desktop --beta   # 桌面测试版：计数 +1，号 = 公开号的下一个小修号 + -beta.N
//   node scripts/build-app.mjs android --beta   # 安卓测试版（走 build-android.sh）
//   node scripts/build-app.mjs desktop          # 正式包：用 versions.json 里这一端 public 的号
//
// 测试版：只装给用户自己试，**不推更新服务器**——publish-exe.sh / publish-apk.sh 的文件名规则也认不出
// 带 -beta 的包，推不上去。打完复制到 ../安装包/，名字固定（每次覆盖），用户只需要最新那一个。
// 正式包：发布前先把 versions.json 里那一端的 public 改成要发的号、beta 归零，再跑本脚本。
// 网页版没有测试版，也不在这儿打：server/deploy/publish-web.sh 自己构建、自己发。
//
// 为什么不改 tauri.conf.json 的 version：三端的号不一样，文件里只能写一个。改用 tauri 的
// --config 临时盖一层（写一个 tauri.version.json，打完删掉），文件里那个号就不再有人信它。

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSIONS = join(HERE, "versions.json");
const PKG_DIR = resolve(HERE, "..", "安装包");

const [platform, ...flags] = process.argv.slice(2);
const beta = flags.includes("--beta");
if (!["desktop", "android"].includes(platform)) {
  console.error("用法：node scripts/build-app.mjs <desktop|android> [--beta]（网页版走 server/deploy/publish-web.sh）");
  process.exit(1);
}

const table = JSON.parse(readFileSync(VERSIONS, "utf8"));
const pub = table.public?.[platform];
if (!/^\d+\.\d+\.\d+$/.test(pub ?? "")) {
  console.error(`versions.json 里 ${platform} 的公开号不对：${pub}`);
  process.exit(1);
}

let version = pub;
let n = 0;
if (beta) {
  n = (Number(table.beta?.[platform]) || 0) + 1;
  const [a, b, c] = pub.split(".").map(Number);
  version = `${a}.${b}.${c + 1}-beta.${n}`;
}

const label = { desktop: "桌面版", android: "安卓版" }[platform];
console.log(`=== ${label} ${beta ? `测试版 ${n}（号 ${version}，接在 v${pub} 之后）` : `正式包 v${version}`}`);

const env = { ...process.env, ACORN_BUILD_PLATFORM: platform, ACORN_BUILD_VERSION: version };
// cargo 装在 ~/.cargo/bin，但不一定在当前会话的 PATH 里（两台机器都遇到过）。
// Windows 上环境变量名不分大小写，展开成普通对象后却分了——找到原来那个键再往前插，别另起一个 PATH
const cargoBin = join(homedir(), ".cargo", "bin");
if (existsSync(cargoBin)) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[key] = `${cargoBin}${delimiter}${env[key] ?? ""}`;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: HERE, env, stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`\n✗ ${cmd} ${args.join(" ")} 失败（退出码 ${r.status}）`);
    process.exit(r.status || 1);
  }
}

let artifact;
if (platform === "desktop") {
  const override = join(HERE, "src-tauri", "tauri.version.json");
  writeFileSync(override, JSON.stringify({ version }));
  try {
    run("npx", ["tauri", "build", "--config", "src-tauri/tauri.version.json"]);
  } finally {
    rmSync(override, { force: true });
  }
  artifact = join(HERE, "src-tauri", "target", "release", "bundle", "nsis", `Acorn_${version}_x64-setup.exe`);
} else {
  run("bash", ["scripts/build-android.sh"]);
  artifact = join(HERE, "src-tauri", "target", "release", "bundle", "android", `Acorn_${version}_arm64.apk`);
}

if (!existsSync(artifact)) {
  console.error(`✗ 打包说成功了，但找不到产物：${artifact}`);
  process.exit(1);
}

// 计数只在真打出包之后才落盘：半路失败不白占一个号
if (beta) {
  table.beta = { ...(table.beta ?? {}), [platform]: n };
  writeFileSync(VERSIONS, JSON.stringify(table, null, 2) + "\n");
}

mkdirSync(PKG_DIR, { recursive: true });
const ext = platform === "desktop" ? "exe" : "apk";
const dest = join(PKG_DIR, beta ? `橡果 ${label} 测试版.${ext}` : `橡果 ${label} v${version}.${ext}`);
copyFileSync(artifact, dest);
console.log(`\n✓ 产物：${artifact}\n✓ 复制到：${dest}`);
