// 桌面侧栏按模块自由排序；分组独立收展，实体横条拖动时邻项实时让位。
// 模块排布/隐藏/显示别名只在本机生效，任务拖入侧栏的原有动作照常保留。
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { todayYMD, cmpYMD } from "../core/dates";
import { dateOptions } from "../core/options";
import { isMobile } from "../core/platform";
import { parentRowsForToday } from "../core/parentRows";
import {
  addTasksWho, aliveTasks, allTags, allWho, appStore, categoryRows, deleteTasks, habitsOpenToday,
  moveList, moveWho, navigate, openRows, removeSubtask, rowDue, rowTaskIds, setChangelogOpen,
  setQuickAddOpen, setTasksDue, setTasksList, updateSubtask, updateTask, useApp, type ViewId,
  trashedSubtaskRows, updateSettings,
} from "../core/store";
import { createCategory } from "../core/categoryCreation";
import { categoryIcon } from "../core/categoryIcons";
import { listColor } from "../core/colors";
import { shortVersion } from "../core/version";
import { forceFoldOpen, useFold } from "../core/useFold";
import { moveSidebarModule, sidebarHidden, sidebarModules, sidebarName, SIDEBAR_MODULES, type SidebarModuleId } from "../core/sidebar";
import SidebarIcon from "./SidebarIcon";
import Icon from "./Icon";
import SidebarModuleMenu, { type SidebarMenuTarget } from "./SidebarModuleMenu";
import { useSidebarModuleDrag } from "./sidebarModuleDrag";
import "../styles/sidebar.css";
import DateField from "./DateField";
import type { DateFieldHandle } from "./DateField";
import { useLeaving } from "./motion";
import { dismissRestored, syncFootState, useSync } from "../core/syncCtl";
import { openFoundUpdate, updateFootState, useUpdate } from "../core/updateCtl";
import {
  IDLE, LONG_PRESS_MS, cancel, down, hold, move, up, type SortState,
} from "../core/touchSort";
import iconUrl from "../../src-tauri/icons/32x32.png";

/** 跳进设置页之后，把「云账号」那一节滚到眼前。
 *
 *  晚一拍再找那个锚点：navigate 只是排了一次渲染，这会儿设置页还没挂上来。
 *  找不到就静静算了——人已经在设置页里了，往下翻两行照样看得见，不值得为它报错。
 *
 *  开了「减少动态效果」就直接跳过去，不做平滑滚动：base.css 那个 reduced-motion 块
 *  只压 animation-duration / transition-duration，管不了脚本发起的滚动；
 *  而滚动动画正是 reduced-motion 首要要抑制的一类（前庭不适）。 */
function revealSetSection(key: string, anchorId: string): void {
  // 设置页现在分节可折叠（v1.9.1）：那一节要是收着，滚到一个收起的标题上用户什么也看不见。
  // 先把它打开（写进记忆 + 广播给已挂载的那一页），再滚
  forceFoldOpen(key, "acorn-set-");
  const still =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  setTimeout(() => {
    document.getElementById(anchorId)?.scrollIntoView({
      behavior: still ? "auto" : "smooth",
      block: "start",
    });
  }, 60);
}

const revealCloudSection = () => revealSetSection("cloud", "set-cloud");
/** 「数据异常」那行字点了去的地方：设置 → 数据（换文件夹、看备份都在那儿）。
 *  v1.15.0 之前那行是一句死字，看见了也没地方去 */
const revealDataSection = () => revealSetSection("data", "set-data");

const ICONS = Object.fromEntries(SIDEBAR_MODULES.map((m) => [m.id, m.icon])) as Record<SidebarModuleId, string>;

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
 *  due 传 null = 连时间一起清掉（子任务清掉自己的日期就重新跟着母任务走） */
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
      e.stopPropagation();
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
  // B8：只订阅自己真用得上的那三片，别整份 data 一变就跟着走。
  // 侧栏里几处派生（openRows / allWho / allTags / 计数）以前是**每次渲染都全量重算一遍**——
  // 而侧栏自己有一堆本地状态（拖拽落点、排序悬停、新建清单…），拖一下就重算几十次
  const tasks = useApp((s) => s.data.tasks);
  const rawLists = useApp((s) => s.data.lists);
  const settings = useApp((s) => s.data.settings);
  const loadError = useApp((s) => s.loadError);
  // 同步状态得在主界面上有块表盘：以前只在 设置 → 云账号 里显示，
  // 而升级、令牌过期、断网都会让同步无声停摆，用户要等到某天点开设置才发现。
  // 分三个 selector 取而不是整份算：syncFootState 每次都返回新对象，整份取会一直重渲染
  const syncSession = useSync((s) => s.session);
  const syncPhase = useSync((s) => s.phase);
  const syncNeedsUpgrade = useSync((s) => s.needsUpgrade);
  const sync = syncFootState({
    session: syncSession, phase: syncPhase, needsUpgrade: syncNeedsUpgrade,
  });
  /** 开机自动从云端取回了一份（v1.15.0）。这台设备上原来一个账本文件都没有，
   *  橡果自己把云端那份拿了回来——得当面给用户一句回执，否则事情凭空出现，比不出现更吓人 */
  const restored = useSync((s) => s.restored);
  // 版本检查也要在这行里有个交代。用户新装完打开橡果，以前「已是最新」是完全安静的，
  // 看不出到底查没查过（2026-09-02 反馈：「下载后没有检查更新的消息框」）。
  // 同样克制：不弹框不弹 toast，就这行小字加一截
  const updCheck = useUpdate((s) => s.lastCheck);
  const upd = updateFootState(updCheck);
  /** 每个分组独立记住展开状态，折起不影响整组排序。 */
  const [listsOpen, toggleLists] = useFold("lists", true);
  const [whoOpen, toggleWho] = useFold("who", true);
  const [tagsOpen, toggleTags] = useFold("tags", true);
  const groupOpen = { lists: listsOpen, who: whoOpen, tags: tagsOpen };
  const toggleGroup = { lists: toggleLists, who: toggleWho, tags: toggleTags };
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
  /** 退场那一拍里弹层还得挂在树上（B6），否则关掉是「啪一下没了」 */
  const planPop = useLeaving(pendingPlan);
  /** 弹层里那个日期框（DateField）的三个手：点弹层外先 flush，Esc 是 cancel */
  const planFieldRef = useRef<DateFieldHandle | null>(null);
  /** 「安排到哪天？」**打开那一刻**这几件事各自的日子（弹层没开着 = null；
   *  拖的是一条子任务也是 null——子任务没有顺延计数这回事）。
   *  跟任务卡同一套口径：顺延按「弹层开 → 弹层关」整段算**一次**，见 settlePlanPopup */
  const planDueAtOpenRef = useRef<Record<string, string> | null>(null);
  /** **这次弹层自己在日期框里写进去的那个日子**（undefined = 没在日期框里写过）。
   *  结算只认它，不认 store 里当下那个 due——弹层开着时别处改的日期不该算到这一笔上。
   *  点预设那条路一次到位、照旧就地计数，写完把它清回 undefined，免得关弹层再数一遍 */
  const planWrittenRef = useRef<string | undefined>(undefined);
  /** 这次弹层的撤销合并键（整个弹层共用一把）。日期写入和关弹层时补的那几次 postponeCount
   *  必须用同一把，才并得成一格撤销——每个 id 各用各的键是并不上的 */
  const planCoalesceRef = useRef<string | undefined>(undefined);
  /** 关弹层时的结算。effect 的清理跑的是「弹层刚开那一帧」的闭包，用 ref 保证结算的永远是最新那一份 */
  const settlePlanRef = useRef<() => void>(() => {});
  /** 弹层里选定日期后的落点：跟拖拽落点同一套口径。
   *
   *  `close` 默认 true（点预设 = 话说完了，设好就收）。**日期框那条路必须传 false**：
   *  键盘正敲在框里，落一次库就把弹层连同框一起拆掉，用户敲「2026 / 10 / 15」时
   *  日段刚敲下「1」就当场按 10-01 排期并关窗，后面那个「5」打在空气上，还顺手 +1 顺延。
   *  收弹层归 DateField 的 onDone（真的点走了才收） */
  const planTo = (due: string, close = true) => {
    if (!pendingPlan) return;
    if (pendingPlan.sub) updateSubtask(pendingPlan.sub.taskId, pendingPlan.sub.subId, { due });
    // 日期框那条路（close=false）一次弹层能落好几次库：去抖落一次、月份点错了在同一个弹层里
    // 改一次又落一次，每次都数就是「安排一次净加 2」——正好是「顺延×2」和周报那句
    // 「（顺延 N 次）」的门槛，而这个数没有任何入口能清零。所以那条路一律不数，
    // 留给关弹层时统一结算一次（settlePlanPopup）；点预设一次到位，照旧就地数
    // 日期框那条路（close=false）要跟关弹层时补的那几次 postponeCount 并成同一格撤销：
    // 不并的话「拖 3 件去排期」得按 4 下 Ctrl+Z 日期才回得去，而撤销栈只有 10 格
    else if (close) setTasksDue(pendingPlan.ids, due);
    else {
      const key = `plan:${pendingPlan.ids.join(",")}:due`;
      planCoalesceRef.current = key;
      setTasksDue(pendingPlan.ids, due, { noPostponeCount: true, coalesceKey: key });
    }
    planWrittenRef.current = close ? undefined : due;
    if (close) setPendingPlan(null);
  };

  /** 关弹层时结算「顺延次数」——**整段只算这一次**，跟任务卡的 settleDuePopup 是同一套。
   *
   *  为什么不能让 setTasksDue 按落库次数数：原生 date 是分段控件，一次「安排到哪天」
   *  能落好几次库（键盘敲月段停手落一次、敲日段停手又落一次；或者选完发现月份点错了
   *  在同一个弹层里改一次），逐次计数就是净加 2。跟停手时长较劲永远有漏，
   *  所以改成跟时长完全无关的算法：「这件事被往后推了几次」= 数弹层，不是数写库。
   *
   *  认的是**这次弹层自己写过的那个日子**（planWrittenRef），不是 store 里当下那个 due——
   *  拿现值当依据会把别处的改动（Ctrl+→ 推明天、勾掉一件循环任务）算到这一笔上。 */
  function settlePlanPopup() {
    // 还欠着的那一次先做掉：它也算「这次弹层写的」，不做掉就漏了这一笔
    planFieldRef.current?.flush();
    const before = planDueAtOpenRef.current;
    const written = planWrittenRef.current;
    const key = planCoalesceRef.current;
    planDueAtOpenRef.current = null;
    planWrittenRef.current = undefined;
    planCoalesceRef.current = undefined;
    if (!before) return; // 拖的是子任务：没有顺延计数这回事
    if (written === undefined) return; // 这次弹层没在日期框里写过（点了预设 / 取消 / Esc）
    for (const [id, at] of Object.entries(before)) {
      if (!at) continue; // 打开时本来就没日期 = 从无到有，不算顺延（跟 store 那边同口径）
      if (cmpYMD(written, at) <= 0) continue; // 没往后挪（改早了 / 绕一圈又改回来了）
      const cur = appStore.getState().data.tasks.find((t) => t.id === id);
      if (!cur) continue;
      // 跟刚才那次日期写入并成同一格撤销：不然改一次日期吃掉两格（栈只有 10 格）。
      // 用的是 planTo 里那把键（整个弹层共用一把），不是 `task:<id>:due`——
      // 后者跟 setTasksDue 那次写入的键对不上，多选时每个 id 还各不相同，一格都并不上
      updateTask(id, { postponeCount: cur.postponeCount + 1 }, { coalesceKey: key });
    }
  }
  settlePlanRef.current = settlePlanPopup;

  const today = todayYMD();
  // 「还欠着的」= 没做完**也没放弃**。放弃跟完成同一个口径（v1.9.0 收口）：
  // 它们都是了结了的事，两种都不进这个数，也都不出现在清单/需求方/标签里。
  // 这里改了口径，清单角标跟着一起改，跟 counts.plan（走 openRows）对齐
  const open = useMemo(() => aliveTasks({ tasks }).filter((t) => !t.done && !t.droppedAt), [tasks]);
  const rows = useMemo(() => openRows({ tasks }), [tasks]);
  const todayParents = useMemo(() => isMobile ? null : parentRowsForToday({ tasks, settings }, today), [tasks, settings, today]);
  // 桌面今日按合并后的母任务计数；手机继续原有到期步骤行计数。
  const counts = useMemo(
    () => ({
      today: todayParents ? todayParents.overdue.length + todayParents.todays.length : rows.filter((r) => {
        const due = rowDue(r);
        return due && cmpYMD(due, today) <= 0;
      }).length,
      // 按「件」算，跟点进去标题上那个「N 件未完成」是同一个数。
      // 一件事拆成几行子任务时，侧栏显示 3 而视图标题显示 1 会让人以为哪儿漏了
      plan: rowTaskIds(rows).length,
      // 回收站里一行一条：整件事 + 单独删掉的子任务（v1.13.0），角标跟页面里的行数对得上
      trash: tasks.filter((t) => t.deletedAt).length + trashedSubtaskRows({ tasks }).length,
      habits: habitsOpenToday({ tasks }, today),
    }),
    [tasks, open, rows, today, todayParents],
  );
  const whoList = useMemo(() => allWho({ tasks, settings }), [tasks, settings]);
  const tagList = useMemo(() => allTags({ tasks }), [tasks]);

  const lists = useMemo(() => [...rawLists].sort((a, b) => a.order - b.order), [rawLists]);
  const storedModules = sidebarModules(settings.sidebar).filter((m) => !sidebarHidden(m.id, settings.sidebar));
  const [moduleMenu, setModuleMenu] = useState<SidebarMenuTarget | null>(null);
  const moduleDrag = useSidebarModuleDrag((from, to) => {
    const next = moveSidebarModule(appStore.getState().data.settings.sidebar, from, to);
    if (next) updateSettings({ sidebar: next });
  });
  const modules = moduleDrag.previewOrder ? [...storedModules].sort((a, b) => moduleDrag.previewOrder!.indexOf(a.id) - moduleDrag.previewOrder!.indexOf(b.id)) : storedModules;
  function editSidebar() {
    navigate("settings");
    onNavigate?.();
    revealSetSection("sidebar", "set-sidebar");
  }
  function openModuleMenu(e: React.MouseEvent | React.KeyboardEvent, id: SidebarModuleId) {
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    setModuleMenu({ id, x: "clientX" in e ? e.clientX : box.left, y: "clientY" in e ? e.clientY : box.bottom });
  }
  function moduleKeys(e: React.KeyboardEvent, id: SidebarModuleId) {
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) openModuleMenu(e, id);
  }

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
        if (!e.dataTransfer.types.includes("text/acorn-task")) return;
        e.preventDefault();
        e.stopPropagation();
        setDropHint(null);
        const ids = draggedTaskIds(e);
        if (ids.length) onDrop(ids, e);
      },
    };
  }

  // 「计划」弹层：Esc / 点弹层外关闭。
  // 顺带记账：一开记下这几件事当时各自的日子，一关（不管走哪条路）统一结算一次顺延
  useEffect(() => {
    if (!pendingPlan) return;
    const now = appStore.getState().data.tasks;
    planDueAtOpenRef.current = pendingPlan.sub
      ? null
      : Object.fromEntries(
        pendingPlan.ids.map((id) => [id, now.find((t) => t.id === id)?.due ?? ""]),
      );
    planWrittenRef.current = undefined;
    function onKey(e: KeyboardEvent) {
      // Esc 才是丢弃：日期框里刚敲了一半、还欠着的那一次一并作废，
      // 这次弹层也不许被记成一次顺延（把记账清空，结算那儿直接 return）
      if (e.key === "Escape") {
        planFieldRef.current?.cancel();
        planWrittenRef.current = undefined;
        setPendingPlan(null);
      }
    }
    function onDoc(e: MouseEvent) {
      if ((e.target as HTMLElement).closest(".side-plan-pop")) return;
      // 点走 = 提交：先把日期框里还欠着的那一次做掉，再收弹层
      planFieldRef.current?.flush();
      setPendingPlan(null);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
      settlePlanRef.current();
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
      tabIndex={0}
      title="拖动调整模块顺序，右键编辑或隐藏"
      onClick={() => { if (moduleDrag.swallowClick()) return; navigate(id); onNavigate?.(); }}
      onContextMenu={(e) => openModuleMenu(e, id as SidebarModuleId)}
      onKeyDown={(e) => {
        moduleKeys(e, id as SidebarModuleId);
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(id); onNavigate?.(); }
      }}
      {...(drop ? dropProps(id, drop) : {})}
      {...moduleDrag.source(id)}
    >
      <span className="sidebar-drag-grip" aria-hidden="true">⠿</span>
      <SidebarIcon path={ICONS[icon]} />
      <span className="side-label">{sidebarName(id as SidebarModuleId, settings.sidebar) || label}</span>
      {n != null && n > 0 && <span className={`n${hot ? " hot" : ""}`}>{n}</span>}
    </li>
  );

  const moduleBodies = {
    plan: item("plan", "计划", "plan", counts.plan, false, (ids, e) =>
      setPendingPlan({ ids, sub: draggedSub(e), x: e.clientX, y: e.clientY })),
    calendar: item("calendar", "日历", "calendar"),
    today: item("today", "今日任务", "today", counts.today, true, (ids, e) => dropDue(e, ids, today)),
    habits: item("habits", "习惯", "habits", counts.habits, true),
    done: item("done", "已完成", "done"),
    focus: item("focus", "专注", "focus"),
    stats: item("stats", "统计", "stats"),
    trash: item("trash", "回收站", "trash", counts.trash, false, (ids, e) => {
      const sub = draggedSub(e);
      if (sub) removeSubtask(sub.taskId, sub.subId);
      else deleteTasks(ids);
    }),
    lists: (
        <ul>
          {lists.map((l) => {
            const n = categoryRows({ tasks }, { listId: l.id }).length;
            return (
              <li
                key={l.id}
                className={`${view === "list" && curList === l.id ? "on" : ""}${dropHint === `list-${l.id}` ? " dropping" : ""}${moveOver === `list:${l.id}` ? " move-over" : ""}${listSort.lifted(l.id) ? " lifted" : ""}`}
                title="拖动可以换位置（手机上长按）"
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
                <span className="sidebar-drag-grip" aria-hidden="true">⠿</span><SidebarIcon path={categoryIcon("list", l.icon)} color={listColor(l.color)} />
                <span className="side-label">{l.name}</span>
                {n > 0 && <span className="n">{n}</span>}
              </li>
            );
          })}
        </ul>

    ),
    who: (
            <ul>
              {whoList.map(({ who, open: n }) => (
                <li
                  key={who}
                  className={`${view === "who" && curWho === who ? "on" : ""}${dropHint === `who-${who}` ? " dropping" : ""}${moveOver === `who:${who}` ? " move-over" : ""}${whoSort.lifted(who) ? " lifted" : ""}`}
                  title="拖动可以换位置（手机上长按）"
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
                  <span className="sidebar-drag-grip" aria-hidden="true">⠿</span><SidebarIcon path={categoryIcon("who", settings.whoAppearance?.[who]?.icon)} color={settings.whoAppearance?.[who]?.color ? listColor(settings.whoAppearance[who].color) : undefined} />
                  <span className="side-label">{who}</span>
                  {n > 0 && <span className="n">{n}</span>}
                </li>
              ))}
            </ul>
    ),
    tags: (
            <ul>
              {tagList.map(({ tag, open: n }) => (
                <li
                  key={tag}
                  className={view === "tag" && curTag === tag ? "on" : ""}
                  onClick={() => { navigate("tag", { tag }); onNavigate?.(); }}
                >
                  <span className="sidebar-drag-grip spacer" aria-hidden="true" /><SidebarIcon path={ICONS.tags} />
                  <span className="side-label">{tag}</span>
                  {n > 0 && <span className="n">{n}</span>}
                </li>
              ))}
            </ul>
    ),
  };
  const groupCounts = { lists: lists.length, who: whoList.length, tags: tagList.length };

  return (
    <aside className={`side side-modules${drawerOpen ? " open" : ""}`}>
      <div className="brand">
        <img src={iconUrl} alt="" />
        <span className="brand-name">橡果</span>
        {/* 版本号小标签，点开是给使用者看的更新日志（core/changelog.ts，不是 CHANGELOG.md）。
            跟齿轮一样在拖拽区里，CSS 必须 no-drag，还得把 .brand 的 3px 字距复位 */}
        <button className="ver" title="查看更新日志" onClick={() => setChangelogOpen(true)}>{shortVersion()}</button>
        {/* 齿轮跟着标题走：手机上抽屉一拉开就在手边，不用滚到侧栏最底下。
            .brand 是窗口拖拽区，这颗按钮必须在 CSS 里单独 no-drag，否则点不动 */}
        <button className="gear" title="设置" aria-label="设置" onClick={() => { navigate("settings"); onNavigate?.(); }}><Icon name="settings" size={16} /></button>
      </div>
      {/* 记一条：整条侧栏最该一眼看见的那件事，所以是唯一一颗实心按钮。
          它**不是导航项**——记完还留在原来那一页，所以没有选中态，也不调 onNavigate
          （手机上侧栏根本不渲染，抽屉那套跟它无关） */}
      <button className="side-quickadd" title="记一条（Ctrl+1）" onClick={() => setQuickAddOpen(true)}>
        <Icon name="plus" size={17} />
        记一条
      </button>
      <nav aria-label="侧栏">
        {modules.map((m, i) => (
          <section key={m.id} data-sidebar-module={m.id} className={`side-module${m.group ? " side-module-group" : ""}${moduleDrag.over === m.id ? " module-over" : ""}${moduleDrag.floating?.id === m.id ? " module-lifted" : ""}`} {...moduleDrag.target(m.id, modules[i + 1]?.id ?? null)}>
            {m.group ? <>
              <div className="side-module-heading" tabIndex={0} role="button" aria-expanded={groupOpen[m.id as keyof typeof groupOpen]} title="拖动整组排序，右键编辑或隐藏"
                {...moduleDrag.source(m.id)} onClick={() => { if (!moduleDrag.swallowClick()) toggleGroup[m.id as keyof typeof toggleGroup](); }} onContextMenu={(e) => openModuleMenu(e, m.id)} onKeyDown={(e) => { moduleKeys(e, m.id); if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGroup[m.id as keyof typeof toggleGroup](); } }}>
                <span className="side-group-controls">
                  <button type="button" className="side-group-toggle" aria-label={`${groupOpen[m.id as keyof typeof groupOpen] ? "收起" : "展开"}${sidebarName(m.id, settings.sidebar)}`} aria-expanded={groupOpen[m.id as keyof typeof groupOpen]} aria-controls={`side-group-${m.id}`} onClick={(e) => { e.stopPropagation(); toggleGroup[m.id as keyof typeof toggleGroup](); }}>
                    <svg className={`side-group-chevron${groupOpen[m.id as keyof typeof groupOpen] ? " expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
                  </button>
                  {(m.id === "lists" || m.id === "who") && <button type="button" className="side-group-add" title={m.id === "lists" ? "新建清单" : "新建需求方"} aria-label={m.id === "lists" ? "新建清单" : "新建需求方"} onClick={(e) => {
                  e.stopPropagation();
                  void createCategory(m.id === "lists" ? "list" : "who").then((created) => { if (created) forceFoldOpen(m.id); });
                  }}>＋</button>}
                </span>
                <SidebarIcon path={m.icon} /><span className="side-label">{sidebarName(m.id, settings.sidebar)}</span>
                {groupCounts[m.id as keyof typeof groupCounts] > 0 && <span className="n">{groupCounts[m.id as keyof typeof groupCounts]}</span>}
              </div>
              {groupOpen[m.id as keyof typeof groupOpen] && <div id={`side-group-${m.id}`}>
                {moduleBodies[m.id]}
                {m.id === "who" && whoList.length === 0 && <p className="side-group-empty">暂无需求方</p>}
                {m.id === "tags" && tagList.length === 0 && <p className="side-group-empty">暂无标签</p>}
              </div>}
            </> : <ul>{moduleBodies[m.id]}</ul>}
          </section>
        ))}
        <div className={`side-module-end${moduleDrag.over === "end" ? " module-over" : ""}`} {...moduleDrag.target(null)}>
          <button type="button" onClick={editSidebar}><SidebarIcon path="M4 6h16M4 18h16M4 12h16 M8 3v6M16 9v6M10 15v6" />功能区设置</button>
        </div>
        {planPop.shown && (
          <div
            className={`popmenu side-plan-pop${planPop.leaving ? " leaving" : ""}`}
            style={{ left: Math.min(planPop.shown.x, window.innerWidth - 220), top: Math.min(planPop.shown.y, window.innerHeight - 220), position: "fixed" }}
          >
            <div style={{ fontSize: 12, color: "var(--ink-2)", padding: "4px 10px" }}>
              安排到哪天？
              {planPop.shown.sub ? "（这条子任务）" : planPop.shown.ids.length > 1 ? `（${planPop.shown.ids.length} 项）` : ""}
            </div>
            {/* 全应用选日子同一套（core/options.dateOptions）：今天 / 明天 / 本周末 / 下周末 / 本月末，
                下面那个日期框就是「选日期…」。一处算一处用，别在这儿再写一份 */}
            {dateOptions(today, { weekendDay: settings.weekendDay, dateShortcuts: settings.dateShortcuts }).map((p) => (
              <button key={p.key} className="item" onClick={() => planTo(p.ymd)}>{p.label}</button>
            ))}
            {/* 跟另外三处日期框同一个件。这一处以前**三样都没有**（没草稿、没去抖、
                一凑齐就落库并当场关窗），是同一个病复发的第四轮；三件套现在封在 DateField 里，
                这儿只交代「落库那句」和「什么时候收弹层」——落库那句绝不许自己关弹层 */}
            <DateField
              ref={planFieldRef}
              value=""
              onCommit={(ymd) => planTo(ymd, false)}
              onDone={(e) => {
                // 焦点还落在这个弹层里（比如点了一下日期框、又改主意去按上面的「本周五」）
                // 就别收弹层：mousedown 把焦点挪走 → 这儿一收 → 弹层当场进退场态
                // （.leaving 是 pointer-events:none）→ 后面那下 mouseup 落不到按钮上、
                // click 根本不触发，整个拖拽动作静默作废。跟「记一条」那排点选同一道闸
                const next = e.relatedTarget as HTMLElement | null;
                if (next && next.closest(".side-plan-pop")) return;
                setPendingPlan(null);
              }}
            />
            <button className="item" onMouseDown={(e) => e.preventDefault()} onClick={() => {
              planFieldRef.current?.cancel();
              planWrittenRef.current = undefined;
              if (!pendingPlan) return;
              if (pendingPlan.sub) updateSubtask(pendingPlan.sub.taskId, pendingPlan.sub.subId, { due: null, dueTime: null });
              else setTasksDue(pendingPlan.ids, null, { coalesceKey: planCoalesceRef.current ?? `plan:${pendingPlan.ids.join(",")}:due` });
              setPendingPlan(null);
            }}>{pendingPlan?.sub ? "清除日期（继承母任务）" : "清除日期"}</button>
            <button className="item" onClick={() => setPendingPlan(null)}>取消</button>
          </div>
        )}
      </nav>
      {moduleMenu && <SidebarModuleMenu key={moduleMenu.id} target={moduleMenu} onClose={() => setModuleMenu(null)} onEditSidebar={editSidebar} />}
      {moduleDrag.floating && createPortal(<div className="sidebar-module-floating" style={{ left: moduleDrag.floating.x, top: moduleDrag.floating.y, width: moduleDrag.floating.width, height: moduleDrag.floating.height }}>
        <span className="sidebar-drag-grip" aria-hidden="true">⠿</span><SidebarIcon path={ICONS[moduleDrag.floating.id as SidebarModuleId]} /><span className="side-label">{sidebarName(moduleDrag.floating.id as SidebarModuleId, settings.sidebar)}</span>
      </div>, document.body)}
      <div className="foot">
        {loadError ? <span className="bad" title={loadError} /> : <span className="ok" />}
        {/* 「数据异常」点得动：跟旁边那行「同步失败」一个口径——出了问题就得有地方可去。
            去的是设置 → 数据，换文件夹、翻备份都在那一节里 */}
        {loadError ? (
          <button
            className="foot-sync warn"
            title={loadError}
            onClick={() => {
              navigate("settings");
              onNavigate?.();
              revealDataSection();
            }}
          >
            数据异常
          </button>
        ) : (
          "数据已就绪"
        )}
        {sync && (
          <>
            <span className="sep">·</span>
            {/* 点得动：同步出问题时，用户看见这行字之后要有地方可去 */}
            <button
              className={sync.bad ? "foot-sync warn" : "foot-sync"}
              title="账号与同步状态"
              onClick={() => {
                navigate("settings");
                onNavigate?.();
                revealCloudSection();
              }}
            >
              {sync.text}
            </button>
          </>
        )}
        {upd && (
          <>
            <span className="sep">·</span>
            {/* 查到新版本那一条点得动：点了把更新弹窗顶出来。
                「已是最新」「版本检查失败」没有下一步动作，就是一句话，不做成假按钮 */}
            {upd.openable ? (
              <button className="foot-sync" title="查看新版本" onClick={openFoundUpdate}>
                {upd.text}
              </button>
            ) : (
              <span className={upd.bad ? "warn" : undefined}>{upd.text}</span>
            )}
          </>
        )}
        {restored && (
          <>
            <span className="sep">·</span>
            {/* 点得动：点了去设置 → 云账号，那儿能看清这个账号同步到哪一步了，
                也有「从云端覆盖到这台设备」可以再来一次。点完这行字就收掉 */}
            <button
              className="foot-sync"
              // 退路在哪儿也得说出来，跟手动登录那条路的回执一个口径（useAuthFlow.signInToast）：
              // 万一取回来的不是他想要的，覆盖前那份还躺在 backups/ 里
              title={
                "这台设备上本来没有数据，橡果开机时把云端那份取了回来" +
                (restored.backup ? `；覆盖前那份存进了 backups/${restored.backup}` : "")
              }
              onClick={() => {
                dismissRestored();
                navigate("settings");
                onNavigate?.();
                revealCloudSection();
              }}
            >
              已从云端取回 {restored.tasks} 件事{restored.backup ? "，旧的已备份" : ""}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
