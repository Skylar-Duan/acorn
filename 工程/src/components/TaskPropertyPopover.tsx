import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** 锚点下方优先；靠边时向内、向上展开，菜单内部自行滚动。 */
export function taskPopoverPosition(anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const gap = 8;
  const maxHeight = Math.max(0, viewportHeight - gap * 2);
  const h = Math.min(height, maxHeight);
  const left = Math.max(gap, Math.min(anchor.left, viewportWidth - width - gap));
  const below = viewportHeight - anchor.bottom - gap * 2;
  const above = anchor.top - gap * 2;
  const top = below >= h || below >= above ? anchor.bottom + gap : anchor.top - h - gap;
  return { left, top: Math.max(gap, Math.min(top, viewportHeight - h - gap)), maxHeight };
}

export default function TaskPropertyPopover({ anchor, owner, qaOwner, leaving, children }: {
  anchor: HTMLElement | null;
  owner?: string;
  qaOwner?: string;
  leaving?: boolean;
  children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof taskPopoverPosition> | null>(null);
  useLayoutEffect(() => {
    const el = element.current;
    if (!el || !anchor) return;
    const place = () => {
      const next = taskPopoverPosition(anchor.getBoundingClientRect(), el.offsetWidth, el.scrollHeight, window.innerWidth, window.innerHeight);
      setPosition((old) => old && old.left === next.left && old.top === next.top && old.maxHeight === next.maxHeight ? old : next);
    };
    place();
    // Portal 不在触发按钮后面的 DOM 顺序里。若焦点还在入口，直接送进菜单；
    // who/tag 输入自身已有 autoFocus 时保留它，不抢回第一个选项。
    if (document.activeElement === anchor) {
      el.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')?.focus({ preventScroll: true });
    }
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
      if (el.contains(document.activeElement) && anchor.isConnected) anchor.focus({ preventScroll: true });
    };
  }, [anchor]);
  return createPortal(<div ref={element} className={`popmenu task-property-popover${leaving ? " leaving" : ""}`}
    data-task-popover={owner} data-qa-popover={qaOwner}
    style={{ position: "fixed", ...position, ...(!position ? { visibility: "hidden" } : {}) }}>
    {children}
  </div>, document.body);
}
