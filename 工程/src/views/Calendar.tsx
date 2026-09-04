// 日历：整月俯瞰。任务条可拖到别的日子改期，双击某天空白处就地补记一条。
//
// 2026-08-31 起做完的事也进日历，按**实际完成日**落格（不是原计划日——逾期补做的事
// 得落在真正做完那天）。头上三选一：全部 / 计划 / 已完成。
import { useMemo, useState } from "react";
import type { Task } from "../core/model";
import { addDays, cmpYMD, dayOfWeek, daysInMonth, monthStart, todayYMD, weekStart } from "../core/dates";
import type { DateRow } from "../core/store";
import {
  addTask, aliveTasks, byPriorityThenOrder, doneRows, expandTask, navigate, rowDoneDay,
  rowDoneGuessed, rowTaskIds, setTasksDue, useApp,
} from "../core/store";
import { rowKey } from "../components/RowList";
import { CommitMark, useCommitFlash } from "../components/commitFlash";
import TaskCard from "../components/TaskCard";
import { isMobile } from "../core/platform";
import MobileHead from "../mobile/MobileHead";
import MobileRow from "../mobile/MobileRow";
import "../styles/calendar.css";

const WEEK_HEAD = ["一", "二", "三", "四", "五", "六", "日"];
/** 一格最多列几条。周视图一行七格、格子高约六倍，给多得多——否则一格空着一大片却挂着「+N」 */
const MAX_SHOWN_MONTH = 3;
const MAX_SHOWN_WEEK = 10;

/** 手机格子里最多几颗点（v1.12.1）。月视图一格 56px 高，三颗就是极限；周视图一格是一整行，给多些 */
const MAX_DOTS_MONTH = 3;
const MAX_DOTS_WEEK = 6;
/** 点的三种颜色：逾期 warn / 计划 accent / 已完成 ok（样式见 calendar.css 的 .cal-dot） */
export type DotKind = "late" | "plan" | "ok";
const DOT_ORDER: DotKind[] = ["late", "plan", "ok"];

/**
 * 手机格子里画哪几颗点。格子里不写字（PM：「别塞文字」），一眼要看出两件事：
 * 这天有**哪几类**事、忙不忙。所以：在场的每一类先各占一颗，剩下的位子按
 * 逾期 → 计划 → 已完成 的顺序拿各类多出来的填，最多 max 颗；同色归拢在一起
 * （「两颗绿一颗黄」比「绿黄绿」好认）。纯函数，tests/mobile-calendar.test.ts 钉着
 */
export function dayDots(counts: Record<DotKind, number>, max: number): DotKind[] {
  const left = { ...counts };
  const out: DotKind[] = [];
  for (const k of DOT_ORDER) {
    if (left[k] > 0) {
      out.push(k);
      left[k]--;
    }
  }
  for (const k of DOT_ORDER) {
    while (out.length < max && left[k] > 0) {
      out.push(k);
      left[k]--;
    }
  }
  out.sort((a, b) => DOT_ORDER.indexOf(a) - DOT_ORDER.indexOf(b));
  return out.slice(0, max);
}

/** 月 / 周（v1.9.1）。周视图只是「7 格横排、格子更高」，不带时间轴 */
type CalMode = "month" | "week";
const MODE_KEY = "acorn-calendar-mode";
function loadMode(): CalMode {
  try {
    return localStorage.getItem(MODE_KEY) === "week" ? "week" : "month";
  } catch {
    return "month";
  }
}
/** anchor 的口径按模式归一：月视图是月首、周视图是周一。切模式必须过这一道，
 *  否则 anchor 停在周一去算月网格会整片错位且不报错 */
function normalizeAnchor(ymd: string, mode: CalMode): string {
  return mode === "week" ? weekStart(ymd) : monthStart(ymd);
}
function mdLabel(ymd: string, withYear: boolean): string {
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  return `${withYear ? `${ymd.slice(0, 4)}年` : ""}${m}月${d}日`;
}

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
  const [mode, setMode] = useState<CalMode>(loadMode);
  /** 月视图：当前展示月份的一号；周视图：当前展示那一周的周一 */
  const [anchor, setAnchor] = useState(() => normalizeAnchor(today, loadMode()));
  const pickMode = (m: CalMode) => {
    setMode(m);
    // 切模式时 anchor 不能机械地「周一 → 月首」：8/31–9/6 这一周切回月视图会落到 8 月，
    // 而人明明在看 9 月（PM 9/3 真机就撞上了）。规则：今天在这一段里就跟今天走；
    // 不在就按 ISO 的习惯取这周的周四所在月 / 这个月里第一个整周
    setAnchor((a) => {
      if (m === "month") {
        const inWeek = weekStart(today) === weekStart(a);
        return monthStart(inWeek ? today : addDays(weekStart(a), 3));
      }
      const inMonth = today.slice(0, 7) === a.slice(0, 7);
      return weekStart(inMonth ? today : a);
    });
    // 手机：切了月/周，底下那块常驻列表回到今天——不然它可能停在一个新视图里根本看不见的日子上
    if (isMobile) setPicked(null);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* 存不了就这次会话记得 */
    }
  };
  const maxShown = mode === "week" ? MAX_SHOWN_WEEK : MAX_SHOWN_MONTH;
  const maxDots = mode === "week" ? MAX_DOTS_WEEK : MAX_DOTS_MONTH;
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
  /** 点开了哪一天（v1.10.0，窄屏用）。窄屏格子只有 51px 宽，条目标题只显示得下一个字，
   *  所以格子里改画圆点，点一格在网格下面列出当天的事。
   *  这块在桌面上由 calendar.css 关掉——桌面格子里本来就写得下标题，不需要二级列表 */
  const [picked, setPicked] = useState<string | null>(null);

  // 格子：月视图整月（周一开头，前后补齐到整周）；周视图就是 anchor 那一周的七天
  const cells = useMemo(() => {
    if (mode === "week") return Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
    const y = Number(anchor.slice(0, 4));
    const m = Number(anchor.slice(5, 7));
    const lead = (dayOfWeek(anchor) + 6) % 7;
    const start = addDays(anchor, -lead);
    const weeks = Math.ceil((lead + daysInMonth(y, m)) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  }, [anchor, mode]);

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
  // 周视图的标题是一段区间，可能跨月跨年：年份只在跟今年不同、或起止跨年时才带
  const ymLabel = (() => {
    if (mode === "month") return `${anchor.slice(0, 4)}年${Number(anchor.slice(5, 7))}月`;
    const end = addDays(anchor, 6);
    const thisYear = today.slice(0, 4);
    const crossYear = anchor.slice(0, 4) !== end.slice(0, 4);
    const startYear = crossYear || anchor.slice(0, 4) !== thisYear;
    const endYear = crossYear || end.slice(0, 4) !== thisYear;
    return `${mdLabel(anchor, startYear)} – ${mdLabel(end, endYear)}`;
  })();

  function goPrev() {
    setAnchor((a) => (mode === "week" ? addDays(a, -7) : monthStart(addDays(a, -1))));
  }
  function goNext() {
    // 月视图：一号加上当月天数正好落到下月一号
    setAnchor((a) =>
      mode === "week" ? addDays(a, 7) : addDays(a, daysInMonth(Number(a.slice(0, 4)), Number(a.slice(5, 7)))),
    );
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

  // 这两组控件桌面上跟标题挤在同一行，手机上放不下，交给顶栏另起一行摆（MobileHead 的 extra）。
  // **同一份 JSX 喂给两边**：分成两份写，早晚有一边少一个按钮
  const filters = (
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
  );
  const nav = (
    <div className="cal-nav">
      {/* 月 / 周 跟前后翻页放一起：都是「我在看哪一段时间」 */}
      <div className="all-sort">
        <button className={mode === "month" ? "on" : undefined} onClick={() => pickMode("month")}>月</button>
        <button className={mode === "week" ? "on" : undefined} onClick={() => pickMode("week")}>周</button>
      </div>
      <button className="arr" onClick={goPrev} title={mode === "week" ? "上一周" : "上个月"}>‹</button>
      <button
        onClick={() => {
          setAnchor(normalizeAnchor(todayYMD(), mode));
          // 手机：底下那块常驻列表也一起回到今天（picked 为空就是今天，见下面 .cal-daylist）
          if (isMobile) setPicked(null);
        }}
      >
        今天
      </button>
      <button className="arr" onClick={goNext} title={mode === "week" ? "下一周" : "下个月"}>›</button>
    </div>
  );

  return (
    <section className="main">
      {/* 手机上走 MobileHead：顶部安全区统一在它那儿留。
          「哪一个月」当副标题，月/周 与 全部/计划/已完成 落到顶栏第二行（那一行横着能滑） */}
      {isMobile ? (
        <MobileHead
          title="日历"
          sub={ymLabel}
          search={false}
          onBack={() => navigate("today")}
          // 风景跟顶栏等高：这一页顶栏底下还挂着两排控件，190px 的固定高会切进第一行日期（v1.12.1）
          sceneFit
          extra={
            <>
              {nav}
              {filters}
            </>
          }
        />
      ) : (
        <div className="view-head">
          <h1>日历</h1>
          <span className="cal-ym">{ymLabel}</span>
          <span className="spacer" />
          {filters}
          {nav}
        </div>
      )}

      {/* 模式挂在容器上：窄屏周视图要把七列拍成七行，那时候上面那排「一二三…」的
          列头就没有意义了，得能选中它关掉，而列头自己不知道现在是月还是周 */}
      <div className={`view-body cal-body${mode === "week" ? " cal-week-mode" : ""}`}>
        <div className="cal-week">
          {WEEK_HEAD.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>

        <div className={`cal-grid${mode === "week" ? " week" : ""}`}>
          {cells.map((ymd) => {
            const slot = byDay.get(ymd);
            const open = filter === "done" ? [] : slot?.open ?? [];
            const done = filter === "plan" ? [] : slot?.done ?? [];
            // 绿点数字不跟着筛选走：它是「这天干成了几件」的一眼信息，切到「计划」也该在。
            // **按件去重**：一件事的三条子任务同一天勾完只算 1 件，不是 3 条——
            // 数字的含义从来是「几件事」，别让它跟着按行列的改动悄悄换口径
            const doneCount = slot ? rowTaskIds(slot.done).length : 0;
            // 计划的先占位，剩下的位子给已完成——一格就那么高，不能两边都硬塞
            const shownOpen = open.slice(0, maxShown);
            const shownDone = done.slice(0, Math.max(0, maxShown - shownOpen.length));
            const hidden = open.length - shownOpen.length + (done.length - shownDone.length);
            // 周视图里七天全是「这一周的」，不发灰；月视图才把补齐用的邻月日子压暗
            const inMonth = mode === "week" || ymd.slice(0, 7) === anchor.slice(0, 7);
            // 手机（v1.12.1）：一格只画「日期 + 最多几颗点」，不塞文字、不画补记框、不拖放——
            // 事情叫什么名字全由网格底下常驻的那块列表交代。点一格就是切到这一天。
            // 逾期 = 这天已经过去了还没做完：过去的日子里所有还开着的事都是逾期的
            if (isMobile) {
              const late = cmpYMD(ymd, today) < 0;
              const dots = dayDots(
                { late: late ? open.length : 0, plan: late ? 0 : open.length, ok: done.length },
                maxDots,
              );
              const shownDay = picked ?? today;
              return (
                <div
                  key={ymd}
                  className={`cal-cell${inMonth ? "" : " dim"}${shownDay === ymd ? " cal-picked" : ""}`}
                  onClick={() => setPicked(ymd)}
                >
                  <span className={`cal-num${ymd === today ? " today" : ""}`}>{Number(ymd.slice(8, 10))}</span>
                  {/* 周几只在周视图露面（七列拍成七行、列头关了），月视图由 CSS 藏起来 */}
                  <span className="cal-wd">周{WEEK_HEAD[(dayOfWeek(ymd) + 6) % 7]}</span>
                  <span className="cal-dots" aria-hidden="true">
                    {dots.map((k, i) => (
                      <i key={i} className={`cal-dot ${k}`} />
                    ))}
                  </span>
                </div>
              );
            }
            return (
              <div
                key={ymd}
                className={`cal-cell${inMonth ? "" : " dim"}${dropYmd === ymd ? " cal-dropping" : ""}${picked === ymd ? " cal-picked" : ""}`}
                // 点一格 = 在下面那块列出这天的事（窄屏才画得出来，见 .cal-daylist）。
                // 再点一次收起来：一格既是开关也是当前位置，手机上不另放一颗关闭键
                onClick={() => setPicked((cur) => (cur === ymd ? null : ymd))}
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
                  {/* 周几。窄屏周视图把七列拍成七行，那排列头就关掉了，
                      日期旁边得自己写上是周几；桌面和月视图里由 CSS 藏起来 */}
                  <span className="cal-wd">周{WEEK_HEAD[(dayOfWeek(ymd) + 6) % 7]}</span>
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

        {/* 手机（v1.12.1）：网格底下**常驻**「这一天」的列表。默认今天，点别的格子切过去，
            永远有东西可看——下半屏是内容不是空白（PM：「下面的留白不符合审美」）。
            行走 MobileRow：点一行拉出任务详情那张纸，左右滑、长按都跟今天页一样 */}
        {isMobile &&
          (() => {
            const day = picked ?? today;
            const slot = byDay.get(day);
            const open = filter === "done" ? [] : slot?.open ?? [];
            const done = filter === "plan" ? [] : slot?.done ?? [];
            // 「N 件」按件数不按行数：一件事的几条子任务同一天勾完算 1 件（跟格子上那颗绿点一个口径）
            const count = rowTaskIds([...open.map((t) => ({ task: t, sub: null })), ...done]).length;
            return (
              <div className="cal-daylist">
                <div className="group-head split">
                  <span className="group-label">
                    {day === today ? "今天" : mdLabel(day, day.slice(0, 4) !== today.slice(0, 4))}
                    {" · 周"}
                    {WEEK_HEAD[(dayOfWeek(day) + 6) % 7]}
                  </span>
                  {count > 0 && <span className="cal-daylist-n">{count} 件</span>}
                </div>
                {open.length === 0 && done.length === 0 ? (
                  <div className="cal-daylist-empty">这天没有安排</div>
                ) : (
                  <div className="mcard">
                    {open.map((t) => (
                      <MobileRow key={t.id} task={t} />
                    ))}
                    {done.map((r) => (
                      <MobileRow key={rowKey(r)} task={r.task} sub={r.sub} doneDate={rowDoneDay(r)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

        {/* 点开那天的清单（窄屏专用，桌面由 calendar.css 关掉；手机走上面那块常驻的）。
            窄屏格子里只剩「日期 + 圆点 + 计数」，事情叫什么名字全靠这一块交代；
            点其中一条照旧展开下面那张任务卡 */}
        {!isMobile && picked && (
          <div className="cal-daylist">
            <div className="cal-daylist-head">
              <b>{mdLabel(picked, picked.slice(0, 4) !== today.slice(0, 4))}</b>
              <span className="cal-daylist-wd">周{WEEK_HEAD[(dayOfWeek(picked) + 6) % 7]}</span>
              <button className="cal-daylist-x" title="收起这天" onClick={() => setPicked(null)}>×</button>
            </div>
            {(() => {
              const slot = byDay.get(picked);
              const open = filter === "done" ? [] : slot?.open ?? [];
              const done = filter === "plan" ? [] : slot?.done ?? [];
              if (open.length === 0 && done.length === 0) {
                return <div className="cal-daylist-empty">这天没有安排</div>;
              }
              return (
                <>
                  {open.map((t) => (
                    <button key={t.id} className="cal-day-row" onClick={() => expandTask(t.id)}>
                      <span className={`flag p${t.priority}`} />
                      <span className="cal-day-title">{t.title || "（未命名）"}</span>
                      {t.dueTime && <span className="cal-day-time">{t.dueTime}</span>}
                    </button>
                  ))}
                  {done.map((r) => (
                    <button
                      key={rowKey(r)}
                      className="cal-day-row done"
                      onClick={() => expandTask(r.task.id)}
                    >
                      <span className="cal-check">✓</span>
                      <span className="cal-day-title">
                        {/* 做完的子任务写成「母 › 子」，跟「已完成」视图一个口径 */}
                        {(r.sub ? `${r.task.title} › ${r.sub.title}` : r.task.title) || "（未命名）"}
                      </span>
                    </button>
                  ))}
                </>
              );
            })()}
          </div>
        )}

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
