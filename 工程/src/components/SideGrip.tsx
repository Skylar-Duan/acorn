import { useRef } from "react";
import {
  SIDE_W_DEFAULT, SIDE_W_MAX, SIDE_W_MIN, applySideW, clampSideW, saveSideW,
} from "../core/sideWidth";

/** 侧栏右边缘那条竖向把手：按住左右拖改侧栏宽度，双击恢复默认。
 *
 *  放在侧栏**外面**、position:fixed 贴在 `--side-w` 那条边线上（样式见 app.css 侧栏一节）：
 *  .side 自己 overflow-y:auto，放里面会跟着滚走。它只盖住侧栏那 1px 边线再往右几像素，
 *  不压侧栏的滚动条。窄屏抽屉模式由 CSS 藏掉；手机端 App.tsx 根本不渲染它。
 *
 *  拖动过程中只改 CSS 变量（applySideW），松手才写一次本机存储 */
export function SideGrip() {
  const drag = useRef<{ x: number; w: number; cur: number } | null>(null);

  const currentW = () => {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--side-w"));
    return clampSideW(Number.isFinite(v) ? v : SIDE_W_DEFAULT);
  };

  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove("side-resizing");
    saveSideW(d.cur);
  };

  return (
    <div
      className="side-grip"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={SIDE_W_MIN}
      aria-valuemax={SIDE_W_MAX}
      title="拖动调整宽度，双击恢复"
      tabIndex={-1}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // 别让按下这一下去选中侧栏和正文里的字
        const w = currentW();
        drag.current = { x: e.clientX, w, cur: w };
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add("side-resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.cur = clampSideW(d.w + e.clientX - d.x);
        applySideW(d.cur);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => {
        applySideW(SIDE_W_DEFAULT);
        saveSideW(SIDE_W_DEFAULT);
      }}
    />
  );
}
