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
//
// 文件下半截（v1.14.1 加）是把这台状态机接到真事件上的那层 React 钩子。上半截照旧一个
// react 的字都不认，单测还是对着纯函数跑。

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

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

// ───────────────── 下面是把上面这台状态机接到真事件上的那层（v1.14.1） ─────────────────

/** 一行的 `data-sort` 长这样：`list:abc` / `who:小明`。把「是谁」从里面读出来。
 *  单抽一个函数是因为它是整条命中测试里唯一会写歪的一步——前缀长度差一个字符，
 *  拖谁都变成拖了个空名字，而界面上看起来一切正常。 */
export function readSortKey(kind: string, attr: string | null | undefined): string | null {
  if (!attr) return null;
  const head = `${kind}:`;
  if (!attr.startsWith(head)) return null;
  return attr.slice(head.length) || null;
}

/**
 * 排完序抬手那一下，浏览器还会补一次 click——不吞掉的话「给清单换个位置」会顺手
 * 跳进那张清单。**在捕获阶段、挂在 document 上**吞：手指常常抬在别的行、甚至别的表
 * 或者一张格子上，只盯着被拖的那一行是拦不住的。
 *
 * 留一道兜底超时：这一下 click 要是压根没来（手指抬在了空处、被系统吃了），
 * 监听不能一直挂着——否则下一次好端端的点击会被它吞掉，界面就成了「点不动」。
 *
 * 返回撤销函数，组件卸载时调一下，别把监听留在文档上。
 */
export function eatNextClick(ttlMs = 400): () => void {
  if (typeof document === "undefined") return () => {};
  let done = false;
  const stop = (e: Event) => {
    done = true;
    e.preventDefault();
    e.stopPropagation();
  };
  const off = () => {
    if (!done) document.removeEventListener("click", stop, { capture: true });
    done = true;
  };
  document.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(off, ttlMs);
  return off;
}

/**
 * 手指版的「按住换位置」：按住不动一会儿把这一行拎起来 → 移动改落点 → 抬手落位。
 *
 * 用在手机「更多」页的清单 / 需求方两张表（views/MobileMore.tsx）。触摸屏上 HTML5 拖拽
 * 根本不触发，所以桌面侧栏那套 draggable 在手机上等于不存在——这层是补那个洞的。
 *
 * `kind` 只用来给 `data-sort` 打前缀，好让命中测试认得出「同一张表里的行」：
 * 清单拖不到需求方头上去，反过来也一样。
 *
 * `onDrop` 一律交给 store 里现成的重排函数（moveList / moveWho），这儿一个字都不许自己写库——
 * 清单的顺序跟数据走会同步到别的设备，需求方的顺序存在本机设置里，两者语义不同，
 * 只有 store 那两个函数分得清。
 *
 * 桌面侧栏（components/Sidebar.tsx）眼下还带着一份自己的同款实现，它跟那边的 HTML5 拖拽
 * 缠在一起，这一轮不许动那个文件。**下一轮把它换成这一份**——同一个手势不该有两份实现。
 */
export function useLongPressSort(
  kind: string,
  onDrop: (from: string, to: string) => void,
  hint: { over: string | null; set: (v: string | null) => void },
) {
  const [st, setSt] = useState<SortState>(IDLE);
  const timer = useRef<number | null>(null);
  const eater = useRef<(() => void) | null>(null);

  function stopTimer() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  // 排序中要把页面按住。React 的 onTouchMove 是被动监听，preventDefault 无效，
  // 必须自己挂一个 passive:false 的原生监听，否则手指一动整页就滚走了
  useEffect(() => {
    if (st.phase !== "sorting") return;
    const block = (e: TouchEvent) => e.preventDefault();
    document.addEventListener("touchmove", block, { passive: false });
    return () => document.removeEventListener("touchmove", block);
  }, [st.phase]);

  useEffect(
    () => () => {
      stopTimer();
      eater.current?.();
    },
    [],
  );

  /** 手指底下压着的是哪一行。用实时命中测试而不是记录每行的位置——这一页会滚、表会变长 */
  function keyAt(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const row = el?.closest?.(`[data-sort^="${kind}:"]`) as HTMLElement | null;
    return readSortKey(kind, row?.getAttribute("data-sort"));
  }

  function finish(next: SortState) {
    stopTimer();
    setSt(next);
    hint.set(null);
  }

  return {
    /** 这一行现在正被拎着吗（界面上要浮起来） */
    lifted: (self: string) => st.phase === "sorting" && st.self === self,
    props: (self: string) => ({
      "data-sort": `${kind}:${self}`,
      onPointerDown: (e: ReactPointerEvent) => {
        if (e.pointerType === "mouse") return; // 鼠标在别处走 HTML5 拖拽那套
        const next = down(st, self, e.clientX, e.clientY);
        if (next === st) return;
        setSt(next);
        // 抓住指针：手指滑出这一行之后还要继续收到 move / up
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        stopTimer();
        timer.current = window.setTimeout(() => setSt((s) => hold(s)), LONG_PRESS_MS);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        if (st.phase === "idle") return;
        const next = move(st, e.clientX, e.clientY, keyAt);
        if (next === st) return;
        if (next.phase === "idle") stopTimer(); // 判成滚动了，计时器也得停
        setSt(next);
        hint.set(next.over ? `${kind}:${next.over}` : null);
      },
      onPointerUp: () => {
        if (st.phase === "idle") return;
        const r = up(st);
        // 拖过就吞掉紧跟着那一下 click（空拖也算拖过）：松手不能顺带跳进这一行
        if (r.sorted) eater.current = eatNextClick();
        finish(r.next);
        if (r.drop) onDrop(r.drop.from, r.drop.to);
      },
      onPointerCancel: () => finish(cancel()),
    }),
  };
}
