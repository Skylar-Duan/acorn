import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";

const source = readFileSync(new URL("../scripts/build-app.mjs", import.meta.url), "utf8");

// 只替换子进程边界；实际构建脚本在隔离临时目录运行，不调用 Tauri/SSH、不读用户数据。
function fixture(t, setup = {}) {
  const options = { buildStatus: 0, publishStatus: 0, artifact: true, ...setup };
  const base = mkdtempSync(join(tmpdir(), "acorn-build-single-"));
  t.after(() => {
    assert.equal(dirname(base), tmpdir()); // 递归清理只允许本次新建的临时目录。
    rmSync(base, { recursive: true, force: true });
  });
  const project = join(base, "工程");
  const script = join(project, "scripts", "build-app.mjs");
  const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  assert.ok(source.includes('import { spawnSync } from "node:child_process";'));
  write(script, source.replace('import { spawnSync } from "node:child_process";', 'import { spawnSync } from "./synthetic-child.mjs";'));
  write(join(project, "scripts", "synthetic-child.mjs"), `
    import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const setup = ${JSON.stringify(options)};
    export function spawnSync(command, args, options) {
      const { ACORN_BUILD_PLATFORM, ACORN_BUILD_EDITION, ACORN_BUILD_VERSION } = options.env;
      const stamp = { command, args, ACORN_BUILD_PLATFORM, ACORN_BUILD_EDITION, ACORN_BUILD_VERSION };
      const capture = () => appendFileSync(join(options.cwd, "synthetic-calls.jsonl"), JSON.stringify(stamp) + "\\n");
      const desktop = command === "npx" && JSON.stringify(args) === JSON.stringify(["tauri", "build", "--config", "src-tauri/tauri.version.json"]);
      const android = command === "bash" && args[0] === "scripts/build-android.sh";
      if (desktop || android) {
        if (desktop) stamp.config = JSON.parse(readFileSync(join(options.cwd, "src-tauri/tauri.version.json"), "utf8"));
        capture();
        if (setup.buildStatus === 0 && setup.artifact) {
        const folder = join(options.cwd, "src-tauri/target/release/bundle", desktop ? "nsis" : "android");
        mkdirSync(folder, { recursive: true });
          writeFileSync(join(folder, "Acorn_" + ACORN_BUILD_VERSION + (desktop ? "_x64-setup.exe" : "_arm64.apk")), "Synthetic bytes; not executable.");
        }
        return { status: setup.buildStatus };
      }
      if (command === "bash" && ["server/deploy/publish-exe.sh", "server/deploy/publish-apk.sh"].includes(args[0])) {
        const nativePath = value => process.platform === "win32" ? value.replace(new RegExp("^/([a-z])/", "i"), (_, drive) => drive.toUpperCase() + ":/") : value;
        stamp.notesFile = nativePath(args[2]);
        stamp.notes = readFileSync(stamp.notesFile, "utf8"); capture();
        return { status: setup.publishStatus };
      }
      throw new Error("测试不允许未知子进程：" + command + " " + args.join(" "));
    }
  `);
  const versions = options.versions ?? { public: { desktop: "1.2.3", android: "1.2.3" }, beta: { desktop: 0 }, betaAfter: { desktop: "1.2.3" } };
  write(join(project, "versions.json"), JSON.stringify(versions));
  const config = JSON.stringify({ app: { windows: [{ label: "main", height: 800 }, { label: "quickadd", height: 210 }] } });
  write(join(project, "src-tauri", "tauri.conf.json"), config);
  write(join(project, "src", "core", "changelog-data.json"), JSON.stringify({ beta: { desktop: { highlights: [
    { title: "共同功能" }, { title: "通用增强", edition: "common" }, { title: "基础体验", edition: "normal" },
    { title: "账号解锁图片", edition: "ultra" }, { title: "Plus专属", edition: "plus" }, { title: "未知权限功能", edition: "future" },
  ] } } }));
  const cache = join(project, "src-tauri", "target", "release", ".fingerprint", "synthetic-cache");
  write(cache, "keep incremental cache");
  return {
    project, base, versions, cache, config,
    calls: () => existsSync(join(project, "synthetic-calls.jsonl")) ? readFileSync(join(project, "synthetic-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [],
    table: () => JSON.parse(readFileSync(join(project, "versions.json"), "utf8")),
    run: (flags = ["--beta", "--no-publish"], platform = "desktop", extraEnv = {}) => spawnSync(process.execPath, [script, platform, ...flags], { cwd: project, encoding: "utf8", env: { ...process.env, ...extraEnv } }),
  };
}

test("构建失败仍删除覆盖配置、不占 beta 号、不产出安装包", t => {
  const f = fixture(t, { buildStatus: 7 });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(f.project, "src-tauri", "tauri.version.json")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.project, "versions.json"), "utf8")), f.versions);
  assert.equal(existsSync(join(f.base, "安装包")), false);
  assert.equal(readFileSync(f.cache, "utf8"), "keep incremental cache");
  assert.equal(f.calls().length, 1);
});

test("Windows每次只构建一个完整包，普通统一名称与beta编号正确，不清增量缓存", t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const nsis = join(f.project, "src-tauri", "target", "release", "bundle", "nsis");
  assert.deepEqual(readdirSync(nsis), ["Acorn_1.2.4-beta.1_x64-setup.exe"]);
  assert.deepEqual(readdirSync(join(f.base, "安装包")), ["橡果 beta 安装包.exe"]);
  assert.equal(existsSync(join(f.project, "src-tauri", "tauri.version.json")), false);
  assert.equal(JSON.parse(readFileSync(join(f.project, "versions.json"), "utf8")).beta.desktop, 1);
  const [stamp] = f.calls(); assert.equal(f.calls().length, 1);
  assert.equal(stamp.ACORN_BUILD_PLATFORM, "desktop");
  assert.equal(stamp.ACORN_BUILD_EDITION, "normal");
  assert.equal(stamp.ACORN_BUILD_VERSION, "1.2.4-beta.1");
  assert.deepEqual(stamp.config, { version: "1.2.4-beta.1" });
  assert.equal(readFileSync(join(f.project, "src-tauri", "tauri.conf.json"), "utf8"), f.config);
  assert.equal(readFileSync(f.cache, "utf8"), "keep incremental cache");
});

for (const flag of ["--ultra", "--plus", "--ultra=true", "--plus=1"]) {
  test(`${flag}在读取版本与启动构建之前明确拒绝`, t => {
    const f = fixture(t); const versionsPath = join(f.project, "versions.json");
    writeFileSync(versionsPath, "deliberately invalid JSON to prove argument validation runs first");
    const result = f.run(["--beta", flag]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /已停用.*Windows.*完整安装包.*desktop/);
    assert.doesNotMatch(result.stderr, /SyntaxError/); assert.deepEqual(f.calls(), []);
    assert.equal(existsSync(join(f.project, "src-tauri", "tauri.version.json")), false);
    assert.equal(existsSync(join(f.base, "安装包")), false);
  });
}

test("正式包只用public版本、不自动发布，外部旧edition环境不能改成Ultra包", t => {
  const f = fixture(t); const result = f.run([], "desktop", { ACORN_BUILD_EDITION: "ultra" });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(f.table(), f.versions);
  assert.deepEqual(readdirSync(join(f.base, "安装包")), ["橡果 v1.2.3 安装包.exe"]);
  assert.equal(f.calls().length, 1); assert.equal(f.calls()[0].ACORN_BUILD_EDITION, "normal");
  assert.equal(f.calls()[0].ACORN_BUILD_VERSION, "1.2.3");
});

test("发布过新正式版后beta重启于1，接着同一轮递增到2，每次只调用一次构建", t => {
  const f = fixture(t, { versions: { public: { desktop: "1.2.3" }, beta: { desktop: 9 }, betaAfter: { desktop: "1.2.2" } } });
  assert.equal(f.run().status, 0); assert.equal(f.table().beta.desktop, 1); assert.equal(f.table().betaAfter.desktop, "1.2.3");
  assert.equal(f.run().status, 0); assert.equal(f.table().beta.desktop, 2);
  assert.deepEqual(f.calls().map(call => call.ACORN_BUILD_VERSION), ["1.2.4-beta.1", "1.2.4-beta.2"]);
});

test("子构建报成功却缺产物时，不占beta号、不复制，临时覆盖已删除", t => {
  const f = fixture(t, { artifact: false }); const result = f.run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /找不到产物/);
  assert.deepEqual(f.table(), f.versions); assert.equal(existsSync(join(f.base, "安装包")), false);
  assert.equal(existsSync(join(f.project, "src-tauri", "tauri.version.json")), false);
});

test("beta默认只向公共Windows脚本推一次，manifest只含共同条目，临时说明会清理", t => {
  const f = fixture(t); const result = f.run(["--beta"]);
  assert.equal(result.status, 0, result.stderr); const calls = f.calls(); assert.equal(calls.length, 2);
  assert.equal(calls[1].command, "bash"); assert.equal(calls[1].args[0], "server/deploy/publish-exe.sh"); assert.equal(calls[1].args[3], "--beta");
  assert.equal(calls[1].notes, "测试版：共同功能；通用增强；基础体验"); assert.doesNotMatch(calls[1].notes, /账号解锁图片|Plus专属|未知权限功能/);
  assert.equal(existsSync(calls[1].notesFile), false);
  assert.equal(f.table().beta.desktop, 1);
});

test("发布失败清理临时说明，但保留已成功产物与已使用编号，避免复用同号", t => {
  const f = fixture(t, { publishStatus: 9 }); const result = f.run(["--beta"]);
  assert.notEqual(result.status, 0); const calls = f.calls(); assert.equal(calls.length, 2);
  assert.equal(existsSync(calls[1].notesFile), false); assert.equal(f.table().beta.desktop, 1);
  assert.equal(existsSync(join(f.base, "安装包", "橡果 beta 安装包.exe")), true);
  assert.equal(existsSync(join(f.project, "src-tauri", "tauri.version.json")), false);
  assert.equal(readFileSync(f.cache, "utf8"), "keep incremental cache");
});

test("安卓原有构建和测试通道保留，仍只调用安卓版公共发布脚本", t => {
  const f = fixture(t); const result = f.run(["--beta"], "android");
  assert.equal(result.status, 0, result.stderr); const calls = f.calls();
  assert.equal(calls[0].args[0], "scripts/build-android.sh"); assert.equal(calls[1].args[0], "server/deploy/publish-apk.sh");
  assert.equal(f.table().beta.android, 1); assert.equal(existsSync(join(f.base, "安装包", "橡果 beta 安卓版.apk")), true);
});

test("真实Vite配置即使旧环境变量为ultra也产normal版本戳；只加载配置不构建", async () => {
  const before = process.env.ACORN_BUILD_EDITION; process.env.ACORN_BUILD_EDITION = "ultra";
  try {
    const result = await loadConfigFromFile({ command: "build", mode: "production" }, fileURLToPath(new URL("../vite.config.ts", import.meta.url)));
    assert.ok(result); assert.equal(JSON.parse(result.config.define.__APP_BUILD__).edition, "normal");
  } finally { if (before === undefined) delete process.env.ACORN_BUILD_EDITION; else process.env.ACORN_BUILD_EDITION = before; }
});
