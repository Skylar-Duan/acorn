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

export interface Task {
  id: string;
  title: string;
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
}

export interface List {
  id: string;
  name: string;
  /** 主题色 token 名之一，见 themes.css 的 --list-*，如 'clay' | 'moss' | 'sea' | 'sand' | 'slate' | 'plum' */
  color: string;
  order: number;
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

/** 当前数据模型版本。导入导出、以后的服务器同步都以它为准（见 transfer.ts） */
export const DATA_VERSION = 3;

export interface AppData {
  version: 3;
  lists: List[];
  tasks: Task[];
  sessions: FocusSession[];
  settings: Settings;
}

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
  return {
    version: 3,
    lists: [
      { id: newId(), name: "工作", color: "clay", order: 0 },
      { id: newId(), name: "生活", color: "moss", order: 1 },
    ],
    tasks: [],
    sessions: [],
    settings: defaultSettings(),
  };
}

export function newTask(partial: Partial<Task> & { title: string }): Task {
  return {
    id: newId(),
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
 *  v2 → v3：需求方从单个人改成可以多个（`who: "李哥"` → `who: ["李哥"]`） */
export function migrate(raw: unknown): AppData {
  const d = (raw ?? {}) as Partial<AppData> & { tasks?: (Task & { someday?: boolean })[] };
  const base = defaultData();
  const settings = { ...defaultSettings(), ...(d.settings ?? {}) };
  const tasks = (Array.isArray(d.tasks) ? d.tasks : []).map((t) => {
    const merged = { ...newTask({ title: "" }), ...t } as Task & { someday?: boolean };
    const { someday: _dropped, ...rest } = merged;
    return {
      ...rest,
      who: normalizeWho((rest as { who?: unknown }).who),
      subtasks: (rest.subtasks ?? []).map((s) => ({
        due: null,
        dueTime: null,
        priority: null,
        ...s,
      })),
    };
  });
  return {
    version: 3,
    lists: Array.isArray(d.lists) && d.lists.length ? (d.lists as List[]) : base.lists,
    tasks,
    sessions: Array.isArray(d.sessions) ? (d.sessions as FocusSession[]) : [],
    settings,
  };
}
