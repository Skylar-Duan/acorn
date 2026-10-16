// 展开的任务卡：原地编辑一切字段。Esc / 点击卡外收起。
// 标题编辑支持快捷标记；Enter / 点走提交，Esc 丢弃本次标题草稿。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Priority, RepeatRule, Subtask, Task, TaskImage } from "../core/model";
import { cmpYMD, formatShort, isPlausibleYMD, todayYMD } from "../core/dates";
import { dateOptions } from "../core/options";
import { taskDue, taskTime } from "../core/taskDue";
import { describeRepeat, firstOccurrence } from "../core/recur";
import { appendedSubCategories, editedCategoryPatch, editedTitlePatch, parseEditedTitle } from "../core/editSyntax";
import { isTaskCategoryDialogOpen, prepareSubtaskCategories, prepareTaskCategories } from "../core/categoryCreation";
import { IS_ULTRA } from "../core/version";
import { imageListUpdateError, taskImages } from "../core/taskImages";
import { imageEditContext } from "../core/imageEditContext";
import { rememberTaskSubtasksFolded, taskSubtasksFolded } from "../core/subtaskFold";
import { listColor } from "../core/colors";
import {
  addSubtask, addTasksWho, allTags, allWho, appStore, completeTask, deleteTasks, dropSubtask,
  dropTasks, expandTask, foldDoneSubs, removeSubtask, removeTaskWho, setTasksWho, splitSubtasks,
  showToast, SUB_DONE_PEEK, toggleSubtask, uncompleteTask, updateSubtask, updateTask, useApp,
} from "../core/store";
import { startFocus } from "../core/focusCtl";
import { FOCUS_ENABLED } from "../core/features";
import SyntaxInput from "./SyntaxInput";
import { growArea, keepLines, oneLine } from "./autogrow";
import DateField from "./DateField";
import type { DateFieldHandle } from "./DateField";
import RepeatPicker from "./RepeatPicker";
import RepeatMenu from "./RepeatMenu";
import { useLeaving } from "./motion";
import { CommitMark, FLASH_MS, TYPING_IDLE_MS, useTypingFlash } from "./commitFlash";
import ImageAttachments from "./ImageAttachments";

const PRIORITY_LABEL: Record<Priority, string> = { 0: "无", 1: "低", 2: "中", 3: "高" };

/** 日期弹层里的每一次写库都带上它：**弹层期间一律不数顺延**。
 *  「这件事被往后推了几次」按弹层开→关整段算一次，落在 settleDuePopup 里 */
const POPUP_WRITE = { noPostponeCount: true } as const;

type MenuName = "date" | "repeat" | "list" | "priority" | "who" | "tags" | null;

export default function TaskCard({ task }: { task: Task }) {
  // B8：只订阅真用得上的三片，派生也都缓存起来。以前是整份 data + 每次渲染重算一遍
  // allWho/allTags——在标题框里打一个字并不改数据，不该重复统计全库需求方和标签
  const lists = useApp((s) => s.data.lists);
  const tasks = useApp((s) => s.data.tasks);
  const settings = useApp((s) => s.data.settings);
  const tagNames = useMemo(() => allTags({ tasks }).map((t) => t.tag), [tasks]);
  const whoNames = useMemo(() => allWho({ tasks, settings }).map((w) => w.who), [tasks, settings]);
  const [menu, setMenu] = useState<MenuName>(null);
  const [subMenu, setSubMenu] = useState<{ id: string; kind: "date" | "prio" } | null>(null);
  /** 循环弹层现在显示的是常用项（false）还是「自定义…」面板（true）。点 ↻ 那颗小签打开时一律回到常用项 */
  const [repeatCustom, setRepeatCustom] = useState(false);
  /** 弹层退场那一拍（B6）：关掉的时候得让它多活一会儿把动画演完，不然是「啪一下没了」。
   *  真正的开关状态照旧是 menu / subMenu，下面那些判断和收尾一个字都没动 */
  const menuPop = useLeaving(menu);
  const subPop = useLeaving(subMenu);
  const [newSub, setNewSub] = useState("");
  const newSubRef = useRef("");
  const [newSubImages, setNewSubImages] = useState<TaskImage[]>([]);
  const newSubImagesRef = useRef<TaskImage[]>([]);
  const newSubImageBusy = useRef(false);
  const newSubImageRevision = useRef(0);
  /** 已完成子任务那堆展不展开。null = 还没表过态，跟自动规则走；
   *  用不得直接存 boolean：那样刚勾掉一条子任务、已完成刚够数的时候自动规则就再也不生效了。
   *  用户自己点过之后才锁成他选的那个 */
  const [showDone, setShowDone] = useState<boolean | null>(null);
  const [openFold, setOpenFold] = useState(() => ({ id: task.id, folded: taskSubtasksFolded(task.id) }));
  const openFolded = openFold.id === task.id ? openFold.folded : taskSubtasksFolded(task.id);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const titleDraftRef = useRef<string | null>(null);
  const [subDrafts, setSubDrafts] = useState<Record<string, string>>({});
  const subDraftsRef = useRef<Record<string, string>>({});
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
   *  会被这一笔再数一遍。三条真路径：① 点开 📅 看了一眼没选，转头在底下标题编辑那栏
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
  /** 「点卡片里的别处 = 只收浮层、不收卡片」的收尾函数。跟 flushRef 同一个道理：
   *  那条 document 监听的闭包停在首帧，读不到最新的 menu / subMenu，只能挂 ref */
  const closeMenusRef = useRef<() => void>(() => {});
  /** 同上：那条监听的闭包停在首帧，要认「我是哪一件事」只能靠 ref 每次渲染刷新 */
  const taskIdRef = useRef(task.id);
  taskIdRef.current = task.id;

  // 已提交的标题与逐键保存的备注有变化时，停手后闪一下回执。
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
      if (!cardRef.current) return;
      // 分类创建弹窗是这笔标题编辑的一部分，点它不应再提交或收起卡片。
      if (isTaskCategoryDialogOpen()) return;
      if (e.target instanceof Element && e.target.closest("[data-image-dialog]")) return;
      if (!cardRef.current.contains(e.target as Node)) {
        // A1「点走 = 提交」：卡片马上就要没了，先把还悬着的输入落库再收
        flushRef.current();
        expandTask(null);
        return;
      }
      // 点在卡里：浮层该跟着走人了（v1.15.0）。以前只有「再点一下那个小签」才关得掉，
      // 于是点开日期浮层之后想去改标题，得先回头点一下 📅 才行——用户原话「点别处要自动消失」。
      // 两处放过：
      //   · 浮层自己（.popmenu）：里面就是给人点的，预设/日历格/时间框/需求方标签的输入框都在里头
      //   · 任何小签（.pill）：mousedown 比按钮自己的 click 早一步，不放过的话
      //     「点 📅 把它收起来」会变成这儿先关掉、紧接着 click 又把它开回来，那颗键就永远按不动了
      const hit = e.target instanceof Element ? e.target : null;
      if (hit?.closest(".popmenu") || hit?.closest(".pill")) return;
      closeMenusRef.current();
    }
    function onKey(e: KeyboardEvent) {
      // Esc 是**丢弃**，不是「点走 = 提交」那条路（见 flushPending 的注释）。
      // 光收卡片不行：卡片一卸载 DateField 会自己 flush 一次，把日期框里刚敲了一半
      // （月段改完、日段还没改）的那一天当成最终结果落库，结算再判它比原来晚，+1 顺延——
      // 「丢弃」这条通道反而把用户从没想要的日子钉死了。
      // 所以先收尾再收卡：欠着的那一拍作废，这次弹层的记账清空（结算那儿直接 return）
      if (e.key === "Escape") {
        if (isTaskCategoryDialogOpen()) return;
        titleDraftRef.current = null;
        subDraftsRef.current = {};
        setTitleDraft(null);
        setSubDrafts({});
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
  // **别处改进来的**：快捷标记、撤销、云同步拉回一份、或者换了一件事
  // （卡片按任务 id 认 key，同一件事换标题时组件是不重建的）
  useLayoutEffect(() => {
    growArea(titleRef.current);
  }, [task.title, titleDraft]);
  // 子任务那一堆同理。它们没有各自的 ref（是个 map 出来的列表），
  // ref={growArea} 只在挂载那一下调一次，所以外部改动（撤销/同步/标题编辑）得在这儿补一遍。
  // 只扫这张卡自己的 .subs，不动别处
  useLayoutEffect(() => {
    cardRef.current?.querySelectorAll<HTMLTextAreaElement>(".subs textarea").forEach((el) => growArea(el));
  }, [task.subtasks, subDrafts]);

  const list = task.listId ? lists.find((l) => l.id === task.listId) : null;
  const today = todayYMD();
  const shownDue = taskDue(task);
  const shownTime = taskTime(task);

  // 已经做完的子任务沉到最下面，多了还要收起来（只改显示顺序，存的那份数组原样不动）。
  // 用户口径：「子任务已通过的排到最下面」——上面永远是还欠着的。
  // 母任务整件事一起传进去：没自己填日期的那几步排序时按母任务的日子算，跟屏幕上显示的一致，
  // 所以母任务改了日期这一堆也要重排（依赖里带上 due / dueTime）
  const { open: openSubs, done: doneSubs } = useMemo(
    () => splitSubtasks(task.subtasks, task),
    [task.subtasks, task.due, task.dueTime],
  );
  const autoFold = foldDoneSubs(task.subtasks);
  // 够数才给折叠开关（只勾掉一两条时摊开就是了，不必多一行按钮）。
  // 不够数时强制摊开：否则「先折起来、再取消勾选几条」会把已完成子任务锁成看不见又开不出来
  const canFoldDone = doneSubs.length >= SUB_DONE_PEEK;
  const doneShown = canFoldDone ? showDone ?? !autoFold : true;

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
   *  标题编辑那栏把日期改晚（普通 updateTask，store 自己 +1），回头关弹层再 +1，
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
  async function addSubFromInput(): Promise<boolean> {
    if (newSubImageBusy.current) { showToast("图片还在处理，请稍候再保存", false); return false; }
    // keepNewlines：栏里 Shift+Enter 敲的换行要一路留进标题（记一条那几条路不开，照旧压成空格）
    const raw = newSubRef.current;
    const images = newSubImagesRef.current;
    const revision = newSubImageRevision.current;
    const capacity = imageListUpdateError(appStore.getState().data, [], IS_ULTRA ? images : []);
    if (capacity) { showToast(capacity, false); return false; }
    const r = parseEditedTitle(raw, { now: new Date(), listNames: lists.map((l) => l.name), weekendDay: settings.weekendDay, keepNewlines: true, skip: ["tag"] });
    const title = r.title.trim();
    if (!title) return false;
    newSubRef.current = "";
    setNewSub("");
    const categories = await prepareSubtaskCategories(r.chips.filter((c) => c.kind === "list").map((c) => c.text), r.who,
      () => newSubImageRevision.current === revision && !imageListUpdateError(appStore.getState().data, [], IS_ULTRA ? images : []) && appStore.getState().data.tasks.some((t) => t.id === task.id && !t.deletedAt));
    if (!categories) {
      // 取消创建仍保留这句草稿；等待期间若已打了下一句，就不覆盖新输入。
      if (!newSubRef.current && appStore.getState().ui.expandedId === task.id) {
        newSubRef.current = raw;
        setNewSub(raw);
      }
      return false;
    }
    addSubtask(task.id, title, {
      due: r.due,
      dueTime: r.dueTime,
      priority: r.priority || null,
      // 子任务自己的循环（v8）：「每周末 大扫除」记成一条每周重复的子任务，不是一次性的周末
      repeat: r.repeat,
      who: categories.who,
      listIds: categories.listIds,
      ...(IS_ULTRA && images.length ? { images } : {}),
    });
    if (newSubImagesRef.current === images) { newSubImagesRef.current = []; setNewSubImages([]); newSubImageRevision.current++; }
    return true;
  }

  /** 标题只有提交时才解析。先确认新分类，取消整笔不写任务。 */
  async function commitTitle() {
    const raw = titleDraftRef.current;
    if (raw === null) return;
    titleDraftRef.current = null;
    setTitleDraft(null);
    const state = appStore.getState();
    const current = state.data.tasks.find((t) => t.id === task.id && !t.deletedAt);
    if (!current || raw === current.title || !raw.trim()) return;
    const parsed = parseEditedTitle(raw, {
      now: new Date(), listNames: state.data.lists.map((l) => l.name), weekendDay: state.data.settings.weekendDay,
    });
    const categories = await prepareTaskCategories(parsed.listName, parsed.who, current.listId,
      () => appStore.getState().data.tasks.some((t) => t.id === task.id && !t.deletedAt));
    if (!categories) return;
    const latest = appStore.getState().data.tasks.find((t) => t.id === task.id && !t.deletedAt);
    if (!latest) return;
    const patch = {
      ...editedTitlePatch(latest, parsed),
      ...editedCategoryPatch(latest, { ...parsed, who: categories.who }, categories.listId),
    };
    if (Object.keys(patch).length) updateTask(task.id, patch);
  }

  async function commitSubTitle(id: string) {
    const raw = subDraftsRef.current[id];
    if (raw === undefined) return;
    const drafts = { ...subDraftsRef.current };
    delete drafts[id];
    subDraftsRef.current = drafts;
    setSubDrafts(drafts);
    const state = appStore.getState();
    const current = state.data.tasks.find((t) => t.id === task.id && !t.deletedAt);
    const sub = current?.subtasks.find((s) => s.id === id && !s.deletedAt);
    if (!current || !sub || raw === sub.title || !raw.trim()) return;
    const parsed = parseEditedTitle(raw, { now: new Date(), listNames: state.data.lists.map((l) => l.name), weekendDay: state.data.settings.weekendDay, keepNewlines: true, skip: ["tag"] });
    const categories = await prepareSubtaskCategories(parsed.chips.filter((c) => c.kind === "list").map((c) => c.text), parsed.who,
      () => !!appStore.getState().data.tasks.find((t) => t.id === task.id && !t.deletedAt)?.subtasks.some((s) => s.id === id && !s.deletedAt));
    if (!categories) return;
    const latest = appStore.getState().data.tasks.find((t) => t.id === task.id && !t.deletedAt)?.subtasks.find((s) => s.id === id && !s.deletedAt);
    if (!latest) return;
    const patch = { ...editedTitlePatch(latest, parsed), ...appendedSubCategories(latest, categories.who, categories.listIds) };
    if (Object.keys(patch).length) {
      updateSubtask(task.id, id, patch);
      touchSub(id);
    }
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
  async function commitWho() {
    const el = whoInputRef.current;
    if (!el || whoSettled.current) return;
    whoSettled.current = true;
    const v = el.value.trim();
    if (!v) return;
    el.value = "";
    const result = await prepareTaskCategories(null, [v], null,
      () => appStore.getState().data.tasks.some((t) => t.id === task.id && !t.deletedAt));
    if (!result || !appStore.getState().data.tasks.some((t) => t.id === task.id && !t.deletedAt)) return;
    result.who.forEach((who) => addTasksWho([task.id], who));
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
    void commitTitle();
    for (const id of Object.keys(subDraftsRef.current)) void commitSubTitle(id);
    // 打了一半还没回车的新子任务
    if (newSub.trim()) addSubFromInput();
    // ③④ 需求方 / 标签两个内联框，只在各自的弹层开着时才有值可捞
    if (menu === "who") commitWho();
    if (menu === "tags") commitTags();
    // ⑤ 日期框里刚敲完、去抖还没烧到点的那一次。**只是提前做掉**，不是补一次：
    //   没欠着的时候它什么都不做（欠着的那一次即便不 flush 也会自己烧到点，不会丢）
    dueFieldRef.current?.flush();
  }
  flushRef.current = flushPending;

  /** 点了卡片里的别处（标题、备注、子任务那片、卡片空白）时的收尾：**只收浮层，卡片留着**。
   *  卡片里同时只可能开着一个浮层，但开关分散在 menu / subMenu 两处，一并关掉最省心。
   *
   *  带输入框的那两个（需求方 / 标签）收之前先落一次库，跟「点卡外」走的是同一条路
   *  （commitWho / commitTags 自带闸门，重复调用不会写第二遍）——不这么做的话，
   *  在标签框里打完字顺手点一下卡片空白，那句话就白打了。
   *
   *  日期那边不用在这儿操心：欠着的那一次和顺延结算都挂在 menu 那个 effect 的清理里
   *  （settleDuePopup），menu 一变成 null 自己就跑了 */
  function closeMenus() {
    if (menu === "who") commitWho();
    if (menu === "tags") commitTags();
    setMenu(null);
    setSubMenu(null);
  }
  closeMenusRef.current = closeMenus;

  // 循环菜单的「每周X/每月X号」按任务自己的日期取形（没有日期按今天）。
  // 星期几在 core/options.repeatCommon 里走 dayOfWeek（本地日期），不按 UTC 解析——
  // 西半球时区不会差一天。菜单有哪几项、什么顺序也在那儿（全应用一套），这儿只交 anchor 和现值
  const repeatAnchor = task.due ?? today;
  // 选日子的快捷项（今天 / 明天 / 本周末 / 下周末 / 本月末）：全应用一套，规则和单测都在 core/options.ts。
  // 主任务的日期弹层和子任务的日期小签都用它
  const presets = dateOptions(today, { weekendDay: settings.weekendDay });

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
          value={subDrafts[s.id] ?? s.title}
          onChange={(e) => {
            growArea(e.currentTarget);
            // 子任务标题可以是几行（用户要的）：换行留着，粘进来的也留着，只统一 \r\n
            const drafts = { ...subDraftsRef.current, [s.id]: keepLines(e.target.value) };
            subDraftsRef.current = drafts;
            setSubDrafts(drafts);
          }}
          // Enter 拦下来什么都不做（它不是「换行」也不是「收卡」，老规矩）。
          // **Shift+Enter 在子任务里是换行**，放给 textarea 自己插——跟母任务标题、备注那边
          // 「Shift+Enter 收卡」不一样；子任务里想收卡按 Esc 或点卡外
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            if (e.shiftKey) return;
            e.preventDefault();
            void commitSubTitle(s.id);
          }}
          onBlur={() => { if (document.hasFocus()) void commitSubTitle(s.id); }}
        />
        <CommitMark on={subFlash === s.id} />
        {/* 放弃了的那一步：圈圈不动，只在旁边挂个灰标签 */}
        {s.droppedAt && <span className="drop-tag">已放弃</span>}
        {/* 这一步会重复（v8）。跟「已放弃」同一副长相（.drop-tag 那套圆角小签），
            一眼看得出勾掉它不是了结、是推到下一次 */}
        {s.repeat && (
          <span className="sub-rep" title={`这一步会重复：${describeRepeat(s.repeat)}`}>
            ↻ {describeRepeat(s.repeat)}
          </span>
        )}
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
        {((s.who?.length ?? 0) > 0 || (s.listIds?.length ?? 0) > 0) && (
          <span className="sub-categories" aria-label="子任务追加归类">
            {(s.who ?? []).map((who) => (
              <span className="sub-category" key={`who:${who}`}>
                @{who}<button type="button" aria-label={`移除子任务需求方 ${who}`} onClick={() => updateSubtask(task.id, s.id, { who: s.who?.filter((w) => w !== who) })}>×</button>
              </span>
            ))}
            {(s.listIds ?? []).map((id) => {
              const ownList = lists.find((l) => l.id === id);
              return ownList ? <span className="sub-category" key={`list:${id}`}>
                /{ownList.name}<button type="button" aria-label={`移除子任务清单 ${ownList.name}`} onClick={() => updateSubtask(task.id, s.id, { listIds: s.listIds?.filter((l) => l !== id) })}>×</button>
              </span> : null;
            })}
          </span>
        )}
        {IS_ULTRA && <div className="sub-images"><ImageAttachments images={taskImages(s.images)} label="这一步的图片"
          canEdit={() => !!appStore.getState().data.tasks.find((t) => t.id === task.id && !t.deletedAt)?.subtasks.some((sub) => sub.id === s.id && !sub.deletedAt)}
          onChange={(images) => updateSubtask(task.id, s.id, { images })} /></div>}
        {subPop.shown?.id === s.id && subPop.shown.kind === "date" && (
          <div className={`popmenu${subPop.leaving ? " leaving" : ""}`} style={{ top: "100%", right: 0 }}>
            {/* 预设跟任务卡那个日期弹层同一套（core/options.dateOptions），别在这儿另写一份；
                下面那个日期框就是「选日期…」 */}
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
          value={titleDraft ?? task.title}
          placeholder="任务标题，可加 ~明天 @人 /清单"
          onChange={(e) => {
            growArea(e.currentTarget);
            const text = oneLine(e.target.value);
            titleDraftRef.current = text;
            setTitleDraft(text);
          }}
          // A8「一路回车敲完一张卡」：回车不再是收卡片，而是走到下一个框（备注）。
          // 想收卡片按 Shift+Enter——收卡这件事从「最容易误触的键」挪成「要多按一个键」。
          // ⚠️ 换成 textarea 之后这段更不能少：Enter 在 textarea 里默认是插一个换行，
          // 不拦的话敲回车不是跳备注，而是把标题敲成两行
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void commitTitle();
            if (e.shiftKey) expandTask(null);
            else notesRef.current?.focus();
          }}
          onBlur={() => { if (document.hasFocus()) void commitTitle(); }}
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

      <ImageAttachments images={taskImages(task.images)}
        canEdit={() => appStore.getState().data.tasks.some((t) => t.id === task.id && !t.deletedAt)}
        onChange={(images) => updateTask(task.id, { images })} />
      <div className="subs">
        {openSubs.length > 0 && <button type="button" className="tc-openfold" aria-expanded={!openFolded} aria-controls={`pending-subs-${task.id}`}
          onClick={() => { const folded = !openFolded; rememberTaskSubtasksFolded(task.id, folded); setOpenFold({ id: task.id, folded }); }}>
          <span className={`tc-openfold-chevron${openFolded ? " folded" : ""}`} aria-hidden="true">⌄</span>
          待办子任务 <span className="tc-openfold-count">{openSubs.length}</span>
        </button>}
        <div id={`pending-subs-${task.id}`}>{!openFolded && openSubs.map(renderSub)}</div>

        {/* 添加栏排在已完成上面：做完的越攒越多，压在下面就得先滚过一堆划线的字才够得着 */}
        {/* 子任务同样认时间、需求方和清单；归类只追加到本步，#仍保留在正文。 */}
        <div className="sub-row">
          <span className="sb" style={{ opacity: 0.35 }} />
          <SyntaxInput
            value={newSub}
            onChange={(v) => { newSubRef.current = v; setNewSub(v); }}
            onSubmit={addSubFromInput}
            // A1：打了一半点走也算数（addSubFromInput 空标题自己会退回，不会加出空条）。
            // 照实汇报加上没有：只打了「明天」没打标题时一条都没加，右边就不该浮出 ✓
            onBlurCommit={() => addSubFromInput()}
            // Esc 先擦掉这一条，第二下才轮到收卡片
            onEscape={() => {
              if (!newSub && !newSubImagesRef.current.length) return false;
              newSubRef.current = "";
              setNewSub("");
              newSubImagesRef.current = []; setNewSubImages([]); newSubImageRevision.current++;
              return true;
            }}
            // 长句子折行、框跟着长高（不再单行一直往左推）；Shift+Enter 是换行，写进这条子任务的标题。
            // 所以这里不接 onShiftEnter：子任务里收卡按 Esc（有字时第二下）或点卡外
            allowNewline
            placeholder="＋ 子任务，回车添加（可以写「~明天 !高」）"
            lists={lists.map((l) => l.name)}
            tags={[]}
            whos={whoNames}
            skip={["tag"]}
            weekendDay={settings.weekendDay}
            inputStyle={{ fontSize: 13 }}
          />
          {IS_ULTRA && <div className="sub-images"><ImageAttachments images={newSubImages} label="新子任务图片" draft
            onBusyChange={(busy) => { newSubImageBusy.current = busy; }}
            canEdit={() => appStore.getState().data.tasks.some((t) => t.id === task.id && !t.deletedAt)}
            createContext={() => { const revision = newSubImageRevision.current; return imageEditContext(() => newSubImageRevision.current === revision && appStore.getState().data.tasks.some((t) => t.id === task.id && !t.deletedAt)); }}
            onChange={(images) => { if (!images.length) newSubImageRevision.current++; newSubImagesRef.current = images; setNewSubImages(images); }} /></div>}
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
        <button className={`pill${shownDue ? " hot" : ""}`} onClick={openDateMenu}
          title={!task.due && shownDue ? "最近子任务的安排；点开可为母任务单独安排日期" : undefined}>
          📅 {shownDue ? `${formatShort(shownDue)}${shownTime ? " " + shownTime : ""}${!task.due ? " · 最近子任务" : ""}` : "安排日期"}
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
        <button
          className={`pill${task.repeat ? " hot" : ""}`}
          onClick={() => { setRepeatCustom(false); setMenu(menu === "repeat" ? null : "repeat"); }}
        >
          ↻ {task.repeat ? describeRepeat(task.repeat) : "循环"}
        </button>
        {menuPop.shown === "repeat" && (
          <div className={`popmenu${menuPop.leaving ? " leaving" : ""}`} style={{ top: "110%", left: 90 }}>
            {repeatCustom ? (
              // 自定义面板就在这块 .popmenu 里换内容，点卡外 / 点别处收起的规矩原样适用
              <RepeatPicker
                value={task.repeat ?? null}
                anchor={repeatAnchor}
                onDone={(r) => setRepeat(r)}
                onCancel={() => setRepeatCustom(false)}
              />
            ) : (
              // 全应用一套（core/options.repeatMenu）：[现值 ✓] 每天 / 每个工作日 / 每周X / 每月X号 /
              // 每隔几天… / 自定义… / 不重复。点现值或「自定义…」换成上面那个面板
              <RepeatMenu
                anchor={repeatAnchor}
                value={task.repeat ?? null}
                onPick={setRepeat}
                onCustom={() => setRepeatCustom(true)}
              />
            )}
          </div>
        )}

        {/* 清单 */}
        <button className="pill" onClick={() => setMenu(menu === "list" ? null : "list")}>
          {list ? (
            <>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: listColor(list.color), display: "inline-block" }} />
              {list.name}
            </>
          ) : (
            "未分清单"
          )}
        </button>
        {menuPop.shown === "list" && (
          <div className={`popmenu${menuPop.leaving ? " leaving" : ""}`} style={{ top: "110%", left: 180 }}>
            <button className="item" onClick={() => { updateTask(task.id, { listId: null }); setMenu(null); }}>不归清单</button>
            {lists.map((l) => (
              <button key={l.id} className="item" onClick={() => { updateTask(task.id, { listId: l.id }); setMenu(null); }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: listColor(l.color), display: "inline-block" }} />
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


    </div>
  );
}
