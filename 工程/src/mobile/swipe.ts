// 一行事的左右滑动（v1.11.0 手机端）：右滑 = 完成，左滑 = 露出 推明天 / 放弃 / 删除。
//
// 只用 Pointer Events，不用 touch 专有事件——鼠标拖、触摸、笔一套代码。
// 三条规矩，都是用户能感觉到的：
//   1. **先判断意图再接管**：手指动了 8px 以上、且横向多于纵向才算「要滑」；纵向的交给列表滚动。
//      判成滑之后 setPointerCapture，指针移出这一行也不丢。
//   2. **右滑不「打开」，松手即生效**：拉过阈值松手就完成，没过就弹回。完成是可撤销的，所以敢这么干脆。
//   3. **左滑「打开」**：停在露出动作条的位置，点动作、点别处、再滑回去都能收。
//      不做「拉到底自动删除」——删除得点一下，别让手一抖就删了。
//
// 只管状态和手势，不画东西。画的那层（动作条、颜色）由 MobileRow 负责。

import { useCallback, useEffect, useRef, useState } from "react";

export interface SwipeOptions {
  /** 右滑过阈值松手时调（完成）。不给就不允许右滑 */
  onRight?: () => void;
  /** 右滑多远算「过了」 */
  rightPx?: number;
  /** 左滑露出的动作条有多宽。不给就不允许左滑 */
  leftWidth?: number;
  disabled?: boolean;
}

export type SwipeState = "idle" | "dragging" | "openLeft" | "firing";

export interface SwipeBind {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onClickCapture: (e: React.MouseEvent) => void;
}

export interface SwipeRow {
  /** 当前横向位移（px），正数向右 */
  dx: number;
  state: SwipeState;
  /** 挂到那一行的根元素上 */
  bind: SwipeBind;
  /** 把左边打开的动作条收回去 */
  close: () => void;
  /** 右滑进度 0..1（给完成那块底色做渐显） */
  rightProgress: number;
}

/** 动了多少才算「有意图」 */
const INTENT_PX = 8;
/** 右滑最远能拉多远（超过后有阻力，越拉越慢） */
const RIGHT_MAX = 140;

export function useSwipeRow(opts: SwipeOptions): SwipeRow {
  const { onRight, rightPx = 72, leftWidth = 0, disabled = false } = opts;
  const [dx, setDx] = useState(0);
  const [state, setState] = useState<SwipeState>("idle");
  const start = useRef<{ x: number; y: number; base: number; captured: boolean; id: number } | null>(null);
  /** 这一次按下有没有真的滑过：滑过的松手不许再触发 click（不然松手那一下会把卡片点开） */
  const swiped = useRef(false);
  const onRightRef = useRef(onRight);
  onRightRef.current = onRight;

  const close = useCallback(() => {
    setDx(0);
    setState("idle");
  }, []);

  // 左边打开着时，点到这一行之外的任何地方就收回去（跟右键菜单「点外面就关」一个道理）
  useEffect(() => {
    if (state !== "openLeft") return;
    const onDoc = (e: PointerEvent) => {
      // **按的正是刚露出来的那两颗动作键就别抢**：这条监听在捕获阶段、跑在按钮前面，
      // 收回去那一拍行本体（.swipe-body 带底色）会滑过来盖住按钮，抬手那一下的 click
      // 就落到行本体上——用户按的「删除」当场变成「点开这一行」。按钮自己会收，不用这儿代劳
      if ((e.target as HTMLElement | null)?.closest?.(".swipe-act")) return;
      close();
    };
    // 延一拍再挂：打开它的那次 pointerup 还在冒泡。
    // 不用 { once: true }：上面那条放行是「这一下不算」，监听得留着等下一次真的点在别处
    const id = setTimeout(() => document.addEventListener("pointerdown", onDoc, true), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", onDoc, true);
    };
  }, [state, close]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled || state === "firing") return;
      // 只认主按键 / 手指；右键留给别的
      if (e.pointerType === "mouse" && e.button !== 0) return;
      start.current = { x: e.clientX, y: e.clientY, base: dx, captured: false, id: e.pointerId };
      swiped.current = false;
    },
    [disabled, dx, state],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = start.current;
      if (!s) return;
      const mx = e.clientX - s.x;
      const my = e.clientY - s.y;
      if (!s.captured) {
        if (Math.abs(mx) < INTENT_PX && Math.abs(my) < INTENT_PX) return;
        // 纵向为主：这是在滚列表，放手
        if (Math.abs(my) >= Math.abs(mx)) {
          start.current = null;
          return;
        }
        s.captured = true;
        swiped.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(s.id);
        setState("dragging");
      }
      let next = s.base + mx;
      // 不允许的方向直接钉死在 0
      if (next > 0 && !onRightRef.current) next = 0;
      if (next < 0 && leftWidth <= 0) next = 0;
      // 右滑越过最远处开始有阻力
      if (next > RIGHT_MAX) next = RIGHT_MAX + (next - RIGHT_MAX) * 0.25;
      // 左滑越过动作条宽度也有阻力：那儿没有更多东西
      if (next < -leftWidth) next = -leftWidth + (next + leftWidth) * 0.25;
      setDx(next);
    },
    [leftWidth],
  );

  const settle = useCallback(() => {
    const s = start.current;
    start.current = null;
    if (!s || !s.captured) return;
    if (dx >= rightPx && onRightRef.current) {
      // 过阈值：先把行推出去演完，再真的完成——动作要跟手，落库紧随其后
      setState("firing");
      setDx(RIGHT_MAX + 60);
      const fn = onRightRef.current;
      setTimeout(() => {
        fn();
        setDx(0);
        setState("idle");
      }, durMs());
      return;
    }
    if (leftWidth > 0 && dx <= -leftWidth / 2) {
      setDx(-leftWidth);
      setState("openLeft");
      return;
    }
    close();
  }, [dx, rightPx, leftWidth, close]);

  const onPointerUp = useCallback(() => settle(), [settle]);
  const onPointerCancel = useCallback(() => {
    start.current = null;
    if (state === "dragging") close();
  }, [state, close]);

  // 松手那一下的 click：滑过就吞掉，没滑过照常（点一行 = 点开）
  const onClickCapture = useCallback(
    (e: React.MouseEvent) => {
      if (swiped.current) {
        e.stopPropagation();
        e.preventDefault();
        swiped.current = false;
      } else if (state === "openLeft") {
        // 动作条开着时点行本体 = 收回去，不当成「点开」
        e.stopPropagation();
        e.preventDefault();
        close();
      }
    },
    [state, close],
  );

  return {
    dx,
    state,
    bind: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture },
    close,
    rightProgress: Math.max(0, Math.min(1, dx / rightPx)),
  };
}

/** 跟 Sheet.tsx 同一个取法：动画时长只认 base.css 的 --dur-2 */
function durMs(): number {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--dur-2").trim();
    if (v.endsWith("ms")) return parseFloat(v) || 180;
    if (v.endsWith("s")) return (parseFloat(v) || 0.18) * 1000;
  } catch {
    /* jsdom */
  }
  return 180;
}
