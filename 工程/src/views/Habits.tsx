// 习惯：一级分类，跟任务分开住。
//
// 这一屏只回答三个问题：今天还有哪几个没打卡、连着做了多久、这周做得怎么样。
// 所以主体是一行一个习惯 + 一个大打卡圈 + 连续天数 + 本周七格，点开才看月历和更多。
//
// 刻意不做的：习惯不排期、不逾期、不进今天/计划。昨天没做就是没做，
// 不该滚成一笔债堵在今天——那是任务的逻辑，不是习惯的逻辑。

import { useMemo, useState } from "react";
import type { RepeatRule, Task } from "../core/model";
import { addDays, dayOfWeek, formatCN, monthStart, todayYMD } from "../core/dates";
import {
  addHabit, aliveHabits, deleteTasks, setHabitRepeat, setTaskKind,
  toggleHabitCheck, updateTask, useApp,
} from "../core/store";
import {
  bestStreak, describeHabitRule, doneOn, isDueOn, monthMarks, recentRate,
  sortHabitsForDay, streak, weekMarks, type DayMark,
} from "../core/habits";
import { CommitMark, useCommitFlash, useTypingFlash } from "../components/commitFlash";
import { isMobile } from "../core/platform";
import MobileHead from "../mobile/MobileHead";
import "../styles/habits.css";

const WEEK_LABEL = ["一", "二", "三", "四", "五", "六", "日"];

const RULE_CHOICES: { label: string; rule: RepeatRule }[] = [
  { label: "每天", rule: { kind: "daily", every: 1 } },
  { label: "每个工作日", rule: { kind: "workday" } },
  { label: "每周一三五", rule: { kind: "weekly", days: [1, 3, 5] } },
  { label: "每周二四六", rule: { kind: "weekly", days: [2, 4, 6] } },
  { label: "每 2 天", rule: { kind: "daily", every: 2 } },
  { label: "每 3 天", rule: { kind: "daily", every: 3 } },
];

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
        <WeekStrip habit={habit} today={today} />
      </div>
      {expanded && <HabitDetail habit={habit} today={today} />}
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
        <select
          className="input"
          value={JSON.stringify(habit.repeat)}
          onChange={(e) => setHabitRepeat(habit.id, JSON.parse(e.target.value) as RepeatRule)}
        >
          {RULE_CHOICES.map((c) => (
            <option key={c.label} value={JSON.stringify(c.rule)}>{c.label}</option>
          ))}
          {/* 现有周期不在预设里（比如从任务转过来的每月 8 号）也要显示得出来 */}
          {!RULE_CHOICES.some((c) => JSON.stringify(c.rule) === JSON.stringify(habit.repeat)) && (
            <option value={JSON.stringify(habit.repeat)}>{describeHabitRule(habit)}</option>
          )}
        </select>
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

  const habits = useMemo(() => sortHabitsForDay(aliveHabits(data), today), [data, today]);
  const dueToday = habits.filter((h) => isDueOn(h, today));
  const restToday = habits.filter((h) => !isDueOn(h, today));
  const doneCount = dueToday.filter((h) => doneOn(h, today)).length;

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
    habits.length === 0
      ? "需要反复做的事放在这里，每天打卡"
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
          sub={sub}
          // 打卡进度也用同一个环：跟「今天」一个形制，扫一眼就知道今天还欠几个
          ring={{ done: doneCount, total: dueToday.length }}
        />
      ) : (
        <div className="view-head">
          <h1>习惯</h1>
          <span className="sub">{sub}</span>
        </div>
      )}

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
          <select
            className="input hb-add-rule"
            value={JSON.stringify(draftRule)}
            onChange={(e) => setDraftRule(JSON.parse(e.target.value) as RepeatRule)}
          >
            {RULE_CHOICES.map((c) => (
              <option key={c.label} value={JSON.stringify(c.rule)}>{c.label}</option>
            ))}
          </select>
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

        {habits.length === 0 && (
          <div className="empty">还没有习惯，在上面加一个。</div>
        )}
      </div>
    </section>
  );
}
