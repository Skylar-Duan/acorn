// 习惯：一级分类，天生重复，靠打卡记录。
//
// 跟普通任务的根本区别：普通事「做完就没了」，习惯「今天做没做」——所以习惯不用
// done/doneAt，用 checkIns（打过卡的日期数组）。这样连续天数、本周几次、补打昨天的卡
// 全都是对同一个数组做运算，没有藏在别处的状态，两台设备合并时也只是并集。
//
// 「今天该不该做」由 repeat 算出来，不占用 due 字段——习惯不会「逾期」，
// 昨天没打就是没打，不该跟着滚到今天变成一笔债。

import type { RepeatRule, Task } from "./model";
import { addDays, cmpYMD, dayOfWeek, daysInMonth, diffDays, isWorkday, pad2, todayYMD, toYMD, weekStart } from "./dates";
import { repeatMenu, type RepeatMenuItem } from "./options";
import { describeRepeat } from "./recur";

/** 习惯没设周期时按「每天」算——新建习惯默认就是每天，这里只是兜底 */
export const DEFAULT_HABIT_REPEAT: RepeatRule = { kind: "daily", every: 1 };

/** 习惯的周期选项（09-21 统一口径）：跟任务的循环菜单是同一份（core/options.repeatMenu），
 *  只差两处——
 *   · 习惯没有日期，「每周X / 每月X号」按今天算（today 由调用方传）；
 *   · 习惯天生就重复，没有「不重复」这一项。
 *  现有周期不在常用项里（每周一三五、每 2 天、每月 8 号……）照样挂在最上面、打勾，不会被悄悄改掉 */
export function habitRepeatMenu(today: string, current: RepeatRule | null): RepeatMenuItem[] {
  return repeatMenu(today, current ?? DEFAULT_HABIT_REPEAT).filter((it) => it.kind !== "clear");
}

export function isHabit(t: Task): boolean {
  return t.kind === "habit";
}

export function habitRule(h: Task): RepeatRule {
  return h.repeat ?? DEFAULT_HABIT_REPEAT;
}

/** 「每 N 天」要有个起算日，用习惯的创建日。createdAt 坏了就退到今天 */
export function habitAnchor(h: Task, now = new Date()): string {
  const d = new Date(h.createdAt);
  return Number.isNaN(d.getTime()) ? todayYMD(now) : toYMD(d);
}

/** 这一天该不该做这个习惯 */
export function isDueOn(h: Task, ymd: string, now = new Date()): boolean {
  const rule = habitRule(h);
  switch (rule.kind) {
    case "daily": {
      const every = Math.max(1, rule.every);
      if (every === 1) return true;
      const anchor = habitAnchor(h, now);
      if (cmpYMD(ymd, anchor) < 0) return false;
      return diffDays(anchor, ymd) % every === 0;
    }
    case "weekly":
      return rule.days.includes(dayOfWeek(ymd));
    case "monthly": {
      const y = Number(ymd.slice(0, 4));
      const m = Number(ymd.slice(5, 7));
      // 每月 31 号在 2 月落到月末，跟循环任务同一口径
      const target = Math.min(Math.max(1, rule.day), daysInMonth(y, m));
      return Number(ymd.slice(8, 10)) === target;
    }
    case "workday":
      return isWorkday(ymd);
  }
}

export function doneOn(h: Task, ymd: string): boolean {
  return h.checkIns.includes(ymd);
}

/** 往前找上一个「该做」的日子。找不到（超出 limit）返回 null */
export function prevDueDay(h: Task, from: string, limit = 400, now = new Date()): string | null {
  let d = from;
  for (let i = 0; i < limit; i++) {
    d = addDays(d, -1);
    if (isDueOn(h, d, now)) return d;
  }
  return null;
}

/** 往后找下一个「该做」的日子（含 from 当天） */
export function nextDueDay(h: Task, from: string, limit = 400, now = new Date()): string | null {
  let d = from;
  for (let i = 0; i < limit; i++) {
    if (isDueOn(h, d, now)) return d;
    d = addDays(d, 1);
  }
  return null;
}

/**
 * 连续多少次。数的是「该做的日子」，不是自然日——每周一的习惯连着三周就是 3。
 *
 * 关键取舍：**今天该做但还没打卡时，从上一个该做的日子往前数**。
 * 不这么做的话，每天早上一睁眼连续天数就归零了，那个数字会变得毫无意义。
 */
export function streak(h: Task, today = todayYMD(), now = new Date()): number {
  let d: string | null = today;
  if (isDueOn(h, today, now) && !doneOn(h, today)) d = prevDueDay(h, today, 400, now);
  let n = 0;
  while (d !== null && doneOn(h, d)) {
    n += 1;
    d = prevDueDay(h, d, 400, now);
  }
  return n;
}

/** 历史最长连续。用于「你最好的一次是 21 天」这种鼓励 */
export function bestStreak(h: Task, now = new Date()): number {
  if (h.checkIns.length === 0) return 0;
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of h.checkIns) {
    // 上一次打卡和这次之间，中间还有没有「该做却没做」的日子
    const broken = prev !== null && prevDueDay(h, day, 400, now) !== prev;
    run = broken || prev === null ? 1 : run + 1;
    if (run > best) best = run;
    prev = day;
  }
  return best;
}

export type DayMark = "done" | "missed" | "todo" | "off" | "future";

/** 一周七格：周一到周日各是什么状态。习惯视图和卡片上的小圆点用它 */
export function weekMarks(
  h: Task,
  today = todayYMD(),
  now = new Date(),
): { ymd: string; mark: DayMark }[] {
  const start = weekStart(today);
  const out: { ymd: string; mark: DayMark }[] = [];
  for (let i = 0; i < 7; i++) {
    const ymd = addDays(start, i);
    const due = isDueOn(h, ymd, now);
    let mark: DayMark;
    if (doneOn(h, ymd)) mark = "done";
    else if (!due) mark = "off";
    else if (cmpYMD(ymd, today) > 0) mark = "future";
    else if (ymd === today) mark = "todo";
    else mark = "missed";
    out.push({ ymd, mark });
  }
  return out;
}

/** 最近 N 个「该做的日子」里做到了几次。0 个该做的日子时返回 null（没法算比例） */
export function recentRate(
  h: Task,
  days = 30,
  today = todayYMD(),
  now = new Date(),
): { done: number; due: number } | null {
  let due = 0;
  let done = 0;
  for (let i = 0; i < days; i++) {
    const ymd = addDays(today, -i);
    if (!isDueOn(h, ymd, now)) continue;
    // 今天还没到晚上，不该算成「没做到」——今天只在做了的时候计入
    if (ymd === today && !doneOn(h, ymd)) continue;
    due += 1;
    if (doneOn(h, ymd)) done += 1;
  }
  return due === 0 ? null : { done, due };
}

/** 打卡 / 取消打卡（同一天再点一次就是撤销）。返回新的 checkIns */
export function toggleCheck(checkIns: string[], ymd: string): string[] {
  return checkIns.includes(ymd)
    ? checkIns.filter((d) => d !== ymd)
    : [...checkIns, ymd].sort();
}

/** 今天要打的卡：该做且还没打的排前面，做完的沉底 */
export function sortHabitsForDay(habits: Task[], today = todayYMD(), now = new Date()): Task[] {
  const rank = (h: Task) => {
    if (!isDueOn(h, today, now)) return 2; // 今天不用做
    return doneOn(h, today) ? 1 : 0; // 已打卡沉到中间，未打卡最上
  };
  return [...habits].sort(
    (a, b) => rank(a) - rank(b) || b.priority - a.priority || a.order - b.order,
  );
}

/** 「每天 / 每个工作日 / 每周一、三、五 / 每月8号」——习惯卡片上那行小字。
 *  跟循环菜单、任务上的循环说法是同一句话（recur.describeRepeat），同一屏上不会出两种写法 */
export function describeHabitRule(h: Task): string {
  return describeRepeat(habitRule(h));
}

/** 这个月的日历格子（给习惯详情用）：每天一个状态 */
export function monthMarks(
  h: Task,
  monthYmd: string,
  today = todayYMD(),
  now = new Date(),
): { ymd: string; mark: DayMark }[] {
  const y = Number(monthYmd.slice(0, 4));
  const m = Number(monthYmd.slice(5, 7));
  const out: { ymd: string; mark: DayMark }[] = [];
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const ymd = `${y}-${pad2(m)}-${pad2(d)}`;
    const due = isDueOn(h, ymd, now);
    let mark: DayMark;
    if (doneOn(h, ymd)) mark = "done";
    else if (!due) mark = "off";
    else if (cmpYMD(ymd, today) > 0) mark = "future";
    else if (ymd === today) mark = "todo";
    else mark = "missed";
    out.push({ ymd, mark });
  }
  return out;
}

/** 这个习惯**下一次**该做是哪天（习惯页每行右边那句「下次 周三」用它）。
 *  今天该做、还没打卡 → 就是今天；今天已经打过、或者今天轮不到 → 从明天起往后找第一个该做的日子。
 *  400 天内都找不到（坏数据，比如每周几一个都没勾）返回 null，界面上就不写 */
export function nextHabitDay(h: Task, today = todayYMD(), now = new Date()): string | null {
  if (isDueOn(h, today, now) && !doneOn(h, today)) return today;
  return nextDueDay(h, addDays(today, 1), 400, now);
}

const NEXT_WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 「下一次」那半句怎么说：今天 / 明天 / 后天 / 一周内写星期几（周三）/ 再远写日子（10月1日），
 *  不是今年的带上年份。刻意不走 formatShort：它一周内也写日子，「下次 9月24日」得自己换算是星期几，
 *  而习惯大多是按星期排的，直接说「周三」一眼就懂 */
export function describeNextDay(ymd: string, today = todayYMD()): string {
  const diff = diffDays(today, ymd);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  if (diff > 2 && diff < 7) return NEXT_WEEK_CN[dayOfWeek(ymd)];
  const base = `${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8, 10))}日`;
  return ymd.slice(0, 4) === today.slice(0, 4) ? base : `${ymd.slice(0, 4)}年${base}`;
}

/** 今天不用做的那一组按「下一次」先后排：明天就轮到的在上，下个月才来的在下。
 *  同一天的照旧按重要性 / 手排顺序；找不到下一次的（坏数据）沉底 */
export function sortHabitsByNext(habits: Task[], today = todayYMD(), now = new Date()): Task[] {
  const key = (h: Task) => nextHabitDay(h, today, now) ?? "9999-99-99";
  return [...habits].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return b.priority - a.priority || a.order - b.order;
  });
}
