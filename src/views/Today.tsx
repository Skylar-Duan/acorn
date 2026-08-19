// 今天：主战场。逾期置顶，可一键全部顺延；底部当日小结。
// 行来自 DateRow：母任务 + 带自己日期的子任务（「母 › 子」形式）。
import { Fragment } from "react";
import type { DateRow } from "../core/store";
import { formatCN, todayYMD } from "../core/dates";
import { postponeRows, rowTaskIds, tasksForToday, useApp } from "../core/store";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";

export default function Today() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const sessions = data.sessions;
  const today = todayYMD();

  const { overdue, todays, doneToday } = tasksForToday(data, today);
  const orderedIds = rowTaskIds([...overdue, ...todays]);
  const focusMin = sessions.filter((s) => s.date === today).reduce((a, b) => a + b.minutes, 0);
  // 底部进度按「件」算不按「行」算：一件事拆成 3 个子任务时，做掉 1 个不该让分母也跟着缩水
  const total = rowTaskIds(todays).length + doneToday.length;
  const doneRatio = total === 0 ? 0 : doneToday.length / total;

  // 展开卡的落点：母任务行处展开；母任务行不在本视图时（只有子任务行到期），
  // 卡片落在该任务的第一个子任务行上，避免「点了没反应」
  const motherVisible = new Set([...overdue, ...todays].filter((r) => !r.sub).map((r) => r.task.id));
  const cardRendered = new Set<string>();
  const renderRow = (r: DateRow, i: number, arr: DateRow[]) => {
    const wantCard =
      expandedId === r.task.id &&
      (!r.sub || !motherVisible.has(r.task.id)) &&
      !cardRendered.has(r.task.id);
    if (wantCard) cardRendered.add(r.task.id);
    const bundled = !!r.sub && i > 0 && arr[i - 1].task.id === r.task.id;
    return (
      <Fragment key={r.sub ? `${r.task.id}-${r.sub.id}` : r.task.id}>
        {wantCard ? <TaskCard task={r.task} /> : <TaskRow task={r.task} sub={r.sub} orderedIds={orderedIds} bundled={bundled} />}
      </Fragment>
    );
  };

  return (
    <section className="main">
      <div className="view-head">
        <h1>今天</h1>
        <span className="sub">{formatCN(today)}</span>
      </div>
      <div className="view-body">
        {overdue.length > 0 && (
          <>
            <div className="group-head warn">
              逾期 {overdue.length}
              <button className="act" onClick={() => postponeRows(overdue)}>
                全部推到明天 →
              </button>
            </div>
            {overdue.map(renderRow)}
          </>
        )}
        {todays.length > 0 && <div className="group-head">今天</div>}
        {todays.map(renderRow)}
        {doneToday.length > 0 && <div className="group-head">已完成 {doneToday.length}</div>}
        {doneToday.map((t) => (
          <Fragment key={t.id}>
            {expandedId === t.id ? (
              <TaskCard task={t} />
            ) : (
              <TaskRow task={t} orderedIds={orderedIds} fadeOnDone={false} />
            )}
          </Fragment>
        ))}
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
