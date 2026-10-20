// 整件事的显示日期；只计算，不把子任务的安排写回母任务。
import type { Task } from "./model";

/** 比较母任务和所有待办子任务，选最早的一次有效安排。
 *  已完成/放弃/删除的母任务保留自己的日期，不再从子任务推导；子任务同样只数还欠着的。
 *  循环子任务直接用当前 due，完成时 store 会把它推进下一次，不在这里另算循环。
 *  同日先取有钟点且最早的那条；无钟点排在最后，相同安排保留母任务／子数组的原序。
 *  日期和钟点始终来自同一条安排，未手排子只继承母任务原字段，绝不继承兄弟的日期。 */
function nextSchedule(task: Task): { due: string; dueTime: string | null } | null {
  let next = task.due ? { due: task.due, dueTime: task.dueTime ?? null } : null;
  if (task.done || task.droppedAt || task.deletedAt) return next;
  for (const sub of task.subtasks) {
    if (sub.done || sub.deletedAt || sub.droppedAt) continue;
    const due = sub.due ?? task.due;
    if (!due) continue;
    const dueTime = sub.due ? sub.dueTime ?? null : sub.dueTime ?? task.dueTime ?? null;
    if (!next || due < next.due ||
        (due === next.due && (dueTime ?? "99:99") < (next.dueTime ?? "99:99"))) {
      next = { due, dueTime };
    }
  }
  return next;
}

/** 母任务和待办子任务的最近安排，用于显示、分组和排序，不改母任务手排字段。
 *  子任务继承日期仍只看母任务手排的 due，绝不把兄弟的安排传给未安排的子任务。 */
export function taskDue(task: Task): string | null {
  return nextSchedule(task)?.due ?? null;
}

/** 与 taskDue 同一条安排的钟点，母任务没日期时不借用它残留的钟点。 */
export function taskTime(task: Task): string | null {
  return nextSchedule(task)?.dueTime ?? null;
}
