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
// 原来独立的 upcoming（按天排的计划）撤掉，四象限并进 plan 成了它的一个视图切换。
// 2026-09-03：手机上四象限重新独立成一页（"quadrant"）——手机屏上「列表 / 四象限」
// 两个 tab 挤在顶栏里既难点又看不出是两种东西。桌面不变：那儿 "quadrant" 就等于 "plan"，
// 四象限仍是计划里的一个 tab
export type ViewId =
  | "inbox" | "today" | "plan" | "quadrant" | "done" | "habits"
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
  /** 侧栏版本号点开的那份更新日志 */
  changelogOpen: boolean;
  /** 居中的「记一条」弹窗（v1.11.2 起替掉了侧栏那个「随手记」视图）。
   *  侧栏那颗「＋ 记一条」、Ctrl+1、命令面板都开的是它 */
  quickAddOpen: boolean;
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
  /** 这份数据是更新版本的橡果写的（null = 没这回事）。
   *
   *  **它只是一条提示条的开关，不是任何闸门**——名字从 `dataTooNew` 改成 `dataFromNewer`
   *  就是为了这个：旧名字读着像「太新了，不能用」，谁看见都想拿它当拦路条件。
   *  数据照常读进来、照常改、照常存回去、照常同步；本机不认识的字段一个不丢（见 model.migrate）。
   *  **绝不许拿它拒绝加载用户的日志**（2026-09-01 用户定的产品原则）。 */
  dataFromNewer: { schema: number } | null;
  /** 当前数据是空的，但别处找到了有内容的数据文件夹——由用户拍板要不要用（null = 没这回事） */
  rescue: persist.DataCandidate[] | null;
  /** 本机数据已经被清空（登出时的隐私路径）。置上之后一律不再落盘——
   *  防抖写入、提醒消费的 requestSave、快速添加窗任何一条都能在删完之后再写一份回来 */
  wiped: boolean;
  ui: UIState;
  focus: FocusState;
  undoDepth: number;
}

/** 撤销栈上限（v1.9.0 从 50 降到 10）。降得动是因为下面那条合并规则：
 *  连着打字不再一个字一张快照，10 张能撤回去的事反而比原来 50 张多 */
const UNDO_CAP = 10;
/** 连续输入的合并窗口：**停手** 800 毫秒才落一张新快照，每敲一个字重新计时。
 *  不是「从第一个字算起的固定 800ms」——那样打得慢的人照样一句话攒出十几张。
 *  注意：这只动撤销栈。**逐键落库一个字都没少**，见 mutate 末尾照旧调 scheduleSave */
const COALESCE_MS = 800;
let undoStack: AppData[] = [];
/** 上一次带合并键的写入：键 + 时刻。键带任务 id 与字段名，
 *  所以「改 A 的标题」和「改 B 的标题」永远并不到一张快照里去 */
let coalesce: { key: string; at: number } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let toastKey = 0;

export const appStore = createStore<AppState>(() => ({
  data: defaultData(),
  loaded: false,
  loadError: null,
  dataFromNewer: null,
  rescue: null,
  wiped: false,
  ui: {
    view: "today", listId: null, who: null, tag: null, ...loadFold(),
    expandedId: null, selectedIds: [], searchOpen: false, paletteOpen: false, changelogOpen: false,
    quickAddOpen: false, toast: null,
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
  // wiped：用户刚把本机这份清掉了，任何一次回写都等于白清。
  // **这里没有 dataFromNewer**（v1.9.1 拆掉）：更新版本写的数据照样存得回去，
  // 未知字段一个不丢。这三条防的是别的事（空库覆盖、目录不可用、清空后回写），别混为一谈
  if (s.wiped || !s.loaded || s.loadError) return Promise.resolve();
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
  coalesce = null;
  appStore.setState({ undoDepth: 0 });
}

/** 删本机数据之前的内存侧收尾。顺序本身就是正确性，别调换：
 *  ① flushSave 把攒着的写完（此刻本地与云端刚比对过，写完才是「已全在云端」的那一份）
 *  ② 冲的过程里可能又排上一次防抖，再清一遍定时器
 *  ③ 置 wiped 闸门，从这一刻起 doSave 一律拒绝
 *  ④ 清撤销栈：栈里躺着十来份完整数据，撤一下就整份写回盘 */
export async function haltPersistence(): Promise<void> {
  await flushSave();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  appStore.setState({ wiped: true, undoDepth: 0 });
  undoStack = [];
  coalesce = null;
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

/** 所有写操作的唯一入口：应用变更 → 盖改动时刻 → 快照进撤销栈 → 计划落盘。无实际变更时什么都不做。
 *  coalesceKey：同一个框里连着打字（同 id 同字段），停手不到 COALESCE_MS 就并进上一张快照，
 *  不再压新的。Ctrl+Z 撤的是「刚才那件事」，不是「刚才那个字」 */
function mutate(
  fn: (d: AppData) => AppData,
  opts?: { toast?: string; skipUndo?: boolean; coalesceKey?: string },
) {
  const cur = appStore.getState().data;
  const next = stamp(cur, fn(cur));
  if (next === cur) return; // 无操作（如对已完成任务再次 complete）不压栈不落盘、也不打断合并
  if (!opts?.skipUndo) {
    const key = opts?.coalesceKey;
    const at = Date.now();
    // 只有「接着上一次同键写入、且还没停手够久」才并。栈空时不能并（没有可并的快照）
    const merge =
      key !== undefined && coalesce !== null && coalesce.key === key
      && at - coalesce.at < COALESCE_MS && undoStack.length > 0;
    if (!merge) {
      undoStack.push(cur);
      if (undoStack.length > UNDO_CAP) undoStack.shift();
    }
    // 中间夹一次别的操作（完成/删除/改日期…）就断链：回头再打字必须另起一张快照
    coalesce = key === undefined ? null : { key, at };
  }
  appStore.setState({ data: next, undoDepth: undoStack.length });
  if (opts?.toast) showToast(opts.toast, !opts?.skipUndo);
  scheduleSave();
}

export function undo() {
  const prev = undoStack.pop();
  // 撤过之后接着打字必须另起一张快照：栈顶已经不是刚才合并的那张了
  coalesce = null;
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
  coalesce = null;
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
    // 磁盘上那份比本机新：**照常读进来**（v1.9.1 拆墙）。本机不认识的字段原样留着，
    // 界面弹一次「已有更新版橡果」的框（App.tsx 的 NewerDataDialog），取消了照常用，仅此而已。
    // 以前这里换空账本 + return，用户打开橡果看见的是一屏「版本过旧」，自己的日志一条也进不来
    const loadedData = res.data;
    // 刚清空过（freshStart）就用真正的空账本
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
    coalesce = null;
    appStore.setState({
      data,
      loaded: true,
      loadError: null,
      // 栈清了计数也必须跟着清。**两者一旦对不上，undo() 就是个空转的死循环**：
      // 它拿不到栈顶就直接 return，一个字都不动，undoDepth 却永远大于 0
      undoDepth: 0,
      // 只点亮提示条，不拦任何东西
      dataFromNewer: res.tooNew ? { schema: res.schema } : null,
    });

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

/** 逐键落库那几个纯文本字段的合并键（A5）。**在这儿现推、不靠调用方传**：
 *  能打字的地方有十来处，靠一处处记得传参迟早漏一个。
 *  只认「一次只改一个字段、而且是 title/notes」——那就是有人正在框里打字；
 *  一次改好几个字段的（整句改、点日期）本来就是一下一张快照，不该并 */
function typingKey(scope: string, patch: object): string | undefined {
  const keys = Object.keys(patch);
  // 日期弹层是「连写」的另一种：那儿 due 和 dueTime 永远一起写（commitDraft 那一个出口），
  // 而原生日期控件改一段就发一次 change——不给它一个合并键，改个日期就吃掉两三格撤销栈，
  // 真正想撤的那件事被挤出去（栈只有 10 格）。单独写 due 的（点预设、清日期）照旧一次一张
  if (keys.length === 2 && keys.includes("due") && keys.includes("dueTime")) return `${scope}:due`;
  if (keys.length !== 1) return undefined;
  const k = keys[0];
  if (k !== "title" && k !== "notes") return undefined;
  return `${scope}:${k}`;
}

export interface UpdateTaskOpts {
  /** 这次写入**不许自动数顺延**：顺延次数由调用方自己按「用户做了一次什么」来算。
   *  日期弹层就是这么用的——弹层期间可以落好几次库（点日历格立刻生效、去抖落一次都算），
   *  但「这件事被往后推了几次」只该按**弹层开 → 弹层关**整段算一次，
   *  跟中途落了几次库、用户在两段之间停手多久全无关系。原委见 core/dateinput.ts */
  noPostponeCount?: boolean;
  /** 撤销栈的合并键。不给就按 patch 的形状自己推（typingKey）。
   *  给的场合只有一处：弹层关掉时补那一次 postponeCount，要跟刚才那次日期写入并成同一格 */
  coalesceKey?: string;
}

export function updateTask(id: string, patch: Partial<Task>, opts: UpdateTaskOpts = {}) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, ...patch };
      // 顺延计数：把日期改得比原来晚（或从无到有不算）
      if (!opts.noPostponeCount
        && patch.due !== undefined && t.due && patch.due && cmpYMD(patch.due, t.due) > 0) {
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
  }), { coalesceKey: opts.coalesceKey ?? typingKey(`task:${id}`, patch) });
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
        ...t, id: newId(), repeat: null, done: true, doneAt: nowIso, droppedAt: null,
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
        // 子任务的专属日期、完成时刻、放弃时刻都属于上一轮，随循环推进一并清掉（重新继承母任务）。
        // doneAt / droppedAt 跟 done 同口径：新一轮还没做，就不能挂着上一轮的那个时刻。
        // 留在已完成副本（上面那条 doneCopy）里的那份原样保留，那才是历史
        subtasks: t.subtasks.map((s) => ({ ...s, done: false, doneAt: null, droppedAt: null, due: null, dueTime: null })),
        postponeCount: 0,
        droppedAt: null,
      };
      return { ...d, tasks: d.tasks.map((x) => (x.id === id ? advanced : x)).concat(doneCopy) };
    }
    // 互斥：勾完成就不再是「放弃」，那个灰标签当场撤掉
    return {
      ...d,
      tasks: d.tasks.map((x) => (x.id === id ? { ...x, done: true, doneAt: nowIso, droppedAt: null } : x)),
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
          ...t, id: newId(), repeat: null, done: true, doneAt: nowIso, droppedAt: null,
          subtasks: t.subtasks.map((s) => ({ ...s, id: newId() })),
        });
        const anchor = cmpYMD(t.due, today) > 0 ? t.due : today;
        const nd = nextOccurrence(t.repeat, anchor);
        const advanced: Task = {
          ...t, due: nd, reminder: regenReminder(t, nd),
          // 跟 completeTask 单条那处逐字同口径：done/doneAt/droppedAt/日期一起清
          //（两处是双胞胎，改一处必改另一处）
          subtasks: t.subtasks.map((s) => ({ ...s, done: false, doneAt: null, droppedAt: null, due: null, dueTime: null })),
          postponeCount: 0,
          droppedAt: null,
        };
        tasks = tasks.map((x) => (x.id === id ? advanced : x));
      } else {
        tasks = tasks.map((x) => (x.id === id ? { ...x, done: true, doneAt: nowIso, droppedAt: null } : x));
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

// ---------- 放弃 ----------
//
// 「放弃」是完成之外的第二种收场：这件事不做了，但它没做成。
// 圈圈一点都不动（那儿只管完成），放弃是标题旁边那个灰标签。三条底线：
//   · 跟 done/doneAt **互斥**——勾完成清放弃，放弃清完成
//   · 统计里**单独算一档**，绝不并进完成数，否则完成率虚高、那个数字就废了
//   · 循环任务放弃 = 这一轮不做了，**照样推进到下一轮**（跟完成同一套推进逻辑）。
//     要彻底不做就删除，那是另一个键

/** 放弃 / 取消放弃若干件事。
 *  循环任务的推进逻辑跟 completeTasks 是同一套（第三胞胎），改一处必须回头看那两处：
 *  留一条「这一轮放弃了」的副本，本体推到下一个落点，新一轮的 droppedAt 必须是干净的。
 *
 *  **对「已经做完的事」的口径跟那两个双胞胎不同，是有意的**：completeTask/completeTasks
 *  开头 `if (t.done) continue`（做完的再点一次完成没有意义），而放弃这边 done 与 droppedAt
 *  互斥、「做完了又反悔说这件事其实没做成」是真实动作——非循环那条路（下面的 else）本来就
 *  把 done/doneAt 清掉照放不误。所以循环这条路也照办：**新一轮显式写 done: false, doneAt: null**，
 *  绝不能靠 `...t` 把上一轮的完成状态带进新一轮（那会让「放弃」对目标完全失效：
 *  它照旧躺在「已完成」里，却被悄悄改了日期、还多出一条幽灵副本）。 */
export function dropTasks(ids: string[], dropped = true) {
  const nowIso = new Date().toISOString();
  const today = todayYMD();
  mutate((d) => {
    let tasks = d.tasks;
    const extras: Task[] = [];
    for (const id of ids) {
      const t = tasks.find((x) => x.id === id);
      // 习惯没有「放弃」这回事：它不是一件会结束的事，今天不做就是今天没打卡
      if (!t || t.kind === "habit") continue;
      if (!dropped) {
        if (!t.droppedAt) continue;
        tasks = tasks.map((x) => (x.id === id ? { ...x, droppedAt: null } : x));
        continue;
      }
      if (t.droppedAt) continue;
      if (t.repeat && t.due) {
        extras.push({
          ...t, id: newId(), repeat: null, done: false, doneAt: null, droppedAt: nowIso,
          subtasks: t.subtasks.map((s) => ({ ...s, id: newId() })),
        });
        const anchor = cmpYMD(t.due, today) > 0 ? t.due : today;
        const nd = nextOccurrence(t.repeat, anchor);
        const advanced: Task = {
          // done/doneAt 显式清掉：见函数头那段口径说明。靠 `...t` 继承就是把上一轮的
          // 完成状态带进新一轮，那样「放弃一件已完成的循环任务」等于没放弃
          ...t, due: nd, done: false, doneAt: null, reminder: regenReminder(t, nd),
          subtasks: t.subtasks.map((s) => ({ ...s, done: false, doneAt: null, droppedAt: null, due: null, dueTime: null })),
          postponeCount: 0,
          droppedAt: null,
        };
        tasks = tasks.map((x) => (x.id === id ? advanced : x));
      } else {
        // 互斥：放弃就不再是「完成」
        tasks = tasks.map((x) => (x.id === id ? { ...x, droppedAt: nowIso, done: false, doneAt: null } : x));
      }
    }
    if (tasks === d.tasks && extras.length === 0) return d;
    return { ...d, tasks: [...tasks, ...extras] };
  }, {
    toast: dropped
      ? ids.length > 1 ? `已放弃 ${ids.length} 件，收进「已完成」` : "已放弃，收进「已完成」"
      : ids.length > 1 ? `已取消放弃 ${ids.length} 件` : "已取消放弃",
  });
  clearSelection();
}

/** 放弃 / 取消放弃一条子任务。跟母任务一样进撤销栈、一样给可撤销的提示 */
export function dropSubtask(taskId: string, subId: string, dropped = true) {
  const at = dropped ? new Date().toISOString() : null;
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) =>
      t.id === taskId
        ? { ...t, subtasks: t.subtasks.map((s) => (s.id === subId ? applySubPatch(s, { droppedAt: at }) : s)) }
        : t,
    ),
  }), { toast: dropped ? "已放弃这一步" : "已取消放弃" });
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

/** 一组任务改期。`opts.noPostponeCount` 跟 updateTask 那个是同一个口径：
 *  这次写入不许自动数顺延，计数由调用方按「用户做了一次什么」自己算。
 *  侧栏「安排到哪天？」那个弹层就是这么用的——弹层里的日期框可以落好几次库
 *  （去抖落一次、改主意再落一次都算），但「这件事被往后推了几次」只该按
 *  **弹层开 → 弹层关**整段算一次，见 Sidebar.settlePlanPopup */
export function setTasksDue(
  ids: string[],
  due: string | null,
  opts: Pick<UpdateTaskOpts, "noPostponeCount" | "coalesceKey"> = {},
) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) => {
      if (!ids.includes(t.id)) return t;
      const postpone = !opts.noPostponeCount && t.due && due && cmpYMD(due, t.due) > 0 ? 1 : 0;
      return {
        ...t, due,
        // 清日期必须连带清时间：残留的 dueTime 会在下次排期时把提醒从隐形状态复活
        dueTime: due ? t.dueTime : null,
        postponeCount: t.postponeCount + postpone,
        reminder: due ? regenReminder(t, due) : null,
      };
    }),
    // 不给键就是老行为（一次一张快照）。给的场合只有侧栏「安排到哪天？」那条：
    // 那儿一次弹层可能落好几次库，还要在关弹层时补一次 postponeCount，
    // 不并成一格的话「拖 3 件去排期」要按 4 下 Ctrl+Z 日期才回得去，而栈只有 10 格
  }), { coalesceKey: opts.coalesceKey });
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
          // 习惯没有「放弃」这回事，转过去顺手把那个标签摘掉
          droppedAt: null,
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
    droppedAt: null,
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
 *  显式带了 doneAt 的（导入回填之类）以调用方给的为准。
 *  「放弃」跟「完成」的互斥也落在这一层，理由同上——三条路都得守同一条规矩。 */
export function applySubPatch(s: Subtask, patch: Partial<Subtask>): Subtask {
  const next = { ...s, ...patch };
  if (patch.done !== undefined && patch.doneAt === undefined) {
    next.doneAt = patch.done ? new Date().toISOString() : null;
  }
  // 勾完成 → 撤掉「已放弃」；标记放弃 → 撤掉完成。取消放弃（droppedAt 传 null）不动完成状态
  if (patch.done === true && patch.droppedAt === undefined) next.droppedAt = null;
  if (patch.droppedAt != null) {
    next.done = false;
    next.doneAt = null;
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
  }), { coalesceKey: typingKey(`sub:${taskId}:${subId}`, patch) });
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

/** 删除清单：里面的事变成「没有清单」（一件都不删）；正看着这张清单时把视图也带走，防止悬空 */
export function deleteList(id: string) {
  const at = new Date().toISOString();
  // 数一下要交代给用户的那个数——**在改之前数**，改完 listId 就都是 null 了。
  // 回收站里那些不算：用户看不见它们，报进去这个数就对不上了
  const n = appStore.getState().data.tasks.filter((t) => t.listId === id && !t.deletedAt).length;
  mutate(
    (d) => ({
      ...d,
      lists: d.lists.filter((l) => l.id !== id),
      tasks: d.tasks.map((t) => (t.listId === id ? { ...t, listId: null } : t)),
      graveyard: bury(d.graveyard, [id], at),
    }),
    // 说它**真做**的那件事：事一件没删，只是不归这张清单了（跟手机上删清单那张纸同一套说法）
    { toast: n ? `清单已删除，${n} 件事变成没有清单` : "清单已删除" },
  );
  const ui = appStore.getState().ui;
  // 桌面上「随手记」这个视图 v1.11.2 起没了（换成「＋ 记一条」弹窗），删完清单没地方可去，
  // 就送去「计划」——那儿装的是所有没做完的事，刚从清单里放出来的这几件也在里面
  if (ui.view === "list" && ui.listId === id) navigate("plan");
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

/** 这件事有没有「子任务链」可折——未完成且没放弃的子任务两条以上（判据跟 openRows 一致）。
 *  给 App.tsx 的 ←/→ 把关用：那是全局键，选中的多半是普通任务，
 *  不挡的话 foldExcept 会被一堆压根没有子任务的 id 撑大，而那份是要落 localStorage 的。
 *  折叠状态本身仍然按任务记、跟数据无关，所以这个判断只放在**入口**，不放进 setChainFolded */
export function hasChain(taskId: string): boolean {
  const t = appStore.getState().data.tasks.find((x) => x.id === taskId);
  return !!t && t.subtasks.filter((s) => !s.done && !s.droppedAt).length >= 2;
}

/** 把这件事的链**摆到**指定状态（不是 toggle）。键盘 ←/→ 用：
 *  连按 ← 得一直是「收着」，第二下不能又给摊开。已经是那个状态就一个字节都不写 */
export function setChainFolded(taskId: string, folded: boolean) {
  const ui = appStore.getState().ui;
  if (isChainFolded(ui, taskId) === folded) return;
  const next = ui.foldExcept.includes(taskId)
    ? ui.foldExcept.filter((x) => x !== taskId)
    : [...ui.foldExcept, taskId];
  saveFold(ui.foldAll, next);
  appStore.setState({ ui: { ...ui, foldExcept: next } });
}

/** 单条的小三角：跟总开关反着来 */
export function toggleChain(taskId: string) {
  const ui = appStore.getState().ui;
  setChainFolded(taskId, !isChainFolded(ui, taskId));
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

export function setChangelogOpen(open: boolean) {
  const ui = appStore.getState().ui;
  appStore.setState({ ui: { ...ui, changelogOpen: open } });
}

/** 居中的「记一条」弹窗开/关。侧栏那颗按钮、Ctrl+1、命令面板都走这一个口 */
export function setQuickAddOpen(open: boolean) {
  const ui = appStore.getState().ui;
  if (ui.quickAddOpen === open) return;
  appStore.setState({ ui: { ...ui, quickAddOpen: open } });
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
//
// 下面几个只吃 tasks（allWho 还要 settings.whoOrder），参数类型就写成 Pick 而不是整份 AppData：
// 界面那边才能只订阅自己真用到的那两三片，而不是整份数据一变就跟着重算一遍（v1.9.0 · B8）。
// 传整份 AppData 进来照样合法，老调用点一个都不用改。

/** 没删的**普通事**。习惯是另一个分类，不该混进今天/计划/全部/日历/四象限——
 *  它不会逾期、也没有「做完就没了」，混进去只会把这些视图搅乱。想要习惯用 aliveHabits */
export function aliveTasks(d: Pick<AppData, "tasks">): Task[] {
  return d.tasks.filter((t) => !t.deletedAt && t.kind !== "habit");
}

/** 没删的习惯 */
export function aliveHabits(d: Pick<AppData, "tasks">): Task[] {
  return d.tasks.filter((t) => !t.deletedAt && t.kind === "habit");
}

/** 普通事 + 习惯。搜索这类「找东西」的场景用它——按名字找当然要能找到习惯 */
export function aliveAll(d: Pick<AppData, "tasks">): Task[] {
  return d.tasks.filter((t) => !t.deletedAt);
}

/** 今天要打的卡（按未打卡在前排好）。今天不用做的习惯也在里面，由界面自己分区 */
export function habitsForToday(d: AppData, today = todayYMD()): Task[] {
  return sortHabitsForDay(aliveHabits(d), today);
}

/** 今天还欠着几个卡——侧栏「习惯」后面那个数字 */
export function habitsOpenToday(d: Pick<AppData, "tasks">, today = todayYMD()): number {
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
  // 没做完的按日期排（用户 2026-09-03：「子任务按照时间顺序自动排列」）：有日期的早的在前，
  // 没日期的沉到后面、彼此保持原来的先后（没填日期的继承母任务的日期，互相之间本来就分不出先后）。
  // sort 是稳定的，同一天的也保持原序。做完的那堆不动：它们按「做完」的先后堆着更符合直觉
  const open = subs
    .filter((s) => !s.done)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const da = a.s.due ?? "";
      const db = b.s.due ?? "";
      if (da && db && da !== db) return da < db ? -1 : 1;
      if (da && !db) return -1;
      if (!da && db) return 1;
      return a.i - b.i;
    })
    .map((x) => x.s);
  return { open, done: subs.filter((s) => s.done) };
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
 *  子任务各自按继承或自填的日期/重要性独立参与排序；子任务全做完后母任务行才回来收尾。
 *
 *  放弃的一律不出现——不管是整件事放弃了，还是只放弃了其中一步。它们退出今天/计划/四象限/日历，
 *  去「已完成」里那个「放弃的」筛子下面待着。 */
export function openRows(d: Pick<AppData, "tasks">): DateRow[] {
  const rows: DateRow[] = [];
  for (const t of aliveTasks(d)) {
    if (t.done || t.droppedAt) continue;
    const openSubs = t.subtasks.filter((s) => !s.done && !s.droppedAt);
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

/** 放弃的事怎么占行——doneRows 的另一面，规则逐条对应：
 *  放弃掉的子任务各出一行（「母 › 子」），母任务自己被放弃时也出一行。
 *  **单独一个函数、不并进 doneRows**：日历只画做完的，并进去就会在日历上多出放弃的条目 */
export function droppedRows(d: AppData): DateRow[] {
  const rows: DateRow[] = [];
  for (const t of aliveTasks(d)) {
    // `&& !done` 是道防线，不是业务规则：写入口那边两者互斥，但手改过的 JSON、
    // 别处导进来的数据可能两个标记都带着。真撞上就**认完成**——
    // 否则「已完成」切到「全部」时同一行会被画两次，React 的 key 当场撞车
    for (const s of t.subtasks) if (s.droppedAt && !s.done) rows.push({ task: t, sub: s });
    if (t.droppedAt && !t.done) rows.push({ task: t, sub: null });
  }
  return rows;
}

/** 这一行是「放弃」的吗。行的口径：子任务行看子任务自己，母任务行看母任务 */
export function rowDropped(r: DateRow): boolean {
  return r.sub ? !!r.sub.droppedAt : !!r.task.droppedAt;
}

/** 这一行是哪一刻放弃的（ISO）。跟 rowDoneAt 同形，但**不需要「猜」那一档**：
 *  droppedAt 是这一版才有的字段，凡是有放弃标记的都必定带着时刻，没有来历不明的老数据 */
export function rowDroppedAt(r: DateRow): string {
  return (r.sub ? r.sub.droppedAt : null) ?? r.task.droppedAt ?? r.task.createdAt;
}

/** 这一行放弃在哪一天（本地 'YYYY-MM-DD'）。同 rowDoneDay，UTC ISO 要转回本地再归日 */
export function rowDroppedDay(r: DateRow): string {
  return toYMD(new Date(rowDroppedAt(r)));
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
export function allWho(d: Pick<AppData, "tasks" | "settings">): { who: string; open: number }[] {
  const map = new Map<string, number>();
  for (const t of aliveTasks(d)) {
    // 放弃跟完成同一个口径（v1.9.0 收口）：两种都是「了结了」，都不算未完成。
    // 这个数跟统计页 byWho 的 open 栏、跟点进去看到的条数是同一个算法，三处不许再劈叉
    for (const w of t.who) map.set(w, (map.get(w) ?? 0) + (t.done || t.droppedAt ? 0 : 1));
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

export function allTags(d: Pick<AppData, "tasks">): { tag: string; open: number }[] {
  const map = new Map<string, number>();
  for (const t of aliveTasks(d)) {
    // 放弃跟完成同一个口径，理由同 allWho
    if (t.done || t.droppedAt) continue;
    for (const tag of t.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
  }
  return [...map.entries()].map(([tag, open]) => ({ tag, open })).sort((a, b) => b.open - a.open);
}
