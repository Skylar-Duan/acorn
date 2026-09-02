// 展开着的那张卡，位置不许被它自己的改动挪走。
//
// 用户原话（2026-09-02）：「主任务时间点在后面比如两个月后，子任务时间点在前面比如今天，
// 添加后卡片会自动收缩而不能连贯输入。希望后台的卡片顺序调整不影响到前台卡片展开和继续输入的状态。」
//
// 病根是三条规矩叠在一起：
//   ① openRows：一件事只要有没做完的子任务，母任务行就撤掉，改成一行一个子任务；
//   ② 分组按**行的日期**算，所以那条今天到期的子任务行落进「今天」，跟母任务原来待的组隔着老远；
//   ③ 卡片是挂在**它那一行下面**画的，每一组各自一个 RowList。
// 于是在卡里加一条今天到期的子任务，卡片当场换了个 React 父节点 —— 整张卡卸载重挂：
// 输入框的焦点、「＋子任务」草稿、「整句改」草稿、已完成子任务的折叠状态全没了。
// 用户看到的就是「卡片自己收回去了，没法接着往下打」。
//
// 办法：**展开期间把这件事的行钉在原位**。这里只重排，不改数据、不改行的内容：
//   · 上一版就有的行 → 还搁在上一版那个位置（哪怕它的日期已经不该在那一组了）
//   · 这一版新冒出来的行 → 插到卡片那一行旁边，也就是「卡下面」
//   · 卡片那一行整个没了（母任务行被子任务行顶掉、或者头一条子任务被删了）→
//     让接替它的那一行搬到它的位置来，否则卡片会跟着接替者跑到别的组去
// 卡片一收起就全松开，该去哪去哪 —— 还要多钉一拍等收起动画演完（见 usePinExpanded）。
//
// 为什么记「前邻居列表」而不是下标：别的事同时也在增减行，下标一到下一版就不作数了。

import { useEffect, useRef, useState } from "react";
import { cardMs } from "./motion";

/** 视图里的一个分段。**只认 key 和 rows 两个字段**，label / warn 这些原样带过去 */
export interface PinGroup<T> {
  key: string;
  rows: T[];
}

/** 怎么从一行里认出「它是谁」「它属于哪件事」。各视图的行长得不一样，这两下由视图给 */
export interface PinIds<T> {
  /** 行的唯一 key（同一件事的不同行也必须不同，跟 React key 同一个口径） */
  key: (row: T) => string;
  /** 这一行属于哪件事 */
  taskId: (row: T) => string;
}

/** 一个「位置」：在哪一组、前面依次是哪些行 */
interface Spot {
  group: string;
  before: string[];
}

/** 上一版里这件事的每一行都待在哪，外加「头一行是谁」——卡片就挂在头一行上
 *  （cardAnchor 的口径：母任务行在就落母任务行；而 openRows 里母任务行和子任务行
 *   本来就是二选一，所以「头一行」跟它等价） */
function spotsOf<T>(groups: readonly PinGroup<T>[], taskId: string, ids: PinIds<T>) {
  const spots = new Map<string, Spot>();
  let card: string | null = null;
  for (const g of groups) {
    const before: string[] = [];
    for (const row of g.rows) {
      const k = ids.key(row);
      if (ids.taskId(row) === taskId) {
        spots.set(k, { group: g.key, before: [...before] });
        if (card === null) card = k;
      }
      before.push(k);
    }
  }
  return { spots, card };
}

/** 这一行该插在第几个位置：从最近的前邻居往回找，头一个还在的那位后面就是它的位置。
 *  一个都不剩就回到组首——比塞到组尾好，至少还在原来那一带 */
function insertAt(before: readonly string[], pos: Map<string, number>): number {
  for (let i = before.length - 1; i >= 0; i--) {
    const p = pos.get(before[i]);
    if (p !== undefined) return p + 1;
  }
  return 0;
}

/**
 * 把 expandedId 这件事的行按上一版的位置摆回去。纯函数：不读 store，不改任何行的内容。
 *
 * @param next  这一版算好的分组
 * @param prev  上一版**真画出去的**那一份（也就是上一次本函数的返回值）
 * @param pool  兜底行池：这件事在 next 里一行都不剩时（比如日期改到了这个视图管不着的日子）
 *              从这儿把它的行捞回来。不给就意味着「真没了就让它没」
 */
export function pinExpanded<T, G extends PinGroup<T>>(
  next: G[],
  prev: G[] | null,
  expandedId: string | null,
  ids: PinIds<T>,
  pool: readonly T[] = [],
): G[] {
  if (!expandedId || !prev) return next;
  const { spots, card: cardKey } = spotsOf(prev, expandedId, ids);
  // 上一版这件事根本不在页面上（刚从别的视图切过来、或者搜索刚把它筛出来）：没有「原位」可言
  if (cardKey === null) return next;
  const cardSpot = spots.get(cardKey)!;

  const mine: T[] = [];
  for (const g of next) for (const row of g.rows) if (ids.taskId(row) === expandedId) mine.push(row);
  const rows = mine.length > 0 ? mine : pool.filter((row) => ids.taskId(row) === expandedId);
  // 这件事是真没了（删掉了 / 勾完了）——那就让它没，别硬留一个空壳在那儿
  if (rows.length === 0) return next;

  const known = new Set(next.map((g) => g.key));
  // 分组本身换了一套（切了排序口径之类），上一版的位置对不上号，不硬凑
  if (!known.has(cardSpot.group)) return next;

  // 卡片原来那一行还在不在。不在就让这一版的头一行顶上它的位置——
  // 「母任务行被第一条子任务顶掉」正是用户报的那个场景
  const cardGone = !rows.some((row) => ids.key(row) === cardKey);
  const plan = rows.map((row, i) => {
    const own = cardGone && i === 0 ? undefined : spots.get(ids.key(row));
    const spot = own ?? cardSpot;
    return { row, spot: known.has(spot.group) ? spot : cardSpot };
  });

  // 先把这件事的行从各组摘干净，再统一插回去：几行同时挪动时互不干扰
  const out = next.map((g) => ({ ...g, rows: g.rows.filter((row) => ids.taskId(row) !== expandedId) }) as G);
  for (const g of out) {
    const here = plan.filter((p) => p.spot.group === g.key);
    if (here.length === 0) continue;
    // 下标一律按「已经摘掉这件事的那一份」算，插完彼此的先后还是 plan 里的先后
    const pos = new Map(g.rows.map((row, i) => [ids.key(row), i]));
    const marks = here.map((p) => ({ at: insertAt(p.spot.before, pos), row: p.row }));
    const rebuilt: T[] = [];
    for (let i = 0; i <= g.rows.length; i++) {
      for (const m of marks) if (m.at === i) rebuilt.push(m.row);
      if (i < g.rows.length) rebuilt.push(g.rows[i]);
    }
    g.rows = rebuilt;
  }
  return out;
}

/**
 * 视图里这么用：这一版分组进去，出来的是「展开期间钉住了的」那一版。
 *
 * 上一版记在 ref 里，而且**只在提交之后才写**：渲染里读到的永远是真画出去的那一份，
 * 中途被打断、被 StrictMode 重跑一遍的那些渲染不算数。
 */
export function usePinExpanded<T, G extends PinGroup<T>>(
  groups: G[],
  expandedId: string | null,
  ids: PinIds<T>,
  pool: readonly T[] = [],
): G[] {
  // 收起之后还要再钉一拍。用户原话是「分组重排等卡片收起之后再发生」——
  // 而且卡片本来就要在树上多活一拍把收起动画演完（RowList 那个 closing），
  // 这会儿要是行已经跑了，那张正在收的卡会连着它那一行凭空消失，收起就成了硬切
  const [held, setHeld] = useState<string | null>(expandedId);
  if (expandedId !== null && held !== expandedId) setHeld(expandedId);
  useEffect(() => {
    if (expandedId !== null || held === null) return;
    const t = setTimeout(() => setHeld(null), cardMs());
    return () => clearTimeout(t);
  }, [expandedId, held]);

  const prev = useRef<G[] | null>(null);
  const out = pinExpanded(groups, prev.current, held, ids, pool);
  useEffect(() => {
    prev.current = out;
  });
  return out;
}
