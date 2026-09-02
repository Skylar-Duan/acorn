// 给使用者看的那份更新日志（core/changelog.ts）。
// 它跟 CHANGELOG.md 是两份：那份是工程记录，这份打进包里、侧栏版本号点开就是它。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHANGELOG } from "../src/core/changelog";
import { APP_VERSION } from "../src/core/model";

describe("产品向更新日志", () => {
  it("最新一条的版本号 = package.json 的版本号（发了版忘了写日志会红）", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(CHANGELOG[0].version).toBe(pkg.version);
  });

  it("最新一条的版本号 = 应用里显示的 APP_VERSION", () => {
    // vite 的 define 在 vitest 里同样生效，所以这儿拿到的就是 package.json 那个
    expect(APP_VERSION).not.toBe("dev");
    expect(CHANGELOG[0].version).toBe(APP_VERSION);
  });

  it("按版本从新到旧排，日期是 YYYY-MM-DD 或一段区间", () => {
    for (const e of CHANGELOG) {
      expect(e.lines.length).toBeGreaterThan(0);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}( → \d{4}-\d{2}-\d{2})?$/);
    }
    const numbered = CHANGELOG.filter((e) => /^\d/.test(e.version)).map((e) => e.version);
    const sorted = [...numbered].sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
    expect(numbered).toEqual(sorted);
  });

  it("每一条都是给人看的话：不带文件名、CSS 变量、函数调用这类工程词", () => {
    // 用户 2026-09-01 定的：这里不是工程项，是产品向。
    // 一堆小修写成「多处优化使用流畅度」，不罗列改了哪个文件哪条变量
    const engineering = /\.(tsx?|css|md|json|rs|py)\b|--[a-z][a-z0-9-]*|\w+\(\)|src\/|store\.|useState|grid-template/;
    for (const e of CHANGELOG) {
      for (const line of e.lines) {
        expect(line, `「${line.slice(0, 40)}…」像工程项`).not.toMatch(engineering);
      }
    }
  });
});
