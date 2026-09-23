// 9-21 那批(9c66f1a0)复核后逐条修的问题,每条一组,钉住修法。
// 所有「现在」都是注入的固定时刻。

import { describe, expect, it } from "vitest";
import { parseQuickAdd, parseSubtaskInput } from "../src/core/parse";
import type { ParseResult } from "../src/core/parse";

const SEP21 = new Date(2026, 8, 21, 10, 0); // 2026-09-21 周一
const p = (input: string, now: Date = SEP21): ParseResult => parseQuickAdd(input, { now, listNames: ["工作", "生活"] });

describe("解析 · 「每月的15号」「每周的周五」不被光写的每月/每周抢走", () => {
  it("~每月的15号 = 每月15号,标题干净", () => {
    const r = p("~每月的15号 还款");
    expect(r.repeat).toEqual({ kind: "monthly", day: 15 });
    expect(r.title).toBe("还款");
  });
  it("~每个月的最后一天 / ~每个月的月底 = 月末", () => {
    for (const s of ["~每个月的最后一天 结账", "~每个月的月底 结账", "~每月的月末 结账"]) {
      const r = p(s);
      expect(r.repeat, s).toEqual({ kind: "monthly", day: 31 });
      expect(r.title, s).toBe("结账");
    }
  });
  it("~每周的周五 = 每周五", () => {
    const r = p("~每周的周五 例会");
    expect(r.repeat).toEqual({ kind: "weekly", days: [5] });
    expect(r.title).toBe("例会");
  });
  it("认不出来的「每月的…」「每周的…」整串留给标题,不被截成光写的循环", () => {
    for (const s of ["~每月的初一 盘点", "~每周的例会 准备"]) {
      const r = p(s);
      expect(r.repeat, s).toBeNull();
      expect(r.title, s).toBe(s);
    }
  });
});

describe("解析 · ~每月月底 在哪个月记都是月末", () => {
  it("9 月(30 天)和 10 月(31 天)记,都存 day 31", () => {
    expect(p("~每月月底 对账").repeat).toEqual({ kind: "monthly", day: 31 });
    expect(p("~每月月底 对账").title).toBe("对账");
    expect(p("~每月月底 对账", new Date(2026, 9, 5, 10, 0)).repeat).toEqual({ kind: "monthly", day: 31 });
    expect(p("~每个月月末 对账").repeat).toEqual({ kind: "monthly", day: 31 });
  });
});

describe("解析 · ~每N天 跟自定义面板同一个范围(1–365)", () => {
  it("~每120天 / ~每365天 认得出", () => {
    expect(p("~每120天 浇花").repeat).toEqual({ kind: "daily", every: 120 });
    expect(p("~每120天 浇花").title).toBe("浇花");
    expect(p("~每365天 体检").repeat).toEqual({ kind: "daily", every: 365 });
  });
  it("超过 365 不认,整串留给标题", () => {
    const r = p("~每400天 换滤芯");
    expect(r.repeat).toBeNull();
    expect(r.title).toBe("~每400天 换滤芯");
  });
});

describe("解析 · ~每周2次 / ~每周两次 不是每周(今天周几)", () => {
  it("整串留给标题,跟「~每个月两次」一个口径", () => {
    for (const s of ["~每周2次 健身", "~每周两次 健身", "~每个月两次 理发"]) {
      const r = p(s);
      expect(r.repeat, s).toBeNull();
      expect(r.title, s).toBe(s);
    }
  });
});

describe("子任务 · 没打 ~ 的「每个月」一个字不动", () => {
  it("每个月 ~15号 交房租:「每个月」留在标题里", () => {
    const r = parseSubtaskInput("每个月 ~15号 交房租", SEP21);
    expect(r.repeat).toBeNull();
    expect(r.due).toBe("2026-10-15");
    expect(r.title).toBe("每个月 交房租");
  });
  it("孤零零的「每」「每月」照旧扫掉", () => {
    expect(parseSubtaskInput("每 交周报 ~明天", SEP21).title).toBe("交周报");
    expect(parseSubtaskInput("每月 交水费 ~明天", SEP21).title).toBe("交水费");
  });
});

// ---------------------------------------------------------------------------
// 多选浮条「顺延 ▾」推看得见的那几行，不把母任务截止日往前拉
// ---------------------------------------------------------------------------
import { beforeEach } from "vitest";
import { appStore, flushSave, postponeRowsForTasks, postponeRowsTo, undo } from "../src/core/store";
import { defaultData, newTask } from "../src/core/model";
import type { Subtask, Task } from "../src/core/model";
import { addDays, todayYMD } from "../src/core/dates";
import appSource from "../src/App.tsx?raw";

const subOf = (id: string, patch: Partial<Subtask> = {}): Subtask =>
  ({ id, title: id, done: false, due: null, dueTime: null, priority: null, ...patch });
const getT = (id: string): Task => appStore.getState().data.tasks.find((t) => t.id === id)!;

describe("多选顺延：按看得见的行推", () => {
  beforeEach(async () => {
    while (appStore.getState().undoDepth > 0) undo();
    await flushSave();
    appStore.setState({ data: defaultData(), loaded: true });
  });

  it("母任务截止在后、子任务自己过期：推那条子任务，母任务截止日不动", () => {
    const today = todayYMD();
    const t = newTask({
      title: "交材料", due: addDays(today, 24),
      subtasks: [subOf("late", { due: addDays(today, -3) }), subOf("later", { due: addDays(today, 10) })],
    });
    const plain = newTask({ title: "没子任务", due: addDays(today, -1) });
    appStore.setState({ data: { ...defaultData(), tasks: [t, plain] } });
    const rows = postponeRowsForTasks([t, plain], today);
    expect(rows.map((r) => r.sub?.id ?? null)).toEqual(["late", null]);
    postponeRowsTo(rows, addDays(today, 1));
    const after = getT(t.id);
    expect(after.due).toBe(addDays(today, 24));
    expect(after.subtasks.find((s) => s.id === "late")!.due).toBe(addDays(today, 1));
    expect(after.subtasks.find((s) => s.id === "later")!.due).toBe(addDays(today, 10));
    expect(getT(plain.id).due).toBe(addDays(today, 1));
    expect(appStore.getState().ui.toast!.msg).toBe("已顺延 2 项");
  });

  it("子任务一条都没过期：推母任务本身", () => {
    const today = todayYMD();
    const t = newTask({ title: "a", due: addDays(today, -1), subtasks: [subOf("x", { due: addDays(today, 3) })] });
    expect(postponeRowsForTasks([t], today)).toEqual([{ task: t, sub: null }]);
  });

  it("母任务行：选的这天比原来早，不改；全都没改就不写库、只提示一句", () => {
    const today = todayYMD();
    const t = newTask({ title: "远", due: addDays(today, 20) });
    appStore.setState({ data: { ...defaultData(), tasks: [t] } });
    const depth = appStore.getState().undoDepth;
    postponeRowsTo([{ task: t, sub: null }], addDays(today, 1));
    expect(getT(t.id)).toBe(t);
    expect(appStore.getState().undoDepth).toBe(depth);
    expect(appStore.getState().ui.toast!.msg).not.toContain("已顺延");
  });

  it("浮条的 getRows 走 postponeRowsForTasks", () => {
    const bar = appSource.slice(appSource.indexOf("className={`bulk-bar"), appSource.indexOf("移到清单"));
    expect(bar).toContain("postponeRowsForTasks(");
    expect(bar).not.toContain(".map((t) => ({ task: t, sub: null }))");
  });
});

// ---------------------------------------------------------------------------
// 手机子任务点开不改就离开不写；文案几处
// ---------------------------------------------------------------------------
import taskSheetSource from "../src/mobile/TaskSheet.tsx?raw";
import accountPanelSource from "../src/components/AccountPanel.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import changelogData from "../src/core/changelog-data.json";

describe("手机子任务：点开没改就离开，一个字都不写", () => {
  it("commit 先拦「跟原标题一模一样」，再压成一行", () => {
    const fn = taskSheetSource.slice(taskSheetSource.indexOf("function commit()"), taskSheetSource.indexOf("updateSubtask(task.id, sub.id, { title: t })"));
    expect(fn).toContain("if (v === sub.title) return;");
    expect(fn.indexOf("if (v === sub.title) return;")).toBeLessThan(fn.indexOf("oneLine(v)"));
  });
});

describe("文案", () => {
  it("侧栏同步那行的鼠标提示叫「账号」，不叫「云账号」", () => {
    expect(sidebarSource).toContain('title="账号与同步状态"');
    expect(sidebarSource).not.toContain("云账号与同步状态");
  });
  it("账号卡说明：手机上说「「今天」页右上角」，桌面说「右上角」，都不写端名", () => {
    expect(accountPanelSource).toContain('{isMobile ? "「今天」页" : ""}右上角那颗头像点开也能退出登录');
  });
  // 桌面这段 09-23 已随 1.16.0 发布、beta 清空（细节并进 1.16.0 的「体验优化」），这两条只剩还攒着的两端要核
  it("网页 beta 段没有「修复更新弹窗贴边」（网页弹不出那个框）；安卓留着", () => {
    const beta = changelogData.beta as Partial<Record<"desktop" | "android" | "web", { highlights: { title: string }[] }>>;
    const titles = (p: "android" | "web") => (beta[p]?.highlights ?? []).map((h) => h.title);
    expect(titles("web")).not.toContain("修复更新弹窗贴边");
    expect(titles("android")).toContain("修复更新弹窗贴边");
  });
  it("桌面那份叫「今日任务页」，不叫「今天页」（1.16.0 正式条目 + 以后攒的 beta）", () => {
    const beta = changelogData.beta as Partial<Record<"desktop", { highlights: { body: string }[] }>>;
    const v116 = changelogData.desktop.find((e) => e.version === "1.16.0")!;
    const body = [...v116.highlights, ...(beta.desktop?.highlights ?? [])].map((h) => h.body).join("\n");
    expect(body).not.toContain("今天页");
  });
  it("v1.14.0「子任务支持循环」的例子照着打真能设上循环", () => {
    for (const p of ["desktop", "android"] as const) {
      const v = (changelogData[p] as { version: string; highlights: { title: string; body: string }[] }[]).find((e) => e.version === "1.14.0")!;
      const card = v.highlights.find((h) => h.title === "子任务支持循环")!;
      const examples = [...card.body.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
      expect(examples.length, p).toBe(2);
      for (const ex of examples) expect(parseSubtaskInput(ex, SEP21).repeat, ex).not.toBeNull();
    }
  });
});

import { existsSync, readFileSync } from "node:fs";

// 验收单工具在 _work/ 下，不进 git：没有这份文件（别处克隆的仓库）就跳过
const PENDING = "../_work/验收单工具/最新改动.json";
describe.skipIf(!existsSync(PENDING))("验收单（最新改动.json）", () => {
  const pend = existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, "utf8")) : {};
  const items = (p: string) => pend[p].items as { id: string; what: string; how: string[] }[];
  const text = (p: string, id: string) => {
    const it = items(p).find((x) => x.id === id)!;
    return [it.what, ...it.how].join("\n");
  };
  it("网页没有「更新弹窗」那一项", () => {
    expect(items("web").map((x) => x.id)).not.toContain("w-2609d-dialog");
  });
  it("桌面说明：攒着改动时写明对应哪个测试版、已经装了；刚发完正式版时写明发的是几号", () => {
    // 不钉死整句——每打一次新测试版这句话就会改一次，只钉这层意思
    if (items("desktop").length) {
      expect(pend.desktop.note).toMatch(/beta\.\d+/);
      expect(pend.desktop.note).toContain("已装到这台电脑");
    } else {
      expect(pend.desktop.note).toMatch(/\d+\.\d+\.\d+ 已于 \d{4}-\d{2}-\d{2} 正式发布/);
    }
  });
  it("网页那几项没有浏览器做不到的操作", () => {
    for (const w of ["托盘", "拖窗口", "快捷记浮窗", "关掉橡果"]) {
      for (const id of ["w-2609d-autopull", "w-2609d-sidew", "w-2609d-multiline"]) expect(text("web", id), `${id} ${w}`).not.toContain(w);
    }
  });
  it("桌面和电脑浏览器那几项叫「今日任务页」；收起的链头才代表整件事", () => {
    // 桌面那两项 09-23 随 1.16.0 发布、从「最新改动」挪走了，只剩网页那两项要核（桌面还攒着的话照核）
    const pairs = [["desktop", "d-2609d-postpone"], ["desktop", "d-2609d-ctx"], ["web", "w-2609d-postpone"], ["web", "w-2609d-ctx"]]
      .filter(([p, id]) => items(p).some((x) => x.id === id));
    expect(pairs.some(([p]) => p === "web")).toBe(true);
    for (const [p, id] of pairs) expect(text(p, id), id).not.toContain("今天页");
    if (items("desktop").some((x) => x.id === "d-2609d-ctx")) {
      expect(text("desktop", "d-2609d-ctx")).not.toContain("右键也是「整件事 · 名字」");
    }
    expect(text("web", "w-2609d-ctx")).not.toContain("右键也是「整件事 · 名字」");
  });
});
