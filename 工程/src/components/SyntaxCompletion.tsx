// 给已有 input/textarea 加同一套候选；Fragment 与 portal 不改变任务行的布局。
import { cloneElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, InputHTMLAttributes, ReactElement, TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { pickSyntaxCandidates, sameName, syntaxToken } from "../core/syntaxCompletion";
import "../styles/syntaxinput.css";

type Field = HTMLInputElement | HTMLTextAreaElement;
type Props = InputHTMLAttributes<Field> & TextareaHTMLAttributes<Field>;
export default function SyntaxCompletion({ children, lists = [], tags = [], whos, owner, plainWho = false, multipleWho = false, onPick }: {
  children: ReactElement<Props>;
  lists?: string[]; tags?: string[]; whos: string[];
  owner: string;
  plainWho?: boolean;
  multipleWho?: boolean;
  onPick?: (name: string) => void;
}) {
  const [field, setField] = useState<Field | null>(null);
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [style, setStyle] = useState<CSSProperties>({});
  const dropRef = useRef<HTMLDivElement>(null);
  const lastName = /[^\s,，、@＠]*$/.exec(value.slice(0, caret))![0];
  const token = multipleWho ? { trigger: "@" as const, prefix: lastName, start: caret - lastName.length, end: caret }
    : plainWho ? { trigger: "@" as const, prefix: value.trim().replace(/^[@＠]/, ""), start: 0, end: value.length } : syntaxToken(value, caret);
  const source = token?.trigger === "#" ? tags : token?.trigger === "/" ? lists : whos;
  const candidates = token ? pickSyntaxCandidates(source, token.prefix) : [];
  const knownListPrefix = token?.trigger === "/" && source.some((name) => name.toLocaleLowerCase().startsWith(token.prefix.toLocaleLowerCase()));
  const createName = token && token.trigger !== "#" && !knownListPrefix && token.prefix && !source.some((name) => sameName(name, token.prefix)) ? token.prefix : null;
  const items = [...candidates.map((name) => ({ name, create: false })), ...(createName ? [{ name: createName, create: true }] : [])];
  const signature = token ? `${token.start}:${token.trigger}:${token.prefix}` : "";
  const open = !!field && !!token && (items.length > 0 || token.trigger !== "#") && dismissed !== signature;
  const index = Math.min(active, items.length - 1);
  useEffect(() => setActive(0), [signature]);
  useLayoutEffect(() => {
    if (!open || !field) return;
    function place() {
      const rect = field!.getBoundingClientRect();
      const height = Math.min(280, dropRef.current?.scrollHeight || 280);
      const above = window.innerHeight - rect.bottom < height + 12 && rect.top > height + 12;
      setStyle({ position: "fixed", zIndex: 1100, top: above ? Math.max(8, rect.top - height - 6) : rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(360, window.innerWidth - 32) - 8)),
        maxHeight: Math.max(36, Math.min(280, above ? rect.top - 16 : window.innerHeight - rect.bottom - 16)) });
    }
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, field, signature]);

  function refresh(el: Field) { setField(el); setValue(el.value); setCaret(el.selectionStart ?? el.value.length); }
  function accept(name: string) {
    if (!field || !token) return;
    if (onPick) { field.value = ""; setValue(""); setField(null); onPick(name); return; }
    const start = token.start + (multipleWho ? 0 : 1);
    const separator = token.trigger === "/" && token.start > 0 && !/\s/.test(value[token.start - 1]) ? " " : "";
    const next = `${value.slice(0, token.start)}${separator}${value.slice(token.start, start)}${name} ${value.slice(token.end)}`;
    const position = start + separator.length + name.length + 1;
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, next);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.setSelectionRange(position, position);
    refresh(field);
    if (multipleWho) setDismissed(`${position}:@:`);
  }
  const original = children.props;
  return <>{cloneElement(children, {
    onFocus: (e) => { refresh(e.currentTarget); setDismissed(null); original.onFocus?.(e); },
    onChange: (e) => { refresh(e.currentTarget); setDismissed(null); original.onChange?.(e); },
    onSelect: (e) => { refresh(e.currentTarget); original.onSelect?.(e); },
    onBlur: (e) => { setField(null); original.onBlur?.(e); },
    onKeyDown: (e) => {
      if (!e.nativeEvent.isComposing && open) {
        if (items.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setActive((index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length); return; }
        if (items.length > 0 && ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab")) { e.preventDefault(); e.stopPropagation(); accept(items[index].name); return; }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(signature); return; }
      }
      original.onKeyDown?.(e);
    },
  })}{open && createPortal(<div className="si-drop" role="listbox" aria-label="输入候选" data-task-popover={owner} data-qa-popover={owner} ref={dropRef} style={style}>
    {items.length === 0 && <span className="si-item">输入名字以新建{token?.trigger === "/" ? "清单" : "需求方"}</span>}
    {items.map((item, i) => <button key={`${item.create}:${item.name}`} type="button" role="option" aria-selected={i === index}
      className={`si-item${i === index ? " on" : ""}`} onMouseEnter={() => setActive(i)}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); accept(item.name); }}>
      {item.create ? `新建${token?.trigger === "/" ? "清单" : "需求方"}「${item.name}」` : `${token?.trigger}${item.name}`}
    </button>)}
  </div>, document.body)}</>;
}
