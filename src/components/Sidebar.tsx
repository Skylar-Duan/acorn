// 侧栏：固定入口 + 视图 + 清单 + 自动出现的需求方分组。
import { useState } from "react";
import { todayYMD, cmpYMD } from "../core/dates";
import {
  addList, aliveTasks, allWho, navigate, useApp, type ViewId,
} from "../core/store";
import { LIST_COLORS } from "../core/model";
import iconUrl from "../../src-tauri/icons/32x32.png";

function Ico({ d, extra }: { d: string; extra?: string }) {
  return (
    <svg className="ico" viewBox="0 0 24 24">
      <path d={d} />
      {extra && <path d={extra} />}
    </svg>
  );
}

const ICONS = {
  inbox: "M3 13h4l2 3h6l2-3h4 M5 6h14l2 7v6H3v-6l2-7z",
  today: "M12 8a4 4 0 100 8 4 4 0 000-8z M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1",
  upcoming: "M3 5h18v16H3z M8 3v4M16 3v4M3 10h18",
  anytime: "M4 8c4-5 12-5 16 0 M4 16c4 5 12 5 16 0",
  logbook: "M4 19h16 M6 15l4-8 3 5 2-3 3 6",
  calendar: "M3 5h18v16H3z M8 3v4M16 3v4M3 10h18M9 10v11M15 10v11M3 15.5h18",
  quadrant: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  focus: "M12 5a8 8 0 100 16 8 8 0 000-16z M12 9v4l3 2 M9 2h6",
  stats: "M4 20V10 M10 20V4 M16 20v-9 M21 20H3",
} as const;

export default function Sidebar() {
  const view = useApp((s) => s.ui.view);
  const curList = useApp((s) => s.ui.listId);
  const curWho = useApp((s) => s.ui.who);
  const data = useApp((s) => s.data);
  const loadError = useApp((s) => s.loadError);
  const [addingList, setAddingList] = useState(false);

  const alive = aliveTasks(data);
  const today = todayYMD();
  const open = alive.filter((t) => !t.done);
  const counts = {
    inbox: open.filter((t) => !t.listId && !t.due && !t.someday).length,
    today: open.filter((t) => t.due && cmpYMD(t.due, today) <= 0).length,
    upcoming: open.filter((t) => t.due && cmpYMD(t.due, today) > 0).length,
    anytime: open.filter((t) => t.someday).length,
  };
  const whoList = allWho(data);

  const item = (id: ViewId, label: string, icon: keyof typeof ICONS, n?: number, hot?: boolean) => (
    <li className={view === id ? "on" : ""} onClick={() => navigate(id)}>
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
          {item("inbox", "收件箱", "inbox", counts.inbox)}
          {item("today", "今天", "today", counts.today, true)}
          {item("upcoming", "计划", "upcoming", counts.upcoming)}
          {item("anytime", "随时", "anytime", counts.anytime)}
          {item("logbook", "日志", "logbook")}
        </ul>
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
                className={view === "list" && curList === l.id ? "on" : ""}
                onClick={() => navigate("list", { listId: l.id })}
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
                  if (e.key === "Enter") {
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
                  className={view === "who" && curWho === who ? "on" : ""}
                  onClick={() => navigate("who", { who })}
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
      </nav>
      <div className="foot">
        {loadError ? <span className="bad" title={loadError} /> : <span className="ok" />}
        {loadError ? "数据异常" : "数据已就绪"}
        <button className="gear" title="设置" onClick={() => navigate("settings")}>⚙</button>
      </div>
    </aside>
  );
}
