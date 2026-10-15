// 整件事的显示日期；只计算，不把子任务的安排写回母任务。
import type { Subtask, Task } from "./model";

/** 母任务没手排日期时，用还欠着的子任务里最早的一次安排。
 *  已完成/放弃/删除的母任务不再自动排期；子任务同样只数还欠着的。
 *  循环子任务直接用当前 due，完成时 store 会把它推进下一次，不在这里另算循环。
 *  同日先取有钟点且最早的那条；无钟点排在最后，相同安排保留原序。 */
function nextScheduledSubtask(task: Task): Subtask | null {
  if (task.done || task.droppedAt || task.deletedAt) return null;
  let next: Subtask | null = null;
  for (const sub of task.subtasks) {
    if (sub.done || sub.deletedAt || sub.droppedAt || !sub.due) continue;
    if (!next || sub.due < next.due! ||
        (sub.due === next.due && (sub.dueTime ?? "99:99") < (next.dueTime ?? "99:99"))) {
      next = sub;
    }
  }
  return next;
}

/** 母任务手排日期优先；否则按最早的未完成子任务显示和分组。
 *  子任务继承日期仍只看母任务手排的 due，绝不把兄弟的安排传给未安排的子任务。 */
export function taskDue(task: Task): string | null {
  return task.due ?? nextScheduledSubtask(task)?.due ?? null;
}

/** 与 taskDue 同一条安排的钟点，母任务没日期时不借用它残留的钟点。 */
export function taskTime(task: Task): string | null {
  return task.due ? task.dueTime : nextScheduledSubtask(task)?.dueTime ?? null;
}
