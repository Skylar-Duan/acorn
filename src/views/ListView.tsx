// 通用列表视图：随手记（无日期无归属的）/ 某清单 / 某需求方 / 某标签 / 回收站 共用。
// 「已完成」不在这儿——它要按完成时间分段、要显示完成日期，自成一个视图（views/Done.tsx）。
// 「随手记」是全应用的记录入口：打字用语法，不想背语法就用下面那排按钮。
import { Fragment, useMemo } from "react";
import type { Task } from "../core/model";
import { cmpYMD, todayYMD } from "../core/dates";
import {
  aliveTasks, deleteList, purgeTask, purgeTrash, renameList,
  restoreTask, setListColor, sortTasks, trashDaysLeft, useApp,
} from "../core/store";
import { LIST_COLORS } from "../core/model";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";
import QuickAddBar from "../components/QuickAddBar";

export type ListKind = "inbox" | "list" | "who" | "tag" | "trash";

export default function ListView({ kind }: { kind: ListKind }) {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const listId = useApp((s) => s.ui.listId);
  const who = useApp((s) => s.ui.who);
  const tag = useApp((s) => s.ui.tag);
  const today = todayYMD();

  const list = kind === "list" && listId ? data.lists.find((l) => l.id === listId) : null;

  const sortMode = data.settings.sortMode;

  const { title, sub, tasks, showAdd, defaults, fade } = useMemo(() => {
    const alive = aliveTasks(data);
    switch (kind) {
      case "inbox":
        return {
          title: "随手记", sub: "没有日期、也没有归入清单的任务",
          tasks: sortTasks(alive.filter((t) => !t.done && !t.listId && !t.due), sortMode),
          showAdd: true, defaults: {}, fade: true,
        };
      case "list":
        return {
          title: list?.name ?? "清单", sub: "",
          tasks: sortTasks(alive.filter((t) => !t.done && t.listId === listId), sortMode),
          showAdd: true, defaults: { listId }, fade: true,
        };
      case "who":
        return {
          title: who ?? "需求方", sub: "这个需求方名下的所有任务",
          tasks: sortTasks(alive.filter((t) => !t.done && who !== null && t.who.includes(who)), sortMode),
          showAdd: true, defaults: { who: who ? [who] : [] }, fade: true,
        };
      case "tag":
        return {
          title: `# ${tag ?? ""}`, sub: "",
          tasks: sortTasks(alive.filter((t) => !t.done && t.tags.includes(tag ?? "")), sortMode),
          showAdd: false, defaults: {}, fade: true,
        };
      case "trash":
        return {
          title: "回收站", sub: "删除的任务保留 30 天",
          tasks: data.tasks.filter((t) => t.deletedAt).sort((a, b) => ((a.deletedAt ?? "") < (b.deletedAt ?? "") ? 1 : -1)),
          showAdd: false, defaults: {}, fade: false,
        };
    }
  }, [data, kind, listId, who, tag, list, sortMode]);

  // 清单/需求方视图：按日期分组展示更有章法
  const groups: { label: string; items: Task[] }[] = useMemo(() => {
    if (kind === "trash") return [{ label: "", items: tasks }];
    const overdue = tasks.filter((t) => t.due && cmpYMD(t.due, today) < 0);
    const todays = tasks.filter((t) => t.due === today);
    const later = tasks.filter((t) => t.due && cmpYMD(t.due, today) > 0);
    const nodate = tasks.filter((t) => !t.due);
    const out: { label: string; items: Task[] }[] = [];
    if (overdue.length) out.push({ label: `逾期 ${overdue.length}`, items: overdue });
    if (todays.length) out.push({ label: "今天", items: todays });
    if (later.length) out.push({ label: "以后", items: later });
    if (nodate.length) out.push({ label: kind === "inbox" ? "" : "未安排", items: nodate });
    return out.length ? out : [{ label: "", items: [] }];
  }, [tasks, kind, today]);

  // shift 连选的顺序必须与实际渲染顺序（分组后）一致，否则会圈中范围外的任务
  const orderedIds = useMemo(() => groups.flatMap((g) => g.items.map((t) => t.id)), [groups]);

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
                else if (!v) e.currentTarget.textContent = list.name; // 清空不生效，还原显示
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
      {showAdd && <QuickAddBar defaults={defaults} withPickers={kind === "inbox"} autoFocus={kind === "inbox"} />}
      <div className="view-body">
        {groups.map((g, gi) => (
          <Fragment key={gi}>
            {g.label && <div className={`group-head${g.label.startsWith("逾期") ? " warn" : ""}`}>{g.label}</div>}
            {g.items.map((t) =>
              kind === "trash" ? (
                <div key={t.id} className="task-row">
                  {/* 跟别的视图的任务行左边缘对齐（那边行首有个折叠小三角） */}
                  <span className="chain-caret ghost" />
                  <span className={`flag p${t.priority}`} />
                  <span className="title" style={{ color: "var(--ink-2)" }}>{t.title || "（未命名）"}</span>
                  <span className="meta">
                    {t.deletedAt && (
                      <span title={`删除于 ${t.deletedAt.slice(0, 10)}`}>
                        还剩 {trashDaysLeft(t.deletedAt)} 天
                      </span>
                    )}
                    <button className="btn ghost" onClick={() => restoreTask(t.id)}>恢复</button>
                    <button className="btn ghost" title="不等 30 天，立即彻底删除" onClick={() => purgeTask(t.id)}>
                      彻底删除
                    </button>
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
            {kind === "trash" ? "回收站是空的。"
              : kind === "inbox" ? "还没有记录，在上面记一条。"
              : "这里没有任务。"}
          </div>
        )}
      </div>
    </section>
  );
}

