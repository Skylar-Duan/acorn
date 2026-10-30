// 四象限坐标平面；拖动只预览，松手才调用既有任务动作。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { Priority, Subtask, Task } from "../core/model";
import { formatShort, todayYMD } from "../core/dates";
import { appStore, expandTask, updateSubtask, updateTask, useApp } from "../core/store";
import { syncStore } from "../core/syncCtl";
import { isMobile } from "../core/platform";
import { deadlineX, quadrantAxisTicks, quadrantDragPreview, quadrantPoints, stepQuadrantDate, type QuadrantPoint } from "../core/quadrantLayout";
import MobileHead from "../mobile/MobileHead";
import { openSheet } from "../mobile/sheetStore";
import TaskCard from "../components/TaskCard";
import Icon from "../components/Icon";
import "../styles/quadrant.css";
import "../styles/mobile-pages.css";

type Preview = ReturnType<typeof quadrantDragPreview>;
interface Gesture {
  point: QuadrantPoint;
  pointerId: number | null;
  element: HTMLButtonElement;
  startX: number; startY: number;
  xPct: number; yPct: number;
  moveX: boolean; moveY: boolean;
  active: boolean;
  preview: Preview;
}
const PRIO = ["无", "低", "中", "高"] as const;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function dueLabel(due: string | null): string { return due ? formatShort(due) : "无日期"; }
function liveTarget(point: QuadrantPoint) {
  const state = appStore.getState();
  if (!state.loaded || state.loadError || state.wiped) return null;
  const task = state.data.tasks.find((t) => t.id === point.taskId && !t.deletedAt && !t.done && !t.droppedAt);
  if (!task) return null;
  const sub = point.subId ? task.subtasks.find((s) => s.id === point.subId && !s.deletedAt && !s.done && !s.droppedAt) : null;
  if (point.subId && !sub) return null;
  return { task, sub };
}

export default function QuadrantBoard() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const today = todayYMD();
  const points = useMemo(() => quadrantPoints(data, today), [data.tasks, today]);
  const plot = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const previewElement = useRef<HTMLDivElement>(null);
  const [previewHeight, setPreviewHeight] = useState(140);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const [drag, setDrag] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [locate, setLocate] = useState<{ taskId: string; subId: string | null } | null>(null);
  const [live, setLive] = useState("");
  const [size, setSize] = useState({ width: 900, height: 540 });
  const ticks = useMemo(() => quadrantAxisTicks(today, { compact: isMobile || size.width < 700 }), [today, size.width]);
  const ignoreClick = useRef({ id: "", until: 0 });
  const cancelledPointer = useRef<{ id: string } | null>(null);
  const ignoreContextUntil = useRef(0);
  const cancelRef = useRef<() => void>(() => {});
  const restoreFocus = useRef<HTMLElement | null>(null);

  function clearGesture(cancelled = false) {
    const current = gesture.current;
    gesture.current = null;
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    if (current?.pointerId !== null && current?.element.hasPointerCapture?.(current.pointerId!)) current.element.releasePointerCapture(current.pointerId!);
    setDrag(null);
    if (current && current.pointerId !== null && (current.active || cancelled)) {
      ignoreClick.current = { id: current.point.id, until: Date.now() + 350 };
    }
    if (current?.active) {
      if (cancelled) setLive("已取消调整，任务保持原样");
    }
  }
  cancelRef.current = () => clearGesture(true);

  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const measure = () => { const rect = element.getBoundingClientRect(); setSize({ width: rect.width, height: rect.height }); };
    measure();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }
    const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (isMobile || !expandedId || !detail.current) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = detail.current;
    const frame = requestAnimationFrame(() => {
      const located = modal.querySelector<HTMLElement>(".quad-located textarea");
      (located ?? modal.querySelector<HTMLElement>(".row1 textarea") ?? modal.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
    });
    return () => { cancelAnimationFrame(frame); const previous = restoreFocus.current; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [expandedId]);

  useEffect(() => {
    const key = () => { const session = syncStore.getState().session; return session ? `${session.email}\n${session.token}` : ""; };
    let previous = key();
    const off = syncStore.subscribe(() => { const next = key(); if (next !== previous) { previous = next; cancelRef.current(); } });
    const offData = appStore.subscribe(() => { if (gesture.current && !liveTarget(gesture.current.point)) cancelRef.current(); });
    const cancel = () => cancelRef.current();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    // 多按钮chord不会再次触发pointerdown。捕获mousedown，右键按下那一刻就取消。
    const rightdown = (event: MouseEvent) => {
      if (event.button !== 2 || !gesture.current || gesture.current.pointerId === null) return;
      cancelledPointer.current = { id: gesture.current.point.id };
      ignoreContextUntil.current = Date.now() + 350;
      event.preventDefault(); event.stopPropagation(); cancel();
    };
    const leftup = (event: MouseEvent) => {
      if (!cancelledPointer.current) return;
      if (event.button === 0) ignoreClick.current = { id: cancelledPointer.current.id, until: Date.now() + 350 };
      ignoreContextUntil.current = Date.now() + 350;
      // 左键也可能先松、右键稍后才松；整个chord结束前都屏蔽这次菜单。
      if (event.buttons === 0) cancelledPointer.current = null;
    };
    const contextmenu = (event: MouseEvent) => {
      if (gesture.current && gesture.current.pointerId !== null) { cancelledPointer.current = { id: gesture.current.point.id }; ignoreContextUntil.current = Date.now() + 350; cancel(); }
      if (cancelledPointer.current || Date.now() < ignoreContextUntil.current) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("mousedown", rightdown, true);
    document.addEventListener("mouseup", leftup, true);
    document.addEventListener("contextmenu", contextmenu, true);
    return () => { off(); offData(); window.removeEventListener("blur", cancel); document.removeEventListener("keydown", keydown, true); document.removeEventListener("mousedown", rightdown, true); document.removeEventListener("mouseup", leftup, true); document.removeEventListener("contextmenu", contextmenu, true); if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, []);

  function initial(point: QuadrantPoint, element: HTMLButtonElement, pointerId: number | null, startX = 0, startY = 0): Gesture {
    return { point, element, pointerId, startX, startY, xPct: point.xPct, yPct: point.yPct, moveX: false, moveY: false, active: false,
      preview: quadrantDragPreview(point, point.xPct, point.yPct, today, { moveX: false, moveY: false }) };
  }
  function paint(current: Gesture) {
    gesture.current = current;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; if (gesture.current) setDrag({ ...gesture.current }); });
  }
  function move(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.buttons & 2) { event.preventDefault(); cancelledPointer.current = { id: current.point.id }; ignoreContextUntil.current = Date.now() + 350; clearGesture(true); return; }
    const dx = event.clientX - current.startX, dy = event.clientY - current.startY;
    if (!current.active && Math.hypot(dx, dy) < 5) return;
    event.preventDefault();
    const rect = plot.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    const xPct = clamp(current.point.xPct + dx / rect.width * 100, 0, 100);
    const yPct = clamp(current.point.yPct + dy / rect.height * 100, 0, 100);
    const moveX = Math.abs(dx) >= 4, moveY = Math.abs(dy) >= 4;
    paint({ ...current, active: true, xPct, yPct, moveX, moveY, preview: quadrantDragPreview(current.point, xPct, yPct, today, { moveX, moveY }) });
  }
  function commit(current: Gesture) {
    const target = liveTarget(current.point);
    if (!target) return;
    const preview = current.preview;
    const patch: Partial<Task> & Partial<Subtask> = {};
    if (preview.changedY && preview.priority !== (target.sub?.priority ?? target.task.priority)) patch.priority = preview.priority;
    if (preview.changedX) {
      if (target.sub) {
        const effective = target.sub.due ?? target.task.due;
        if (preview.due === null ? target.sub.due != null : preview.due !== effective) patch.due = preview.due;
      } else if (preview.due !== target.task.due) {
        patch.due = preview.due;
        if (preview.due === null) patch.dueTime = null;
      }
    }
    if (!Object.keys(patch).length) return;
    if (target.sub) updateSubtask(target.task.id, target.sub.id, patch);
    else updateTask(target.task.id, patch);
    setLive(`已调整${current.point.title}，${PRIO[preview.priority]}重要性，${preview.inheritsDue ? "继承母任务日期" : dueLabel(preview.due)}`);
  }
  function open(point: QuadrantPoint) {
    if (Date.now() < ignoreClick.current.until && ignoreClick.current.id === point.id) return;
    if (isMobile) { openSheet({ kind: "task", taskId: point.taskId }); return; }
    setLocate({ taskId: point.taskId, subId: point.subId }); expandTask(point.taskId);
  }
  function keydown(event: ReactKeyboardEvent<HTMLButtonElement>, point: QuadrantPoint) {
    if (event.nativeEvent.isComposing) return;
    let current = gesture.current;
    if (event.key === " " && !current) {
      event.preventDefault(); event.stopPropagation(); current = { ...initial(point, event.currentTarget, null), active: true }; gesture.current = current; setDrag(current);
      setLive("方向键调整：左右改日期，上下改重要性，回车保存，Esc取消"); return;
    }
    if (current?.point.id === point.id && current.pointerId === null) {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(current); clearGesture(); return; }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      let x = current.xPct, y = current.yPct, moveX = current.moveX, moveY = current.moveY;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") { const priority = clamp(current.preview.priority + (event.key === "ArrowUp" ? 1 : -1), 0, 3) as Priority; y = (3 - priority) * 25 + 12.5; moveY = true; }
      else if (event.key === "Home" || event.key === "End") { x = event.key === "Home" ? 4 : deadlineX(today, today); moveX = true; }
      else {
        const due = current.preview.due ?? current.point.due;
        const next = due ? stepQuadrantDate(due, event.key === "ArrowRight" ? -1 : 1) : today;
        x = deadlineX(next, today);
        moveX = true;
      }
      current = { ...current, xPct: x, yPct: y, moveX, moveY, preview: quadrantDragPreview(current.point, x, y, today, { moveX, moveY }) };
      gesture.current = current; setDrag(current); setLive(`${PRIO[current.preview.priority]}重要性，${dueLabel(current.preview.due)}`); return;
    }
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); open(point); }
  }

  const shown = drag?.point ?? points.find((point) => point.id === (hover ?? focus));
  const preview = drag?.preview;
  useLayoutEffect(() => {
    const element = previewElement.current;
    if (!element) return;
    const measure = () => { const height = element.getBoundingClientRect().height; if (height > 0) setPreviewHeight(height); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element); return () => observer?.disconnect();
  }, [shown?.id, !!drag, preview?.due, preview?.priority, preview?.inheritsDue]);
  const activeTask = expandedId ? data.tasks.find((task) => task.id === expandedId && !task.deletedAt) : null;
  const plotRect = plot.current?.getBoundingClientRect();
  const shownX = drag?.xPct ?? shown?.xPct ?? 0, shownY = drag?.yPct ?? shown?.yPct ?? 0;
  const anchorY = (plotRect?.top ?? 0) + shownY / 100 * size.height;
  const above = anchorY - previewHeight - 14;
  const previewTop = above >= 12 ? above : anchorY + 14;
  const previewStyle = { left: clamp((plotRect?.left ?? 0) + shownX / 100 * size.width - 142, 12, Math.max(12, window.innerWidth - 296)), top: clamp(previewTop, 12, Math.max(12, window.innerHeight - previewHeight - 12)) };
  const board = <div className="view-body quad-body quad-coordinate">
    <div className="quad-legend"><span><Icon name="grid" size={14} />{points.length} 条待办</span>{!isMobile && <span>拖动安排 · 空格键调整</span>}</div>
    <div className={`quad-chart${drag ? " quad-dragging" : ""}`}>
      <div className="quad-y-title">重要性 <Icon name="arrowUp" size={13} /></div>
      <div className="quad-plot" ref={plot} role="group" aria-label="重要性与截止日期坐标平面">
        <div className="quad-region quad-in"><span>重要不紧急</span></div><div className="quad-region quad-iu"><span>重要且紧急</span></div>
        <div className="quad-region quad-nn"><span>不重要不紧急</span></div><div className="quad-region quad-nu"><span>紧急不重要</span></div>
        <div className="quad-axis quad-axis-x" /><div className="quad-axis quad-axis-y" />
        {[3, 2, 1, 0].map((priority) => <span className="quad-y-tick" key={priority} style={{ top: `${(3 - priority) * 25 + 12.5}%` }}>{PRIO[priority]}</span>)}
        <div className="quad-undated-guide" aria-hidden="true" />
        {points.map((point) => {
          const active = drag?.point.id === point.id;
          return <button type="button" key={point.id} className={`quad-point p${active ? drag.preview.priority : point.priority}${point.subId ? " quad-sub-point" : ""}${point.dateKind === "overdue" ? " overdue" : ""}${active ? " moving" : ""}`}
            data-quad-point={point.id} data-task-id={point.taskId} data-subtask-id={point.subId ?? undefined}
            aria-label={`${point.parentTitle ? `${point.parentTitle} › ` : ""}${point.title}，${PRIO[point.priority]}重要性，${dueLabel(point.due)}。回车打开，空格键调整`}
            style={{ left: `${active ? drag.xPct : point.xPct}%`, top: `${active ? drag.yPct : point.yPct}%` }}
            onFocus={() => setFocus(point.id)} onBlur={() => { setFocus(null); if (gesture.current?.pointerId === null) clearGesture(true); }}
            onPointerEnter={() => { if (!gesture.current) setHover(point.id); }} onPointerLeave={() => { if (!gesture.current) setHover(null); }}
            onPointerDown={(event) => { if (event.button !== 0 || gesture.current) return; event.stopPropagation(); cancelledPointer.current = null; ignoreClick.current = { id: "", until: 0 }; gesture.current = initial(point, event.currentTarget, event.pointerId, event.clientX, event.clientY); event.currentTarget.setPointerCapture?.(event.pointerId); }}
            onPointerMove={move} onPointerCancel={() => clearGesture(true)} onLostPointerCapture={() => { if (gesture.current?.pointerId !== null) clearGesture(true); }}
            onPointerUp={(event) => { const current = gesture.current; if (!current || current.pointerId !== event.pointerId) return; if (current.active) { event.preventDefault(); commit(current); } clearGesture(); }}
            onClick={() => open(point)} onKeyDown={(event) => keydown(event, point)}><span /></button>;
        })}
        {!points.length && <div className="quad-empty"><Icon name="checkCircle" size={26} /><span>暂时没有待办</span></div>}
      </div>
      <div className="quad-x-ticks">{ticks.map((tick) => <span key={tick.key} style={{ left: `${tick.xPct}%` }}>{tick.label}</span>)}</div>
      <div className="quad-x-title">{isMobile ? "截止" : "截止越近，越靠右"} <Icon name="arrowRight" size={13} /></div>
    </div>
    {!isMobile && <p className="quad-footnote">有待办步骤的任务只显示子点；无日期在最左，逾期在最右。</p>}
    <span className="quad-live" role="status" aria-live="polite">{live}</span>
    {shown && !activeTask && createPortal(<div ref={previewElement} className={`quad-preview${drag ? " adjusting" : ""}`} style={previewStyle} data-quad-preview>
      {shown.parentTitle && <div className="quad-preview-parent"><Icon name="folder" size={13} />{shown.parentTitle}</div>}
      <strong>{shown.title || "未命名任务"}</strong>
      <div className="quad-preview-values"><span><Icon name="flag" size={13} />{PRIO[shown.priority]}{preview && <><Icon name="arrowRight" size={12} /><b>{PRIO[preview.priority]}</b></>}</span>
      <span><Icon name="calendar" size={13} />{dueLabel(shown.due)}{preview && <><Icon name="arrowRight" size={12} /><b>{preview.inheritsDue ? `继承母任务日期${preview.effectiveDue ? ` · ${dueLabel(preview.effectiveDue)}` : ""}` : dueLabel(preview.due)}</b></>}</span></div>
      {drag && <small>{drag.pointerId === null ? "回车保存 · Esc取消" : "松手保存 · 右键取消"}</small>}
    </div>, document.body)}
    {!isMobile && activeTask && createPortal(<div className="quad-detail-layer" data-quad-detail onMouseDown={(event) => { if (event.target === event.currentTarget) expandTask(null); }}
      onKeyDownCapture={(event) => {
        if (event.key !== "Tab" || document.querySelector("[data-image-dialog], [data-category-dialog]")) return;
        const roots: Element[] = detail.current ? [detail.current] : [];
        for (const popup of document.querySelectorAll('[data-task-popover]:not(.leaving)')) if (popup.getAttribute("data-task-popover") === activeTask.id) roots.push(popup);
        const nodes = roots.flatMap((root) => [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')]).filter((node) => node.getClientRects().length > 0);
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        if (nodes.length && ((event.shiftKey && index <= 0) || (!event.shiftKey && (index < 0 || index === nodes.length - 1)))) { event.preventDefault(); nodes[event.shiftKey ? nodes.length - 1 : 0].focus(); }
      }}>
      <div className="quad-detail" ref={detail} role="dialog" aria-modal="true" aria-label="任务详情"><button type="button" className="quad-detail-close" aria-label="关闭任务详情" onClick={() => expandTask(null)}><Icon name="close" size={19} /></button>
        <TaskCard key={activeTask.id} task={activeTask} detailMode locateSubId={locate?.taskId === activeTask.id ? locate.subId ?? undefined : undefined} />
      </div>
    </div>, document.body)}
  </div>;
  if (isMobile) return <section className="main"><MobileHead title="四象限" search={false} />{board}</section>;
  return board;
}
