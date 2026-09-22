// 桌面上「选循环」那张小菜单的内容（09-21 统一口径）：任务卡「↻ 循环」和快速添加条「🔁 重复」共用。
// 有哪几项、按什么顺序、叫什么，一律从 core/options.repeatMenu 取，这儿只管画和点：
//   [现值 ✓] 每天 / 每个工作日 / 每周X / 每月X号 / 每隔几天… / 自定义… / 不重复
// 「每隔几天…」点开就在原地变成一个小输入「每 [ ] 天」，回车写入；Esc 或点「取消」收回去。
// 「自定义…」和点现值都交给调用方去换成 RepeatPicker 面板（面板画在调用方自己的 .popmenu 里）。
import { useState } from "react";
import type { RepeatRule } from "../core/model";
import { everyNDays, repeatMenu, type RepeatMenuItem } from "../core/options";
import "../styles/repeatpicker.css";

export interface RepeatMenuProps {
  /** 这件事的日期，没有就今天：「每周X / 每月X号」按它取形 */
  anchor: string;
  /** 现在生效的规则 */
  value: RepeatRule | null;
  /** 选定了（null = 不重复） */
  onPick: (rule: RepeatRule | null) => void;
  /** 打开「自定义…」面板 */
  onCustom: () => void;
  /** 换一份菜单项（仍须出自 core/options.repeatMenu）：习惯用 core/habits.habitRepeatMenu，少一项「不重复」。
   *  不给就是 repeatMenu(anchor, value) */
  items?: RepeatMenuItem[];
}

export default function RepeatMenu({ anchor, value, onPick, onCustom, items: given }: RepeatMenuProps) {
  const [everyOpen, setEveryOpen] = useState(false);
  const items = given ?? repeatMenu(anchor, value);
  return (
    <>
      {items.map((it) => {
        switch (it.kind) {
          case "current":
            return (
              <div key="current">
                <button className="item" onClick={onCustom}>
                  {it.label}<span className="k">✓</span>
                </button>
                <div className="sep" />
              </div>
            );
          case "rule":
            return (
              <button key={`rule-${it.rule.kind}`} className="item" onClick={() => onPick(it.rule)}>
                {it.label}
                {it.on && <span className="k">✓</span>}
              </button>
            );
          case "every":
            return everyOpen ? (
              <EveryNInput
                key="every"
                initial={value?.kind === "daily" && value.every > 1 ? value.every : 2}
                onDone={onPick}
                onCancel={() => setEveryOpen(false)}
              />
            ) : (
              <button key="every" className="item" onClick={() => setEveryOpen(true)}>{it.label}</button>
            );
          case "custom":
            return (
              <div key="custom">
                <div className="sep" />
                <button className="item" onClick={onCustom}>{it.label}</button>
              </div>
            );
          case "clear":
            return <button key="clear" className="item" onClick={() => onPick(null)}>{it.label}</button>;
        }
      })}
    </>
  );
}

/** 「每隔几天…」摊开后的小输入：每 [n] 天 · 好。只收 1–365 的整数，不合法时「好」按了也不写 */
function EveryNInput({ initial, onDone, onCancel }: {
  initial: number;
  onDone: (rule: RepeatRule) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(String(initial));
  const rule = everyNDays(text);
  return (
    <div className="rp-everyn">
      每
      <input
        className="rp-num"
        type="number"
        min={1}
        max={365}
        autoFocus
        value={text}
        aria-label="隔几天"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation(); // 同顺延的「选日期…」：别让全局快捷键接着吃这一下回车
            if (rule) onDone(rule);
          } else if (e.key === "Escape") {
            // 只收回这个小输入，不连整张菜单一起关
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      天
      <button className="rp-btn primary" disabled={!rule} onClick={() => rule && onDone(rule)}>好</button>
    </div>
  );
}
