import { useRef, useState } from "react";
import { SIDEBAR_MODULE_MIME } from "../core/sidebar";

/** 模块排序和任务/组内排序使用不同类型，接收方只处理自己的拖放。 */
export function useSidebarModuleDrag(onMove: (from: string, to: string | null) => void) {
  const [over, setOver] = useState<string | null>(null);
  const moved = useRef(false);
  return {
    over,
    swallowClick: () => { const value = moved.current; moved.current = false; return value; },
    source: (id: string) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.stopPropagation();
        e.dataTransfer.setData(SIDEBAR_MODULE_MIME, id);
        e.dataTransfer.effectAllowed = "move";
        moved.current = true;
      },
      onDragEnd: () => { setOver(null); setTimeout(() => { moved.current = false; }, 0); },
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
