// 自定义右键菜单：作用于单条或多选任务（ui.ctxMenu.ids）。
// App.tsx 常驻渲染 <ContextMenu/>；打开/关闭走 store 的 openCtxMenu/closeCtxMenu。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Priority, Task } from "../core/model";
import { addDays, dayOfWeek, todayYMD } from "../core/dates";
import {
  closeCtxMenu, completeTask, deleteTasks, postponeRows, postponeTasks,
  removeSubtask, setTasksDue, setTasksList, setTasksWho, showToast, uncompleteTask,
  updateSubtask, updateTask, useApp,
} from "../core/store";
import { startFocus } from "../core/focusCtl";
import "../styles/contextmenu.css";

const PRIORITY_LABEL: Record<Priority, string> = { 0: "无", 1: "低", 2: "中", 3: "高" };

type SubName = "date" | "priority" | "list";

export default function ContextMenu() {
  const ctx = useApp((s) => s.ui.ctxMenu);
  if (!ctx) return null;
  // 每次打开都重挂载，内部状态（子菜单/输入框/定位）不残留
  if (ctx.sub) {
    return <SubRowMenu key={`${ctx.x},${ctx.y},${ctx.sub.subId}`} x={ctx.x} y={ctx.y} taskId={ctx.sub.taskId} subId={ctx.sub.subId} />;
  }
  return <Menu key={`${ctx.x},${ctx.y},${ctx.ids.join("|")}`} x={ctx.x} y={ctx.y} ids={ctx.ids} />;
}

/** 子任务行的右键菜单：作用对象是子任务本身，绝不打到母任务上 */
function SubRowMenu({ x, y, taskId, subId }: { x: number; y: number; taskId: string; subId: string }) {
  const data = useApp((s) => s.data);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [subOpen, setSubOpen] = useState<"date" | "priority" | null>(null);

  const task = data.tasks.find((t) => t.id === taskId && !t.deletedAt);
  const sub = task?.subtasks.find((s) => s.id === subId);
  const gone = !task || !sub;

  useEffect(() => {
    if (gone) closeCtxMenu();
  }, [gone]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    let left = x, top = y;
    if (left + el.offsetWidth > window.innerWidth - 8) left = Math.max(8, left - el.offsetWidth);
    if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, top - el.offsetHeight);
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeCtxMenu();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeCtxMenu();
    }
    function onWheel() {
      closeCtxMenu();
    }
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  if (gone) return null;
  const today = todayYMD();
  const run = (fn: () => void) => {
    fn();
    closeCtxMenu();
  };

  return (
    <div className="ctx-menu" ref={menuRef} style={{ left: pos.left, top: pos.top }} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-count">子任务 · {task.title.slice(0, 12)}</div>
      <button className="ctx-item" onClick={() => run(() => updateSubtask(taskId, subId, { done: !sub.done }))}>
        {sub.done ? "标记未完成" : "完成子任务"}
      </button>
      <div className="ctx-sep" />
      <button className="ctx-item" onClick={() => run(() => postponeRows([{ task, sub }]))}>
        推到明天
      </button>
      <div
        className={`ctx-subwrap${subOpen === "date" ? " open" : ""}`}
        onMouseEnter={() => setSubOpen("date")}
        onMouseLeave={() => setSubOpen(null)}
      >
        <button className="ctx-item">安排日期<span className="ctx-caret">▸</span></button>
        {subOpen === "date" && (
          <div className="ctx-submenu">
            <button className="ctx-item" onClick={() => run(() => updateSubtask(taskId, subId, { due: today }))}>今天</button>
            <button className="ctx-item" onClick={() => run(() => updateSubtask(taskId, subId, { due: addDays(today, 1) }))}>明天</button>
            <div className="ctx-sep" />
            <button className="ctx-item" onClick={() => run(() => updateSubtask(taskId, subId, { due: null, dueTime: null }))}>继承母任务</button>
          </div>
        )}
      </div>
      <div
        className={`ctx-subwrap${subOpen === "priority" ? " open" : ""}`}
        onMouseEnter={() => setSubOpen("priority")}
        onMouseLeave={() => setSubOpen(null)}
      >
        <button className="ctx-item">优先级<span className="ctx-caret">▸</span></button>
        {subOpen === "priority" && (
          <div className="ctx-submenu">
            {([3, 2, 1, 0] as Priority[]).map((p) => (
              <button key={p} className="ctx-item" onClick={() => run(() => updateSubtask(taskId, subId, { priority: p }))}>
                <span className={`flag p${p}`} />
                {PRIORITY_LABEL[p]}
              </button>
            ))}
            <button className="ctx-item" onClick={() => run(() => updateSubtask(taskId, subId, { priority: null }))}>继承母任务</button>
          </div>
        )}
      </div>
      <div className="ctx-sep" />
      <button
        className="ctx-item"
        onClick={() => {
          void navigator.clipboard.writeText(sub.title).then(
            () => showToast("已复制", false),
            () => showToast("复制失败", false),
          );
          closeCtxMenu();
        }}
      >
        复制标题
      </button>
      <button className="ctx-item ctx-danger" onClick={() => run(() => removeSubtask(taskId, subId))}>
        删除子任务
      </button>
    </div>
  );
}

function Menu({ x, y, ids: rawIds }: { x: number; y: number; ids: string[] }) {
  const data = useApp((s) => s.data);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const subTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [sub, setSub] = useState<SubName | null>(null);
  const [subFlip, setSubFlip] = useState(false);
  const [whoOpen, setWhoOpen] = useState(false);

  // 已被删除/不存在的任务静默过滤
  const tasks = rawIds
    .map((id) => data.tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t && !t.deletedAt);
  const ids = tasks.map((t) => t.id);
  const empty = tasks.length === 0;

  // 菜单开着时目标全没了（撤销等）→ 自动收起
  useEffect(() => {
    if (empty) closeCtxMenu();
  }, [empty]);

  // 定位：靠近视口右/下缘时向左/上翻转
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    let left = x, top = y;
    if (left + el.offsetWidth > window.innerWidth - 8) left = Math.max(8, left - el.offsetWidth);
    if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, top - el.offsetHeight);
    setPos({ left, top });
  }, [x, y]);

  // 点击菜单外（mousedown 捕获）/ Esc / 滚轮 → 关闭
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeCtxMenu();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeCtxMenu();
    }
    function onWheel() {
      closeCtxMenu();
    }
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
      if (subTimer.current) clearTimeout(subTimer.current);
    };
  }, []);

  // 子菜单右侧放不下 → 向左弹
  useLayoutEffect(() => {
    if (!sub || !menuRef.current || !subRef.current) return;
    const mr = menuRef.current.getBoundingClientRect();
    setSubFlip(mr.right + subRef.current.offsetWidth > window.innerWidth - 8);
  }, [sub]);

  if (empty) return null;

  function subEnter(name: SubName) {
    if (subTimer.current) {
      clearTimeout(subTimer.current);
      subTimer.current = null;
    }
    setSub(name);
  }
  function subLeave() {
    if (subTimer.current) clearTimeout(subTimer.current);
    subTimer.current = setTimeout(() => setSub(null), 150);
  }
  /** 执行任何命令后统一收起菜单 */
  function run(fn: () => void) {
    fn();
    closeCtxMenu();
  }

  const allDone = tasks.every((t) => t.done);
  const today = todayYMD();
  const w = dayOfWeek(today);
  const nextMonday = addDays(today, w === 0 ? 1 : 8 - w);
  const lists = [...data.lists].sort((a, b) => a.order - b.order);
  // 多选且需求方不一致时输入框从空开始。多个人用空格隔开
  const whoKey = (t: Task) => t.who.join(" ");
  const whoDefault = tasks.every((t) => whoKey(t) === whoKey(tasks[0])) ? whoKey(tasks[0]) : "";

  return (
    <div
      className="ctx-menu"
      ref={menuRef}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {tasks.length > 1 && <div className="ctx-count">{tasks.length} 项</div>}

      <button
        className="ctx-item"
        onClick={() => run(() => ids.forEach((id) => (allDone ? uncompleteTask(id) : completeTask(id))))}
      >
        {allDone ? "标记未完成" : "完成"}
      </button>
      {tasks.length === 1 && !tasks[0].done && (
        <button className="ctx-item" onClick={() => run(() => void startFocus(tasks[0].id))}>
          ▶ 开始专注
        </button>
      )}

      <div className="ctx-sep" />

      <button className="ctx-item" onClick={() => run(() => postponeTasks(ids))}>
        推到明天
      </button>

      {/* 安排日期 ▸ */}
      <div
        className={`ctx-subwrap${sub === "date" ? " open" : ""}`}
        onMouseEnter={() => subEnter("date")}
        onMouseLeave={subLeave}
      >
        <button className="ctx-item">
          安排日期<span className="ctx-caret">▸</span>
        </button>
        {sub === "date" && (
          <div className={`ctx-submenu${subFlip ? " flip" : ""}`} ref={subRef}>
            <button className="ctx-item" onClick={() => run(() => setTasksDue(ids, today))}>今天</button>
            <button className="ctx-item" onClick={() => run(() => setTasksDue(ids, addDays(today, 1)))}>明天</button>
            <button className="ctx-item" onClick={() => run(() => setTasksDue(ids, nextMonday))}>下周一</button>
            <div className="ctx-sep" />
            <button className="ctx-item" onClick={() => run(() => setTasksDue(ids, null))}>清除日期</button>
          </div>
        )}
      </div>

      {/* 优先级 ▸ */}
      <div
        className={`ctx-subwrap${sub === "priority" ? " open" : ""}`}
        onMouseEnter={() => subEnter("priority")}
        onMouseLeave={subLeave}
      >
        <button className="ctx-item">
          优先级<span className="ctx-caret">▸</span>
        </button>
        {sub === "priority" && (
          <div className={`ctx-submenu${subFlip ? " flip" : ""}`} ref={subRef}>
            {([3, 2, 1, 0] as Priority[]).map((p) => (
              <button
                key={p}
                className="ctx-item"
                onClick={() => run(() => ids.forEach((id) => updateTask(id, { priority: p })))}
              >
                <span className={`flag p${p}`} />
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 移到清单 ▸ */}
      <div
        className={`ctx-subwrap${sub === "list" ? " open" : ""}`}
        onMouseEnter={() => subEnter("list")}
        onMouseLeave={subLeave}
      >
        <button className="ctx-item">
          移到清单<span className="ctx-caret">▸</span>
        </button>
        {sub === "list" && (
          <div className={`ctx-submenu${subFlip ? " flip" : ""}`} ref={subRef}>
            <button className="ctx-item" onClick={() => run(() => setTasksList(ids, null))}>
              <span className="ctx-dot" style={{ background: "var(--ink-3)" }} />
              随手记
            </button>
            {lists.map((l) => (
              <button key={l.id} className="ctx-item" onClick={() => run(() => setTasksList(ids, l.id))}>
                <span className="ctx-dot" style={{ background: `var(--list-${l.color})` }} />
                {l.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 需求方：点开变内联输入 */}
      {whoOpen ? (
        <input
          className="ctx-input"
          autoFocus
          placeholder="为谁做的？多个人用空格隔开，回车确定"
          defaultValue={whoDefault}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              const names = (e.target as HTMLInputElement).value.split(/[\s,，、@]+/);
              run(() => setTasksWho(ids, names));
            }
          }}
        />
      ) : (
        <button className="ctx-item" onClick={() => setWhoOpen(true)}>
          需求方…
        </button>
      )}

      <div className="ctx-sep" />

      <button
        className="ctx-item"
        onClick={() => {
          void navigator.clipboard.writeText(tasks.map((t) => t.title).join("\n")).then(
            () => showToast("已复制", false),
            () => showToast("复制失败", false),
          );
          closeCtxMenu();
        }}
      >
        复制标题
      </button>
      <button className="ctx-item ctx-danger" onClick={() => run(() => deleteTasks(ids))}>
        删除
      </button>
    </div>
  );
}
