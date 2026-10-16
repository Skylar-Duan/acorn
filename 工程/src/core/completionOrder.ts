import type { Subtask, Task } from "./model";

/** 实际结束时刻。只认有效ISO时间，不用创建/编辑时间替代未知的完成时刻。 */
export function completedMillis(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const max = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!max || day < 1 || day > max || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] || 0) > 59) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

/** 最近结束的在上；同刻、缺失或非法时间保持原顺序，未知一律在有效记录后。 */
export function compareCompletedAt(a: unknown, b: unknown): number {
  const left = completedMillis(a), right = completedMillis(b);
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

/** 老子任务没有自己的戳时，可沿用已完成母任务的真实戳；绝不回落到创建时间。 */
export function rowCompletionAt(row: { task: Task; sub: Subtask | null }): string | null {
  const raw = row.sub ? row.sub.doneAt ?? (row.task.done ? row.task.doneAt : null) : row.task.doneAt;
  return completedMillis(raw) === null ? null : raw!;
}
