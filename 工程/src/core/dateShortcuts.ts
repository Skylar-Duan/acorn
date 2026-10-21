import { addDays, fromYMD, isWorkday, monthEnd, toYMD, weekStart, weekendOf } from "./dates";

export type DateShortcutRule = { id: string; name?: string; mode?: "calendar" | "workday" } & (
  | { kind: "days"; days: number }
  | { kind: "week"; weeks: number; day: number | "weekend" }
  | { kind: "end"; period: "month" | "quarter" | "halfYear" | "year" }
);

/** 不写入旧账本：未自定义的设备仍使用原来的五项和周末偏好。 */
export function defaultDateShortcuts(): DateShortcutRule[] {
  return [
    { id: "today", kind: "days", days: 0 },
    { id: "tomorrow", kind: "days", days: 1 },
    { id: "weekend", kind: "week", weeks: 0, day: "weekend" },
    { id: "nextWeekend", kind: "week", weeks: 1, day: "weekend" },
    { id: "monthEnd", kind: "end", period: "month" },
  ];
}

export function validDateShortcuts(value: unknown): DateShortcutRule[] {
  if (!Array.isArray(value)) return defaultDateShortcuts();
  const ids = new Set<string>();
  return value.filter((v): v is DateShortcutRule => {
    if (!v || typeof v !== "object" || typeof v.id !== "string" || !v.id || ids.has(v.id)) return false;
    const good = (v.mode === undefined || v.mode === "calendar" || v.mode === "workday") && (
      (v.kind === "days" && Number.isInteger(v.days) && v.days >= 0 && v.days <= 3650) ||
      (v.kind === "week" && Number.isInteger(v.weeks) && v.weeks >= 0 && v.weeks <= 2 &&
        (v.day === "weekend" || (Number.isInteger(v.day) && v.day >= 0 && v.day <= 6))) ||
      (v.kind === "end" && ["month", "quarter", "halfYear", "year"].includes(v.period))
    );
    if (good) ids.add(v.id);
    return good;
  });
}

function lastWorkday(ymd: string): string {
  let date = ymd;
  while (!isWorkday(date)) date = addDays(date, -1);
  return date;
}

export function dateShortcutLabel(rule: DateShortcutRule): string {
  if (typeof rule.name === "string" && rule.name.trim()) return rule.name.trim();
  const work = rule.mode === "workday";
  if (rule.kind === "days") {
    if (!rule.days) return work ? "今天（工作日）" : "今天";
    if (!work && rule.days === 1) return "明天";
    if (!work && rule.days === 2) return "后天";
    return `${rule.days}${work ? "个工作日" : "天"}后`;
  }
  if (rule.kind === "week") {
    const prefix = ["本周", "下周", "下下周"][rule.weeks];
    const label = prefix + (rule.day === "weekend" ? "末" : "日一二三四五六"[rule.day]);
    return label + (work ? "（工作日）" : "");
  }
  const period = { month: "本月末", quarter: "本季度末", halfYear: "本半年末", year: "今年底" }[rule.period];
  return period + (work ? "（工作日）" : "");
}

export function resolveDateShortcut(today: string, rule: DateShortcutRule, weekendDay?: "sat" | "sun"): string {
  const work = rule.mode === "workday";
  if (rule.kind === "days") {
    if (!work) return addDays(today, rule.days);
    let date = today;
    let left = rule.days;
    // 0个工作日：休息日取下一个工作日，不给过去的日期。
    if (!left) { while (!isWorkday(date)) date = addDays(date, 1); }
    while (left > 0) { date = addDays(date, 1); if (isWorkday(date)) left--; }
    return date;
  }
  let result: string;
  if (rule.kind === "week") {
    result = rule.day === "weekend"
      ? weekendOf(today, weekendDay, rule.weeks)
      : addDays(weekStart(today), rule.weeks * 7 + (rule.day === 0 ? 6 : rule.day - 1));
    // 本周末原算法会把已过去的周六压到周日；工作日按所选周的实际末尾取。
    if (work && rule.day === "weekend") result = addDays(weekStart(today), rule.weeks * 7 + (weekendDay === "sat" ? 5 : 6));
  } else {
    const d = fromYMD(today);
    const month = d.getMonth();
    const endMonth = rule.period === "month" ? month : rule.period === "quarter" ? Math.floor(month / 3) * 3 + 2 : rule.period === "halfYear" ? (month < 6 ? 5 : 11) : 11;
    result = monthEnd(toYMD(new Date(d.getFullYear(), endMonth, 1)));
  }
  return work ? lastWorkday(result) : result;
}
