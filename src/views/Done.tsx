// 已完成：做完的事都在这儿（原来叫「日志」，2026-08-28 改名并搬到侧栏常驻位）。
//
// 为什么改：一件事勾掉之后它就从今天/计划里消失，而「日志」当时收在「更多」里面，
// 用户的原话是「我做完了一个任务，怎么直接消失了」——东西没丢，是找不着。
// 所以：换成人话（已完成）、放到侧栏能一眼看见的地方、按时间分段、把重要性和完成日期摆出来。
//
// 2026-08-31 起按**行**列，不再按任务列：做完的子任务各占一行（显示成「母 › 子」），
// 母任务勾掉了也占一行。用户原话「已完成按照子任务来排列」——一件事分几步做完，
// 就该看得见是分几天做完的，而不是只在收尾那天冒出一条。
import { Fragment, useMemo, useState } from "react";
import { todayYMD } from "../core/dates";
import { doneGroups } from "../core/plan";
import type { DateRow } from "../core/store";
import { doneRows, rowDoneAt, rowDoneDay, rowDoneGuessed, rowTaskIds, useApp } from "../core/store";
import { cardAnchor, rowKey } from "../components/RowList";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";

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
}

export default function Done() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const today = todayYMD();
  const [showAllOld, setShowAllOld] = useState(false);

  const { groups, total, taskCount } = useMemo(() => {
    // 归日和排序都只走 store 的 rowDoneDay / rowDoneAt：老子任务没有自己的完成时刻会
    // 回落到母任务，而且那里已经把 UTC ISO 转成本地日期了（本地 0-8 点做完的不能归到昨天）。
    // 日历的已完成桶用的是同两个函数——口径一旦分家，同一件事会在两个页面落在不同的日子
    const items: DoneItem[] = doneRows(data)
      .map((r) => ({ row: r, day: rowDoneDay(r), at: rowDoneAt(r), guessed: rowDoneGuessed(r) }))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
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
  }, [data, today, showAllOld]);

  // 连选按「件」不按「行」（跟计划视图一个口径）。只数**这一轮真画出来的**行：
  // 「更早」还没全展开时，没露面的行不能混进连选序列，否则 shift 连选会错位
  const shown = groups.flatMap((g) => g.shown);
  const orderedIds = rowTaskIds(shown.map((x) => x.row));
  // 一件事占好几行时，展开卡只能出现一次——落点整页算一次，各组照着认领
  const anchor = cardAnchor(shown.map((x) => x.row), expandedId);

  const renderRow = (x: DoneItem, i: number, arr: DoneItem[]) => {
    const key = rowKey(x.row);
    if (anchor === key) {
      return (
        <Fragment key={x.row.task.id}>
          <TaskCard task={x.row.task} />
        </Fragment>
      );
    }
    // 紧挨着的同一件事：需求方/清单只由头一行交代，不逐行重复
    const bundled = !!x.row.sub && i > 0 && arr[i - 1].row.task.id === x.row.task.id;
    return (
      <Fragment key={key}>
        <TaskRow
          task={x.row.task}
          sub={x.row.sub}
          orderedIds={orderedIds}
          bundled={bundled}
          fadeOnDone={false}
          doneDate={x.guessed ? null : x.day}
        />
      </Fragment>
    );
  };

  return (
    <section className="main">
      <div className="view-head">
        <h1>已完成</h1>
        <span className="sub">
          {total} 条
          {total !== taskCount && ` · ${taskCount} 件事`}
          {" · 点圆圈可以放回未完成"}
        </span>
      </div>
      <div className="view-body">
        {groups.map((g) => (
          <Fragment key={g.key}>
            {g.items.length > 0 && (
              <div className="group-head">
                {g.label} {g.items.length}
              </div>
            )}
            {g.shown.map(renderRow)}
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
          <div className="empty">还没有完成记录。</div>
        )}
      </div>
    </section>
  );
}
