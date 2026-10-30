// 清单／需求方总览（10-30）：侧栏不再往下展开条目，点「清单」「需求方」在右侧主区换成这一页。
// 一张卡一个清单或需求方：名字、未完成数、最近三件；点卡进入，拖卡换顺序，任务拖到卡上照旧归进去。
import { useMemo, useState } from "react";
import { cmpYMD, formatShort, todayYMD } from "../core/dates";
import { categoryIcon } from "../core/categoryIcons";
import { createCategory } from "../core/categoryCreation";
import { listColor } from "../core/colors";
import { addTasksWho, allWho, categoryRows, moveList, moveWho, navigate, rowDue, sortRows, setTasksList, useApp, type DateRow } from "../core/store";
import SidebarIcon from "../components/SidebarIcon";
import "../styles/category-overview.css";

type Kind = "list" | "who";
const PEEK = 3;

function rowTitle(r: DateRow): string {
  return (r.sub ? r.sub.title : r.task.title).split("\n")[0];
}

export default function CategoryOverview({ kind }: { kind: Kind }) {
  const tasks = useApp((s) => s.data.tasks);
  const settings = useApp((s) => s.data.settings);
  const rawLists = useApp((s) => s.data.lists);
  const [over, setOver] = useState<string | null>(null);
  const today = todayYMD();

  const cards = useMemo(() => {
    const entries = kind === "list"
      ? [...rawLists].sort((a, b) => a.order - b.order).map((l) => ({ key: l.id, name: l.name, icon: categoryIcon("list", l.icon), color: listColor(l.color), filter: { listId: l.id } }))
      : allWho({ tasks, settings }).map(({ who }) => {
        const look = settings.whoAppearance?.[who];
        return { key: who, name: who, icon: categoryIcon("who", look?.icon), color: look?.color ? listColor(look.color) : undefined, filter: { who } };
      });
    return entries.map((e) => {
      const rows = sortRows(categoryRows({ tasks }, e.filter), "time");
      const late = rows.filter((r) => { const d = rowDue(r); return !!d && cmpYMD(d, today) < 0; }).length;
      // 从没放过事的不能说「都做完了」
      const used = rows.length > 0 || tasks.some((t) => !t.deletedAt && ("listId" in e.filter ? t.listId === e.filter.listId : t.who.includes(e.filter.who!)));
      return { ...e, count: rows.length, late, used, peek: rows.slice(0, PEEK) };
    });
  }, [kind, rawLists, tasks, settings, today]);

  const label = kind === "list" ? "清单" : "需求方";
  const moveType = `text/acorn-${kind}-move`;

  function open(key: string) {
    navigate(kind, kind === "list" ? { listId: key } : { who: key });
  }

  function dropOn(e: React.DragEvent, key: string) {
    e.preventDefault();
    setOver(null);
    const moved = e.dataTransfer.getData(moveType);
    if (moved) { if (moved !== key) (kind === "list" ? moveList : moveWho)(moved, key); return; }
    const ids = (e.dataTransfer.getData("text/acorn-task") || "").split(",").filter(Boolean);
    if (!ids.length) return;
    if (kind === "list") setTasksList(ids, key); else addTasksWho(ids, key);
  }

  return (
    <section className="main category-page">
      <div className="view-head">
        <h1>{label}</h1>
        <span className="sub">{cards.length} 个</span>
        <span className="spacer" />
        <button type="button" className="btn ghost category-new" onClick={() => {
          void createCategory(kind).then((created) => { if (created) open(created); });
        }}>＋ 新建{label}</button>
      </div>
      <div className="view-body category-body">
        {cards.length === 0 ? (
          <p className="category-empty">还没有{label}</p>
        ) : (
          <div className="category-grid">
            {cards.map((c, i) => (
              <article
                key={c.key}
                role="link"
                tabIndex={0}
                aria-label={`${c.name}，${c.count} 件未完成`}
                className={`category-card${over === c.key ? " over" : ""}`}
                style={{ "--i": Math.min(i, 12), ...(c.color ? { "--cat": c.color } : {}) } as React.CSSProperties}
                draggable
                onClick={() => open(c.key)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(c.key); } }}
                onDragStart={(e) => { e.dataTransfer.setData(moveType, c.key); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => {
                  const types = e.dataTransfer.types;
                  if (!types.includes(moveType) && !types.includes("text/acorn-task")) return;
                  e.preventDefault();
                  if (over !== c.key) setOver(c.key);
                }}
                onDragLeave={() => setOver((cur) => (cur === c.key ? null : cur))}
                onDragEnd={() => setOver(null)}
                onDrop={(e) => dropOn(e, c.key)}
              >
                <header className="category-card-head">
                  <span className="category-card-icon"><SidebarIcon path={c.icon} color={c.color} /></span>
                  <span className="category-card-name">{c.name}</span>
                  <span className="category-card-count">{c.count}</span>
                </header>
                {c.peek.length > 0 ? (
                  <ul className="category-card-peek">
                    {c.peek.map((r) => {
                      const due = rowDue(r);
                      return (
                        <li key={`${r.task.id}:${r.sub?.id ?? ""}`}>
                          <span className="category-peek-title">{rowTitle(r)}</span>
                          {due && <span className={`category-peek-due${cmpYMD(due, today) < 0 ? " late" : ""}`}>{formatShort(due)}</span>}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="category-card-clear">{c.used ? "都做完了" : "还没有事"}</p>
                )}
                {(c.count > PEEK || c.late > 0) && (
                  <footer className="category-card-foot">
                    {c.count > PEEK && <span>还有 {c.count - PEEK} 件</span>}
                    {c.late > 0 && <span className="late">{c.late} 件已过期</span>}
                  </footer>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
