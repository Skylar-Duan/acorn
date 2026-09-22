// 习惯页里的「重复的计划」那一组：所有带循环、还没了结的计划。
//
// 用户 2026-09-21 原话：「我添加的重复计划每月“同步一次”在里面看不到，我要在里面就跟计划界面一样
// 全部放上，而不是只显示今天的，右侧显示下一次的时间」。
// 所以这里**不看今天**：一件循环的事不管下一次在明天还是下个月，都列出来；
// 它的「下一次」就是它现在的日期（循环任务勾完成会把日期推到下一个落点，见 store.completeTask /
// store.advanceSub），行上右边本来就显示这个日期，不另算一份。
//
// 单独一个文件、不塞进 store.ts：它要用 store 里的 aliveTasks / aliveSubtasks / rowDue，
// 放进 habits.ts 会跟 store 互相 import 成环。

import type { AppData } from "./model";
import { aliveSubtasks, aliveTasks, rowDue, rowTime, type DateRow } from "./store";

/** 带循环的计划，一行一件：
 *   · 整件事带循环的 → 母任务那一行（有子任务也只占一行，跟「每月同步一次」这种说法对得上）；
 *   · 某一步自己带循环的 → 「母 › 子」那一行（母任务本身带不带循环都算）。
 *  做完的、放弃的、在回收站的都不算；习惯不算（习惯在本页自己那两组里）。
 *  按下一次的日子排，同一天写了钟点的在前；没排日子的沉底，彼此按标题排 */
export function repeatingRows(d: Pick<AppData, "tasks">): DateRow[] {
  const rows: DateRow[] = [];
  for (const t of aliveTasks(d)) {
    if (t.done || t.droppedAt) continue;
    if (t.repeat) rows.push({ task: t, sub: null });
    for (const s of aliveSubtasks(t)) {
      if (s.repeat && !s.done && !s.droppedAt) rows.push({ task: t, sub: s });
    }
  }
  const key = (r: DateRow) => `${rowDue(r) ?? "9999-99-99"}T${rowTime(r) ?? "99:99"}`;
  const name = (r: DateRow) => (r.sub ? `${r.task.title} › ${r.sub.title}` : r.task.title);
  return rows
    .map((r, i) => ({ r, i, k: key(r), n: name(r) }))
    .sort((a, b) => (a.k !== b.k ? (a.k < b.k ? -1 : 1) : a.n.localeCompare(b.n, "zh") || a.i - b.i))
    .map((x) => x.r);
}
