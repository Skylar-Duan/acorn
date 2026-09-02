// 今天：主战场。逾期置顶，可一键全部顺延；底部当日小结。
// 行来自 DateRow：母任务 + 带自己日期的子任务（「母 › 子」形式）。
import { formatCN, todayYMD } from "../core/dates";
import { openRows, postponeRows, rowTaskIds, sortRows, tasksForToday, useApp } from "../core/store";
import { FOCUS_ENABLED } from "../core/features";
import { usePinExpanded } from "../core/pin";
import { RowCard } from "../components/motion";
import RowList, { ROW_PIN, cardAnchor, useFoldPlan, visibleRows } from "../components/RowList";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";

export default function Today() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const sessions = data.sessions;
  const today = todayYMD();

  const { overdue, todays, doneToday } = tasksForToday(data, today);
  // 展开着的那件事钉在上一版的位置上（core/pin.ts）：在卡里加一条明天到期的子任务、
  // 或者顺手把日期改到下周，这件事的行会整个退出这个视图，卡片当场没了没法接着输入。
  // 所以兜底行池给的是**整份** openRows——光靠下面这两组是捞不回来的
  const pinPool = expandedId
    ? sortRows(openRows(data).filter((r) => r.task.id === expandedId), data.settings.sortMode)
    : [];
  const pinned = usePinExpanded(
    [{ key: "overdue", rows: overdue }, { key: "today", rows: todays }],
    expandedId,
    ROW_PIN,
    pinPool,
  );
  const overdueShown = pinned[0].rows;
  const todayShown = pinned[1].rows;
  const allRows = [...overdueShown, ...todayShown];
  const orderedIds = rowTaskIds(allRows);
  // 折叠整页算一次（跟「计划」同一套口径），否则逾期区和今天区会各收一遍
  const fold = useFoldPlan(allRows);
  const anchor = cardAnchor(allRows, expandedId);
  // 这两个只用来判断「这一组还剩东西吗、组标题画不画」。
  // 真正交给 RowList 的是**没过滤过**的那份：折叠掉的行由它收成 0 高，收/放才都有动画（B5）
  const overdueRows = visibleRows(overdueShown, fold);
  const todayRows = visibleRows(todayShown, fold);
  const focusMin = sessions.filter((s) => s.date === today).reduce((a, b) => a + b.minutes, 0);
  // 底部进度按「件」算不按「行」算：一件事拆成 3 个子任务时，做掉 1 个不该让分母也跟着缩水
  const total = rowTaskIds(todays).length + doneToday.length;
  const doneRatio = total === 0 ? 0 : doneToday.length / total;


  return (
    <section className="main">
      <div className="view-head">
        <h1>今天</h1>
        <span className="sub">{formatCN(today)}</span>
      </div>
      <div className="view-body">
        {overdueRows.length > 0 && (
          <>
            <div className="group-head warn">
              逾期 {overdue.length}
              <button className="act" onClick={() => postponeRows(overdue)}>
                全部推到明天 →
              </button>
            </div>
            <RowList rows={overdueShown} fold={fold} anchor={anchor} orderedIds={orderedIds} />
          </>
        )}
        {todayRows.length > 0 && <div className="group-head">今天</div>}
        <RowList rows={todayShown} fold={fold} anchor={anchor} orderedIds={orderedIds} />
        {doneToday.length > 0 && <div className="group-head">已完成 {doneToday.length}</div>}
        {doneToday.map((t) => (
          <RowCard
            key={t.id}
            open={expandedId === t.id}
            row={(collapsed) => (
              // doneToday 里的每一件都是**今天**做完的（tasksForToday 就是这么筛的），
              // 所以完成日直接就是 today。以前这儿没传 doneDate，右边写的还是截止日期——
              // 同一件事在这儿写「今天 15:30」、切到「已完成」写「完成于 今天」，两个口径。
              // 现在统一成「完成于 X」，也跟着走 tail="date" 那条只留一格日期的规矩
              <TaskRow
                task={t}
                orderedIds={orderedIds}
                fadeOnDone={false}
                collapsed={collapsed}
                doneDate={today}
                tail="date"
              />
            )}
            card={() => <TaskCard task={t} />}
          />
        ))}
        {/* 按**这一版真画出来的行**算，不按 overdue/todays 算：展开期间钉在这儿的那一件
            已经不属于这两组了，照旧数它俩的话会出现「卡片摆在页面上，底下写着今天没有安排」 */}
        {allRows.length === 0 && doneToday.length === 0 && (
          <div className="empty">今天没有安排。</div>
        )}
      </div>
      <div className="day-foot">
        <span
          className="ring"
          style={{
            background: `conic-gradient(var(--ok) 0 ${Math.round(doneRatio * 360)}deg, var(--hair) ${Math.round(doneRatio * 360)}deg 360deg)`,
          }}
        />
        <span>
          完成 {doneToday.length} / {total}
        </span>
        {FOCUS_ENABLED && focusMin > 0 && <span>🍅 专注 {focusMin} 分钟</span>}
        <span className="kbd-hint">
          <kbd>Ctrl K</kbd> 命令面板 · <kbd>Ctrl F</kbd> 搜索 · <kbd>Ctrl Z</kbd> 撤销
        </span>
      </div>
    </section>
  );
}
