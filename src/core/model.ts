// 数据模型：整个应用的唯一契约。所有模块（解析/循环/统计/存储/UI）都从这里取类型。

export type Priority = 0 | 1 | 2 | 3; // 0 无 · 1 低 · 2 中 · 3 高

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
  /** 子任务自己的日期/优先级；null/undefined = 继承母任务。有自己日期的子任务会单独出现在日期视图里 */
  due?: string | null;
  dueTime?: string | null;
  priority?: Priority | null;
}

export type RepeatRule =
  | { kind: "daily"; every: number } // 每天 / 每 N 天
  | { kind: "weekly"; days: number[] } // 每周几（0=周日…6=周六，升序）
  | { kind: "monthly"; day: number } // 每月 N 号（超出当月末取月末）
  | { kind: "workday" }; // 每个工作日（周一至周五）

/** 事情的分类。习惯是新增的一级分类：天生重复、靠打卡记录、有自己的入口和视觉。
 *  为什么不做成独立实体：它本质就是「另一种事」，共用任务的标题/备注/清单/需求方/子任务
 *  这些字段，独立一套只会让搜索、统计、同步、导入导出各写两遍。 */
export type TaskKind = "task" | "habit";

export interface Task {
  id: string;
  title: string;
  /** 'task' = 普通事（做完就没了）；'habit' = 习惯（每天/每周该做，靠 checkIns 记录打卡） */
  kind: TaskKind;
  notes: string;
  /** null = 随手记 */
  listId: string | null;
  tags: string[];
  /** 需求方：这件事是为谁做的（@李哥 @张总，可以多个）。空数组 = 未指定 */
  who: string[];
  priority: Priority;
  /** 截止/安排日期 'YYYY-MM-DD'；null = 未安排 */
  due: string | null;
  /** 'HH:mm'；仅在 due 存在时有意义 */
  dueTime: string | null;
  /** 下次提醒 'YYYY-MM-DDTHH:mm'（本地）；null = 不提醒 */
  reminder: string | null;
  repeat: RepeatRule | null;
  subtasks: Subtask[];
  done: boolean;
  /** ISO 完成时刻 */
  doneAt: string | null;
  createdAt: string;
  /** 手动排序序号（组内） */
  order: number;
  /** 顺延次数：每次把 due 往后改都 +1 */
  postponeCount: number;
  /** 累计专注分钟数 */
  focusMinutes: number;
  /** 非 null = 在回收站，值为删除时刻 ISO */
  deletedAt: string | null;
  /** 最后一次改动时刻 ISO。云同步靠它判断「两台设备都改过同一件事时该听谁的」——
   *  谁改得晚听谁的。每次经 mutate() 真正变过的任务都会重新盖这个戳 */
  updatedAt: string;
  /** 只有习惯用：打过卡的日期 'YYYY-MM-DD'，升序去重。
   *  习惯不用 done/doneAt——「今天做没做」= 今天在不在这个数组里，
   *  这样连续天数、本周几次、补打昨天的卡全都是对这个数组做运算，没有隐藏状态 */
  checkIns: string[];
}

export interface List {
  id: string;
  name: string;
  /** 主题色 token 名之一，见 themes.css 的 --list-*，如 'clay' | 'moss' | 'sea' | 'sand' | 'slate' | 'plum' */
  color: string;
  order: number;
  /** 同 Task.updatedAt */
  updatedAt: string;
}

/** 墓碑：被彻底删掉（不是进回收站）的任务/清单 id + 删除时刻。
 *  没有它，另一台设备同步过来会把已经清干净的东西又拉回来。保留 180 天后自行清掉 */
export interface Tombstone {
  id: string;
  at: string;
}

export interface FocusSession {
  taskId: string | null;
  /** 'YYYY-MM-DD' 属于哪一天 */
  date: string;
  minutes: number;
  startedAt: string; // ISO
}

export type ThemeName = "forest" | "ocean" | "night" | "desert" | "snow" | "polar";

export interface Settings {
  theme: ThemeName;
  mode: "light" | "dark" | "system";
  quickAddShortcut: string; // 如 'Alt+Space'
  autostart: boolean;
  focusMinutesDefault: number; // 25
  /** 只填日期没填时间的任务，提醒默认落在这个钟点 */
  reminderDefaultTime: string; // '09:00'
  /** 列表排序：时间优先（同时间按重要性）或重要性优先 */
  sortMode: "time" | "priority";
}

/** 应用版本号（构建时由 package.json 注入；测试环境没有这个宏时退到 dev） */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

/** 当前数据模型版本。导入导出、服务器同步都以它为准（见 transfer.ts / cloud.ts） */
export const DATA_VERSION = 5;

export interface AppData {
  version: 5;
  lists: List[];
  tasks: Task[];
  sessions: FocusSession[];
  settings: Settings;
  /** 彻底删掉的东西的墓碑（见 Tombstone）。不参与界面，只为云同步不把死人拉回来 */
  graveyard: Tombstone[];
}

/** 墓碑保留多久。比回收站的 30 天长得多——只要还有设备可能揣着旧副本，就不能忘 */
export const TOMBSTONE_DAYS = 180;

// ---------- 构造 ----------

let idSeq = 0;
export function newId(): string {
  idSeq = (idSeq + 1) % 46656;
  return `${Date.now().toString(36)}-${idSeq.toString(36)}-${Math.floor(Math.random() * 46656).toString(36)}`;
}

export const LIST_COLORS = ["clay", "moss", "sea", "sand", "slate", "plum"] as const;

export function defaultSettings(): Settings {
  return {
    theme: "forest",
    mode: "system",
    quickAddShortcut: "Alt+Space",
    autostart: false,
    focusMinutesDefault: 25,
    reminderDefaultTime: "09:00",
    sortMode: "time",
  };
}

export function defaultData(): AppData {
  const at = new Date().toISOString();
  return {
    version: 5,
    lists: [
      { id: newId(), name: "工作", color: "clay", order: 0, updatedAt: at },
      { id: newId(), name: "生活", color: "moss", order: 1, updatedAt: at },
    ],
    tasks: [],
    sessions: [],
    settings: defaultSettings(),
    graveyard: [],
  };
}

export function newTask(partial: Partial<Task> & { title: string }): Task {
  return {
    id: newId(),
    kind: "task",
    checkIns: [],
    updatedAt: new Date().toISOString(),
    notes: "",
    listId: null,
    tags: [],
    who: [],
    priority: 0,
    due: null,
    dueTime: null,
    reminder: null,
    repeat: null,
    subtasks: [],
    done: false,
    doneAt: null,
    createdAt: new Date().toISOString(),
    order: 0,
    postponeCount: 0,
    focusMinutes: 0,
    deletedAt: null,
    ...partial,
  };
}

/** 需求方字段归一：老数据是单个字符串（或 null），新数据是数组。
 *  去重、去空白、丢空串——保证 who 永远是一个干净的字符串数组 */
export function normalizeWho(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (name === "" || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** 数据文件载入后的兜底：老版本字段补齐、废弃字段清理（向前兼容，绝不丢数据）
 *  v1 → v2：someday 概念取消（无日期任务统一住随手记/全部），字段直接丢弃；
 *  子任务补 due/dueTime/priority（默认继承母任务，存为 null）
 *  v2 → v3：需求方从单个人改成可以多个（`who: "李哥"` → `who: ["李哥"]`）
 *  v3 → v4：每条任务/清单补 updatedAt（云同步判先后用），补空墓碑表。
 *           老数据没有这个戳，就拿创建时刻顶上——比拿「现在」老实：
 *           拿现在会让本机所有旧任务显得比云端新，第一次同步就把云端盖掉
 *  v4 → v5：新增「习惯」分类。老任务一律 kind='task'、checkIns 空——
 *           没有任何一条旧数据会被误判成习惯 */
export function migrate(raw: unknown): AppData {
  const d = (raw ?? {}) as Partial<AppData> & { tasks?: (Task & { someday?: boolean })[] };
  const base = defaultData();
  const settings = { ...defaultSettings(), ...(d.settings ?? {}) };
  const epoch = new Date(0).toISOString();
  const tasks = (Array.isArray(d.tasks) ? d.tasks : []).map((t) => {
    const merged = { ...newTask({ title: "" }), ...t } as Task & { someday?: boolean };
    const { someday: _dropped, ...rest } = merged;
    return {
      ...rest,
      who: normalizeWho((rest as { who?: unknown }).who),
      kind: (rest.kind === "habit" ? "habit" : "task") as TaskKind,
      checkIns: normalizeCheckIns((rest as { checkIns?: unknown }).checkIns),
      updatedAt: typeof rest.updatedAt === "string" && rest.updatedAt ? rest.updatedAt : rest.createdAt,
      subtasks: (rest.subtasks ?? []).map((s) => ({
        due: null,
        dueTime: null,
        priority: null,
        ...s,
      })),
    };
  });
  const lists = (Array.isArray(d.lists) && d.lists.length ? (d.lists as List[]) : base.lists).map(
    (l) => ({ ...l, updatedAt: typeof l.updatedAt === "string" && l.updatedAt ? l.updatedAt : epoch }),
  );
  const graveyard = (Array.isArray(d.graveyard) ? d.graveyard : [])
    .filter(
      (g): g is Tombstone =>
        !!g && typeof (g as Tombstone).id === "string" && typeof (g as Tombstone).at === "string",
    )
    .map((g) => ({ id: g.id, at: g.at }));
  return {
    version: 5,
    lists,
    tasks,
    sessions: Array.isArray(d.sessions) ? (d.sessions as FocusSession[]) : [],
    settings,
    graveyard: pruneGraveyard(graveyard),
  };
}

/** 打卡日期归一：只留合法的 'YYYY-MM-DD'，去重升序。
 *  两台设备各打各的卡，合并时靠这个保证不出现重复日期和乱序 */
export function normalizeCheckIns(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) {
    if (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)) out.add(x);
  }
  return [...out].sort();
}

/** 太老的墓碑清掉——所有设备早就同步过了，再留着只是白占地方 */
export function pruneGraveyard(graves: Tombstone[], now = Date.now()): Tombstone[] {
  const cutoff = now - TOMBSTONE_DAYS * 86400000;
  const seen = new Map<string, string>();
  for (const g of graves) {
    const at = new Date(g.at).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    const prev = seen.get(g.id);
    if (prev === undefined || prev < g.at) seen.set(g.id, g.at);
  }
  return [...seen.entries()].map(([id, at]) => ({ id, at }));
}
