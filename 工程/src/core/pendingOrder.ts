import type { Priority } from "./model";

export interface PendingSchedule {
  due: string | null;
  time: string | null;
  priority: Priority;
}

/** 无日期不拿残留钟点排先后；同日有钟点的先于未定钟点。 */
export function pendingTimeKey(due: string | null, time: string | null): string {
  return due ? `${due}T${time || "99:99"}` : "9999-99-99T99:99";
}

/** 待办时间主、重要性次；同键返回0，由调用方保留原先后。 */
export function comparePendingSchedule(a: PendingSchedule, b: PendingSchedule): number {
  const left = pendingTimeKey(a.due, a.time), right = pendingTimeKey(b.due, b.time);
  if (left !== right) return left < right ? -1 : 1;
  return b.priority - a.priority;
}
