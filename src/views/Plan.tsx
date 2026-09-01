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
import { openRows, rowTaskIds, setFoldAll, updateSettings, useApp } from "../core/store";
import { hardCutRows } from "../core/motion";
import RowList, { cardAnchor, useFoldPlan, visibleRows } from "../components/RowList";
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

  const groups = useMemo(() => planGroups(openRows(data), sortMode, today), [data, sortMode, today]);
  const allRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  // 折叠和展开卡的落点都得**整页算一次**：子任务各带日期时会散落在不同的时间段里，
  // 一段一段各算各的，「收起」就变成了「每段收一次」，等于没收
  const fold = useFoldPlan(allRows);
  const anchor = cardAnchor(allRows, expandedId);
  // 连选按「件」走：一件事拆成几行也只占一个连选位
  const orderedIds = rowTaskIds(allRows);
  // 有子任务可以折叠的事——一件都没有就别摆那个按钮
  const foldable = allRows.some((r) => r.sub);

  return (
    <section className="main">
      <div className="view-head">
        <h1>计划</h1>
        <span className="sub">
          {orderedIds.length} 件未完成
          {allRows.length !== orderedIds.length && ` · ${allRows.length} 条待办`}
        </span>
        <span className="spacer" />
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
      </div>
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
            <div className="empty">没有未完成的事。</div>
          )}
        </div>
      )}
    </section>
  );
}
