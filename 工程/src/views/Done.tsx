// 已完成：做完的事都在这儿（原来叫「日志」，2026-08-28 改名并搬到侧栏常驻位）。
//
// 为什么改：一件事勾掉之后它就从今天/计划里消失，而「日志」当时收在「更多」里面，
// 用户的原话是「我做完了一个任务，怎么直接消失了」——东西没丢，是找不着。
// 所以：换成人话（已完成）、放到侧栏能一眼看见的地方、按时间分段、把重要性和完成日期摆出来。
//
// 2026-08-31 起按**行**列，不再按任务列：做完的子任务各占一行（显示成「母 › 子」），
// 母任务勾掉了也占一行。用户原话「已完成按照子任务来排列」——一件事分几步做完，
// 就该看得见是分几天做完的，而不是只在收尾那天冒出一条。
//
// 2026-09-01 起这里也是「放弃」的归宿：顶上一个三选一（做完的 / 放弃的 / 全部），默认「做完的」。
// **不新开侧栏项**——放弃跟完成一样是「这件事收场了」，收场的东西住同一个屋子，
// 只是进门时分一下是做成的还是不做了。
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { todayYMD } from "../core/dates";
import { cardMs } from "../core/motion";
import { doneGroups } from "../core/plan";
import type { DateRow } from "../core/store";
import {
  doneRows, droppedRows, rowDoneAt, rowDoneDay, rowDoneGuessed,
  rowDroppedAt, rowDroppedDay, rowTaskIds, useApp,
} from "../core/store";
import type { PinIds } from "../core/pin";
import { usePinExpanded } from "../core/pin";
import { hasDesktopFeatures } from "../core/platform";
import { cardAnchor, rowKey } from "../components/RowList";
import { CardSlot } from "../components/motion";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";
import "../styles/plan.css";

/** 「更早」一上来只画这么多——一次画几千行会卡。**不是上限**：下面有按钮能全展开，
 *  绝不能出现「标题说有 350 件、页面只有 300 行、剩下的在 App 里彻底够不着」那种事 */
const OLD_PAGE = 300;

/** 一条「已完成」条目：行 + 它归到哪天 + 精确到哪一刻（排序用）。
 *  guessed = 这个日子是猜的（老子任务没有完成时刻，母任务也没完成）——
 *  这类条目照样列出来，但不写「完成 X月X日」，也不参与按天分组 */
interface DoneItem {
  row: DateRow;
  day: string;
  at: string;
  guessed: boolean;
  /** 这条是放弃的（不是做完的）。分组、排序两边一视同仁，只有文案和筛选认它 */
  dropped: boolean;
}

/** 「这一条是谁、属于哪件事」——喂给 core/pin 的 usePinExpanded。
 *  key 跟下面那个 `row:` 的 React key 同源（都走 rowKey），认的是同一条行 */
const DONE_PIN: PinIds<DoneItem> = { key: (x) => rowKey(x.row), taskId: (x) => x.row.task.id };

/** 顶上那个三选一。默认「做完的」——这个视图的主业还是完成记录，放弃的是来投奔的。
 *  控件和存法都照抄日历那个筛子（同款 .all-sort 分段控件，选择存 localStorage） */
const FILTERS = [
  { id: "done", name: "做完的" },
  { id: "dropped", name: "放弃的" },
  { id: "all", name: "全部" },
] as const;
type DoneFilter = (typeof FILTERS)[number]["id"];
const FILTER_KEY = "acorn-done-filter";

function loadFilter(): DoneFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === "dropped" || v === "all" ? v : "done";
  } catch {
    return "done";
  }
}

export default function Done() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const today = todayYMD();
  const [showAllOld, setShowAllOld] = useState(false);
  const [filter, setFilter] = useState<DoneFilter>(loadFilter);
  const pickFilter = (f: DoneFilter) => {
    setFilter(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* 存不了就这次会话记得 */
    }
  };

  const { groups, total, taskCount } = useMemo(() => {
    // 归日和排序都只走 store 的 rowDoneDay / rowDoneAt：老子任务没有自己的完成时刻会
    // 回落到母任务，而且那里已经把 UTC ISO 转成本地日期了（本地 0-8 点做完的不能归到昨天）。
    // 日历的已完成桶用的是同两个函数——口径一旦分家，同一件事会在两个页面落在不同的日子
    // 放弃的按**放弃那一刻**归日排（走 rowDroppedDay，跟完成那边同一套本地时区口径），
    // 而且不存在「猜的」那一档：droppedAt 是这版才有的字段，有标记就必定带着时刻
    const items: DoneItem[] = [];
    if (filter !== "dropped") {
      for (const r of doneRows(data)) {
        items.push({ row: r, day: rowDoneDay(r), at: rowDoneAt(r), guessed: rowDoneGuessed(r), dropped: false });
      }
    }
    if (filter !== "done") {
      for (const r of droppedRows(data)) {
        items.push({ row: r, day: rowDroppedDay(r), at: rowDroppedAt(r), guessed: false, dropped: true });
      }
    }
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    // 日子是猜出来的那些不按天分组——按母任务的创建日归档等于编一个完成日，
    // 一堆几个月前才建的老事会假装是那天做完的。它们统一沉到最后一组（「更早」）的尾部：
    // 不显示用户会以为东西不见了，显示就得老实说不知道是哪天（doneDate 传 null）
    const dated = items.filter((x) => !x.guessed);
    const guessed = items.filter((x) => x.guessed);
    const raw = doneGroups(dated, (x) => x.day, today);
    const merged = raw.map((g, i) =>
      i === raw.length - 1 ? { ...g, items: [...g.items, ...guessed] } : g,
    );
    const gs = merged.map((g) =>
      g.key === "old" && !showAllOld
        ? { ...g, shown: g.items.slice(0, OLD_PAGE), rest: Math.max(0, g.items.length - OLD_PAGE) }
        : { ...g, shown: g.items, rest: 0 },
    );
    return { groups: gs, total: items.length, taskCount: rowTaskIds(items.map((x) => x.row)).length };
  }, [data, today, showAllOld, filter]);

  // 展开着的那件事钉在上一版的位置上（core/pin.ts）：在卡里勾掉一条子任务，
  // 那条新完成记录会插到最新那一组的最前面、把卡片的落点从原来那一组抢走，
  // 整张卡跟着卸载重挂——已完成子任务的折叠状态、几个草稿全清空。收起之后照常重排。
  // 钉的是**这一轮真画出来的**那份（shown），不是整组：「更早」还没全展开时
  // 没露面的行本来就不参与画面
  const laid = groups.map((g) => ({ ...g, rows: g.shown }));
  const pinned = usePinExpanded(laid, expandedId, DONE_PIN);
  // 连选按「件」不按「行」（跟计划视图一个口径）。只数**这一轮真画出来的**行：
  // 「更早」还没全展开时，没露面的行不能混进连选序列，否则 shift 连选会错位
  const shown = pinned.flatMap((g) => g.rows);
  const orderedIds = rowTaskIds(shown.map((x) => x.row));
  // 一件事占好几行时，展开卡只能出现一次——落点整页算一次，各组照着认领
  const anchor = cardAnchor(shown.map((x) => x.row), expandedId);

  // 收起卡片也要有动画（B1）。v1.9.1 之前这个视图是**直接拿 TaskCard 顶掉那一行**——
  // 点开是硬切、那一行整个消失，跟今天/清单/计划三处的做法都不一样。
  // 现在跟 RowList 同一个口径：行和卡同时挂着，一个收成 0 高另一个长出来，
  // 卡片从 anchor 上撤走之后再多活一拍，那一拍里 .shut 把高度收回去。
  // 状态得在渲染里翻、不能放 useEffect：放那儿卡片已经被卸载了，动画没机会开始
  const [prevAnchor, setPrevAnchor] = useState<string | null>(anchor);
  const [closing, setClosing] = useState<string | null>(null);
  if (prevAnchor !== anchor) {
    setPrevAnchor(anchor);
    if (anchor) setClosing(null);
    else if (prevAnchor) setClosing(prevAnchor);
  }
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setClosing(null), cardMs());
    return () => clearTimeout(t);
  }, [closing]);

  // 返回的是**一个平铺数组**（下面用 flatMap 摊开），不是一个 Fragment 套两件东西：
  // 包一层 Fragment 的话卡片的 key 会活在行 key 的作用域里，
  // 「卡片按任务 id 认 key」那条规矩当场失效——在卡里勾一条子任务，行没了、
  // anchor 落到下一行，整张卡会被卸载重建（草稿、折叠状态全清空）
  const renderRow = (x: DoneItem, i: number, arr: DoneItem[]): ReactNode[] => {
    const key = rowKey(x.row);
    const expanded = anchor === key;
    // 紧挨着的同一件事：需求方/清单只由头一行交代，不逐行重复
    const bundled = !!x.row.sub && i > 0 && arr[i - 1].row.task.id === x.row.task.id;
    const out: ReactNode[] = [
      <TaskRow
        key={`row:${key}`}
        task={x.row.task}
        sub={x.row.sub}
        orderedIds={orderedIds}
        bundled={bundled}
        fadeOnDone={false}
        doneDate={x.guessed ? null : x.day}
        // 右边只留一格「完成于 X」：这个视图里截止日期已经没有意义了，
        // 归类/@/标签/进度/循环/顺延展开卡片自然看得到
        tail="date"
        collapsed={expanded}
      />,
    ];
    // 一件事在这个视图里可能占好几行（母 + 各个子任务），但 anchor 整页只认一行，
    // 所以这里照样只会画出一张卡
    if (expanded || key === closing) {
      out.push(
        <CardSlot key={`card:${x.row.task.id}`} shut={!expanded}>
          <TaskCard task={x.row.task} />
        </CardSlot>,
      );
    }
    return out;
  };

  return (
    <section className="main">
      <div className="view-head">
        <h1>已完成</h1>
        <span className="sub">
          {total} 条
          {total !== taskCount && ` · ${taskCount} 件事`}
          {/* 提示语跟圈圈的实际行为对齐：做完的点圆圈 = 标记未完成，
              放弃的点圆圈 = 取消放弃放回未完成（见 TaskRow.onCheck），两种都是「放回未完成」 */}
          {/* 手机上没有右键（长按也只是同一份菜单的另一条路），这句话按平台分叉，
              别给手机用户指一个他做不到的操作 */}
          {filter === "dropped"
            ? ` · 点圆圈${hasDesktopFeatures ? "或右键" : ""}可以取消放弃`
            : " · 点圆圈可以放回未完成"}
        </span>
        <span className="spacer" />
        <div className="all-sort">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? "on" : undefined}
              onClick={() => pickFilter(f.id)}
            >
              {f.name}
            </button>
          ))}
        </div>
      </div>
      <div className="view-body">
        {pinned.map((g) => (
          <Fragment key={g.key}>
            {g.items.length > 0 && (
              <div className="group-head">
                {g.label} {g.items.length}
              </div>
            )}
            {g.rows.flatMap(renderRow)}
            {g.rest > 0 && (
              <button className="done-more" onClick={() => setShowAllOld(true)}>
                {/* g.rest 数的是 DoneItem（行），不是任务件数——跟顶上「N 条 · M 件事」
                    同一套口径，这里只能说「条」 */}
                展开更早的 {g.rest} 条
              </button>
            )}
          </Fragment>
        ))}
        {total === 0 && (
          <div className="empty">
            {filter === "dropped" ? "还没有放弃过什么。" : "还没有完成记录。"}
          </div>
        )}
      </div>
    </section>
  );
}
