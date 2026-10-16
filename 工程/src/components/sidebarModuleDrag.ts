import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SIDEBAR_MODULE_MIME } from "../core/sidebar";

/** 模块排序和任务/组内排序使用不同类型，接收方只处理自己的拖放。 */
export function useSidebarModuleDrag(onMove: (from: string, to: string | null) => void) {
  const [over, setOver] = useState<string | null>(null);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const [floating, setFloating] = useState<{ id: string; x: number; y: number; width: number; height: number } | null>(null);
  const moved = useRef(false);
  const moveRef = useRef(onMove); moveRef.current = onMove;
  const boxes = useRef(new Map<string, DOMRect>());
  const drag = useRef<{ id: string; pointer: number; startX: number; startY: number; offsetY: number; box: DOMRect; nav: HTMLElement; active: boolean; order: string[]; to: string | null } | null>(null);
  useLayoutEffect(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>(".side [data-sidebar-module]")];
    const next = new Map(nodes.map((el) => [el.dataset.sidebarModule!, el.getBoundingClientRect()]));
    if (drag.current?.active && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      for (const el of nodes) {
        const old = boxes.current.get(el.dataset.sidebarModule!); const fresh = next.get(el.dataset.sidebarModule!);
        if (old && fresh && old.top !== fresh.top && el.dataset.sidebarModule !== drag.current.id) el.animate?.([{ transform: `translateY(${old.top - fresh.top}px)` }, { transform: "translateY(0)" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    }
    boxes.current = next;
  }, [previewOrder]);
  useEffect(() => {
    function finish(commit: boolean) {
      const current = drag.current; if (!current) return;
      drag.current = null;
      if (commit && current.active) moveRef.current(current.id, current.to);
      setPreviewOrder(null); setFloating(null); setOver(null);
      document.body.classList.remove("sidebar-module-dragging");
      if (current.nav.hasPointerCapture?.(current.pointer)) current.nav.releasePointerCapture(current.pointer);
      setTimeout(() => { moved.current = false; }, 0);
    }
    function pointerMove(e: PointerEvent) {
      const current = drag.current; if (!current || e.pointerId !== current.pointer) return;
      if (!current.active && Math.hypot(e.clientX - current.startX, e.clientY - current.startY) < 5) return;
      if (!current.active) {
        // 过拖动阈值才捕获；普通点击仍把 pointerup/click 交给原入口。
        try { current.nav.setPointerCapture?.(current.pointer); } catch { /* 指针已取消时下一事件回滚。 */ }
      }
      current.active = true; moved.current = true; e.preventDefault();
      document.body.classList.add("sidebar-module-dragging");
      const navBox = current.nav.getBoundingClientRect();
      if (e.clientY > navBox.bottom - 28) current.nav.scrollTop += 12;
      else if (e.clientY < navBox.top + 28) current.nav.scrollTop -= 12;
      const rows = [...current.nav.querySelectorAll<HTMLElement>("[data-sidebar-module]")].filter((el) => el.dataset.sidebarModule !== current.id);
      const before = rows.find((el) => { const b = el.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
      current.to = before?.dataset.sidebarModule ?? null;
      const order = rows.map((el) => el.dataset.sidebarModule!);
      order.splice(current.to ? order.indexOf(current.to) : order.length, 0, current.id);
      current.order = order;
      setPreviewOrder((old) => old?.join("|") === order.join("|") ? old : order);
      setFloating({ id: current.id, x: current.box.left, y: e.clientY - current.offsetY, width: current.box.width, height: current.box.height });
    }
    function pointerUp(e: PointerEvent) {
      const current = drag.current; if (!current || e.pointerId !== current.pointer) return;
      const box = current.nav.getBoundingClientRect();
      finish(e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom);
    }
    const cancel = (e: PointerEvent) => { if (e.pointerId === drag.current?.pointer) finish(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && drag.current) { e.preventDefault(); e.stopImmediatePropagation(); finish(false); } };
    const blur = () => finish(false);
    window.addEventListener("pointermove", pointerMove, { passive: false }); window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", cancel); window.addEventListener("lostpointercapture", cancel); window.addEventListener("keydown", escape, true); window.addEventListener("blur", blur);
    return () => { finish(false); window.removeEventListener("pointermove", pointerMove); window.removeEventListener("pointerup", pointerUp); window.removeEventListener("pointercancel", cancel); window.removeEventListener("lostpointercapture", cancel); window.removeEventListener("keydown", escape, true); window.removeEventListener("blur", blur); };
  }, []);
  return {
    over, previewOrder, floating,
    swallowClick: () => { const value = moved.current; moved.current = false; return value; },
    source: (id: string) => ({
      draggable: false,
      onDragStart: (e: React.DragEvent) => { e.preventDefault(); },
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.button !== 0 || (e.target as Element).closest("button,input,a,select,textarea")) return;
        const nav = e.currentTarget.closest("nav"); if (!nav) return;
        const box = e.currentTarget.getBoundingClientRect();
        drag.current = { id, pointer: e.pointerId, startX: e.clientX, startY: e.clientY, offsetY: e.clientY - box.top, box, nav, active: false, order: [], to: id };
      },
    }),
    target: (id: string | null, after?: string | null) => ({
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(SIDEBAR_MODULE_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        const box = e.currentTarget.getBoundingClientRect();
        const target = after !== undefined && box.height > 0 && e.clientY > box.top + box.height / 2 ? after : id;
        setOver(target ?? "end");
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setOver(null);
      },
      onDrop: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(SIDEBAR_MODULE_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        const from = e.dataTransfer.getData(SIDEBAR_MODULE_MIME);
        setOver(null);
        const box = e.currentTarget.getBoundingClientRect();
        const target = after !== undefined && box.height > 0 && e.clientY > box.top + box.height / 2 ? after : id;
        if (from) onMove(from, target);
      },
    }),
  };
}
