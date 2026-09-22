// 习惯：一级分类，跟任务分开住。
//
// 这一屏只回答三个问题：今天还有哪几个没打卡、连着做了多久、这周做得怎么样。
// 所以主体是一行一个习惯 + 一个大打卡圈 + 连续天数 + 本周七格，点开才看月历和更多。
//
// 刻意不做的：习惯不排期、不逾期、不进今天/计划。昨天没做就是没做，
// 不该滚成一笔债堵在今天——那是任务的逻辑，不是习惯的逻辑。
//
// 2026-09-21 用户：「习惯展示的是所有的不是今日的」——这一页不许只剩「今天要做的」。
// 三组：今天要做的（习惯）/ 重复的计划（所有带循环的计划，按下一次排，core/repeating）/
// 今天不用做（习惯，按下一次排）。每一行右边都写下一次是哪天。
// 重复的计划那几行就是计划页那一行（桌面 TaskRow + 内嵌任务卡，手机 MobileRow + 任务纸），
// 勾完成走循环任务原有的「推到下一次」，这里一行逻辑都不另写

import { useEffect, useMemo, useRef, useState } from "react";
import type { RepeatRule, Task } from "../core/model";
import { describeRepeat } from "../core/recur";
import RepeatMenu from "../components/RepeatMenu";
import RepeatPicker from "../components/RepeatPicker";
import { useLeaving } from "../components/motion";
import { repeatingRows } from "../core/repeating";
import { addDays, dayOfWeek, formatCN, monthStart, todayYMD } from "../core/dates";
import {
  addHabit, aliveHabits, deleteTasks, rowTaskIds, setHabitRepeat, setTaskKind,
  toggleHabitCheck, updateTask, useApp,
} from "../core/store";
import {
  bestStreak, describeHabitRule, describeNextDay, doneOn, habitRepeatMenu, habitRule, isDueOn, monthMarks, nextHabitDay,
  recentRate, sortHabitsByNext, sortHabitsForDay, streak, weekMarks, type DayMark,
} from "../core/habits";
import RowList, { cardAnchor, type FoldPlan } from "../components/RowList";
import { CommitMark, useCommitFlash, useTypingFlash } from "../components/commitFlash";
import { isMobile } from "../core/platform";
import MobileHead from "../mobile/MobileHead";
import { openSheet } from "../mobile/sheetStore";
import "../styles/habits.css";
import "../styles/mobile-pages.css";

const WEEK_LABEL = ["一", "二", "三", "四", "五", "六", "日"];

/** 重复的计划那一组不折叠子任务链：每一行都是一条独立的循环，收起来就看不见它哪天来了 */
const NO_FOLD: FoldPlan = { hidden: new Set(), more: new Map(), head: new Set(), total: new Map() };

/** 行尾那句「下次 周三」。今天该做还没打的不写——它就在「今天要做的」那一组里，再写一遍「今天」是噪音 */
function nextText(habit: Task, today: string): string | null {
  const next = nextHabitDay(habit, today);
  if (!next || next === today) return null;
  return `下次 ${describeNextDay(next, today)}`;
}

/** 习惯的周期选择（桌面：新建那一行、习惯详情里各一个）。09-21 统一口径：
 *  选项跟任务的「↻ 循环」是同一份（core/habits.habitRepeatMenu ← core/options.repeatMenu），
 *  画法也是同一个 RepeatMenu / RepeatPicker，只是习惯没有日期（每周X / 每月X号按今天算）、没有「不重复」。
 *  用户原话：「习惯界面每天、每个工作日、每月、每N天（手动输入）、日历自行勾选」。
 *  现有周期（每周一三五、每 2 天……）不在常用项里时挂在最上面打勾，不会被改掉 */
function HabitRulePick({ value, onPick, className }: {
  value: RepeatRule;
  onPick: (rule: RepeatRule) => void;
  className?: string;
}) {
  const today = todayYMD();
  const [open, setOpen] = useState(false);
  /** 菜单现在是常用项（false）还是「自定义…」面板（true） */
  const [custom, setCustom] = useState(false);
  const pop = useLeaving(open ? true : null);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // 点别处 / Esc 收起
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(rule: RepeatRule) {
    onPick(rule);
    setOpen(false);
  }

  return (
    <span className="hb-rule-slot" ref={wrapRef}>
      <button
        type="button"
        className={`input hb-rule-pick${className ? ` ${className}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        // 每次点开都先回到常用项那一页，不停在上回的自定义面板上
        onClick={() => { setCustom(false); setOpen(!open); }}
      >
        {describeRepeat(value)}
        <span className="hb-rule-caret">▾</span>
      </button>
      {pop.shown && (
        <div className={`popmenu hb-rule-pop${pop.leaving ? " leaving" : ""}`}>
          {custom ? (
            <RepeatPicker value={value} anchor={today} onDone={pick} onCancel={() => setCustom(false)} />
          ) : (
            <RepeatMenu
              anchor={today}
              value={value}
              items={habitRepeatMenu(today, value)}
              onPick={(r) => r && pick(r)}
              onCustom={() => setCustom(true)}
            />
          )}
        </div>
      )}
    </span>
  );
}

function markTitle(mark: DayMark, ymd: string): string {
  const when = formatCN(ymd);
  switch (mark) {
    case "done": return `${when} 做了`;
    case "missed": return `${when} 没做`;
    case "todo": return `${when} 今天还没做`;
    case "off": return `${when} 不用做`;
    case "future": return when;
  }
}

/** 本周七格。周一在左，今天有个圈 */
function WeekStrip({ habit, today }: { habit: Task; today: string }) {
  const marks = weekMarks(habit, today);
  return (
    <span className="hb-week">
      {marks.map((m, i) => (
        <button
          key={m.ymd}
          className={`hb-dot ${m.mark}${m.ymd === today ? " now" : ""}`}
          title={`${WEEK_LABEL[i]} · ${markTitle(m.mark, m.ymd)}${m.mark === "off" ? "" : "（点一下可以补打/取消）"}`}
          disabled={m.mark === "future" || m.mark === "off"}
          onClick={(e) => {
            e.stopPropagation();
            // 补打昨天的卡是刚需——晚上忘了记，第二天想补上
            toggleHabitCheck(habit.id, m.ymd);
          }}
        />
      ))}
    </span>
  );
}

function HabitRow({ habit, today, expanded, onToggleExpand }: {
  habit: Task;
  today: string;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const due = isDueOn(habit, today);
  const done = doneOn(habit, today);
  const n = streak(habit, today);
  const next = nextText(habit, today);

  return (
    <div className={`hb-row${done ? " done" : ""}${due ? "" : " off"}${expanded ? " open" : ""}`}>
      <div className="hb-head" onClick={onToggleExpand}>
        <button
          className={`hb-check${done ? " on" : ""}`}
          title={done ? "撤销今天的打卡" : due ? "打卡" : "今天不在计划内，也可以补打一次"}
          onClick={(e) => {
            e.stopPropagation();
            toggleHabitCheck(habit.id, today);
          }}
        >
          {done ? "✓" : ""}
        </button>
        <span className="hb-title">{habit.title || "（未命名）"}</span>
        <span className="hb-rule">{describeHabitRule(habit)}</span>
        {n > 0 && (
          <span className="hb-streak" title={`已连续 ${n} 次`}>
            🔥 {n}
          </span>
        )}
        {next && <span className="hb-next">{next}</span>}
        <WeekStrip habit={habit} today={today} />
      </div>
      {expanded && <HabitDetail habit={habit} today={today} />}
    </div>
  );
}

/** 最近 7 天（含今天），从早到晚。手机那一行右边的七个小点用它。
 *  跟桌面那条「本周七格」不是一回事：本周七格周一在左，月初打开只剩一两天可看；
 *  「最近 7 天」不管今天周几，右起第一个永远是今天 */
function recentMarks(habit: Task, today: string): { ymd: string; done: boolean }[] {
  const out: { ymd: string; done: boolean }[] = [];
  for (let i = 6; i >= 0; i--) {
    const ymd = addDays(today, -i);
    out.push({ ymd, done: doneOn(habit, ymd) });
  }
  return out;
}

/** 手机上的一行习惯（v1.11.2）：打卡圈 · 名字 + 一行小字 · 最近七天。
 *
 *  桌面那套（标题 / 周期 / 连续 / 本周七格全挤在一行，点开还长出月历和一堆输入框）
 *  在 390px 上会被 habits.css 的窄屏规则折成两行半——用户说的「比例不对」就是这个。
 *  这里**绝不折行**：中间那块 flex:1 + min-width:0，长名字自己收成省略号，
 *  左右两头都是定死的宽度，360px 上也是一行。
 *  改名字、改周期、删除全在「点一行拉出来的那张纸」里（mobile/HabitSheet），页面上不摆控件 */
function MobileHabitRow({ habit, today }: { habit: Task; today: string }) {
  const due = isDueOn(habit, today);
  const done = doneOn(habit, today);
  const n = streak(habit, today);
  const next = nextText(habit, today);

  return (
    <div className={`mhb-row${done ? " done" : ""}${due ? "" : " off"}`}>
      <button
        className={`mhb-cb${done ? " on" : ""}`}
        // 今天不用做的圈灰着、按不动：按下去会打出一次「计划外」的卡，
        // 而这一页正在说的是「今天该做哪几个」
        disabled={!due}
        title={done ? "撤销今天的打卡" : due ? "打卡" : "今天不用做"}
        aria-label={done ? `撤销「${habit.title}」今天的打卡` : `给「${habit.title}」打卡`}
        onClick={() => toggleHabitCheck(habit.id, today)}
      />
      <button className="mhb-main" onClick={() => openSheet({ kind: "habit", id: habit.id })}>
        <span className="mhb-title">{habit.title || "（未命名）"}</span>
        <span className="mhb-meta">
          {describeHabitRule(habit)}
          {/* 连续 0 次不摆那颗火：它是给「已经连着做了一阵」的人看的，从 0 开始数只是噪音 */}
          {n > 0 && <span className="mhb-streak"> · 🔥 {n}</span>}
        </span>
      </button>
      {/* 右边一列：上面一行「下次 周三」，下面最近七天。宽度由七个点定死，小字右对齐落在点的上方 */}
      <span className="mhb-side">
        {next && <span className="mhb-next">{next}</span>}
        <span className="mhb-dots" aria-hidden>
          {recentMarks(habit, today).map((m) => (
            <span key={m.ymd} className={`mhb-dot${m.done ? " on" : ""}${m.ymd === today ? " now" : ""}`} />
          ))}
        </span>
      </span>
    </div>
  );
}

function HabitDetail({ habit, today }: { habit: Task; today: string }) {
  const [month, setMonth] = useState(() => monthStart(today));
  // 习惯名和备注也是逐键落库、零提示（A7）：停手半秒闪一下，跟任务卡那边一个规矩
  const titleFlash = useTypingFlash(habit.title);
  const notesFlash = useTypingFlash(habit.notes);
  const marks = monthMarks(habit, month, today);
  const rate = recentRate(habit, 30, today);
  const best = bestStreak(habit);
  // 月历第一天前面留几个空格，让它对齐到周一
  const lead = (dayOfWeek(marks[0].ymd) + 6) % 7;

  return (
    <div className="hb-detail" onClick={(e) => e.stopPropagation()}>
      <div className="hb-stats">
        <span><b>{streak(habit, today)}</b> 当前连续</span>
        <span><b>{best}</b> 最长连续</span>
        <span><b>{habit.checkIns.length}</b> 累计</span>
        <span>
          {rate ? (
            <>
              <b>{Math.round((rate.done / rate.due) * 100)}%</b> 近 30 天
            </>
          ) : (
            <span className="hb-dim">近 30 天没到日子</span>
          )}
        </span>
      </div>

      <div className="hb-month">
        <div className="hb-month-head">
          <button onClick={() => setMonth(monthStart(addDays(month, -1)))}>‹</button>
          <span>{month.slice(0, 4)} 年 {Number(month.slice(5, 7))} 月</span>
          <button
            onClick={() => setMonth(monthStart(addDays(month, 32)))}
            disabled={month >= monthStart(today)}
          >
            ›
          </button>
        </div>
        <div className="hb-grid">
          {WEEK_LABEL.map((w) => (
            <span key={w} className="hb-grid-label">{w}</span>
          ))}
          {Array.from({ length: lead }, (_, i) => (
            <span key={`pad${i}`} />
          ))}
          {marks.map((m) => (
            <button
              key={m.ymd}
              className={`hb-cell ${m.mark}${m.ymd === today ? " now" : ""}`}
              title={markTitle(m.mark, m.ymd)}
              disabled={m.mark === "future"}
              onClick={() => toggleHabitCheck(habit.id, m.ymd)}
            >
              {Number(m.ymd.slice(8, 10))}
            </button>
          ))}
        </div>
      </div>

      <div className="hb-edit">
        <input
          className={`input${titleFlash ? " commit-lit" : ""}`}
          value={habit.title}
          placeholder="习惯名"
          onChange={(e) => updateTask(habit.id, { title: e.target.value })}
        />
        <CommitMark on={titleFlash} />
        {/* 现有周期不在常用项里（比如从任务转过来的每月 8 号）也显示得出来：挂在菜单最上面打勾 */}
        <HabitRulePick
          value={habitRule(habit)}
          onPick={(r) => setHabitRepeat(habit.id, r)}
        />
      </div>
      {/* 包一层只为给回执的「✓」一个落脚点，跟任务卡的备注同一个写法 */}
      <div className="hb-notes-wrap">
        <textarea
          className={`hb-notes${notesFlash ? " commit-lit" : ""}`}
          placeholder="备注…"
          value={habit.notes}
          rows={habit.notes ? undefined : 1}
          onChange={(e) => updateTask(habit.id, { notes: e.target.value })}
        />
        {notesFlash && <span className="commit-ok hb-notes-ok">✓</span>}
      </div>
      <div className="hb-actions">
        <button
          className="btn ghost"
          title="打卡记录会清空，这件事本身保留为一条普通任务"
          onClick={() => setTaskKind(habit.id, "task")}
        >
          转成普通任务
        </button>
        <button className="btn danger" onClick={() => deleteTasks([habit.id])}>
          删除习惯
        </button>
      </div>
    </div>
  );
}

export default function Habits() {
  const data = useApp((s) => s.data);
  const today = todayYMD();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftRule, setDraftRule] = useState<RepeatRule>({ kind: "daily", every: 1 });
  const addFlash = useCommitFlash();

  const expandedTask = useApp((s) => s.ui.expandedId);
  const habits = useMemo(() => sortHabitsForDay(aliveHabits(data), today), [data, today]);
  const dueToday = habits.filter((h) => isDueOn(h, today));
  // 今天不用做的按「下一次」先后排：明天就轮到的在上
  const restToday = useMemo(
    () => sortHabitsByNext(habits.filter((h) => !isDueOn(h, today)), today),
    [habits, today],
  );
  const doneCount = dueToday.filter((h) => doneOn(h, today)).length;
  // 所有带循环的计划，不看今天（core/repeating）。行尾显示的日期就是它的下一次
  const planRows = useMemo(() => repeatingRows(data), [data]);
  const planIds = rowTaskIds(planRows);
  const planAnchor = cardAnchor(planRows, expandedTask);
  const nothing = habits.length === 0 && planRows.length === 0;

  function create() {
    const title = draft.trim();
    if (!title) return;
    const id = addHabit({ title, repeat: draftRule });
    setDraft("");
    addFlash.flash();
    setExpandedId(id);
  }

  // 副标题**同一份喂给两边**：分成两处写，早晚有一边的口径跟另一边对不上
  const sub =
    nothing
      ? "需要反复做的事放在这里，每天打卡"
      : habits.length === 0
        ? `${planIds.length} 件重复的计划`
      : dueToday.length === 0
        ? "今天没有要打卡的习惯"
        : doneCount === dueToday.length
          ? `今天的 ${dueToday.length} 个已全部打卡`
          : `今天 ${doneCount}/${dueToday.length}`;

  return (
    <section className="main">
      {/* 手机上必须走 MobileHead：顶部安全区只在它那儿留了一份。
          v1.11.0 这一页还挂着桌面那个 .view-head，而手机上 .main 的内边距是 0——
          标题直接顶到系统状态栏底下（用户真机截图点名的就是这一条） */}
      {isMobile ? (
        <MobileHead
          title="习惯"
          // 一个习惯都没有时这一行不写：底下那张空态卡说的就是这句话，
          // 同一句话在一屏里出现两遍，看着像是页面坏了
          sub={nothing ? "" : sub}
          // 打卡进度也用同一个环：跟「今天」一个形制，扫一眼就知道今天还欠几个
          ring={{ done: doneCount, total: dueToday.length }}
        />
      ) : (
        <div className="view-head">
          <h1>习惯</h1>
          <span className="sub">{sub}</span>
        </div>
      )}

      {/* 手机上是另一副身板：没有那张「输入框 + 周期下拉 + 加上」的横条（390px 排不下，
          v1.11.1 真机上它被折成两行半），加习惯走右下角那颗 ＋。桌面那一整块一个字没动。
          形制**跟「今天」一模一样**，这是死约定：v1.15.0 今天页从「一组一张长卡」改成
          「一件事一张卡」，这一页当天跟着改（样式在 mobile-pages.css 的 .mhb-card / .mhb-row）。
          哪天今天页再变形，这一页必须同一天跟上——不跟就是两副长相，切一下页签就看得出来。
          习惯名仍然一行省略号：这一页的名字本来就短，折行只会让一屏看得更少 */}
      {isMobile ? (
        <div className="view-body mhb-body">
          {dueToday.length > 0 && (
            <>
              <div className="group-head">今天要做的 {doneCount}/{dueToday.length}</div>
              <div className="mcard mhb-card">
                {dueToday.map((h) => (
                  <MobileHabitRow key={h.id} habit={h} today={today} />
                ))}
              </div>
            </>
          )}

          {planRows.length > 0 && (
            <>
              <div className="group-head">重复的计划</div>
              <RowList rows={planRows} fold={NO_FOLD} anchor={null} orderedIds={planIds} />
            </>
          )}

          {restToday.length > 0 && (
            <>
              <div className="group-head">今天不用做</div>
              <div className="mcard mhb-card">
                {restToday.map((h) => (
                  <MobileHabitRow key={h.id} habit={h} today={today} />
                ))}
              </div>
            </>
          )}

          {nothing && (
            <div className="mcard mhb-blank">
              需要反复做的事放在这里，每天打卡。点右下角的 ＋ 加一个。
            </div>
          )}
        </div>
      ) : (
      <div className="view-body hb-body">
        <div className="hb-add">
          <span className="plus">＋</span>
          <input
            className={`hb-add-input${addFlash.on ? " commit-lit" : ""}`}
            placeholder="加一个习惯，比如「喝水 2L」"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) create();
              // Esc 才是丢弃
              if (e.key === "Escape" && draft) {
                e.stopPropagation();
                setDraft("");
              }
            }}
            // A1：点走 = 提交。但**点旁边那个周期下拉和「加上」按钮不算点走**——
            // 那一下正是在给这个习惯挑周期，抢先建了反而拿的是默认周期
            // **窗口失焦也不算点走**：alt-tab 去别的程序时浏览器照样发 blur，
            // 抢着建出一个打了一半名字的习惯、还顺手跳过去展开它
            onBlur={(e) => {
              if (!document.hasFocus()) return;
              const next = e.relatedTarget as Node | null;
              if (next && e.currentTarget.parentElement?.contains(next)) return;
              create();
            }}
          />
          <CommitMark on={addFlash.on} />
          <HabitRulePick className="hb-add-rule" value={draftRule} onPick={setDraftRule} />
          <button className="btn primary" disabled={!draft.trim()} onClick={create}>
            加上
          </button>
        </div>

        {dueToday.length > 0 && (
          <>
            <div className="group-head">今天要做的 {doneCount}/{dueToday.length}</div>
            {dueToday.map((h) => (
              <HabitRow
                key={h.id}
                habit={h}
                today={today}
                expanded={expandedId === h.id}
                onToggleExpand={() => setExpandedId(expandedId === h.id ? null : h.id)}
              />
            ))}
          </>
        )}

        {planRows.length > 0 && (
          <>
            <div className="group-head">重复的计划</div>
            {/* 就是计划页那一行：点开是同一张任务卡，勾完成推到下一次 */}
            <RowList rows={planRows} fold={NO_FOLD} anchor={planAnchor} orderedIds={planIds} />
          </>
        )}

        {restToday.length > 0 && (
          <>
            <div className="group-head">今天不用做</div>
            {restToday.map((h) => (
              <HabitRow
                key={h.id}
                habit={h}
                today={today}
                expanded={expandedId === h.id}
                onToggleExpand={() => setExpandedId(expandedId === h.id ? null : h.id)}
              />
            ))}
          </>
        )}

        {nothing && (
          <div className="empty">还没有习惯，在上面加一个。带循环的计划也会列在这里。</div>
        )}
      </div>
      )}
    </section>
  );
}
