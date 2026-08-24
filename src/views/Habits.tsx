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
          title={done ? "点一下撤销今天的打卡" : due ? "打卡" : "今天本来不用做，也可以记一笔"}
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
          <span className="hb-streak" title={`连续 ${n} 次没断过`}>
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
          className="input"
          value={habit.title}
          placeholder="习惯名"
          onChange={(e) => updateTask(habit.id, { title: e.target.value })}
        />
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
      <textarea
        className="hb-notes"
        placeholder="备注…（为什么想养成它？）"
        value={habit.notes}
        rows={habit.notes ? undefined : 1}
        onChange={(e) => updateTask(habit.id, { notes: e.target.value })}
      />
      <div className="hb-actions">
        <button
          className="btn ghost"
          title="打卡记录会清空，事情本身留下来变成一条普通待办"
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

  const habits = useMemo(() => sortHabitsForDay(aliveHabits(data), today), [data, today]);
  const dueToday = habits.filter((h) => isDueOn(h, today));
  const restToday = habits.filter((h) => !isDueOn(h, today));
  const doneCount = dueToday.filter((h) => doneOn(h, today)).length;

  function create() {
    const title = draft.trim();
    if (!title) return;
    const id = addHabit({ title, repeat: draftRule });
    setDraft("");
    setExpandedId(id);
  }

  return (
    <section className="main">
      <div className="view-head">
        <h1>习惯</h1>
        <span className="sub">
          {habits.length === 0
            ? "重复着做的事放这儿，每天勾一下"
            : dueToday.length === 0
              ? "今天一个都不用做，歇着"
              : doneCount === dueToday.length
                ? `今天的 ${dueToday.length} 个都打过卡了 🌰`
                : `今天 ${doneCount}/${dueToday.length}`}
        </span>
      </div>

      <div className="view-body hb-body">
        <div className="hb-add">
          <span className="plus">＋</span>
          <input
            className="hb-add-input"
            placeholder="加一个习惯，比如「喝水 2L」"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) create();
            }}
          />
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
          <div className="empty">
            <span className="glyph">🌱</span>
            还没有习惯。上面加一个——每天做一点的事最适合放这儿。
          </div>
        )}
      </div>
    </section>
  );
}
