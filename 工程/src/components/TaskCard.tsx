// 展开的任务卡：原地编辑一切字段。Esc / 点击卡外收起。
// v1.1：日期选择用草稿态（翻月不再立刻保存）；子任务可带自己的日期/优先级（默认继承）；
// 底部「快捷改」——用快速添加同款语法改任务（出现哪类要素就改哪类，其余不动）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Priority, RepeatRule, Subtask, Task } from "../core/model";
import { LIST_COLORS } from "../core/model";
import { cmpYMD, duePresets, formatShort, isPlausibleYMD, todayYMD } from "../core/dates";
import { describeRepeat, firstOccurrence } from "../core/recur";
import type { ParseResult } from "../core/parse";
import { parseQuickAdd, parseSubtaskInput, SUBTASK_SKIP } from "../core/parse";
import { taskToSentence } from "../core/syntax";
import {
  addList, addSubtask, addTasksWho, allTags, allWho, appStore, completeTask, deleteTasks, dropSubtask,
  dropTasks, expandTask, foldDoneSubs, removeSubtask, removeTaskWho, setTasksWho, splitSubtasks,
  SUB_DONE_PEEK, toggleSubtask, uncompleteTask, updateSubtask, updateTask, useApp,
} from "../core/store";
import { startFocus } from "../core/focusCtl";
import { FOCUS_ENABLED } from "../core/features";
import SyntaxInput from "./SyntaxInput";
import { growArea, oneLine } from "./autogrow";
import DateField from "./DateField";
import type { DateFieldHandle } from "./DateField";
import { useLeaving } from "./motion";
import { CommitMark, FLASH_MS, TYPING_IDLE_MS, useTypingFlash } from "./commitFlash";

const PRIORITY_LABEL: Record<Priority, string> = { 0: "无", 1: "低", 2: "中", 3: "高" };

/** 日期弹层里的每一次写库都带上它：**弹层期间一律不数顺延**。
 *  「这件事被往后推了几次」按弹层开→关整段算一次，落在 settleDuePopup 里 */
const POPUP_WRITE = { noPostponeCount: true } as const;

type MenuName = "date" | "repeat" | "list" | "priority" | "who" | "tags" | null;

export default function TaskCard({ task }: { task: Task }) {
  // B8：只订阅真用得上的三片，派生也都缓存起来。以前是整份 data + 每次渲染重算一遍
  // allWho/allTags——在「整句改」框里打一个字并不改数据，却照样把全库的需求方和标签数一遍
  const lists = useApp((s) => s.data.lists);
  const tasks = useApp((s) => s.data.tasks);
  const settings = useApp((s) => s.data.settings);
  const tagNames = useMemo(() => allTags({ tasks }).map((t) => t.tag), [tasks]);
  const whoNames = useMemo(() => allWho({ tasks, settings }).map((w) => w.who), [tasks, settings]);
  const [menu, setMenu] = useState<MenuName>(null);
  const [subMenu, setSubMenu] = useState<{ id: string; kind: "date" | "prio" } | null>(null);
  /** 弹层退场那一拍（B6）：关掉的时候得让它多活一会儿把动画演完，不然是「啪一下没了」。
   *  真正的开关状态照旧是 menu / subMenu，下面那些判断和收尾一个字都没动 */
  const menuPop = useLeaving(menu);
  const subPop = useLeaving(subMenu);
  const [newSub, setNewSub] = useState("");
  /** 已完成子任务那堆展不展开。null = 还没表过态，跟自动规则走；
   *  用不得直接存 boolean：那样刚勾掉一条子任务、已完成刚够数的时候自动规则就再也不生效了。
   *  用户自己点过之后才锁成他选的那个 */
  const [showDone, setShowDone] = useState<boolean | null>(null);
  /** 「整句改」输入框的草稿。null = 没动过，显示现算的那句。
   *  **必须连底稿一起记**（base）：用户在框里打了一半，又去上面点了个日期/优先级，
   *  这句底稿就过期了；不作废的话回车会拿过期的那句把刚点的改动盖回去。 */
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  // 日期弹层里时间框的当前值。**不再是「攒着等确定」的草稿**（那个「确定」按钮已经撤了，
  // 见下面 commitDraft 一带的注释）：日历格一选就生效、时间一失焦就生效，
  // 这个 state 只是让输入框在弹层开着的时候记得自己显示什么。
  // 日期那一边的草稿归 DateField 自己管（草稿 / 闸门 / 去抖三件套都封在它里面）
  const [draftTime, setDraftTime] = useState<string>("");
  /** 日期框（DateField）的三个手：flush 提前落、cancel 作废、pending 看还欠着什么。
   *  弹层没开着的时候是 null，调用点一律用 `?.` ——那会儿本来也没什么欠着的 */
  const dueFieldRef = useRef<DateFieldHandle | null>(null);
  /** 子任务日期小签里那个框。subMenu 同时只可能开一个，一个 ref 够用。
   *  Esc 要连它一起 cancel——不然在子任务日期框里敲了一半按 Esc，
   *  卡片卸载时 DateField 自己 flush，把半截日期钉成那条子任务的最终日期 */
  const subDueFieldRef = useRef<DateFieldHandle | null>(null);
  /** 日期弹层**打开那一刻**这件事的日子（没开着就是 null）。
   *  顺延次数按「弹层开 → 弹层关」整段算**一次**，见下面 settleDuePopup */
  const dueAtOpenRef = useRef<string | null>(null);
  /** **这次弹层自己写进去的那个日子**（undefined = 这次弹层一个字都没写，null = 把日期清了）。
   *
   *  顺延结算只认它，不认 store 里当下那个 due——不然弹层开着的时候别处改了日期，
   *  会被这一笔再数一遍。三条真路径：① 点开 📅 看了一眼没选，转头在底下「整句改」那栏
   *  把日期改晚（store 自己 +1），关弹层再 +1 → 用户只顺延了一次，行尾挂出「顺延×2」；
   *  ② 弹层开着时勾掉一件循环任务（完成会清零计数并把 due 推到下一个落点），关弹层凭空 +1，
   *  刚完成的循环任务进了周报的顺延名单；③ 弹层开着时按 Ctrl+→ 推明天，同样多数一次 */
  const dueWrittenRef = useRef<string | null | undefined>(undefined);
  /** 关弹层时的结算。effect 的清理跑的是「menu 刚变成 date 那一帧」的闭包，
   *  用 ref 保证结算的永远是最新那一份 */
  const settleDueRef = useRef<() => void>(() => {});
  const cardRef = useRef<HTMLDivElement>(null);
  // v1.9.1 起标题是 textarea 不是 input（长标题在卡里换行显示，不再被截断）
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  /** 需求方 / 标签这两个内联框：卡片被点没了的时候要能把里面的字捞出来（A1） */
  const whoInputRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  /** 需求方那个内联框已经交代过了（提交或丢弃），别再交代第二遍。
   *  照抄 ContextMenu 那套闸门：B1 之后卡片不再当场卸载，点卡外先跑 flushPending、
   *  紧接着 blur 照样发出来，不挡住就是同一个名字落两次库、白压一张撤销快照 */
  const whoSettled = useRef(false);
  /** 标签框同理：它跟需求方框是同一条路数（点卡外 flushPending 一次、紧接着 blur 又一次），
   *  onBlur 里那句「没改过就别写」比的是**这一次渲染时**的 task.tags——点卡外那一下写完
   *  React 还没重渲染，比到的仍是旧标签，于是照样写第二遍、白占一格撤销栈 */
  const tagsSettled = useRef(false);
  /** 点卡外时的收尾函数。document 监听只挂一次，拿不到最新的 state，用 ref 每次渲染刷新 */
  const flushRef = useRef<() => void>(() => {});
  /** 同上：那条监听的闭包停在首帧，要认「我是哪一件事」只能靠 ref 每次渲染刷新 */
  const taskIdRef = useRef(task.id);
  taskIdRef.current = task.id;

  // 逐键落库的两个框（A7）：没有「提交」这个动作，停手 600ms 闪一下算回执
  const titleFlash = useTypingFlash(task.title);
  const notesFlash = useTypingFlash(task.notes);
  /** 正在闪回执的那条子任务。同时只可能有一条在打字，不必一行一个计时器 */
  const [subFlash, setSubFlash] = useState<string | null>(null);
  const subFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      // 我已经不是当前展开的那张了就别管事（v1.9.0 · B1 的后账）：
      // 收起中的卡片会在树上多活 cardMs() 那一拍好把动画演完，这条监听跟着还活着。
      // 这一拍里点新展开那张卡的任何地方，都会被上一张卡判成「点到卡外」当场收掉——
      // 「点开一件事马上去点它的日期」这个最常见的连贯动作正好落在这里。
      // 收起那一拍的收尾在 flushPending 里早就做过了，直接 return，不需要再做第二遍
      if (appStore.getState().ui.expandedId !== taskIdRef.current) return;
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        // A1「点走 = 提交」：卡片马上就要没了，先把还悬着的输入落库再收
        flushRef.current();
        expandTask(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      // Esc 是**丢弃**，不是「点走 = 提交」那条路（见 flushPending 的注释）。
      // 光收卡片不行：卡片一卸载 DateField 会自己 flush 一次，把日期框里刚敲了一半
      // （月段改完、日段还没改）的那一天当成最终结果落库，结算再判它比原来晚，+1 顺延——
      // 「丢弃」这条通道反而把用户从没想要的日子钉死了。
      // 所以先收尾再收卡：欠着的那一拍作废，这次弹层的记账清空（结算那儿直接 return）
      if (e.key === "Escape") {
        dueFieldRef.current?.cancel();
        subDueFieldRef.current?.cancel();
        dueWrittenRef.current = undefined;
        expandTask(null);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      if (subFlashTimer.current) clearTimeout(subFlashTimer.current);
    };
  }, []);

  // 标题框的高度跟着内容走。自己打字那一路 onChange 里已经算过一遍了，这条管的是
  // **别处改进来的**：底下「整句改」改了标题、撤销、云同步拉回一份、或者换了一件事
  // （卡片按任务 id 认 key，同一件事换标题时组件是不重建的）
  useLayoutEffect(() => {
    growArea(titleRef.current);
  }, [task.title]);
  // 子任务那一堆同理。它们没有各自的 ref（是个 map 出来的列表），
  // ref={growArea} 只在挂载那一下调一次，所以外部改动（撤销/同步/整句改）得在这儿补一遍。
  // 只扫这张卡自己的 .subs，不动别处
  useLayoutEffect(() => {
    cardRef.current?.querySelectorAll<HTMLTextAreaElement>(".subs textarea").forEach((el) => growArea(el));
  }, [task.subtasks]);

  const list = task.listId ? lists.find((l) => l.id === task.listId) : null;
  const today = todayYMD();

  // 已经做完的子任务沉到最下面，多了还要收起来（只改显示顺序，存的那份数组原样不动）。
  // 用户口径：「子任务已通过的排到最下面」——上面永远是还欠着的
  const { open: openSubs, done: doneSubs } = useMemo(() => splitSubtasks(task.subtasks), [task.subtasks]);
  const autoFold = foldDoneSubs(task.subtasks);
  // 够数才给折叠开关（只勾掉一两条时摊开就是了，不必多一行按钮）。
  // 不够数时强制摊开：否则「先折起来、再取消勾选几条」会把已完成子任务锁成看不见又开不出来
  const canFoldDone = doneSubs.length >= SUB_DONE_PEEK;
  const doneShown = canFoldDone ? showDone ?? !autoFold : true;

  // 这件事的「一整句话」。按当前状态现算，不存旧的输入——存了迟早跟字段对不上
  const sentence = useMemo(
    () => taskToSentence(task, { listName: list?.name ?? null, listNames: lists.map((l) => l.name) }),
    [task, list, lists],
  );
  const baseText = sentence.safe ? sentence.text : "";
  // 草稿的底稿跟现在这句对不上 = 期间任务被别处改过，草稿作废，重新以新句子为准
  const live = draft && draft.base === baseText ? draft.text : baseText;

  function openDateMenu() {
    setDraftTime(task.dueTime ?? "");
    setMenu(menu === "date" ? null : "date");
  }

  /** 日期弹层落库的唯一出口。
   *  **只填了时间没填日期 → 落到今天**，不允许「有时间无日期」的悬空状态——这条规矩比「确定」按钮老，
   *  按钮撤了它照旧管用。
   *
   *  第一行是这个唯一出口上的兜底：不像话的日子（键盘敲年份时那几拍中间值）一个都不许进库，
   *  遇到就按这件事原来的日子写，时间照改。空串是「只填了时间」的合法情形，不动它。
   *
   *  最后一行记账：**这次弹层写了什么**。顺延结算只认这一笔，见 settleDuePopup */
  function commitDraft(dueRaw: string, time: string) {
    const due = dueRaw && !isPlausibleYMD(dueRaw) ? task.due ?? "" : dueRaw;
    const next = due || (time ? today : null);
    // noPostponeCount：弹层期间的每一次落库都不数顺延，整段只在关弹层时数一次（settleDuePopup）
    updateTask(task.id, { due: next, dueTime: time || null }, POPUP_WRITE);
    dueWrittenRef.current = next;
  }

  /** 关弹层时结算「顺延次数」——**整段只算这一次**。
   *
   *  为什么不能在 store 那边按落库次数数：原生 date 是分段控件，用键盘把 9-10 改成 10-15
   *  会连发四拍，中间那两拍也是「格式合法、年份合法」的完整日期。去抖只是把窗口收窄，
   *  用户在月段和日段之间抬眼确认一下就轻松超过 DATE_COMMIT_MS——于是月段一次、日段一次，
   *  postponeCount 净加 2，而 2 正好是「顺延×2」和周报那句「（顺延 N 次）」的门槛，
   *  这个数还没有任何入口能清零。跟时长较劲永远有漏，所以改成跟时长完全无关的算法：
   *  「这件事被往后推了几次」= 数弹层，不是数写库。
   *
   *  落库照旧即时（点日历格立刻生效，那是「已生效」的反馈），只是一律不带计数。
   *
   *  **认的是「这次弹层自己写了什么」（dueWrittenRef），不是 store 里当下那个 due。**
   *  拿 store 的现值当依据会把别处的改动算到这一笔上：弹层开着不动它，转头在底下
   *  「整句改」那栏把日期改晚（普通 updateTask，store 自己 +1），回头关弹层再 +1，
   *  用户只顺延了一次却挂出「顺延×2」；弹层开着时勾掉一件循环任务（完成会清零计数、
   *  把 due 推到下一个落点）关弹层也会凭空 +1，刚做完的循环任务进了周报的顺延名单；
   *  弹层开着按 Ctrl+→ 推明天同理。这次弹层一个字都没写，就一次都不数。 */
  function settleDuePopup() {
    // 还欠着的那一次先做掉：它也算「这次弹层写的」，不做掉就漏了这一笔
    dueFieldRef.current?.flush();
    const before = dueAtOpenRef.current;
    const written = dueWrittenRef.current;
    dueAtOpenRef.current = null;
    dueWrittenRef.current = undefined;
    if (written === undefined) return; // 这次弹层一个字都没写：别处改的日期不算在这一笔上
    if (!before) return; // 打开时本来就没日期 = 从无到有，不算顺延（跟 store 那边同口径）
    if (!written) return; // 这次弹层把日期清了，不是顺延
    if (cmpYMD(written, before) <= 0) return; // 没往后挪（改早了 / 又改回来了）
    const cur = appStore.getState().data.tasks.find((t) => t.id === taskIdRef.current);
    if (!cur) return;
    // 跟刚才那次日期写入并成同一格撤销：不然改一次日期吃掉两格（栈只有 10 格）
    updateTask(cur.id, { postponeCount: cur.postponeCount + 1 }, { coalesceKey: `task:${cur.id}:due` });
  }
  settleDueRef.current = settleDuePopup;

  /** 弹层一开就记下当时的日子、把「这次写了什么」清空，一关（点走 / Esc / 点了预设 /
   *  换别的弹层 / 收卡片）就结算。挂在 effect 的清理里而不是各个关闭入口上：
   *  关弹层的路太多，一处处补迟早漏一条 */
  useEffect(() => {
    if (menu !== "date") return;
    dueAtOpenRef.current =
      appStore.getState().data.tasks.find((t) => t.id === taskIdRef.current)?.due ?? "";
    dueWrittenRef.current = undefined;
    return () => settleDueRef.current();
  }, [menu]);

  /** 快捷预设：**设好并关弹层**——按它的人已经把话说完了。
   *  弹层里刚填的时间要带上（没填则保留任务原时间） */
  function setDue(d: string | null) {
    // 刚在日历格里敲了一半又改点预设：那句作废，别让它 350ms 后回来把预设盖掉
    dueFieldRef.current?.cancel();
    updateTask(task.id, { due: d, dueTime: d ? draftTime || task.dueTime : null }, POPUP_WRITE);
    dueWrittenRef.current = d; // 这次弹层写的就是它
    setMenu(null); // 计数交给 settleDuePopup（关弹层那一下），这儿不数
  }

  function setRepeat(r: RepeatRule | null) {
    updateTask(task.id, { repeat: r, due: r ? task.due ?? firstOccurrence(r, today) : task.due });
    setMenu(null);
  }

  /** 子任务输入框回车：把「明天 15点 !高 画趋势图」拆成标题 + 它自己的日期/时间/重要性。
   *  没写日期/重要性就还是继承母任务（存 null）。加完输入框清空，接着敲下一条。
   *  **返回「到底加上没有」**：只打了日期没打标题时一条都没加，回执就不许闪——
   *  A2 那个 ✓ 的全部价值在于它不能说谎 */
  function addSubFromInput(): boolean {
    const r = parseSubtaskInput(newSub, new Date());
    const title = r.title.trim();
    if (!title) return false;
    addSubtask(task.id, title, {
      due: r.due,
      dueTime: r.dueTime,
      priority: r.priority || null,
    });
    setNewSub("");
    return true;
  }

  /** 名字 → 清单 id。**先认这件事现在待的那张**：允许重名，光按名字找会永远命中第一张，
   *  于是「什么都没改直接回车」也能把任务从后建的那张同名清单搬到先建的那张去 */
  function ensureListId(name: string): string {
    if (list && list.name === name) return list.id;
    const hit = lists.find((l) => l.name === name) ?? lists.find((l) => l.name.startsWith(name));
    if (hit) return hit.id;
    return addList(name, LIST_COLORS[lists.length % LIST_COLORS.length]);
  }

  /** 整句改：框里那句话**就是**这件事，写什么它就变成什么——
   *  删掉「!高」就降级、删掉「@李哥」就把人摘了、日期改掉就改期。
   *
   *  两条保险：
   *  ① 整句删光了不动手。一句里连标题都没有，那不是「我要清空这件事」，是手滑
   *    （Ctrl+A Delete 回车太容易了），而且此时焦点还在输入框里，Ctrl+Z 走的是
   *    浏览器的文本撤销、救不回来。
   *  ② 只写**真的变了**的字段。全量写的话，一个已经响过、已经被清成 null 的提醒
   *    会因为「due/dueTime 被传了」而重新算出来一个过去的时刻，几十秒后再轰你一次。 */
  function applySentence(p: ParseResult, raw: string) {
    if (!raw.trim() || !p.title.trim()) {
      // 什么都不改，把框恢复成这件事本来那句
      setDraft(null);
      return;
    }
    const patch: Partial<Task> = {};
    const title = p.title.trim();
    if (title !== task.title) patch.title = title;
    if (p.due !== task.due) patch.due = p.due;
    if (p.dueTime !== (task.due ? task.dueTime : null)) patch.dueTime = p.dueTime;
    if (JSON.stringify(p.repeat) !== JSON.stringify(task.repeat)) patch.repeat = p.repeat;
    if (p.priority !== task.priority) patch.priority = p.priority;
    if (JSON.stringify(p.who) !== JSON.stringify(task.who)) patch.who = p.who;
    if (JSON.stringify(p.tags) !== JSON.stringify(task.tags)) patch.tags = p.tags;
    const nextList = p.listName ? ensureListId(p.listName) : null;
    if (nextList !== task.listId) patch.listId = nextList;
    if (Object.keys(patch).length) updateTask(task.id, patch);
    setDraft(null);
  }

  /** 兜底：这件事没法用一句话无损表达（标题里带 # / @，或清单名里有空格）时，
   *  退回老口径——写出哪类要素就改哪类，没写的不动 */
  function applyQuickPatch(p: ParseResult) {
    const kinds = new Set(p.chips.map((c) => c.kind));
    const patch: Partial<Task> = {};
    if (kinds.has("date")) patch.due = p.due;
    if (kinds.has("time")) patch.dueTime = p.dueTime;
    if (kinds.has("repeat")) {
      patch.repeat = p.repeat;
      // 只写「每周一」没写日期：任务本来无日期时要带上首个落点，否则循环永不触发
      if (!kinds.has("date") && !task.due && p.due) patch.due = p.due;
    }
    if (kinds.has("priority")) patch.priority = p.priority;
    if (kinds.has("who")) patch.who = [...new Set([...task.who, ...p.who])];
    if (kinds.has("list") && p.listName) patch.listId = ensureListId(p.listName);
    if (kinds.has("tag")) patch.tags = [...new Set([...task.tags, ...p.tags])];
    if (p.title.trim()) patch.title = p.title.trim();
    if (Object.keys(patch).length) updateTask(task.id, patch);
    setDraft(null);
  }

  /** 整句改那一栏的提交口——回车、失焦、点卡外，三条路走的都是这一个函数。
   *  绝不另写一条：applySentence 里那两条保险（删光了不动手、只写真的变了的字段）
   *  一旦被绕过去，历史上出过的两个 bug 会一起回来 */
  function commitSentence(p: ParseResult, raw: string) {
    if (sentence.safe) applySentence(p, raw);
    else applyQuickPatch(p);
  }

  /** 子任务标题的回执计时（A7）：停手 TYPING_IDLE_MS 才闪，闪 FLASH_MS 后收 */
  function touchSub(id: string) {
    if (subFlashTimer.current) clearTimeout(subFlashTimer.current);
    setSubFlash(null);
    subFlashTimer.current = setTimeout(() => {
      setSubFlash(id);
      subFlashTimer.current = setTimeout(() => {
        subFlashTimer.current = null;
        setSubFlash(null);
      }, FLASH_MS);
    }, TYPING_IDLE_MS);
  }

  /** 需求方内联框的唯一落库口。回车 / 失焦 / 点卡外三条路都走它，**只认第一次**。
   *  落完把框清空（它是非受控的，React 重渲染不会替我们清），下一条路读到的就是空的；
   *  whoSettled 再兜一层，免得同一个名字进两次撤销栈。
   *  又开始打字（onChange）或重新聚焦时闸门放回去，接着加下一个人 */
  function commitWho() {
    const el = whoInputRef.current;
    if (!el || whoSettled.current) return;
    whoSettled.current = true;
    const v = el.value.trim();
    if (!v) return;
    addTasksWho([task.id], v);
    el.value = "";
  }

  /** 标签内联框的唯一落库口，跟 commitWho 一个路数：三条路只认第一次。
   *  这个框落完不清空——它显示的就是这件事现在的标签 */
  function commitTags() {
    const el = tagInputRef.current;
    if (!el || tagsSettled.current) return;
    tagsSettled.current = true;
    const v = el.value.trim();
    if (v === task.tags.join(" ")) return; // 没改过就别写
    updateTask(task.id, { tags: v ? v.split(/\s+/) : [] });
  }

  /** 点到卡外面之前的收尾（A1）。卡片一卸载，React 就不会再给这些框发 blur 了，
   *  不在这儿捞一把，打了一半的字就真的白打。**Esc 不走这条路**——Esc 才是丢弃 */
  function flushPending() {
    // ① 整句改的草稿。底稿对不上（期间任务被别处改过）的那份已经作废，不能拿它去写
    if (draft && draft.base === baseText && draft.text.trim() && draft.text !== baseText) {
      commitSentence(parseQuickAdd(draft.text, { now: new Date(), listNames: lists.map((l) => l.name) }), draft.text);
    }
    // ② 打了一半还没回车的新子任务
    if (newSub.trim()) addSubFromInput();
    // ③④ 需求方 / 标签两个内联框，只在各自的弹层开着时才有值可捞
    if (menu === "who") commitWho();
    if (menu === "tags") commitTags();
    // ⑤ 日期框里刚敲完、去抖还没烧到点的那一次。**只是提前做掉**，不是补一次：
    //   没欠着的时候它什么都不做（欠着的那一次即便不 flush 也会自己烧到点，不会丢）
    dueFieldRef.current?.flush();
  }
  flushRef.current = flushPending;

  // 循环菜单的「每周X/每月X号」按任务自己的日期取形
  const wd = task.due ? new Date(task.due).getDay() : new Date().getDay();
  const dom = task.due ? Number(task.due.slice(8, 10)) : new Date().getDate();
  // 安排日期的快捷预设（今天 / 本周五 / 本周日 / 本月末）现算：永远向后取最近的一个，
  // 名字跟着算出来的日子走，跟今天撞上的那个不出现。规则和单测都在 core/dates.ts
  const presets = duePresets(today);

  /** 一条子任务的整行。未完成那堆和已完成那堆共用它，两处长得一模一样。
   *  写成组件体内的局部函数、不抽成外部组件：外部组件每次 render 都是个新类型，
   *  React 会把行整个卸载重建，行里那两个 .popmenu 会在打字时闪没 */
  function renderSub(s: Subtask) {
    return (
      <div key={s.id} className={`sub-row${s.done ? " done" : ""}${s.droppedAt ? " dropped" : ""}`} style={{ position: "relative" }}>
        <button className={`sb${s.done ? " done" : ""}`} onClick={() => toggleSubtask(task.id, s.id)} />
        {/* 子任务标题跟母任务标题同一个待遇：长了就换行，不再单行截断（v1.9.1）。
            ref 直接给 growArea——它是个模块级的稳定函数，React 只在元素挂/卸时调它，
            不会每渲染一次就重挂一遍 */}
        <textarea
          rows={1}
          ref={growArea}
          className={subFlash === s.id ? "commit-lit" : undefined}
          value={s.title}
          onChange={(e) => {
            growArea(e.currentTarget);
            updateSubtask(task.id, s.id, { title: oneLine(e.target.value) });
            touchSub(s.id);
          }}
          // 换成 textarea 之后 Enter 默认是换行，得拦下来：子任务标题是一行字段。
          // Shift+Enter 收卡，跟母任务标题和备注一个规矩
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (e.shiftKey) expandTask(null);
          }}
        />
        <CommitMark on={subFlash === s.id} />
        {/* 放弃了的那一步：圈圈不动，只在旁边挂个灰标签 */}
        {s.droppedAt && <span className="drop-tag">已放弃</span>}
        {/* 子任务自己的日期/优先级：默认继承母任务，点小签单独设 */}
        <button
          className="pill"
          style={{ padding: "1px 8px", fontSize: 11 }}
          title={s.due ? "这条子任务自己的日期" : "跟着母任务走，点一下可以单独排"}
          onClick={() => setSubMenu(subMenu?.id === s.id && subMenu.kind === "date" ? null : { id: s.id, kind: "date" })}
        >
          {/* 继承来的日期也照样显示，只是淡一点——一眼看得出这条到底哪天要做 */}
          {s.due ? formatShort(s.due) : task.due ? <span style={{ opacity: 0.5 }}>{formatShort(task.due)}</span> : "📅"}
        </button>
        <button
          className="pill"
          style={{ padding: "1px 8px", fontSize: 11 }}
          title={s.priority != null ? "这条子任务自己的重要性" : "跟着母任务走，点一下可以单独设"}
          onClick={() => setSubMenu(subMenu?.id === s.id && subMenu.kind === "prio" ? null : { id: s.id, kind: "prio" })}
        >
          {/* 继承母任务的整体淡一档：一眼分得出「自己设的」还是「跟着母任务」 */}
          <span className={`flag p${s.priority ?? task.priority}`} style={{ opacity: s.priority == null ? 0.5 : 1 }} />
          {s.priority != null ? (
            PRIORITY_LABEL[s.priority]
          ) : (
            <span style={{ opacity: 0.5 }}>{PRIORITY_LABEL[task.priority]}</span>
          )}
        </button>
        {/* 放弃跟删除挨着放，都是「按一下这行就不在待办里了」的键；已经放弃的那条常驻显示，
            否则想反悔的人得先猜出来这里有个按钮 */}
        <button
          className="sub-drop"
          onClick={() => dropSubtask(task.id, s.id, !s.droppedAt)}
          title={s.droppedAt ? "取消放弃，放回未完成" : "放弃这一步：不做了，但它不算做完"}
        >
          {s.droppedAt ? "↩" : "⊘"}
        </button>
        <button className="rm" onClick={() => removeSubtask(task.id, s.id)} title="删除子任务">×</button>
        {subPop.shown?.id === s.id && subPop.shown.kind === "date" && (
          <div className={`popmenu${subPop.leaving ? " leaving" : ""}`} style={{ top: "100%", right: 0 }}>
            {/* 预设跟任务卡那个日期弹层同一套（core/dates.duePresets），别在这儿另写一份 */}
            {presets.map((p) => (
              <button key={p.key} className="item" onClick={() => { updateSubtask(task.id, s.id, { due: p.ymd }); setSubMenu(null); }}>
                {p.label}
              </button>
            ))}
            {/* 跟另外三处日期框同一个件（草稿 / 闸门 / 去抖三件套都在 DateField 里）。
                收弹层归调用方：只有真的点走了（窗口失焦不算）才收 */}
            <DateField
              ref={subDueFieldRef}
              value={s.due ?? ""}
              onCommit={(ymd) => updateSubtask(task.id, s.id, { due: ymd })}
              onDone={(e) => {
                // 焦点还落在这个小弹层里（点了一下日期框、又改主意去按上面的预设 /
                // 「继承母任务」）就别收：一收弹层当场进退场态（.leaving 是
                // pointer-events:none），那一下 click 根本不触发，按了等于没按
                const next = e.relatedTarget as HTMLElement | null;
                if (next && next.closest(".popmenu")) return;
                setSubMenu(null);
              }}
            />
            <button className="item" onClick={() => { updateSubtask(task.id, s.id, { due: null, dueTime: null }); setSubMenu(null); }}>继承母任务</button>
          </div>
        )}
        {subPop.shown?.id === s.id && subPop.shown.kind === "prio" && (
          <div className={`popmenu${subPop.leaving ? " leaving" : ""}`} style={{ top: "100%", right: 0 }}>
            {([3, 2, 1, 0] as Priority[]).map((p) => (
              <button key={p} className="item" onClick={() => { updateSubtask(task.id, s.id, { priority: p }); setSubMenu(null); }}>
                <span className={`flag p${p}`} />
                {PRIORITY_LABEL[p]}
              </button>
            ))}
            <button className="item" onClick={() => { updateSubtask(task.id, s.id, { priority: null }); setSubMenu(null); }}>继承母任务</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="task-card" ref={cardRef}>
      <div className="row1">
        {/* 跟任务行左边缘对齐用的占位（任务行那边有个折叠小三角），没有它点开卡片标题会往左跳一格 */}
        <span className="chain-caret ghost" />
        <span className={`flag p${task.priority}`} />
        <button
          className={`cb${task.done ? " done" : ""}`}
          onClick={() => (task.done ? uncompleteTask(task.id) : completeTask(task.id))}
        />
        {/* v1.9.1：input → 自动撑高的 textarea。用户原话「点开后能够多行显示」——
            长标题在列表行上是一行省略号，点开这张卡才是看全的地方，
            它自己再截断一次就等于没地方看全了。
            rows={1} 起步，高度由 growArea 按内容算；键盘约定原样保住（见下面 onKeyDown） */}
        <textarea
          ref={titleRef}
          rows={1}
          className={`${task.droppedAt ? "dropped" : ""}${titleFlash ? " commit-lit" : ""}`.trim() || undefined}
          value={task.title}
          placeholder="任务标题"
          onChange={(e) => {
            growArea(e.currentTarget);
            updateTask(task.id, { title: oneLine(e.target.value) });
          }}
          // A8「一路回车敲完一张卡」：回车不再是收卡片，而是走到下一个框（备注）。
          // 想收卡片按 Shift+Enter——收卡这件事从「最容易误触的键」挪成「要多按一个键」。
          // ⚠️ 换成 textarea 之后这段更不能少：Enter 在 textarea 里默认是插一个换行，
          // 不拦的话敲回车不是跳备注，而是把标题敲成两行
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (e.shiftKey) expandTask(null);
            else notesRef.current?.focus();
          }}
        />
        <CommitMark on={titleFlash} />
        {/* 放弃只在这儿露一个灰标签，圈圈那边一点不动 */}
        {task.droppedAt && <span className="drop-tag">已放弃</span>}
      </div>

      {/* 包一层是为了让「✓」有个落脚的地方：备注是整行的 textarea，回执得贴在它右上角 */}
      <div className="tc-notes-wrap">
        <textarea
          ref={notesRef}
          className={`notes${notesFlash ? " commit-lit" : ""}`}
          value={task.notes}
          placeholder="备注…"
          rows={task.notes ? undefined : 1}
          onChange={(e) => updateTask(task.id, { notes: e.target.value })}
          // 备注里回车照旧是换行（它就是给人写几行字的）；Shift+Enter 收卡，跟标题那边一个规矩
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              expandTask(null);
            }
          }}
        />
        {notesFlash && <span className="commit-ok tc-notes-ok">✓</span>}
      </div>

      <div className="subs">
        {openSubs.map(renderSub)}

        {/* 添加栏排在已完成上面：做完的越攒越多，压在下面就得先滚过一堆划线的字才够得着 */}
        {/* 子任务也能一句话记全：「明天 15点 !高 画趋势图」。
            清单/标签/需求方归母任务管，在这儿写就是普通文字，不会被吃掉 */}
        <div className="sub-row">
          <span className="sb" style={{ opacity: 0.35 }} />
          <SyntaxInput
            value={newSub}
            onChange={setNewSub}
            onSubmit={addSubFromInput}
            // A1：打了一半点走也算数（addSubFromInput 空标题自己会退回，不会加出空条）。
            // 照实汇报加上没有：只打了「明天」没打标题时一条都没加，右边就不该浮出 ✓
            onBlurCommit={() => addSubFromInput()}
            // Esc 先擦掉这一条，第二下才轮到收卡片
            onEscape={() => {
              if (!newSub) return false;
              setNewSub("");
              return true;
            }}
            onShiftEnter={() => expandTask(null)}
            placeholder="＋ 子任务，回车添加（可以写「明天 !高」）"
            lists={[]}
            tags={[]}
            whos={[]}
            skip={SUBTASK_SKIP}
            inputStyle={{ fontSize: 13 }}
          />
        </div>

        {/* 阈值跟自动折叠同一个，见上面的 canFoldDone */}
        {canFoldDone && (
          <button className="tc-donefold" onClick={() => setShowDone(!doneShown)}>
            {doneShown ? "收起已完成" : `显示已完成 ${doneSubs.length}`}
            <span className="tc-donefold-caret">{doneShown ? "▴" : "▾"}</span>
          </button>
        )}
        {doneShown && doneSubs.map(renderSub)}
      </div>

      <div className="chips" style={{ position: "relative" }}>
        {/* 日期 */}
        <button className={`pill${task.due ? " hot" : ""}`} onClick={openDateMenu}>
          📅 {task.due ? `${formatShort(task.due)}${task.dueTime ? " " + task.dueTime : ""}` : "安排日期"}
        </button>
        {menuPop.shown === "date" && (
          <div className={`popmenu${menuPop.leaving ? " leaving" : ""}`} style={{ top: "110%", left: 0 }}>
            {presets.map((p) => (
              <button key={p.key} className="item" onClick={() => setDue(p.ymd)}>
                {p.label}
              </button>
            ))}
            <div className="sep" />
            {/* 这个弹层只有一套规矩（v1.9.0 统一，此前是两套，要不要再点一下才生效得靠猜）：
                · 点上面的预设 = 设好并关弹层
                · 点日历格 = 立即生效，但**弹层留着**，好接着设时间
                · 时间失焦即生效
                **翻月仍然只是导航、不生效**：原生日期控件翻月不触发 change，
                v1.1.0 专门修过的那个草稿态没有翻回去 */}
            {/* 草稿 / 闸门 / 去抖三件套全在 DateField 里，这儿只交代「落库那句」。
                **不给 onDone**：点日历格立刻生效，但弹层留着好接着设时间 */}
            <DateField
              ref={dueFieldRef}
              value={task.due ?? ""}
              onCommit={(ymd) => { if (ymd !== (task.due ?? "")) commitDraft(ymd, draftTime); }}
            />
            <input
              className="inline"
              type="time"
              value={draftTime}
              onChange={(e) => setDraftTime(e.target.value)}
              // 没变就不写：点预设时也会先掠过这一下失焦，白写一次会在撤销栈里多压一层。
              // **窗口失焦不是点走**：alt-tab 去别的程序时框原样悬着，等用户回来自己了结。
              // 日期取 task.due：日期框先失焦、先把欠着的那天落了库，这会儿它已经是最新的
              onBlur={() => {
                if (!document.hasFocus()) return;
                if ((draftTime || null) !== (task.dueTime ?? null)) commitDraft(task.due ?? "", draftTime);
              }}
            />
            <div className="sep" />
            {/* 清日期同样要把还欠着的那一次去抖丢掉，否则刚清完它 350ms 后又把日期写回来 */}
            {task.due && <button className="item" onClick={() => { dueFieldRef.current?.cancel(); updateTask(task.id, { due: null, dueTime: null }); dueWrittenRef.current = null; setMenu(null); }}>清除日期</button>}
          </div>
        )}

        {/* 循环 */}
        <button className={`pill${task.repeat ? " hot" : ""}`} onClick={() => setMenu(menu === "repeat" ? null : "repeat")}>
          ↻ {task.repeat ? describeRepeat(task.repeat) : "循环"}
        </button>
        {menuPop.shown === "repeat" && (
          <div className={`popmenu${menuPop.leaving ? " leaving" : ""}`} style={{ top: "110%", left: 90 }}>
            <button className="item" onClick={() => setRepeat({ kind: "daily", every: 1 })}>每天</button>
            <button className="item" onClick={() => setRepeat({ kind: "workday" })}>每个工作日</button>
            <button className="item" onClick={() => setRepeat({ kind: "weekly", days: [wd] })}>
              {describeRepeat({ kind: "weekly", days: [wd] })}
            </button>
            <button className="item" onClick={() => setRepeat({ kind: "monthly", day: dom })}>每月{dom}号</button>
            {task.repeat && (
              <>
                <div className="sep" />
                <button className="item" onClick={() => setRepeat(null)}>不再循环</button>
              </>
            )}
          </div>
        )}

        {/* 清单 */}
        <button className="pill" onClick={() => setMenu(menu === "list" ? null : "list")}>
          {list ? (
            <>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: `var(--list-${list.color})`, display: "inline-block" }} />
              {list.name}
            </>
          ) : (
            "随手记"
          )}
        </button>
        {menuPop.shown === "list" && (
          <div className={`popmenu${menuPop.leaving ? " leaving" : ""}`} style={{ top: "110%", left: 180 }}>
            <button className="item" onClick={() => { updateTask(task.id, { listId: null }); setMenu(null); }}>随手记</button>
            {lists.map((l) => (
              <button key={l.id} className="item" onClick={() => { updateTask(task.id, { listId: l.id }); setMenu(null); }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: `var(--list-${l.color})`, display: "inline-block" }} />
                {l.name}
              </button>
            ))}
          </div>
        )}

        {/* 需求方：一件事可以挂好几个人，挂了谁就一人一行，点 × 摘掉 */}
        <button className={`pill${task.who.length ? " hot" : ""}`} onClick={() => setMenu(menu === "who" ? null : "who")}>
          ＠ {task.who.length ? task.who.join("、") : "需求方"}
        </button>
        {menuPop.shown === "who" && (
          <div className={`popmenu${menuPop.leaving ? " leaving" : ""}`} style={{ top: "110%", left: 250 }}>
            {task.who.map((w) => (
              <button key={w} className="item" title="移除这个需求方" onClick={() => removeTaskWho(task.id, w)}>
                ＠ {w}
                <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>×</span>
              </button>
            ))}
            {task.who.length > 0 && <div className="sep" />}
            <input
              className="inline"
              ref={whoInputRef}
              autoFocus
              placeholder={task.who.length ? "再加一个需求方，回车确定" : "需求方，回车确定"}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  commitWho(); // 落库并清空，留在原地接着加下一个，不用重开菜单
                }
                // Esc 才是丢弃：**框里有字才吃掉这一下**（擦掉这一半）。
                // 空框上再按 Esc 就放行，让它冒泡上去收卡片——不然打开这个弹层之后
                // 按几下 Esc 都收不掉卡片（口径跟 onEscape 一致）
                if (e.key === "Escape") {
                  const el = e.target as HTMLInputElement;
                  whoSettled.current = true; // Esc 是丢弃，别让紧接着的失焦把它补交上去
                  if (el.value) {
                    e.stopPropagation();
                    el.value = "";
                  }
                }
              }}
              // 又开始打字 / 又回到框里 = 还有话要说，把「已交代过」的闸门放回去
              onChange={() => { whoSettled.current = false; }}
              onFocus={() => { whoSettled.current = false; }}
              // A1：点走 = 提交。走同一个口，点卡外那条路已经交代过就不再交代第二遍。
              // **窗口失焦不是点走**：alt-tab 出去时浏览器照样发 blur，落库就等于
              // 拿打了一半的「李」建出一个新需求方（还会进侧栏那份需求方列表）。
              // 整个悬着，等用户回来自己了结（回车提交 / Esc 丢弃）
              onBlur={() => { if (document.hasFocus()) commitWho(); }}
            />
            {task.who.length > 0 && (
              <button className="item" onClick={() => { setTasksWho([task.id], []); setMenu(null); }}>全部清除</button>
            )}
          </div>
        )}

        {/* 优先级 */}
        <button className={`pill${task.priority ? " hot" : ""}`} onClick={() => setMenu(menu === "priority" ? null : "priority")}>
          ⚑ {PRIORITY_LABEL[task.priority]}
        </button>
        {menuPop.shown === "priority" && (
          <div className={`popmenu${menuPop.leaving ? " leaving" : ""}`} style={{ top: "110%", left: 330 }}>
            {([3, 2, 1, 0] as Priority[]).map((p) => (
              <button key={p} className="item" onClick={() => { updateTask(task.id, { priority: p }); setMenu(null); }}>
                <span className={`flag p${p}`} />
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
        )}

        {/* 标签 */}
        <button className={`pill${task.tags.length ? " hot" : ""}`} onClick={() => setMenu(menu === "tags" ? null : "tags")}>
          # {task.tags.length ? task.tags.join("、") : "标签"}
        </button>
        {menuPop.shown === "tags" && (
          <div className={`popmenu${menuPop.leaving ? " leaving" : ""}`} style={{ top: "110%", left: 380 }}>
            <input
              className="inline"
              ref={tagInputRef}
              autoFocus
              placeholder="多个用空格分开，回车确定"
              defaultValue={task.tags.join(" ")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  commitTags();
                  setMenu(null);
                }
                // Esc 还原成这件事现在的标签。**只有确实有东西可丢弃时才吃掉这一下**：
                // 已经跟现在的标签一模一样就放行，让它冒泡上去收卡片
                // （否则打开这个弹层之后按几下 Esc 都收不掉卡片）
                if (e.key === "Escape") {
                  const el = e.target as HTMLInputElement;
                  const cur = task.tags.join(" ");
                  tagsSettled.current = true; // Esc 是丢弃，别让紧接着的失焦把它补交上去
                  if (el.value !== cur) {
                    e.stopPropagation();
                    el.value = cur;
                  }
                }
              }}
              // 又开始打字 / 又回到框里 = 还有话要说，把「已交代过」的闸门放回去
              onChange={() => { tagsSettled.current = false; }}
              onFocus={() => { tagsSettled.current = false; }}
              // A1：点走 = 提交。走同一个口：没改过就别写，点卡外那条路已经交代过的也不写第二遍。
              // **窗口失焦不是点走**：alt-tab 出去时那句改了一半的字串会被写成这件事的全部标签
              onBlur={() => { if (document.hasFocus()) commitTags(); }}
            />
          </div>
        )}

        {/* 放弃和删除都跟上面那排「改属性」的胶囊隔开：这两个是仅有的「按下去东西会从列表里消失」的键，
            挨着放迟早误点（2026-08-28 用户就问过「怎么直接消失了」） */}
        <span className="tc-gap" />
        <button
          className="pill drop-pill"
          title={task.droppedAt ? "取消放弃，放回未完成" : "放弃：这件事不做了。它不算完成，收进「已完成」的「放弃的」里，随时能反悔"}
          onClick={() => {
            expandTask(null);
            dropTasks([task.id], !task.droppedAt);
          }}
        >
          {task.droppedAt ? "↩ 取消放弃" : "⊘ 放弃"}
        </button>
        <button className="pill danger-pill" title="删除（可在回收站恢复，也可 Ctrl+Z 撤销）" onClick={() => { expandTask(null); deleteTasks([task.id]); }}>
          🗑
        </button>

        {/* 专注暂时收起，见 core/features.ts */}
        {FOCUS_ENABLED && !task.done && (
          <button
            className="focus-go"
            onClick={() => {
              expandTask(null);
              void startFocus(task.id);
            }}
          >
            ▶ 专注
          </button>
        )}
      </div>

      {/* 整句改：这一栏里就是这件事的一句话（现算的，不是当初输入的那句）。改它就是改这件事 */}
      <div className="tc-sentence">
        <span className="tc-sentence-tag">{sentence.safe ? "整句改" : "快捷改"}</span>
        <SyntaxInput
          value={live}
          onChange={(v) => setDraft({ base: baseText, text: v })}
          onSubmit={(p) => commitSentence(p, live)}
          // A1：点走 = 提交，走的还是 commitSentence 那一条路，两条保险一个不少
          onBlurCommit={(p) => {
            if (live === baseText) return false; // 没改过就别写
            commitSentence(p, live);
            return true;
          }}
          // A3 草稿保护：有草稿时第一下 Esc 只把这句还原（跟右边那个 ↺ 一个意思），
          // 第二下才冒泡出去收卡片。手一抖不至于前功尽弃
          onEscape={() => {
            if (live === baseText) return false;
            setDraft(null);
            return true;
          }}
          onShiftEnter={() => expandTask(null)}
          placeholder={
            sentence.safe
              ? "改这句话就是改这件事，回车生效"
              : "快捷改：输入「明天 15点 !高 #标签 /清单 @人」，写了哪类改哪类，回车生效"
          }
          lists={lists.map((l) => l.name)}
          tags={tagNames}
          whos={whoNames}
          showChips
          // 长句子在这儿换行显示，不再被右边界切掉半截（v1.9.1）。
          // 只有这一处开：随手记那条是个一行高的横条、快捷记浮窗是固定大小的系统窗口，
          // 那两处长高了会把宿主的版式顶变形
          multiline
          inputStyle={{ fontSize: 12.5, padding: "5px 9px" }}
        />
        {sentence.safe && live !== baseText && (
          <button className="tc-restore" title="放弃当前编辑，退回这件事现在的样子" onClick={() => setDraft(null)}>↺</button>
        )}
      </div>
    </div>
  );
}
