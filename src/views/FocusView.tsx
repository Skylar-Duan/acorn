// 专注：应用内的大计时器。状态源是 store 的 s.focus（与迷你浮窗共用），控制走 focusCtl。
import { useEffect, useMemo, useState } from "react";
import type { FocusSession } from "../core/model";
import { pad2, todayYMD } from "../core/dates";
import { aliveTasks, tasksForToday, useApp } from "../core/store";
import { pauseFocus, resumeFocus, startFocus, stopFocus } from "../core/focusCtl";
import "../styles/focusview.css";

const MIN_CHOICES = [15, 25, 45, 60];

/** 剩余毫秒 -> 'MM:SS'（向上取整，起点即满 25:00） */
function fmtRemain(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
}

/** ISO -> 'HH:mm'（本地） */
function fmtStart(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export default function FocusView() {
  const data = useApp((s) => s.data);
  const focus = useApp((s) => s.focus);
  const today = todayYMD();

  // 空闲态的两个选择：挂哪个任务、专注多久
  const [pickId, setPickId] = useState("");
  const [minutes, setMinutes] = useState(() => data.settings.focusMinutesDefault);

  // 计时中每 500ms 触发一次重渲染，用 endsAt 现算剩余
  const [, force] = useState(0);
  useEffect(() => {
    if (!focus.running) return;
    const t = setInterval(() => force((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [focus.running]);

  // totalMinutes>0 表示一轮尚未结束（含暂停）；结束/完成时 focusCtl 会清零
  const active = focus.running || focus.totalMinutes > 0;
  // 暂停约定：endsAt 为 null 且这一轮还在 → 视为暂停
  const paused = active && !focus.running;

  // 候选任务：今天未完成（逾期置前，母任务本身）+ 收件箱前 10 条（去掉与今天重复的）
  const { todayTasks, inbox } = useMemo(() => {
    const { overdue, todays } = tasksForToday(data, today);
    const tt = [...overdue, ...todays].filter((r) => !r.sub).map((r) => r.task);
    const seen = new Set(tt.map((t) => t.id));
    const ib = aliveTasks(data)
      .filter((t) => !t.done && t.listId === null && !seen.has(t.id))
      .sort((a, b) => a.order - b.order)
      .slice(0, 10);
    return { todayTasks: tt, inbox: ib };
  }, [data, today]);

  // 选中的任务可能中途被完成/删除——兜底回「纯计时」
  const chosen =
    todayTasks.some((t) => t.id === pickId) || inbox.some((t) => t.id === pickId) ? pickId : "";

  const curTask = focus.taskId ? data.tasks.find((t) => t.id === focus.taskId) : null;
  const remainMs = focus.running && focus.endsAt ? Math.max(0, focus.endsAt - Date.now()) : 0;

  const todaySessions = useMemo(() => data.sessions.filter((s) => s.date === today), [data, today]);
  const totalMin = todaySessions.reduce((sum, s) => sum + s.minutes, 0);

  const sessionName = (s: FocusSession) =>
    s.taskId ? (data.tasks.find((t) => t.id === s.taskId)?.title ?? "（已删除的任务）") : "纯计时";

  return (
    <section className="main">
      <div className="view-head">
        <h1>专注</h1>
        <span className="sub">一次只做一件事</span>
      </div>

      <div className="view-body fv-body">
        {active ? (
          <div className="fv-stage fv-run">
            {paused ? (
              <div className="fv-timer fv-paused">已暂停</div>
            ) : (
              <div className="fv-timer">{fmtRemain(remainMs)}</div>
            )}
            <div className="fv-task">{curTask ? curTask.title || "（未命名）" : "纯计时"}</div>
            <div className="fv-round">本轮 {focus.totalMinutes} 分钟</div>
            <div className="fv-ctrl">
              {paused ? (
                <button className="btn primary" onClick={() => void resumeFocus()}>▶ 继续</button>
              ) : (
                <button className="btn" onClick={() => void pauseFocus()}>⏸ 暂停</button>
              )}
              <button className="btn" onClick={() => void stopFocus()}>结束</button>
            </div>
          </div>
        ) : (
          <div className="fv-stage">
            <div className="fv-card">
              <div className="fv-lead">选一件事，开始专注</div>
              <select className="input fv-select" value={chosen} onChange={(e) => setPickId(e.target.value)}>
                <option value="">不挂任务，纯计时</option>
                {todayTasks.length > 0 && (
                  <optgroup label="今天">
                    {todayTasks.map((t) => (
                      <option key={t.id} value={t.id}>{t.title || "（未命名）"}</option>
                    ))}
                  </optgroup>
                )}
                {inbox.length > 0 && (
                  <optgroup label="收件箱">
                    {inbox.map((t) => (
                      <option key={t.id} value={t.id}>{t.title || "（未命名）"}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <div className="fv-mins">
                {MIN_CHOICES.map((m) => (
                  <button
                    key={m}
                    className={`fv-min${minutes === m ? " on" : ""}`}
                    onClick={() => setMinutes(m)}
                  >
                    {m} 分
                  </button>
                ))}
              </div>
              <button className="fv-start" onClick={() => void startFocus(chosen || null, minutes)}>
                ▶ 开始专注
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="fv-log">
        <div className="fv-log-head">
          今天的专注记录
          {totalMin > 0 && <span className="fv-sum">合计 {totalMin} 分钟</span>}
        </div>
        {todaySessions.length === 0 && <div className="fv-log-empty">还没有记录——开一轮试试。</div>}
        {[...todaySessions].reverse().map((s, i) => (
          <div className="fv-log-row" key={`${s.startedAt}-${i}`}>
            <span className="fv-at">{fmtStart(s.startedAt)}</span>
            <span className="fv-dur">{s.minutes} 分钟</span>
            <span className="fv-name">{sessionName(s)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
