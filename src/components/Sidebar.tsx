// 侧栏：常驻五项（随手记/今天/习惯/计划/已完成）+ 可展开的「更多」+ 清单/需求方/标签。
// 同时是拖拽落点：任务拖到「今天」改今天、「计划」弹日期选择、「随手记」清日期、清单/需求方即归属。
//
// 为什么要折叠：加了习惯之后侧栏太长了。偶尔才看的视图收进「更多」，
// 清单/需求方/标签各只列 3 个，剩下的点一下才出来。展开状态记在本机 localStorage——
// 它是「这台机器的界面偏好」，不该跟着云同步跑到另一台设备上去。
//
// 清单和需求方还能**拖着换顺序**（拖清单到另一张清单上面）。清单的顺序跟数据走，
// 需求方的顺序存在设置里（每台设备各排各的，见 Settings.whoOrder）。
// 换顺序有两套手势：鼠标走 HTML5 拖拽，手指走「按住不动进排序模式」——
// 后者是必须的，HTML5 拖拽在触摸屏上根本不触发（见 core/touchSort.ts）。
import { useEffect, useRef, useState } from "react";
import { addDays, dayOfWeek, todayYMD, cmpYMD } from "../core/dates";
import {
  addList, addTasksWho, aliveTasks, allTags, allWho, deleteTasks, habitsOpenToday, moveList,
  moveWho, navigate, openRows, removeSubtask, rowDue, rowTaskIds, setTasksDue, setTasksList,
  updateSubtask, useApp, type ViewId,
} from "../core/store";
import { LIST_COLORS } from "../core/model";
import {
  IDLE, LONG_PRESS_MS, cancel, down, hold, move, up, type SortState,
} from "../core/touchSort";
import iconUrl from "../../src-tauri/icons/32x32.png";

function Ico({ d }: { d: string }) {
  return (
    <svg className="ico" viewBox="0 0 24 24">
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  inbox: "M3 21l3.6-.7L20 6.9a2.12 2.12 0 0 0-3-3L3.7 17.4 3 21z M14.4 6.5l3.1 3.1",
  today: "M12 8a4 4 0 100 8 4 4 0 000-8z M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1",
  plan: "M4 6h16 M4 12h16 M4 18h10",
  done: "M20 6L9 17l-5-5",
  guide: "M12 19c-2-1.4-4.2-2-7-2V5c2.8 0 5 .6 7 2 2-1.4 4.2-2 7-2v12c-2.8 0-5 .6-7 2z M12 7v12",
  calendar: "M3 5h18v16H3z M8 3v4M16 3v4M3 10h18M9 10v11M15 10v11M3 15.5h18",
  focus: "M12 5a8 8 0 100 16 8 8 0 000-16z M12 9v4l3 2 M9 2h6",
  stats: "M4 20V10 M10 20V4 M16 20v-9 M21 20H3",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
  // 习惯：循环箭头里打个勾——重复着做，做一次记一次
  habits: "M20.5 12a8.5 8.5 0 1 1-2.6-6.1 M20.5 3.5v4h-4 M8.6 12.2l2.4 2.4 4.6-4.8",
} as const;

/** 折叠组默认只露几个 */
const PEEK = 3;

/** 侧栏的展开/收起状态。存本机、不同步——换台设备用什么样子是那台设备自己的事 */
function useFold(key: string, initial: boolean): [boolean, () => void] {
  const lsKey = `acorn-side-${key}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(lsKey);
      return raw === null ? initial : raw === "1";
    } catch {
      return initial;
    }
  });
  return [
    open,
    () =>
      setOpen((v) => {
        try {
          localStorage.setItem(lsKey, v ? "0" : "1");
        } catch {
          /* 隐私模式之类存不了就算了，只是这次会话不记住 */
        }
        return !v;
      }),
  ];
}

/** 从拖拽事件里取任务 id 组（TaskRow onDragStart 放进去的，多选拖拽是逗号串） */
function draggedTaskIds(e: React.DragEvent): string[] {
  const raw = e.dataTransfer.getData("text/acorn-task");
  return raw ? raw.split(",").filter(Boolean) : [];
}

/** 拖的是不是一条子任务行。是的话改日期只该改这一条，不能把整件事挪走 */
function draggedSub(e: React.DragEvent): { taskId: string; subId: string } | null {
  const raw = e.dataTransfer.getData("text/acorn-sub");
  if (!raw) return null;
  const [taskId, subId] = raw.split(":");
  return taskId && subId ? { taskId, subId } : null;
}

/** 拖拽落点统一改期：子任务行只动自己，母任务行（可能多选）整组走。
 *  子任务被拖回「随手记」= 放弃自己的日期，重新跟着母任务走 */
function dropDue(e: React.DragEvent, ids: string[], due: string | null) {
  const s = draggedSub(e);
  if (s) updateSubtask(s.taskId, s.subId, due ? { due } : { due: null, dueTime: null });
  else setTasksDue(ids, due);
}

/** 同一个 li 上挂了两套拖拽（接任务 / 换位置），同名回调要挨个调过去，不能后者盖前者 */
function mergeDrop(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a, ...b };
  for (const k of Object.keys(a)) {
    const fa = a[k];
    const fb = b[k];
    if (typeof fa === "function" && typeof fb === "function") {
      out[k] = (e: React.DragEvent) => {
        (fa as (e: React.DragEvent) => void)(e);
        (fb as (e: React.DragEvent) => void)(e);
      };
    }
  }
  return out;
}

/** 侧栏内部的「换位置」拖拽：清单拖清单、需求方拖需求方。
 *  跟「任务拖到侧栏」是两套 dataTransfer 类型，互不干扰 */
function reorderProps(
  kind: "list" | "who",
  self: string,
  onDrop: (dragged: string) => void,
  hint: { over: string | null; set: (v: string | null) => void },
) {
  const type = `text/acorn-${kind}-move`;
  const key = `${kind}:${self}`;
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(type, self);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(type)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (hint.over !== key) hint.set(key);
    },
    onDragLeave: () => hint.set(hint.over === key ? null : hint.over),
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(type)) return;
      e.preventDefault();
      e.stopPropagation();
      hint.set(null);
      const dragged = e.dataTransfer.getData(type);
      if (dragged && dragged !== self) onDrop(dragged);
    },
    onDragEnd: () => hint.set(null),
  };
}

/** 手指版的「换位置」：按住不动一会儿进排序模式，移动改落点，抬手落位。
 *  跟上面那套 HTML5 拖拽并存——鼠标走那套，手指走这套，靠 pointerType 分流。
 *  时序判定（滑动算滚动 / 没到时长算点击 / 排完序吞掉那一下点击）在 core/touchSort.ts，那边有单测。 */
function useLongPressSort(
  kind: "list" | "who",
  onDrop: (from: string, to: string) => void,
  hint: { over: string | null; set: (v: string | null) => void },
) {
  const [st, setSt] = useState<SortState>(IDLE);
  const timer = useRef<number | null>(null);
  // 排完序松手时浏览器还会补一次 click，不吞掉的话「换个位置」会顺手跳进这张清单
  const swallow = useRef(false);

  function stopTimer() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  // 排序中要把页面按住。React 的 onTouchMove 是被动监听，preventDefault 无效，
  // 必须自己挂一个 passive:false 的原生监听，否则手指一动侧栏就滚走了。
  useEffect(() => {
    if (st.phase !== "sorting") return;
    const block = (e: TouchEvent) => e.preventDefault();
    document.addEventListener("touchmove", block, { passive: false });
    return () => document.removeEventListener("touchmove", block);
  }, [st.phase]);

  useEffect(() => stopTimer, []);

  /** 手指底下压着的是哪一项。用实时命中测试而不是记录每行的位置——侧栏会折叠、会滚 */
  function keyAt(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const row = el?.closest?.(`[data-sort^="${kind}:"]`) as HTMLElement | null;
    const k = row?.getAttribute("data-sort");
    return k ? k.slice(kind.length + 1) : null;
  }

  function finish(next: SortState) {
    stopTimer();
    setSt(next);
    hint.set(null);
  }

  return {
    /** 这一项现在正被拎着吗（界面上要浮起来） */
    lifted: (self: string) => st.phase === "sorting" && st.self === self,
    /** 刚排完序的那一下 click 要不要吞掉。读一次就复位 */
    swallowClick: () => {
      const v = swallow.current;
      swallow.current = false;
      return v;
    },
    props: (self: string) => ({
      "data-sort": `${kind}:${self}`,
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType === "mouse") return; // 鼠标继续走 HTML5 拖拽那套
        const next = down(st, self, e.clientX, e.clientY);
        if (next === st) return;
        swallow.current = false;
        setSt(next);
        // 抓住指针：手指滑出这一行之后还要继续收到 move / up
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        stopTimer();
        timer.current = window.setTimeout(() => setSt((s) => hold(s)), LONG_PRESS_MS);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (st.phase === "idle") return;
        const next = move(st, e.clientX, e.clientY, keyAt);
        if (next === st) return;
        if (next.phase === "idle") stopTimer(); // 判成滚动了，计时器也得停
        setSt(next);
        hint.set(next.over ? `${kind}:${next.over}` : null);
      },
      onPointerUp: () => {
        if (st.phase === "idle") return;
        const r = up(st);
        swallow.current = r.sorted;
        finish(r.next);
        if (r.drop) onDrop(r.drop.from, r.drop.to);
      },
      onPointerCancel: () => finish(cancel()),
    }),
  };
}

export default function Sidebar(
  { drawerOpen = false, onNavigate }: { drawerOpen?: boolean; onNavigate?: () => void } = {},
) {
  const view = useApp((s) => s.ui.view);
  const curList = useApp((s) => s.ui.listId);
  const curWho = useApp((s) => s.ui.who);
  const curTag = useApp((s) => s.ui.tag);
  const data = useApp((s) => s.data);
  const loadError = useApp((s) => s.loadError);
  const [addingList, setAddingList] = useState(false);
  const [dropHint, setDropHint] = useState<string | null>(null);
  /** 侧栏内部换位置时，鼠标正悬在哪一条上（画一条落点线） */
  const [moveOver, setMoveOver] = useState<string | null>(null);
  const moveHint = { over: moveOver, set: setMoveOver };
  const listSort = useLongPressSort("list", (from, to) => moveList(from, to), moveHint);
  const whoSort = useLongPressSort("who", (from, to) => moveWho(from, to), moveHint);
  /** 拖到「计划」后待定日期的任务组 + 弹层位置（落点处）。sub 非空 = 拖的是一条子任务行，只改它 */
  const [pendingPlan, setPendingPlan] = useState<
    { ids: string[]; sub: { taskId: string; subId: string } | null; x: number; y: number } | null
  >(null);
  /** 弹层里选定日期后的落点：跟拖拽落点同一套口径 */
  const planTo = (due: string) => {
    if (!pendingPlan) return;
    if (pendingPlan.sub) updateSubtask(pendingPlan.sub.taskId, pendingPlan.sub.subId, { due });
    else setTasksDue(pendingPlan.ids, due);
    setPendingPlan(null);
  };

  const today = todayYMD();
  const open = aliveTasks(data).filter((t) => !t.done);
  const rows = openRows(data);
  // 计数按「行」算，跟点进去实际看到的条数对得上（有子任务的事已经拆成一行一个子任务）
  const counts = {
    inbox: open.filter((t) => !t.listId && !t.due).length,
    today: rows.filter((r) => {
      const due = rowDue(r);
      return due && cmpYMD(due, today) <= 0;
    }).length,
    // 按「件」算，跟点进去标题上那个「N 件未完成」是同一个数。
    // 一件事拆成几行子任务时，侧栏显示 3 而视图标题显示 1 会让人以为哪儿漏了
    plan: rowTaskIds(rows).length,
    trash: data.tasks.filter((t) => t.deletedAt).length,
    habits: habitsOpenToday(data, today),
  };
  const whoList = allWho(data);
  const tagList = allTags(data);

  const [moreOpen, toggleMore] = useFold("more", false);
  const [listsOpen, toggleLists] = useFold("lists", false);
  const [whoOpen, toggleWho] = useFold("who", false);
  const [tagsOpen, toggleTags] = useFold("tags", false);

  const lists = [...data.lists].sort((a, b) => a.order - b.order);
  // 正看着的东西如果被折在下面，就得露出来——否则界面上没有任何地方显示「你在哪」
  const MORE_VIEWS: ViewId[] = ["calendar", "focus", "stats", "guide", "trash"];
  const showMore = moreOpen || MORE_VIEWS.includes(view);
  const curListHidden =
    view === "list" && lists.findIndex((l) => l.id === curList) >= PEEK;
  const curWhoHidden = view === "who" && whoList.findIndex((w) => w.who === curWho) >= PEEK;
  const curTagHidden = view === "tag" && tagList.findIndex((t) => t.tag === curTag) >= PEEK;
  const showLists = listsOpen || curListHidden || addingList;
  const showWho = whoOpen || curWhoHidden;
  const showTags = tagsOpen || curTagHidden;

  /** 「还有 N 个 ▾ / 收起 ▴」那一行 */
  const moreRow = (hidden: number, open: boolean, onClick: () => void) =>
    hidden <= 0 ? null : (
      <li className="side-more" onClick={onClick}>
        <span className="side-more-txt">{open ? "收起" : `还有 ${hidden} 个`}</span>
        <span className="side-caret">{open ? "▴" : "▾"}</span>
      </li>
    );

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
      onClick={() => { navigate(id); onNavigate?.(); }}
      {...(drop ? dropProps(id, drop) : {})}
    >
      <Ico d={ICONS[icon]} />
      {label}
      {n != null && n > 0 && <span className={`n${hot ? " hot" : ""}`}>{n}</span>}
    </li>
  );

  return (
    <aside className={`side${drawerOpen ? " open" : ""}`}>
      <div className="brand">
        <img src={iconUrl} alt="" />
        橡果
      </div>
      <nav>
        <ul>
          {item("inbox", "随手记", "inbox", counts.inbox, false, (ids, e) => dropDue(e, ids, null))}
          {item("today", "今天", "today", counts.today, true, (ids, e) => dropDue(e, ids, today))}
          {item("habits", "习惯", "habits", counts.habits, true)}
          {/* 计划 = 所有没做完的事（原来的「全部」）。拖任务过来仍然是弹日期选择 */}
          {item("plan", "计划", "plan", counts.plan, false, (ids, e) =>
            setPendingPlan({ ids, sub: draggedSub(e), x: e.clientX, y: e.clientY }),
          )}
          {/* 不挂角标：其它角标的意思都是「还欠着多少」，已完成是历史累计，
              摆一起口径相反，而且这个数只会越来越大，看久了变成噪音 */}
          {item("done", "已完成", "done")}
        </ul>
        {pendingPlan && (
          <div
            className="popmenu side-plan-pop"
            style={{ left: Math.min(pendingPlan.x, window.innerWidth - 220), top: Math.min(pendingPlan.y, window.innerHeight - 220), position: "fixed" }}
          >
            <div style={{ fontSize: 12, color: "var(--ink-2)", padding: "4px 10px" }}>
              安排到哪天？
              {pendingPlan.sub ? "（这条子任务）" : pendingPlan.ids.length > 1 ? `（${pendingPlan.ids.length} 项）` : ""}
            </div>
            <button className="item" onClick={() => planTo(addDays(today, 1))}>明天</button>
            <button className="item" onClick={() => { const wd = dayOfWeek(today); planTo(addDays(today, wd === 0 ? 1 : 8 - wd)); }}>下周一</button>
            <input
              className="inline"
              type="date"
              onChange={(e) => {
                if (e.target.value) planTo(e.target.value);
              }}
            />
            <button className="item" onClick={() => setPendingPlan(null)}>取消</button>
          </div>
        )}
        {/* 不常用的收进这里。默认收起——加了习惯之后侧栏太长了 */}
        <div className={`group-title fold${showMore ? " on" : ""}`} onClick={toggleMore}>
          更多
          <span className="side-caret">{showMore ? "▴" : "▾"}</span>
        </div>
        {showMore && (
          <ul>
            {item("calendar", "日历", "calendar")}
            {item("focus", "专注", "focus")}
            {item("stats", "统计", "stats")}
            {item("guide", "用法", "guide")}
            {/* 回收站：删掉的事在这儿待 30 天。也是拖拽落点——拖过来就是删掉（还能撤销、还能在这里恢复） */}
            {item("trash", "回收站", "trash", counts.trash, false, (ids, e) => {
              const s = draggedSub(e);
              if (s) removeSubtask(s.taskId, s.subId);
              else deleteTasks(ids);
            })}
          </ul>
        )}
        <div className="group-title">
          清单
          <button title="新建清单" onClick={() => setAddingList(true)}>＋</button>
        </div>
        <ul>
          {(showLists ? lists : lists.slice(0, PEEK)).map((l) => {
            const n = open.filter((t) => t.listId === l.id).length;
            return (
              <li
                key={l.id}
                className={`${view === "list" && curList === l.id ? "on" : ""}${dropHint === `list-${l.id}` ? " dropping" : ""}${moveOver === `list:${l.id}` ? " move-over" : ""}${listSort.lifted(l.id) ? " lifted" : ""}`}
                title="拖着可以换位置（手机上按住不放）"
                onClick={() => {
                  if (listSort.swallowClick()) return;
                  navigate("list", { listId: l.id });
                  onNavigate?.();
                }}
                {...listSort.props(l.id)}
                {...mergeDrop(
                  dropProps(`list-${l.id}`, (ids) => setTasksList(ids, l.id)),
                  reorderProps("list", l.id, (dragged) => moveList(dragged, l.id), moveHint),
                )}
              >
                <span className="dot" style={{ background: `var(--list-${l.color})` }} />
                {l.name}
                {n > 0 && <span className="n">{n}</span>}
              </li>
            );
          })}
          {moreRow(lists.length - PEEK, showLists, toggleLists)}
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
              {(showWho ? whoList : whoList.slice(0, PEEK)).map(({ who, open: n }) => (
                <li
                  key={who}
                  className={`${view === "who" && curWho === who ? "on" : ""}${dropHint === `who-${who}` ? " dropping" : ""}${moveOver === `who:${who}` ? " move-over" : ""}${whoSort.lifted(who) ? " lifted" : ""}`}
                  title="拖着可以换位置（手机上按住不放）"
                  onClick={() => {
                    if (whoSort.swallowClick()) return;
                    navigate("who", { who });
                    onNavigate?.();
                  }}
                  {...whoSort.props(who)}
                  {...mergeDrop(
                    dropProps(`who-${who}`, (ids) => addTasksWho(ids, who)),
                    reorderProps("who", who, (dragged) => moveWho(dragged, who), moveHint),
                  )}
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
              {moreRow(whoList.length - PEEK, showWho, toggleWho)}
            </ul>
          </>
        )}
        {tagList.length > 0 && (
          <>
            <div className="group-title">标签</div>
            <ul>
              {(showTags ? tagList : tagList.slice(0, PEEK)).map(({ tag, open: n }) => (
                <li
                  key={tag}
                  className={view === "tag" && curTag === tag ? "on" : ""}
                  onClick={() => { navigate("tag", { tag }); onNavigate?.(); }}
                >
                  <span style={{ color: "var(--ink-3)", fontSize: 12, width: 8, textAlign: "center" }}>#</span>
                  {tag}
                  {n > 0 && <span className="n">{n}</span>}
                </li>
              ))}
              {moreRow(tagList.length - PEEK, showTags, toggleTags)}
            </ul>
          </>
        )}
      </nav>
      <div className="foot">
        {loadError ? <span className="bad" title={loadError} /> : <span className="ok" />}
        {loadError ? "数据异常" : "数据已就绪"}
        <button className="gear" title="设置" onClick={() => { navigate("settings"); onNavigate?.(); }}>⚙</button>
      </div>
    </aside>
  );
}
