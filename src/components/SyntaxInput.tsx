// 可复用的「快捷语法输入框」：边打字边解析 chips 预览，# 标签 · @ 需求方 · / 清单 自动补全。
// 纯受控组件：不碰 store，候选与文本全走 props；回车把 ParseResult 交还调用方落库。
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  SyntheticEvent,
} from "react";
import type { ParseChip, ParseResult } from "../core/parse";
import { parseQuickAdd } from "../core/parse";
import "../styles/syntaxinput.css";

export interface SyntaxInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (parsed: ParseResult) => void;
  lists: string[];
  tags: string[];
  whos: string[];
  placeholder?: string;
  autoFocus?: boolean;
  /** 是否显示解析 chips，默认 true */
  showChips?: boolean;
  inputStyle?: CSSProperties;
}

// chips 图标：与 QuickAddBar 保持一致
const CHIP_ICON: Record<ParseChip["kind"], string> = {
  date: "📅", time: "🕒", repeat: "↻", list: "▤", tag: "#", who: "＠", priority: "⚑",
};

// 触发字符 → 候选类别
const TRIGGER_KIND = { "#": "tag", "@": "who", "/": "list" } as const;
type Trigger = keyof typeof TRIGGER_KIND;

// 光标前的未完成 token：触发字符 + 已敲的前缀（不含空白与其他触发符）
const TOKEN_RE = /(?:^|\s)([#@\/])([^\s#@\/!！]*)$/;

const MAX_ITEMS = 6;

/** 前缀命中优先，其次包含命中，最多 6 条；空前缀给全量前 6 */
function pickCandidates(source: string[], prefix: string): string[] {
  if (prefix === "") return source.slice(0, MAX_ITEMS);
  const pre: string[] = [];
  const inc: string[] = [];
  for (const s of source) {
    if (s.startsWith(prefix)) pre.push(s);
    else if (s.includes(prefix)) inc.push(s);
  }
  return [...pre, ...inc].slice(0, MAX_ITEMS);
}

interface DropMatch {
  trigger: Trigger;
  /** 触发字符在全文中的下标 */
  start: number;
  /** 替换终点 = 光标位置 */
  end: number;
  prefix: string;
  items: string[];
}

export default function SyntaxInput({
  value, onChange, onSubmit, lists, tags, whos,
  placeholder, autoFocus, showChips = true, inputStyle,
}: SyntaxInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  /** Esc 关掉的那个下拉的签名：签名不变就不再弹，继续敲字换了签名会重开 */
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  /** 接受补全后待恢复的光标位置（受控 value 更新落地后再设） */
  const pendingCaret = useRef<number | null>(null);

  const parsed = useMemo(
    () => parseQuickAdd(value, { now: new Date(), listNames: lists }),
    [value, lists],
  );

  const drop = useMemo<DropMatch | null>(() => {
    const m = TOKEN_RE.exec(value.slice(0, caret));
    if (m === null) return null;
    const trigger = m[1] as Trigger;
    const prefix = m[2];
    const source = trigger === "#" ? tags : trigger === "@" ? whos : lists;
    const items = pickCandidates(source, prefix);
    if (items.length === 0) return null;
    return { trigger, start: caret - prefix.length - 1, end: caret, prefix, items };
  }, [value, caret, tags, whos, lists]);

  const dropKey = drop === null ? null : `${drop.trigger}${drop.start}:${drop.prefix}`;
  const open = drop !== null && dropKey !== dismissedKey;
  const activeIdx = drop === null ? 0 : Math.min(active, drop.items.length - 1);

  // 候选集换了（换 token / 前缀变化）就回到第一项
  useEffect(() => {
    setActive(0);
  }, [dropKey]);

  // 受控 value 更新落地后，把光标挪到补全插入点末尾
  useEffect(() => {
    const p = pendingCaret.current;
    if (p !== null) {
      pendingCaret.current = null;
      inputRef.current?.setSelectionRange(p, p);
    }
  }, [value]);

  /** 把部分 token 替换成完整值 + 尾随空格，焦点留在输入框继续打 */
  function accept(item: string) {
    if (drop === null) return;
    const next = `${value.slice(0, drop.start + 1)}${item} ${value.slice(drop.end)}`;
    const pos = drop.start + 1 + item.length + 1;
    pendingCaret.current = pos;
    setCaret(pos);
    setDismissedKey(null);
    onChange(next);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return; // IME 组字中不抢按键
    if (open && drop !== null) {
      const n = drop.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((activeIdx + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        accept(drop.items[activeIdx]);
        return;
      }
      if (e.key === "Escape") {
        // 只关下拉，不让外层收到 Esc
        e.preventDefault();
        e.stopPropagation();
        setDismissedKey(dropKey);
        return;
      }
      return;
    }
    if (e.key === "Enter") onSubmit(parsed);
    // Esc 不拦截，冒泡交给外层（清空/关窗由调用方决定）
  }

  return (
    <div className="si-wrap">
      <input
        ref={inputRef}
        className="si-input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        style={inputStyle}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setDismissedKey(null);
          onChange(e.target.value);
        }}
        onSelect={(e: SyntheticEvent<HTMLInputElement>) => {
          setCaret(e.currentTarget.selectionStart ?? 0);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (dropKey !== null) setDismissedKey(dropKey);
        }}
      />
      {showChips && parsed.chips.length > 0 && (
        <span className="si-chips">
          {parsed.chips.map((c, i) => (
            <span key={`${c.kind}-${i}`} className="chip">
              {CHIP_ICON[c.kind]} {c.text}
            </span>
          ))}
        </span>
      )}
      {open && drop !== null && (
        <div className="si-drop">
          {drop.items.map((it, i) => (
            <button
              key={it}
              type="button"
              className={`si-item${i === activeIdx ? " on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // 焦点留在输入框
                accept(it);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="si-mark">{CHIP_ICON[TRIGGER_KIND[drop.trigger]]}</span>
              {it}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
