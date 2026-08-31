// 一组任务行怎么摆。今天 / 计划两个视图共用，省得三处各写一遍（以前就是三处，改一处忘两处）。
//
// 干两件事：
// 1. **展开卡落在哪一行**：一件事被拆成好几行时，卡片只能出现一次——母任务行在就落母任务行，
//    母任务行收起了就落它在整个视图里的头一行。
// 2. **子任务链折叠**：收起时一件事**在整个视图里**只占一行「下一步」，行尾标 +N 说明后面还有几条。
//    这两件事都必须**按整个视图算，不能按组算**——子任务各自带日期时会被分到不同的时间段里去，
//    按组算的话「收起」之后这件事仍然一段出现一次，按钮说的「只显示下一步」就是句空话。
import { Fragment } from "react";
import type { DateRow, UIState } from "../core/store";
import { isChainFolded, toggleChain, useApp } from "../core/store";
import TaskRow from "./TaskRow";
import TaskCard from "./TaskCard";

export function rowKey(r: DateRow): string {
  return r.sub ? `${r.task.id}/${r.sub.id}` : r.task.id;
}

/** 展开卡该落在哪一行（整个视图算一次，各组照着认领，保证只画一张） */
export function cardAnchor(allRows: DateRow[], expandedId: string | null): string | null {
  if (!expandedId) return null;
  const mother = allRows.find((r) => r.task.id === expandedId && !r.sub);
  if (mother) return rowKey(mother);
  const first = allRows.find((r) => r.task.id === expandedId);
  return first ? rowKey(first) : null;
}

export interface FoldPlan {
  /** 被折叠掉、这一轮不该出现的行 */
  hidden: Set<string>;
  /** 链头行 → 它替多少条没露面的行说话（+N） */
  more: Map<string, number>;
  /** 链头行：给它画小三角 */
  head: Set<string>;
}

/** 整个视图算一次折叠。传进来的必须是**全部**行（跨组），不是某一组 */
export function planFold(allRows: DateRow[], ui: UIState): FoldPlan {
  const count = new Map<string, number>();
  const first = new Map<string, string>();
  for (const r of allRows) {
    if (!r.sub) continue;
    const id = r.task.id;
    count.set(id, (count.get(id) ?? 0) + 1);
    if (!first.has(id)) first.set(id, rowKey(r));
  }
  const hidden = new Set<string>();
  const more = new Map<string, number>();
  const head = new Set<string>();
  for (const [id, n] of count) {
    if (n <= 1) continue; // 就一行，谈不上链
    const headKey = first.get(id)!;
    head.add(headKey);
    if (!isChainFolded(ui, id)) continue;
    more.set(headKey, n - 1);
    for (const r of allRows) {
      if (r.task.id !== id || !r.sub) continue;
      const k = rowKey(r);
      if (k !== headKey) hidden.add(k);
    }
  }
  return { hidden, more, head };
}

export interface RowListProps {
  /** 本组要显示的行（**已经**用 fold.hidden 过滤过了） */
  rows: DateRow[];
  /** 整个视图算好的折叠方案 */
  fold: FoldPlan;
  /** 展开卡落在哪一行（cardAnchor 的结果） */
  anchor: string | null;
  orderedIds: string[];
  fadeOnDone?: boolean;
}

export default function RowList({ rows, fold, anchor, orderedIds, fadeOnDone }: RowListProps) {
  return (
    <>
      {rows.map((r, i) => {
        const key = rowKey(r);
        const bundled = !!r.sub && i > 0 && rows[i - 1].task.id === r.task.id;
        // 展开的卡片按**任务 id** 认领 key，不跟着行 key 走：在卡里勾掉一条子任务，
        // openRows 会把那行剔出去、anchor 顺势落到下一条子任务行上，行 key 一变整张卡就被卸载重建——
        // 已完成子任务的折叠开关、「＋子任务」草稿、「整句改」草稿会一起被清空
        // （表现成「我展开已完成，勾一下，它自己又收回去了」）。
        // cardAnchor 保证全视图只有一行认领这张卡，且有子任务行时不会同时有母任务行，key 不会撞
        if (anchor === key) {
          return (
            <Fragment key={r.task.id}>
              <TaskCard task={r.task} />
            </Fragment>
          );
        }
        return (
          <Fragment key={key}>
            <TaskRow
              task={r.task}
              sub={r.sub}
              orderedIds={orderedIds}
              bundled={bundled}
              fadeOnDone={fadeOnDone}
              chain={
                fold.head.has(key)
                  ? {
                      folded: fold.more.has(key),
                      more: fold.more.get(key) ?? 0,
                      onToggle: () => toggleChain(r.task.id),
                    }
                  : undefined
              }
            />
          </Fragment>
        );
      })}
    </>
  );
}

/** 用折叠方案过掉一组里该藏起来的行。视图拿它决定「这一组还剩东西吗、组标题要不要画」 */
export function visibleRows(rows: DateRow[], fold: FoldPlan): DateRow[] {
  return fold.hidden.size === 0 ? rows : rows.filter((r) => !fold.hidden.has(rowKey(r)));
}

/** 免得每个视图都 import useApp 再取一次 */
export function useFoldPlan(allRows: DateRow[]): FoldPlan {
  const ui = useApp((s) => s.ui);
  return planFold(allRows, ui);
}
