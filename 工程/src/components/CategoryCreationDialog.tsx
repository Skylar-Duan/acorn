import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CATEGORY_COLORS, CATEGORY_ICONS, categoryIcon } from "../core/categoryIcons";
import { listColor } from "../core/colors";
import { finishCategoryDraft, useCategoryCreation, type CategoryDraft } from "../core/categoryCreation";
import SidebarIcon from "./SidebarIcon";
import "../styles/category-creation.css";

function CategoryCreationDialog({ initial }: { initial: CategoryDraft }) {
  const [draft, setDraft] = useState(initial);
  const box = useRef<HTMLFormElement>(null);
  const person = draft.kind === "who";
  const noun = person ? "需求方" : "清单";
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLInputElement>("input")?.focus();
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopImmediatePropagation(); finishCategoryDraft(null);
      }
      if (e.key === "Tab") {
        const fields = [...(box.current?.querySelectorAll<HTMLElement>("input,button:not(:disabled)") ?? [])];
        const first = fields[0], last = fields[fields.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener("keydown", keys, true);
    return () => { document.removeEventListener("keydown", keys, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="overlay category-create-back" data-category-dialog onMouseDown={(e) => {
    e.stopPropagation(); if (e.target === e.currentTarget) finishCategoryDraft(null);
  }}>
    <form ref={box} className="modal category-create" role="dialog" aria-modal="true" aria-labelledby="category-create-title"
      onSubmit={(e) => {
        e.preventDefault();
        const name = draft.name.trim();
        if (name) finishCategoryDraft({ ...draft, name });
      }}>
      <header>
        <div><p>给{person ? "这个人" : "这张清单"}一个记号</p><h2 id="category-create-title">新建{noun}</h2></div>
        <button type="button" className="category-create-close" aria-label={`取消新建${noun}`} onClick={() => finishCategoryDraft(null)}>×</button>
      </header>
      <div className="category-create-name">
        <span className="category-create-preview" style={{ color: listColor(draft.color), background: `color-mix(in srgb, ${listColor(draft.color)} 13%, transparent)` }}>
          <SidebarIcon path={categoryIcon(draft.kind, draft.icon)} />
        </span>
        <label><span>{noun}名称</span><input className="input" value={draft.name} maxLength={80} placeholder={person ? "例如：李哥、设计团队" : "例如：工作、读书计划"}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      </div>
      <fieldset><legend>颜色</legend><div className="category-color-options">
        {CATEGORY_COLORS.map((color) => <button key={color.id} type="button" title={color.name} aria-label={color.name} aria-pressed={draft.color === color.id}
          className={draft.color === color.id ? "selected" : ""} style={{ "--category-color": `var(--list-${color.id})` } as React.CSSProperties}
          onClick={() => setDraft({ ...draft, color: color.id })}><span>{draft.color === color.id ? "✓" : ""}</span></button>)}
        <label className={`category-custom-color${draft.color.startsWith("#") ? " selected" : ""}`} title="自选颜色" style={{ "--category-custom": draft.color.startsWith("#") ? draft.color : "#b86f52" } as React.CSSProperties}>
          <input type="color" aria-label="自选颜色" value={/^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : "#b86f52"} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 3 6 6-9 9-7 1 1-7z M13 5l6 6 M5 19l-2 2" /></svg>
        </label>
      </div></fieldset>
      <fieldset><legend>{person ? "人物图标" : "清单图标"}</legend><div className="category-icon-options">
        {CATEGORY_ICONS[draft.kind].map((icon) => <button key={icon.id} type="button" title={icon.name} aria-label={icon.name} aria-pressed={draft.icon === icon.id}
          className={draft.icon === icon.id ? "selected" : ""} onClick={() => setDraft({ ...draft, icon: icon.id })}>
          <SidebarIcon path={icon.path} />
        </button>)}
      </div></fieldset>
      <footer><button type="button" className="btn" onClick={() => finishCategoryDraft(null)}>取消</button><button type="submit" className="btn primary" disabled={!draft.name.trim()}>创建{noun}</button></footer>
    </form>
  </div>, document.body);
}

export default function CategoryCreationHost() {
  const pending = useCategoryCreation((s) => s.pending);
  return pending ? <CategoryCreationDialog key={`${pending.draft.kind}:${pending.draft.name}`} initial={pending.draft} /> : null;
}
