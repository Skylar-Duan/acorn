// 统计与每周回顾聚合：纯函数、零 DOM 依赖，"现在/今天"一律由调用方注入。
// 口径约定（各函数共用）：
// - "完成"指 done 且未在回收站，按 doneAt 换算为本地日期后判断是否落入区间；
// - "未完成"（open）指当前 !done 且未删除，与区间无关；
// - 所有 [startYMD, endYMD] 区间均含两端。

import type { FocusSession, List, Task } from "./model";
import { addDays, cmpYMD, diffDays, fromYMD, toYMD, weekStart } from "./dates";

/** ISO 时刻 → 本地 'YYYY-MM-DD'（带 Z 或显式时区偏移的写法都归到本地日历日） */
export function localDateOfISO(iso: string): string {
  return toYMD(new Date(iso));
}

/** [start, end] 逐日展开；start > end 时返回空数组 */
function eachDay(startYMD: string, endYMD: string): string[] {
  const days: string[] = [];
  for (let d = startYMD; cmpYMD(d, endYMD) <= 0; d = addDays(d, 1)) days.push(d);
  return days;
}

function inRange(ymd: string, startYMD: string, endYMD: string): boolean {
  return cmpYMD(ymd, startYMD) >= 0 && cmpYMD(ymd, endYMD) <= 0;
}

/** 平局时的稳定排序：按码点比较（不用 localeCompare，避免结果随 ICU 版本漂移） */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 是否为区间内的有效完成（done + 未删除 + doneAt 本地日落入区间） */
function isDoneInRange(t: Task, startYMD: string, endYMD: string): t is Task & { doneAt: string } {
  return (
    t.done &&
    t.deletedAt === null &&
    t.doneAt !== null &&
    inRange(localDateOfISO(t.doneAt), startYMD, endYMD)
  );
}

/** 每日完成数：每天都有条目（0 也要），只统计 done 且未删除，按 doneAt 归日 */
export function completionByDay(
  tasks: Task[],
  startYMD: string,
  endYMD: string,
): { date: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of tasks) {
    if (!t.done || t.deletedAt !== null || t.doneAt === null) continue;
    const d = localDateOfISO(t.doneAt);
    m.set(d, (m.get(d) ?? 0) + 1);
  }
  return eachDay(startYMD, endYMD).map((date) => ({ date, count: m.get(date) ?? 0 }));
}

/** 每日新增数：按 createdAt 归日；进了回收站的也算当初的新增 */
export function addedByDay(
  tasks: Task[],
  startYMD: string,
  endYMD: string,
): { date: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of tasks) {
    const d = localDateOfISO(t.createdAt);
    m.set(d, (m.get(d) ?? 0) + 1);
  }
  return eachDay(startYMD, endYMD).map((date) => ({ date, count: m.get(date) ?? 0 }));
}

/**
 * 按清单统计。随手记固定第一行（id=null），其余清单按 order 升序，全零也保留；
 * 引用了已不存在清单的任务并入随手记。
 */
export function byList(
  tasks: Task[],
  lists: List[],
  startYMD: string,
  endYMD: string,
): { id: string | null; name: string; done: number; open: number }[] {
  const rows = new Map<string | null, { id: string | null; name: string; done: number; open: number }>();
  rows.set(null, { id: null, name: "随手记", done: 0, open: 0 });
  for (const l of [...lists].sort((a, b) => a.order - b.order)) {
    rows.set(l.id, { id: l.id, name: l.name, done: 0, open: 0 });
  }
  for (const t of tasks) {
    if (t.deletedAt !== null) continue;
    const row = rows.get(t.listId) ?? rows.get(null)!;
    if (t.done) {
      if (isDoneInRange(t, startYMD, endYMD)) row.done++;
    } else {
      row.open++;
    }
  }
  return [...rows.values()];
}

/** 按需求方统计：只含（未删除任务里）出现过 who 的，按 done 降序，平局按名字稳定排。
 *  一件事挂了几个人就在几个人名下各算一次——「这件事和谁有关」的口径，不是把工作量切开分 */
export function byWho(
  tasks: Task[],
  startYMD: string,
  endYMD: string,
): { who: string; done: number; open: number }[] {
  const rows = new Map<string, { who: string; done: number; open: number }>();
  for (const t of tasks) {
    if (t.deletedAt !== null) continue;
    for (const w of t.who) {
      let row = rows.get(w);
      if (!row) {
        row = { who: w, done: 0, open: 0 };
        rows.set(w, row);
      }
      if (t.done) {
        if (isDoneInRange(t, startYMD, endYMD)) row.done++;
      } else {
        row.open++;
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.done - a.done || cmpStr(a.who, b.who));
}

/** 每日专注分钟：session.date 本身就是本地日，直接累加；每天都有条目 */
export function focusByDay(
  sessions: FocusSession[],
  startYMD: string,
  endYMD: string,
): { date: string; minutes: number }[] {
  const m = new Map<string, number>();
  for (const s of sessions) m.set(s.date, (m.get(s.date) ?? 0) + s.minutes);
  return eachDay(startYMD, endYMD).map((date) => ({ date, minutes: m.get(date) ?? 0 }));
}

export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  completed: Task[];
  stillOpen: Task[];
  postponed: Task[];
  focusMinutes: number;
  perList: { name: string; done: number }[];
  perWho: { who: string; done: number }[];
}

/**
 * 每周回顾（周一~周日）。传入周内任意一天都会归一化到该周周一。
 * 约定：completed 按 perList 的分组顺序连续排列（组内按 doneAt 升序），
 * exportWeekMarkdown 依赖这一约定用 perList 的计数切片还原分组。
 */
export function weeklyReview(
  tasks: Task[],
  sessions: FocusSession[],
  lists: List[],
  weekStartYMD: string,
): WeeklyReview {
  const ws = weekStart(weekStartYMD);
  const we = addDays(ws, 6);
  const live = tasks.filter((t) => t.deletedAt === null);

  const doneThisWeek = live.filter((t): t is Task & { doneAt: string } => isDoneInRange(t, ws, we));

  const listName = (listId: string | null): string =>
    listId === null ? "随手记" : (lists.find((l) => l.id === listId)?.name ?? "随手记");

  const groups = new Map<string, Task[]>();
  for (const t of doneThisWeek) {
    const name = listName(t.listId);
    const g = groups.get(name);
    if (g) g.push(t);
    else groups.set(name, [t]);
  }
  const groupArr = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || cmpStr(a[0], b[0]),
  );
  const perList = groupArr.map(([name, ts]) => ({ name, done: ts.length }));
  const completed = groupArr.flatMap(([, ts]) =>
    [...ts].sort((a, b) => new Date(a.doneAt!).getTime() - new Date(b.doneAt!).getTime()),
  );

  const whoCount = new Map<string, number>();
  for (const t of doneThisWeek) {
    for (const w of t.who) whoCount.set(w, (whoCount.get(w) ?? 0) + 1);
  }
  const perWho = [...whoCount.entries()]
    .map(([who, done]) => ({ who, done }))
    .sort((a, b) => b.done - a.done || cmpStr(a.who, b.who));

  const stillOpen = live
    .filter((t): t is Task & { due: string } => !t.done && t.due !== null && cmpYMD(t.due, we) <= 0)
    .sort((a, b) => cmpYMD(a.due, b.due) || a.order - b.order);

  const postponed = live
    .filter((t) => !t.done && t.postponeCount > 0)
    .sort((a, b) => b.postponeCount - a.postponeCount);

  const focusMinutes = sessions
    .filter((s) => inRange(s.date, ws, we))
    .reduce((sum, s) => sum + s.minutes, 0);

  return { weekStart: ws, weekEnd: we, completed, stillOpen, postponed, focusMinutes, perList, perWho };
}

function fmtMD(ymd: string): string {
  const d = fromYMD(ymd);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0 && m > 0) return `${h} 小时 ${m} 分钟`;
  if (h > 0) return `${h} 小时`;
  return `${m} 分钟`;
}

/** 中文 Markdown 周报小结；空周输出兜底文案 */
export function exportWeekMarkdown(r: WeeklyReview): string {
  const lines: string[] = [];
  lines.push(`# 每周回顾（${fmtMD(r.weekStart)} ~ ${fmtMD(r.weekEnd)}）`);

  const isEmpty =
    r.completed.length === 0 &&
    r.stillOpen.length === 0 &&
    r.postponed.length === 0 &&
    r.focusMinutes === 0;
  if (isEmpty) {
    lines.push("", "本周没有记录，好好休息也很重要。");
    return lines.join("\n") + "\n";
  }

  lines.push("", `## ✅ 本周完成 ${r.completed.length} 件`);
  if (r.completed.length === 0) {
    lines.push("", "本周没有完成记录。");
  } else {
    // 依 weeklyReview 的约定：completed 按 perList 分组顺序连续排列，按计数切片还原
    let i = 0;
    for (const g of r.perList) {
      lines.push("", `### ${g.name}（${g.done} 件）`);
      for (const t of r.completed.slice(i, i + g.done)) lines.push(`- ${t.title}`);
      i += g.done;
    }
  }

  if (r.stillOpen.length > 0) {
    lines.push("", `## ⏳ 未清 ${r.stillOpen.length} 件`);
    for (const t of r.stillOpen) {
      const overdue = t.due === null ? 0 : diffDays(t.due, r.weekEnd);
      lines.push(`- ${t.title}${overdue > 0 ? `（逾期 ${overdue} 天）` : "（本周到期）"}`);
    }
  }

  if (r.postponed.length > 0) {
    lines.push("", "## 🔁 反复顺延");
    for (const t of r.postponed) {
      lines.push(`- ${t.title}（顺延 ${t.postponeCount} 次，考虑拆小或放弃）`);
    }
  }

  lines.push("", `## 🍅 专注合计 ${fmtMinutes(r.focusMinutes)}`);

  if (r.perWho.length > 0) {
    lines.push("", "## 按需求方");
    for (const w of r.perWho) lines.push(`- ${w.who}：${w.done} 件`);
  }

  return lines.join("\n") + "\n";
}
