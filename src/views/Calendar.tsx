// 日历：整月俯瞰。任务条可拖到别的日子改期，双击某天空白处就地补记一条。
//
// 2026-08-31 起做完的事也进日历，按**实际完成日**落格（不是原计划日——逾期补做的事
// 得落在真正做完那天）。头上三选一：全部 / 计划 / 已完成。
import { useMemo, useState } from "react";
import type { Task } from "../core/model";
import { addDays, dayOfWeek, daysInMonth, monthStart, todayYMD } from "../core/dates";
import type { DateRow } from "../core/store";
import {
  addTask, aliveTasks, byPriorityThenOrder, doneRows, expandTask, rowDoneDay, rowDoneGuessed,
  rowTaskIds, setTasksDue, useApp,
} from "../core/store";
import { rowKey } from "../components/RowList";
import { CommitMark, useCommitFlash } from "../components/commitFlash";
import TaskCard from "../components/TaskCard";
import "../styles/calendar.css";

const WEEK_HEAD = ["一", "二", "三", "四", "五", "六", "日"];
const MAX_SHOWN = 3;

/** 日格里显示哪一类。默认「全部」——先让人看见东西，再让他自己收窄 */
const FILTERS = [
  { id: "all", name: "全部" },
  { id: "plan", name: "计划" },
  { id: "done", name: "已完成" },
] as const;
type CalFilter = (typeof FILTERS)[number]["id"];
const FILTER_KEY = "acorn-calendar-filter";

function loadFilter(): CalFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === "plan" || v === "done" ? v : "all";
  } catch {
    return "all";
  }
}

export default function Calendar() {
  const data = useApp((s) => s.data);
  const expandedId = useApp((s) => s.ui.expandedId);
  const today = todayYMD();
  /** 当前展示月份的一号 */
  const [anchor, setAnchor] = useState(() => monthStart(today));
  const [dropYmd, setDropYmd] = useState<string | null>(null);
  const [quickYmd, setQuickYmd] = useState<string | null>(null);
  const [quickText, setQuickText] = useState("");
  /** 日历格补记的提交回执（A2） */
  const quickFlash = useCommitFlash();
  const [filter, setFilter] = useState<CalFilter>(loadFilter);
  const pickFilter = (f: CalFilter) => {
    setFilter(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* 存不了就这次会话记得 */
    }
  };

  // 本月格子：周一开头，前后补齐到整周
  const cells = useMemo(() => {
    const y = Number(anchor.slice(0, 4));
    const m = Number(anchor.slice(5, 7));
    const lead = (dayOfWeek(anchor) + 6) % 7;
    const start = addDays(anchor, -lead);
    const weeks = Math.ceil((lead + daysInMonth(y, m)) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  }, [anchor]);

  // 按日期归堆，两个桶各按各的日子：
  //   · 计划桶按截止日 t.due（维持原样）
  //   · 已完成桶按**实际完成日**——走 store.rowDoneDay，跟「已完成」视图同一个函数。
  //     它已经把 UTC ISO 转成本地日期了（本地 0-8 点做完的不能归到昨天）
  // 已完成是**按行**的：做完的子任务各占一条，母任务勾掉了也占一条
  const byDay = useMemo(() => {
    const map = new Map<string, { open: Task[]; done: DateRow[] }>();
    const slotOf = (ymd: string) => {
      let slot = map.get(ymd);
      if (!slot) {
        slot = { open: [], done: [] };
        map.set(ymd, slot);
      }
      return slot;
    };
    for (const t of aliveTasks(data)) {
      // 放弃的一格都不占：日历上的计划条是「那天要做什么」，已经不做了就不该再排在那儿。
      // 已完成桶走 doneRows，那个函数本来就只收做完的，放弃的进不去（见 store.droppedRows）
      if (t.due && !t.done && !t.droppedAt) slotOf(t.due).open.push(t);
    }
    // 完成时刻是猜出来的（老子任务没戳、母任务也没完成）一律不落格：
    // 那天用户其实什么都没做完，画上去就是凭空捏造一条完成记录。
    // 它们不会消失，只是留在「已完成」列表尾部（见 store.rowDoneGuessed）
    for (const r of doneRows(data)) {
      if (rowDoneGuessed(r)) continue;
      slotOf(rowDoneDay(r)).done.push(r);
    }
    for (const slot of map.values()) slot.open.sort(byPriorityThenOrder);
    return map;
  }, [data]);

  const expanded = expandedId ? aliveTasks(data).find((t) => t.id === expandedId) : undefined;
  const ymLabel = `${anchor.slice(0, 4)}年${Number(anchor.slice(5, 7))}月`;

  function goPrev() {
    setAnchor((a) => monthStart(addDays(a, -1)));
  }
  function goNext() {
    // 一号加上当月天数正好落到下月一号
    setAnchor((a) => addDays(a, daysInMonth(Number(a.slice(0, 4)), Number(a.slice(5, 7)))));
  }

  /** 日历格里补记一条。回车之后**框留在原地清空**，接着记下一条同一天的事；
   *  点走则记完就收（A1：空的就丢、有字就提交）。text 显式传进来，
   *  免得 Esc 清空之后 blur 读到的还是上一拍的 state */
  function submitQuick(text: string, keepOpen: boolean) {
    const title = text.trim();
    if (title && quickYmd) {
      addTask({ title, due: quickYmd });
      quickFlash.flash();
    }
    setQuickText("");
    if (!keepOpen) setQuickYmd(null);
  }

  function onDrop(e: React.DragEvent, ymd: string) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    if (id) setTasksDue([id], ymd);
    setDropYmd(null);
  }

  return (
    <section className="main">
      <div className="view-head">
        <h1>日历</h1>
        <span className="cal-ym">{ymLabel}</span>
        <span className="spacer" />
        <div className="all-sort">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? "on" : undefined}
              onClick={() => pickFilter(f.id)}
            >
              {f.name}
            </button>
          ))}
        </div>
        <div className="cal-nav">
          <button className="arr" onClick={goPrev} title="上个月">‹</button>
          <button onClick={() => setAnchor(monthStart(todayYMD()))}>今天</button>
          <button className="arr" onClick={goNext} title="下个月">›</button>
        </div>
      </div>

      <div className="view-body cal-body">
        <div className="cal-week">
          {WEEK_HEAD.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>

        <div className="cal-grid">
          {cells.map((ymd) => {
            const slot = byDay.get(ymd);
            const open = filter === "done" ? [] : slot?.open ?? [];
            const done = filter === "plan" ? [] : slot?.done ?? [];
            // 绿点数字不跟着筛选走：它是「这天干成了几件」的一眼信息，切到「计划」也该在。
            // **按件去重**：一件事的三条子任务同一天勾完只算 1 件，不是 3 条——
            // 数字的含义从来是「几件事」，别让它跟着按行列的改动悄悄换口径
            const doneCount = slot ? rowTaskIds(slot.done).length : 0;
            // 计划的先占位，剩下的位子给已完成——一格就那么高，不能两边都硬塞
            const shownOpen = open.slice(0, MAX_SHOWN);
            const shownDone = done.slice(0, Math.max(0, MAX_SHOWN - shownOpen.length));
            const hidden = open.length - shownOpen.length + (done.length - shownDone.length);
            const inMonth = ymd.slice(0, 7) === anchor.slice(0, 7);
            return (
              <div
                key={ymd}
                className={`cal-cell${inMonth ? "" : " dim"}${dropYmd === ymd ? " cal-dropping" : ""}`}
                onDoubleClick={() => {
                  setQuickYmd(ymd);
                  setQuickText("");
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropYmd((cur) => (cur === ymd ? cur : ymd));
                }}
                onDragLeave={() => setDropYmd((cur) => (cur === ymd ? null : cur))}
                onDrop={(e) => onDrop(e, ymd)}
              >
                <div className="cal-head">
                  <span className={`cal-num${ymd === today ? " today" : ""}`}>
                    {Number(ymd.slice(8, 10))}
                  </span>
                  {/* 绿点和「+N」都挤在日期这一行：日格是固定高 + overflow:hidden，
                      排在条目后面的东西在 6 周布局里会被整条裁掉，用户根本看不见还有没显示完的 */}
                  <span className="cal-head-right">
                    {doneCount > 0 && (
                      <span className="cal-done" title={`当天已完成 ${doneCount} 项`}>
                        <span className="cal-done-dot" />
                        {doneCount}
                      </span>
                    )}
                    {hidden > 0 && <span className="cal-more" title={`还有 ${hidden} 条没列出来`}>+{hidden}</span>}
                  </span>
                </div>
                {/* 补记输入框排在条目之前：排最后会被挤出可视区，得靠浏览器滚一下才露出来，
                    日期数字跟着滚没，看着像格子错位 */}
                {quickYmd === ymd && (
                  <div className="cal-quick" onDoubleClick={(e) => e.stopPropagation()}>
                    <input
                      autoFocus
                      className={quickFlash.on ? "commit-lit" : undefined}
                      placeholder="回车添加"
                      value={quickText}
                      onChange={(e) => setQuickText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) submitQuick(quickText, true);
                        // Esc 才是丢弃
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setQuickText("");
                          setQuickYmd(null);
                        }
                      }}
                      // A1：点走 = 提交（空的照旧直接收）。
                      // 但**窗口失焦不是点走**：alt-tab 去别的程序不该凭空多一条任务，
                      // 框原样悬在这儿等用户回来自己了结
                      onBlur={(e) => {
                        if (!document.hasFocus()) return;
                        submitQuick(e.target.value, false);
                      }}
                    />
                    <CommitMark on={quickFlash.on} />
                  </div>
                )}
                {shownOpen.map((t) => (
                  <div
                    key={t.id}
                    className="cal-task"
                    title={t.title}
                    draggable
                    onClick={(e) => {
                      e.stopPropagation();
                      expandTask(t.id);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", t.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDropYmd(null)}
                  >
                    <span className={`flag p${t.priority}`} />
                    <span className="cal-title">{t.title || "（未命名）"}</span>
                  </div>
                ))}
                {shownDone.map((r) => {
                  const title = r.sub ? `${r.task.title} › ${r.sub.title}` : r.task.title;
                  return (
                    <div
                      key={rowKey(r)}
                      className="cal-task cal-task-done"
                      title={`已完成：${title}`}
                      // 做完的事不给拖：拖它去改截止日既没有意义，还会把一件已完成的事写脏
                      onClick={(e) => {
                        e.stopPropagation();
                        expandTask(r.task.id);
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <span className="cal-check">✓</span>
                      <span className="cal-title">
                        {(r.sub ? r.sub.title : r.task.title) || "（未命名）"}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {expanded && (
          <div className="cal-detail">
            {/* key 必不可少：不给 key，切换展开的任务时 React 会复用同一个实例，
                已完成子任务的折叠状态、整句改草稿都会从上一张卡串到下一张 */}
            <TaskCard key={expanded.id} task={expanded} />
          </div>
        )}
      </div>
    </section>
  );
}
