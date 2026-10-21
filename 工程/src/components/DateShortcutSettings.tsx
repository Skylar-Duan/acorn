import { useState } from "react";
import { dateShortcutLabel, defaultDateShortcuts, resolveDateShortcut, validDateShortcuts, type DateShortcutRule } from "../core/dateShortcuts";
import { todayYMD } from "../core/dates";
import { updateSettings, useApp } from "../core/store";
import "../styles/date-shortcuts.css";

export default function DateShortcutSettings() {
  const settings = useApp((s) => s.data.settings);
  const [draft, setDraft] = useState<DateShortcutRule[] | null>(null);
  const rules = validDateShortcuts(settings.dateShortcuts);
  const today = todayYMD();
  const valid = draft !== null && validDateShortcuts(draft).length === draft.length;
  function change(index: number, rule: DateShortcutRule) {
    setDraft((old) => old!.map((r, i) => i === index ? rule : r));
  }
  function move(index: number, step: number) {
    setDraft((old) => {
      const next = [...old!];
      [next[index], next[index + step]] = [next[index + step], next[index]];
      return next;
    });
  }
  return <div className="date-shortcut-settings">
    <div className="set-row">
      <div className="set-row-label">快捷日期
        <span className="set-hint">自定义选日期、安排日期与顺延菜单的数量、顺序和规则</span>
        <span className="set-hint">{rules.length ? rules.map(dateShortcutLabel).join(" · ") : "不显示快捷项，仍可选择任意日期"}</span>
      </div>
      <div className="set-ctl"><button className="btn" aria-expanded={draft !== null} onClick={() => setDraft(draft ? null : structuredClone(rules))}>{draft ? "收起编辑" : "编辑快捷日期"}</button></div>
    </div>
    {draft && <div className="date-shortcut-editor" aria-label="快捷日期设置" onKeyDown={(e) => e.stopPropagation()}>
      <p className="date-shortcut-note">工作日为周一至周五，暂不计法定节假日和调休。各周期末可独立选择自然日或工作日；工作日取该周期内最后一个工作日。半年按1—6月、7—12月划分。</p>
      <p className="date-shortcut-note">右侧预览以今天为准。菜单中相同日期只保留排在前面的一项；已过去的日期会隐藏。</p>
      {draft.map((rule, index) => <div className="date-shortcut-rule" key={rule.id}>
        <div className="date-shortcut-rule-head">
          <strong>{dateShortcutLabel(rule)}</strong>
          <span className="date-shortcut-preview">{validDateShortcuts([rule]).length ? resolveDateShortcut(today, rule, settings.weekendDay) : "请填写有效规则"}</span>
          <button className="btn" aria-label={`上移第${index + 1}项`} disabled={!index} onClick={() => move(index, -1)}>↑</button>
          <button className="btn" aria-label={`下移第${index + 1}项`} disabled={index === draft.length - 1} onClick={() => move(index, 1)}>↓</button>
          <button className="btn" aria-label={`删除第${index + 1}项`} onClick={() => setDraft(draft.filter((_, i) => i !== index))}>删除</button>
        </div>
        <div className="date-shortcut-fields">
          <label>规则<select value={rule.kind} onChange={(e) => {
            const common = { id: rule.id, name: rule.name, mode: rule.mode };
            change(index, e.target.value === "days" ? { ...common, kind: "days", days: 3 } : e.target.value === "week" ? { ...common, kind: "week", weeks: 0, day: 5 } : { ...common, kind: "end", period: "month" });
          }}><option value="days">几天后</option><option value="week">指定周与星期</option><option value="end">周期末</option></select></label>
          {rule.kind === "days" && <label>天数<input type="number" min="0" max="3650" step="1" value={Number.isNaN(rule.days) ? "" : rule.days} onChange={(e) => change(index, { ...rule, days: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>}
          {rule.kind === "week" && <>
            <label>哪一周<select value={rule.weeks} onChange={(e) => change(index, { ...rule, weeks: Number(e.target.value) })}><option value="0">本周</option><option value="1">下周</option><option value="2">下下周</option></select></label>
            <label>星期<select value={rule.day} onChange={(e) => change(index, { ...rule, day: e.target.value === "weekend" ? "weekend" : Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>周{"日一二三四五六"[d]}</option>)}<option value="weekend">周末（按设置）</option></select></label>
          </>}
          {rule.kind === "end" && <label>周期<select value={rule.period} onChange={(e) => change(index, { ...rule, period: e.target.value as "month" | "quarter" | "halfYear" | "year" })}><option value="month">月末</option><option value="quarter">季度末</option><option value="halfYear">半年末</option><option value="year">年底</option></select></label>}
          <label>日期口径<select value={rule.mode ?? "calendar"} onChange={(e) => change(index, { ...rule, mode: e.target.value as "calendar" | "workday" })}><option value="calendar">自然日</option><option value="workday">工作日</option></select></label>
          <label className="date-shortcut-name">显示名称（可选）<input maxLength={32} value={rule.name ?? ""} placeholder="留空自动命名" onChange={(e) => change(index, { ...rule, name: e.target.value })} /></label>
        </div>
      </div>)}
      <div className="date-shortcut-footer">
        <button className="btn" onClick={() => setDraft([...draft, { id: `custom-${crypto.randomUUID()}`, kind: "days", days: 3 }])}>＋ 添加快捷日期</button>
        <button className="btn" onClick={() => setDraft(defaultDateShortcuts())}>恢复默认</button>
        <span />
        <button className="btn" onClick={() => setDraft(null)}>取消</button>
        <button className="btn primary" disabled={!valid} onClick={() => { updateSettings({ dateShortcuts: structuredClone(draft) }); setDraft(null); }}>保存</button>
      </div>
    </div>}
  </div>;
}
