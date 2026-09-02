// 计划：所有还没做完的事都在这儿（原来叫「全部」）。
//
// 2026-08-28 用户口径：
//   · 原来那个按天铺开的「计划」撤掉了，这里的「一周内」已经覆盖同一件事
//   · 「接下来」拆成 一周内 / 一个月内 / 半年内（再往后进「更远」，不能让它没地方去）
//   · 「按重要性」不再只是组内换个排法，而是**换一种分组**：高 / 中 / 低 / 普通，每档内按时间
//   · 四象限并进来，成为这里的另一种看法，不再单占一个侧栏位置
import { Fragment, useMemo, useState } from "react";
import { todayYMD } from "../core/dates";
import { planGroups } from "../core/plan";
import { searchTasks } from "../core/search";
import { aliveTasks, openRows, rowTaskIds, setFoldAll, updateSettings, useApp } from "../core/store";
import { hardCutRows } from "../core/motion";
import { isMobile } from "../core/platform";
import { usePinExpanded } from "../core/pin";
import RowList, { ROW_PIN, cardAnchor, useFoldPlan, visibleRows } from "../components/RowList";
import MobileHead from "../mobile/MobileHead";
import QuadrantBoard from "./Quadrant";
import "../styles/plan.css";

const SORT_OPTIONS = [
  { id: "time", name: "按时间" },
  { id: "priority", name: "按重要性" },
] as const;

const TAB_KEY = "acorn-plan-tab";

export default function Plan() {
  const data = useApp((s) => s.data);
  const foldAll = useApp((s) => s.ui.foldAll);
  const expandedId = useApp((s) => s.ui.expandedId);
  const sortMode = data.settings.sortMode;
  const today = todayYMD();
  const [tab, setTab] = useState<"list" | "quad">(() => {
    try {
      return localStorage.getItem(TAB_KEY) === "quad" ? "quad" : "list";
    } catch {
      return "list";
    }
  });
  const pickTab = (t: "list" | "quad") => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* 存不了就这次会话记得 */
    }
  };

  // 计划里的搜索（v1.9.1）。本地 state，不入 store、不落盘——它是「这一眼想找什么」，不是偏好
  const [q, setQ] = useState("");
  const query = q.trim();
  const openAll = useMemo(() => openRows(data), [data]);
  // **过滤必须发生在 planGroups 之前**：下面 fold / anchor / orderedIds / foldable 四个派生值
  // 全都得吃过滤后的行——否则折叠链头被搜掉之后 anchor 会指向没渲染的行，展开卡凭空消失，
  // 键盘上下也会走到看不见的任务上。
  // 当筛选器用：limit 不设上限（截断了就是静默丢事）、只认子串（子序列会把整页都留下）。
  // 按**件**过滤：一件事只要标题 / 子任务 / 备注 / 标签 / 需求方任一命中，它的所有行都留下
  const rows = useMemo(() => {
    if (!query) return openAll;
    const hit = new Set(
      searchTasks(aliveTasks(data), data.lists, query, { limit: Infinity, exact: true }).map((h) => h.task.id),
    );
    return openAll.filter((r) => hit.has(r.task.id));
  }, [openAll, data, query]);
  // 分完组还有一道：**展开着的那件事钉在上一版的位置上**（core/pin.ts）。
  // 母任务定在两个月后、在卡里加一条今天到期的子任务时，母任务行会被子任务行顶掉，
  // 新行按日期落进「今天」那一组——卡片跟着换了个 React 父节点、整张卡卸载重挂，
  // 焦点和几个草稿全丢，看着就是「卡片自己收回去了」。收起之后照常重排
  const laid = useMemo(() => planGroups(rows, sortMode, today), [rows, sortMode, today]);
  // 兜底行池：搜索框正筛着的时候，在卡里把标题改得不再命中，这件事的行会当场从页面上
  // 消失、卡片跟着没。展开期间不许发生这种事，所以从**没过滤**的那份里把它的行留着
  const pinPool = useMemo(
    () => (expandedId ? openAll.filter((r) => r.task.id === expandedId) : []),
    [openAll, expandedId],
  );
  const groups = usePinExpanded(laid, expandedId, ROW_PIN, pinPool);
  const allRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const totalOpen = useMemo(() => rowTaskIds(openAll).length, [openAll]);
  // 折叠和展开卡的落点都得**整页算一次**：子任务各带日期时会散落在不同的时间段里，
  // 一段一段各算各的，「收起」就变成了「每段收一次」，等于没收
  const fold = useFoldPlan(allRows);
  const anchor = cardAnchor(allRows, expandedId);
  // 连选按「件」走：一件事拆成几行也只占一个连选位
  const orderedIds = rowTaskIds(allRows);
  // 有子任务可以折叠的事——一件都没有就别摆那个按钮
  const foldable = allRows.some((r) => r.sub);

  const sub = (
    <>
      {query
        ? `匹配 ${orderedIds.length} 件 / 共 ${totalOpen} 件`
        : `${orderedIds.length} 件未完成`}
      {!query && allRows.length !== orderedIds.length && ` · ${allRows.length} 条待办`}
    </>
  );
  // 这几组控件桌面上跟标题挤在同一行，手机上放不下，交给顶栏另起一行摆（MobileHead 的 extra）。
  // **同一份 JSX 喂给两边**：分成两份写，早晚有一边少一个按钮
  const controls = (
    <>
      <div className="all-sort">
        <button className={tab === "list" ? "on" : undefined} onClick={() => pickTab("list")}>列表</button>
        <button className={tab === "quad" ? "on" : undefined} onClick={() => pickTab("quad")}>四象限</button>
      </div>
      {tab === "list" && (
        <>
          <div className="all-sort">
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.id}
                className={sortMode === o.id ? "on" : undefined}
                onClick={() => updateSettings({ sortMode: o.id })}
              >
                {o.name}
              </button>
            ))}
          </div>
          {foldable && (
            <button
              className="btn ghost"
              title={foldAll ? "展开每件事的全部子任务" : "折叠后每件事只显示下一步"}
              // 这一下可能翻掉上百行。高度过渡不能上合成器，每帧都要重算轨道并回流其下方
              // 的全部内容——这个按钮存在的理由恰恰是「行太多了」。所以总开关这条路走硬切，
              // 高度动画只留给单条小三角（它一次只动几行）
              onClick={() => { hardCutRows(); setFoldAll(!foldAll); }}
            >
              {foldAll ? "展开子任务" : "收起子任务"}
            </button>
          )}
        </>
      )}
    </>
  );

  return (
    <section className="main">
      {isMobile ? (
        <MobileHead title="计划" sub={sub} extra={controls} />
      ) : (
        <div className="view-head">
          <h1>计划</h1>
          <span className="sub">{sub}</span>
          <span className="spacer" />
          {controls}
        </div>
      )}
      {/* 搜索条另起一行：view-head 里已有三组控件，最小窗宽下再塞一个输入框会挤爆。
          Ctrl+F 在这个视图里会聚焦到它（App.tsx 按 DOM 找 .plan-search input），四象限 tab 下不出现 */}
      {tab === "list" && (
        <div className="plan-search">
          <span className="ps-glyph">🔍</span>
          <input
            className="input"
            value={q}
            // 手机上这句长的会被硬裁在「标签、」中间（框里没有省略号，只有半截字），
            // 换一句短的比加省略号可读——搜的范围没变，只是不逐项报菜名
            placeholder={isMobile ? "搜索标题、子任务、备注…" : "搜索计划里的事：标题、子任务、备注、标签、需求方"}
            // 每敲一个字行集合都大改，跟总开关一样走硬切，不然上百行的高度过渡每次击键重跑
            onChange={(e) => {
              hardCutRows();
              setQ(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // 不让它冒到 App 的全局 Escape——那儿会清选中 + 收起展开的任务卡
                e.stopPropagation();
                if (q) {
                  hardCutRows();
                  setQ("");
                } else {
                  (e.target as HTMLInputElement).blur();
                }
              }
            }}
          />
          {q && (
            <button
              className="ps-clear"
              title="清空"
              onClick={() => {
                hardCutRows();
                setQ("");
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
      {tab === "quad" ? (
        <QuadrantBoard />
      ) : (
        <div className="view-body">
          {groups.map((g) => {
            // 只用来判断组标题画不画。RowList 拿的是**没过滤过**的那份：
            // 折叠掉的行由它收成 0 高，收/放才都有动画（B5）
            const rows = visibleRows(g.rows, fold);
            return (
              <Fragment key={g.key}>
                {rows.length > 0 && (
                  <div className={g.warn ? "group-head warn" : "group-head"}>
                    {g.label}
                    {g.warn ? ` ${g.rows.length}` : ""}
                  </div>
                )}
                <RowList rows={g.rows} fold={fold} anchor={anchor} orderedIds={orderedIds} />
              </Fragment>
            );
          })}
          {allRows.length === 0 && (
            <div className="empty">{query ? `没有匹配「${query}」的事。` : "没有未完成的事。"}</div>
          )}
        </div>
      )}
    </section>
  );
}
