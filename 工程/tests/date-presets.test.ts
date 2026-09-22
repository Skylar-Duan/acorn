// 安排日期的快捷预设。原来的「今天 / 本周五 / 本周日 / 本月末」（duePresets）09-21 已删，
// 统一成 core/options.dateOptions；下面剩的是 nextDow / monthEnd 两个小函数和各入口的源码守卫。
// 全是 core/dates.ts 里的纯函数，跟界面无关，所以这里一律传死日期算，不用 todayYMD()。
//
// 三条规矩全在这儿钉住：
//   ① 永远向后取最近的一个，绝不给出过去的日子
//   ② 名字跟着算出来的日子走（周六点开时「本周五」写成「下周五」）
//   ③ 跟「今天」撞上同一天的那个不出现
//
// 参照日历（自己核过，别改）：
//   2026-09-01 周二 · 09-04 周五 · 09-06 周日 · 09-30 周三 · 2026-12-28 周一
import { describe, expect, it } from "vitest";
import taskCardSource from "../src/components/TaskCard.tsx?raw";
import ctxMenuSource from "../src/components/ContextMenu.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import quickAddSource from "../src/components/QuickAddBar.tsx?raw";
import todaySource from "../src/views/Today.tsx?raw";
import postponeSource from "../src/components/PostponeMenu.tsx?raw";
import { dayOfWeek, monthEnd, nextDow } from "../src/core/dates";
// 注：09-21 起桌面和手机全部改走 core/options.dateOptions（单测在 tests/options.test.ts），
// duePresets 已删（手机那三张纸也切完了）

// 定位用的这几个记号跟着 v1.9.0 的 B6 改了名：弹层的显隐现在走 useLeaving 的 shown，
// 好让它关掉时多活一拍把退场演完。判断的语义一个字没变，这里只是换个抓手
/** 任务卡里那个日期弹层的源码片段（从 `menuPop.shown === "date"` 到下一块「循环」为止） */
const dateMenu = taskCardSource.slice(
  taskCardSource.indexOf('{menuPop.shown === "date" && ('),
  taskCardSource.indexOf("{/* 循环 */}"),
);

/** 子任务那个日期小签的弹层片段 */
const subDateMenu = taskCardSource.slice(
  taskCardSource.indexOf('subPop.shown.kind === "date" && ('),
  taskCardSource.indexOf('subPop.shown.kind === "prio" && ('),
);


describe("nextDow：往后最近的那个星期几（含当天）", () => {
  it("当天就是那个星期几 → 就是当天，不跳到下周", () => {
    expect(dayOfWeek("2026-09-04")).toBe(5);
    expect(nextDow("2026-09-04", 5)).toBe("2026-09-04");
  });

  it("过了就顺延到下一个", () => {
    // 周六找周五：整整再等六天
    expect(nextDow("2026-09-05", 5)).toBe("2026-09-11");
    // 周日找周五：等五天
    expect(nextDow("2026-09-06", 5)).toBe("2026-09-11");
  });

  it("周日按 0 算，周一找周日会走到本周末那天", () => {
    expect(dayOfWeek("2026-08-31")).toBe(1);
    expect(nextDow("2026-08-31", 0)).toBe("2026-09-06");
  });
});

describe("monthEnd：当月最后一天", () => {
  it("大月小月各一个", () => {
    expect(monthEnd("2026-09-01")).toBe("2026-09-30");
    expect(monthEnd("2026-12-01")).toBe("2026-12-31");
  });

  it("闰年二月是 29 号，平年是 28 号", () => {
    expect(monthEnd("2028-02-15")).toBe("2028-02-29");
    expect(monthEnd("2026-02-15")).toBe("2026-02-28");
  });

  it("当天就是月末 → 还是当天", () => {
    expect(monthEnd("2026-09-30")).toBe("2026-09-30");
  });
});

// 原来这儿是 duePresets（今天 / 本周五 / 本周日 / 本月末）自己的几组单测。
// 09-21 起全应用（桌面 + 手机）选日子统一走 core/options.dateOptions，手机那三张纸也切完了，
// duePresets 连同这几组单测一起删掉；新口径的单测在 tests/options.test.ts。
describe("duePresets 已经删掉：老的「本周五 / 本周日」写法全仓一处不剩", () => {
  it("core/dates 不再导出它", async () => {
    const mod: Record<string, unknown> = await import("../src/core/dates");
    expect(mod.duePresets).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 弹层的两套语义合成一套（A6）。结构性约束，读源码钉住。
// ---------------------------------------------------------------------------

describe("安排日期弹层：一套规矩，不用猜这次要不要点确定", () => {
  it("「确定」按钮撤了", () => {
    expect(dateMenu).not.toContain("确定");
  });

  // 09-21 改口：全应用选日子统一成 core/options.dateOptions（今天 / 明天 / 本周末 / 下周末 / 本月末 / 选日期…），
  // 原来「安排日期去掉明天」那条决定被用户这次有意推翻——「明天」回来了，但只从 dateOptions 来，不许写死
  it("预设不再自己写一份，一律从 dateOptions 现取——两处弹层同一个来源", () => {
    expect(dateMenu).toContain("presets.map");
    expect(subDateMenu).toContain("presets.map");
    expect(taskCardSource).toContain("const presets = dateOptions(today, { weekendDay: settings.weekendDay })");
    expect(taskCardSource).not.toContain("duePresets(");
  });

  it("两处弹层里一个日子的名字都不写死（「明天 / 本周末」全从 dateOptions 来）", () => {
    for (const seg of [dateMenu, subDateMenu]) {
      const code = seg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const label of ["明天", "本周末", "下周末", "本周五", "本周日", "本月末"]) expect(code).not.toContain(label);
    }
  });

  it("点预设 = 设好并关弹层", () => {
    expect(dateMenu).toContain("onClick={() => setDue(p.ymd)}");
    expect(taskCardSource).toContain("function setDue");
    const setDue = taskCardSource.slice(taskCardSource.indexOf("function setDue"));
    expect(setDue.slice(0, 300)).toContain("setMenu(null)");
  });

  it("点日历格 = 生效（走「一次编辑落一次」那道去抖），但弹层留着（好接着设时间）", () => {
    // 落库不在 onChange 里当场做了：月/日段的中间值年份也合法，闸门拦不住，
    // 逐个落库就是 postponeCount 虚增（见 commit-guards 那一组）。草稿 / 闸门 / 去抖
    // 三件套统一封在 components/DateField.tsx 里，鼠标点日历格只发一次 change，停手就落，手感照旧
    expect(dateMenu).toContain("<DateField");
    expect(taskCardSource).toContain('if (ymd !== (task.due ?? "")) commitDraft(ymd, draftTime);');
    // 这一段里绝不能有关弹层的动作。**连 onDone 都不给**：点日历格生效，弹层留着好接着设时间
    const dateField = dateMenu.slice(dateMenu.indexOf("<DateField"), dateMenu.indexOf('type="time"'));
    expect(dateField).not.toContain("setMenu(null)");
    expect(dateField).not.toContain("onDone");
  });

  it("时间失焦即生效，没变就不写（免得点预设时白压一层撤销栈）", () => {
    expect(dateMenu).toContain("onBlur={() => {");
    // 日期取 task.due：日期框先失焦、先把欠着的那天落了库，这会儿它已经是最新的
    expect(dateMenu).toContain('if ((draftTime || null) !== (task.dueTime ?? null)) commitDraft(task.due ?? "", draftTime);');
  });

  it("「只有时间没日期 → 落到今天」这条老规矩没丢", () => {
    const commit = taskCardSource.slice(taskCardSource.indexOf("function commitDraft"));
    expect(commit.slice(0, 300)).toContain("due || (time ? today : null)");
  });

  it("翻月仍然只是导航：原生日期控件翻月不触发 change，弹层里也没有别的翻月钩子", () => {
    expect(dateMenu).not.toContain("onMonthChange");
    expect(dateMenu).not.toContain("setAnchor");
  });
});

// ---------------------------------------------------------------------------
// v1.15.0：点卡片里的别处，浮层就该消失（用户原话「点别处要自动消失，而不是必须再点一下日期」）。
// 这条路只写在组件顶上那条 document mousedown 监听里，跟上面那套「点预设关窗 / 点日历格留窗」
// 半点不沾——那套规矩是 v1.9.0 定的，一个字不改。
// ---------------------------------------------------------------------------

/** 组件顶上那条 document mousedown 监听的源码片段（从 `function onDoc` 到下一个 `function onKey`） */
const onDoc = taskCardSource.slice(
  taskCardSource.indexOf("function onDoc"),
  taskCardSource.indexOf("function onKey"),
);
/** 「只收浮层不收卡片」那个收尾函数的片段 */
const closeMenus = taskCardSource.slice(
  taskCardSource.indexOf("function closeMenus"),
  taskCardSource.indexOf("closeMenusRef.current = closeMenus"),
);

describe("点卡片里的别处：浮层自己消失，卡片留着", () => {
  it("点到卡外还是老样子：先落库再收整张卡", () => {
    expect(onDoc).toContain("flushRef.current();");
    expect(onDoc).toContain("expandTask(null);");
  });

  it("点在卡里、不在浮层也不在小签上 → 只收浮层", () => {
    expect(onDoc).toContain("closeMenusRef.current();");
  });

  it("两处放过一个不能少：浮层自己，和任何小签", () => {
    // .popmenu：里面就是给人点的（预设 / 日历格 / 时间框 / 需求方与标签的输入框）
    // .pill：mousedown 比按钮自己的 click 早一步，不放过的话「点 📅 把它收起来」
    //        会变成这儿先关掉、紧接着 click 又开回来，那颗键就永远按不动
    expect(onDoc).toContain('.closest(".popmenu")');
    expect(onDoc).toContain('.closest(".pill")');
  });

  it("closeMenus 只动浮层，绝不顺手把卡片也收了", () => {
    expect(closeMenus).not.toContain("expandTask");
  });

  it("卡里那几个浮层一起收（主任务那六个走 menu，子任务那两个走 subMenu）", () => {
    expect(closeMenus).toContain("setMenu(null)");
    expect(closeMenus).toContain("setSubMenu(null)");
  });

  it("带输入框的需求方 / 标签，收之前先把框里的字落库——跟点卡外同一条路", () => {
    expect(closeMenus).toContain('if (menu === "who") commitWho();');
    expect(closeMenus).toContain('if (menu === "tags") commitTags();');
  });

  it("这条新路没有落进日期弹层那几段：任务卡的日期框照旧连 onDone 都不给", () => {
    // v1.9.0 的老规矩：点日历格生效、弹层留着好接着设时间。加「点别处收浮层」不许动它
    const dateField = dateMenu.slice(dateMenu.indexOf("<DateField"), dateMenu.indexOf('type="time"'));
    expect(dateField).not.toContain("onDone");
    expect(dateField).not.toContain("setMenu(null)");
    expect(dateField).not.toContain("closeMenus");
    // 落库回调里也不许出现关浮层的动作
    const commit = taskCardSource.slice(taskCardSource.indexOf("function commitDraft"));
    expect(commit.slice(0, 400)).not.toContain("setMenu");
  });
});

// ---------------------------------------------------------------------------
// 「安排日期只有一套规矩」是 README 上白纸黑字的承诺，那就得是全仓每个入口都算数。
// 09-21 起口径换成 core/options.dateOptions（今天 / 明天 / 本周末 / 下周末 / 本月末 / 选日期…），
// 顺延菜单也并进来了（PostponeMenu，带 after 下限，见 postpone-presets.test.ts）。
// 桌面这几处全部切过去；手机那几张纸 09-21 也切完了（见 mobile-sheets / mobile-shell 测试）。
// ---------------------------------------------------------------------------

describe("安排日期：桌面每个入口同一套选项，一处都不许自己现算", () => {
  /** 把块注释和行注释都去掉——写给后人的提醒里出现的字不算数，看的是真代码 */
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const ENTRIES = [
    ["任务卡 · 日期弹层 / 子任务日期小签", taskCardSource],
    ["右键菜单 · 任务的与子任务的「调整日期▸」", ctxMenuSource],
    ["侧栏 · 拖到「计划」的「安排到哪天？」", sidebarSource],
    ["随手记 · 点选那排的 📅 日期", quickAddSource],
    ["顺延 ▾（逾期组 / 多选浮条 / 过期行尾）", postponeSource],
  ] as const;

  it("五处都从 core/options.dateOptions 现取，老的 duePresets / adjustDatePresets / postponePresets 一个不剩", () => {
    for (const [name, src] of ENTRIES) {
      const code = stripComments(src);
      expect(code.includes("dateOptions("), name).toBe(true);
      for (const old of ["duePresets(", "adjustDatePresets(", "postponePresets("]) expect(code, `${name} ${old}`).not.toContain(old);
    }
  });

  it("桌面这几处都按设置里的周末日算「本周末 / 下周末」", () => {
    for (const [name, src] of ENTRIES) expect(stripComments(src), name).toMatch(/dateOptions\(today, \{ weekendDay/);
  });

  it("随手记那排点选按钮不本地现算：「下周一」这类写死的没有，也没有别的算日子的函数", () => {
    const duePick = stripComments(quickAddSource.slice(
      quickAddSource.indexOf('id="due"'),
      quickAddSource.indexOf('id="list"'),
    ));
    expect(duePick).toContain("dateOptions(today, { weekendDay: settings.weekendDay }).map");
    expect(duePick).not.toContain("下周一");
    expect(duePick).not.toContain("明天");
    expect(duePick).not.toContain("addDays(today, 1)");
    expect(duePick).not.toContain("dayOfWeek(today)");
  });

  it("右键里单独那一项「推到明天」照旧没有；今天页是「全部顺延 ▾」", () => {
    expect(stripComments(ctxMenuSource)).not.toContain("推到明天");
    expect(todaySource).toContain('label="全部顺延"');
  });

  it("没有日期框常驻的两处（顺延、右键）末尾挂「选日期…」（DatePickRow）", () => {
    expect(stripComments(postponeSource)).toContain("<DatePickRow");
    expect(stripComments(ctxMenuSource).match(/<DatePickRow /g) ?? []).toHaveLength(2);
  });
});
