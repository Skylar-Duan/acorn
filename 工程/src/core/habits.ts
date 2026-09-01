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

/** 习惯没设周期时按「每天」算——新建习惯默认就是每天，这里只是兜底 */
export const DEFAULT_HABIT_REPEAT: RepeatRule = { kind: "daily", every: 1 };

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

/** 「每天 / 每个工作日 / 每周一三五 / 每月 8 号」——习惯卡片上那行小字 */
export function describeHabitRule(h: Task): string {
  const rule = habitRule(h);
  switch (rule.kind) {
    case "daily":
      return rule.every === 1 ? "每天" : `每 ${rule.every} 天`;
    case "workday":
      return "每个工作日";
    case "weekly": {
      const names = ["日", "一", "二", "三", "四", "五", "六"];
      if (rule.days.length === 7) return "每天";
      return `每周${rule.days.map((d) => names[d]).join("、")}`;
    }
    case "monthly":
      return `每月 ${rule.day} 号`;
  }
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
