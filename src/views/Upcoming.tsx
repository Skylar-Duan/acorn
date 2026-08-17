// 计划：未来 7 天逐日排 + 更远的按月归堆。含带自己日期的子任务行。
import { Fragment, useMemo } from "react";
import type { DateRow } from "../core/store";
import { addDays, cmpYMD, formatShort, fromYMD, todayYMD } from "../core/dates";
import { openRows, rowDue, sortRows, useApp } from "../core/store";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";
import QuickAddBar from "../components/QuickAddBar";

const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

export default function Upcoming() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const today = todayYMD();
  const mode = data.settings.sortMode;

  const future = useMemo(
    () =>
      sortRows(
        openRows(data).filter((r) => {
          const due = rowDue(r);
          return due && cmpYMD(due, today) > 0;
        }),
        mode,
      ),
    [data, today, mode],
  );

  const orderedIds = future.filter((r) => !r.sub).map((r) => r.task.id);

  const dayGroups = useMemo(() => {
    const out: { label: string; date: string; items: DateRow[] }[] = [];
    for (let i = 1; i <= 7; i++) {
      const d = addDays(today, i);
      const items = future.filter((r) => rowDue(r) === d);
      const w = WEEK_CN[fromYMD(d).getDay()];
      out.push({ label: `${formatShort(d)} · 周${w}`, date: d, items });
    }
    return out;
  }, [future, today]);

  const beyond = useMemo(() => {
    const limit = addDays(today, 7);
    const far = future.filter((r) => cmpYMD(rowDue(r)!, limit) > 0);
    const byMonth = new Map<string, DateRow[]>();
    for (const r of far) {
      const key = rowDue(r)!.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key)!.push(r);
    }
    return [...byMonth.entries()].map(([ym, items]) => ({
      label: `${Number(ym.slice(0, 4)) !== fromYMD(today).getFullYear() ? ym.slice(0, 4) + "年" : ""}${Number(ym.slice(5, 7))}月`,
      items,
    }));
  }, [future, today]);

  const renderRow = (r: DateRow) => (
    <Fragment key={r.sub ? `${r.task.id}-${r.sub.id}` : r.task.id}>
      {!r.sub && expandedId === r.task.id ? (
        <TaskCard task={r.task} />
      ) : (
        <TaskRow task={r.task} sub={r.sub} orderedIds={orderedIds} />
      )}
    </Fragment>
  );

  return (
    <section className="main">
      <div className="view-head">
        <h1>计划</h1>
        <span className="sub">接下来的日子</span>
      </div>
      <QuickAddBar placeholder="记一条带日期的…如「下周三 和李哥对需求」" />
      <div className="view-body">
        {dayGroups.map((g) => (
          <Fragment key={g.date}>
            {g.items.length > 0 && <div className="group-head">{g.label}</div>}
            {g.items.map(renderRow)}
          </Fragment>
        ))}
        {beyond.map((g) => (
          <Fragment key={g.label}>
            <div className="group-head">{g.label}</div>
            {g.items.map(renderRow)}
          </Fragment>
        ))}
        {future.length === 0 && (
          <div className="empty">
            <span className="glyph">🌿</span>
            往后几天一片清净。
          </div>
        )}
      </div>
    </section>
  );
}
