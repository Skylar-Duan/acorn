// 计划：未来 7 天逐日排 + 更远的按月归堆。
import { Fragment, useMemo } from "react";
import type { Task } from "../core/model";
import { addDays, cmpYMD, formatShort, fromYMD, todayYMD } from "../core/dates";
import { aliveTasks, byPriorityThenOrder, useApp } from "../core/store";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";
import QuickAddBar from "../components/QuickAddBar";

const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

export default function Upcoming() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const today = todayYMD();

  const future = useMemo(
    () =>
      aliveTasks(data)
        .filter((t) => !t.done && t.due && cmpYMD(t.due, today) > 0)
        .sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : byPriorityThenOrder(a, b))),
    [data, today],
  );

  const orderedIds = future.map((t) => t.id);

  const dayGroups = useMemo(() => {
    const out: { label: string; date: string; items: Task[] }[] = [];
    for (let i = 1; i <= 7; i++) {
      const d = addDays(today, i);
      const items = future.filter((t) => t.due === d);
      const w = WEEK_CN[fromYMD(d).getDay()];
      out.push({ label: `${formatShort(d)} · 周${w}`, date: d, items });
    }
    return out;
  }, [future, today]);

  const beyond = useMemo(() => {
    const limit = addDays(today, 7);
    const far = future.filter((t) => cmpYMD(t.due!, limit) > 0);
    const byMonth = new Map<string, Task[]>();
    for (const t of far) {
      const key = t.due!.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key)!.push(t);
    }
    return [...byMonth.entries()].map(([ym, items]) => ({
      label: `${Number(ym.slice(0, 4)) !== fromYMD(today).getFullYear() ? ym.slice(0, 4) + "年" : ""}${Number(ym.slice(5, 7))}月`,
      items,
    }));
  }, [future, today]);

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
            {g.items.map((t) => (
              <Fragment key={t.id}>
                {expandedId === t.id ? <TaskCard task={t} /> : <TaskRow task={t} orderedIds={orderedIds} />}
              </Fragment>
            ))}
          </Fragment>
        ))}
        {beyond.map((g) => (
          <Fragment key={g.label}>
            <div className="group-head">{g.label}</div>
            {g.items.map((t) => (
              <Fragment key={t.id}>
                {expandedId === t.id ? <TaskCard task={t} /> : <TaskRow task={t} orderedIds={orderedIds} />}
              </Fragment>
            ))}
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
