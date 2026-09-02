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

  it("按版本从新到旧排，每版都是正经版本号 + YYYY-MM-DD（不再有「更早」那种历史回顾）", () => {
    // 用户 2026-09-02：「把历史建立和隐藏的部分都去掉，不再谈」
    for (const e of CHANGELOG) {
      expect(e.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.headline.length).toBeGreaterThan(4);
      expect(e.highlights.length).toBeGreaterThan(0);
      // 主卡最多五张：再多就又成了一列文本
      expect(e.highlights.length).toBeLessThanOrEqual(5);
    }
    const versions = CHANGELOG.map((e) => e.version);
    const sorted = [...versions].sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
    expect(versions).toEqual(sorted);
  });

  /** 这份日志里所有会显示出来的字 */
  function allText(): string[] {
    const out: string[] = [];
    for (const e of CHANGELOG) {
      out.push(e.headline);
      for (const h of e.highlights) out.push(h.title, h.body);
      if (e.minor) out.push(e.minor);
    }
    return out;
  }

  it("每一句都是给人看的话：不带文件名、CSS 变量、函数调用这类工程词", () => {
    // 用户 2026-09-01 定的：这里不是工程项，是产品向
    const engineering = /\.(tsx?|css|md|json|rs|py)\b|--[a-z][a-z0-9-]*|\w+\(\)|src\/|store\.|useState|grid-template|schema|DATA_VERSION|localStorage/i;
    for (const line of allText()) {
      expect(line, `「${line.slice(0, 40)}…」像工程项`).not.toMatch(engineering);
    }
  });

  it("不提已经删掉或藏起来的功能，也不回顾历史", () => {
    // 用户 2026-09-02：「已经删除或者隐藏的功能，就不要在更新日志里面提醒了」
    const banned = /专注|番茄|收起了|去掉了「用法」|用法页|v1\.0 到|从「能记一句话」/;
    for (const line of allText()) {
      expect(line, `「${line.slice(0, 40)}…」在提已删/已藏的东西`).not.toMatch(banned);
    }
  });

  it("小标题短、正文不啰嗦：title ≤ 12 字，body ≤ 90 字", () => {
    for (const e of CHANGELOG) {
      for (const h of e.highlights) {
        expect(h.title.length, h.title).toBeLessThanOrEqual(12);
        expect(h.body.length, h.title).toBeLessThanOrEqual(90);
      }
    }
  });
});
