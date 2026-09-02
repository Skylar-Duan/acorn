// 任务详情抽屉（画板 ④）——手机上「点开一件事」的唯一去处，v1.11.0。
//
// 桌面那张展开卡（components/TaskCard.tsx）在 390px 上是横着长出屏幕的，所以这儿**版式重画**，
// 但**每一次写库都照抄它那一份**：完成 / 放弃 / 删除 / 改标题 / 改属性 / 子任务的六件事，
// 用的都是 TaskCard 调的那几个 store 函数（它们自带撤销栈和落盘），一个都不另开新路。
// 尤其是日期那一套「顺延次数按弹层开→关整段算一次」（POPUP_WRITE + settleDuePopup），
// 一字不差地搬过来了：少了它，在这儿点两下日期就会给这件事凭空记上「顺延×2」，
// 而这个数没有任何入口能清零（原委见 core/dateinput.ts 与 tests/commit-guards.test.ts）。
//
// 手机上跟桌面故意不一样的三处，都是「手指没有 hover、屏幕只有一屏」逼出来的：
//   · 属性不是一排小胶囊而是**一行一个**，点开在同一张纸里往下长出一段（不叠第二层抽屉）；
//   · 子任务的「放弃 / 删除」不靠 hover 显形，**左滑**露出来（useSwipeRow）；
//   · 「放弃 / 删除」钉在纸底，跟上面改属性的那些隔开——这两个是仅有的「按下去它就不在清单里了」的键。
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Priority, RepeatRule, Subtask, Task } from "../core/model";
import { cmpYMD, dayOfWeek, duePresets, formatShort, isPlausibleYMD, todayYMD } from "../core/dates";
import { describeRepeat, firstOccurrence } from "../core/recur";
import { parseSubtaskInput } from "../core/parse";
import {
  addSubtask, addTasksWho, allTags, allWho, appStore, completeTask, deleteTasks, dropSubtask,
  dropTasks, foldDoneSubs, removeSubtask, removeTaskWho, setTasksWho, splitSubtasks, SUB_DONE_PEEK,
  toggleSubtask, uncompleteTask, updateSubtask, updateTask, useApp,
} from "../core/store";
import DateField from "../components/DateField";
import type { DateFieldHandle } from "../components/DateField";
import { growArea, oneLine } from "../components/autogrow";
import { closeSheet, topSheet, useSheet } from "./sheetStore";
import Sheet from "./Sheet";
import { useSwipeRow } from "./swipe";
import "../styles/mobile-sheet.css";

const PRIO_NAME: Record<Priority, string> = { 0: "无", 1: "低", 2: "中", 3: "高" };

/** 左滑露出来的那条有多宽：mobile.css 里 .swipe-act 是 72px 一颗，放弃 + 删除两颗 */
const SUB_ACTIONS_W = 144;

/** 日期那一段里的每一次写库都带上它：**这一段开着的时候一律不数顺延**。
 *  「这件事被往后推了几次」按「段开 → 段关」整段算一次，落在 settleDuePopup 里。
 *  跟 TaskCard 的 POPUP_WRITE 是同一件东西，别在这儿改口径 */
const POPUP_WRITE = { noPostponeCount: true } as const;

type Seg = "date" | "list" | "who" | "prio" | "tags" | null;

export function TaskSheetHost() {
  const top = useSheet((s) => topSheet(s.stack));
  const taskId = top?.kind === "task" ? top.taskId : null;
  const task = useApp((s) => (taskId ? s.data.tasks.find((t) => t.id === taskId) ?? null : null));
  /** 这件事没了（被删进回收站 / 撤销掉 / 云同步拉走）就自己收掉——
   *  抽屉不许留在一件已经不存在的事上，那样点什么都是往空气里写 */
  const gone = !!taskId && (!task || !!task.deletedAt);
  useEffect(() => {
    if (gone) closeSheet();
  }, [gone]);

  // 退场那 180ms 里栈已经空了，但纸还在演动画：留住最后那一份，别让纸在滑下去的路上突然变白
  const lastRef = useRef<Task | null>(null);
  if (task && !task.deletedAt) lastRef.current = task;
  const shown = task && !task.deletedAt ? task : lastRef.current;

  return (
    <Sheet open={!gone && !!task} onClose={closeSheet} expandable label="任务详情" className="msh-sheet msh-task">
      {shown ? <TaskSheetBody key={shown.id} task={shown} /> : null}
    </Sheet>
  );
}

function TaskSheetBody({ task }: { task: Task }) {
  // 只订阅真用得上的三片（照 TaskCard 的 B8）：这张纸里打一个字并不改清单和需求方表
  const lists = useApp((s) => s.data.lists);
  const tasks = useApp((s) => s.data.tasks);
  const settings = useApp((s) => s.data.settings);
  const tagNames = useMemo(() => allTags({ tasks }).map((t) => t.tag), [tasks]);
  const whoNames = useMemo(() => allWho({ tasks, settings }).map((w) => w.who), [tasks, settings]);

  const [seg, setSeg] = useState<Seg>(null);
  /** 标题 / 备注的原地编辑草稿。null = 没在改，显示的就是这件事现在那句 */
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const [newSub, setNewSub] = useState("");
  /** 已完成子任务展不展开。null = 还没表过态，跟自动规则走（口径跟 TaskCard 一模一样） */
  const [showDone, setShowDone] = useState<boolean | null>(null);
  /** 日期段里时间框的当前值：一失焦就生效，这个 state 只是让它记得自己显示什么 */
  const [draftTime, setDraftTime] = useState("");
  /** 删除按了第一下没有：第一下只是把这颗键变成「真的删？」 */
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dueFieldRef = useRef<DateFieldHandle | null>(null);
  /** 日期段**打开那一刻**这件事的日子 */
  const dueAtOpenRef = useRef<string | null>(null);
  /** 这一段自己写进去的那个日子（undefined = 一个字都没写，null = 把日期清了）。
   *  顺延结算只认它，不认 store 里当下那个 due——不然段开着的时候别处改的日期会被再数一遍 */
  const dueWrittenRef = useRef<string | null | undefined>(undefined);
  const settleDueRef = useRef<() => void>(() => {});
  const taskIdRef = useRef(task.id);
  taskIdRef.current = task.id;

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  const today = todayYMD();
  // 安排日期的四个快捷预设现算，规则和单测都在 core/dates.duePresets：
  // 一律向后取最近的一个、名字跟着算出来的日子走、跟今天撞上的那个不出现。
  // 全仓七处安排日期共用这一份，绝不在这儿再写一份
  const presets = duePresets(today);
  const list = task.listId ? lists.find((l) => l.id === task.listId) : null;
  const { open: openSubs, done: doneSubs } = useMemo(() => splitSubtasks(task.subtasks), [task.subtasks]);
  const canFoldDone = doneSubs.length >= SUB_DONE_PEEK;
  const doneShown = canFoldDone ? showDone ?? !foldDoneSubs(task.subtasks) : true;

  // ---------- 日期：跟 TaskCard 同一套记账 ----------

  /** 日期段落库的唯一出口。只填了时间没填日期 → 落到今天，不允许「有时间无日期」的悬空状态。
   *  第一行是兜底：不像话的日子（键盘敲年份时那几拍中间值）一个都不许进库 */
  function commitDue(dueRaw: string, time: string) {
    const due = dueRaw && !isPlausibleYMD(dueRaw) ? task.due ?? "" : dueRaw;
    const next = due || (time ? today : null);
    updateTask(task.id, { due: next, dueTime: time || null }, POPUP_WRITE);
    dueWrittenRef.current = next;
  }

  /** 关掉日期段时结算顺延，整段只算这一次。挂在 effect 的清理上而不是各个关闭入口上：
   *  关这一段的路太多（点标题栏收起、点别的属性、收抽屉、任务被删），一处处补迟早漏一条 */
  function settleDuePopup() {
    dueFieldRef.current?.flush(); // 还欠着的那一次先做掉，它也算「这一段写的」
    const before = dueAtOpenRef.current;
    const written = dueWrittenRef.current;
    dueAtOpenRef.current = null;
    dueWrittenRef.current = undefined;
    if (written === undefined) return; // 这一段一个字都没写：别处改的日期不算在这一笔上
    if (!before) return; // 打开时本来就没日期 = 从无到有，不算顺延
    if (!written) return; // 这一段把日期清了，不是顺延
    if (cmpYMD(written, before) <= 0) return; // 没往后挪
    const cur = appStore.getState().data.tasks.find((t) => t.id === taskIdRef.current);
    if (!cur) return;
    // 跟刚才那次日期写入并成同一格撤销：不然改一次日期吃掉两格（栈只有 10 格）
    updateTask(cur.id, { postponeCount: cur.postponeCount + 1 }, { coalesceKey: `task:${cur.id}:due` });
  }
  settleDueRef.current = settleDuePopup;

  useEffect(() => {
    if (seg !== "date") return;
    dueAtOpenRef.current = appStore.getState().data.tasks.find((t) => t.id === taskIdRef.current)?.due ?? "";
    dueWrittenRef.current = undefined;
    return () => settleDueRef.current();
  }, [seg]);

  /** 点预设 / 点「不要日期」：话已经说完了，刚敲了一半的那句作废，别让它一会儿回来盖掉 */
  function setDue(d: string | null) {
    dueFieldRef.current?.cancel();
    updateTask(task.id, { due: d, dueTime: d ? draftTime || task.dueTime : null }, POPUP_WRITE);
    dueWrittenRef.current = d;
  }

  function setRepeat(r: RepeatRule | null) {
    // 只写「每周一」没写日期时要带上首个落点，否则循环永不触发（跟 TaskCard 同一句）
    updateTask(task.id, { repeat: r, due: r ? task.due ?? firstOccurrence(r, today) : task.due });
  }

  // ---------- 标题 / 备注：点了原地改，「点走 = 存」 ----------

  /** v1.9 的口径：点走 = 存，Esc = 丢弃。
   *  **窗口失焦不是点走**（跟全仓一致）：那会儿框原样悬着，等人回来自己了结 */
  function commitTitle() {
    const v = titleDraft;
    setTitleDraft(null);
    if (v == null) return;
    const t = oneLine(v);
    if (t !== task.title) updateTask(task.id, { title: t });
  }

  function commitNotes() {
    const v = notesDraft;
    setNotesDraft(null);
    if (v == null || v === task.notes) return;
    updateTask(task.id, { notes: v });
  }

  /** 子任务输入框回车：把「明天 15点 !高 画趋势图」拆成标题 + 它自己的日期/时间/重要性。
   *  子任务这一处**保留**快捷语法（手机上不用背语法说的是「记一条」那张纸）。
   *  加完清空、不失焦，接着敲下一条 */
  function addSubFromInput(): boolean {
    const r = parseSubtaskInput(newSub, new Date());
    const title = r.title.trim();
    if (!title) return false;
    addSubtask(task.id, title, { due: r.due, dueTime: r.dueTime, priority: r.priority || null });
    setNewSub("");
    return true;
  }

  function toggleSeg(name: Exclude<Seg, null>) {
    setSeg((cur) => (cur === name ? null : name));
  }

  const dueText = task.due
    ? `${formatShort(task.due)}${task.dueTime ? ` ${task.dueTime}` : ""}${task.repeat ? ` · ${describeRepeat(task.repeat)}` : ""}`
    : task.repeat
      ? describeRepeat(task.repeat)
      : "没有日期";

  return (
    <>
      <div className="msh-head">
        <button
          className={`msh-cb${task.done ? " done" : ""}`}
          aria-label={task.done ? "取消完成" : "完成"}
          onClick={() => (task.done ? uncompleteTask(task.id) : completeTask(task.id))}
        />
        <div className="msh-headmain">
          {titleDraft == null ? (
            <div
              className={`msh-title${task.droppedAt ? " dropped" : ""}${task.title ? "" : " empty"}`}
              onClick={() => setTitleDraft(task.title)}
            >
              {task.title || "（未命名）"}
            </div>
          ) : (
            <textarea
              className="msh-title"
              rows={1}
              autoFocus
              ref={growArea}
              value={titleDraft}
              onChange={(e) => {
                growArea(e.currentTarget);
                setTitleDraft(e.target.value);
              }}
              // 回车 = 说完了（手机键盘上那颗是「完成」），不是往标题里塞换行
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") setTitleDraft(null); // Esc 是丢弃
              }}
              onBlur={() => {
                if (document.hasFocus()) commitTitle();
              }}
            />
          )}
          {notesDraft == null ? (
            <div className="msh-notes" onClick={() => setNotesDraft(task.notes)}>
              {task.notes || "备注…"}
            </div>
          ) : (
            <textarea
              className="msh-notes"
              rows={2}
              autoFocus
              ref={growArea}
              value={notesDraft}
              placeholder="备注…"
              onChange={(e) => {
                growArea(e.currentTarget);
                setNotesDraft(e.target.value);
              }}
              // 备注里回车照旧是换行（它就是给人写几行字的），只有 Esc 是丢弃
              onKeyDown={(e) => {
                if (e.key === "Escape") setNotesDraft(null);
              }}
              onBlur={() => {
                if (document.hasFocus()) commitNotes();
              }}
            />
          )}
          {task.droppedAt && <span className="msh-droptag">已放弃</span>}
        </div>
        <button className="msh-collapse" aria-label="收起" onClick={closeSheet}>
          <ChevronDown />
        </button>
      </div>

      <div className="msh-scroll">
        <div className="msh-subs">
          <div className="msh-sec">
            <span className="msh-sec-t">
              子任务 · {doneSubs.length}/{task.subtasks.length}
            </span>
            <span className="msh-sec-hint">左滑可放弃 / 删除</span>
          </div>
          {openSubs.map((s) => (
            <SubRow key={s.id} task={task} sub={s} today={today} />
          ))}
          {/* 添加栏排在已完成上面：做完的越攒越多，压在下面就得先滚过一堆划线的字才够得着 */}
          <div className="msh-subadd">
            <span className="msh-sb ghost" aria-hidden />
            <input
              value={newSub}
              placeholder="添加子任务，可以直接写「明天 !高」"
              enterKeyHint="done"
              onChange={(e) => setNewSub(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                e.preventDefault();
                addSubFromInput(); // 连着加下一条，焦点不走
              }}
              // 打了一半点走也算数（只打了「明天」没打标题时一条都不加，见 addSubFromInput）
              onBlur={() => {
                if (document.hasFocus()) addSubFromInput();
              }}
            />
          </div>
          {canFoldDone && (
            <button className="msh-donefold" onClick={() => setShowDone(!doneShown)}>
              {doneShown ? "收起已完成" : `显示已完成 ${doneSubs.length}`}
              <span aria-hidden>{doneShown ? "▴" : "▾"}</span>
            </button>
          )}
          {doneShown && doneSubs.map((s) => <SubRow key={s.id} task={task} sub={s} today={today} />)}
        </div>

        <div className="msh-props">
          {/* ---- 日期（连时间和循环一起，它们说的是同一件事：这件事什么时候要做） ---- */}
          <button className={`msh-prop${seg === "date" ? " open" : ""}`} onClick={() => toggleSeg("date")}>
            <IconDate />
            <span className="msh-prop-k">日期</span>
            <span className={`msh-prop-v${task.due || task.repeat ? "" : " off"}`}>{dueText}</span>
            <span className="msh-caret"><ChevronRight /></span>
          </button>
          {seg === "date" && (
            <div className="msh-seg">
              <div className="msh-row">
                {presets.map((p) => (
                  <button
                    key={p.key}
                    className={`msh-opt${task.due === p.ymd ? " on" : ""}`}
                    onClick={() => setDue(p.ymd)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="msh-row">
                <input
                  className="msh-field"
                  type="time"
                  value={draftTime || task.dueTime || ""}
                  onChange={(e) => setDraftTime(e.target.value)}
                  // 没变就不写：点预设时也会先掠过这一下失焦，白写一次会在撤销栈里多压一层。
                  // 日期取 task.due——日期框先失焦、欠着的那天已经落了库，这会儿它是最新的
                  onBlur={() => {
                    if (!document.hasFocus()) return;
                    if ((draftTime || null) !== (task.dueTime ?? null)) commitDue(task.due ?? "", draftTime);
                  }}
                />
                {/* 草稿 / 闸门 / 去抖三件套全在 DateField 里（全仓的日期框只此一个件）。
                    **不给 onDone**：选完立刻生效，但这一段留着，好接着设时间和循环 */}
                <DateField
                  ref={dueFieldRef}
                  className="msh-field date"
                  value={task.due ?? ""}
                  onCommit={(ymd) => {
                    if (ymd !== (task.due ?? "")) commitDue(ymd, draftTime || task.dueTime || "");
                  }}
                />
                <button className="msh-opt narrow" onClick={() => setDue(null)}>
                  不要
                </button>
              </div>
              <div className="msh-seg-t">重复</div>
              <div className="msh-chips">
                {repeatChoices(today, task).map((r) => (
                  <button
                    key={r.label}
                    className={`msh-opt${sameRule(task.repeat, r.rule) ? " on" : ""}`}
                    onClick={() => setRepeat(r.rule)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ---- 清单 ---- */}
          <button className={`msh-prop${seg === "list" ? " open" : ""}`} onClick={() => toggleSeg("list")}>
            <span className="msh-dot" style={{ background: list ? `var(--list-${list.color})` : "var(--ink-3)" }} />
            <span className="msh-prop-k">清单</span>
            <span className={`msh-prop-v${list ? "" : " off"}`}>{list ? list.name : "随手记"}</span>
            <span className="msh-caret"><ChevronRight /></span>
          </button>
          {seg === "list" && (
            <div className="msh-seg">
              <div className="msh-chips">
                <button
                  className={`msh-opt${task.listId ? "" : " on"}`}
                  onClick={() => updateTask(task.id, { listId: null })}
                >
                  随手记
                </button>
                {lists.map((l) => (
                  <button
                    key={l.id}
                    className={`msh-opt${task.listId === l.id ? " on" : ""}`}
                    onClick={() => updateTask(task.id, { listId: l.id })}
                  >
                    <span className="msh-dot" style={{ background: `var(--list-${l.color})` }} />
                    {l.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ---- 需求方：一件事可以挂好几个人 ---- */}
          <button className={`msh-prop${seg === "who" ? " open" : ""}`} onClick={() => toggleSeg("who")}>
            <IconWho />
            <span className="msh-prop-k">需求方</span>
            <span className={`msh-prop-v${task.who.length ? "" : " off"}`}>
              {task.who.length ? task.who.join("、") : "没指定"}
            </span>
            <span className="msh-caret"><ChevronRight /></span>
          </button>
          {seg === "who" && (
            <div className="msh-seg">
              <div className="msh-chips">
                {/* 已经挂上的排前面，点一下就是摘掉——手机上没有「悬停出现的 ×」这回事 */}
                {[...task.who, ...whoNames.filter((w) => !task.who.includes(w))].map((w) => {
                  const on = task.who.includes(w);
                  return (
                    <button
                      key={w}
                      className={`msh-opt${on ? " on" : ""}`}
                      onClick={() => (on ? removeTaskWho(task.id, w) : addTasksWho([task.id], w))}
                    >
                      {w}
                    </button>
                  );
                })}
                {task.who.length > 0 && (
                  <button className="msh-opt" onClick={() => setTasksWho([task.id], [])}>
                    全部清除
                  </button>
                )}
              </div>
              <input
                className="msh-field wide"
                placeholder="新需求方，回车确定"
                enterKeyHint="done"
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  const el = e.currentTarget;
                  const v = el.value.trim();
                  if (v) addTasksWho([task.id], v);
                  el.value = ""; // 非受控：落完自己清，留在原地接着加下一个
                }}
              />
            </div>
          )}

          {/* ---- 重要性 + 标签：两个都短，并排一行 ---- */}
          <div className="msh-pair">
            <button className={`msh-prop${seg === "prio" ? " open" : ""}`} onClick={() => toggleSeg("prio")}>
              <span className={`flag p${task.priority}`} />
              <span className={`msh-prop-v${task.priority ? "" : " off"}`}>{PRIO_NAME[task.priority]}</span>
            </button>
            <button className={`msh-prop${seg === "tags" ? " open" : ""}`} onClick={() => toggleSeg("tags")}>
              <span aria-hidden>#</span>
              <span className={`msh-prop-v${task.tags.length ? "" : " off"}`}>
                {task.tags.length ? task.tags.join("、") : "标签"}
              </span>
            </button>
          </div>
          {seg === "prio" && (
            <div className="msh-seg">
              <div className="msh-row">
                {([3, 2, 1, 0] as Priority[]).map((p) => (
                  <button
                    key={p}
                    className={`msh-opt${task.priority === p ? " on" : ""}`}
                    onClick={() => updateTask(task.id, { priority: p })}
                  >
                    <span className={`flag p${p}`} />
                    {PRIO_NAME[p]}
                  </button>
                ))}
              </div>
            </div>
          )}
          {seg === "tags" && (
            <div className="msh-seg">
              <div className="msh-chips">
                {[...task.tags, ...tagNames.filter((t) => !task.tags.includes(t))].map((t) => {
                  const on = task.tags.includes(t);
                  return (
                    <button
                      key={t}
                      className={`msh-opt${on ? " on" : ""}`}
                      onClick={() =>
                        updateTask(task.id, { tags: on ? task.tags.filter((x) => x !== t) : [...task.tags, t] })
                      }
                    >
                      #{t}
                    </button>
                  );
                })}
              </div>
              <input
                className="msh-field wide"
                placeholder="新标签，回车确定"
                enterKeyHint="done"
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  const el = e.currentTarget;
                  const v = el.value.trim().replace(/^#/, "");
                  if (v && !task.tags.includes(v)) updateTask(task.id, { tags: [...task.tags, v] });
                  el.value = "";
                }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="msh-foot">
        <button
          className="msh-drop"
          onClick={() => dropTasks([task.id], !task.droppedAt)}
        >
          {task.droppedAt ? (
            <>↩ 取消放弃</>
          ) : (
            <>
              <IconDrop />
              放弃这件事
            </>
          )}
        </button>
        <button
          className={`msh-del${armed ? " armed" : ""}`}
          aria-label={armed ? "确认删除" : "删除"}
          onClick={() => {
            if (!armed) {
              // 第一下只是「举起手」：3 秒没有第二下就自己放下，免得这颗键一直红着吓人
              setArmed(true);
              if (armTimer.current) clearTimeout(armTimer.current);
              armTimer.current = setTimeout(() => setArmed(false), 3000);
              return;
            }
            deleteTasks([task.id]);
            closeSheet();
          }}
        >
          {armed ? "真的删？" : <IconTrash />}
        </button>
      </div>
    </>
  );
}

/** 一条子任务：22px 圆角方框 + 标题 + 右边的日期，整行能左滑露出「放弃 / 删除」。
 *
 *  **必须是模块级组件**，不能写成组件体内的局部函数：useSwipeRow 是个 hook，一行得有一份
 *  自己的手势状态；而写在 render 里每次都是个新组件类型，React 会把行整个卸载重建——
 *  滑到一半的位移和正在改的标题都会当场没掉 */
function SubRow({ task, sub, today }: { task: Task; sub: Subtask; today: string }) {
  const sw = useSwipeRow({ leftWidth: SUB_ACTIONS_W });
  /** 原地改标题的草稿。null = 没在改 */
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    const v = draft;
    setDraft(null);
    if (v == null) return;
    const t = oneLine(v).trim();
    if (t && t !== sub.title) updateSubtask(task.id, sub.id, { title: t });
  }

  // 有自己日期的照自己的显示，没有的淡着显示母任务那天——一眼看得出这条到底哪天要做
  const own = sub.due ?? null;
  const shownDue = own ?? task.due ?? null;
  const overdue = !!shownDue && !sub.done && !sub.droppedAt && cmpYMD(shownDue, today) < 0;

  return (
    <div className={`swipe-wrap msh-subwrap${sub.done ? " done" : ""}${sw.state === "dragging" ? " dragging" : ""}`}>
      <div className="swipe-under left">
        <button
          className="swipe-act drop"
          onClick={() => {
            sw.close();
            dropSubtask(task.id, sub.id, !sub.droppedAt);
          }}
        >
          <span aria-hidden>{sub.droppedAt ? "↩" : "⊘"}</span>
          {sub.droppedAt ? "取消" : "放弃"}
        </button>
        <button
          className="swipe-act delete"
          onClick={() => {
            sw.close();
            removeSubtask(task.id, sub.id);
          }}
        >
          <span aria-hidden>🗑</span>
          删除
        </button>
      </div>
      <div className="swipe-body msh-sub" style={dxStyle(sw.dx)} {...sw.bind}>
        <button
          className={`msh-sb${sub.done ? " done" : ""}`}
          aria-label={sub.done ? "取消完成" : "完成"}
          onClick={() => toggleSubtask(task.id, sub.id)}
        />
        {draft == null ? (
          <button className="msh-subtitle" onClick={() => setDraft(sub.title)}>
            {sub.title || "（未命名）"}
          </button>
        ) : (
          <input
            className="msh-subtitle"
            autoFocus
            value={draft}
            enterKeyHint="done"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
              if (e.key === "Escape") setDraft(null); // Esc 是丢弃
            }}
            onBlur={() => {
              if (document.hasFocus()) commit();
            }}
          />
        )}
        {sub.droppedAt && <span className="msh-droptag">已放弃</span>}
        {shownDue && (
          <span className={`msh-subdate${own ? " own" : ""}${overdue ? " over" : ""}`}>{formatShort(shownDue)}</span>
        )}
      </div>
    </div>
  );
}

/** 跟手的位移交给 CSS 变量（mobile.css 里 .swipe-body 读 --dx）。
 *  自定义属性不在 CSSProperties 的字段表里，只能在这一处绕一下类型，别散着写 */
function dxStyle(dx: number): CSSProperties {
  return { "--dx": `${dx}px` } as unknown as CSSProperties;
}

/** 循环选项：「每周X / 每月N号」按这件事自己的日子取形（没日子就按今天）。
 *  星期几走 core/dates.dayOfWeek——'YYYY-MM-DD' 交给 new Date() 会按 UTC 解析，
 *  东八区的凌晨会算成前一天 */
function repeatChoices(today: string, task: Task): { label: string; rule: RepeatRule | null }[] {
  const base = task.due ?? today;
  const wd = dayOfWeek(base);
  const dom = Number(base.slice(8, 10));
  return [
    { label: "不重复", rule: null },
    { label: "每天", rule: { kind: "daily", every: 1 } },
    { label: "每个工作日", rule: { kind: "workday" } },
    { label: describeRepeat({ kind: "weekly", days: [wd] }), rule: { kind: "weekly", days: [wd] } },
    { label: `每月${dom}号`, rule: { kind: "monthly", day: dom } },
  ];
}

function sameRule(a: RepeatRule | null, b: RepeatRule | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---------- 图标：跟设计稿同一套线条（stroke 走 currentColor，六主题自动跟着走） ----------

function ChevronDown() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function IconDate() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <rect x="4" y="5" width="16" height="15" rx="3" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </svg>
  );
}

function IconWho() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 20c1.5-4 4-6 7-6s5.5 2 7 6" />
    </svg>
  );
}

function IconDrop() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 17.5l11-11" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12" />
    </svg>
  );
}
