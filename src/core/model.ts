// 数据模型：整个应用的唯一契约。所有模块（解析/循环/统计/存储/UI）都从这里取类型。

export type Priority = 0 | 1 | 2 | 3; // 0 无 · 1 低 · 2 中 · 3 高

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
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
  /** null = 收件箱 */
  listId: string | null;
  tags: string[];
  /** 需求方：这件事是为谁做的（@李哥）。null = 未指定 */
  who: string | null;
  priority: Priority;
  /** 截止/安排日期 'YYYY-MM-DD'；null = 未安排 */
  due: string | null;
  /** 'HH:mm'；仅在 due 存在时有意义 */
  dueTime: string | null;
  /** 下次提醒 'YYYY-MM-DDTHH:mm'（本地）；null = 不提醒 */
  reminder: string | null;
  repeat: RepeatRule | null;
  subtasks: Subtask[];
  /** 「随时」抽屉：没有日期压力的存放处 */
  someday: boolean;
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
}

export interface AppData {
  version: 1;
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
  };
}

export function defaultData(): AppData {
  return {
    version: 1,
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
    who: null,
    priority: 0,
    due: null,
    dueTime: null,
    reminder: null,
    repeat: null,
    subtasks: [],
    someday: false,
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

/** 数据文件载入后的兜底：老版本字段补齐（向前兼容） */
export function migrate(raw: unknown): AppData {
  const d = (raw ?? {}) as Partial<AppData>;
  const base = defaultData();
  const settings = { ...defaultSettings(), ...(d.settings ?? {}) };
  const tasks = (Array.isArray(d.tasks) ? d.tasks : []).map((t) => ({
    ...newTask({ title: "" }),
    ...t,
  }));
  return {
    version: 1,
    lists: Array.isArray(d.lists) && d.lists.length ? (d.lists as List[]) : base.lists,
    tasks,
    sessions: Array.isArray(d.sessions) ? (d.sessions as FocusSession[]) : [],
    settings,
  };
}
