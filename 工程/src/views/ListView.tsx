// 通用列表视图：随手记（无日期无归属的）/ 某清单 / 某需求方 / 某标签 / 回收站 共用。
// 「已完成」不在这儿——它要按完成时间分段、要显示完成日期，自成一个视图（views/Done.tsx）。
// 「随手记」是全应用的记录入口：打字用语法，不想背语法就用下面那排按钮。
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { List, Task } from "../core/model";
import { cmpYMD, todayYMD } from "../core/dates";
import {
  aliveTasks, deleteList, purgeTask, purgeTrash, renameList,
  restoreTask, setListColor, sortTasks, trashDaysLeft, useApp,
} from "../core/store";
import { LIST_COLORS } from "../core/model";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";
import QuickAddBar from "../components/QuickAddBar";
import { RowCard } from "../components/motion";
import { CommitMark, useCommitFlash } from "../components/commitFlash";

export type ListKind = "inbox" | "list" | "who" | "tag" | "trash";

/** 清单名（v1.9.0 · A4）。原来是个 contentEditable 的 h1：看不出能改、回车会插一个换行、
 *  也没法反悔。换成正经输入框——鼠标扫过露一圈淡边框，回车 / 点走都是存，Esc 还原。
 *  字体不能靠 `.view-head h1` 那条规则捡了，得显式搬到 input 上，否则清单页的标题
 *  会跟别的视图不是一个字体。 */
function ListNameInput({ list }: { list: List }) {
  const [draft, setDraft] = useState(list.name);
  const { on, flash } = useCommitFlash();
  /** 用户动过这个框没有。用 ref 不用 state：它只影响「要不要跟随外部改名」，不影响画面 */
  const dirty = useRef(false);

  // 别处改了这张清单的名字（撤销、云同步、另一台设备）就跟过去；用户正在改的时候不抢
  useEffect(() => {
    if (!dirty.current) setDraft(list.name);
  }, [list.name]);

  function commit() {
    const v = draft.trim();
    // 清空则还原显示（这条兜底比 A4 老，原样留着）
    if (!v) {
      setDraft(list.name);
      dirty.current = false;
      return;
    }
    if (v !== list.name) renameList(list.id, v);
    if (dirty.current) flash();
    dirty.current = false;
  }

  return (
    <>
      <input
        className={`list-name${on ? " commit-lit" : ""}`}
        value={draft}
        aria-label="清单名"
        onChange={(e) => {
          setDraft(e.target.value);
          dirty.current = true;
        }}
        // 点走 = 存下。**窗口失焦不是点走**：alt-tab 出去时清单会被改成打了一半的那个名字，
        // 框原样悬着，等用户回来自己了结（回车存 / Esc 还原）
        onBlur={() => { if (document.hasFocus()) commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit();
          }
          // Esc 还原，焦点留在框里。**必须拦下**：不拦的话它会冒到任务卡那层，
          // 顺手把正开着的卡片也收了（Esc 一共三层监听，见 SyntaxInput 的注释）
          if (e.key === "Escape") {
            e.stopPropagation();
            setDraft(list.name);
            dirty.current = false;
          }
        }}
      />
      <CommitMark on={on} />
    </>
  );
}

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
      // 这四个视图的口径（v1.9.0 收口）：**放弃跟完成一模一样**——都算了结了，
      // 都从这儿退出去、也都不进侧栏那个角标，归宿统一是「已完成」页里的「放弃的」。
      // 不发明第三种行为：同一个概念在三处给三个值，用户对不上的时候只能当哪个是坏的
      case "inbox":
        return {
          title: "随手记", sub: "没有日期、也没有归入清单的任务",
          tasks: sortTasks(alive.filter((t) => !t.done && !t.droppedAt && !t.listId && !t.due), sortMode),
          showAdd: true, defaults: {}, fade: true,
        };
      case "list":
        return {
          title: list?.name ?? "清单", sub: "",
          tasks: sortTasks(alive.filter((t) => !t.done && !t.droppedAt && t.listId === listId), sortMode),
          showAdd: true, defaults: { listId }, fade: true,
        };
      case "who":
        return {
          title: who ?? "需求方", sub: "这个需求方名下的所有任务",
          tasks: sortTasks(alive.filter((t) => !t.done && !t.droppedAt && who !== null && t.who.includes(who)), sortMode),
          showAdd: true, defaults: { who: who ? [who] : [] }, fade: true,
        };
      case "tag":
        return {
          title: `# ${tag ?? ""}`, sub: "",
          tasks: sortTasks(alive.filter((t) => !t.done && !t.droppedAt && t.tags.includes(tag ?? "")), sortMode),
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
            {/* key：切到另一张清单要重开一个框，否则上一张的草稿会串过来 */}
            <ListNameInput key={list.id} list={list} />
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
                <RowCard
                  key={t.id}
                  open={expandedId === t.id}
                  row={(collapsed) => (
                    <TaskRow
                      task={t}
                      orderedIds={orderedIds}
                      hideList={kind === "list"}
                      fadeOnDone={fade}
                      collapsed={collapsed}
                    />
                  )}
                  card={() => <TaskCard task={t} />}
                />
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

