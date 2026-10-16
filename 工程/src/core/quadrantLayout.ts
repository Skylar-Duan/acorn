import type { AppData, Priority, Subtask, Task } from "./model";

export type QuadrantDateKind = "dated" | "overdue" | "undated";
export type QuadrantRange = readonly [number, number];
export interface QuadrantPoint {
  id: string;
  task: Task;
  sub: Subtask | null;
  taskId: string;
  subId: string | null;
  title: string;
  parentTitle: string | null;
  /** 显示用的有效值；子任务仅继承母任务手排属性，不借兄弟的安排。 */
  due: string | null;
  priority: Priority;
  /** 百分比，x向右越紧急，y向下越不重要。 */
  xPct: number;
  yPct: number;
  xRange: QuadrantRange;
  yRange: QuadrantRange;
  dateKind: QuadrantDateKind;
}
export interface QuadrantPreview {
  due: string | null;
  priority: Priority;
  dateKind: QuadrantDateKind;
  dayOffset: number | null;
}
export interface QuadrantDragPreview extends QuadrantPreview {
  /** due=null对子任务表示继承；这里给出继承后实际显示的日期。 */
  effectiveDue: string | null;
  inheritsDue: boolean;
  changedX: boolean;
  changedY: boolean;
}
export interface QuadrantAxisTick {
  key: string;
  label: string;
  xPct: number;
  due: string | null;
  kind: QuadrantDateKind;
}

export const QUADRANT_SCALE = {
  urgencyX: 50,
  importanceY: 50,
  undated: [0, 8] as QuadrantRange,
  futureLimitX: 10,
  todayX: 70,
  /** 昨天/今天单元之间的半日边界；今天的散点不会被误标成逾期。 */
  overdueStartX: 98 - 196 / 7.5,
  overdueLimitX: 98,
  editYears: [1900, 2999] as const,
} as const;

const DAY_MS = 86400000;
/** 用UTC日序数做公历运算，避免夏令时让一天变成23/25小时。 */
function ordinal(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() / DAY_MS : null;
}
function todayOrdinal(today: string): number {
  const value = ordinal(today);
  if (value === null) throw new RangeError("四象限需要有效的今天日期");
  return value;
}
function validDue(due: unknown): string | null { return ordinal(due) === null ? null : due as string; }
const MIN_DAY = ordinal("0001-01-01")!;
const MAX_DAY = ordinal("9999-12-31")!;
const MIN_EDIT_DAY = ordinal("1900-01-01")!;
const MAX_EDIT_DAY = ordinal("2999-12-31")!;
function dayString(day: number): string {
  const date = new Date(Math.max(MIN_DAY, Math.min(MAX_DAY, day)) * DAY_MS);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
function finiteClamp(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

/** 未来f(d)=10+180/(d+3)，f''=360/(d+3)^3>0：近日期拉开，远期压缩。
 *  d=1.5恰在x=50，因此明天及以前仍是紧急右半区。
 *  逾期另用连续可逆有界段，保留很早的原日期，不把所有逾期压成一个点。 */
function xAtOffset(days: number): number {
  return days >= 0 ? 10 + 180 / (days + 3) : 98 - 196 / (7 - days);
}

export function deadlineX(due: string | null, today: string): number {
  const base = todayOrdinal(today), day = ordinal(due);
  return day === null ? 4 : xAtOffset(day - base);
}

/** 用户生成日期遵守既有输入范围1900..2999；投影原值和未移动日期轴不受此范围截断。 */
export function deadlineAtX(xPct: number, today: string): string | null {
  const base = todayOrdinal(today), x = finiteClamp(xPct, 4);
  if (x <= QUADRANT_SCALE.futureLimitX) return null;
  const offset = x <= 70 ? 180 / (x - 10) - 3 : x < 98 ? 7 - 196 / (98 - x) : MIN_EDIT_DAY - base;
  return dayString(Math.max(MIN_EDIT_DAY, Math.min(MAX_EDIT_DAY, base + Math.round(offset))));
}

/** 键盘日期步进同一生成范围，不经过new Date(year,...)的0..99年份偏移或本地DST。 */
export function stepQuadrantDate(due: string, delta: number): string {
  const day = ordinal(due);
  if (day === null) throw new RangeError("日期步进需要有效日期");
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  if (!step) return due;
  return dayString(Math.max(MIN_EDIT_DAY, Math.min(MAX_EDIT_DAY, day + step)));
}

export function importanceBand(priority: Priority): { min: number; max: number; center: number; label: string } {
  const level = Math.max(0, Math.min(3, Math.round(priority))) as Priority;
  const min = (3 - level) * 25;
  return { min, max: min + 25, center: min + 12.5, label: ["无", "低", "中", "高"][level] };
}
function priorityAtY(yPct: number): Priority {
  return Math.max(0, 3 - Math.floor(finiteClamp(yPct, 50) / 25)) as Priority;
}
function dateInfo(due: string | null, today: string): { dateKind: QuadrantDateKind; dayOffset: number | null } {
  const day = ordinal(due), base = todayOrdinal(today);
  const dayOffset = day === null ? null : day - base;
  return { dayOffset, dateKind: dayOffset === null ? "undated" : dayOffset < 0 ? "overdue" : "dated" };
}

/** 每日单元的边界是d±0.5的投影；点只在本日单元内散开，反解不会跳日期。 */
function dateRange(due: string | null, today: string): QuadrantRange {
  const day = ordinal(due), base = todayOrdinal(today);
  if (day === null) return QUADRANT_SCALE.undated;
  const offset = day - base;
  return [xAtOffset(offset + 0.5), xAtOffset(offset - 0.5)];
}
/** 只由稳定行ID产生，数据顺序/窗口尺寸/刷新均不改变位置。 */
function unitHash(id: string, salt: string): number {
  let value = 2166136261;
  const text = `${salt}|${id}`;
  for (let i = 0; i < text.length; i++) { value ^= text.charCodeAt(i); value = Math.imul(value, 16777619); }
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15; value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}
function scatter(range: QuadrantRange, id: string, salt: string): number {
  return range[0] + (range[1] - range[0]) * (0.16 + unitHash(id, salt) * 0.68);
}

/** 只列可执行点：仍欠着子步骤时母任务不重复占点，无待办子时母任务回来收尾。 */
export function quadrantPoints(data: Pick<AppData, "tasks">, today: string): QuadrantPoint[] {
  todayOrdinal(today);
  const points: QuadrantPoint[] = [];
  for (const task of data.tasks) {
    if (task.kind === "habit" || task.done || task.droppedAt || task.deletedAt) continue;
    const pending = task.subtasks.filter((sub) => !sub.done && !sub.droppedAt && !sub.deletedAt);
    const rows: (Subtask | null)[] = pending.length ? pending : [null];
    for (const sub of rows) {
      const id = JSON.stringify([task.id, sub?.id ?? null]);
      const due = validDue(sub ? sub.due ?? task.due : task.due);
      const priority = sub?.priority ?? task.priority;
      const xRange = dateRange(due, today);
      const band = importanceBand(priority), yRange: QuadrantRange = [band.min, band.max];
      points.push({ id, task, sub, taskId: task.id, subId: sub?.id ?? null,
        title: sub?.title ?? task.title, parentTitle: sub ? task.title : null,
        due, priority, xRange, yRange, xPct: scatter(xRange, id, "x"), yPct: scatter(yRange, id, "y"),
        dateKind: dateInfo(due, today).dateKind });
    }
  }
  return points;
}

export function quadrantPreview(xPct: number, yPct: number, today: string): QuadrantPreview {
  const due = deadlineAtX(xPct, today);
  return { due, priority: priorityAtY(yPct), ...dateInfo(due, today) };
}

/** moveX/Y由交互层根据真实轴位移判断。保留未动轴，避免纵向拖动截断远日期或固化继承。 */
export function quadrantDragPreview(point: QuadrantPoint, xPct: number, yPct: number, today: string,
  axes: { moveX: boolean; moveY: boolean }): QuadrantDragPreview {
  const decoded = quadrantPreview(xPct, yPct, today);
  const due = axes.moveX ? decoded.due : point.due;
  const priority = axes.moveY ? decoded.priority : point.priority;
  const ownDue = point.sub ? point.sub.due ?? null : point.task.due;
  const changedX = axes.moveX && (due === null ? ownDue !== null : due !== point.due);
  const inheritsDue = !!point.sub && (changedX ? due === null : ownDue === null);
  const effectiveDue = inheritsDue ? validDue(point.task.due) : due;
  return { due, priority, effectiveDue, inheritsDue, ...dateInfo(effectiveDue, today),
    changedX,
    changedY: axes.moveY && priority !== point.priority };
}

/** compact给窄屏留5个可读刻度；时间与全年/多年原值不参与截断。 */
export function quadrantAxisTicks(today: string, options: { compact?: boolean } = {}): QuadrantAxisTick[] {
  const base = todayOrdinal(today);
  const values: { key: string; label: string; offset: number | null }[] = options.compact
    ? [{ key: "undated", label: "无日期", offset: null }, { key: "week", label: "下周", offset: 7 },
      { key: "tomorrow", label: "明天", offset: 1 }, { key: "today", label: "今天", offset: 0 }, { key: "overdue", label: "逾期", offset: -14 }]
    : [{ key: "undated", label: "无日期", offset: null }, { key: "far", label: "远期", offset: 365 },
      { key: "month", label: "一月后", offset: 30 }, { key: "week", label: "下周", offset: 7 },
      { key: "after-tomorrow", label: "后天", offset: 2 }, { key: "tomorrow", label: "明天", offset: 1 },
      { key: "today", label: "今天", offset: 0 }, { key: "overdue", label: "逾期", offset: -14 }];
  return values.map((value) => {
    const due = value.offset === null ? null : dayString(base + value.offset);
    return { key: value.key, label: value.label, due, xPct: deadlineX(due, today), kind: dateInfo(due, today).dateKind };
  });
}
