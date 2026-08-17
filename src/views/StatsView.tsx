// 统计与每周回顾：数字卡 + 完成热力图 + 14 天趋势 + 分布两栏 + 周报导出。图全部用 CSS 画。
import "../styles/statsview.css";
import { useMemo } from "react";
import { addDays, formatCN, fromYMD, todayYMD, weekStart } from "../core/dates";
import { byList, byWho, completionByDay, exportWeekMarkdown, weeklyReview } from "../core/stats";
import * as persist from "../core/persist";
import { showToast, useApp } from "../core/store";
import { WhoBadge } from "../components/TaskRow";

const HEAT_WEEKS = 13;
const HEAT_DAYS = HEAT_WEEKS * 7; // 91

/** 完成数 → 热力档位（0 为空档，1~4 对应 --ok 四档透明度） */
function heatLevel(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  return 4;
}

function fmtMD(ymd: string): string {
  const d = fromYMD(ymd);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function StatsView() {
  const data = useApp((s) => s.data);
  const today = todayYMD();

  const agg = useMemo(() => {
    const { tasks, sessions, lists } = data;

    // 热力图：本周一往前推 12 周，共 91 天；今天之后的格子留空
    const heatStart = addDays(weekStart(today), -7 * (HEAT_WEEKS - 1));
    const heat = completionByDay(tasks, heatStart, today);

    // streak：从今天往回数连续有完成记录的天数；今天还没完成不算断
    const back = completionByDay(tasks, addDays(today, -365), today);
    let streak = 0;
    let i = back.length - 1;
    if (back[i].count === 0) i--;
    for (; i >= 0 && back[i].count > 0; i--) streak++;

    const start30 = addDays(today, -29);
    return {
      heat,
      streak,
      trend: completionByDay(tasks, addDays(today, -13), today),
      listRows: byList(tasks, lists, start30, today),
      whoRows: byWho(tasks, start30, today),
      review: weeklyReview(tasks, sessions, lists, today),
    };
  }, [data, today]);

  const { heat, streak, trend, listRows, whoRows, review } = agg;
  const trendMax = Math.max(1, ...trend.map((d) => d.count));
  const listMax = Math.max(1, ...listRows.map((r) => r.done));
  const whoMax = Math.max(1, ...whoRows.map((r) => r.done));

  const listColor = (id: string | null): string =>
    id === null ? "var(--ink-3)" : `var(--list-${data.lists.find((l) => l.id === id)?.color ?? "slate"})`;

  async function onExport() {
    const md = exportWeekMarkdown(review);
    try {
      if (!persist.inTauri) {
        // 浏览器环境没有保存对话框，退化为复制
        await navigator.clipboard.writeText(md);
        showToast("当前不在桌面环境，小结已复制到剪贴板", false);
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `橡果周报-${review.weekStart}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      await persist.writeTextFile(path, md);
      showToast("本周小结已导出", false);
    } catch (e) {
      showToast(`导出失败：${String(e)}`, false);
    }
  }

  return (
    <section className="main">
      <div className="view-head">
        <h1>统计</h1>
        <span className="sub">看看最近的节奏</span>
      </div>
      <div className="view-body stats-body">
        {/* 三枚数字卡 */}
        <div className="stats-cards">
          <div className="stats-card">
            <span className="stats-num">{review.completed.length}</span>
            <span className="stats-label">本周完成</span>
          </div>
          <div className="stats-card">
            <span className="stats-num">
              {review.focusMinutes}
              <em>分钟</em>
            </span>
            <span className="stats-label">本周专注</span>
          </div>
          <div className="stats-card">
            <span className="stats-num">
              {streak}
              <em>天</em>
            </span>
            <span className="stats-label">连续有完成</span>
          </div>
        </div>

        {/* 完成热力图 */}
        <div>
          <div className="stats-sec-head">
            完成热力图
            <span className="stats-sec-sub">最近 {HEAT_WEEKS} 周</span>
            <span className="stats-hm-legend">
              少
              <span className="stats-hm-cell" />
              <span className="stats-hm-cell l1" />
              <span className="stats-hm-cell l2" />
              <span className="stats-hm-cell l3" />
              <span className="stats-hm-cell l4" />
              多
            </span>
          </div>
          <div className="stats-hm">
            <div className="stats-hm-days">
              <span>一</span>
              <span>四</span>
              <span>日</span>
            </div>
            <div className="stats-hm-grid">
              {Array.from({ length: HEAT_DAYS }, (_, idx) => {
                if (idx >= heat.length) return <span key={`f${idx}`} className="stats-hm-cell future" />;
                const d = heat[idx];
                const lv = heatLevel(d.count);
                return (
                  <span
                    key={d.date}
                    className={`stats-hm-cell${lv ? ` l${lv}` : ""}`}
                    title={`${formatCN(d.date)} · 完成 ${d.count} 件`}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* 最近 14 天趋势 */}
        <div>
          <div className="stats-sec-head">
            完成趋势
            <span className="stats-sec-sub">最近 14 天</span>
          </div>
          <div className="stats-trend">
            {trend.map((d) => (
              <div key={d.date} className="stats-trend-col" title={`${formatCN(d.date)} · 完成 ${d.count} 件`}>
                <div className="stats-trend-track">
                  {d.count > 0 && <span className="stats-trend-val">{d.count}</span>}
                  <div
                    className={`stats-trend-bar${d.count === 0 ? " zero" : ""}`}
                    style={
                      d.count === 0
                        ? undefined
                        : { height: `${Math.max(8, Math.round((d.count / trendMax) * 100))}%` }
                    }
                  />
                </div>
                <span className="stats-trend-day">{d.date === today ? "今" : fromYMD(d.date).getDate()}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 分布两栏：清单 | 需求方 */}
        <div className="stats-duo">
          <div>
            <div className="stats-sec-head">
              各清单分布
              <span className="stats-sec-sub">最近 30 天完成</span>
            </div>
            <div className="stats-dist">
              {listRows.map((r) => (
                <div key={r.id ?? "inbox"} className="stats-dist-row">
                  <span className="stats-dist-name" title={r.name}>
                    <span className="stats-dot" style={{ background: listColor(r.id) }} />
                    <span className="stats-dist-nm">{r.name}</span>
                  </span>
                  <span className="stats-dist-track">
                    <span
                      className="stats-dist-fill"
                      style={{ width: `${(r.done / listMax) * 100}%`, background: listColor(r.id) }}
                    />
                  </span>
                  <span className="stats-dist-num">{r.done}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="stats-sec-head">
              各需求方分布
              <span className="stats-sec-sub">最近 30 天完成</span>
            </div>
            {whoRows.length === 0 ? (
              <div className="stats-none">还没有为谁记录过任务</div>
            ) : (
              <div className="stats-dist">
                {whoRows.map((r) => (
                  <div key={r.who} className="stats-dist-row">
                    <span className="stats-dist-name" title={r.who}>
                      <WhoBadge who={r.who} />
                    </span>
                    <span className="stats-dist-track">
                      <span className="stats-dist-fill" style={{ width: `${(r.done / whoMax) * 100}%` }} />
                    </span>
                    <span className="stats-dist-num">{r.done}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 每周回顾卡 */}
        <div className="stats-week">
          <div className="stats-week-info">
            <div className="stats-week-titlerow">
              <span className="stats-week-title">每周回顾</span>
              <span className="stats-week-range">
                {fmtMD(review.weekStart)} ~ {fmtMD(review.weekEnd)}
              </span>
            </div>
            <div className="stats-week-sum">
              完成 {review.completed.length} · 未清 {review.stillOpen.length} · 反复顺延 {review.postponed.length} · 专注{" "}
              {review.focusMinutes} 分钟
            </div>
          </div>
          <button className="btn" onClick={() => void onExport()}>
            导出本周小结 (Markdown)
          </button>
        </div>
      </div>
    </section>
  );
}
