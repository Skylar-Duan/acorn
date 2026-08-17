// 展开的任务卡：原地编辑一切字段。Esc / 点击卡外收起。
// v1.1：日期选择用草稿态（翻月不再立刻保存）；子任务可带自己的日期/优先级（默认继承）；
// 底部「快捷改」——用快速添加同款语法改任务（出现哪类要素就改哪类，其余不动）。
import { useEffect, useRef, useState } from "react";
import type { Priority, RepeatRule, Subtask, Task } from "../core/model";
import { LIST_COLORS } from "../core/model";
import { addDays, dayOfWeek, formatShort, todayYMD } from "../core/dates";
import { describeRepeat, firstOccurrence } from "../core/recur";
import type { ParseResult } from "../core/parse";
import {
  addList, addSubtask, allTags, allWho, completeTask, deleteTasks, expandTask,
  removeSubtask, toggleSubtask, uncompleteTask, updateSubtask, updateTask, useApp,
} from "../core/store";
import { startFocus } from "../core/focusCtl";
import SyntaxInput from "./SyntaxInput";

const PRIORITY_LABEL: Record<Priority, string> = { 0: "无", 1: "低", 2: "中", 3: "高" };

type MenuName = "date" | "repeat" | "list" | "priority" | "who" | "tags" | null;

export default function TaskCard({ task }: { task: Task }) {
  const data = useApp((s) => s.data);
  const lists = data.lists;
  const [menu, setMenu] = useState<MenuName>(null);
  const [subMenu, setSubMenu] = useState<{ id: string; kind: "date" | "prio" } | null>(null);
  const [newSub, setNewSub] = useState("");
  const [quick, setQuick] = useState("");
  // 日期草稿：在弹层里随便翻，点「确定」才落库
  const [draftDue, setDraftDue] = useState<string>("");
  const [draftTime, setDraftTime] = useState<string>("");
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

  function openDateMenu() {
    setDraftDue(task.due ?? "");
    setDraftTime(task.dueTime ?? "");
    setMenu(menu === "date" ? null : "date");
  }

  function commitDraft() {
    // 只填了时间没填日期 → 落到今天，不允许「有时间无日期」的悬空状态
    const due = draftDue || (draftTime ? today : null);
    updateTask(task.id, { due, dueTime: draftTime || null });
    setMenu(null);
  }

  /** 快捷按钮：改日期，但弹层里刚填的时间要带上（没填则保留任务原时间） */
  function setDue(d: string | null) {
    updateTask(task.id, { due: d, dueTime: d ? draftTime || task.dueTime : null });
    setMenu(null);
  }

  function setRepeat(r: RepeatRule | null) {
    updateTask(task.id, { repeat: r, due: r ? task.due ?? firstOccurrence(r, today) : task.due });
    setMenu(null);
  }

  function ensureListId(name: string): string {
    const hit = lists.find((l) => l.name === name) ?? lists.find((l) => l.name.startsWith(name));
    if (hit) return hit.id;
    return addList(name, LIST_COLORS[lists.length % LIST_COLORS.length]);
  }

  /** 快捷改：解析结果里出现哪类要素就改哪类；剩余文字非空则视为新标题 */
  function applyQuickPatch(p: ParseResult) {
    const kinds = new Set(p.chips.map((c) => c.kind));
    const patch: Partial<Task> = {};
    if (kinds.has("date")) patch.due = p.due;
    if (kinds.has("time")) patch.dueTime = p.dueTime;
    if (kinds.has("repeat")) {
      patch.repeat = p.repeat;
      // 只写「每周一」没写日期：任务本来无日期时要带上首个落点，否则循环永不触发
      if (!kinds.has("date") && !task.due && p.due) patch.due = p.due;
    }
    if (kinds.has("priority")) patch.priority = p.priority;
    if (kinds.has("who")) patch.who = p.who;
    if (kinds.has("list") && p.listName) patch.listId = ensureListId(p.listName);
    if (kinds.has("tag")) patch.tags = [...new Set([...task.tags, ...p.tags])];
    if (p.title.trim()) patch.title = p.title.trim();
    if (Object.keys(patch).length) updateTask(task.id, patch);
    setQuick("");
  }

  // 循环菜单的「每周X/每月X号」按任务自己的日期取形；「下周一」必须按今天算
  const wd = task.due ? new Date(task.due).getDay() : new Date().getDay();
  const dom = task.due ? Number(task.due.slice(8, 10)) : new Date().getDate();
  const todayWd = dayOfWeek(today);
  const nextMonday = addDays(today, todayWd === 0 ? 1 : 8 - todayWd);

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
          <div key={s.id} className={`sub-row${s.done ? " done" : ""}`} style={{ position: "relative" }}>
            <button className={`sb${s.done ? " done" : ""}`} onClick={() => toggleSubtask(task.id, s.id)} />
            <input
              type="text"
              value={s.title}
              onChange={(e) =>
                updateSubtask(task.id, s.id, { title: e.target.value })
              }
            />
            {/* 子任务自己的日期/优先级：默认继承母任务，点小签单独设 */}
            <button
              className="pill"
              style={{ padding: "1px 8px", fontSize: 11 }}
              title="子任务日期（默认继承母任务）"
              onClick={() => setSubMenu(subMenu?.id === s.id && subMenu.kind === "date" ? null : { id: s.id, kind: "date" })}
            >
              {s.due ? formatShort(s.due) : "📅"}
            </button>
            <button
              className="pill"
              style={{ padding: "1px 8px", fontSize: 11 }}
              title="子任务优先级（默认继承母任务）"
              onClick={() => setSubMenu(subMenu?.id === s.id && subMenu.kind === "prio" ? null : { id: s.id, kind: "prio" })}
            >
              ⚑ {s.priority != null ? PRIORITY_LABEL[s.priority] : "继承"}
            </button>
            <button className="rm" onClick={() => removeSubtask(task.id, s.id)} title="删除子任务">×</button>
            {subMenu?.id === s.id && subMenu.kind === "date" && (
              <div className="popmenu" style={{ top: "100%", right: 0 }}>
                <button className="item" onClick={() => { updateSubtask(task.id, s.id, { due: today }); setSubMenu(null); }}>今天</button>
                <button className="item" onClick={() => { updateSubtask(task.id, s.id, { due: addDays(today, 1) }); setSubMenu(null); }}>明天</button>
                <input
                  className="inline"
                  type="date"
                  defaultValue={s.due ?? ""}
                  onBlur={(e) => { if (e.target.value) { updateSubtask(task.id, s.id, { due: e.target.value }); setSubMenu(null); } }}
                />
                <button className="item" onClick={() => { updateSubtask(task.id, s.id, { due: null, dueTime: null }); setSubMenu(null); }}>继承母任务</button>
              </div>
            )}
            {subMenu?.id === s.id && subMenu.kind === "prio" && (
              <div className="popmenu" style={{ top: "100%", right: 0 }}>
                {([3, 2, 1, 0] as Priority[]).map((p) => (
                  <button key={p} className="item" onClick={() => { updateSubtask(task.id, s.id, { priority: p }); setSubMenu(null); }}>
                    <span className={`flag p${p}`} />
                    {PRIORITY_LABEL[p]}
                  </button>
                ))}
                <button className="item" onClick={() => { updateSubtask(task.id, s.id, { priority: null }); setSubMenu(null); }}>继承母任务</button>
              </div>
            )}
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
        <button className={`pill${task.due ? " hot" : ""}`} onClick={openDateMenu}>
          📅 {task.due ? `${formatShort(task.due)}${task.dueTime ? " " + task.dueTime : ""}` : "安排日期"}
        </button>
        {menu === "date" && (
          <div className="popmenu" style={{ top: "110%", left: 0 }}>
            <button className="item" onClick={() => setDue(today)}>今天</button>
            <button className="item" onClick={() => setDue(addDays(today, 1))}>明天</button>
            <button className="item" onClick={() => setDue(nextMonday)}>下周一</button>
            <div className="sep" />
            {/* 草稿态：随便翻月翻时间，点「确定」才生效 */}
            <input className="inline" type="date" value={draftDue} onChange={(e) => setDraftDue(e.target.value)} />
            <input className="inline" type="time" value={draftTime} onChange={(e) => setDraftTime(e.target.value)} />
            <button className="item" style={{ color: "var(--accent)", fontWeight: 600 }} onClick={commitDraft}>
              ✓ 确定
            </button>
            <div className="sep" />
            {task.due && <button className="item" onClick={() => { updateTask(task.id, { due: null, dueTime: null }); setMenu(null); }}>清除日期</button>}
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

      {/* 快捷改：与快速添加同一套语法 */}
      <div style={{ margin: "10px 0 2px 28px" }}>
        <SyntaxInput
          value={quick}
          onChange={setQuick}
          onSubmit={applyQuickPatch}
          placeholder="快捷改：输入「明天 15点 !高 #标签 /清单 @人」或直接打新标题，回车生效"
          lists={lists.map((l) => l.name)}
          tags={allTags(data).map((t) => t.tag)}
          whos={allWho(data).map((w) => w.who)}
          showChips
          inputStyle={{ fontSize: 12.5, padding: "5px 9px" }}
        />
      </div>
    </div>
  );
}
