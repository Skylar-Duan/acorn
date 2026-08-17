// 通用列表视图：收件箱 / 随时 / 某清单 / 某需求方 / 某标签 / 日志 / 回收站 共用。
import { Fragment, useMemo } from "react";
import type { Task } from "../core/model";
import { cmpYMD, todayYMD } from "../core/dates";
import {
  aliveTasks, byPriorityThenOrder, deleteList, purgeTrash, renameList,
  restoreTask, setListColor, useApp,
} from "../core/store";
import { LIST_COLORS } from "../core/model";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";
import QuickAddBar from "../components/QuickAddBar";

export type ListKind = "inbox" | "anytime" | "list" | "who" | "tag" | "logbook" | "trash";

export default function ListView({ kind }: { kind: ListKind }) {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const listId = useApp((s) => s.ui.listId);
  const who = useApp((s) => s.ui.who);
  const tag = useApp((s) => s.ui.tag);
  const today = todayYMD();

  const list = kind === "list" && listId ? data.lists.find((l) => l.id === listId) : null;

  const { title, sub, tasks, showAdd, defaults, fade } = useMemo(() => {
    const alive = aliveTasks(data);
    switch (kind) {
      case "inbox":
        return {
          title: "收件箱", sub: "还没归类、没安排日期的想法",
          tasks: alive.filter((t) => !t.done && !t.listId && !t.due && !t.someday).sort(byPriorityThenOrder),
          showAdd: true, defaults: {}, fade: true,
        };
      case "anytime":
        return {
          title: "随时", sub: "不赶时间，有空就做",
          tasks: alive.filter((t) => !t.done && t.someday).sort(byPriorityThenOrder),
          showAdd: true, defaults: { someday: true }, fade: true,
        };
      case "list":
        return {
          title: list?.name ?? "清单", sub: "",
          tasks: alive.filter((t) => !t.done && t.listId === listId).sort(sortByDueThenPriority),
          showAdd: true, defaults: { listId }, fade: true,
        };
      case "who":
        return {
          title: who ?? "需求方", sub: `为 TA 做的所有事`,
          tasks: alive.filter((t) => !t.done && t.who === who).sort(sortByDueThenPriority),
          showAdd: true, defaults: { who }, fade: true,
        };
      case "tag":
        return {
          title: `# ${tag ?? ""}`, sub: "",
          tasks: alive.filter((t) => !t.done && t.tags.includes(tag ?? "")).sort(sortByDueThenPriority),
          showAdd: false, defaults: {}, fade: true,
        };
      case "logbook":
        return {
          title: "日志", sub: "做完的事都在这里",
          tasks: alive.filter((t) => t.done).sort((a, b) => ((a.doneAt ?? "") < (b.doneAt ?? "") ? 1 : -1)).slice(0, 200),
          showAdd: false, defaults: {}, fade: false,
        };
      case "trash":
        return {
          title: "回收站", sub: "删除的任务保留 30 天",
          tasks: data.tasks.filter((t) => t.deletedAt).sort((a, b) => ((a.deletedAt ?? "") < (b.deletedAt ?? "") ? 1 : -1)),
          showAdd: false, defaults: {}, fade: false,
        };
    }
  }, [data, kind, listId, who, tag, list]);

  const orderedIds = tasks.map((t) => t.id);

  // 清单/需求方视图：按日期分组展示更有章法
  const groups: { label: string; items: Task[] }[] = useMemo(() => {
    if (kind === "logbook" || kind === "trash") return [{ label: "", items: tasks }];
    const overdue = tasks.filter((t) => t.due && cmpYMD(t.due, today) < 0);
    const todays = tasks.filter((t) => t.due === today);
    const later = tasks.filter((t) => t.due && cmpYMD(t.due, today) > 0);
    const nodate = tasks.filter((t) => !t.due);
    const out: { label: string; items: Task[] }[] = [];
    if (overdue.length) out.push({ label: `逾期 ${overdue.length}`, items: overdue });
    if (todays.length) out.push({ label: "今天", items: todays });
    if (later.length) out.push({ label: "以后", items: later });
    if (nodate.length) out.push({ label: kind === "anytime" ? "" : "未安排", items: nodate });
    return out.length ? out : [{ label: "", items: [] }];
  }, [tasks, kind, today]);

  return (
    <section className="main">
      <div className="view-head">
        {kind === "list" && list ? (
          <>
            <span
              className="dot"
              style={{ width: 12, height: 12, borderRadius: 99, background: `var(--list-${list.color})` }}
            />
            <h1
              contentEditable
              suppressContentEditableWarning
              style={{ outline: "none" }}
              onBlur={(e) => {
                const v = e.currentTarget.textContent?.trim();
                if (v && v !== list.name) renameList(list.id, v);
              }}
            >
              {list.name}
            </h1>
          </>
        ) : (
          <h1>{title}</h1>
        )}
        {sub && <span className="sub">{sub}</span>}
        <span className="spacer" />
        {kind === "list" && list && (
          <>
            {LIST_COLORS.map((c) => (
              <button
                key={c}
                title="换个颜色"
                onClick={() => setListColor(list.id, c)}
                style={{
                  width: 14, height: 14, borderRadius: 99, background: `var(--list-${c})`,
                  border: list.color === c ? "2px solid var(--ink)" : "2px solid transparent",
                }}
              />
            ))}
            <button className="btn danger" style={{ marginLeft: 10 }} onClick={() => deleteList(list.id)}>
              删除清单
            </button>
          </>
        )}
        {kind === "trash" && tasks.length > 0 && (
          <button className="btn danger" onClick={() => purgeTrash()}>清空回收站</button>
        )}
      </div>
      {showAdd && <QuickAddBar defaults={defaults} />}
      <div className="view-body">
        {groups.map((g, gi) => (
          <Fragment key={gi}>
            {g.label && <div className={`group-head${g.label.startsWith("逾期") ? " warn" : ""}`}>{g.label}</div>}
            {g.items.map((t) =>
              kind === "trash" ? (
                <div key={t.id} className="task-row">
                  <span className={`flag p${t.priority}`} />
                  <span className="title" style={{ color: "var(--ink-2)" }}>{t.title}</span>
                  <span className="meta">
                    <button className="btn ghost" onClick={() => restoreTask(t.id)}>恢复</button>
                  </span>
                </div>
              ) : (
                <Fragment key={t.id}>
                  {expandedId === t.id ? (
                    <TaskCard task={t} />
                  ) : (
                    <TaskRow task={t} orderedIds={orderedIds} hideList={kind === "list"} fadeOnDone={fade} />
                  )}
                </Fragment>
              ),
            )}
          </Fragment>
        ))}
        {tasks.length === 0 && (
          <div className="empty">
            <span className="glyph">🍂</span>
            {kind === "trash" ? "回收站是空的" : kind === "logbook" ? "还没有完成记录" : "空空如也"}
          </div>
        )}
      </div>
    </section>
  );
}

function sortByDueThenPriority(a: Task, b: Task): number {
  const ad = a.due ?? "9999-99-99";
  const bd = b.due ?? "9999-99-99";
  if (ad !== bd) return ad < bd ? -1 : 1;
  return byPriorityThenOrder(a, b);
}
