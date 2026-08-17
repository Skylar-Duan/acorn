// 侧栏：固定入口 + 视图 + 清单 + 自动出现的需求方/标签分组。
// 同时是拖拽落点：任务拖到「今天」改今天、「计划」弹日期选择、「收件箱」清日期、清单/需求方即归属。
import { useEffect, useState } from "react";
import { addDays, dayOfWeek, todayYMD, cmpYMD } from "../core/dates";
import {
  addList, aliveTasks, allTags, allWho, navigate, openRows, setTasksDue,
  setTasksList, updateTask, useApp, type ViewId,
} from "../core/store";
import { LIST_COLORS } from "../core/model";
import iconUrl from "../../src-tauri/icons/32x32.png";

function Ico({ d }: { d: string }) {
  return (
    <svg className="ico" viewBox="0 0 24 24">
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  inbox: "M3 13h4l2 3h6l2-3h4 M5 6h14l2 7v6H3v-6l2-7z",
  today: "M12 8a4 4 0 100 8 4 4 0 000-8z M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1",
  upcoming: "M3 5h18v16H3z M8 3v4M16 3v4M3 10h18",
  all: "M4 6h16 M4 12h16 M4 18h10",
  logbook: "M4 19h16 M6 15l4-8 3 5 2-3 3 6",
  calendar: "M3 5h18v16H3z M8 3v4M16 3v4M3 10h18M9 10v11M15 10v11M3 15.5h18",
  quadrant: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  focus: "M12 5a8 8 0 100 16 8 8 0 000-16z M12 9v4l3 2 M9 2h6",
  stats: "M4 20V10 M10 20V4 M16 20v-9 M21 20H3",
} as const;

/** 从拖拽事件里取任务 id 组（TaskRow onDragStart 放进去的，多选拖拽是逗号串） */
function draggedTaskIds(e: React.DragEvent): string[] {
  const raw = e.dataTransfer.getData("text/acorn-task");
  return raw ? raw.split(",").filter(Boolean) : [];
}

export default function Sidebar() {
  const view = useApp((s) => s.ui.view);
  const curList = useApp((s) => s.ui.listId);
  const curWho = useApp((s) => s.ui.who);
  const curTag = useApp((s) => s.ui.tag);
  const data = useApp((s) => s.data);
  const loadError = useApp((s) => s.loadError);
  const [addingList, setAddingList] = useState(false);
  const [dropHint, setDropHint] = useState<string | null>(null);
  /** 拖到「计划」后待定日期的任务组 + 弹层位置（落点处） */
  const [pendingPlan, setPendingPlan] = useState<{ ids: string[]; x: number; y: number } | null>(null);

  const today = todayYMD();
  const open = aliveTasks(data).filter((t) => !t.done);
  const rows = openRows(data);
  const counts = {
    inbox: open.filter((t) => !t.listId && !t.due).length,
    today: rows.filter((r) => {
      const due = r.sub ? r.sub.due ?? null : r.task.due;
      return due && cmpYMD(due, today) <= 0;
    }).length,
    upcoming: rows.filter((r) => {
      const due = r.sub ? r.sub.due ?? null : r.task.due;
      return due && cmpYMD(due, today) > 0;
    }).length,
    all: open.length,
  };
  const whoList = allWho(data);
  const tagList = allTags(data);

  function dropProps(key: string, onDrop: (taskIds: string[], e: React.DragEvent) => void) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes("text/acorn-task")) {
          e.preventDefault();
          setDropHint(key);
        }
      },
      onDragLeave: () => setDropHint((h) => (h === key ? null : h)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDropHint(null);
        const ids = draggedTaskIds(e);
        if (ids.length) onDrop(ids, e);
      },
    };
  }

  // 「计划」弹层：Esc / 点弹层外关闭
  useEffect(() => {
    if (!pendingPlan) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPendingPlan(null);
    }
    function onDoc(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest(".side-plan-pop")) setPendingPlan(null);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [pendingPlan]);

  const item = (
    id: ViewId,
    label: string,
    icon: keyof typeof ICONS,
    n?: number,
    hot?: boolean,
    drop?: (taskIds: string[], e: React.DragEvent) => void,
  ) => (
    <li
      className={`${view === id ? "on" : ""}${dropHint === id ? " dropping" : ""}`}
      onClick={() => navigate(id)}
      {...(drop ? dropProps(id, drop) : {})}
    >
      <Ico d={ICONS[icon]} />
      {label}
      {n != null && n > 0 && <span className={`n${hot ? " hot" : ""}`}>{n}</span>}
    </li>
  );

  return (
    <aside className="side">
      <div className="brand">
        <img src={iconUrl} alt="" />
        橡果
      </div>
      <nav>
        <ul>
          {item("inbox", "收件箱", "inbox", counts.inbox, false, (ids) => setTasksDue(ids, null))}
          {item("today", "今天", "today", counts.today, true, (ids) => setTasksDue(ids, today))}
          {item("upcoming", "计划", "upcoming", counts.upcoming, false, (ids, e) => setPendingPlan({ ids, x: e.clientX, y: e.clientY }))}
          {item("all", "全部", "all", counts.all)}
          {item("logbook", "日志", "logbook")}
        </ul>
        {pendingPlan && (
          <div
            className="popmenu side-plan-pop"
            style={{ left: Math.min(pendingPlan.x, window.innerWidth - 220), top: Math.min(pendingPlan.y, window.innerHeight - 220), position: "fixed" }}
          >
            <div style={{ fontSize: 12, color: "var(--ink-2)", padding: "4px 10px" }}>
              安排到哪天？{pendingPlan.ids.length > 1 ? `（${pendingPlan.ids.length} 项）` : ""}
            </div>
            <button className="item" onClick={() => { setTasksDue(pendingPlan.ids, addDays(today, 1)); setPendingPlan(null); }}>明天</button>
            <button className="item" onClick={() => { const wd = dayOfWeek(today); setTasksDue(pendingPlan.ids, addDays(today, wd === 0 ? 1 : 8 - wd)); setPendingPlan(null); }}>下周一</button>
            <input
              className="inline"
              type="date"
              onChange={(e) => {
                if (e.target.value) {
                  setTasksDue(pendingPlan.ids, e.target.value);
                  setPendingPlan(null);
                }
              }}
            />
            <button className="item" onClick={() => setPendingPlan(null)}>取消</button>
          </div>
        )}
        <div className="group-title">视图</div>
        <ul>
          {item("calendar", "日历", "calendar")}
          {item("quadrant", "四象限", "quadrant")}
          {item("focus", "专注", "focus")}
          {item("stats", "统计", "stats")}
        </ul>
        <div className="group-title">
          清单
          <button title="新建清单" onClick={() => setAddingList(true)}>＋</button>
        </div>
        <ul>
          {[...data.lists].sort((a, b) => a.order - b.order).map((l) => {
            const n = open.filter((t) => t.listId === l.id).length;
            return (
              <li
                key={l.id}
                className={`${view === "list" && curList === l.id ? "on" : ""}${dropHint === `list-${l.id}` ? " dropping" : ""}`}
                onClick={() => navigate("list", { listId: l.id })}
                {...dropProps(`list-${l.id}`, (ids) => setTasksList(ids, l.id))}
              >
                <span className="dot" style={{ background: `var(--list-${l.color})` }} />
                {l.name}
                {n > 0 && <span className="n">{n}</span>}
              </li>
            );
          })}
          {addingList && (
            <li>
              <input
                className="input"
                autoFocus
                placeholder="清单名，回车创建"
                style={{ padding: "3px 8px", fontSize: 13 }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    const v = (e.target as HTMLInputElement).value.trim();
                    if (v) addList(v, LIST_COLORS[data.lists.length % LIST_COLORS.length]);
                    setAddingList(false);
                  }
                  if (e.key === "Escape") setAddingList(false);
                }}
                onBlur={() => setAddingList(false)}
              />
            </li>
          )}
        </ul>
        {whoList.length > 0 && (
          <>
            <div className="group-title">需求方</div>
            <ul>
              {whoList.map(({ who, open: n }) => (
                <li
                  key={who}
                  className={`${view === "who" && curWho === who ? "on" : ""}${dropHint === `who-${who}` ? " dropping" : ""}`}
                  onClick={() => navigate("who", { who })}
                  {...dropProps(`who-${who}`, (ids) => ids.forEach((id) => updateTask(id, { who })))}
                >
                  <span
                    className="dot"
                    style={{
                      background: "var(--accent-soft)", color: "var(--accent)",
                      width: 16, height: 16, borderRadius: 99, fontSize: 10, fontWeight: 600,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    {who.slice(0, 1)}
                  </span>
                  {who}
                  {n > 0 && <span className="n">{n}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {tagList.length > 0 && (
          <>
            <div className="group-title">标签</div>
            <ul>
              {tagList.map(({ tag, open: n }) => (
                <li
                  key={tag}
                  className={view === "tag" && curTag === tag ? "on" : ""}
                  onClick={() => navigate("tag", { tag })}
                >
                  <span style={{ color: "var(--ink-3)", fontSize: 12, width: 8, textAlign: "center" }}>#</span>
                  {tag}
                  {n > 0 && <span className="n">{n}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
      <div className="foot">
        {loadError ? <span className="bad" title={loadError} /> : <span className="ok" />}
        {loadError ? "数据异常" : "数据已就绪"}
        <button className="gear" title="设置" onClick={() => navigate("settings")}>⚙</button>
      </div>
    </aside>
  );
}
