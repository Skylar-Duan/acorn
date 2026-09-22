// 手机上「选循环」那一段的内容（09-21 统一口径）：任务详情的「重复」、记一条的「重复」共用。
// 有哪几项、按什么顺序、叫什么，一律从 core/options.repeatMenu 取，这儿只管画和点——
// 跟桌面那份（components/RepeatMenu）同一个来源，两端点开看到的是同一串：
//   [现值] 每天 / 每个工作日 / 每周X / 每月X号 / 每隔几天… / 自定义… / 不重复
//
// 手机上跟桌面不一样的两处，都是「手指 + 390 宽」逼出来的：
//   · 「每隔几天…」点了在下面长出一行「每 [ n ] 天 · 好」，弹的是数字键盘；
//   · 「自定义…」（和点现值）叠一张底部纸，里面就是桌面那块天 / 周 / 月面板（RepeatPicker），
//     逻辑一行不另写，只把格子放大到手指点得准（样式在 mobile-sheet.css 的 .msh-rp）。
//     这张纸是本地开关、不进抽屉栈：进了栈，底下那张任务详情就不在栈顶，会被当成「该收了」。
import { useState } from "react";
import type { RepeatRule } from "../core/model";
import { everyNDays, repeatMenu } from "../core/options";
import RepeatPicker from "../components/RepeatPicker";
import Sheet from "./Sheet";
import "../styles/mobile-sheet.css";

export interface RepeatOptionsProps {
  /** 这件事的日期，没有就今天：「每周X / 每月X号」按它取形 */
  anchor: string;
  /** 现在生效的规则 */
  value: RepeatRule | null;
  /** 选定了（null = 不重复） */
  onPick: (rule: RepeatRule | null) => void;
}

export default function RepeatOptions({ anchor, value, onPick }: RepeatOptionsProps) {
  const [everyOpen, setEveryOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  /** 每打开一次自定义纸就换一个 key：面板的草稿从「现在的规则」重新起，不接上一次没点「好」的 */
  const [customKey, setCustomKey] = useState(0);
  const items = repeatMenu(anchor, value);

  function openCustom() {
    setEveryOpen(false);
    setCustomKey((k) => k + 1);
    setCustomOpen(true);
  }

  function pick(rule: RepeatRule | null) {
    setEveryOpen(false);
    onPick(rule);
  }

  return (
    <>
      <div className="msh-chips">
        {items.map((it) => {
          switch (it.kind) {
            case "current":
              // 现值不在常用项里：挂在最前面、亮着，点它进自定义接着改
              return (
                <button key="current" className="msh-opt on" onClick={openCustom}>
                  ✓ {it.label}
                </button>
              );
            case "rule":
              return (
                <button
                  key={`rule-${it.rule.kind}`}
                  className={`msh-opt${it.on ? " on" : ""}`}
                  onClick={() => pick(it.rule)}
                >
                  {it.label}
                </button>
              );
            case "every":
              return (
                <button
                  key="every"
                  className={`msh-opt${everyOpen ? " open" : ""}`}
                  aria-expanded={everyOpen}
                  onClick={() => setEveryOpen(!everyOpen)}
                >
                  {it.label}
                </button>
              );
            case "custom":
              return (
                <button key="custom" className="msh-opt" onClick={openCustom}>
                  {it.label}
                </button>
              );
            case "clear":
              return (
                <button key="clear" className="msh-opt" onClick={() => pick(null)}>
                  {it.label}
                </button>
              );
          }
        })}
      </div>

      {everyOpen && (
        <EveryNRow
          initial={value?.kind === "daily" && value.every > 1 ? value.every : 2}
          onDone={pick}
        />
      )}

      <Sheet open={customOpen} onClose={() => setCustomOpen(false)} label="自定义循环" className="msh-rp-sheet">
        <div className="msh-rp">
          <div className="msheet-label">自定义循环</div>
          <RepeatPicker
            key={customKey}
            value={value}
            anchor={anchor}
            onDone={(r) => {
              pick(r);
              setCustomOpen(false);
            }}
            onCancel={() => setCustomOpen(false)}
          />
        </div>
      </Sheet>
    </>
  );
}

/** 「每隔几天…」长出来的那一行：每 [ n ] 天 · 好。只收 1–365 的整数，不合法时「好」是灰的 */
function EveryNRow({ initial, onDone }: { initial: number; onDone: (rule: RepeatRule) => void }) {
  const [text, setText] = useState(String(initial));
  const rule = everyNDays(text);
  return (
    <div className="msh-row msh-everyn">
      <span className="msh-everyn-t">每</span>
      <input
        className="msh-field"
        type="number"
        inputMode="numeric"
        min={1}
        max={365}
        enterKeyHint="done"
        value={text}
        aria-label="隔几天"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault(); // 别让这一下回车顺着跑到别处（记一条那张纸上回车是「记下」）
          if (rule) onDone(rule);
        }}
      />
      <span className="msh-everyn-t">天</span>
      <button className="msh-opt narrow" disabled={!rule} onClick={() => rule && onDone(rule)}>
        好
      </button>
    </div>
  );
}
