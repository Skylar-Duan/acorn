// 今天：主战场。逾期置顶，可一键全部顺延；底部当日小结。
import { Fragment } from "react";
import { formatCN, todayYMD } from "../core/dates";
import {
  postponeTasks, tasksForToday, useApp,
} from "../core/store";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";
import QuickAddBar from "../components/QuickAddBar";

export default function Today() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const sessions = data.sessions;
  const today = todayYMD();

  const { overdue, todays, doneToday } = tasksForToday(data, today);
  const orderedIds = [...overdue, ...todays, ...doneToday].map((t) => t.id);
  const focusMin = sessions.filter((s) => s.date === today).reduce((a, b) => a + b.minutes, 0);
  const total = todays.length + doneToday.length;
  const doneRatio = total === 0 ? 0 : doneToday.length / total;

  const renderRow = (t: (typeof todays)[number], fade = true) => (
    <Fragment key={t.id}>
      {expandedId === t.id ? (
        <TaskCard task={t} />
      ) : (
        <TaskRow task={t} orderedIds={orderedIds} fadeOnDone={fade} />
      )}
    </Fragment>
  );

  return (
    <section className="main">
      <div className="view-head">
        <h1>今天</h1>
        <span className="sub">{formatCN(today)}</span>
      </div>
      <QuickAddBar autoFocus defaults={{ due: today }} />
      <div className="view-body">
        {overdue.length > 0 && (
          <>
            <div className="group-head warn">
              逾期 {overdue.length}
              <button className="act" onClick={() => postponeTasks(overdue.map((t) => t.id))}>
                全部推到明天 →
              </button>
            </div>
            {overdue.map((t) => renderRow(t))}
          </>
        )}
        {todays.length > 0 && <div className="group-head">今天</div>}
        {todays.map((t) => renderRow(t))}
        {doneToday.length > 0 && <div className="group-head">已完成 {doneToday.length}</div>}
        {doneToday.map((t) => renderRow(t, false))}
        {overdue.length === 0 && todays.length === 0 && doneToday.length === 0 && (
          <div className="empty">
            <span className="glyph">🌰</span>
            今天还没有安排——记一条，或者享受留白。
          </div>
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
        {focusMin > 0 && <span>🍅 专注 {focusMin} 分钟</span>}
        <span className="kbd-hint">
          <kbd>Ctrl K</kbd> 命令面板 · <kbd>Ctrl F</kbd> 搜索 · <kbd>Ctrl Z</kbd> 撤销
        </span>
      </div>
    </section>
  );
}
