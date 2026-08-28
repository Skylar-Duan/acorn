// 四象限：重要 × 紧急，一眼分清轻重缓急。拖动换格 = 改任务属性。
// 2026-08-28 起它不再是一个独立视图，而是「计划」里的一种看法（见 views/Plan.tsx），
// 所以这里只画格子本身，标题栏归 Plan 管。
import { useMemo, useState } from "react";
import type { Task } from "../core/model";
import { addDays, cmpYMD, formatShort, todayYMD } from "../core/dates";
import {
  aliveTasks, byPriorityThenOrder, completeTask, expandTask,
  setTasksDue, updateTask, useApp,
} from "../core/store";
import TaskCard from "../components/TaskCard";
import "../styles/quadrant.css";

type QuadKey = "iu" | "in" | "nu" | "nn";

interface QuadCell {
  key: QuadKey;
  important: boolean;
  urgent: boolean;
  name: string;
  hint: string;
}

const QUADRANTS: QuadCell[] = [
  { key: "iu", important: true, urgent: true, name: "重要且紧急", hint: "现在就做" },
  { key: "in", important: true, urgent: false, name: "重要不紧急", hint: "排进日程" },
  { key: "nu", important: false, urgent: true, name: "紧急不重要", hint: "能挪就挪" },
  { key: "nn", important: false, urgent: false, name: "不重要不紧急", hint: "想想还做不做" },
];

function isImportant(t: Task): boolean {
  return t.priority >= 2;
}

/** 紧急 = 有日期且不晚于明天（含逾期） */
function isUrgent(t: Task, tomorrow: string): boolean {
  return !!t.due && cmpYMD(t.due, tomorrow) <= 0;
}

export default function QuadrantBoard() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const [dropKey, setDropKey] = useState<QuadKey | null>(null);
  const today = todayYMD();
  const tomorrow = addDays(today, 1);

  const open = useMemo(() => aliveTasks(data).filter((t) => !t.done), [data]);

  const groups = useMemo(() => {
    const out = new Map<QuadKey, Task[]>();
    for (const q of QUADRANTS) out.set(q.key, []);
    for (const t of open) {
      const key: QuadKey = isImportant(t)
        ? isUrgent(t, tomorrow) ? "iu" : "in"
        : isUrgent(t, tomorrow) ? "nu" : "nn";
      out.get(key)!.push(t);
    }
    for (const list of out.values()) list.sort(byPriorityThenOrder);
    return out;
  }, [open, tomorrow]);

  function onDrop(e: React.DragEvent<HTMLDivElement>, q: QuadCell) {
    e.preventDefault();
    setDropKey(null);
    const id = e.dataTransfer.getData("text/plain");
    const t = open.find((x) => x.id === id);
    if (!t) return;
    // 按落点格子的语义改任务：只动与现状不同的轴
    if (isImportant(t) !== q.important) {
      updateTask(t.id, { priority: q.important ? 3 : 0 });
    }
    if (isUrgent(t, tomorrow) !== q.urgent) {
      if (q.urgent) {
        if (!t.due) setTasksDue([t.id], today); // 无日期的设为今天
      } else if (t.due) {
        setTasksDue([t.id], addDays(today, 3)); // 挪出紧急带；本来没日期的不动
      }
    }
  }

  return (
    <div className="view-body quad-body">
      <div className="quad-grid" onDragEnd={() => setDropKey(null)}>
      {QUADRANTS.map((q) => {
        const items = groups.get(q.key)!;
        return (
          <div
            key={q.key}
            className={`quad-cell quad-${q.key}${dropKey === q.key ? " quad-dropping" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dropKey !== q.key) setDropKey(q.key);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDropKey((k) => (k === q.key ? null : k));
              }
            }}
            onDrop={(e) => onDrop(e, q)}
          >
            <div className="quad-head">
              <span className="quad-name">{q.name}</span>
              <span className="quad-count">{items.length}</span>
              <span className="quad-hint">{q.hint}</span>
            </div>
            <div className="quad-cell-body">
              {items.map((t) =>
                expandedId === t.id ? (
                  <TaskCard key={t.id} task={t} />
                ) : (
                  <QuadRow key={t.id} task={t} today={today} />
                ),
              )}
              {items.length === 0 && <div className="quad-empty">这格清净</div>}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

/** 格内简化行：旗标 + 勾选 + 标题 + 日期短格式。点击展开卡片，可拖走。 */
function QuadRow({ task, today }: { task: Task; today: string }) {
  const overdue = !!task.due && cmpYMD(task.due, today) < 0;
  return (
    <div
      className="quad-row"
      draggable
      data-task-id={task.id}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => expandTask(task.id)}
    >
      <span className={`flag p${task.priority}`} />
      <button
        className="cb"
        title="完成"
        onClick={(e) => {
          e.stopPropagation();
          completeTask(task.id);
        }}
      />
      <span className="quad-title">{task.title || "（未命名）"}</span>
      {task.due && (
        <span className={`quad-due${overdue ? " overdue" : ""}`}>
          {formatShort(task.due)}
          {task.dueTime ? ` ${task.dueTime}` : ""}
        </span>
      )}
    </div>
  );
}
