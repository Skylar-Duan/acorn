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
//
// 最下面一截（v1.15.0 加）是手机上那版「真把卡片拎起来走」：同一台状态机，
// 落点从「画一条线」换成「其余的行实时让位」。几何照样是纯函数，照样单测。

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { dur1 } from "./motion";

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

// ═══════════ 手指真的把卡片拎起来走（v1.15.0） ═══════════
//
// 上面 useLongPressSort 那一版是「按住之后在目标行的上缘画一条线」：手指在屏幕上走，
// 卡片却一直钉在原地，人只能靠一条细线猜自己会落在哪儿。用户的原话是
// 「像 notability 一样可以真的把这个卡片拖着到处跑，拖到下面其他位置，其他卡片自动上移」。
//
// 所以这一版的规矩换成三条：
//   ① 被拎起来的那张贴着手指走（transform，不动 top / margin——那会让整张表每帧重排）；
//   ② 其余的行**实时让开**一行的位置，空出来的那格就是落点，不再另画一条线；
//   ③ 手指停在表头 / 表尾那一截时，列表自己慢慢滚，但卡片永远出不了这张表。
//
// 几何全部写成纯函数：jsdom 里 getBoundingClientRect 一律返回 0，
// 「拖到哪一格」这种事挂在钩子上是测不出来的，只有纯函数能逐条钉死。
//
// 上面那套（useLongPressSort）一个字没动：桌面侧栏还在用它。

/** 拖动开始那一刻量下来的一行：它是谁、上沿在哪、多高。坐标是当时的视口坐标 */
export interface RowBox {
  key: string;
  top: number;
  height: number;
}

/** 拎起来的那张放大一点点。再大就像贴纸，再小看不出「离开了队列」 */
export const LIFT_SCALE = 1.03;
/** 手指进到表的上下这么宽的一截里，列表开始自己滚 */
export const EDGE_PX = 64;
/** 自动滚最快每帧走这么多像素。「慢慢滚」是用户要的：滚快了整张表一闪而过，反而看不清落在哪儿 */
export const EDGE_STEP_PX = 9;

/**
 * 卡片跟着手指走了 dy 之后，它该排在第几格。
 *
 * 量的是**每一行原来的中线**：卡片的中线越过谁的中线，就排到谁后面去。
 * 为什么不拿「让位之后的位置」来算——那样一让位，判定条件立刻跟着变，
 * 手指不动卡片也会来回跳（这类拖动最常见的抖动就是这么来的）。
 * 用原始位置算，卡片走一行的距离正好换一格，手指和落点是 1:1 的。
 *
 * 返回的是「把自己抽出去之后的那串」里的下标，范围 0 … 行数-1，等于 from 就是没动过。
 *
 * 两条中线正好压在一起时算谁的，**看拖的方向**：往下拖算过了、往上拖算没过。
 * 这不是凑数——拖到表尾时卡片被 clampDy 拦在最后一行的位置上，两条中线正好重合，
 * 一刀切成「没过」的话最后一格就永远够不着（往上拖到表头同理）。
 */
export function slotOf(rows: RowBox[], from: number, dy: number): number {
  const self = rows[from];
  if (!self) return 0;
  const mid = self.top + self.height / 2 + dy;
  let slot = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (i === from) continue;
    const c = rows[i].top + rows[i].height / 2;
    if (dy >= 0 ? c <= mid : c < mid) slot += 1;
  }
  return slot;
}

/**
 * 第 j 行要让开几行的位置：+1 往下让、-1 往上让、0 站着别动。
 * 被拎起来的那一行自己不算（它跟着手指走）。
 *
 * 推导很短：卡片抽走之后，排在它下面、又在落点之前（含落点）的那些行各往上顶一格；
 * 排在它上面、又在落点之后（含落点）的那些行各往下让一格。
 */
export function shiftOf(j: number, from: number, slot: number): -1 | 0 | 1 {
  if (j === from) return 0;
  if (j < from) return j >= slot ? 1 : 0;
  return j <= slot ? -1 : 0;
}

/**
 * 落库时要告诉 store 的那个「挪到谁前面」。
 * 落在最后一格时没有「谁」可言，返回 null —— store 的 moveBefore 认这一档（v1.15.0 加的），
 * 不然卡片能一路拖到队尾、松手却停在倒数第二格，看着就像没拖动。
 */
export function dropKeyOf(rows: RowBox[], from: number, slot: number): string | null {
  const at = slot < from ? slot : slot + 1;
  return rows[at]?.key ?? null;
}

/** 卡片跟着手指走，但走不出这张表：拖到表头 / 表尾就停住（落点永远在本表内） */
export function clampDy(rows: RowBox[], from: number, dy: number): number {
  const self = rows[from];
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!self || !first || !last) return 0;
  const min = first.top - self.top;
  const max = last.top + last.height - (self.top + self.height);
  return Math.min(Math.max(dy, min), max);
}

/**
 * 松手那一下，卡片要从手指底下飞回它该在的那一格——飞到的就是这个位移。
 * 有这一下，落位才像「放下」；没有的话卡片会从手指处瞬移到空位，像闪了一下。
 */
export function settleDy(rows: RowBox[], from: number, slot: number): number {
  const self = rows[from];
  if (!self || slot === from) return 0;
  // 往上走：它占的就是落点那一行原来的位置
  if (slot < from) return (rows[slot]?.top ?? self.top) - self.top;
  // 往下走：让开的最后一行是原来的第 slot 行，它顶上去之后，卡片接在它下面
  const tail = rows[slot];
  if (!tail) return 0;
  return tail.top + tail.height - self.height - self.top;
}

/**
 * 手指贴到列表上下边缘时，这一帧该把列表滚多少像素（负数往上）。
 * 越贴边滚得越快，但最快也就 EDGE_STEP_PX——用户要的是「慢慢滚」。
 */
export function edgeScroll(
  y: number,
  top: number,
  bottom: number,
  edge = EDGE_PX,
  step = EDGE_STEP_PX,
): number {
  // 可视区还没两截边缘那么高，就别滚了：上下两头会互相抢，表在原地抖
  if (bottom - top < edge * 2) return 0;
  if (y < top + edge) return -Math.ceil(Math.min(1, (top + edge - y) / edge) * step);
  if (y > bottom - edge) return Math.ceil(Math.min(1, (y - (bottom - edge)) / edge) * step);
  return 0;
}

/**
 * 手指版的「按住把卡片拎起来换位置」：按住不动一会儿 → 卡片浮起来贴着手指走 →
 * 其余的行实时让位 → 松手，卡片落进让出来的那一格。
 *
 * 用在手机「更多」页的清单 / 需求方两张表（views/MobileMore.tsx）。
 *
 * 跟上面那套共用同一台手势状态机（down / hold / move / cancel），只把「落点是谁」
 * 换成了几何算出来的格子；桌面侧栏用的 useLongPressSort 原样留着，一个字没动。
 *
 * `onDrop` 一律交给 store 里现成的重排函数（moveList / moveWho），这儿一个字都不许自己写库——
 * 清单的顺序跟数据走、会同步到别的设备、能撤销；需求方的顺序只存在这台手机的设置里。
 * 两张表的手感做成一样，落库仍旧各走各的。
 *
 * **拖的整个过程一次都不写数据**：写了会把撤销栈和云同步刷爆（拖一次能有上百帧）。
 * 只有松手、而且真换了格，才落这一次。
 */
export function useCardSort(
  kind: string,
  onDrop: (from: string, to: string | null) => void,
) {
  const [st, setSt] = useState<SortState>(IDLE);
  /** 卡片当前跟着手指走了多远 */
  const [dy, setDy] = useState(0);
  /** 现在悬在第几格 */
  const [slot, setSlot] = useState(-1);
  /** 松手之后、落库之前那一小段：卡片正飞回格子里 */
  const [landing, setLanding] = useState(false);
  /** 落库那一帧：所有位移一起归零，这一帧不许有过渡，否则每一行都会从新位置再滑回去一次 */
  const [quiet, setQuiet] = useState(false);

  const boxEl = useRef<HTMLElement | null>(null);
  const rows = useRef<RowBox[]>([]);
  const fromIx = useRef(-1);
  const slotIx = useRef(-1);
  const startY = useRef(0);
  const startScroll = useRef(0);
  const lastY = useRef(0);
  const timer = useRef<number | null>(null);
  const land = useRef<number | null>(null);
  const eater = useRef<(() => void) | null>(null);

  function stopTimer() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  /** 这张表装在哪一层里滚。手机上每个视图都是 .view-body 自己滚（见 mobile-shell.css） */
  function scroller(): HTMLElement | null {
    return (boxEl.current?.closest(".view-body") as HTMLElement | null) ?? null;
  }

  /** 按住到点那一刻量一次「谁在哪儿」。不在按下那一刻量：那会儿列表可能还在滑 */
  function measure(self: string): boolean {
    const box = boxEl.current;
    if (!box) return false;
    const list: RowBox[] = [];
    box.querySelectorAll<HTMLElement>("[data-sort]").forEach((el) => {
      const key = readSortKey(kind, el.getAttribute("data-sort"));
      if (!key) return;
      const r = el.getBoundingClientRect();
      list.push({ key, top: r.top, height: r.height });
    });
    rows.current = list;
    fromIx.current = list.findIndex((r) => r.key === self);
    return fromIx.current >= 0 && list.length > 1;
  }

  /** 手指到了 y，卡片走多远、悬在第几格。列表自己滚过的那一段要补进来，不然卡片会离开手指 */
  function apply(y: number) {
    const sc = scroller();
    const rolled = sc ? sc.scrollTop - startScroll.current : 0;
    const next = clampDy(rows.current, fromIx.current, y - startY.current + rolled);
    const at = slotOf(rows.current, fromIx.current, next);
    slotIx.current = at;
    setDy(next);
    setSlot(at);
  }

  // 排序中要把页面按住。React 的 onTouchMove 是被动监听，preventDefault 无效，
  // 必须自己挂一个 passive:false 的原生监听，否则手指一动整页就滚走了
  useEffect(() => {
    if (st.phase !== "sorting") return;
    const block = (e: TouchEvent) => e.preventDefault();
    document.addEventListener("touchmove", block, { passive: false });
    return () => document.removeEventListener("touchmove", block);
  }, [st.phase]);

  // 手指贴在表头 / 表尾时，列表自己慢慢滚——长表上够不着的那一段，只能靠这个
  useEffect(() => {
    if (st.phase !== "sorting" || landing) return;
    const sc = scroller();
    if (!sc || typeof requestAnimationFrame !== "function") return;
    let live = true;
    let id = 0;
    const tick = () => {
      if (!live) return;
      const r = sc.getBoundingClientRect();
      const step = edgeScroll(lastY.current, r.top, r.bottom);
      if (step) {
        const was = sc.scrollTop;
        sc.scrollTop = was + step;
        if (sc.scrollTop !== was) apply(lastY.current);
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => {
      live = false;
      cancelAnimationFrame(id);
    };
  }, [st.phase, landing]);

  // 落库那一帧之后就把「不许有过渡」摘掉。两帧之后才摘：第一个 rAF 跑在
  // 「带着新顺序的那次绘制」之前，那会儿摘等于没摘（跟 core/motion 的 hardCutRows 同一个道理）
  useEffect(() => {
    if (!quiet) return;
    const off = () => setQuiet(false);
    if (typeof requestAnimationFrame !== "function") {
      const t = window.setTimeout(off, 0);
      return () => clearTimeout(t);
    }
    const id = requestAnimationFrame(() => requestAnimationFrame(off));
    return () => cancelAnimationFrame(id);
  }, [quiet]);

  useEffect(
    () => () => {
      stopTimer();
      if (land.current !== null) clearTimeout(land.current);
      eater.current?.();
    },
    [],
  );

  const active = st.phase === "sorting" || landing;
  // 让位的行一律挪「被拎起来那张」的高度：抽走它、再插回去，中间那些行挪的就是这么多。
  // 行与行不等高时（清单名长到折行）会差那么一两像素，肉眼看不出来，不值得为它把每行的高度都算一遍
  const rowH = rows.current[fromIx.current]?.height ?? 0;

  return {
    /** 挂在装着这张表的 .mcard 上：量位置、找滚动的那一层，都从它起步 */
    box: (el: HTMLDivElement | null) => {
      boxEl.current = el;
    },
    /** 这张表正被拖着吗。卡片要浮出纸面，装它的盒子这会儿就不能再裁切 */
    active,
    /** 这一行的类名尾巴：拎起来的那张加 lifted，松手飞回格子的那一小段再加 landing */
    cls: (self: string) => (active && st.self === self ? (landing ? " lifted landing" : " lifted") : ""),
    /** 这一行该挪到哪儿。每行各走各的距离，写不进样式表，只能写在行内 */
    style: (self: string): CSSProperties => {
      if (quiet) return { transition: "none" };
      if (!active) return {};
      if (st.self === self) return { transform: `translateY(${Math.round(dy)}px) scale(${LIFT_SCALE})` };
      const k = shiftOf(rows.current.findIndex((r) => r.key === self), fromIx.current, slot);
      return k ? { transform: `translateY(${k * rowH}px)` } : {};
    },
    props: (self: string) => ({
      "data-sort": `${kind}:${self}`,
      onPointerDown: (e: ReactPointerEvent) => {
        if (e.pointerType === "mouse") return; // 鼠标在别处走 HTML5 拖拽那套
        if (landing) return; // 上一张还在落地，别再拎起第二张
        const next = down(st, self, e.clientX, e.clientY);
        if (next === st) return;
        setSt(next);
        // 抓住指针：手指滑出这一行之后还要继续收到 move / up
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        startY.current = e.clientY;
        lastY.current = e.clientY;
        stopTimer();
        timer.current = window.setTimeout(() => {
          timer.current = null;
          if (!measure(self)) return; // 表里就一行，没什么可换的
          const sc = scroller();
          startScroll.current = sc ? sc.scrollTop : 0;
          slotIx.current = fromIx.current;
          setDy(0);
          setSlot(fromIx.current);
          setSt((s) => hold(s));
          // 拎起来了得让手知道。安卓上给一下极轻的震；不支持的设备上这句自己消失
          navigator.vibrate?.(8);
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        if (st.phase === "idle" || landing) return;
        if (st.phase === "waiting") {
          // 还没拎起来就滑 = 在滚列表，整个手势作废（这条分界跟侧栏共用同一处实现）
          const next = move(st, e.clientX, e.clientY, () => null);
          if (next === st) return;
          stopTimer();
          setSt(next);
          return;
        }
        lastY.current = e.clientY;
        apply(e.clientY);
      },
      onPointerUp: () => {
        if (st.phase === "idle" || landing) return;
        stopTimer();
        if (st.phase !== "sorting") {
          setSt(IDLE); // 没按够时长 = 普通点击，交给 onClick
          return;
        }
        // 拖过就吞掉紧跟着那一下 click（空拖也算拖过）：松手不能顺带跳进这一行
        eater.current = eatNextClick();
        const who = st.self as string;
        const at = slotIx.current;
        const moved = at !== fromIx.current;
        const to = moved ? dropKeyOf(rows.current, fromIx.current, at) : null;
        // 先让卡片飞回格子里，再落库。飞完那一刻界面上已经是最终的样子，
        // 所以落库那一帧只是「把位移换成真顺序」，肉眼看不出切换
        setLanding(true);
        setDy(settleDy(rows.current, fromIx.current, at));
        land.current = window.setTimeout(() => {
          land.current = null;
          setQuiet(true);
          setLanding(false);
          setSt(IDLE);
          setDy(0);
          setSlot(-1);
          if (moved) onDrop(who, to);
        }, dur1());
      },
      onPointerCancel: () => {
        // 被系统打断（来电、手势导航、多指）：原样放回去，一个字都不落库
        stopTimer();
        setSt(cancel());
        setDy(0);
        setSlot(-1);
        setLanding(false);
      },
    }),
  };
}
