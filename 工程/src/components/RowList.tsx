// 一组任务行怎么摆。今天 / 计划两个视图共用，省得三处各写一遍（以前就是三处，改一处忘两处）。
//
// 干两件事：
// 1. **展开卡落在哪一行**：一件事被拆成好几行时，卡片只能出现一次——母任务行在就落母任务行，
//    母任务行收起了就落它在整个视图里的头一行。
// 2. **子任务链折叠**：收起时一件事**在整个视图里**只占一行「下一步」，行尾标 +N 说明后面还有几条。
//    这两件事都必须**按整个视图算，不能按组算**——子任务各自带日期时会被分到不同的时间段里去，
//    按组算的话「收起」之后这件事仍然一段出现一次，按钮说的「只显示下一步」就是句空话。
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { DateRow, UIState } from "../core/store";
import { isChainFolded, toggleChain, useApp } from "../core/store";
import { cardMs } from "../core/motion";
import { isMobile } from "../core/platform";
import type { PinIds } from "../core/pin";
import { CardSlot } from "./motion";
import MobileRow from "../mobile/MobileRow";
import TaskRow from "./TaskRow";
import TaskCard from "./TaskCard";

export function rowKey(r: DateRow): string {
  return r.sub ? `${r.task.id}/${r.sub.id}` : r.task.id;
}

/** 「这一行是谁、属于哪件事」——喂给 core/pin 的 usePinExpanded。
 *  跟下面 `row:` 那个 React key 用的是同一个 rowKey，两处口径不许分家：
 *  钉位置靠的就是「上一版这个 key 待在哪」，认错了行就等于没钉 */
export const ROW_PIN: PinIds<DateRow> = { key: rowKey, taskId: (r) => r.task.id };

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
  /** 链头行 → 它替多少条没露面的行说话（+N）。**只有收起来的链才有条目** */
  more: Map<string, number>;
  /** 链头行：给它画小三角 */
  head: Set<string>;
  /** 链头行 → 这条链除了它自己还有几条，收着摊着都算。
   *  摊开态那个「−N（点了收起）」要用它——more 只在收起时才有值，摊开时是空的 */
  total: Map<string, number>;
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
  const total = new Map<string, number>();
  for (const [id, n] of count) {
    if (n <= 1) continue; // 就一行，谈不上链
    const headKey = first.get(id)!;
    head.add(headKey);
    total.set(headKey, n - 1);
    if (!isChainFolded(ui, id)) continue;
    more.set(headKey, n - 1);
    for (const r of allRows) {
      if (r.task.id !== id || !r.sub) continue;
      const k = rowKey(r);
      if (k !== headKey) hidden.add(k);
    }
  }
  return { hidden, more, head, total };
}

export interface RowListProps {
  /** 本组的行。**不要**先拿 fold.hidden 过滤——折叠掉的行由这里收成 0 高，
   *  这样「只看下一步」是收进去/放出来的，而不是凭空少几行又多几行（B5）。
   *  视图那边照旧用 visibleRows 判断这一组还剩不剩东西、组标题画不画 */
  rows: DateRow[];
  /** 整个视图算好的折叠方案 */
  fold: FoldPlan;
  /** 展开卡落在哪一行（cardAnchor 的结果） */
  anchor: string | null;
  orderedIds: string[];
  fadeOnDone?: boolean;
  /** 手机端：给这一组的第一行演一次「往右滑」的示意（只有整页最上面那一组该传，见 mobile/MobileRow） */
  hintFirstRow?: boolean;
}

export default function RowList({ rows, fold, anchor, orderedIds, fadeOnDone, hintFirstRow }: RowListProps) {
  // 收起卡片也要有动画（B1）：expandedId 一清空就把卡片从树上摘掉的话，
  // 「收起」永远是硬切。所以让它再活一拍，那一拍里 .shut 把高度收回去。
  // 只有卡片本来就落在这一组的那个 RowList 会留住它，别的组从头到尾没画过卡片。
  // 状态必须在渲染里翻、不能放 useEffect：放那儿卡片已经被卸载了，动画没机会开始
  const owned = anchor && rows.some((r) => rowKey(r) === anchor) ? anchor : null;
  const [prevOwned, setPrevOwned] = useState<string | null>(owned);
  const [closing, setClosing] = useState<string | null>(null);
  if (prevOwned !== owned) {
    setPrevOwned(owned);
    if (owned) setClosing(null);
    else if (prevOwned) setClosing(prevOwned);
  }
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setClosing(null), cardMs());
    return () => clearTimeout(t);
  }, [closing]);

  // ---- 手机端（v1.11.0）：一组一张圆角卡，行换成 MobileRow ----
  // 这里**不画展开卡**：手机上点一行是从底下抽出一张纸（mobile/TaskSheet），
  // 内嵌卡那套（CardSlot / anchor / 钉位置）留给桌面。
  // 折叠掉的行也不再收成 0 高而是直接不画：0 高的行在卡片里会留下一道多余的分隔线，
  // 而「收/放都有动画」是鼠标时代的讲究，手指滑动时那点高度过渡反而黏手。
  // 分支必须排在上面几个 hook 后面——isMobile 是模块常量，但把 return 摆在 hook 前面
  // 迟早会有人在它上面再加一个 hook
  if (isMobile) {
    const shown = rows.filter((r) => !fold.hidden.has(rowKey(r)));
    // 空组不画：不然会剩一个 0 高但有边框的白盒子
    if (shown.length === 0) return null;
    return (
      <div className="mcard">
        {shown.map((r, i) => (
          <MobileRow key={rowKey(r)} task={r.task} sub={r.sub} hint={hintFirstRow && i === 0} />
        ))}
      </div>
    );
  }

  // 手搭一个**平铺**的数组，不用 rows.map 返回数组套数组：嵌套数组会给 key 加一层作用域，
  // 下面那条「卡片按任务 id 认 key」的规矩就白写了
  const out: ReactNode[] = [];
  rows.forEach((r, i) => {
    const key = rowKey(r);
    const bundled = !!r.sub && i > 0 && rows[i - 1].task.id === r.task.id;
    const expanded = anchor === key;
    out.push(
      <TaskRow
        key={`row:${key}`}
        task={r.task}
        sub={r.sub}
        orderedIds={orderedIds}
        bundled={bundled}
        fadeOnDone={fadeOnDone}
        // 摊成卡片了、或者被「只看下一步」收起来了，都只是收成 0 高，不下树
        collapsed={expanded || fold.hidden.has(key)}
        chain={
          fold.head.has(key)
            ? {
                folded: fold.more.has(key),
                more: fold.more.get(key) ?? 0,
                // 摊开态的「−N」得知道这条链一共有几条：more 那份收起来才有值
                total: fold.total.get(key) ?? 0,
                onToggle: () => toggleChain(r.task.id),
              }
            : undefined
        }
      />,
    );
    // 展开的卡片按**任务 id** 认领 key，不跟着行 key 走：在卡里勾掉一条子任务，
    // openRows 会把那行剔出去、anchor 顺势落到下一条子任务行上，行 key 一变整张卡就被卸载重建——
    // 已完成子任务的折叠开关、「＋子任务」草稿、「整句改」草稿会一起被清空
    // （表现成「我展开已完成，勾一下，它自己又收回去了」）。
    // 行的 key 加了 `row:` 前缀正是为了跟它岔开：母任务行的 rowKey 就等于任务 id，会撞
    if (expanded || key === closing) {
      out.push(
        <CardSlot key={`card:${r.task.id}`} shut={!expanded}>
          <TaskCard task={r.task} />
        </CardSlot>,
      );
    }
  });
  return <>{out}</>;
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
