// 任务行：一行看清一件事。点击行展开为 TaskCard；勾选有停留动画。
import { useRef, useState } from "react";
import type { Task } from "../core/model";
import { formatShort, todayYMD, cmpYMD } from "../core/dates";
import { describeRepeat } from "../core/recur";
import { completeTask, uncompleteTask, expandTask, useApp, setSelection } from "../core/store";

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
  /** 本视图内可见任务的有序 id 列表（shift 连选用） */
  orderedIds: string[];
  /** 隐藏所属清单标签（清单视图里冗余） */
  hideList?: boolean;
  /** 完成后是否播放淡出（今天/清单视图 true；日志视图 false） */
  fadeOnDone?: boolean;
}

export default function TaskRow({ task, orderedIds, hideList, fadeOnDone = true }: TaskRowProps) {
  const lists = useApp((s) => s.data.lists);
  const selected = useApp((s) => s.ui.selectedIds.includes(task.id));
  const selectedIds = useApp((s) => s.ui.selectedIds);
  const [leaving, setLeaving] = useState(false);
  const anchor = useRef<string | null>(null);

  const list = task.listId ? lists.find((l) => l.id === task.listId) : null;
  const today = todayYMD();
  const overdue = !task.done && !!task.due && cmpYMD(task.due, today) < 0;
  const subDone = task.subtasks.filter((s) => s.done).length;

  function onCheck(e: React.MouseEvent) {
    e.stopPropagation();
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

  const willDone = task.done || leaving;

  return (
    <div
      className={`task-row${willDone ? " done-row" : ""}${leaving ? " leaving" : ""}${selected ? " selected" : ""}`}
      onClick={onRowClick}
      data-task-id={task.id}
    >
      <span className={`flag p${task.priority}`} />
      <button className={`cb${willDone ? " done" : ""}`} onClick={onCheck} title={task.done ? "标记未完成" : "完成"} />
      <span className="title">{task.title || "（未命名）"}</span>
      <span className="meta" onClick={(e) => e.stopPropagation()}>
        {task.who && <WhoBadge who={task.who} />}
        {task.tags.map((t) => (
          <span key={t}># {t}</span>
        ))}
        {!hideList && list && (
          <span className="list-tag">
            <span className="dot" style={{ width: 7, height: 7, borderRadius: 99, background: `var(--list-${list.color})`, display: "inline-block" }} />
            {list.name}
          </span>
        )}
        {task.subtasks.length > 0 && (
          <span>
            {subDone}/{task.subtasks.length}
          </span>
        )}
        {task.repeat && <span title={describeRepeat(task.repeat)}>↻</span>}
        {task.postponeCount >= 2 && !task.done && (
          <span className="warn" title={`已顺延 ${task.postponeCount} 次`}>
            顺延×{task.postponeCount}
          </span>
        )}
        {task.due && (
          <span className={overdue ? "overdue" : undefined}>
            {formatShort(task.due)}
            {task.dueTime ? ` ${task.dueTime}` : ""}
          </span>
        )}
      </span>
    </div>
  );
}
