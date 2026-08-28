// 已完成：做完的事都在这儿（原来叫「日志」，2026-08-28 改名并搬到侧栏常驻位）。
//
// 为什么改：一件事勾掉之后它就从今天/计划里消失，而「日志」当时收在「更多」里面，
// 用户的原话是「我做完了一个任务，怎么直接消失了」——东西没丢，是找不着。
// 所以：换成人话（已完成）、放到侧栏能一眼看见的地方、按时间分段、把重要性和完成日期摆出来。
import { Fragment, useMemo, useState } from "react";
import type { Task } from "../core/model";
import { todayYMD, toYMD } from "../core/dates";
import { doneGroups } from "../core/plan";
import { aliveTasks, useApp } from "../core/store";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";

/** 「更早」一上来只画这么多——一次画几千行会卡。**不是上限**：下面有按钮能全展开，
 *  绝不能出现「标题说有 350 件、页面只有 300 行、剩下的在 App 里彻底够不着」那种事 */
const OLD_PAGE = 300;

export default function Done() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const today = todayYMD();
  const [showAllOld, setShowAllOld] = useState(false);

  const { groups, total } = useMemo(() => {
    const done = aliveTasks(data)
      .filter((t) => t.done)
      // doneAt 是 UTC ISO，必须转回本地日期再归日，否则本地 0-8 点完成的会归到昨天。
      // 没有 doneAt 的（老数据 / 别处导进来的）拿创建日顶上——宁可归错一档，
      // 也不能让它在全应用任何视图里都不存在
      .map((t) => ({ task: t, day: toYMD(new Date(t.doneAt ?? t.createdAt)) }))
      .sort((a, b) => ((a.task.doneAt ?? a.task.createdAt) < (b.task.doneAt ?? b.task.createdAt) ? 1 : -1));
    const gs = doneGroups(done, (x) => x.day, today).map((g) =>
      g.key === "old" && !showAllOld
        ? { ...g, shown: g.items.slice(0, OLD_PAGE), rest: Math.max(0, g.items.length - OLD_PAGE) }
        : { ...g, shown: g.items, rest: 0 },
    );
    return { groups: gs, total: done.length };
  }, [data, today, showAllOld]);

  const orderedIds = groups.flatMap((g) => g.shown.map((x) => x.task.id));

  const renderRow = (x: { task: Task; day: string }) => (
    <Fragment key={x.task.id}>
      {expandedId === x.task.id ? (
        <TaskCard task={x.task} />
      ) : (
        <TaskRow task={x.task} orderedIds={orderedIds} fadeOnDone={false} doneDate={x.day} />
      )}
    </Fragment>
  );

  return (
    <section className="main">
      <div className="view-head">
        <h1>已完成</h1>
        <span className="sub">{total} 件 · 勾掉的事都收在这里，点圆圈可以放回去</span>
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
                还有 {g.rest} 件更早的，全部展开
              </button>
            )}
          </Fragment>
        ))}
        {total === 0 && (
          <div className="empty">
            <span className="glyph">🍂</span>
            还没有完成记录
          </div>
        )}
      </div>
    </section>
  );
}
