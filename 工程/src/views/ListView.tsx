// 通用列表视图：随手记（无日期无归属的）/ 某清单 / 某需求方 / 某标签 / 回收站 共用。
// 「已完成」不在这儿——它要按完成时间分段、要显示完成日期，自成一个视图（views/Done.tsx）。
// 「随手记」是全应用的记录入口：打字用语法，不想背语法就用下面那排按钮。
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { listColor } from "../core/colors";
import type { List, Subtask, Task } from "../core/model";
import { todayYMD } from "../core/dates";
import { taskDue } from "../core/taskDue";
import {
  aliveTasks, categoryRows, deleteList, navigate, purgeSubtask, purgeTask, purgeTrash, renameList,
  restoreSubtask, restoreTask, setListColor, sortRows, sortTasks, trashDaysLeft, trashedSubtaskRows, useApp,
} from "../core/store";
import { isMobile } from "../core/platform";
import type { ListGroup } from "../core/plan";
import { listGroups } from "../core/plan";
import type { PinIds } from "../core/pin";
import { usePinExpanded } from "../core/pin";
import { LIST_COLORS } from "../core/model";
import TaskRow from "../components/TaskRow";
import TaskCard from "../components/TaskCard";
import QuickAddBar from "../components/QuickAddBar";
import { RowCard } from "../components/motion";
import { CommitMark, useCommitFlash } from "../components/commitFlash";
import MobileHead from "../mobile/MobileHead";
import MobileRow from "../mobile/MobileRow";
import { openSheet } from "../mobile/sheetStore";
import { IcoDots } from "../mobile/icons";
import RowList, { cardAnchor, planFold } from "../components/RowList";
import Icon from "../components/Icon";
import "../styles/trash.css";
import "../styles/category-overview.css";

export type ListKind = "inbox" | "list" | "who" | "tag" | "trash";

/** 「这一行是谁、属于哪件事」——喂给 core/pin 的 usePinExpanded。
 *  这几个视图一件事只占一行（子任务不单独出行），所以两个口径都是任务 id，
 *  跟下面 RowCard 的 `key={t.id}` 同一个来源：认错行就等于没钉 */
const LIST_PIN: PinIds<Task> = { key: (t) => t.id, taskId: (t) => t.id };

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

function TrashRow({ task, sub }: { task: Task; sub?: Subtask }) {
  const deleted = sub?.deletedAt ?? task.deletedAt;
  const days = deleted ? trashDaysLeft(deleted) : null;
  const title = (sub ? sub.title : task.title) || "（未命名）";
  return <div className={`task-row trash-row${sub ? " trash-sub" : ""}`}>
    <span className="trash-kind"><Icon name={sub ? "list" : "file"} size={18} /></span>
    <span className="trash-copy">
      {sub && <span className="trash-parent" title={task.title}>{task.title || "（未命名）"}<Icon name="chevronRight" size={11} />子任务</span>}
      <span className="title" title={title}>{title}</span>
    </span>
    <span className={`trash-expiry${days !== null && days <= 3 ? " soon" : ""}`} title={deleted ? `删除于 ${deleted.slice(0, 10)}` : undefined}>{days !== null ? `还剩 ${days} 天` : ""}</span>
    <span className="trash-actions">
      <button className="btn trash-restore" onClick={() => sub ? restoreSubtask(task.id, sub.id) : restoreTask(task.id)} aria-label={`恢复${title}`}><Icon name="restore" size={14} />恢复</button>
      <button className="btn ghost trash-purge" title="不等 30 天，立即彻底删除" aria-label={`彻底删除${title}`} onClick={() => sub ? purgeSubtask(task.id, sub.id) : purgeTask(task.id)}>彻底删除</button>
    </span>
  </div>;
}

export default function ListView({ kind }: { kind: ListKind }) {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const ui = useApp((s) => s.ui);
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
          title: "还没有清单的事", sub: "没有日期、也没有归入清单的任务",
          tasks: sortTasks(alive.filter((t) => !t.done && !t.droppedAt && !t.listId && !taskDue(t)), sortMode),
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

  // 回收站里单列的子任务（v7）：母任务还活着、只删了这一步的那些，画在整件事那列后面，
  // 一行一条「母任务 › 子任务」。母任务整件事在回收站里时它的子任务不单列（跟着母任务走）
  const subRows = useMemo(() => {
    if (kind === "trash") return trashedSubtaskRows(data);
    if (kind !== "list" && kind !== "who") return [];
    return sortRows(categoryRows(data, kind === "list" ? { listId } : { who }).filter((r) => r.sub), "time");
  }, [data, kind, listId, who]);
  const trashHasStuff = tasks.length > 0 || subRows.length > 0;

  // 清单/需求方视图：按日期分组展示更有章法（分法在 core/plan.ts，纯函数、可单测）。
  // 回收站不分组：那儿按删除时间倒着排，再切成逾期/今天没有意义
  const laid: ListGroup[] = useMemo(
    () =>
      kind === "trash"
        ? [{ key: "all", label: "", rows: tasks }]
        : listGroups(tasks, today, kind === "inbox" ? "" : "未安排"),
    [tasks, kind, today],
  );

  // 展开着的那件事钉在上一版的位置上（core/pin.ts）。这个视图犯的是同一种病：
  // 在卡里把日期改到今天、或者顺手改掉它的归属，这一行会当场换一组（甚至整个退出这个视图），
  // 而每一组各自一个 Fragment —— 卡片换了 React 父节点就是卸载重挂，
  // 输入框焦点、「＋子任务」草稿、标题编辑草稿一起清空，用户看到的就是「卡片自己收回去了」。
  // 兜底行池给的是**这个视图没过滤过**的那一份（还活着、还没了结的全部任务）：
  // 改到别的清单去之后，光靠上面那四组是捞不回来的。
  // 真勾掉 / 真删掉的不在池子里 —— 那种「真没了」就该让它没（跟「今天」视图同一个口径）
  const pinPool = expandedId
    ? aliveTasks(data).filter((t) => !t.done && !t.droppedAt && t.id === expandedId)
    : [];
  const groups = usePinExpanded(laid, expandedId, LIST_PIN, pinPool);

  // 下面一律用**这一版真画出去的**那份：连选顺序、空态都得跟画面对得上
  const shown = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  // shift 连选的顺序必须与实际渲染顺序（分组后）一致，否则会圈中范围外的任务
  const orderedIds = useMemo(() => shown.map((t) => t.id), [shown]);

  return (
    <section className={`main${kind === "trash" ? " trash-page" : ""}${!isMobile && (kind === "list" || kind === "who") ? " category-detail" : ""}`}>
      {isMobile ? (
        // 清单页的手机版顶栏（画板 ⑤）：返回 · 色点 + 名字 · N 件 · 「···」。
        // 原来摊在这一行上的六颗颜色点和红色的「删除清单」全收进「···」那张纸里
        // （mobile/ListSettingsSheet）——390px 宽排不下，而删除也不该跟标题挤在一起等着被误碰
        <MobileHead
          // 手机上没有「随手记」这个词了（2026-09-03）：那些事在 今天 / 计划 / 日历 里照常排着，
          // 只是不再单开一个叫「随手记」的地方。搜索结果仍可能落到这一页，所以它得有个说人话的名字
          title={kind === "inbox" ? "还没有清单的事" : kind === "list" && list ? list.name : title}
          sub={kind === "list" ? "" : kind === "inbox" ? "" : kind === "trash" ? `${tasks.length + subRows.length} 项` : sub}
          small={kind === "list"}
          dot={kind === "list" && list ? listColor(list.color) : null}
          // 每一页都得有路回去：这几页手机上都不是常驻位，进来了就要走得掉
          onBack={() => navigate("today")}
          search={kind !== "list"}
          right={
            kind === "list" && list ? (
              <>
                <span className="mhead-count">{tasks.length + subRows.length} 件</span>
                <button
                  className="mhead-plain"
                  aria-label="清单设置"
                  onClick={() => openSheet({ kind: "listSettings", listId: list.id })}
                >
                  <IcoDots />
                </button>
              </>
            ) : undefined
          }
          extra={
            kind === "trash" && trashHasStuff ? (
              <button className="btn ghost trash-clear" onClick={() => purgeTrash()}><Icon name="trash" size={14} />清空回收站</button>
            ) : undefined
          }
        />
      ) : (
      <div className="view-head">
        {(kind === "list" || kind === "who") && (
          // 侧栏不再展开条目，回总览走这里（10-30）
          <button type="button" className="category-back" onClick={() => navigate(kind)} aria-label={`返回全部${kind === "list" ? "清单" : "需求方"}`}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3.5-4.5 4.5 4.5 4.5" /></svg>{kind === "list" ? "清单" : "需求方"}
          </button>
        )}
        {kind === "list" && list ? (
          <>
            <span
              className="dot"
              style={{ width: 12, height: 12, borderRadius: 99, background: listColor(list.color) }}
            />
            {/* key：切到另一张清单要重开一个框，否则上一张的草稿会串过来 */}
            <ListNameInput key={list.id} list={list} />
          </>
        ) : (
          <h1>{title}</h1>
        )}
        {sub && <span className="sub">{kind === "trash" ? `${tasks.length + subRows.length} 项 · 删除后保留30天` : sub}</span>}
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
        {kind === "trash" && trashHasStuff && (
          <button className="btn ghost trash-clear" onClick={() => purgeTrash()}><Icon name="trash" size={14} />清空回收站</button>
        )}
      </div>
      )}
      {/* 手机上不画这条输入栏：记一条走右下角那颗悬浮 ＋（拉出「记一条」那张纸），
          一处入口就够了，屏幕顶上再顶一条常驻输入框会把「今天要做什么」挤下去 */}
      {showAdd && !isMobile && (
        <QuickAddBar defaults={defaults} withPickers={kind === "inbox"} autoFocus={kind === "inbox"} />
      )}
      <div className="view-body">
        {groups.map((g) => (
          // key 是组的语义名（overdue / today / later / nodate），不是下标：
          // 下标当 key 的话，某一组一空，它后面每一组的 key 全体错一位、整片重挂，
          // 卡片跟着卸载重建——那正是「加完子任务卡片自己收回去」的另一条路
          <Fragment key={g.key}>
            {/* 空组照旧不画（连组标题一起）。判的是**钉过之后**这一组还剩什么：
                钉在这儿的那一件已经不属于这一组了，照原分组判会出现「标题底下空一片」 */}
            {g.rows.length > 0 && g.label && (
              // split + .group-label：手机上标题收成一颗胶囊贴左（画板 A）。桌面上这两个类名没有样式
              <div className={`group-head split${g.warn ? " warn" : ""}`}>
                <span className="group-label">{g.label}</span>
              </div>
            )}
            {/* 手机端：一组一张圆角卡，行换成 MobileRow。回收站不走这条——那儿的行不是任务行，
                是「还剩 N 天 + 恢复 + 彻底删除」，滑动和详情都用不上 */}
            {isMobile && kind !== "trash" ? (
              g.rows.length > 0 && (
                <div className="mcard">
                  {g.rows.map((t) => (
                    <MobileRow key={t.id} task={t} />
                  ))}
                </div>
              )
            ) : (
            g.rows.map((t) =>
              kind === "trash" ? (
                <TrashRow key={t.id} task={t} />
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
            )
            )}
          </Fragment>
        ))}
        {kind !== "trash" && subRows.length > 0 && (
          <>
            <div className="group-head split"><span className="group-label">子任务</span></div>
            <RowList rows={subRows} fold={planFold(subRows, ui)} anchor={cardAnchor(subRows, expandedId)} orderedIds={[...orderedIds, ...subRows.map((r) => r.task.id)]} fadeOnDone />
          </>
        )}
        {/* 回收站里单列的子任务（v7）：一行一条「母任务 › 子任务 · 还剩 N 天」，恢复 / 彻底删除。
            桌面和手机同一份标记——手机上这一页本来就用的是桌面那份 .task-row（套成卡的样子，
            见 mobile-shell.css），照抄上面整件事那行就行 */}
        {kind === "trash" &&
          subRows.map((r) => (
            <TrashRow key={`${r.task.id}/${r.sub!.id}`} task={r.task} sub={r.sub!} />
          ))}
        {/* 按**这一版真画出来的行**算，不按过滤出来的 tasks 算：展开期间钉在这儿的那一件
            已经不在 tasks 里了（比如在卡里改了归属），照 tasks 判会出现
            「卡片明明摆在页面上，底下写着这里没有任务」 */}
        {shown.length === 0 && subRows.length === 0 && (
          kind === "trash" ? <div className="empty trash-empty"><Icon name="trash" size={28} /><strong>回收站是空的。</strong><span>删除的任务会在这里保留30天，可随时恢复。</span></div> : <div className="empty">
            {/* 「在上面记一条」说的是那条输入栏。手机上没有它，得指向右下角那颗 ＋ */}
            {kind === "inbox" ? (isMobile ? "没有还缺清单的事，点右下角的 ＋ 记一条。" : "还没有记录，在上面记一条。")
              : "这里没有任务。"}
          </div>
        )}
      </div>
    </section>
  );
}

