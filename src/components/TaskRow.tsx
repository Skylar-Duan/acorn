// 任务行：一行看清一件事。点击行展开为 TaskCard；勾选有停留动画。
// sub 非 null 时是「子任务行」——显示 母任务 › 子任务，勾选只勾子任务。
// 有未完成子任务的任务在日期/总览视图里被分拆成若干子任务行（母任务行收起），
// 日期/重要性没单独设的子任务显示的是继承自母任务的那份（口径统一走 store 的 row* 系列）。
import { useRef, useState } from "react";
import type { Subtask, Task } from "../core/model";
import { formatShort, todayYMD, cmpYMD } from "../core/dates";
import { describeRepeat } from "../core/recur";
import {
  completeTask, uncompleteTask, expandTask, useApp, setSelection,
  updateSubtask, openCtxMenu, rowDue, rowTime, rowPriority,
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
  /** 紧挨着上一行、属于同一件事的子任务行：需求方/清单只由这一束的头一行交代，不逐行重复 */
  bundled?: boolean;
  /** 完成后是否播放淡出（今天/清单视图 true；日志视图 false） */
  fadeOnDone?: boolean;
}

export default function TaskRow({ task, sub = null, orderedIds, hideList, bundled, fadeOnDone = true }: TaskRowProps) {
  const lists = useApp((s) => s.data.lists);
  const selected = useApp((s) => s.ui.selectedIds.includes(task.id));
  const selectedIds = useApp((s) => s.ui.selectedIds);
  const [leaving, setLeaving] = useState(false);
  const anchor = useRef<string | null>(null);

  const list = task.listId ? lists.find((l) => l.id === task.listId) : null;
  const today = todayYMD();
  const row = { task, sub };
  const due = rowDue(row);
  const dueTime = rowTime(row);
  const priority = rowPriority(row);
  // 子任务没单独设日期/重要性时，这行显示的是母任务那份——改母任务会连带动，鼠标停上去说明白
  const dueInherited = !!sub && sub.due == null && task.due != null;
  const prioInherited = !!sub && sub.priority == null;
  const isDone = sub ? sub.done : task.done;
  const overdue = !isDone && !!due && cmpYMD(due, today) < 0;
  const subDone = task.subtasks.filter((s) => s.done).length;

  function onCheck(e: React.MouseEvent) {
    e.stopPropagation();
    if (leaving) return; // 完成动画播放中，重复点击不能把循环任务推进两轮
    if (sub) {
      // 用幂等置位而非 toggle：950ms 动画窗口内用户可能已在展开卡片里改过状态
      if (sub.done) {
        updateSubtask(task.id, sub.id, { done: false });
        return;
      }
      if (fadeOnDone) {
        setLeaving(true);
        setTimeout(() => {
          updateSubtask(task.id, sub.id, { done: true });
          setLeaving(false);
        }, 950);
      } else {
        updateSubtask(task.id, sub.id, { done: true });
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

  // 多选按「件」不按「行」：分拆出来的子任务行也能 Ctrl/Shift 连选，选中的是它那件母任务，
  // 否则一旦任务都有子任务、母任务行全收起，多选就整个用不了了
  function onRowClick(e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      const next = selected ? selectedIds.filter((i) => i !== task.id) : [...selectedIds, task.id];
      anchor.current = task.id;
      setSelection(next);
      return;
    }
    if (e.shiftKey && selectedIds.length) {
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
    if (sub) {
      // 子任务行：菜单作用于子任务本身，不能打到整个母任务上
      openCtxMenu(e.clientX, e.clientY, [task.id], { taskId: task.id, subId: sub.id });
      return;
    }
    // 右键落在多选集合上时保留多选，否则只对当前行
    const ids = selected && selectedIds.length > 1 ? selectedIds : [task.id];
    openCtxMenu(e.clientX, e.clientY, ids);
  }

  const willDone = isDone || leaving;

  return (
    <div
      className={`task-row${willDone ? " done-row" : ""}${leaving ? " leaving" : ""}${selected ? " selected" : ""}`}
      onClick={onRowClick}
      onContextMenu={onCtx}
      draggable
      onDragStart={(e) => {
        // 子任务行也能拖：额外带上子任务身份，拖到「今天/计划」时只挪这一条，
        // 拖到清单/需求方仍然是整件事换归属（归属本来就是任务级的）
        if (sub) {
          e.dataTransfer.setData("text/acorn-sub", `${task.id}:${sub.id}`);
          e.dataTransfer.setData("text/acorn-task", task.id);
          e.dataTransfer.effectAllowed = "move";
          return;
        }
        // 拖的是多选中的一行 → 整组一起走
        const ids = selected && selectedIds.length > 1 ? selectedIds : [task.id];
        e.dataTransfer.setData("text/acorn-task", ids.join(","));
        e.dataTransfer.effectAllowed = "move";
      }}
      data-task-id={task.id}
    >
      <span className={`flag p${priority}`} title={prioInherited ? "重要性继承自母任务" : undefined} />
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
        {task.who && !bundled && <WhoBadge who={task.who} />}
        {!sub && task.tags.map((t) => (
          <span key={t}># {t}</span>
        ))}
        {!hideList && !bundled && list && (
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
          <span
            className={overdue ? "overdue" : undefined}
            title={dueInherited ? "日期继承自母任务，改母任务会一起动" : undefined}
          >
            {formatShort(due)}
            {dueTime ? ` ${dueTime}` : ""}
          </span>
        )}
      </span>
    </div>
  );
}
