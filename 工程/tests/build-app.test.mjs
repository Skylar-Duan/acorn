import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const source = readFileSync(new URL("../scripts/build-app.mjs", import.meta.url), "utf8");

// 只替换子进程边界；实际构建脚本在隔离临时目录运行，不调用 Tauri/SSH、不读用户数据。
function fixture(t, status) {
  const base = mkdtempSync(join(tmpdir(), "acorn-build-edition-"));
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
    import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    export function spawnSync(command, args, options) {
      if (command !== "npx") throw new Error("测试不允许发布/其它子进程");
      const { ACORN_BUILD_PLATFORM, ACORN_BUILD_EDITION, ACORN_BUILD_VERSION } = options.env;
      const config = JSON.parse(readFileSync(join(options.cwd, "src-tauri/tauri.version.json"), "utf8"));
      writeFileSync(join(options.cwd, "synthetic-stamp.json"), JSON.stringify({ ACORN_BUILD_PLATFORM, ACORN_BUILD_EDITION, ACORN_BUILD_VERSION, config }));
      if (${status} === 0) {
        const folder = join(options.cwd, "src-tauri/target/release/bundle/nsis");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "Acorn_1.2.4-beta.1_x64-setup.exe"), "Synthetic bytes; not an executable.");
      }
      return { status: ${status} };
    }
  `);
  const versions = { public: { desktop: "1.2.3" }, beta: { desktop: 0 }, betaAfter: { desktop: "1.2.3" } };
  write(join(project, "versions.json"), JSON.stringify(versions));
  write(join(project, "src-tauri", "tauri.conf.json"), JSON.stringify({ app: { windows: [{ label: "main", height: 800 }, { label: "quickadd", height: 250 }] } }));
  return { project, base, versions, run: () => spawnSync(process.execPath, [script, "desktop", "--beta", "--ultra", "--no-publish"], { cwd: project, encoding: "utf8" }) };
}

test("构建失败仍删除覆盖配置、不占 beta 号、不产出安装包", t => {
  const f = fixture(t, 7);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(f.project, "src-tauri", "tauri.version.json")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.project, "versions.json"), "utf8")), f.versions);
  assert.equal(existsSync(join(f.base, "安装包")), false);
});

test("Ultra 成功产物不残留普通文件名，构建戳和共享 beta 计数正确", t => {
  const f = fixture(t, 0);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const nsis = join(f.project, "src-tauri", "target", "release", "bundle", "nsis");
  assert.equal(existsSync(join(nsis, "Acorn_1.2.4-beta.1_x64-setup.exe")), false);
  assert.equal(existsSync(join(nsis, "AcornUltra_1.2.4-beta.1_x64-setup.exe")), true);
  assert.equal(existsSync(join(f.base, "安装包", "橡果 Ultra beta 安装包.exe")), true);
  assert.equal(existsSync(join(f.base, "安装包", "橡果 beta 安装包.exe")), false);
  assert.equal(existsSync(join(f.project, "src-tauri", "tauri.version.json")), false);
  assert.equal(JSON.parse(readFileSync(join(f.project, "versions.json"), "utf8")).beta.desktop, 1);
  const stamp = JSON.parse(readFileSync(join(f.project, "synthetic-stamp.json"), "utf8"));
  assert.equal(stamp.ACORN_BUILD_PLATFORM, "desktop");
  assert.equal(stamp.ACORN_BUILD_EDITION, "ultra");
  assert.equal(stamp.ACORN_BUILD_VERSION, "1.2.4-beta.1");
  assert.deepEqual(stamp.config, { version: "1.2.4-beta.1" }); // 两版沿用相同的窗口配置，图片区有内容时自行扩展。
});
