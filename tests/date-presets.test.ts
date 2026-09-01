// 安排日期的快捷预设（今天 / 本周五 / 本周日 / 本月末）。
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
import { addDays, cmpYMD, dayOfWeek, duePresets, monthEnd, nextDow } from "../src/core/dates";

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

/** 预设的 label → ymd，断言时比对起来一眼能看懂 */
function map(today: string): Record<string, string> {
  return Object.fromEntries(duePresets(today).map((p) => [p.label, p.ymd]));
}

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

describe("duePresets：周中的普通一天，四个都在", () => {
  it("周二：今天 / 本周五 / 本周日 / 本月末", () => {
    expect(duePresets("2026-09-01")).toEqual([
      { key: "today", label: "今天", ymd: "2026-09-01" },
      { key: "fri", label: "本周五", ymd: "2026-09-04" },
      { key: "sun", label: "本周日", ymd: "2026-09-06" },
      { key: "monthEnd", label: "本月末", ymd: "2026-09-30" },
    ]);
  });
});

describe("duePresets：跟今天撞上的那个不显示", () => {
  it("当天就是周五 → 「本周五」整个不出现（它跟「今天」是同一天）", () => {
    const m = map("2026-09-04");
    expect(Object.keys(m)).toEqual(["今天", "本周日", "本月末"]);
    expect(m["本周日"]).toBe("2026-09-06");
  });

  it("当天是周日 → 「本周日」不出现，而周五已经过了，改口叫「下周五」", () => {
    const m = map("2026-09-06");
    expect(Object.keys(m)).toEqual(["今天", "下周五", "本月末"]);
    expect(m["下周五"]).toBe("2026-09-11");
  });

  it("当天正好是月末 → 「本月末」不出现（没有「下月末」这一说，它不会往后跑）", () => {
    const m = map("2026-09-30");
    expect(Object.keys(m)).toEqual(["今天", "本周五", "本周日"]);
  });
});

describe("duePresets：跨月与跨年", () => {
  it("月末那周：周五周日都落到下个月，名字仍然是「本周」——按周算它们确实还在这一周", () => {
    const m = map("2026-09-30");
    expect(m["本周五"]).toBe("2026-10-02");
    expect(m["本周日"]).toBe("2026-10-04");
  });

  it("跨年：12 月最后那个周一，周五周日都落到 2027 年，本月末还在 2026 年", () => {
    expect(dayOfWeek("2026-12-28")).toBe(1);
    const m = map("2026-12-28");
    expect(m["本周五"]).toBe("2027-01-01");
    expect(m["本周日"]).toBe("2027-01-03");
    expect(m["本月末"]).toBe("2026-12-31");
  });

  it("闰年二月的月末：2 月 15 号点开，落在 29 号", () => {
    expect(map("2028-02-15")["本月末"]).toBe("2028-02-29");
  });
});

describe("duePresets：怎么翻都不许算出一个过去的日子", () => {
  it("连着 400 天逐日验一遍：每个预设都 >= 当天，key 不重复", () => {
    let d = "2026-01-01";
    for (let i = 0; i < 400; i++) {
      const ps = duePresets(d);
      const keys = ps.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
      // 「今天」永远在，其余的必须严格晚于今天（等于今天的已经被筛掉了）
      expect(keys[0]).toBe("today");
      for (const p of ps.slice(1)) {
        expect(cmpYMD(p.ymd, d)).toBeGreaterThan(0);
      }
      d = addDays(d, 1);
    }
  });

  it("周起始按周一：周一到周五点开都叫「本周五」，周六周日才改叫「下周五」", () => {
    // 2026-08-31 是周一，往后铺一周
    const week = Array.from({ length: 7 }, (_, i) => addDays("2026-08-31", i));
    const labels = week.map((d) => duePresets(d).find((p) => p.key === "fri")?.label ?? "（没有）");
    expect(labels).toEqual([
      "本周五", // 周一
      "本周五", // 周二
      "本周五", // 周三
      "本周五", // 周四
      "（没有）", // 周五当天，跟「今天」撞上
      "下周五", // 周六
      "下周五", // 周日
    ]);
  });
});

// ---------------------------------------------------------------------------
// 弹层的两套语义合成一套（A6）。结构性约束，读源码钉住。
// ---------------------------------------------------------------------------

describe("安排日期弹层：一套规矩，不用猜这次要不要点确定", () => {
  it("「确定」按钮撤了", () => {
    expect(dateMenu).not.toContain("确定");
  });

  it("预设不再自己写一份，一律从 duePresets 现取——两处弹层同一个来源", () => {
    expect(dateMenu).toContain("presets.map");
    expect(subDateMenu).toContain("presets.map");
    expect(taskCardSource).toContain("const presets = duePresets(today)");
  });

  it("「明天」从两处弹层里去掉了（顺延那条路不受影响，见 postponeRows）", () => {
    expect(dateMenu).not.toContain("明天");
    expect(subDateMenu).not.toContain("明天");
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
// 「安排日期只有一套规矩」是 README 上白纸黑字的承诺，那就得是全仓五个入口都算数。
// 第五处（随手记那排「也可以点选：」里的 📅）v1.9.0 收口时才补上——在那之前它还
// 本地现算着「今天 / 明天 / 下周一」，跟另外四处对不上，「明天」这个已经决定去掉的
// 选项在那儿还留着。
// ---------------------------------------------------------------------------

describe("安排日期：五个入口同一套预设，一处都不许自己现算", () => {
  /** 把块注释和行注释都去掉——写给后人的提醒里出现「明天」不算数，看的是真代码 */
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const ENTRIES = [
    ["任务卡 · 日期弹层", taskCardSource],
    ["任务卡 · 子任务日期小签", taskCardSource],
    ["右键菜单 · 任务的与子任务的「安排日期▸」", ctxMenuSource],
    ["侧栏 · 拖到「计划」的「安排到哪天？」", sidebarSource],
    ["随手记 · 点选那排的 📅 日期", quickAddSource],
  ] as const;

  it("五处都从 core/dates.duePresets 现取", () => {
    for (const [name, src] of ENTRIES) {
      expect(src, name).toContain("duePresets(");
    }
  });

  it("随手记那排点选按钮不再本地现算，「明天 / 下周一」在这一处也没了", () => {
    // 注释里那句「别在这儿再写一份「明天 / 下周一」」是提醒后人的，不算；看的是真代码
    const duePick = stripComments(quickAddSource.slice(
      quickAddSource.indexOf('id="due"'),
      quickAddSource.indexOf('id="list"'),
    ));
    expect(duePick).toContain("duePresets(today).map");
    expect(duePick).not.toContain("下周一");
    expect(duePick).not.toContain("addDays(today, 1)");
    // 这一段里除了 duePresets，不许再出现别的算日子的函数
    expect(duePick).not.toContain("dayOfWeek(today)");
  });

  it("全仓再没有第六处：这五个之外没有别的地方现算安排日期的候选", () => {
    // 「顺延」不走这套（Ctrl+→ 推明天、逾期区「全部推到明天」），它们用的是 postpone*，
    // 名字里也带着「推」不带「安排」——这两处仍然允许出现「明天」
    for (const [name, src] of [
      ["右键菜单 · 推到明天", ctxMenuSource],
      ["今天页 · 全部推到明天", todaySource],
    ] as const) {
      expect(src, name).toContain("推到明天");
    }
    // 反过来：安排日期的那五个入口里一个「明天」都不许剩
    const dueMenus = [
      taskCardSource.slice(taskCardSource.indexOf('{menuPop.shown === "date" && ('), taskCardSource.indexOf("{/* 循环 */}")),
      subDateMenu,
      quickAddSource.slice(quickAddSource.indexOf('id="due"'), quickAddSource.indexOf('id="list"')),
    ];
    for (const seg of dueMenus) expect(stripComments(seg)).not.toContain("明天");
  });
});
