// 「选日子 / 选循环」的选项清单：全应用**唯一一份**（用户 09-21 定的口径）。
// 用户原话：「各个地方的循环可选项要对齐一致，包括延期选项也要对齐，现在不同的地方点进去可以选择的方案不一样」。
//
// 这里只给「有哪几项、按什么顺序、叫什么」，不管长相。桌面、手机、习惯都从这儿取，
// 谁也别在自己的界面里再写一份「明天 / 本周五 / 每周一」。
//
//   · 日期：今天 / 明天 / 本周末 / 下周末 / 本月末（后面的「选日期…」由界面自己画）
//   · 循环：每天 / 每个工作日 / 每周X / 每月X号 / 每隔几天… / 自定义… / 不重复
//
// 纯函数，不读系统时钟、不读设置：今天、周末日、这件事的日期一律由调用方传进来。
import type { RepeatRule } from "./model";
import { addDays, cmpYMD, dayOfWeek, monthEnd, weekendOf } from "./dates";
import { describeRepeat } from "./recur";

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

export type DateOptionKey = "today" | "tomorrow" | "weekend" | "nextWeekend" | "monthEnd";

/** 选日子的一项 */
export interface DateOption {
  /** 稳定标识，界面拿它做 key，不随名字变 */
  key: DateOptionKey;
  label: string;
  ymd: string;
}

/** 列表末尾那一项的名字：点开是一个日期框（界面自己画） */
export const PICK_DATE_LABEL = "选日期…";

export interface DateOptionsOpts {
  /** 设置里的周末日（settings.weekendDay），不给按周日 */
  weekendDay?: "sat" | "sun";
  /** 顺延类入口传「这件事现有的日期」：**不晚于它**的选项一律不出（顺延不该把日子往前拉，
   *  也不该原地不动）。没日期 / 不是顺延就不传 */
  after?: string | null;
}

/** 所有选日子的地方共用的快捷项：今天 / 明天 / 本周末 / 下周末 / 本月末。
 *
 *  规矩：
 *  ① 顺序固定就是上面这个；
 *  ② **跟前面某项撞上同一天的不出现**（周六点开、周末日是周日：本周末 = 明天，只留「明天」；
 *     月末那天：本月末 = 今天，不出）——两个按钮干同一件事，只会让人多犹豫一下；
 *  ③ 本周末落在今天或以前（今天就是周末日 / 周末日已经过了）就不出「本周末」，只留「下周末」；
 *  ④ 给了 after（顺延）：再把不晚于 after 的藏掉。去重在前、藏在后——
 *     「今天」被藏了，跟它同一天的「本周末」也不会顶上来。
 *  本周末 / 下周末跟记事语法「~周末 / ~下周末」同一套算法（dates.weekendOf）。 */
export function dateOptions(today: string, opts: DateOptionsOpts = {}): DateOption[] {
  const weekend = weekendOf(today, opts.weekendDay, 0);
  const all: DateOption[] = [
    { key: "today", label: "今天", ymd: today },
    { key: "tomorrow", label: "明天", ymd: addDays(today, 1) },
    { key: "weekend", label: "本周末", ymd: weekend },
    { key: "nextWeekend", label: "下周末", ymd: weekendOf(today, opts.weekendDay, 1) },
    { key: "monthEnd", label: "本月末", ymd: monthEnd(today) },
  ];
  const out: DateOption[] = [];
  for (const o of all) {
    if (o.key === "weekend" && cmpYMD(o.ymd, today) <= 0) continue;
    if (out.some((q) => q.ymd === o.ymd)) continue;
    out.push(o);
  }
  const after = opts.after;
  return after ? out.filter((o) => cmpYMD(o.ymd, after) > 0) : out;
}

// ---------------------------------------------------------------------------
// 循环
// ---------------------------------------------------------------------------

/** 两条规则是不是同一个（判「现在选的是哪个」「现在的值在不在常用项里」）。
 *  每周那几天先排序再比，[5,1] 跟 [1,5] 是一回事 */
export function sameRepeat(a: RepeatRule | null, b: RepeatRule | null): boolean {
  // 七天全勾的每周 = 每天：菜单里给「每天」打勾，跟那句「每天」对得上
  const norm = (r: RepeatRule | null): RepeatRule | null => {
    if (!r || r.kind !== "weekly") return r;
    const days = [...new Set(r.days)].sort((x, y) => x - y);
    return days.length >= 7 ? { kind: "daily", every: 1 } : { ...r, days };
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** 循环的四个常用项：每天 / 每个工作日 / 每周X / 每月X号。
 *  X 按 anchor 取形：调用方传「这件事的日期，没有就今天」。31 号那条显示成「每月最后一天」（describeRepeat） */
export function repeatCommon(anchor: string): RepeatRule[] {
  return [
    { kind: "daily", every: 1 },
    { kind: "workday" },
    { kind: "weekly", days: [dayOfWeek(anchor)] },
    { kind: "monthly", day: Number(anchor.slice(8, 10)) },
  ];
}

export const REPEAT_EVERY_LABEL = "每隔几天…";
export const REPEAT_CUSTOM_LABEL = "自定义…";
export const REPEAT_CLEAR_LABEL = "不重复";

/** 循环菜单的一项。界面按 kind 决定点了干什么：
 *   · current：现在的规则不在常用项里，挂在最上面、打勾；点它进自定义面板接着改
 *   · rule：常用项，点了直接写入；on = 现在就是它
 *   · every：「每隔几天…」，点了让人填天数（1–365），回车写入 { daily, every: n }
 *   · custom：「自定义…」，点了打开天 / 周 / 月面板（RepeatPicker）
 *   · clear：「不重复」，只在已经有循环时才出 */
export type RepeatMenuItem =
  | { kind: "current"; rule: RepeatRule; label: string }
  | { kind: "rule"; rule: RepeatRule; label: string; on: boolean }
  | { kind: "every"; label: string }
  | { kind: "custom"; label: string }
  | { kind: "clear"; label: string };

/** 所有选循环的地方共用的菜单：
 *  [现值（不在常用项里时）] 每天 / 每个工作日 / 每周X / 每月X号 / 每隔几天… / 自定义… / [不重复（有循环时）] */
export function repeatMenu(anchor: string, current: RepeatRule | null): RepeatMenuItem[] {
  const common = repeatCommon(anchor);
  const items: RepeatMenuItem[] = [];
  if (current && !common.some((r) => sameRepeat(r, current))) {
    items.push({ kind: "current", rule: current, label: describeRepeat(current) });
  }
  for (const r of common) items.push({ kind: "rule", rule: r, label: describeRepeat(r), on: sameRepeat(r, current) });
  items.push({ kind: "every", label: REPEAT_EVERY_LABEL });
  items.push({ kind: "custom", label: REPEAT_CUSTOM_LABEL });
  if (current) items.push({ kind: "clear", label: REPEAT_CLEAR_LABEL });
  return items;
}

/** 「每隔几天…」填进来的字 → 规则。只收 1–365 的整数，别的一律当没填（返回 null）。
 *  填 1 就是「每天」 */
export function everyNDays(input: string | number): RepeatRule | null {
  const n = typeof input === "number" ? input : Number(String(input).trim());
  if (!Number.isInteger(n) || n < 1 || n > 365) return null;
  return { kind: "daily", every: n };
}
