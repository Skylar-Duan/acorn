// 日历：整月俯瞰。任务条可拖到别的日子改期，双击某天空白处就地补记一条。
import { useMemo, useState } from "react";
import type { Task } from "../core/model";
import { addDays, dayOfWeek, daysInMonth, monthStart, todayYMD } from "../core/dates";
import {
  addTask, aliveTasks, byPriorityThenOrder, expandTask, setTasksDue, useApp,
} from "../core/store";
import TaskCard from "../components/TaskCard";
import "../styles/calendar.css";

const WEEK_HEAD = ["一", "二", "三", "四", "五", "六", "日"];
const MAX_SHOWN = 3;

export default function Calendar() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const today = todayYMD();
  /** 当前展示月份的一号 */
  const [anchor, setAnchor] = useState(() => monthStart(today));
  const [dropYmd, setDropYmd] = useState<string | null>(null);
  const [quickYmd, setQuickYmd] = useState<string | null>(null);
  const [quickText, setQuickText] = useState("");

  // 本月格子：周一开头，前后补齐到整周
  const cells = useMemo(() => {
    const y = Number(anchor.slice(0, 4));
    const m = Number(anchor.slice(5, 7));
    const lead = (dayOfWeek(anchor) + 6) % 7;
    const start = addDays(anchor, -lead);
    const weeks = Math.ceil((lead + daysInMonth(y, m)) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  }, [anchor]);

  // 按日期归堆：未完成列条目，已完成只记数
  const byDay = useMemo(() => {
    const map = new Map<string, { open: Task[]; done: number }>();
    for (const t of aliveTasks(data)) {
      if (!t.due) continue;
      let slot = map.get(t.due);
      if (!slot) {
        slot = { open: [], done: 0 };
        map.set(t.due, slot);
      }
      if (t.done) slot.done += 1;
      else slot.open.push(t);
    }
    for (const slot of map.values()) slot.open.sort(byPriorityThenOrder);
    return map;
  }, [data]);

  const expanded = expandedId ? aliveTasks(data).find((t) => t.id === expandedId) : undefined;
  const ymLabel = `${anchor.slice(0, 4)}年${Number(anchor.slice(5, 7))}月`;

  function goPrev() {
    setAnchor((a) => monthStart(addDays(a, -1)));
  }
  function goNext() {
    // 一号加上当月天数正好落到下月一号
    setAnchor((a) => addDays(a, daysInMonth(Number(a.slice(0, 4)), Number(a.slice(5, 7)))));
  }

  function submitQuick() {
    const title = quickText.trim();
    if (title && quickYmd) addTask({ title, due: quickYmd });
    setQuickYmd(null);
    setQuickText("");
  }

  function onDrop(e: React.DragEvent, ymd: string) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    if (id) setTasksDue([id], ymd);
    setDropYmd(null);
  }

  return (
    <section className="main">
      <div className="view-head">
        <h1>日历</h1>
        <span className="cal-ym">{ymLabel}</span>
        <span className="spacer" />
        <div className="cal-nav">
          <button className="arr" onClick={goPrev} title="上个月">‹</button>
          <button onClick={() => setAnchor(monthStart(todayYMD()))}>今天</button>
          <button className="arr" onClick={goNext} title="下个月">›</button>
        </div>
      </div>

      <div className="view-body cal-body">
        <div className="cal-week">
          {WEEK_HEAD.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>

        <div className="cal-grid">
          {cells.map((ymd) => {
            const slot = byDay.get(ymd);
            const open = slot?.open ?? [];
            const done = slot?.done ?? 0;
            const inMonth = ymd.slice(0, 7) === anchor.slice(0, 7);
            return (
              <div
                key={ymd}
                className={`cal-cell${inMonth ? "" : " dim"}${dropYmd === ymd ? " cal-dropping" : ""}`}
                onDoubleClick={() => {
                  setQuickYmd(ymd);
                  setQuickText("");
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropYmd((cur) => (cur === ymd ? cur : ymd));
                }}
                onDragLeave={() => setDropYmd((cur) => (cur === ymd ? null : cur))}
                onDrop={(e) => onDrop(e, ymd)}
              >
                <div className="cal-head">
                  <span className={`cal-num${ymd === today ? " today" : ""}`}>
                    {Number(ymd.slice(8, 10))}
                  </span>
                  {done > 0 && (
                    <span className="cal-done" title={`当天已完成 ${done} 项`}>
                      <span className="cal-done-dot" />
                      {done}
                    </span>
                  )}
                </div>
                {open.slice(0, MAX_SHOWN).map((t) => (
                  <div
                    key={t.id}
                    className="cal-task"
                    title={t.title}
                    draggable
                    onClick={(e) => {
                      e.stopPropagation();
                      expandTask(t.id);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", t.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDropYmd(null)}
                  >
                    <span className={`flag p${t.priority}`} />
                    <span className="cal-title">{t.title || "（未命名）"}</span>
                  </div>
                ))}
                {open.length > MAX_SHOWN && <div className="cal-more">+{open.length - MAX_SHOWN}</div>}
                {quickYmd === ymd && (
                  <div className="cal-quick" onDoubleClick={(e) => e.stopPropagation()}>
                    <input
                      autoFocus
                      placeholder="回车添加"
                      value={quickText}
                      onChange={(e) => setQuickText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitQuick();
                        if (e.key === "Escape") setQuickYmd(null);
                      }}
                      onBlur={() => setQuickYmd(null)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {expanded && (
          <div className="cal-detail">
            <TaskCard task={expanded} />
          </div>
        )}
      </div>
    </section>
  );
}
