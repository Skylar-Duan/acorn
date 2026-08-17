// 日期工具：全应用统一用本地时区的 'YYYY-MM-DD' 字符串表示日期，
// 'HH:mm' 表示时间。避免 Date 序列化/时区带来的隐性偏移。

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Date -> 'YYYY-MM-DD'（本地时区） */
export function toYMD(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date（本地 00:00） */
export function fromYMD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function todayYMD(now: Date = new Date()): string {
  return toYMD(now);
}

export function addDays(ymd: string, n: number): string {
  const d = fromYMD(ymd);
  d.setDate(d.getDate() + n);
  return toYMD(d);
}

/** 0=周日 … 6=周六（与 Date.getDay 一致） */
export function dayOfWeek(ymd: string): number {
  return fromYMD(ymd).getDay();
}

export function isWorkday(ymd: string): boolean {
  const w = dayOfWeek(ymd);
  return w >= 1 && w <= 5;
}

export function daysInMonth(year: number, month1: number): number {
  // month1: 1..12
  return new Date(year, month1, 0).getDate();
}

/** 'YYYY-MM-DD' 比较：a<b 负数，a===b 0，a>b 正数（字符串序即时间序） */
export function cmpYMD(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 两个日期相差的天数：b - a */
export function diffDays(a: string, b: string): number {
  const ms = fromYMD(b).getTime() - fromYMD(a).getTime();
  return Math.round(ms / 86400000);
}

/** 本周一（周作为回顾单位，周一开始） */
export function weekStart(ymd: string): string {
  const w = dayOfWeek(ymd);
  return addDays(ymd, w === 0 ? -6 : 1 - w);
}

/** 当月一号 */
export function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** '8月17日 · 星期一' */
export function formatCN(ymd: string): string {
  const d = fromYMD(ymd);
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${WEEK_CN[d.getDay()]}`;
}

/** 短格式：今天/明天/昨天/8月21日，超过今年附带年份 */
export function formatShort(ymd: string, now: Date = new Date()): string {
  const t = todayYMD(now);
  const diff = diffDays(t, ymd);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  if (diff === -1) return "昨天";
  const d = fromYMD(ymd);
  const base = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? base : `${d.getFullYear()}年${base}`;
}

/** 'YYYY-MM-DDTHH:mm'（本地）；reminder 存储用 */
export function toLocalDT(ymd: string, hm: string): string {
  return `${ymd}T${hm}`;
}

export function nowLocalDT(now: Date = new Date()): string {
  return `${toYMD(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}
