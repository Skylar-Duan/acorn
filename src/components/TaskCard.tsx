// 展开的任务卡：原地编辑一切字段。Esc / 点击卡外收起。
import { useEffect, useRef, useState } from "react";
import type { Priority, RepeatRule, Task } from "../core/model";
import { addDays, formatShort, todayYMD } from "../core/dates";
import { describeRepeat, firstOccurrence } from "../core/recur";
import {
  addSubtask, completeTask, deleteTasks, expandTask, removeSubtask,
  setFocusState, toggleSubtask, uncompleteTask, updateTask, useApp,
} from "../core/store";
import { startFocus } from "../core/focusCtl";

const PRIORITY_LABEL: Record<Priority, string> = { 0: "无", 1: "低", 2: "中", 3: "高" };

type MenuName = "date" | "repeat" | "list" | "priority" | "who" | "tags" | null;

export default function TaskCard({ task }: { task: Task }) {
  const lists = useApp((s) => s.data.lists);
  const [menu, setMenu] = useState<MenuName>(null);
  const [newSub, setNewSub] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) expandTask(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") expandTask(null);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const list = task.listId ? lists.find((l) => l.id === task.listId) : null;
  const today = todayYMD();

  function setDue(d: string | null) {
    updateTask(task.id, { due: d, someday: false });
    setMenu(null);
  }
  function setRepeat(r: RepeatRule | null) {
    updateTask(task.id, { repeat: r, due: r ? task.due ?? firstOccurrence(r, today) : task.due });
    setMenu(null);
  }

  const wd = task.due ? new Date(task.due).getDay() : new Date().getDay();
  const dom = task.due ? Number(task.due.slice(8, 10)) : new Date().getDate();

  return (
    <div className="task-card" ref={cardRef}>
      <div className="row1">
        <span className={`flag p${task.priority}`} />
        <button
          className={`cb${task.done ? " done" : ""}`}
          onClick={() => (task.done ? uncompleteTask(task.id) : completeTask(task.id))}
        />
        <input
          ref={titleRef}
          value={task.title}
          placeholder="任务标题"
          onChange={(e) => updateTask(task.id, { title: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && expandTask(null)}
        />
      </div>

      <textarea
        className="notes"
        value={task.notes}
        placeholder="备注…"
        rows={task.notes ? undefined : 1}
        onChange={(e) => updateTask(task.id, { notes: e.target.value })}
      />

      <div className="subs">
        {task.subtasks.map((s) => (
          <div key={s.id} className={`sub-row${s.done ? " done" : ""}`}>
            <button className={`sb${s.done ? " done" : ""}`} onClick={() => toggleSubtask(task.id, s.id)} />
            <input
              type="text"
              value={s.title}
              onChange={(e) =>
                updateTask(task.id, {
                  subtasks: task.subtasks.map((x) => (x.id === s.id ? { ...x, title: e.target.value } : x)),
                })
              }
            />
            <button className="rm" onClick={() => removeSubtask(task.id, s.id)} title="删除子任务">×</button>
          </div>
        ))}
        <div className="sub-row">
          <span className="sb" style={{ opacity: 0.35 }} />
          <input
            type="text"
            placeholder="＋ 子任务，回车添加"
            value={newSub}
            onChange={(e) => setNewSub(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && newSub.trim()) {
                addSubtask(task.id, newSub.trim());
                setNewSub("");
              }
            }}
          />
        </div>
      </div>

      <div className="chips" style={{ position: "relative" }}>
        {/* 日期 */}
        <button className={`pill${task.due ? " hot" : ""}`} onClick={() => setMenu(menu === "date" ? null : "date")}>
          📅 {task.due ? `${formatShort(task.due)}${task.dueTime ? " " + task.dueTime : ""}` : "安排日期"}
        </button>
        {menu === "date" && (
          <div className="popmenu" style={{ top: "110%", left: 0 }}>
            <button className="item" onClick={() => setDue(today)}>今天</button>
            <button className="item" onClick={() => setDue(addDays(today, 1))}>明天</button>
            <button className="item" onClick={() => setDue(addDays(today, 7 - (wd === 0 ? 7 : wd) + 1))}>下周一</button>
            <div className="sep" />
            <input
              className="inline"
              type="date"
              value={task.due ?? ""}
              onChange={(e) => setDue(e.target.value || null)}
            />
            <input
              className="inline"
              type="time"
              value={task.dueTime ?? ""}
              onChange={(e) => updateTask(task.id, { dueTime: e.target.value || null })}
            />
            <div className="sep" />
            <button className="item" onClick={() => { updateTask(task.id, { due: null, dueTime: null, someday: true }); setMenu(null); }}>
              移到「随时」
            </button>
            {task.due && <button className="item" onClick={() => setDue(null)}>清除日期</button>}
          </div>
        )}

        {/* 循环 */}
        <button className={`pill${task.repeat ? " hot" : ""}`} onClick={() => setMenu(menu === "repeat" ? null : "repeat")}>
          ↻ {task.repeat ? describeRepeat(task.repeat) : "循环"}
        </button>
        {menu === "repeat" && (
          <div className="popmenu" style={{ top: "110%", left: 90 }}>
            <button className="item" onClick={() => setRepeat({ kind: "daily", every: 1 })}>每天</button>
            <button className="item" onClick={() => setRepeat({ kind: "workday" })}>每个工作日</button>
            <button className="item" onClick={() => setRepeat({ kind: "weekly", days: [wd] })}>
              {describeRepeat({ kind: "weekly", days: [wd] })}
            </button>
            <button className="item" onClick={() => setRepeat({ kind: "monthly", day: dom })}>每月{dom}号</button>
            {task.repeat && (
              <>
                <div className="sep" />
                <button className="item" onClick={() => setRepeat(null)}>不再循环</button>
              </>
            )}
          </div>
        )}

        {/* 清单 */}
        <button className="pill" onClick={() => setMenu(menu === "list" ? null : "list")}>
          {list ? (
            <>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: `var(--list-${list.color})`, display: "inline-block" }} />
              {list.name}
            </>
          ) : (
            "收件箱"
          )}
        </button>
        {menu === "list" && (
          <div className="popmenu" style={{ top: "110%", left: 180 }}>
            <button className="item" onClick={() => { updateTask(task.id, { listId: null }); setMenu(null); }}>收件箱</button>
            {lists.map((l) => (
              <button key={l.id} className="item" onClick={() => { updateTask(task.id, { listId: l.id }); setMenu(null); }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: `var(--list-${l.color})`, display: "inline-block" }} />
                {l.name}
              </button>
            ))}
          </div>
        )}

        {/* 需求方 */}
        <button className={`pill${task.who ? " hot" : ""}`} onClick={() => setMenu(menu === "who" ? null : "who")}>
          ＠ {task.who ?? "需求方"}
        </button>
        {menu === "who" && (
          <div className="popmenu" style={{ top: "110%", left: 250 }}>
            <input
              className="inline"
              autoFocus
              placeholder="这事是为谁做的？回车确定"
              defaultValue={task.who ?? ""}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  const v = (e.target as HTMLInputElement).value.trim();
                  updateTask(task.id, { who: v || null });
                  setMenu(null);
                }
              }}
            />
            {task.who && <button className="item" onClick={() => { updateTask(task.id, { who: null }); setMenu(null); }}>清除</button>}
          </div>
        )}

        {/* 优先级 */}
        <button className={`pill${task.priority ? " hot" : ""}`} onClick={() => setMenu(menu === "priority" ? null : "priority")}>
          ⚑ {PRIORITY_LABEL[task.priority]}
        </button>
        {menu === "priority" && (
          <div className="popmenu" style={{ top: "110%", left: 330 }}>
            {([3, 2, 1, 0] as Priority[]).map((p) => (
              <button key={p} className="item" onClick={() => { updateTask(task.id, { priority: p }); setMenu(null); }}>
                <span className={`flag p${p}`} />
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
        )}

        {/* 标签 */}
        <button className={`pill${task.tags.length ? " hot" : ""}`} onClick={() => setMenu(menu === "tags" ? null : "tags")}>
          # {task.tags.length ? task.tags.join("、") : "标签"}
        </button>
        {menu === "tags" && (
          <div className="popmenu" style={{ top: "110%", left: 380 }}>
            <input
              className="inline"
              autoFocus
              placeholder="多个用空格分开，回车确定"
              defaultValue={task.tags.join(" ")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  const v = (e.target as HTMLInputElement).value.trim();
                  updateTask(task.id, { tags: v ? v.split(/\s+/) : [] });
                  setMenu(null);
                }
              }}
            />
          </div>
        )}

        <button className="pill" title="删除（可在回收站找回）" onClick={() => { expandTask(null); deleteTasks([task.id]); }}>
          🗑
        </button>

        {!task.done && (
          <button
            className="focus-go"
            onClick={() => {
              expandTask(null);
              void startFocus(task.id);
            }}
          >
            ▶ 专注
          </button>
        )}
      </div>
    </div>
  );
}
