// 给使用者看的那份更新日志（core/changelog.ts + changelog-data.json）。
// 它跟 CHANGELOG.md 是两份：那份是工程记录，这份打进包里、侧栏版本号点开就是它。
// 每一端一份；怎么写的规矩在 _work/约定.md 第五节，这里把能机械拦的都拦上。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BETA_NOTES, CHANGELOG, changelogFor, type ChangelogEntry } from "../src/core/changelog";
import { APP_PLATFORM, APP_VERSION, PLATFORMS, compareVersions } from "../src/core/version";

const table = JSON.parse(readFileSync("versions.json", "utf8")) as { public: Record<string, string> };

const allEntries = (): ChangelogEntry[] => [
  ...PLATFORMS.flatMap((p) => CHANGELOG[p]),
  ...PLATFORMS.flatMap((p) => (BETA_NOTES[p] ? [{ ...BETA_NOTES[p]!, version: "0.0.0" }] : [])),
];

/** 这份日志里所有会显示出来的字 */
function allText(): string[] {
  const out: string[] = [];
  for (const e of allEntries()) {
    out.push(e.headline);
    for (const h of e.highlights) out.push(h.title, h.body);
  }
  return out;
}

describe("号码对得上", () => {
  it("每一端最新一条的号 = versions.json 里这一端公开的号（发了版忘了写日志会红）", () => {
    for (const p of PLATFORMS) expect(CHANGELOG[p][0]?.version, p).toBe(table.public[p]);
  });

  it("这一端最新一条的号 = 应用里的 APP_VERSION（测试环境算桌面版）", () => {
    expect(APP_PLATFORM).toBe("desktop");
    expect(changelogFor("desktop", { beta: false })[0].version).toBe(APP_VERSION);
  });

  it("每一端从新到旧、不重号（弹窗拿号码当 key）", () => {
    for (const p of PLATFORMS) {
      const vs = CHANGELOG[p].map((e) => e.version);
      expect(vs, p).toEqual([...vs].sort((a, b) => compareVersions(b, a)));
      expect(new Set(vs).size, p).toBe(vs.length);
    }
  });
});

describe("分端：每一端只列它真拿到、且看得见变化的版本", () => {
  const vs = (p: "desktop" | "android" | "web") => CHANGELOG[p].map((e) => e.version);

  it("电脑上没有只改了手机的 1.14.2，也没有跟使用者无关的 1.14.3", () => {
    expect(vs("desktop")).not.toContain("1.14.2");
    expect(vs("desktop")).not.toContain("1.14.3");
  });

  it("手机上没有安卓没发过的 1.9.x / 1.14.1，也没有 1.14.3", () => {
    for (const v of ["1.9.0", "1.9.1", "1.14.1", "1.14.3"]) expect(vs("android")).not.toContain(v);
    expect(vs("android")).toContain("1.14.2");
  });

  it("网页版是 1.15.0 才有的，只有这一版", () => {
    expect(vs("web")).toEqual(["1.15.0"]);
  });

  it("电脑那份里不写手机才有的东西", () => {
    const text = CHANGELOG.desktop.flatMap((e) => [e.headline, ...e.highlights.flatMap((h) => [h.title, h.body])]);
    for (const line of text) expect(line, line).not.toMatch(/右滑|左滑|长按|底部导航|手机版|安装应用/);
  });
});

describe("测试版：第一块是比上一个正式版多了什么", () => {
  it("装着测试版时，第一块是这个测试版，上一个正式版挪进后面", () => {
    const list = changelogFor("desktop", { beta: true, betaVersion: "1.15.1-beta.3" });
    expect(list[0].version).toBe("1.15.1-beta.3");
    expect(list[0].headline).toBe(BETA_NOTES.desktop!.headline);
    expect(list[1].version).toBe(table.public.desktop);
  });

  it("正式版里没有那一块", () => {
    expect(changelogFor("desktop", { beta: false })[0].version).toBe(table.public.desktop);
  });
});

describe("写法", () => {
  it("每一版都是正经日期、有标题、至少一张小卡；正式版最多 6 张（新功能 + 一张「体验优化」）", () => {
    for (const e of allEntries()) {
      expect(e.date, e.headline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.headline.length).toBeGreaterThan(3);
      expect(e.highlights.length, e.headline).toBeGreaterThan(0);
    }
    for (const p of PLATFORMS) for (const e of CHANGELOG[p]) expect(e.highlights.length, e.version).toBeLessThanOrEqual(6);
  });

  it("「还有」那一行不要了：细节合成一张「体验优化」小卡（用户 2026-09-18）", () => {
    const dialog = readFileSync("src/components/ChangelogDialog.tsx", "utf8");
    // 只看画出来的东西：不再有「还有」那颗小标签和那一行（注释里提到它不算）
    expect(dialog).not.toMatch(/>还有</);
    expect(dialog).not.toContain("cl-minor");
    expect(dialog).not.toContain("e.minor");
    for (const e of allEntries()) expect(Object.keys(e)).not.toContain("minor");
  });

  it("测试版那段是给开发者看的：每处改动单独一张，不止一句带过", () => {
    // 用户 2026-09-18：「beta 版本的软件内更新日志一定要详细说明该 beta 累计的每处的改动」
    for (const p of PLATFORMS) {
      const notes = BETA_NOTES[p];
      if (notes) expect(notes.highlights.length, p).toBeGreaterThan(1);
    }
  });

  it("小标题是功能名：≤ 12 字；正文一两句：≤ 90 字", () => {
    for (const e of allEntries()) {
      for (const h of e.highlights) {
        expect(h.title.length, h.title).toBeLessThanOrEqual(12);
        expect(h.body.length, h.title).toBeLessThanOrEqual(90);
      }
    }
  });

  it("每一句都是给人看的话：不带文件名、CSS 变量、函数调用这类工程词", () => {
    const engineering = /\.(tsx?|css|md|json|rs|py)\b|--[a-z][a-z0-9-]*|\w+\(\)|src\/|store\.|useState|grid-template|schema|DATA_VERSION|localStorage/i;
    for (const line of allText()) expect(line, `「${line.slice(0, 40)}…」像工程项`).not.toMatch(engineering);
  });

  it("不提已经删掉或藏起来的功能，也不回顾历史", () => {
    const banned = /专注|番茄|收起了|去掉了「用法」|用法页|v1\.0 到|从「能记一句话」|随手记/;
    for (const line of allText()) expect(line, `「${line.slice(0, 40)}…」在提已删/已藏的东西`).not.toMatch(banned);
  });

  it("不写回被用户骂过的说法：自造的比喻、界面小调整的机制解释、跟使用者无关的事", () => {
    // 用户 2026-09-18：「某一步也能自己重复了？极差」「什么叫点开一个、另一个自己收起？」
    // 「1.14.3 跟使用者有什么关系？」「日历上的点，我都懒得喷」
    const bad = /某一步|点开一个|自己收起|手风琴|隔了几版|漏看|圆点|同一个绿|淡一些|一张纸上|摊开/;
    for (const line of allText()) expect(line, `「${line.slice(0, 40)}…」`).not.toMatch(bad);
  });
});
