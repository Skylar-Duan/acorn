// 2026-09 · 桌面导航重排。
//
// 用户原话：「计划移到最前面，今天这个版面去掉，日历挪到计划下面（第二个），习惯第三个，
// 已完成挪到更多里」，后来改口：「今天那个别删了，挪到习惯上面（第三个），名称改成今日任务」。
// 用户同时定了：先只改电脑，手机按规矩先出稿再改。
//
// 这一份钉五件事：
//   ① 侧栏常驻四项的顺序是 计划 / 日历 / 今日任务 / 习惯
//   ② 「更多」里已完成排第一个，日历不在里面了
//   ③ Ctrl+2~5、命令面板跟着新顺序，导航上不再叫「今天」
//   ④ 桌面打开先落在「计划」，手机仍是「今天」
//   ⑤ 手机底部导航一格没动（等出稿）
import { describe, expect, it } from "vitest";
import { startView } from "../src/core/store";
import appSource from "../src/App.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import paletteSource from "../src/components/CommandPalette.tsx?raw";
import todaySource from "../src/views/Today.tsx?raw";
import shellSource from "../src/mobile/MobileShell.tsx?raw";

/** 侧栏里一段 <ul> 的导航项：[ViewId, 名字]，按出现顺序 */
function items(block: string): [string, string][] {
  return [...block.matchAll(/item\("(\w+)", "([^"]+)"/g)].map((m) => [m[1], m[2]]);
}

// 常驻组：<nav> 之后的第一个 <ul>；「更多」组：side-fold 里的那个 <ul>
const navAt = sidebarSource.indexOf("<nav>");
const mainBlock = sidebarSource.slice(navAt, sidebarSource.indexOf("</ul>", navAt));
const foldAt = sidebarSource.indexOf('className={`side-fold');
const moreBlock = sidebarSource.slice(foldAt, sidebarSource.indexOf("</ul>", foldAt));

describe("① 侧栏常驻四项：计划 / 日历 / 今日任务 / 习惯", () => {
  it("顺序一格不错", () => {
    expect(items(mainBlock)).toEqual([
      ["plan", "计划"],
      ["calendar", "日历"],
      ["today", "今日任务"],
      ["habits", "习惯"],
    ]);
  });

  it("搬家没丢东西：计划拖上来弹日期、今日任务拖上来改今天做、两个都还挂角标", () => {
    expect(mainBlock).toMatch(/item\("plan", "计划", "plan", counts\.plan, false, \(ids, e\) =>\s*setPendingPlan\(/);
    expect(mainBlock).toContain('item("today", "今日任务", "today", counts.today, true, (ids, e) => dropDue(e, ids, today))');
    expect(mainBlock).toContain('item("habits", "习惯", "habits", counts.habits, true)');
  });

  it("导航上不再叫「今天」", () => {
    expect(sidebarSource).not.toMatch(/item\("\w+", "今天"/);
  });
});

describe("② 「更多」：已完成排第一个，日历提出去了", () => {
  it("顺序是 已完成 / 专注 / 统计 / 回收站", () => {
    expect(items(moreBlock).map((x) => x[0])).toEqual(["done", "focus", "stats", "trash"]);
    expect(moreBlock).not.toContain('item("calendar"');
  });

  it("正看着已完成时「更多」自动展开（不然界面上没地方显示你在哪）", () => {
    expect(sidebarSource).toContain('const MORE_VIEWS: ViewId[] = ["done", "focus", "stats", "trash"];');
  });
});

describe("③ 快捷键与命令面板跟新顺序", () => {
  it("Ctrl+2~5 = 计划 / 日历 / 今日任务 / 习惯", () => {
    expect(appSource).toContain('navigate((["plan", "calendar", "today", "habits"] as const)[Number(e.key) - 2]);');
  });

  it("命令面板：前四个跟侧栏一样，导航项名叫「今日任务」", () => {
    const nav = paletteSource.slice(paletteSource.indexOf("const NAV"), paletteSource.indexOf("];", paletteSource.indexOf("const NAV")));
    const rows = [...nav.matchAll(/\["(\w+)", "[^"]*", "([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(rows.slice(0, 5)).toEqual([
      ["plan", "计划"],
      ["calendar", "日历"],
      ["today", "今日任务"],
      ["habits", "习惯"],
      ["done", "已完成"],
    ]);
    expect(rows.map((r) => r[1])).not.toContain("今天");
  });

  it("今日任务页的桌面大标题跟着改名，手机页头不动", () => {
    expect(todaySource).toContain("<h1>今日任务</h1>");
    expect(todaySource).not.toContain("<h1>今天</h1>");
    expect(todaySource).toContain('title="今天"');
  });
});

describe("④ 打开先落在哪一页：两端分开", () => {
  it("桌面是计划，手机仍是今天", () => {
    expect(startView(false)).toBe("plan");
    expect(startView(true)).toBe("today");
  });
});

describe("⑤ 手机这次不跟（约定七：先出稿）", () => {
  it("底部导航仍是 今天 / 习惯 / 计划 / 四象限", () => {
    const tabs = shellSource.slice(shellSource.indexOf("const TABS = ["), shellSource.indexOf("] as const;"));
    expect([...tabs.matchAll(/id: "(\w+)"/g)].map((m) => m[1])).toEqual(["today", "habits", "plan", "quadrant"]);
    expect(tabs).toContain('label: "今天"');
  });
});
