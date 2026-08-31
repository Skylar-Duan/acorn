// 应用状态中枢（zustand）。所有数据变更必须经 mutate() —— 它负责撤销快照与延迟落盘。
// UI 层只调用这里导出的动作，不直接改 data。

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { AppData, List, Priority, RepeatRule, Settings, Subtask, Task, TaskKind } from "./model";
import { defaultData, newId, newTask, normalizeWho } from "./model";
import { bury } from "./merge";
import { doneOn, isDueOn, sortHabitsForDay, toggleCheck, DEFAULT_HABIT_REPEAT } from "./habits";
import { addDays, cmpYMD, nowLocalDT, todayYMD, toLocalDT, toYMD } from "./dates";
import { firstOccurrence, nextOccurrence } from "./recur";
import * as persist from "./persist";

// 视图 id。2026-08-28 改名对照：all→plan（原「全部」现在叫「计划」）、logbook→done（原「日志」现在叫「已完成」）；
// 原来独立的 upcoming（按天排的计划）撤掉，四象限并进 plan 成了它的一个视图切换
export type ViewId =
  | "inbox" | "today" | "plan" | "done" | "habits"
  | "calendar" | "focus" | "stats" | "settings"
  | "list" | "who" | "tag" | "trash";

export interface UIState {
  view: ViewId;
  /** view==='list' 时生效 */
  listId: string | null;
  /** view==='who' 时生效 */
  who: string | null;
  /** view==='tag' 时生效 */
  tag: string | null;
  expandedId: string | null;
  selectedIds: string[];
  searchOpen: boolean;
  paletteOpen: boolean;
  toast: { msg: string; undoable: boolean; key: number } | null;
  /** 自定义右键菜单：null = 关闭。sub 非空 = 右键落在子任务行上，菜单应收窄为子任务语义 */
  ctxMenu: { x: number; y: number; ids: string[]; sub?: { taskId: string; subId: string } | null } | null;
  /** 子任务链默认收起还是摊开（今天 / 计划两个视图）。收起 = 一件事只占一行「下一步」，
   *  行尾标 +N 表示后面还有几条 */
  foldAll: boolean;
  /** 跟默认相反的那几件事（点了单条的小三角）。切换总开关时清空 */
  foldExcept: string[];
}

const FOLD_KEY = "acorn-fold";

function loadFold(): { foldAll: boolean; foldExcept: string[] } {
  try {
    const raw = localStorage.getItem(FOLD_KEY);
    if (!raw) return { foldAll: false, foldExcept: [] };
    const v = JSON.parse(raw) as { foldAll?: boolean; foldExcept?: string[] };
    return { foldAll: !!v.foldAll, foldExcept: Array.isArray(v.foldExcept) ? v.foldExcept : [] };
  } catch {
    return { foldAll: false, foldExcept: [] };
  }
}

function saveFold(foldAll: boolean, foldExcept: string[]) {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify({ foldAll, foldExcept }));
  } catch {
    /* 存不了就只这次会话记得，不影响用 */
  }
}

export interface FocusState {
  taskId: string | null;
  running: boolean;
  /** epoch ms；running 时有效 */
  endsAt: number | null;
  totalMinutes: number;
}

interface AppState {
  data: AppData;
  loaded: boolean;
  loadError: string | null;
  /** 磁盘上那份数据比本机新（null = 没这回事）。跟 loadError 分开：这不是「坏了」，
   *  是「这台设备太老」，处理方式也不同——只能升级本机，重试和换文件夹都没用。
   *  置上之后一律不写盘（见 doSave），免得用户随手改一下就把降级后的数据盖回磁盘 */
  dataTooNew: { schema: number } | null;
  /** 当前数据是空的，但别处找到了有内容的数据文件夹——由用户拍板要不要用（null = 没这回事） */
  rescue: persist.DataCandidate[] | null;
  /** 本机数据已经被清空（登出时的隐私路径）。置上之后一律不再落盘——
   *  防抖写入、提醒消费的 requestSave、快速添加窗任何一条都能在删完之后再写一份回来 */
  wiped: boolean;
  ui: UIState;
  focus: FocusState;
  undoDepth: number;
}

const UNDO_CAP = 50;
let undoStack: AppData[] = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let toastKey = 0;

export const appStore = createStore<AppState>(() => ({
  data: defaultData(),
  loaded: false,
  loadError: null,
  dataTooNew: null,
  rescue: null,
  wiped: false,
  ui: {
    view: "today", listId: null, who: null, tag: null, ...loadFold(),
    expandedId: null, selectedIds: [], searchOpen: false, paletteOpen: false, toast: null,
    ctxMenu: null,
  },
  focus: { taskId: null, running: false, endsAt: null, totalMinutes: 0 },
  undoDepth: 0,
}));

export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(appStore, selector);
}

// ---------- 落盘 ----------

let inflightSave: Promise<void> | null = null;

function doSave(): Promise<void> {
  const s = appStore.getState();
  // 数据没加载成功时绝不落盘——否则会拿默认空库覆盖磁盘上的真数据。
  // 磁盘上那份比本机新时同理：写回去就是把新版本才有的东西抹掉。
  // wiped：用户刚把本机这份清掉了，任何一次回写都等于白清
  if (s.wiped || !s.loaded || s.loadError || s.dataTooNew) return Promise.resolve();
  const p = persist
    .saveData(s.data)
    .catch((e) => {
      showToast(`保存失败：${String(e)}`, false);
    })
    .finally(() => {
      if (inflightSave === p) inflightSave = null;
    });
  inflightSave = p;
  return p;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void doSave();
  }, 400);
}

/** 给绕过 mutate 的少数场景（提醒消费）用的落盘请求 */
export function requestSave() {
  scheduleSave();
}

/** 立即把待存的数据写掉（退出前调用）。等在途写入一起结束，避免退出竞态 */
export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await doSave();
  }
  if (inflightSave) await inflightSave;
}

/** 清空撤销栈。整份数据被换掉之后必须清——不清的话 Ctrl+Z 一按就把旧的整份写回盘 */
export function clearUndo(): void {
  undoStack = [];
  appStore.setState({ undoDepth: 0 });
}

/** 删本机数据之前的内存侧收尾。顺序本身就是正确性，别调换：
 *  ① flushSave 把攒着的写完（此刻本地与云端刚比对过，写完才是「已全在云端」的那一份）
 *  ② 冲的过程里可能又排上一次防抖，再清一遍定时器
 *  ③ 置 wiped 闸门，从这一刻起 doSave 一律拒绝
 *  ④ 清撤销栈：栈里躺着 50 份完整数据，撤一下就整份写回盘 */
export async function haltPersistence(): Promise<void> {
  await flushSave();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  appStore.setState({ wiped: true, undoDepth: 0 });
  undoStack = [];
}

// ---------- 变更入口 ----------

/** 给云同步盖的「最后改动时刻」戳。
 *  先比对象身份（绝大多数没动的任务是同一个对象，一比就过），身份不同再比内容——
 *  撤销这类操作会重建对象但内容可能没变，只比身份会把整库都标成「刚改过」，
 *  那样第一次同步就会拿本机盖掉云端。 */
function stampChanged<T extends { id: string; updatedAt: string }>(
  prev: T[],
  next: T[],
  at: string,
): T[] {
  const prevById = new Map(prev.map((x) => [x.id, x]));
  let touched = false;
  const out = next.map((x) => {
    const old = prevById.get(x.id);
    if (old === x) return x;
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(x)) return old;
    touched = true;
    return { ...x, updatedAt: at };
  });
  return touched || out.length !== prev.length ? out : next;
}

function stamp(prev: AppData, next: AppData): AppData {
  const at = new Date().toISOString();
  const tasks = next.tasks === prev.tasks ? next.tasks : stampChanged(prev.tasks, next.tasks, at);
  const lists = next.lists === prev.lists ? next.lists : stampChanged(prev.lists, next.lists, at);
  if (tasks === next.tasks && lists === next.lists) return next;
  return { ...next, tasks, lists };
}

/** 所有写操作的唯一入口：应用变更 → 盖改动时刻 → 快照进撤销栈 → 计划落盘。无实际变更时什么都不做 */
function mutate(fn: (d: AppData) => AppData, opts?: { toast?: string; skipUndo?: boolean }) {
  const cur = appStore.getState().data;
  const next = stamp(cur, fn(cur));
  if (next === cur) return; // 无操作（如对已完成任务再次 complete）不压栈不落盘
  if (!opts?.skipUndo) {
    undoStack.push(cur);
    if (undoStack.length > UNDO_CAP) undoStack.shift();
  }
  appStore.setState({ data: next, undoDepth: undoStack.length });
  if (opts?.toast) showToast(opts.toast, !opts?.skipUndo);
  scheduleSave();
}

export function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  // sessions 与 settings 不属于可撤销数据（专注记录/偏好不该被连带回滚），从当前状态嫁接。
  // 逐任务再嫁接两样：已消费的过期提醒不复活（否则撤销会重复轰炸）、focusMinutes 取两边较大值
  const cur = appStore.getState().data;
  const now = nowLocalDT();
  const curById = new Map(cur.tasks.map((t) => [t.id, t]));
  const tasks = prev.tasks.map((pt) => {
    const ct = curById.get(pt.id);
    if (!ct) return pt;
    const reminder = ct.reminder === null && pt.reminder && pt.reminder <= now ? null : pt.reminder;
    const focusMinutes = ct.focusMinutes > pt.focusMinutes ? ct.focusMinutes : pt.focusMinutes;
    // 两样都不用改就把原对象原样还回去——保住对象身份，stamp 才认得出「这条没动过」
    if (reminder === pt.reminder && focusMinutes === pt.focusMinutes) return pt;
    return { ...pt, reminder, focusMinutes };
  });
  // 撤销也是一次改动，被撤回来的那些条要重新盖时刻戳，
  // 否则同步时云端那份「更新」的会把撤销效果又推回来
  const restored = stamp(cur, {
    ...prev,
    tasks,
    sessions: cur.sessions,
    settings: cur.settings,
    graveyard: cur.graveyard,
  });
  appStore.setState({
    data: restored,
    undoDepth: undoStack.length,
    ui: { ...appStore.getState().ui, toast: null },
  });
  scheduleSave();
}

/** 云同步合并完的结果装回来。
 *  **不走 mutate**：合并结果里每条的「最后改动时刻」是算好的，再盖一次戳会把整库
 *  标成本机刚改过，下一轮同步就拿本机盖掉别的设备。
 *  撤销栈一并清掉——「撤销」一次同步没有意义，还会把别的设备刚删的东西拉回来。 */
export function applyRemoteData(data: AppData) {
  const cur = appStore.getState().data;
  if (data === cur) return;
  undoStack = [];
  appStore.setState({ data, undoDepth: 0 });
  scheduleSave();
}

export function showToast(msg: string, undoable: boolean) {
  const ui = appStore.getState().ui;
  appStore.setState({ ui: { ...ui, toast: { msg, undoable, key: ++toastKey } } });
}

export function dismissToast() {
  const ui = appStore.getState().ui;
  appStore.setState({ ui: { ...ui, toast: null } });
}

// ---------- 初始化 ----------

export async function initStore(): Promise<void> {
  try {
    // 上一次「退出登录并清空本机」留下的一次性标记：这一次启动不许建默认账本。
    // defaultData() 带两条**每次都换新 id** 的清单「工作」「生活」，一旦落盘，
    // 用户重新登录就把它们当「本机新建的清单」推上云，云端和另一台设备各多出一对，
    // 只能手工一条条删。空着就好，登录之后云端那份会把内容填回来。
    const freshStart = await persist.takeFreshStart().catch(() => false);
    let res: persist.LoadResult;
    try {
      res = await persist.loadData();
    } catch (first) {
      // 瞬时抖动（移动硬盘唤醒等）重试一次再放弃
      await new Promise((r) => setTimeout(r, 800));
      res = await persist.loadData();
    }
    // 磁盘上那份比本机新：到此为止。不落库、不写盘、不做每日备份——
    // 降级读进来的数据一旦被写回去，新版本才有的东西就没了，用户毫不知情
    if (res.tooNew) {
      // 连内存里那份也换成真正的空账本（lists/tasks 全空）。
      // 模块初始化时的 defaultData() 带着两条**每次启动都换新 id** 的默认清单「工作」「生活」，
      // 那不是用户的账本——数据没真正读进来之前，内存里这份谁都不代表。
      // 将来万一又漏掉某条出口（云同步就漏过一次），推出去的至少不是两条凭空冒出来的清单
      appStore.setState({
        data: { ...defaultData(), lists: [], tasks: [] },
        loaded: true,
        dataTooNew: { schema: res.schema },
        loadError: null,
      });
      return;
    }
    const loadedData = res.data;
    // 刚清空过（freshStart）就用真正的空账本，跟 tooNew 那支一个写法
    const data =
      loadedData ?? (freshStart ? { ...defaultData(), lists: [], tasks: [] } : defaultData());
    // 回收站 30 天自动清理。清掉的同样立墓碑，否则另一台设备同步过来会把它们又拉回来
    const cutoff = Date.now() - 30 * 86400000;
    const expired = data.tasks.filter(
      (t) => t.deletedAt && new Date(t.deletedAt).getTime() <= cutoff,
    );
    if (expired.length) {
      data.tasks = data.tasks.filter((t) => !expired.includes(t));
      data.graveyard = bury(data.graveyard, expired.map((t) => t.id), new Date().toISOString());
    }
    undoStack = []; // 换数据源（含恢复备份后 reload）不能撤销回旧数据
    appStore.setState({ data, loaded: true, loadError: null, dataTooNew: null });

    // 这里空空如也的时候，先别急着建一本空账本落盘——指针指歪 / 换了机器 / 数据在另一个
    // 文件夹时，那本空账本会盖在真数据前面，让人以为数据没了。先去别处找找，找到就让用户选。
    if (data.tasks.length === 0) {
      const found = (await persist.findDataCandidates().catch(() => []))
        .filter((c) => c.tasks > 0);
      if (found.length) {
        appStore.setState({ rescue: found });
        return; // 用户拍板前不写盘、不做备份
      }
    }
    // 刚清空过就连这一下落盘也跳过：盘上一个字都不该留，等登录后由云端填回来
    if (loadedData == null && !freshStart) await persist.saveData(data);
    await persist.ensureDailyBackup();
  } catch (e) {
    appStore.setState({ loaded: true, loadError: String(e) });
  }
}

/** 用户在「找回数据」屏做了选择：接管某个文件夹，或坚持从空的开始 */
export async function resolveRescue(dir: string | null): Promise<void> {
  if (dir) {
    await persist.setDataDir(dir); // 目标已有数据时不会被覆盖，只改指针
    location.reload();
    return;
  }
  appStore.setState({ rescue: null });
  await persist.saveData(appStore.getState().data);
  await persist.ensureDailyBackup();
}

// ---------- 任务动作 ----------

export interface AddTaskInput {
  title: string;
  listId?: string | null;
  tags?: string[];
  who?: string[];
  priority?: Priority;
  due?: string | null;
  dueTime?: string | null;
  repeat?: RepeatRule | null;
  notes?: string;
}

/** 日期变化后提醒的再生规则：dueTime 是第一来源（响过而被清空的提醒随新日期复活），
 *  没有 dueTime 才沿用旧提醒的钟点 */
function regenReminder(t: Task, newDue: string): string | null {
  if (t.dueTime) return toLocalDT(newDue, t.dueTime);
  if (t.reminder) return toLocalDT(newDue, t.reminder.slice(11));
  return null;
}

export function addTask(input: AddTaskInput): string {
  const t = newTask({
    ...input,
    listId: input.listId ?? null,
    tags: input.tags ?? [],
    who: normalizeWho(input.who),
    priority: input.priority ?? 0,
    due: input.due ?? null,
    dueTime: input.dueTime ?? null,
    repeat: input.repeat ?? null,
    order: Date.now(),
  });
  // 有日期+时间 → 自动带提醒；只有日期不打扰
  if (t.due && t.dueTime) t.reminder = toLocalDT(t.due, t.dueTime);
  mutate((d) => ({ ...d, tasks: [...d.tasks, t] }));
  return t.id;
}

export function updateTask(id: string, patch: Partial<Task>) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, ...patch };
      // 顺延计数：把日期改得比原来晚（或从无到有不算）
      if (patch.due !== undefined && t.due && patch.due && cmpYMD(patch.due, t.due) > 0) {
        next.postponeCount = t.postponeCount + 1;
      }
      // 日期/时间变了且原本有提醒 → 提醒跟着走
      if ((patch.due !== undefined || patch.dueTime !== undefined) && next.due) {
        if (next.dueTime) next.reminder = toLocalDT(next.due, next.dueTime);
        else if (t.reminder) next.reminder = toLocalDT(next.due, t.reminder.slice(11));
      }
      if (patch.due === null) {
        next.reminder = null;
        if (patch.dueTime === undefined) next.dueTime = null; // 清日期连带清时间（除非显式另给）
      }
      // 清掉时间点 → 挂在那个时间上的提醒一并清（否则提醒会隐形残留、无处取消）
      if (patch.dueTime === null && patch.reminder === undefined) next.reminder = null;
      return next;
    }),
  }));
}

/** 完成任务。循环任务：留下一条已完成副本，本体推进到下一个落点 */
export function completeTask(id: string) {
  const nowIso = new Date().toISOString();
  // 习惯没有「完成」这回事，勾它就是打今天的卡（再勾一次是撤销）
  const target = appStore.getState().data.tasks.find((x) => x.id === id);
  if (target?.kind === "habit") {
    toggleHabitCheck(id);
    return;
  }
  mutate((d) => {
    const t = d.tasks.find((x) => x.id === id);
    if (!t || t.done) return d;
    if (t.repeat && t.due) {
      const doneCopy: Task = {
        ...t, id: newId(), repeat: null, done: true, doneAt: nowIso,
        subtasks: t.subtasks.map((s) => ({ ...s, id: newId() })),
      };
      // 严重逾期的循环任务补追赶：锚点取 max(旧 due, 今天)，新落点必在未来，
      // 否则完成一次只前进一步、且会立刻生成过去时刻的提醒再响一次
      const anchor = cmpYMD(t.due, todayYMD()) > 0 ? t.due : todayYMD();
      const nd = nextOccurrence(t.repeat, anchor);
      const advanced: Task = {
        ...t,
        due: nd,
        // dueTime 优先再生提醒：响过的提醒（已被 sweep 清成 null）要在新落点复活
        reminder: regenReminder(t, nd),
        // 子任务的专属日期和完成时刻都属于上一轮，随循环推进一并清掉（重新继承母任务）。
        // doneAt 跟 done 同口径：新一轮还没做，就不能挂着上一轮做完的那个时刻。
        // 留在已完成副本（上面那条 doneCopy）里的那份原样保留，那才是历史
        subtasks: t.subtasks.map((s) => ({ ...s, done: false, doneAt: null, due: null, dueTime: null })),
        postponeCount: 0,
      };
      return { ...d, tasks: d.tasks.map((x) => (x.id === id ? advanced : x)).concat(doneCopy) };
    }
    return {
      ...d,
      tasks: d.tasks.map((x) => (x.id === id ? { ...x, done: true, doneAt: nowIso } : x)),
    };
  }, { toast: "已完成，移入「已完成」" });
}

/** 一次完成多件（Ctrl+D 多选 / 右键菜单）。
 *  必须**一次 mutate 完成全部**：一件一次的话撤销栈里会压 N 层，
 *  toast 上那个「撤销」只撤得回最后一件——提示说了能撤，就得真能全撤 */
export function completeTasks(ids: string[]) {
  if (ids.length <= 1) {
    if (ids.length === 1) completeTask(ids[0]);
    return;
  }
  const nowIso = new Date().toISOString();
  const today = todayYMD();
  mutate((d) => {
    let tasks = d.tasks;
    const extras: Task[] = [];
    for (const id of ids) {
      const t = tasks.find((x) => x.id === id);
      if (!t || t.done || t.kind === "habit") continue;
      if (t.repeat && t.due) {
        extras.push({
          ...t, id: newId(), repeat: null, done: true, doneAt: nowIso,
          subtasks: t.subtasks.map((s) => ({ ...s, id: newId() })),
        });
        const anchor = cmpYMD(t.due, today) > 0 ? t.due : today;
        const nd = nextOccurrence(t.repeat, anchor);
        const advanced: Task = {
          ...t, due: nd, reminder: regenReminder(t, nd),
          // 跟 completeTask 单条那处逐字同口径：done/doneAt/日期一起清（两处是双胞胎，改一处必改另一处）
          subtasks: t.subtasks.map((s) => ({ ...s, done: false, doneAt: null, due: null, dueTime: null })),
          postponeCount: 0,
        };
        tasks = tasks.map((x) => (x.id === id ? advanced : x));
      } else {
        tasks = tasks.map((x) => (x.id === id ? { ...x, done: true, doneAt: nowIso } : x));
      }
    }
    if (tasks === d.tasks && extras.length === 0) return d;
    return { ...d, tasks: [...tasks, ...extras] };
  }, { toast: `已完成 ${ids.length} 件，移入「已完成」` });
  clearSelection();
}

export function uncompleteTask(id: string) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => (t.id === id ? { ...t, done: false, doneAt: null } : t)),
  }));
}

export function deleteTasks(ids: string[]) {
  const nowIso = new Date().toISOString();
  mutate(
    (d) => ({
      ...d,
      tasks: d.tasks.map((t) => (ids.includes(t.id) ? { ...t, deletedAt: nowIso } : t)),
    }),
    { toast: ids.length > 1 ? `已删除 ${ids.length} 项` : "已删除" },
  );
  clearSelection();
}

export function restoreTask(id: string) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => (t.id === id ? { ...t, deletedAt: null } : t)),
  }));
}

export function purgeTrash() {
  const at = new Date().toISOString();
  mutate(
    (d) => ({
      ...d,
      tasks: d.tasks.filter((t) => !t.deletedAt),
      graveyard: bury(d.graveyard, d.tasks.filter((t) => t.deletedAt).map((t) => t.id), at),
    }),
    { toast: "回收站已清空" },
  );
}

/** 从回收站里彻底删掉一条（仍进撤销栈，手滑了 Ctrl+Z 还能回来） */
export function purgeTask(id: string) {
  const at = new Date().toISOString();
  mutate(
    (d) => {
      const hit = d.tasks.find((t) => t.id === id && t.deletedAt);
      if (!hit) return d;
      return {
        ...d,
        tasks: d.tasks.filter((t) => t.id !== id),
        graveyard: bury(d.graveyard, [id], at),
      };
    },
    { toast: "已彻底删除" },
  );
}

/** 回收站里这条还剩几天被自动清掉（0 = 今天就到期） */
export function trashDaysLeft(deletedAt: string, now = Date.now()): number {
  const gone = new Date(deletedAt).getTime() + 30 * 86400000;
  return Math.max(0, Math.ceil((gone - now) / 86400000));
}

/** 按行顺延：母任务行推母任务，子任务行只推这一条子任务（日期继承母任务的会就地落成自己的）。
 *  逾期区「全部推到明天」与子任务行右键都走这里 */
export function postponeRows(rows: DateRow[], days = 1) {
  const today = todayYMD();
  const taskIds = rows.filter((r) => !r.sub).map((r) => r.task.id);
  const subs = rows.filter((r) => r.sub != null);
  mutate(
    (d) => ({
      ...d,
      tasks: d.tasks.map((t) => {
        const subHits = subs.filter((r) => r.task.id === t.id);
        let next = t;
        if (taskIds.includes(t.id)) {
          const base = t.due && cmpYMD(t.due, today) > 0 ? t.due : today;
          const nd = addDays(base, days);
          next = { ...next, due: nd, postponeCount: t.postponeCount + 1, reminder: regenReminder(t, nd) };
        }
        if (subHits.length) {
          next = {
            ...next,
            subtasks: next.subtasks.map((s) => {
              const hit = subHits.find((r) => r.sub!.id === s.id);
              if (!hit) return s;
              // 继承母任务日期的子任务也推得动：把继承来的日期先落成自己的，再往后挪，
              // 这样只有被推的那条子任务滑走，同一件事的其他子任务原地不动
              const own = s.due != null;
              const from = own ? s.due! : t.due;
              const base = from && cmpYMD(from, today) > 0 ? from : today;
              return {
                ...s,
                due: addDays(base, days),
                dueTime: own ? s.dueTime ?? null : s.dueTime ?? t.dueTime,
              };
            }),
          };
        }
        return next;
      }),
    }),
    { toast: rows.length > 1 ? `已顺延 ${rows.length} 项` : "推到明天" },
  );
  clearSelection();
}

/** 推到明天（逾期任务推到今天之后的明天） */
export function postponeTasks(ids: string[], days = 1) {
  const today = todayYMD();
  mutate(
    (d) => ({
      ...d,
      tasks: d.tasks.map((t) => {
        if (!ids.includes(t.id)) return t;
        const base = t.due && cmpYMD(t.due, today) > 0 ? t.due : today;
        const nd = addDays(base, days);
        return {
          ...t,
          due: nd,
          postponeCount: t.postponeCount + 1,
          reminder: regenReminder(t, nd),
        };
      }),
    }),
    { toast: ids.length > 1 ? `已顺延 ${ids.length} 项` : "推到明天" },
  );
  clearSelection();
}

/** 整组换需求方（右键批量改用这个：给几个人就是几个人，原来的清掉） */
export function setTasksWho(ids: string[], who: string[]) {
  const next = normalizeWho(who);
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => (ids.includes(t.id) ? { ...t, who: next } : t)),
  }));
  clearSelection();
}

/** 追加一个需求方（拖到侧栏某人名下用这个：是「也归 TA」，不是「只归 TA」） */
export function addTasksWho(ids: string[], name: string) {
  const who = name.trim();
  if (!who) return;
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) =>
      ids.includes(t.id) && !t.who.includes(who) ? { ...t, who: [...t.who, who] } : t,
    ),
  }));
  clearSelection();
}

/** 从一件事上摘掉某个需求方 */
export function removeTaskWho(id: string, name: string) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => (t.id === id ? { ...t, who: t.who.filter((w) => w !== name) } : t)),
  }));
}

export function setTasksList(ids: string[], listId: string | null) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => (ids.includes(t.id) ? { ...t, listId } : t)),
  }));
  clearSelection();
}

export function setTasksDue(ids: string[], due: string | null) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => {
      if (!ids.includes(t.id)) return t;
      const postpone = t.due && due && cmpYMD(due, t.due) > 0 ? 1 : 0;
      return {
        ...t, due,
        // 清日期必须连带清时间：残留的 dueTime 会在下次排期时把提醒从隐形状态复活
        dueTime: due ? t.dueTime : null,
        postponeCount: t.postponeCount + postpone,
        reminder: due ? regenReminder(t, due) : null,
      };
    }),
  }));
  clearSelection();
}

// ---------- 习惯 ----------

export interface AddHabitInput {
  title: string;
  repeat?: RepeatRule | null;
  notes?: string;
  priority?: Priority;
  listId?: string | null;
  tags?: string[];
}

/** 新建一个习惯。不给周期就是「每天」——绝大多数习惯都是每天 */
export function addHabit(input: AddHabitInput): string {
  const h = newTask({
    ...input,
    kind: "habit",
    repeat: input.repeat ?? DEFAULT_HABIT_REPEAT,
    // 习惯不排期、不逾期：due 一直是 null，「今天该不该做」由 repeat 现算
    due: null,
    dueTime: null,
    reminder: null,
    listId: input.listId ?? null,
    tags: input.tags ?? [],
    priority: input.priority ?? 0,
    order: Date.now(),
  });
  mutate((d) => ({ ...d, tasks: [...d.tasks, h] }));
  return h.id;
}

/** 打卡 / 撤销打卡。同一天再点一次就是撤销（点错了不用找地方改） */
export function toggleHabitCheck(id: string, ymd = todayYMD()) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) =>
      t.id === id && t.kind === "habit" ? { ...t, checkIns: toggleCheck(t.checkIns, ymd) } : t,
    ),
  }));
}

/** 改习惯的周期。习惯必须有周期，传 null 会退回「每天」 */
export function setHabitRepeat(id: string, rule: RepeatRule | null) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) =>
      t.id === id && t.kind === "habit" ? { ...t, repeat: rule ?? DEFAULT_HABIT_REPEAT } : t,
    ),
  }));
}

/** 普通事 ⇄ 习惯互转。转成习惯时清掉排期（习惯不逾期），转回来时清掉打卡记录 */
export function setTaskKind(id: string, kind: TaskKind) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => {
      if (t.id !== id || t.kind === kind) return t;
      if (kind === "habit") {
        return {
          ...t,
          kind,
          repeat: t.repeat ?? DEFAULT_HABIT_REPEAT,
          due: null,
          dueTime: null,
          reminder: null,
          done: false,
          doneAt: null,
        };
      }
      return { ...t, kind, checkIns: [] };
    }),
  }));
}

// ---------- 子任务 ----------

/** 加一条子任务。extra 用来一次性带上它自己的日期/时间/重要性
 *  （子任务输入框认「明天 15点 !高」这类写法，解析结果就从这里进来）。
 *  不给 = null = 继承母任务 */
export function addSubtask(
  taskId: string,
  title: string,
  extra?: { due?: string | null; dueTime?: string | null; priority?: Priority | null },
) {
  const sub: Subtask = {
    id: newId(),
    title,
    done: false,
    due: extra?.due ?? null,
    dueTime: extra?.dueTime ?? null,
    priority: extra?.priority ?? null,
    // 子任务的默认值一共两处（另一处是 model.migrate 里那个字面量），加字段要一起改
    doneAt: null,
  };
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => (t.id === taskId ? { ...t, subtasks: [...t.subtasks, sub] } : t)),
  }));
}

/** 给子任务打补丁：动到 done 就顺手把完成时刻盖上（勾）或清掉（取消）。
 *  这件事必须落在这一层，不能交给调用点：勾一条子任务有三条独立的路——任务卡走 toggleSubtask，
 *  列表行（TaskRow）和右键菜单都是直调 updateSubtask({done})。在三个调用点各写一遍迟早漏一处，
 *  漏了就出「在卡上勾有完成日、在行上勾没有」的分裂数据。
 *  显式带了 doneAt 的（导入回填之类）以调用方给的为准。 */
export function applySubPatch(s: Subtask, patch: Partial<Subtask>): Subtask {
  const next = { ...s, ...patch };
  if (patch.done !== undefined && patch.doneAt === undefined) {
    next.doneAt = patch.done ? new Date().toISOString() : null;
  }
  return next;
}

export function toggleSubtask(taskId: string, subId: string) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) =>
      t.id === taskId
        ? { ...t, subtasks: t.subtasks.map((s) => (s.id === subId ? applySubPatch(s, { done: !s.done }) : s)) }
        : t,
    ),
  }));
}

/** 子任务字段更新（自己的日期/优先级/标题；带 done 时连完成时刻一起管，见 applySubPatch） */
export function updateSubtask(taskId: string, subId: string, patch: Partial<Subtask>) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) =>
      t.id === taskId
        ? { ...t, subtasks: t.subtasks.map((s) => (s.id === subId ? applySubPatch(s, patch) : s)) }
        : t,
    ),
  }));
}

export function removeSubtask(taskId: string, subId: string) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) =>
      t.id === taskId ? { ...t, subtasks: t.subtasks.filter((s) => s.id !== subId) } : t,
    ),
  }));
}

// ---------- 清单 ----------

export function addList(name: string, color: string): string {
  const id = newId();
  mutate((d) => ({
    ...d,
    lists: [...d.lists, { id, name, color, order: d.lists.length, updatedAt: new Date().toISOString() }],
  }));
  return id;
}

export function renameList(id: string, name: string) {
  mutate((d) => ({ ...d, lists: d.lists.map((l) => (l.id === id ? { ...l, name } : l)) }));
}

/** 一串东西里，把 dragId 挪到 overId **前面**。
 *  必须「先抽出再定位」：先算好目标下标再抽，往下拖时下标会因为抽走而错一格，
 *  结果就落到目标后面去了——跟界面上画在目标上边的那条落点线对不上 */
function moveBefore(order: string[], dragId: string, overId: string): string[] | null {
  const next = [...order];
  const from = next.indexOf(dragId);
  if (from < 0 || !next.includes(overId)) return null;
  next.splice(from, 1);
  const to = next.indexOf(overId);
  next.splice(to, 0, dragId);
  return next;
}

/** 侧栏里把某张清单拖到另一张上面。整组重新编号，order 只是「第几个」不带别的含义。
 *  清单的顺序跟着数据走（会同步到别的设备）——它是一条真记录，不是本机偏好。
 *  **进撤销栈**：拖错了 Ctrl+Z 撤的就该是这一下，不能让它去撤上一件不相干的事 */
export function moveList(dragId: string, overId: string) {
  if (dragId === overId) return;
  mutate((d) => {
    const sorted = [...d.lists].sort((a, b) => a.order - b.order).map((l) => l.id);
    const next = moveBefore(sorted, dragId, overId);
    if (!next) return d;
    const rank = new Map(next.map((id, i) => [id, i]));
    return { ...d, lists: d.lists.map((l) => (l.order === rank.get(l.id) ? l : { ...l, order: rank.get(l.id)! })) };
  }, { toast: "清单顺序已调整" });
}

/** 侧栏里把某个需求方拖到另一个上面。存进设置 = 每台设备各排各的（见 Settings.whoOrder）。
 *  设置不进撤销栈也不同步，所以这一下 Ctrl+Z 撤不回来——再拖回去就是了 */
export function moveWho(dragName: string, overName: string) {
  if (dragName === overName) return;
  const names = allWho(appStore.getState().data).map((w) => w.who);
  const next = moveBefore(names, dragName, overName);
  if (next) updateSettings({ whoOrder: next });
}

export function setListColor(id: string, color: string) {
  mutate((d) => ({ ...d, lists: d.lists.map((l) => (l.id === id ? { ...l, color } : l)) }));
}

/** 删除清单：其下任务回随手记；正看着这张清单时把视图也带走，防止悬空 */
export function deleteList(id: string) {
  const at = new Date().toISOString();
  mutate(
    (d) => ({
      ...d,
      lists: d.lists.filter((l) => l.id !== id),
      tasks: d.tasks.map((t) => (t.listId === id ? { ...t, listId: null } : t)),
      graveyard: bury(d.graveyard, [id], at),
    }),
    { toast: "清单已删除，任务已移回随手记" },
  );
  const ui = appStore.getState().ui;
  if (ui.view === "list" && ui.listId === id) navigate("inbox");
}

// ---------- 专注 ----------

export function logFocus(taskId: string | null, minutes: number) {
  if (minutes <= 0) return;
  const date = todayYMD();
  mutate(
    (d) => ({
      ...d,
      sessions: [...d.sessions, { taskId, date, minutes, startedAt: new Date().toISOString() }],
      tasks: taskId
        ? d.tasks.map((t) => (t.id === taskId ? { ...t, focusMinutes: t.focusMinutes + minutes } : t))
        : d.tasks,
    }),
    { skipUndo: true },
  );
}

// ---------- 设置 ----------

export function updateSettings(patch: Partial<Settings>) {
  mutate((d) => ({ ...d, settings: { ...d.settings, ...patch } }), { skipUndo: true });
}

// ---------- UI 动作 ----------

export function navigate(view: ViewId, extra?: { listId?: string | null; who?: string | null; tag?: string | null }) {
  const ui = appStore.getState().ui;
  appStore.setState({
    ui: {
      ...ui, view,
      listId: extra?.listId ?? null,
      who: extra?.who ?? null,
      tag: extra?.tag ?? null,
      expandedId: null, selectedIds: [],
    },
  });
}

/** 这件事的子任务链现在是收起的吗 */
export function isChainFolded(ui: UIState, taskId: string): boolean {
  return ui.foldExcept.includes(taskId) ? !ui.foldAll : ui.foldAll;
}

/** 总开关：全部收起 / 全部摊开。切换时把单条的例外清掉，否则用户点完发现还有几条没听话 */
export function setFoldAll(v: boolean) {
  const ui = appStore.getState().ui;
  saveFold(v, []);
  appStore.setState({ ui: { ...ui, foldAll: v, foldExcept: [] } });
}

/** 单条的小三角：跟总开关反着来 */
export function toggleChain(taskId: string) {
  const ui = appStore.getState().ui;
  const next = ui.foldExcept.includes(taskId)
    ? ui.foldExcept.filter((x) => x !== taskId)
    : [...ui.foldExcept, taskId];
  saveFold(ui.foldAll, next);
  appStore.setState({ ui: { ...ui, foldExcept: next } });
}

export function expandTask(id: string | null) {
  const ui = appStore.getState().ui;
  appStore.setState({ ui: { ...ui, expandedId: id } });
}

export function setSelection(ids: string[]) {
  const ui = appStore.getState().ui;
  appStore.setState({ ui: { ...ui, selectedIds: ids } });
}

export function clearSelection() {
  const ui = appStore.getState().ui;
  if (ui.selectedIds.length) appStore.setState({ ui: { ...ui, selectedIds: [] } });
}

export function setSearchOpen(open: boolean) {
  const ui = appStore.getState().ui;
  appStore.setState({ ui: { ...ui, searchOpen: open, paletteOpen: false } });
}

export function setPaletteOpen(open: boolean) {
  const ui = appStore.getState().ui;
  appStore.setState({ ui: { ...ui, paletteOpen: open, searchOpen: false } });
}

export function setFocusState(patch: Partial<FocusState>) {
  appStore.setState({ focus: { ...appStore.getState().focus, ...patch } });
}

export function openCtxMenu(x: number, y: number, ids: string[], sub?: { taskId: string; subId: string } | null) {
  const ui = appStore.getState().ui;
  appStore.setState({ ui: { ...ui, ctxMenu: { x, y, ids, sub: sub ?? null } } });
}

export function closeCtxMenu() {
  const ui = appStore.getState().ui;
  if (ui.ctxMenu) appStore.setState({ ui: { ...ui, ctxMenu: null } });
}

// ---------- 派生查询（UI 共用；返回未删除任务） ----------

/** 没删的**普通事**。习惯是另一个分类，不该混进今天/计划/全部/日历/四象限——
 *  它不会逾期、也没有「做完就没了」，混进去只会把这些视图搅乱。想要习惯用 aliveHabits */
export function aliveTasks(d: AppData): Task[] {
  return d.tasks.filter((t) => !t.deletedAt && t.kind !== "habit");
}

/** 没删的习惯 */
export function aliveHabits(d: AppData): Task[] {
  return d.tasks.filter((t) => !t.deletedAt && t.kind === "habit");
}

/** 普通事 + 习惯。搜索这类「找东西」的场景用它——按名字找当然要能找到习惯 */
export function aliveAll(d: AppData): Task[] {
  return d.tasks.filter((t) => !t.deletedAt);
}

/** 今天要打的卡（按未打卡在前排好）。今天不用做的习惯也在里面，由界面自己分区 */
export function habitsForToday(d: AppData, today = todayYMD()): Task[] {
  return sortHabitsForDay(aliveHabits(d), today);
}

/** 今天还欠着几个卡——侧栏「习惯」后面那个数字 */
export function habitsOpenToday(d: AppData, today = todayYMD()): number {
  return aliveHabits(d).filter((h) => isDueOn(h, today) && !doneOn(h, today)).length;
}

/** 日期视图的统一行：母任务本身，或它的某个未完成子任务（sub 非 null 时） */
export interface DateRow {
  task: Task;
  sub: Subtask | null;
}

/** 行的有效日期。子任务没填日期 = 继承母任务的（用户口径：默认等于母任务截止日期） */
export function rowDue(r: DateRow): string | null {
  return r.sub ? r.sub.due ?? r.task.due : r.task.due;
}

/** 行的有效时间。子任务自己排了别的日子就不再继承母任务的钟点——那个钟点是给母任务那天的 */
export function rowTime(r: DateRow): string | null {
  if (!r.sub) return r.task.dueTime;
  if (r.sub.due) return r.sub.dueTime ?? null;
  return r.sub.dueTime ?? r.task.dueTime;
}

/** 行的有效重要性。子任务没填 = 继承母任务 */
export function rowPriority(r: DateRow): Priority {
  return r.sub ? r.sub.priority ?? r.task.priority : r.task.priority;
}

/** 已完成子任务攒到这个数，任务卡里那堆默认收起。
 *  沿用侧栏 PEEK=3 的口径：1-2 条直接摊开，收起反而多让人点一次 */
export const SUB_DONE_PEEK = 3;

/** 任务卡里把子任务分成「还欠着的」和「做完的」两堆。
 *  filter 保留原数组顺序，所以两堆接起来跟原先「做完的沉到最下面」的稳定排序逐条等价，
 *  改成折叠之后视觉上不会有「东西自己动了」。只管显示，存的那份数组一个字节都不动 */
export function splitSubtasks(subs: Subtask[]): { open: Subtask[]; done: Subtask[] } {
  return { open: subs.filter((s) => !s.done), done: subs.filter((s) => s.done) };
}

/** 已完成那堆默不默认收起。
 *  「还有没做完的」是必要前提：一件事整个做完之后（「已完成」视图里点开的卡片就是这样），
 *  再折叠的话卡片里一条子任务都看不见，只剩一行「显示已完成 N」 */
export function foldDoneSubs(subs: Subtask[]): boolean {
  const { open, done } = splitSubtasks(subs);
  return done.length >= SUB_DONE_PEEK && open.length > 0;
}

/** 未完成的事在日期/总览视图里怎么占行。
 *  用户口径：「有子任务的把重要级和截止日期挪到子任务，默认等于母任务，总任务排序时分开排」——
 *  所以有未完成子任务的任务**分拆**成一行一个子任务（母任务行收起，子任务行自带「母 › 子」前缀），
 *  子任务各自按继承或自填的日期/重要性独立参与排序；子任务全做完后母任务行才回来收尾。 */
export function openRows(d: AppData): DateRow[] {
  const rows: DateRow[] = [];
  for (const t of aliveTasks(d)) {
    if (t.done) continue;
    const openSubs = t.subtasks.filter((s) => !s.done);
    if (openSubs.length === 0) {
      rows.push({ task: t, sub: null });
      continue;
    }
    for (const s of openSubs) rows.push({ task: t, sub: s });
  }
  return rows;
}

/** 做完的事怎么占行——openRows 的对偶。
 *  已完成的子任务各出一行（显示成「母 › 子」），母任务 done=true 时**也**出一行，
 *  代表「这件事本身收尾了」。所以一件有子任务的事做完之后，
 *  在「已完成」里既看得到每一步是哪天做的，也看得到收尾那一下。
 *  母任务没做完但子任务勾了几条（很常见）同样在这里现身，不用等整件事做完。 */
export function doneRows(d: AppData): DateRow[] {
  const rows: DateRow[] = [];
  for (const t of aliveTasks(d)) {
    for (const s of t.subtasks) if (s.done) rows.push({ task: t, sub: s });
    if (t.done) rows.push({ task: t, sub: null });
  }
  return rows;
}

/** 这一行是哪一刻做完的（ISO）。子任务优先用自己的完成时刻；
 *  加 doneAt 之前就已经勾掉的老子任务没有这个戳，回落到母任务的 doneAt，
 *  再没有就拿创建时刻顶——**这一档纯粹是为了排序有个位置**，不是真的完成时刻，
 *  用之前先问 rowDoneGuessed：凡是猜出来的日子都不许当成完成记录展示。
 *  **不为这批老数据单开「不知道哪天」分组**：那一组只会越攒越大，还谁也修不了它。 */
export function rowDoneAt(r: DateRow): string {
  return r.sub ? r.sub.doneAt ?? r.task.doneAt ?? r.task.createdAt : r.task.doneAt ?? r.task.createdAt;
}

/** 这一行的完成时刻是「猜的」还是真有。子任务自己没戳、母任务也没戳，
 *  rowDoneAt 只能拿母任务的创建时刻顶——那天用户其实什么都没做完。
 *  这类行的去处：日历一条都不落格（否则凭空多出完成记录，绿点数字也跟着虚高）；
 *  「已完成」视图照旧显示（不显示用户会以为东西不见了），但排在最后一组的尾部，
 *  且不写「完成 X月X日」——宁可不说，也不编一个日期。 */
export function rowDoneGuessed(r: DateRow): boolean {
  return !!r.sub && !r.sub.doneAt && !r.task.doneAt;
}

/** 这一行归到哪一天（本地 'YYYY-MM-DD'）。doneAt 存的是 UTC ISO，必须转回本地再归日，
 *  否则本地 0-8 点做完的会归到昨天。「已完成」视图和日历的已完成桶共用这一个函数，
 *  不许各写一遍——两处口径一旦分家，同一件事在两个页面会落在不同的日子 */
export function rowDoneDay(r: DateRow): string {
  return toYMD(new Date(rowDoneAt(r)));
}

/** 一批行里涉及的任务 id，按出现顺序去重。分拆后一件事会占好几行，
 *  但「选中 / 键盘上下 / 计数到底有几件事」都必须按件算，不能按行算 */
export function rowTaskIds(rows: DateRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (seen.has(r.task.id)) continue;
    seen.add(r.task.id);
    out.push(r.task.id);
  }
  return out;
}

/** 排序：time = 时间优先（同时间按重要性）；priority = 重要性优先（同级按时间）。无日期的都排最后 */
export function sortRows(rows: DateRow[], mode: "time" | "priority"): DateRow[] {
  const key = (r: DateRow) => `${rowDue(r) ?? "9999-99-99"}T${rowTime(r) ?? "99:99"}`;
  // 同一件事的几个子任务行挤在一起时，按它们在任务里的先后排，不然顺序看运气
  const subIdx = (r: DateRow) => (r.sub ? r.task.subtasks.findIndex((s) => s.id === r.sub!.id) : -1);
  return [...rows].sort((a, b) => {
    if (mode === "priority") {
      if (rowPriority(a) !== rowPriority(b)) return rowPriority(b) - rowPriority(a);
      const ka = key(a), kb = key(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
    } else {
      const ka = key(a), kb = key(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      if (rowPriority(a) !== rowPriority(b)) return rowPriority(b) - rowPriority(a);
    }
    if (a.task.order !== b.task.order) return a.task.order - b.task.order;
    return subIdx(a) - subIdx(b);
  });
}

export function tasksForToday(d: AppData, today = todayYMD()): { overdue: DateRow[]; todays: DateRow[]; doneToday: Task[] } {
  const mode = d.settings.sortMode;
  const rows = openRows(d);
  const overdue = sortRows(rows.filter((r) => { const due = rowDue(r); return due && cmpYMD(due, today) < 0; }), mode);
  const todays = sortRows(rows.filter((r) => rowDue(r) === today), mode);
  const doneToday = aliveTasks(d)
    // doneAt 是 UTC ISO，必须转回本地日期再归日，否则本地 0-8 点完成的会归到昨天
    .filter((t) => t.done && t.doneAt && toYMD(new Date(t.doneAt)) === today)
    .sort((a, b) => (a.doneAt! < b.doneAt! ? 1 : -1));
  return { overdue, todays, doneToday };
}

/** 旧比较器：仍被四象限等纯任务列表使用 */
export function byPriorityThenOrder(a: Task, b: Task): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const at = a.dueTime ?? "99:99";
  const bt = b.dueTime ?? "99:99";
  if (at !== bt) return at < bt ? -1 : 1;
  return a.order - b.order;
}

/** 任务列表按设置排序（不含子任务行的场景用） */
export function sortTasks(tasks: Task[], mode: "time" | "priority"): Task[] {
  return sortRows(tasks.map((t) => ({ task: t, sub: null })), mode).map((r) => r.task);
}

/** 需求方列表。一件事挂了几个人，就在这几个人名下各算一次。
 *  排过序（侧栏拖过）就照手排的来，没排过的接在后面按未完成数降序——
 *  否则手排完一加新任务，顺序又自己跳回去了 */
export function allWho(d: AppData): { who: string; open: number }[] {
  const map = new Map<string, number>();
  for (const t of aliveTasks(d)) {
    for (const w of t.who) map.set(w, (map.get(w) ?? 0) + (t.done ? 0 : 1));
  }
  const all = [...map.entries()]
    .map(([who, open]) => ({ who, open }))
    .sort((a, b) => b.open - a.open || (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));
  const order = d.settings.whoOrder ?? [];
  if (order.length === 0) return all;
  const rank = new Map(order.map((w, i) => [w, i]));
  const ranked = all.filter((x) => rank.has(x.who)).sort((a, b) => rank.get(a.who)! - rank.get(b.who)!);
  return [...ranked, ...all.filter((x) => !rank.has(x.who))];
}

export function allTags(d: AppData): { tag: string; open: number }[] {
  const map = new Map<string, number>();
  for (const t of aliveTasks(d)) {
    if (t.done) continue;
    for (const tag of t.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
  }
  return [...map.entries()].map(([tag, open]) => ({ tag, open })).sort((a, b) => b.open - a.open);
}
