// 2026-09 · 桌面导航重排。
//
// 用户原话：「计划移到最前面，今天这个版面去掉，日历挪到计划下面（第二个），习惯第三个，
// 已完成挪到更多里」，后来改口：「今天那个别删了，挪到习惯上面（第三个），名称改成今日任务」。
// 用户同时定了：先只改电脑，手机按规矩先出稿再改。
//
// 这一份钉五件事：
//   ① 默认四项是 计划 / 日历 / 今日任务 / 习惯，模块可以由用户重排
//   ② 所有模块直接显示，清单 / 需求方 / 标签保留整组
//   ③ Ctrl+2~5、命令面板按功能固定，拖排不改变键盘习惯
//   ④ 桌面打开先落在「计划」，手机仍是「今天」
//   ⑤ 手机底部导航一格没动（等出稿）
import { describe, expect, it } from "vitest";
import { startView } from "../src/core/store";
import { sidebarModules } from "../src/core/sidebar";
import appSource from "../src/App.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import paletteSource from "../src/components/CommandPalette.tsx?raw";
import todaySource from "../src/views/Today.tsx?raw";
import shellSource from "../src/mobile/MobileShell.tsx?raw";

/** 侧栏里一段 <ul> 的导航项：[ViewId, 名字]，按出现顺序 */
function items(block: string): [string, string][] {
  return [...block.matchAll(/item\("(\w+)", "([^"]+)"/g)].map((m) => [m[1], m[2]]);
}

// 默认次序延续原来的常用四项，用户可以整模块拖排；键盘快捷键按功能固定。
const mainBlock = sidebarSource.slice(sidebarSource.indexOf("  const moduleBodies ="));

describe("① 侧栏默认四项：计划 / 日历 / 今日任务 / 习惯", () => {
  it("默认顺序延续原有习惯，但可以自定义", () => {
    expect(sidebarModules().slice(0, 4).map((m) => [m.id, m.name])).toEqual([
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

describe("② 所有模块直接显示，清单和需求方保留分组", () => {
  it("已完成 / 统计 / 回收站不再藏在更多中", () => {
    expect(sidebarModules().slice(4, 7).map((m) => m.id)).toEqual(["done", "stats", "trash"]);
    expect(sidebarSource).not.toContain("side-fold");
    expect(sidebarSource).not.toContain("side-more");
  });

  it("清单 / 需求方 / 标签是三个整组，全部展开", () => {
    expect(sidebarModules().filter((m) => m.group).map((m) => m.id)).toEqual(["lists", "who", "tags"]);
    expect(sidebarSource).not.toContain("slice(0, PEEK)");
  });
});

describe("③ 快捷键与命令面板按功能固定，拖排不影响键盘习惯", () => {
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
