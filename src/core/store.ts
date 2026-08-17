// 应用状态中枢（zustand）。所有数据变更必须经 mutate() —— 它负责撤销快照与延迟落盘。
// UI 层只调用这里导出的动作，不直接改 data。

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { AppData, List, Priority, RepeatRule, Settings, Subtask, Task } from "./model";
import { defaultData, newId, newTask } from "./model";
import { addDays, cmpYMD, nowLocalDT, todayYMD, toLocalDT, toYMD } from "./dates";
import { firstOccurrence, nextOccurrence } from "./recur";
import * as persist from "./persist";

export type ViewId =
  | "inbox" | "today" | "upcoming" | "all" | "logbook"
  | "calendar" | "quadrant" | "focus" | "stats" | "settings"
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
  ui: {
    view: "today", listId: null, who: null, tag: null,
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
  // 数据没加载成功时绝不落盘——否则会拿默认空库覆盖磁盘上的真数据
  if (!s.loaded || s.loadError) return Promise.resolve();
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

// ---------- 变更入口 ----------

/** 所有写操作的唯一入口：应用变更 → 快照进撤销栈 → 计划落盘。无实际变更时什么都不做 */
function mutate(fn: (d: AppData) => AppData, opts?: { toast?: string; skipUndo?: boolean }) {
  const cur = appStore.getState().data;
  const next = fn(cur);
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
    const patched = { ...pt };
    if (ct.reminder === null && pt.reminder && pt.reminder <= now) patched.reminder = null;
    if (ct.focusMinutes > pt.focusMinutes) patched.focusMinutes = ct.focusMinutes;
    return patched;
  });
  appStore.setState({
    data: { ...prev, tasks, sessions: cur.sessions, settings: cur.settings },
    undoDepth: undoStack.length,
    ui: { ...appStore.getState().ui, toast: null },
  });
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
    let loadedData: AppData | null;
    try {
      loadedData = await persist.loadData();
    } catch (first) {
      // 瞬时抖动（移动硬盘唤醒等）重试一次再放弃
      await new Promise((r) => setTimeout(r, 800));
      loadedData = await persist.loadData();
    }
    const data = loadedData ?? defaultData();
    // 回收站 30 天自动清理
    const cutoff = Date.now() - 30 * 86400000;
    data.tasks = data.tasks.filter(
      (t) => !t.deletedAt || new Date(t.deletedAt).getTime() > cutoff,
    );
    undoStack = []; // 换数据源（含恢复备份后 reload）不能撤销回旧数据
    appStore.setState({ data, loaded: true, loadError: null });
    if (loadedData == null) await persist.saveData(data);
    await persist.ensureDailyBackup();
  } catch (e) {
    appStore.setState({ loaded: true, loadError: String(e) });
  }
}

// ---------- 任务动作 ----------

export interface AddTaskInput {
  title: string;
  listId?: string | null;
  tags?: string[];
  who?: string | null;
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
    who: input.who ?? null,
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
        // 子任务的专属日期属于上一轮，随循环推进一并清掉（重新继承母任务）
        subtasks: t.subtasks.map((s) => ({ ...s, done: false, due: null, dueTime: null })),
        postponeCount: 0,
      };
      return { ...d, tasks: d.tasks.map((x) => (x.id === id ? advanced : x)).concat(doneCopy) };
    }
    return {
      ...d,
      tasks: d.tasks.map((x) => (x.id === id ? { ...x, done: true, doneAt: nowIso } : x)),
    };
  });
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
  mutate((d) => ({ ...d, tasks: d.tasks.filter((t) => !t.deletedAt) }), { toast: "回收站已清空" });
}

/** 按行顺延：母任务行推母任务，子任务行推子任务自己的日期（逾期区「全部推到明天」用） */
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
              if (!hit || !s.due) return s;
              const base = cmpYMD(s.due, today) > 0 ? s.due : today;
              return { ...s, due: addDays(base, days) };
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

// ---------- 子任务 ----------

export function addSubtask(taskId: string, title: string) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) =>
      t.id === taskId ? { ...t, subtasks: [...t.subtasks, { id: newId(), title, done: false }] } : t,
    ),
  }));
}

export function toggleSubtask(taskId: string, subId: string) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) =>
      t.id === taskId
        ? { ...t, subtasks: t.subtasks.map((s) => (s.id === subId ? { ...s, done: !s.done } : s)) }
        : t,
    ),
  }));
}

/** 子任务字段更新（自己的日期/优先级/标题） */
export function updateSubtask(taskId: string, subId: string, patch: Partial<Subtask>) {
  mutate((d) => ({
    ...d,
    tasks: d.tasks.map((t) =>
      t.id === taskId
        ? { ...t, subtasks: t.subtasks.map((s) => (s.id === subId ? { ...s, ...patch } : s)) }
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
    lists: [...d.lists, { id, name, color, order: d.lists.length }],
  }));
  return id;
}

export function renameList(id: string, name: string) {
  mutate((d) => ({ ...d, lists: d.lists.map((l) => (l.id === id ? { ...l, name } : l)) }));
}

export function setListColor(id: string, color: string) {
  mutate((d) => ({ ...d, lists: d.lists.map((l) => (l.id === id ? { ...l, color } : l)) }));
}

/** 删除清单：其下任务回收件箱；正看着这张清单时把视图也带走，防止悬空 */
export function deleteList(id: string) {
  mutate(
    (d) => ({
      ...d,
      lists: d.lists.filter((l) => l.id !== id),
      tasks: d.tasks.map((t) => (t.listId === id ? { ...t, listId: null } : t)),
    }),
    { toast: "清单已删除，任务已移回收件箱" },
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

export function aliveTasks(d: AppData): Task[] {
  return d.tasks.filter((t) => !t.deletedAt);
}

/** 日期视图的统一行：母任务本身，或带自己日期的子任务（sub 非 null 时） */
export interface DateRow {
  task: Task;
  sub: Subtask | null;
}

export function rowDue(r: DateRow): string | null {
  return r.sub ? r.sub.due ?? null : r.task.due;
}

export function rowTime(r: DateRow): string | null {
  return r.sub ? r.sub.dueTime ?? null : r.task.dueTime;
}

export function rowPriority(r: DateRow): Priority {
  return r.sub ? r.sub.priority ?? r.task.priority : r.task.priority;
}

/** 所有会出现在日期/总览视图里的未完成行：未完成母任务 + 有自己日期的未完成子任务 */
export function openRows(d: AppData): DateRow[] {
  const rows: DateRow[] = [];
  for (const t of aliveTasks(d)) {
    if (t.done) continue;
    rows.push({ task: t, sub: null });
    for (const s of t.subtasks) {
      if (!s.done && s.due) rows.push({ task: t, sub: s });
    }
  }
  return rows;
}

/** 排序：time = 时间优先（同时间按重要性）；priority = 重要性优先（同级按时间）。无日期的都排最后 */
export function sortRows(rows: DateRow[], mode: "time" | "priority"): DateRow[] {
  const key = (r: DateRow) => `${rowDue(r) ?? "9999-99-99"}T${rowTime(r) ?? "99:99"}`;
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
    return a.task.order - b.task.order;
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

/** 需求方列表（按未完成任务数降序） */
export function allWho(d: AppData): { who: string; open: number }[] {
  const map = new Map<string, number>();
  for (const t of aliveTasks(d)) {
    if (!t.who) continue;
    map.set(t.who, (map.get(t.who) ?? 0) + (t.done ? 0 : 1));
  }
  return [...map.entries()]
    .map(([who, open]) => ({ who, open }))
    .sort((a, b) => b.open - a.open);
}

export function allTags(d: AppData): { tag: string; open: number }[] {
  const map = new Map<string, number>();
  for (const t of aliveTasks(d)) {
    if (t.done) continue;
    for (const tag of t.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
  }
  return [...map.entries()].map(([tag, open]) => ({ tag, open })).sort((a, b) => b.open - a.open);
}
