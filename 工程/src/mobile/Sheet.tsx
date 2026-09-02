// 底部抽屉（bottom sheet）——手机端所有「从底下抽出一张纸」的共用外壳（v1.11.0）。
//
// 只做三件事：遮罩 + 纸 + 手势。纸里装什么由调用方决定。
//   · 顶上那根短横是拖拽把手：**只能上下拖**，往下拖过阈值就收掉，往上拖（expandable 时）到全屏。
//     绝不响应左右——用户 2026-09-02 特别点名「左右一定不能滑动」。
//   · 点遮罩、按 Esc 都收掉。
//   · 进出场走 base.css 的 --dur-2 / --ease（motion.test 不许写字面时长）。
//
// 用 portal 挂到 body：抽屉必须盖在整个壳子之上，而手机壳子里有 transform（底部导航、滑动行），
// 会把 fixed 定位关进自己的盒子里——侧栏抽屉那次已经踩过（ChangelogDialog 头注释）。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "../styles/mobile.css";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 纸的高度：auto = 内容多高就多高（上限 88dvh）；full = 一上来就顶到安全区下面 */
  size?: "auto" | "full";
  /** 允许往上拖成全屏（任务详情用；动作单这类短的不用） */
  expandable?: boolean;
  /** 额外的类名，给调用方挂自己的样式 */
  className?: string;
  /** 无障碍标题 */
  label?: string;
}

/** 拖多远算「要关」。太小会误关，太大关不动 */
const CLOSE_PX = 90;
/** 拖多远算「要放大」 */
const EXPAND_PX = 60;

export default function Sheet({ open, onClose, children, size = "auto", expandable = false, className, label }: SheetProps) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const [full, setFull] = useState(size === "full");
  /** 手指正在拖时纸往下偏了多少（只记向下；向上由 full 状态表达） */
  const [dy, setDy] = useState(0);
  const drag = useRef<{ y0: number; moved: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 进场：先挂到树上（translateY(100%)），下一帧加 .in 让它滑上来。
  // 退场：先去掉 .in 演完滑下去，再从树上摘掉
  useEffect(() => {
    if (open) {
      if (timer.current) clearTimeout(timer.current);
      setMounted(true);
      setFull(size === "full");
      setDy(0);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    timer.current = setTimeout(() => setMounted(false), durMs());
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, size]);

  // Esc 收掉（外接键盘 / 桌面窗口拖窄时也能用）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!mounted) return null;

  function onDown(e: React.PointerEvent) {
    drag.current = { y0: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const d = e.clientY - drag.current.y0;
    if (Math.abs(d) > 4) drag.current.moved = true;
    if (d > 0) setDy(d);
    else if (expandable && -d > EXPAND_PX) setFull(true);
  }
  function onUp() {
    if (!drag.current) return;
    const d = dy;
    drag.current = null;
    setDy(0);
    if (d > CLOSE_PX) onClose();
  }

  const style = dy > 0 ? { transform: `translateY(${dy}px)`, transition: "none" } : undefined;

  return createPortal(
    <div className={`msheet-back${shown ? " in" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={`msheet${shown ? " in" : ""}${full ? " full" : ""}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={style}
      >
        {/* 把手区域略高于那根短横本身，手指好按；只监听指针的纵向位移 */}
        <div className="msheet-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <span className="msheet-bar" aria-hidden />
        </div>
        <div className="msheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** 退场要等多久才能摘树：读 base.css 的 --dur-2，跟 CSS 同源（core/motion.ts 同一套做法） */
function durMs(): number {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--dur-2").trim();
    if (v.endsWith("ms")) return parseFloat(v) || 180;
    if (v.endsWith("s")) return (parseFloat(v) || 0.18) * 1000;
  } catch {
    /* jsdom 没有这个变量 */
  }
  return 180;
}
