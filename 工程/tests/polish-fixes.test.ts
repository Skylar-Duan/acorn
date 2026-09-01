// v1.9.0 续跑复核「观感与收口」那一组，逐条钉住。
// 动画在 jsdom 里看不见，所以跟 motion.test.ts 一个路数：钉**结构**——
// 撤掉的东西确实撤干净了、该留的（hover / focus 那些老过渡）一条没误伤、
// 同一个动作在几个入口给的是同一套候选日。
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { hardCutRows } from "../src/core/motion";
import appSource from "../src/App.tsx?raw";
import planSource from "../src/views/Plan.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import ctxSource from "../src/components/ContextMenu.tsx?raw";

// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串，
// 那样这些断言会对着空字符串「全过」。跟 motion.test.ts 同一套做法
const baseCss = readFileSync("src/styles/base.css", "utf8");
const appCss = readFileSync("src/styles/app.css", "utf8");

/** 取一个选择器后面那一对花括号里的内容（只认第一处，够用了）。
 *  必须连着行首找：直接 indexOf(".task-row {") 会先撞上 ".row-slot > .task-row {" */
function block(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `找不到选择器 ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

/** 把 JSX 注释去掉再断言：注释里为了说清楚「别再写一份」难免出现「明天 / 下周一」这些字 */
function stripComments(src: string): string {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("B7 撤回：换主题回到瞬间齐切，不留半做的底色渐变", () => {
  it("body 上没有颜色过渡了", () => {
    expect(block(baseCss, "body")).not.toContain("transition:");
  });

  it("侧栏和任务卡这两块大面也没有了", () => {
    expect(block(appCss, ".side")).not.toContain("transition:");
    expect(block(appCss, ".task-card")).not.toContain("transition:");
  });

  it("全仓样式里再没有 background-color 跟着 --dur-2 渐的写法", () => {
    expect(baseCss).not.toContain("background-color var(--dur-2)");
    expect(appCss).not.toContain("background-color var(--dur-2)");
  });

  it("随手记那条只剩本来就该有的边框/描边过渡（focus-within 用的）", () => {
    const quickAdd = block(appCss, ".quick-add");
    expect(quickAdd).toContain("transition: border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease);");
    expect(quickAdd).not.toContain("background-color");
  });

  it("手机抽屉滑进滑出的那条 transform 过渡没被顺手删掉", () => {
    expect(appCss).toContain("transition: transform var(--dur-2) var(--ease);");
  });

  it("hover / focus 那些本来就该有的过渡一条都没误伤", () => {
    expect(block(baseCss, ".btn")).toContain("transition: background var(--dur-1)");
    expect(block(baseCss, ".input")).toContain("transition: border-color var(--dur-1)");
    expect(block(baseCss, ".cb")).toContain("transition: background var(--dur-1)");
    expect(block(appCss, ".task-row")).toContain("transition: background var(--dur-1)");
    expect(block(appCss, ".side nav li")).toContain("transition: background var(--dur-1)");
  });

  it("撤回的理由写在代码里，下次别又加回来", () => {
    expect(baseCss).toContain("B7 已撤回");
  });
});

describe("B5：一次性翻掉整列走硬切，单条小三角照旧有动画", () => {
  it("有一条一次性跳过行高过渡的规矩", () => {
    expect(appCss).toContain(":root.no-row-anim .row-slot { transition: none; }");
  });

  it("行本身的高度过渡还在（单条小三角、让位给任务卡、勾掉收行都靠它）", () => {
    const slot = block(appCss, ".row-slot");
    expect(slot).toContain("transition: grid-template-rows var(--dur-2) var(--ease)");
    expect(appCss).toContain(".row-slot.shut { grid-template-rows: 0fr; opacity: 0; }");
  });

  it("总开关这条路先硬切再翻状态，顺序不能反", () => {
    expect(planSource).toContain("hardCutRows(); setFoldAll(!foldAll);");
    expect(planSource.indexOf("hardCutRows()")).toBeLessThan(planSource.indexOf("setFoldAll(!foldAll)"));
  });

  it("单条小三角那条路一个字没动，不该跟着硬切", () => {
    expect(planSource).not.toContain("toggleChain");
  });

  it("挂上就生效，而且一定摘得掉——后台标签页里 rAF 根本不调度，得有计时器兜底", () => {
    vi.useFakeTimers();
    try {
      hardCutRows();
      expect(document.documentElement.classList.contains("no-row-anim")).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(document.documentElement.classList.contains("no-row-anim")).toBe(false);
    } finally {
      vi.useRealTimers();
      document.documentElement.classList.remove("no-row-anim");
    }
  });
});

describe("B3：切清单 / 切需求方 / 切标签也要重播正文淡入", () => {
  it("key 带上了具体目标，不再只有 view", () => {
    expect(appSource).toContain("const bodyKey = `${view}:${listId ?? whoFilter ?? tagFilter ?? \"\"}`;");
    expect(appSource).not.toContain("key={view}");
  });

  it("十三个视图全都挂上了这个 key，一个不落", () => {
    expect(appSource.split("key={bodyKey}").length - 1).toBe(13);
  });

  it("useMemo 的依赖跟着走，否则算出来的还是上一份 element", () => {
    expect(appSource).toContain("}, [view, bodyKey]);");
  });
});

describe("平滑滚动也得听「减少动态效果」", () => {
  it("命中就直接跳过去，不做平滑滚动", () => {
    const reveal = sidebarSource.slice(
      sidebarSource.indexOf("function revealCloudSection"),
      sidebarSource.indexOf("function Ico"),
    );
    expect(reveal).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(reveal).toContain('behavior: still ? "auto" : "smooth"');
    // 写死 smooth 的那一版没了
    expect(reveal).not.toContain('behavior: "smooth"');
  });
});

describe("「安排日期」只有一套规矩：五个入口同一份预设", () => {
  const ctx = stripComments(ctxSource);
  const sidebar = stripComments(sidebarSource);

  /** 右键菜单里两个「安排日期 ▸」子菜单（任务的、子任务的） */
  const subMenuDate = ctx.slice(ctx.indexOf('{subOpen === "date" && ('), ctx.indexOf('{subOpen === "priority" && ('));
  // 结尾要从起点往后找：子任务菜单里也有个「优先级」，它排在前面，从头找会切出一段空的
  const taskDateAt = ctx.indexOf('{sub === "date" && (');
  const taskMenuDate = ctx.slice(taskDateAt, ctx.indexOf("优先级", taskDateAt));
  /** 拖到侧栏「计划」弹出的「安排到哪天？」 */
  const planPop = sidebar.slice(sidebar.indexOf("side-plan-pop"), sidebar.indexOf("{/* 不常用的收进这里"));

  it("右键「安排日期 ▸」（任务）走 duePresets，不再自己算候选日", () => {
    expect(taskMenuDate).toContain("duePresets(today).map(");
    expect(taskMenuDate).not.toContain("明天");
    expect(taskMenuDate).not.toContain("下周一");
  });

  it("右键「安排日期 ▸」（子任务）也是同一套", () => {
    expect(subMenuDate).toContain("duePresets(today).map(");
    expect(subMenuDate).not.toContain("明天");
    // 「继承母任务」是子任务独有的一条，得留着
    expect(subMenuDate).toContain("继承母任务");
  });

  it("侧栏「安排到哪天？」也是同一套", () => {
    expect(planPop).toContain("duePresets(today).map(");
    expect(planPop).not.toContain("明天");
    expect(planPop).not.toContain("下周一");
  });

  it("各写一份的那些现算逻辑连根拔了（nextMonday / dayOfWeek 那段）", () => {
    expect(ctxSource).not.toContain("nextMonday");
    expect(ctxSource).not.toContain("dayOfWeek");
    expect(sidebarSource).not.toContain("dayOfWeek");
  });

  it("「推到明天」是顺延不是安排日期，一个字都不该动", () => {
    expect(ctxSource).toContain("推到明天");
    expect(ctxSource).toContain("postponeTasks(ids)");
  });
});
