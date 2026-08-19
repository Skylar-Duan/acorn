// 全部：未完成事项总览。按日期分四段（逾期/今天/接下来/未安排），排序偏好全局共用。
// 有子任务的事在这里被拆成一行一个子任务，各自按（继承或自填的）日期与重要性排。
import { Fragment, useMemo } from "react";
import { cmpYMD, todayYMD } from "../core/dates";
import type { DateRow } from "../core/store";
import { openRows, rowDue, rowTaskIds, sortRows, updateSettings, useApp } from "../core/store";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";
import "../styles/allview.css";

const SORT_OPTIONS = [
  { id: "time", name: "按时间" },
  { id: "priority", name: "按重要性" },
] as const;

export default function AllView() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const sortMode = data.settings.sortMode;
  const today = todayYMD();

  const groups = useMemo(() => {
    const rows = openRows(data);
    const pick = (test: (due: string | null) => boolean) =>
      sortRows(rows.filter((r) => test(rowDue(r))), sortMode);
    return [
      { key: "overdue", label: "逾期", warn: true, rows: pick((d) => !!d && cmpYMD(d, today) < 0) },
      { key: "today", label: "今天", warn: false, rows: pick((d) => d === today) },
      { key: "future", label: "接下来", warn: false, rows: pick((d) => !!d && cmpYMD(d, today) > 0) },
      { key: "nodate", label: "未安排", warn: false, rows: pick((d) => d === null) },
    ];
  }, [data, sortMode, today]);

  const allRows = groups.flatMap((g) => g.rows);
  // 连选按「件」走：一件事拆成几行也只占一个连选位
  const orderedIds = rowTaskIds(allRows);
  const openCount = allRows.length;

  // 母任务行不可见时展开卡落在第一个子行上（与今天/计划视图行为一致）
  const motherVisible = new Set(allRows.filter((r) => !r.sub).map((r) => r.task.id));
  const cardRendered = new Set<string>();
  const renderRow = (r: DateRow, i: number, arr: DateRow[]) => {
    const wantCard =
      expandedId === r.task.id &&
      (!r.sub || !motherVisible.has(r.task.id)) &&
      !cardRendered.has(r.task.id);
    if (wantCard) cardRendered.add(r.task.id);
    const bundled = !!r.sub && i > 0 && arr[i - 1].task.id === r.task.id;
    return (
      <Fragment key={r.sub ? `${r.task.id}/${r.sub.id}` : r.task.id}>
        {wantCard ? <TaskCard task={r.task} /> : <TaskRow task={r.task} sub={r.sub} orderedIds={orderedIds} bundled={bundled} />}
      </Fragment>
    );
  };

  return (
    <section className="main">
      <div className="view-head">
        <h1>全部</h1>
        <span className="sub">{openCount} 件未完成</span>
        <span className="spacer" />
        <div className="all-sort">
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.id}
              className={sortMode === o.id ? "on" : undefined}
              onClick={() => updateSettings({ sortMode: o.id })}
            >
              {o.name}
            </button>
          ))}
        </div>
      </div>
      <div className="view-body">
        {groups.map((g) => (
          <Fragment key={g.key}>
            {g.rows.length > 0 && (
              <div className={g.warn ? "group-head warn" : "group-head"}>
                {g.label}
                {g.warn ? ` ${g.rows.length}` : ""}
              </div>
            )}
            {g.rows.map(renderRow)}
          </Fragment>
        ))}
        {allRows.length === 0 && (
          <div className="empty">
            <span className="glyph">🌰</span>
            一件未完成的事都没有——好状态
          </div>
        )}
      </div>
    </section>
  );
}
