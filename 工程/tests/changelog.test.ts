// 给使用者看的那份更新日志（core/changelog.ts）。
// 它跟 CHANGELOG.md 是两份：那份是工程记录，这份打进包里、侧栏版本号点开就是它。
// 2026-09-18 起三端各排各的号：每条写「发到哪几端、各几号」，每端只看得到跟自己有关的条目。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHANGELOG, changelogFor } from "../src/core/changelog";
import { APP_VERSION } from "../src/core/model";
import { APP_PLATFORM, PLATFORMS, compareVersions } from "../src/core/version";

const table = JSON.parse(readFileSync("versions.json", "utf8")) as {
  public: Record<string, string>;
};

describe("产品向更新日志", () => {
  it("每一端最新一条的号 = versions.json 里这一端公开的号（发了版忘了写日志会红）", () => {
    for (const p of PLATFORMS) {
      expect(changelogFor(p)[0]?.version, p).toBe(table.public[p]);
    }
  });

  it("这一端最新一条的号 = 应用里显示的 APP_VERSION", () => {
    // vite 的 define 在 vitest 里同样生效；测试环境没有安卓 UA、不是网页版构建，算桌面版
    expect(APP_PLATFORM).toBe("desktop");
    expect(APP_VERSION).not.toBe("dev");
    expect(changelogFor(APP_PLATFORM)[0].version).toBe(APP_VERSION);
  });

  it("每条至少发到一端，号都是正经版本号 + YYYY-MM-DD（不再有「更早」那种历史回顾）", () => {
    // 用户 2026-09-02：「把历史建立和隐藏的部分都去掉，不再谈」
    for (const e of CHANGELOG) {
      const vs = Object.values(e.versions);
      expect(vs.length, e.headline).toBeGreaterThan(0);
      for (const v of vs) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.headline.length).toBeGreaterThan(4);
      expect(e.highlights.length).toBeGreaterThan(0);
      // 主卡最多五张：再多就又成了一列文本
      expect(e.highlights.length).toBeLessThanOrEqual(5);
    }
  });

  it("写在文件里的顺序，放到每一端去看也是从新到旧（新条目要加在最上面）", () => {
    for (const p of PLATFORMS) {
      const inFile = CHANGELOG.map((e) => e.versions[p]).filter((v): v is string => !!v);
      const sorted = [...inFile].sort((a, b) => compareVersions(b, a));
      expect(inFile, p).toEqual(sorted);
      // 同一端里不许有两条同号：更新日志弹窗拿号码当 key，重了会串
      expect(new Set(inFile).size, p).toBe(inFile.length);
    }
  });

  it("各端只看到跟自己有关的：电脑上没有「手机上装新版」那条，网页版只从 1.15.0 起", () => {
    const desktop = changelogFor("desktop").map((e) => e.version);
    const android = changelogFor("android").map((e) => e.version);
    const web = changelogFor("web").map((e) => e.version);
    expect(android).toContain("1.14.2");
    expect(desktop).not.toContain("1.14.2");
    expect(web).toEqual(["1.15.0"]);
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
