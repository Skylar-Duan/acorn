// 循环的「自定义…」面板（v1.15，桌面）。用户原话：「循环界面的可选也不对，应该可以点开弹出日历有更多的选择」。
//
// 三个页签，只用现有 4 种规则能表达的：
//   · 天 = 每隔 N 天（daily.every）
//   · 周 = 一周里哪几天，可多选（weekly.days）
//   · 月 = 1–31 号的格子 + 「最后一天」（monthly.day；最后一天存 31，当月没有 31 号就落在月末）
// 不加每年 / 隔周 / 隔月：那得新增规则种类，没升级的另外两端读不懂。
//
// 点格子只改面板里的草稿，底部预览跟着变；点「好」才交给调用方写入，点「取消」什么都不动。
// 面板只管界面，文字一律走 core/recur 的 describeRepeat，跟任务卡上显示的是同一个说法。
// 放在调用方自己的 .popmenu 里渲染（不另起弹层）：点卡外收起、点别处关浮层那几条规矩原样适用。
import { useState } from "react";
import type { RepeatRule } from "../core/model";
import { dayOfWeek } from "../core/dates";
import { describeRepeat } from "../core/recur";
import "../styles/repeatpicker.css";

type Tab = "day" | "week" | "month";

/** 周一在前，跟日历页一个排法；值是 0=周日 … 6=周六 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

export interface RepeatPickerProps {
  /** 现在生效的规则；没有就是 null */
  value: RepeatRule | null;
  /** 没有现成规则时，周 / 月两页默认选哪天：按这件事的日期，没有就今天（'YYYY-MM-DD'） */
  anchor: string;
  onDone: (rule: RepeatRule) => void;
  onCancel: () => void;
}

/** 两条规则是不是同一个。09-21 起搬进 core/options（常用项清单在那儿，判现值也在那儿），
 *  这里转一手，老的 import 照样能用 */
export { sameRepeat } from "../core/options";

/** 面板初始停在哪一页、各页的草稿是什么：从现有规则推，推不出来的按 anchor 给个合理的默认 */
function initial(value: RepeatRule | null, anchor: string) {
  const dow = dayOfWeek(anchor);
  const dom = Number(anchor.slice(8, 10));
  let tab: Tab = "week";
  let every = 1;
  let days = [dow];
  let monthDay = dom;
  if (value) {
    switch (value.kind) {
      case "daily":
        tab = "day";
        every = Math.max(1, value.every);
        break;
      case "weekly":
        tab = "week";
        if (value.days.length) days = [...value.days];
        break;
      case "workday":
        // 工作日在面板里摊成周一到周五；真要按节假日调休走，常用项里的「每个工作日」还在
        tab = "week";
        days = [1, 2, 3, 4, 5];
        break;
      case "monthly":
        tab = "month";
        monthDay = Math.min(31, Math.max(1, value.day));
        break;
    }
  }
  return { tab, every, days, monthDay };
}

export default function RepeatPicker({ value, anchor, onDone, onCancel }: RepeatPickerProps) {
  const [init] = useState(() => initial(value, anchor));
  const [tab, setTab] = useState<Tab>(init.tab);
  const [every, setEvery] = useState(init.every);
  const [days, setDays] = useState<number[]>(init.days);
  const [monthDay, setMonthDay] = useState(init.monthDay);

  const draft: RepeatRule | null =
    tab === "day"
      ? { kind: "daily", every }
      : tab === "week"
        ? days.length ? { kind: "weekly", days: [...days].sort((a, b) => a - b) } : null
        : { kind: "monthly", day: monthDay };

  function toggleDay(d: number) {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  }

  /** 天数框：只收 1–365 的整数，别的字一律当没打 */
  function changeEvery(n: number) {
    if (!Number.isFinite(n)) return;
    setEvery(Math.min(365, Math.max(1, Math.round(n))));
  }

  return (
    <div className="rp">
      <div className="rp-tabs" role="tablist">
        {([["day", "天"], ["week", "周"], ["month", "月"]] as const).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={`rp-tab${tab === k ? " on" : ""}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "day" && (
        <div className="rp-every">
          每
          <button className="rp-step" aria-label="少一天" disabled={every <= 1} onClick={() => changeEvery(every - 1)}>−</button>
          <input
            className="rp-num"
            type="number"
            min={1}
            max={365}
            value={every}
            onChange={(e) => changeEvery(Number(e.target.value))}
          />
          <button className="rp-step" aria-label="多一天" disabled={every >= 365} onClick={() => changeEvery(every + 1)}>＋</button>
          天
        </div>
      )}

      {tab === "week" && (
        <div className="rp-week">
          {WEEK_ORDER.map((d) => (
            <button key={d} className={`rp-cell${days.includes(d) ? " on" : ""}`} onClick={() => toggleDay(d)}>
              {WEEK_CN[d]}
            </button>
          ))}
        </div>
      )}

      {tab === "month" && (
        <div className="rp-month">
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
            <button key={d} className={`rp-cell${monthDay === d ? " on" : ""}`} onClick={() => setMonthDay(d)}>
              {d}
            </button>
          ))}
          {/* 31 号和「最后一天」是同一回事（没有 31 号的月份落在月末），所以选了哪个两格一起亮 */}
          <button className={`rp-cell rp-last${monthDay === 31 ? " on" : ""}`} onClick={() => setMonthDay(31)}>
            最后一天
          </button>
        </div>
      )}

      <div className="rp-foot">
        <span className="rp-preview">
          {draft ? describeRepeat(draft) : "至少选一天"}
          {draft?.kind === "monthly" && draft.day >= 29 && draft.day < 31 && (
            <span className="rp-note">没有这一天的月份落在月末</span>
          )}
        </span>
        <button className="rp-btn" onClick={onCancel}>取消</button>
        <button className="rp-btn primary" disabled={!draft} onClick={() => draft && onDone(draft)}>好</button>
      </div>
    </div>
  );
}
