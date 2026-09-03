// 四象限：重要 × 紧急，一眼分清轻重缓急。拖动换格 = 改任务属性。
//
// 两端两种身份：
//   · 桌面：2026-08-28 起它是「计划」里的一种看法（见 views/Plan.tsx），标题栏归 Plan 管，
//     这个文件只画格子本身。
//   · 手机（2026-09-03）：它自己就是一页，从「更多」里那一格进。手机顶栏放不下
//     「列表 / 四象限」两个 tab——那两个 tab 挤在标题下面，既难点、也看不出是两种东西。
//     独立成页之后它得自己带 MobileHead：顶部安全区只在那儿留了一份，漏了就顶到状态栏底下。
import { useMemo, useState } from "react";
import type { Task } from "../core/model";
import { addDays, cmpYMD, formatShort, todayYMD } from "../core/dates";
import {
  aliveTasks, byPriorityThenOrder, completeTask, expandTask, navigate,
  setTasksDue, updateTask, useApp,
} from "../core/store";
import { isMobile } from "../core/platform";
import MobileHead from "../mobile/MobileHead";
import TaskCard from "../components/TaskCard";
import "../styles/quadrant.css";
import "../styles/mobile-pages.css";

type QuadKey = "iu" | "in" | "nu" | "nn";

interface QuadCell {
  key: QuadKey;
  important: boolean;
  urgent: boolean;
  name: string;
  hint: string;
}

const QUADRANTS: QuadCell[] = [
  { key: "iu", important: true, urgent: true, name: "重要且紧急", hint: "立即处理" },
  { key: "in", important: true, urgent: false, name: "重要不紧急", hint: "排进日程" },
  { key: "nu", important: false, urgent: true, name: "紧急不重要", hint: "转交或压缩" },
  { key: "nn", important: false, urgent: false, name: "不重要不紧急", hint: "考虑不做" },
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

  // 放弃的退出四象限：这四个格子问的是「接下来怎么排」，已经决定不做的事没有格子可待
  const open = useMemo(() => aliveTasks(data).filter((t) => !t.done && !t.droppedAt), [data]);

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

  const board = (
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
              {items.length === 0 && <div className="quad-empty">这一格没有任务</div>}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );

  // 手机：自己一页，自己带顶栏。「返回」回今天——手机上没有「上一页」这回事（跟清单页同一条）
  if (isMobile) {
    return (
      <section className="main">
        <MobileHead
          title="四象限"
          sub="按重要和紧急分四格"
          onBack={() => navigate("today")}
          search={false}
        />
        {board}
      </section>
    );
  }
  // 桌面：仍然是「计划」里的一个 tab，外面那层 section 和标题栏归 Plan 管
  return board;
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
