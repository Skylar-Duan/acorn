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
  /** ISO 完成时刻；null = 没勾上，或者是这个字段之前就已经勾掉的老数据。
   *  「已完成」按子任务列、日历按实际完成日归格都靠它。老数据缺这个戳时回落到母任务的
   *  doneAt（口径见 store.rowDoneAt），**绝不在迁移时拿「现在」补** */
  doneAt?: string | null;
  /** ISO 放弃时刻；null/缺失 = 没放弃。「不做了」跟「做完了」是两回事，各占一个字段：
   *  圈圈只管完成，放弃是标题旁边那个灰标签。两者互斥，见 store.applySubPatch */
  droppedAt?: string | null;
  /** ISO 删除时刻；null/**缺失** = 活着（v7）。子任务删掉不再是当场消失，而是跟整件事一样
   *  进回收站待 30 天（回收站页单列「母 › 子」一行，可恢复 / 彻底删除）。
   *  **老数据缺这个键就让它缺着**，migrate 不补 null——补了等于把每一条子任务都改写一遍。
   *  凡是「活着的子任务」语义的地方一律走 store.aliveSubtasks，不许各处手写 filter */
  deletedAt?: string | null;
  /** 子任务自己的循环规则；null/**缺失** = 不循环（v8）。跟日期/重要性不同，它**不继承母任务**：
   *  母任务的 repeat 管的是整件事下一轮什么时候来，一条子任务写「每周末」说的是它自己每周来一次。
   *  存在这里而不是另开一张表：子任务本来就是任务的一个字段，循环规则跟 Task.repeat 同一个类型，
   *  两套语义共用一个引擎（core/recur）——独立一套只会让解析、推进、同步各写两遍。
   *  **老数据缺这个键就让它缺着**，migrate 不补 null——理由跟 deletedAt 那条一模一样：
   *  补了等于把每一条子任务都改写一遍，导出文件里每条平白多一个键。
   *  勾完成 / 放弃一条带循环且有 due 的子任务时**不标完成，只把 due 推到下一个落点**
   *  （见 store.advanceSub）；**故意不留已完成副本**——那份历史会堆在母任务卡片里，
   *  一条每周重复的子任务一年 52 行，卡片就没法看了。这一处跟整件事的行为不一致，是有意的 */
  repeat?: RepeatRule | null;
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
  /** ISO 放弃时刻；null = 没放弃。放弃 = 这件事不做了，但它不是「完成」——
   *  统计里单独算一档，绝不混进完成率。跟 done/doneAt 互斥（见 store.dropTasks / completeTask） */
  droppedAt: string | null;
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
  /** 记事时写「周末」「下周末」指的是周六还是周日。默认周日；老数据缺这个字段时 migrate 补成周日 */
  weekendDay: "sat" | "sun";
  /** 需求方在侧栏的手排顺序（人名，按显示先后）。没排过的人接在后面。
   *  放在设置里 = 每台设备各排各的：需求方不是一条真实记录，只是任务上的一个名字，
   *  给它建一张会同步的表不值当 */
  whoOrder: string[];
}

/** 应用版本号（构建时由 package.json 注入；测试环境没有这个宏时退到 dev） */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

/** 当前数据模型版本。导入导出、服务器同步都以它为准（见 transfer.ts / cloud.ts） */
export const DATA_VERSION = 8;

export interface AppData {
  /** 这份数据本来是第几版。**不是字面量 6**：更新版本的橡果写的数据被老客户端读进来时，
   *  这个数字必须原样活下来（migrate 取 max，见下），否则「这份是第 7 版」这个事实
   *  会被老客户端一次保存就抹成 6，云端的 schema 棘轮也会被它拉回去 */
  version: number;
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
    weekendDay: "sun",
    whoOrder: [],
  };
}

export function defaultData(): AppData {
  const at = new Date().toISOString();
  return {
    version: 8,
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
    droppedAt: null,
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
 *           没有任何一条旧数据会被误判成习惯
 *  v5 → v6：子任务补 doneAt、任务与子任务各补 droppedAt（都补 null，不补「现在」）。
 *           之所以为可选字段升版本：老客户端不只是「读进来看不见新字段」，它还会**持续写入**
 *           勾掉却没有 doneAt 的已完成子任务，新客户端拿到只能猜日子；「放弃」它更是整个不认，
 *           在它那边一件已放弃的事会照旧躺在待办里。升版本是为了让新客户端知道该防着谁，
 *           **不是为了把老客户端挡在门外**（v1.9.1 起：比本机新的数据照读，见下）
 *  v6 → v7：子任务加 deletedAt（删掉的子任务进回收站，不再当场消失）。**不改任何值**：
 *           老数据缺这个键就让它缺着（缺失 = 活着），不补 null 也不补时间。升版本是因为
 *           老客户端会把已删的子任务当活的显示、还可能勾完它（判据第二问为「会」）
 *  v7 → v8：子任务加 repeat（子任务能带自己的循环，「每周末 大扫除」记在子任务里也认）。
 *           **不改任何值**：老数据缺这个键就让它缺着（缺失 = 不循环），不补 null。
 *           升版本是因为老客户端（v1.13.0）压根不认这个字段：勾掉一条带循环的子任务时
 *           它只会标成完成、不会推到下一次，用户看到的是「循环失效了」（判据第二问为「会」）
 *
 *  **比本机新的数据一律照常读进来，一个字段都不许丢**（v1.9.1 的产品原则）：
 *  · 顶层先铺开原始对象再覆盖已知键 —— 新版本才有的顶层集合（projects/notebooks…）不被吞掉
 *  · 墓碑只过滤不重建 —— 墓碑上的未知字段跟着走
 *  · version 取 `max(DATA_VERSION, 读到的)` —— 「这份本来是第几版」这个事实活下来
 *  丢掉其中任何一条，老客户端读一次、存一次就把新版本的数据吃掉一层，用户毫不知情。
 *
 *  **字段差异表、转化规则、升不升版本的判据都在 `docs/数据模型变更.md`**，
 *  这段注释只留一句摘要，改模型时以那份台账为准。 */
export function migrate(raw: unknown): AppData {
  // 只有「真正的对象」才配被铺开。字符串会被 spread 成 {0:'a',1:'b'}、数组会被铺成下标键，
  // 那不是数据是垃圾——这一层过滤就是老那个 6 键字面量顺带起过的「消毒」作用
  const src: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = src as Partial<AppData> & { tasks?: (Task & { someday?: boolean })[] };
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
      // 子任务没有工厂函数，默认值就写在这个字面量里（另一处是 store.addSubtask）——
      // 给 Subtask 加字段必须同时改这两处。漏了这处，老数据里那个键是 undefined，
      // JSON.stringify 会把它整个吞掉，「导出→导入→再导出逐字节一致」当场就不成立了。
      // doneAt 只补 null：已经勾掉的老子任务不知道是哪天勾的，拿「现在」补等于集体撒谎。
      // droppedAt 同理，老数据里根本没有「放弃」这回事，一律补 null。
      // deletedAt（v7）**故意不在这个字面量里**：它的口径是「缺失 = 活着」，老数据一个键都不补，
      // 读进来什么样存回去还是什么样；带着这个键的新数据靠下面的 ...s 原样带走。
      // repeat（v8）同理**故意不补**：口径是「缺失 = 不循环」，补 null 一样没有信息量，
      // 却会把每一条老子任务都改写一遍
      subtasks: (rest.subtasks ?? []).map((s) => ({
        due: null,
        dueTime: null,
        priority: null,
        doneAt: null,
        droppedAt: null,
        ...s,
      })),
    };
  });
  const lists = (Array.isArray(d.lists) && d.lists.length ? (d.lists as List[]) : base.lists).map(
    (l) => ({ ...l, updatedAt: typeof l.updatedAt === "string" && l.updatedAt ? l.updatedAt : epoch }),
  );
  // **只过滤，不重建**。以前这里跟着一个 `.map(g => ({id, at}))`，墓碑因此是全代码
  // 唯一会丢未知字段的结构——给墓碑加字段（比如「删的是任务还是清单」），老客户端过一遍就抹了
  const graveyard = (Array.isArray(d.graveyard) ? d.graveyard : []).filter(
    (g): g is Tombstone =>
      !!g && typeof (g as Tombstone).id === "string" && typeof (g as Tombstone).at === "string",
  );
  // 先铺开原始对象、再覆盖已知键：这样新版本才有的**顶层集合**原样留着。
  // 写成 6 键字面量的那些年，schema 7 的 projects/notebooks 每读一次就整个消失，连痕迹都没有
  return {
    ...src,
    version: Math.max(DATA_VERSION, typeof d.version === "number" ? d.version : 0),
    lists,
    tasks,
    sessions: Array.isArray(d.sessions) ? (d.sessions as FocusSession[]) : [],
    settings,
    graveyard: pruneGraveyard(graveyard),
  } as AppData;
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

/** 太老的墓碑清掉——所有设备早就同步过了，再留着只是白占地方。
 *
 *  **留的是原对象，不是 `{id, at}` 重建件**：它是 migrate / mergeData / bury 三条路的共同咽喉，
 *  在这里重建一次，墓碑上的未知字段就每次迁移、每次同步、每次彻底删除各丢一次 */
export function pruneGraveyard(graves: Tombstone[], now = Date.now()): Tombstone[] {
  const cutoff = now - TOMBSTONE_DAYS * 86400000;
  const seen = new Map<string, Tombstone>();
  for (const g of graves) {
    const at = new Date(g.at).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    const prev = seen.get(g.id);
    if (prev === undefined || prev.at < g.at) seen.set(g.id, g);
  }
  return [...seen.values()];
}
