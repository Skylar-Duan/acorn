// 可复用的「快捷语法输入框」：边打字边解析 chips 预览，# 标签 · @ 需求方 · / 清单 自动补全。
// 纯受控组件：不碰 store，候选与文本全走 props；回车把 ParseResult 交还调用方落库。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  SyntheticEvent,
  MutableRefObject,
} from "react";
import type { ParseChip, ParseResult } from "../core/parse";
import { parseQuickAdd } from "../core/parse";
import { CommitMark, useCommitFlash } from "./commitFlash";
import { growArea, keepLines, oneLine } from "./autogrow";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import "../styles/syntaxinput.css";

export interface SyntaxInputProps {
  value: string;
  onChange: (v: string) => void;
  /** 回车提交。**回执由调用方说了算**：明确返回 false = 这一下什么都没存
   *  （用法页那个只解析不落库的试写框、只写了日期没写标题的子任务栏），那就不闪 ✓。
   *  返回 true / 什么都不返回 = 存下了，照旧闪。A2 那个回执的全部价值在于它不能说谎 */
  onSubmit: (parsed: ParseResult) => boolean | void | Promise<boolean | void>;
  lists: string[];
  tags: string[];
  whos: string[];
  placeholder?: string;
  autoFocus?: boolean;
  /** 是否显示解析 chips，默认 true */
  showChips?: boolean;
  /** 不认这几类要素（子任务行用：没有清单/标签/需求方/循环）。被关掉的类别也不弹补全 */
  skip?: ParseChip["kind"][];
  /** 「周末」指周六还是周日（设置里那一项）。这个框不碰 store，得由调用方喂进来；不给就当周日 */
  weekendDay?: "sat" | "sun";
  inputStyle?: CSSProperties;
  /** 失焦时怎么办（A1「点走 = 提交」）。**这里不写死任何一种语义**：
   *  这个框由记一条、加子任务和浮窗复用，
   *  记一条那条要躲开自己那排点选按钮、浮窗根本不能在失焦时落库——各家自己判。
   *  不给这个 prop 就是老样子：失焦只关补全下拉，什么都不提交。
   *  返回 true = 真的存下去了，这边才闪回执 */
  onBlurCommit?: (parsed: ParseResult, e: ReactFocusEvent<SyntaxInputEl>) => boolean | Promise<boolean>;
  /** 补全下拉没开着时按 Esc。返回 true = 这一下我吃掉了（不再往外冒泡）。
   *  新子任务会丢弃草稿，浮窗会隐藏窗口，各处自行决定 */
  onEscape?: () => boolean;
  /** Shift+Enter（A8「一路回车敲完一张卡」里的收卡那一下）。不给就当普通回车 */
  onShiftEnter?: () => void;
  /** 长句子换行显示，不再单行截断（v1.9.1）。底下的元素从 input 换成自动撑高的 textarea。
   *
   *  **默认关着**。记一条那条是个一行高的横条、
   *  快捷记浮窗更是一个固定大小的系统窗口——那两处长高了就会把宿主的版式顶变形。
   *  开着的时候语义一点不变：回车照旧是提交（在 textarea 里得自己拦掉默认的换行），
   *  粘进来的换行符照旧当空格吃掉（一句话就是一句话，不能是两行）。 */
  multiline?: boolean;
  /** 允许真的换行（任务卡里加子任务那一栏用）。开了它就一定是 textarea（等于顺带开了 multiline）：
   *  Shift+Enter 不再交给 onShiftEnter，而是照 textarea 的默认插一个换行；粘进来的换行也留着
   *  （\r\n 统一成 \n）。Enter 仍是提交，补全下拉开着时 Enter 仍是选候选——那两条一点不变。
   *  换行要一路留到标题里，调用方解析时还得给 parse 开 keepNewlines */
  allowNewline?: boolean;
  /** 将图片粘贴/拖入绑定到真正的文字输入。 */
  elementRef?: MutableRefObject<SyntaxInputEl | null>;
}

/** 这个框底下那个真实元素。开了 multiline 是 textarea，否则还是 input——
 *  两条路的事件、光标 API（selectionStart / setSelectionRange）完全一致，
 *  所以上面那一整套补全/提交逻辑一份就够，不必分家 */
export type SyntaxInputEl = HTMLInputElement | HTMLTextAreaElement;

// chips 图标：与 QuickAddBar 保持一致
const CHIP_ICON: Record<ParseChip["kind"], IconName> = {
  date: "calendar", time: "clock", repeat: "repeat", list: "folder", tag: "tag", who: "person", priority: "flag",
};

// 触发字符 → 候选类别
const TRIGGER_KIND = { "#": "tag", "@": "who", "/": "list" } as const;
type Trigger = keyof typeof TRIGGER_KIND;

// 光标前的未完成 token：触发字符 + 已敲的前缀（不含空白与其他触发符）。
// ~ / ～ 也是边界：打「@李哥~3点」时那个 ~ 之后是时间，不该再往候选里筛人名
const TOKEN_RE = /(?:^|\s)([#@\/])([^\s#@\/!！~～]*)$/;

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
  placeholder, autoFocus, showChips = true, skip, weekendDay, inputStyle,
  onBlurCommit, onEscape, onShiftEnter, multiline: multilineProp = false, allowNewline = false, elementRef,
}: SyntaxInputProps) {
  const multiline = multilineProp || allowNewline;
  const inputRef = useRef<SyntaxInputEl | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [dropStyle, setDropStyle] = useState<CSSProperties>({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { on: flashOn, flash } = useCommitFlash();
  const [caret, setCaret] = useState(0);
  /** Esc 关掉的那个下拉的签名：签名不变就不再弹，继续敲字换了签名会重开 */
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  /** 接受补全后待恢复的光标位置（受控 value 更新落地后再设） */
  const pendingCaret = useRef<number | null>(null);

  // props 传数组每次渲染都是新引用，序列化成串当依赖，免得每次打字都重算
  const skipKey = (skip ?? []).join(",");
  const parsed = useMemo(
    () => parseQuickAdd(value, { now: new Date(), listNames: lists, skip, weekendDay }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, lists, skipKey, weekendDay],
  );

  const drop = useMemo<DropMatch | null>(() => {
    const m = TOKEN_RE.exec(value.slice(0, caret));
    if (m === null) return null;
    const trigger = m[1] as Trigger;
    const prefix = m[2];
    // 这一类根本不认，就别弹补全了（子任务行里的 # @ / 就是普通字符）
    if (skip?.includes(TRIGGER_KIND[trigger])) return null;
    const source = trigger === "#" ? tags : trigger === "@" ? whos : lists;
    const items = pickCandidates(source, prefix);
    if (items.length === 0) return null;
    return { trigger, start: caret - prefix.length - 1, end: caret, prefix, items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, caret, tags, whos, lists, skipKey]);

  const dropKey = drop === null ? null : `${drop.trigger}${drop.start}:${drop.prefix}`;
  const open = drop !== null && dropKey !== dismissedKey;
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = dropRef.current;
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!el || !rect) return;
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const up = below < Math.min(el.scrollHeight, 280) && above > below;
      const left = Math.max(8 - rect.left, Math.min(0, window.innerWidth - rect.left - el.offsetWidth - 8));
      const next: CSSProperties = { left, top: up ? "auto" : "calc(100% + 6px)", bottom: up ? "calc(100% + 6px)" : "auto", maxHeight: Math.max(36, Math.min(280, up ? above : below)) };
      setDropStyle((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, dropKey]);
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

  // multiline 那条路的高度跟着内容走。ref 回调只在挂载那一下调一次，
  // 所以每次 value 变了都得再算一遍——**受控组件**，句子还会被调用方从外面改
  // （调用方还原草稿、提交后清空，都会从外部改值）
  useLayoutEffect(() => {
    if (!multiline) return;
    const el = inputRef.current;
    if (el instanceof HTMLTextAreaElement) growArea(el);
  }, [value, multiline]);

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

  function handleKeyDown(e: ReactKeyboardEvent<SyntaxInputEl>) {
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
    // 允许换行的框（子任务栏）：Shift+Enter 就是换行，放给 textarea 自己插，别拦
    if (e.key === "Enter" && e.shiftKey && allowNewline) return;
    if (e.key === "Enter") {
      // multiline 那条路底下是 textarea，Enter 默认是插一个换行。
      // 这个框写的是**一句话**，回车的意思从头到尾都是「就这样，存」，不是换行
      e.preventDefault();
      if (e.shiftKey && onShiftEnter) {
        onShiftEnter();
        return;
      }
      submit(parsed);
      return;
    }
    if (e.key === "Escape" && onEscape && onEscape()) {
      // 调用方吃掉了这一下（比如丢弃新子任务草稿），别再让外层收卡片
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // 其余情况 Esc 不拦截，冒泡交给外层（清空选中/收卡片/关窗由调用方决定）
  }

  /** 提交并闪一下回执。空框不闪——那一下什么都没存；
   *  调用方明说「没存」（返回 false）的同样不闪，见 onSubmit 那段注释 */
  function submit(p: ParseResult) {
    const stored = onSubmit(p);
    if (stored instanceof Promise) {
      void stored.then((result) => { if (mounted.current && result !== false && value.trim()) flash(); });
      return;
    }
    if (stored !== false && value.trim()) flash();
  }

  function handleBlur(e: ReactFocusEvent<SyntaxInputEl>) {
    if (dropKey !== null) setDismissedKey(dropKey);
    // 点补全项不会走到这儿：那边 onMouseDown 已经 preventDefault，焦点根本没离开。
    //
    // **窗口失焦不是点走**（A1 的统一口径，一处盖住所有 onBlurCommit 的调用方）：
    // alt-tab 去别的程序时浏览器照样发 blur，半句草稿不能被当成已经说完。
    // 正确的行为是**原样悬着**，等用户回来自己了结（回车提交 / Esc 丢弃）
    if (!document.hasFocus()) return;
    if (onBlurCommit && value.trim()) {
      const stored = onBlurCommit(parsed, e);
      if (stored instanceof Promise) void stored.then((result) => { if (mounted.current && result) flash(); });
      else if (stored) flash();
    }
  }

  function handleChange(e: ChangeEvent<SyntaxInputEl>) {
    setCaret(e.target.selectionStart ?? e.target.value.length);
    setDismissedKey(null);
    // 一句话就是一句话：粘进来的换行符当空格吃掉（input 那边本来是浏览器替我们吃的）。
    // 允许换行的框例外：换行留着，只把 \r\n / \r 统一成 \n
    const v = e.target.value;
    onChange(allowNewline ? keepLines(v) : multiline ? oneLine(v) : v);
  }

  // 两条路共用同一份属性：分开写两遍迟早有一处漏改（少个 onSelect，光标一挪补全就错位）
  const shared = {
    className: `si-input${flashOn ? " commit-lit" : ""}`,
    value,
    placeholder,
    autoFocus,
    style: inputStyle,
    onChange: handleChange,
    onSelect: (e: SyntheticEvent<SyntaxInputEl>) => {
      setCaret(e.currentTarget.selectionStart ?? 0);
    },
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
  };

  return (
    <div className="si-wrap" ref={wrapRef}>
      {multiline ? (
        <textarea
          ref={(el) => {
            inputRef.current = el;
            if (elementRef) elementRef.current = el;
            growArea(el);
          }}
          rows={1}
          {...shared}
        />
      ) : (
        <input ref={(el) => { inputRef.current = el; if (elementRef) elementRef.current = el; }} {...shared} />
      )}
      <CommitMark on={flashOn} />
      {showChips && parsed.chips.length > 0 && (
        <span className="si-chips">
          {parsed.chips.map((c, i) => (
            <span key={`${c.kind}-${i}`} className="chip">
              <Icon name={CHIP_ICON[c.kind]} size={13} /> <span>{c.text}</span>
            </span>
          ))}
        </span>
      )}
      {open && drop !== null && (
        <div className="si-drop" ref={dropRef} style={dropStyle}>
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
              <span className="si-mark"><Icon name={CHIP_ICON[TRIGGER_KIND[drop.trigger]]} size={14} /></span>
              {it}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
