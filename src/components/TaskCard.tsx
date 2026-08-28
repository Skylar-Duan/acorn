// 展开的任务卡：原地编辑一切字段。Esc / 点击卡外收起。
// v1.1：日期选择用草稿态（翻月不再立刻保存）；子任务可带自己的日期/优先级（默认继承）；
// 底部「快捷改」——用快速添加同款语法改任务（出现哪类要素就改哪类，其余不动）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { Priority, RepeatRule, Subtask, Task } from "../core/model";
import { LIST_COLORS } from "../core/model";
import { addDays, dayOfWeek, formatShort, todayYMD } from "../core/dates";
import { describeRepeat, firstOccurrence } from "../core/recur";
import type { ParseResult } from "../core/parse";
import { parseSubtaskInput, SUBTASK_SKIP } from "../core/parse";
import { taskToSentence } from "../core/syntax";
import {
  addList, addSubtask, addTasksWho, allTags, allWho, completeTask, deleteTasks, expandTask,
  removeSubtask, removeTaskWho, setTasksWho, toggleSubtask, uncompleteTask, updateSubtask,
  updateTask, useApp,
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
  /** 「整句改」输入框的草稿。null = 没动过，显示现算的那句。
   *  **必须连底稿一起记**（base）：用户在框里打了一半，又去上面点了个日期/优先级，
   *  这句底稿就过期了；不作废的话回车会拿过期的那句把刚点的改动盖回去。 */
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
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

  // 已经做完的子任务沉到最下面（只改显示顺序，存的那份数组原样不动）。
  // 用户口径：「子任务已通过的排到最下面」——上面永远是还欠着的
  const subsInOrder = useMemo(() => {
    const idx = new Map(task.subtasks.map((s, i) => [s.id, i]));
    return [...task.subtasks].sort(
      (a, b) => Number(a.done) - Number(b.done) || idx.get(a.id)! - idx.get(b.id)!,
    );
  }, [task.subtasks]);

  // 这件事的「一整句话」。按当前状态现算，不存旧的输入——存了迟早跟字段对不上
  const sentence = useMemo(
    () => taskToSentence(task, { listName: list?.name ?? null, listNames: lists.map((l) => l.name) }),
    [task, list, lists],
  );
  const baseText = sentence.safe ? sentence.text : "";
  // 草稿的底稿跟现在这句对不上 = 期间任务被别处改过，草稿作废，重新以新句子为准
  const live = draft && draft.base === baseText ? draft.text : baseText;

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

  /** 子任务输入框回车：把「明天 15点 !高 画趋势图」拆成标题 + 它自己的日期/时间/重要性。
   *  没写日期/重要性就还是继承母任务（存 null）。加完输入框清空，接着敲下一条 */
  function addSubFromInput() {
    const r = parseSubtaskInput(newSub, new Date());
    const title = r.title.trim();
    if (!title) return;
    addSubtask(task.id, title, {
      due: r.due,
      dueTime: r.dueTime,
      priority: r.priority || null,
    });
    setNewSub("");
  }

  /** 名字 → 清单 id。**先认这件事现在待的那张**：允许重名，光按名字找会永远命中第一张，
   *  于是「什么都没改直接回车」也能把任务从后建的那张同名清单搬到先建的那张去 */
  function ensureListId(name: string): string {
    if (list && list.name === name) return list.id;
    const hit = lists.find((l) => l.name === name) ?? lists.find((l) => l.name.startsWith(name));
    if (hit) return hit.id;
    return addList(name, LIST_COLORS[lists.length % LIST_COLORS.length]);
  }

  /** 整句改：框里那句话**就是**这件事，写什么它就变成什么——
   *  删掉「!高」就降级、删掉「@李哥」就把人摘了、日期改掉就改期。
   *
   *  两条保险：
   *  ① 整句删光了不动手。一句里连标题都没有，那不是「我要清空这件事」，是手滑
   *    （Ctrl+A Delete 回车太容易了），而且此时焦点还在输入框里，Ctrl+Z 走的是
   *    浏览器的文本撤销、救不回来。
   *  ② 只写**真的变了**的字段。全量写的话，一个已经响过、已经被清成 null 的提醒
   *    会因为「due/dueTime 被传了」而重新算出来一个过去的时刻，几十秒后再轰你一次。 */
  function applySentence(p: ParseResult, raw: string) {
    if (!raw.trim() || !p.title.trim()) {
      // 什么都不改，把框恢复成这件事本来那句
      setDraft(null);
      return;
    }
    const patch: Partial<Task> = {};
    const title = p.title.trim();
    if (title !== task.title) patch.title = title;
    if (p.due !== task.due) patch.due = p.due;
    if (p.dueTime !== (task.due ? task.dueTime : null)) patch.dueTime = p.dueTime;
    if (JSON.stringify(p.repeat) !== JSON.stringify(task.repeat)) patch.repeat = p.repeat;
    if (p.priority !== task.priority) patch.priority = p.priority;
    if (JSON.stringify(p.who) !== JSON.stringify(task.who)) patch.who = p.who;
    if (JSON.stringify(p.tags) !== JSON.stringify(task.tags)) patch.tags = p.tags;
    const nextList = p.listName ? ensureListId(p.listName) : null;
    if (nextList !== task.listId) patch.listId = nextList;
    if (Object.keys(patch).length) updateTask(task.id, patch);
    setDraft(null);
  }

  /** 兜底：这件事没法用一句话无损表达（标题里带 # / @，或清单名里有空格）时，
   *  退回老口径——写出哪类要素就改哪类，没写的不动 */
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
    if (kinds.has("who")) patch.who = [...new Set([...task.who, ...p.who])];
    if (kinds.has("list") && p.listName) patch.listId = ensureListId(p.listName);
    if (kinds.has("tag")) patch.tags = [...new Set([...task.tags, ...p.tags])];
    if (p.title.trim()) patch.title = p.title.trim();
    if (Object.keys(patch).length) updateTask(task.id, patch);
    setDraft(null);
  }

  // 循环菜单的「每周X/每月X号」按任务自己的日期取形；「下周一」必须按今天算
  const wd = task.due ? new Date(task.due).getDay() : new Date().getDay();
  const dom = task.due ? Number(task.due.slice(8, 10)) : new Date().getDate();
  const todayWd = dayOfWeek(today);
  const nextMonday = addDays(today, todayWd === 0 ? 1 : 8 - todayWd);

  return (
    <div className="task-card" ref={cardRef}>
      <div className="row1">
        {/* 跟任务行左边缘对齐用的占位（任务行那边有个折叠小三角），没有它点开卡片标题会往左跳一格 */}
        <span className="chain-caret ghost" />
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
        {subsInOrder.map((s) => (
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
              title={s.due ? "这条子任务自己的日期" : "跟着母任务走，点一下可以单独排"}
              onClick={() => setSubMenu(subMenu?.id === s.id && subMenu.kind === "date" ? null : { id: s.id, kind: "date" })}
            >
              {/* 继承来的日期也照样显示，只是淡一点——一眼看得出这条到底哪天要做 */}
              {s.due ? formatShort(s.due) : task.due ? <span style={{ opacity: 0.5 }}>{formatShort(task.due)}</span> : "📅"}
            </button>
            <button
              className="pill"
              style={{ padding: "1px 8px", fontSize: 11 }}
              title={s.priority != null ? "这条子任务自己的重要性" : "跟着母任务走，点一下可以单独设"}
              onClick={() => setSubMenu(subMenu?.id === s.id && subMenu.kind === "prio" ? null : { id: s.id, kind: "prio" })}
            >
              {/* 继承母任务的整体淡一档：一眼分得出「自己设的」还是「跟着母任务」 */}
              <span className={`flag p${s.priority ?? task.priority}`} style={{ opacity: s.priority == null ? 0.5 : 1 }} />
              {s.priority != null ? (
                PRIORITY_LABEL[s.priority]
              ) : (
                <span style={{ opacity: 0.5 }}>{PRIORITY_LABEL[task.priority]}</span>
              )}
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
        {/* 子任务也能一句话记全：「明天 15点 !高 画趋势图」。
            清单/标签/需求方归母任务管，在这儿写就是普通文字，不会被吃掉 */}
        <div className="sub-row">
          <span className="sb" style={{ opacity: 0.35 }} />
          <SyntaxInput
            value={newSub}
            onChange={setNewSub}
            onSubmit={addSubFromInput}
            placeholder="＋ 子任务，回车添加（可以写「明天 !高」）"
            lists={[]}
            tags={[]}
            whos={[]}
            skip={SUBTASK_SKIP}
            inputStyle={{ fontSize: 13 }}
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
            "随手记"
          )}
        </button>
        {menu === "list" && (
          <div className="popmenu" style={{ top: "110%", left: 180 }}>
            <button className="item" onClick={() => { updateTask(task.id, { listId: null }); setMenu(null); }}>随手记</button>
            {lists.map((l) => (
              <button key={l.id} className="item" onClick={() => { updateTask(task.id, { listId: l.id }); setMenu(null); }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: `var(--list-${l.color})`, display: "inline-block" }} />
                {l.name}
              </button>
            ))}
          </div>
        )}

        {/* 需求方：一件事可以挂好几个人，挂了谁就一人一行，点 × 摘掉 */}
        <button className={`pill${task.who.length ? " hot" : ""}`} onClick={() => setMenu(menu === "who" ? null : "who")}>
          ＠ {task.who.length ? task.who.join("、") : "需求方"}
        </button>
        {menu === "who" && (
          <div className="popmenu" style={{ top: "110%", left: 250 }}>
            {task.who.map((w) => (
              <button key={w} className="item" title="点一下摘掉 TA" onClick={() => removeTaskWho(task.id, w)}>
                ＠ {w}
                <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>×</span>
              </button>
            ))}
            {task.who.length > 0 && <div className="sep" />}
            <input
              className="inline"
              autoFocus
              placeholder={task.who.length ? "再加一个人，回车确定" : "这事是为谁做的？回车确定"}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  const el = e.target as HTMLInputElement;
                  addTasksWho([task.id], el.value);
                  el.value = ""; // 留在原地接着加下一个，不用重开菜单
                }
              }}
            />
            {task.who.length > 0 && (
              <button className="item" onClick={() => { setTasksWho([task.id], []); setMenu(null); }}>全部清除</button>
            )}
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

        {/* 删除跟上面那排「改属性」的胶囊隔开：它是唯一一个按下去东西会消失的键，
            挨着放迟早误点（2026-08-28 用户就问过「怎么直接消失了」） */}
        <span className="tc-gap" />
        <button className="pill danger-pill" title="删除（可在回收站找回，也能 Ctrl+Z 撤销）" onClick={() => { expandTask(null); deleteTasks([task.id]); }}>
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

      {/* 整句改：这一栏里就是这件事的一句话（现算的，不是当初输入的那句）。改它就是改这件事 */}
      <div className="tc-sentence">
        <span className="tc-sentence-tag">{sentence.safe ? "整句改" : "快捷改"}</span>
        <SyntaxInput
          value={live}
          onChange={(v) => setDraft({ base: baseText, text: v })}
          onSubmit={sentence.safe ? (p) => applySentence(p, live) : applyQuickPatch}
          placeholder={
            sentence.safe
              ? "改这句话就是改这件事，回车生效"
              : "快捷改：输入「明天 15点 !高 #标签 /清单 @人」，写了哪类改哪类，回车生效"
          }
          lists={lists.map((l) => l.name)}
          tags={allTags(data).map((t) => t.tag)}
          whos={allWho(data).map((w) => w.who)}
          showChips
          inputStyle={{ fontSize: 12.5, padding: "5px 9px" }}
        />
        {sentence.safe && live !== baseText && (
          <button className="tc-restore" title="丢掉手上这句，换回这件事现在的样子" onClick={() => setDraft(null)}>↺</button>
        )}
      </div>
    </div>
  );
}
