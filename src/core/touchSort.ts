// 长按排序：手机上「清单 / 需求方拖着换位置」的补丁。
//
// 为什么要单独写一套：侧栏换位置走的是 HTML5 拖拽（draggable + dragover + drop），
// 那套在触摸屏上**根本不触发**——手指按住一行往下拖，浏览器只当你在滚页面。
// 结果是 v1.8.0 的「侧栏可拖动排序」在手机上代码在、功能等于不存在。
//
// 手势定成「按住不动一会儿 → 进入排序 → 手指移动改落点 → 抬手落位」，
// 因为手机上一根手指要同时表达三件事：点开这张清单、滚动侧栏、给清单换位置。
// 靠「按住多久」和「按住时动没动」把三者分开，是移动端排序的通用做法。
//
// 状态机做成纯函数，是因为这类手势的 bug 全在时序上：按下就滑（在滚动）、
// 长按还没到就抬手（是点击）、进了排序模式再抬手（是落位）——这三条必须能单测，
// 靠在真手机上反复戳是试不全的。

/** 按住多久算「长按」。再短会跟滚动抢手，再长会让人以为没反应 */
export const LONG_PRESS_MS = 450;
/** 长按计时期间手指挪超过这么多像素，就认定用户是在滚动列表，取消排序 */
export const SLOP_PX = 10;

export type SortPhase = "idle" | "waiting" | "sorting";

export interface SortState {
  phase: SortPhase;
  /** 被按住的那一项（`清单 id` 或 `需求方名字`） */
  self: string | null;
  /** 按下时的坐标，用来判「有没有在滑」 */
  x: number;
  y: number;
  /** 当前落点。null = 悬空，抬手不动 */
  over: string | null;
}

export const IDLE: SortState = { phase: "idle", self: null, x: 0, y: 0, over: null };

/** 手指按下。只从 idle 起步——多指同时按只认第一根 */
export function down(s: SortState, self: string, x: number, y: number): SortState {
  if (s.phase !== "idle") return s;
  return { phase: "waiting", self, x, y, over: null };
}

/** 计时器到点：等待中 → 进入排序模式 */
export function hold(s: SortState): SortState {
  if (s.phase !== "waiting") return s;
  return { ...s, phase: "sorting" };
}

/**
 * 手指移动。
 * - 等待中挪超过 SLOP：判定为滚动，整个手势作废（否则一滚侧栏就误进排序）
 * - 排序中：按当前坐标下面是谁来定落点；落到自己身上等于没落点
 */
export function move(
  s: SortState,
  x: number,
  y: number,
  keyAt: (x: number, y: number) => string | null,
): SortState {
  if (s.phase === "waiting") {
    const far = Math.abs(x - s.x) > SLOP_PX || Math.abs(y - s.y) > SLOP_PX;
    return far ? IDLE : s;
  }
  if (s.phase !== "sorting") return s;
  const k = keyAt(x, y);
  const over = k && k !== s.self ? k : null;
  return over === s.over ? s : { ...s, over };
}

/**
 * 抬手。返回下一个状态 + 要不要真的换位置。
 * `sorted` 是给界面用的：刚排完序那一下的 click 要吞掉，否则松手就跳进这张清单。
 */
export function up(s: SortState): {
  next: SortState;
  drop: { from: string; to: string } | null;
  sorted: boolean;
} {
  const ok = s.phase === "sorting" && !!s.self && !!s.over && s.over !== s.self;
  return {
    next: IDLE,
    drop: ok ? { from: s.self as string, to: s.over as string } : null,
    sorted: s.phase === "sorting",
  };
}

/** 手势被系统打断（来电、手势导航、多指）——一律作废，不留半个状态 */
export function cancel(): SortState {
  return IDLE;
}
