// 「计划」视图怎么分组（纯函数，可单测）。
//
// 用户口径（2026-08-28）：
//   · 按时间：逾期 / 今天 之后，「接下来」再切成 一周内 / 一个月内 / 半年内
//   · 按重要性：先分 高 / 中 / 低 / 普通 四档，**每档内部按时间排**
//
// 为什么一定要有「更远」这一组：半年以后的事总会有（学费、年检、明年的考试）。
// 没有兜底组，它们不属于任何一段，会在界面上凭空消失——那是丢数据级的错觉。

import type { Priority, Task } from "./model";
import type { DateRow } from "./store";
import { rowDue, rowPriority, sortRows } from "./store";
import { addDays, cmpYMD } from "./dates";

export interface PlanGroup {
  key: string;
  label: string;
  /** 醒目提示（逾期） */
  warn?: boolean;
  rows: DateRow[];
}

/** 「接下来」的三档分界（天数，从今天往后算，含端点）。顺序即显示顺序 */
export const PLAN_BANDS = [
  { key: "w1", label: "一周内", days: 7 },
  { key: "m1", label: "一个月内", days: 30 },
  { key: "h1", label: "半年内", days: 182 },
] as const;

// 「普通」是兜底档：任何不是 高/中/低 的重要性都归它。
// 别写成 === 0——导进来的数据里 priority 可能是 5 或 null（migrate 不校验这个字段），
// 四档都严格相等匹配的话，这种行会一档都不落，整条从「按重要性」页面上蒸发。
// 时间维度那边专门为这件事留了「更远」，这边同理。
const PRIORITY_BANDS: { key: string; label: string; level: Priority | null }[] = [
  { key: "p3", label: "高", level: 3 },
  { key: "p2", label: "中", level: 2 },
  { key: "p1", label: "低", level: 1 },
  { key: "p0", label: "普通", level: null },
];

/** 把未完成的行分组。mode 决定分组的维度本身，不只是组内怎么排 */
export function planGroups(rows: DateRow[], mode: "time" | "priority", today: string): PlanGroup[] {
  // 组内一律按时间排：分组已经把「重要性」这一维吃掉了，组内再按重要性排没有信息量
  const pick = (test: (r: DateRow) => boolean) => sortRows(rows.filter(test), "time");

  if (mode === "priority") {
    const named = new Set<unknown>([3, 2, 1]);
    return PRIORITY_BANDS.map((b) => ({
      key: b.key,
      label: b.label,
      rows: pick((r) => (b.level === null ? !named.has(rowPriority(r)) : rowPriority(r) === b.level)),
    }));
  }

  const out: PlanGroup[] = [
    { key: "overdue", label: "逾期", warn: true, rows: pick((r) => { const d = rowDue(r); return !!d && cmpYMD(d, today) < 0; }) },
    { key: "today", label: "今天", rows: pick((r) => rowDue(r) === today) },
  ];
  let from = today;
  for (const b of PLAN_BANDS) {
    const lo = from;
    const hi = addDays(today, b.days);
    out.push({
      key: b.key,
      label: b.label,
      rows: pick((r) => { const d = rowDue(r); return !!d && cmpYMD(d, lo) > 0 && cmpYMD(d, hi) <= 0; }),
    });
    from = hi;
  }
  const last = from;
  out.push({ key: "far", label: "更远", rows: pick((r) => { const d = rowDue(r); return !!d && cmpYMD(d, last) > 0; }) });
  out.push({ key: "nodate", label: "未安排", rows: pick((r) => rowDue(r) === null) });
  return out;
}

/** 清单 / 随手记 / 需求方 / 标签（views/ListView）怎么分组。这四处一件事只占一行，
 *  所以分的是 Task 不是 DateRow。传进来的 tasks 已经排好序了，这儿只切分、不重排。
 *
 *  两条规矩跟「展开期间把这件事钉在原位」（core/pin.ts）是一套的：
 *   · key 是**语义名**，不是数组下标。下标当 key 的话，某一组一空，它后面每一组的 key
 *     全体错一位，整片 Fragment 换 key 重挂，卡片跟着卸载重建——输入焦点、「＋子任务」
 *     草稿、「整句改」草稿全清空，正是用户报的那个「卡片自己收回去了」
 *   · 空组照旧出场（画不画交给视图判）。钉住的那一件可能正落在一个「本来空了」的组里：
 *     在卡里把日期改到今天，它原来那组只剩它一个，组就空了；组要是当场从数组里消失，
 *     pinExpanded 认不出这个组名，就没地方把它钉回去了 */
export interface ListGroup {
  key: string;
  label: string;
  /** 醒目提示（逾期） */
  warn?: boolean;
  rows: Task[];
}

/** @param nodateLabel 「没有日期」那一组的标题（随手记整页都是没日期的，不用再标一遍） */
export function listGroups(tasks: Task[], today: string, nodateLabel: string): ListGroup[] {
  const overdue = tasks.filter((t) => t.due && cmpYMD(t.due, today) < 0);
  const todays = tasks.filter((t) => t.due === today);
  const later = tasks.filter((t) => t.due && cmpYMD(t.due, today) > 0);
  const nodate = tasks.filter((t) => !t.due);
  // 标题上那个数字数的是「这一组本来有几件」——钉住只管画面上别挪窝，不改「谁属于哪一组」
  return [
    { key: "overdue", label: `逾期 ${overdue.length}`, warn: true, rows: overdue },
    { key: "today", label: "今天", rows: todays },
    { key: "later", label: "以后", rows: later },
    { key: "nodate", label: nodateLabel, rows: nodate },
  ];
}

/** 已完成视图的分组：过去一周 / 过去一个月 / 更早。传的是完成日（本地 'YYYY-MM-DD'） */
export function doneGroups<T>(items: T[], doneDay: (x: T) => string, today: string): { key: string; label: string; items: T[] }[] {
  const w = addDays(today, -7);
  const m = addDays(today, -30);
  const pick = (test: (d: string) => boolean) => items.filter((x) => test(doneDay(x)));
  return [
    { key: "w", label: "过去一周", items: pick((d) => cmpYMD(d, w) >= 0) },
    { key: "m", label: "过去一个月", items: pick((d) => cmpYMD(d, m) >= 0 && cmpYMD(d, w) < 0) },
    { key: "old", label: "更早", items: pick((d) => cmpYMD(d, m) < 0) },
  ];
}
