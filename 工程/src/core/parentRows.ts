// 桌面母子树只改变可见结构；原始任务、日期和子任务数组均不改写。
import type { AppData, Task } from "./model";
import type { DateRow } from "./store";
import { aliveSubtasks, openRows, overdueSubRows, rowDue, sortRows } from "./store";
import { cmpYMD } from "./dates";

/** 同一母任务只占一个分组位置，日期仍由rowDue的母手排／最近子规则决定。 */
export function mergeParentRows(rows: readonly DateRow[]): DateRow[] {
  const seen = new Set<string>();
  return rows.flatMap(({ task }): DateRow[] => {
    if (seen.has(task.id)) return [];
    seen.add(task.id); return [{ task, sub: null }];
  });
}

/** 展开本母全部待办，固定时间主、重要性次，不跟随母列表的分组模式改顺序。 */
export function pendingChildRows(task: Task): DateRow[] {
  return sortRows(aliveSubtasks(task).filter((sub) => !sub.done && !sub.droppedAt).map((sub) => ({ task, sub })), "time");
}

/** 只顺延实际过期的日期owner；继承过期母日期的子不必另写自己的日期。 */
export function overdueParentActions(task: Task, today: string): DateRow[] {
  const motherPast = !!task.due && cmpYMD(task.due, today) < 0;
  return [
    ...(motherPast ? [{ task, sub: null }] : []),
    ...overdueSubRows(task, today).filter(({ sub }) => !motherPast || sub!.due != null),
  ];
}

/** Today命中母安排或任何到期步骤；跨逾期／今日只保留一条母行。 */
export function parentRowsForToday(data: Pick<AppData, "tasks" | "settings">, today: string): { overdue: DateRow[]; todays: DateRow[]; overdueActions: DateRow[]; todayCount: number } {
  const overdue: DateRow[] = [], todays: DateRow[] = [], overdueActions: DateRow[] = [];
  let todayCount = 0;
  for (const row of mergeParentRows(openRows(data))) {
    const children = pendingChildRows(row.task);
    const due = rowDue(row);
    const pastChildren = overdueSubRows(row.task, today);
    const parentPast = !!due && cmpYMD(due, today) < 0;
    const hasToday = due === today || children.some((child) => rowDue(child) === today);
    if (hasToday) todayCount++;
    if (parentPast || pastChildren.length) {
      overdue.push(row);
      overdueActions.push(...overdueParentActions(row.task, today));
    } else if (hasToday) todays.push(row);
  }
  return { overdue: sortRows(overdue, data.settings.sortMode), todays: sortRows(todays, data.settings.sortMode), overdueActions, todayCount };
}
