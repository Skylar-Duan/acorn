// 任务行：一行看清一件事。点击行展开为 TaskCard；勾选有停留动画。
// sub 非 null 时是「子任务行」——显示 母任务 › 子任务，勾选只勾子任务（日期视图里带自己日期的子任务单独成行）。
import { useRef, useState } from "react";
import type { Subtask, Task } from "../core/model";
import { formatShort, todayYMD, cmpYMD } from "../core/dates";
import { describeRepeat } from "../core/recur";
import {
  completeTask, uncompleteTask, expandTask, useApp, setSelection,
  toggleSubtask, openCtxMenu,
} from "../core/store";

export function WhoBadge({ who }: { who: string }) {
  return (
    <span className="who-badge" title={`需求方：${who}`}>
      <span className="avatar">{who.slice(0, 1)}</span>
      {who}
    </span>
  );
}

export interface TaskRowProps {
  task: Task;
  /** 子任务行：勾选/日期/优先级都取子任务自己的 */
  sub?: Subtask | null;
  /** 本视图内可见任务的有序 id 列表（shift 连选用） */
  orderedIds: string[];
  /** 隐藏所属清单标签（清单视图里冗余） */
  hideList?: boolean;
  /** 完成后是否播放淡出（今天/清单视图 true；日志视图 false） */
  fadeOnDone?: boolean;
}

export default function TaskRow({ task, sub = null, orderedIds, hideList, fadeOnDone = true }: TaskRowProps) {
  const lists = useApp((s) => s.data.lists);
  const selected = useApp((s) => s.ui.selectedIds.includes(task.id));
  const selectedIds = useApp((s) => s.ui.selectedIds);
  const [leaving, setLeaving] = useState(false);
  const anchor = useRef<string | null>(null);

  const list = task.listId ? lists.find((l) => l.id === task.listId) : null;
  const today = todayYMD();
  const due = sub ? sub.due ?? null : task.due;
  const dueTime = sub ? sub.dueTime ?? null : task.dueTime;
  const priority = sub ? sub.priority ?? task.priority : task.priority;
  const isDone = sub ? sub.done : task.done;
  const overdue = !isDone && !!due && cmpYMD(due, today) < 0;
  const subDone = task.subtasks.filter((s) => s.done).length;

  function onCheck(e: React.MouseEvent) {
    e.stopPropagation();
    if (leaving) return; // 完成动画播放中，重复点击不能把循环任务推进两轮
    if (sub) {
      if (sub.done) {
        toggleSubtask(task.id, sub.id);
        return;
      }
      if (fadeOnDone) {
        setLeaving(true);
        setTimeout(() => {
          toggleSubtask(task.id, sub.id);
          setLeaving(false);
        }, 950);
      } else {
        toggleSubtask(task.id, sub.id);
      }
      return;
    }
    if (task.done) {
      uncompleteTask(task.id);
      return;
    }
    if (fadeOnDone) {
      setLeaving(true);
      // 动画演完再真正完成（store 变更会让行从列表消失）
      setTimeout(() => {
        completeTask(task.id);
        setLeaving(false);
      }, 950);
    } else {
      completeTask(task.id);
    }
  }

  function onRowClick(e: React.MouseEvent) {
    if (!sub && (e.ctrlKey || e.metaKey)) {
      const next = selected ? selectedIds.filter((i) => i !== task.id) : [...selectedIds, task.id];
      anchor.current = task.id;
      setSelection(next);
      return;
    }
    if (!sub && e.shiftKey && selectedIds.length) {
      const last = anchor.current ?? selectedIds[selectedIds.length - 1];
      const a = orderedIds.indexOf(last);
      const b = orderedIds.indexOf(task.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelection(orderedIds.slice(lo, hi + 1));
        return;
      }
    }
    anchor.current = task.id;
    expandTask(task.id);
  }

  function onCtx(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // 右键落在多选集合上时保留多选，否则只对当前行
    const ids = selected && selectedIds.length > 1 ? selectedIds : [task.id];
    openCtxMenu(e.clientX, e.clientY, ids);
  }

  const willDone = isDone || leaving;

  return (
    <div
      className={`task-row${willDone ? " done-row" : ""}${leaving ? " leaving" : ""}${selected && !sub ? " selected" : ""}`}
      onClick={onRowClick}
      onContextMenu={onCtx}
      draggable={!sub}
      onDragStart={(e) => {
        if (sub) return;
        e.dataTransfer.setData("text/acorn-task", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      data-task-id={sub ? undefined : task.id}
    >
      <span className={`flag p${priority}`} />
      <button className={`cb${willDone ? " done" : ""}`} onClick={onCheck} title={isDone ? "标记未完成" : "完成"} />
      {sub ? (
        <span className="title">
          <span style={{ color: "var(--ink-3)" }}>{task.title || "（未命名）"} › </span>
          {sub.title || "（未命名）"}
        </span>
      ) : (
        <span className="title">{task.title || "（未命名）"}</span>
      )}
      <span className="meta" onClick={(e) => e.stopPropagation()}>
        {task.who && <WhoBadge who={task.who} />}
        {!sub && task.tags.map((t) => (
          <span key={t}># {t}</span>
        ))}
        {!hideList && list && (
          <span className="list-tag">
            <span className="dot" style={{ width: 7, height: 7, borderRadius: 99, background: `var(--list-${list.color})`, display: "inline-block" }} />
            {list.name}
          </span>
        )}
        {!sub && task.subtasks.length > 0 && (
          <span>
            {subDone}/{task.subtasks.length}
          </span>
        )}
        {!sub && task.repeat && <span title={describeRepeat(task.repeat)}>↻</span>}
        {!sub && task.postponeCount >= 2 && !task.done && (
          <span className="warn" title={`已顺延 ${task.postponeCount} 次`}>
            顺延×{task.postponeCount}
          </span>
        )}
        {due && (
          <span className={overdue ? "overdue" : undefined}>
            {formatShort(due)}
            {dueTime ? ` ${dueTime}` : ""}
          </span>
        )}
      </span>
    </div>
  );
}
