import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { defaultSettings } from "../core/model";
import { recordShortcut } from "../core/shortcutCapture";
import { applyQuickAddShortcut, resumeQuickAddShortcut, suspendQuickAddShortcut } from "../core/shortcutCtl";
import { updateSettings } from "../core/store";
import Icon from "./Icon";
import "../styles/shortcut-recorder.css";

function RecorderDialog({ value, close }: { value: string; close: () => void }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState(value.split("+").length > 3 ? "最多三个键，请重新按一组。" : "");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const readyRef = useRef(false);
  const savingRef = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const capture = useRef<HTMLDivElement>(null);
  const held = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    const previous = document.activeElement as HTMLElement | null;
    capture.current?.focus();
    void suspendQuickAddShortcut().then(() => { if (alive) { readyRef.current = true; setReady(true); } }).catch(() => {
      if (alive) setError("暂时无法开始录制，请关闭后重试。");
    });
    function down(e: KeyboardEvent) {
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.stopImmediatePropagation();
        const buttons = [...(box.current?.querySelectorAll<HTMLElement>('[tabindex="0"], button:not(:disabled)') ?? [])];
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        return;
      }
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault(); e.stopImmediatePropagation(); if (!savingRef.current) close(); return;
      }
      // 保留键盘访问底部按钮，录制区里的回车和空格则当成待录制的按键。
      if ((e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey &&
          e.target instanceof Element && e.target.closest("button")) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!readyRef.current || savingRef.current || e.repeat || e.isComposing) return;
      held.current.add(e.code);
      const next = recordShortcut(e, held.current);
      setDraft(next.value); setError(next.error);
    }
    function up(e: KeyboardEvent) { held.current.delete(e.code); e.stopImmediatePropagation(); }
    function blur() { held.current.clear(); }
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      alive = false;
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
      void resumeQuickAddShortcut();
      if (previous?.isConnected) previous.focus();
    };
  }, [close]);

  async function save() {
    if (!ready || savingRef.current || error || !draft) return;
    savingRef.current = true; setSaving(true);
    const ok = await applyQuickAddShortcut(draft);
    if (ok) { updateSettings({ quickAddShortcut: draft }); close(); }
    else {
      setError("这组快捷键不可用或已被其他程序占用，请换一组。");
      // 注册失败后继续录制，旧设置在取消时恢复。
      savingRef.current = false; setSaving(false);
    }
  }

  return createPortal(<div className="overlay shortcut-recorder-back" onMouseDown={(e) => {
    if (e.target === e.currentTarget && !savingRef.current) close();
  }}>
    <div className="modal shortcut-recorder" ref={box} role="dialog" aria-modal="true" aria-labelledby="shortcut-recorder-title">
      <header><h2 id="shortcut-recorder-title">设置全局快捷键</h2><button type="button" aria-label="关闭快捷键设置" disabled={saving} onClick={close}><Icon name="close" size={20} /></button></header>
      <p>按下你想用的组合，最多三个键。保存后用于唤起「记一条」。</p>
      <div className="shortcut-capture" tabIndex={0} ref={capture} aria-label="快捷键录制区" aria-describedby="shortcut-recorder-status" aria-live="polite">
        {draft ? draft.split("+").slice(0, 3).map((key, index) => <kbd key={`${index}:${key}`}>{key === "Super" ? "Win" : key}</kbd>) : <span>请按下快捷键</span>}
      </div>
      <p id="shortcut-recorder-status" className={`shortcut-status${error ? " invalid" : ""}`} role="status">{error || (saving ? "正在保存…" : ready ? "正在收集按键 · 松开后可重新录制" : "正在准备录制…")}</p>
      <footer>
        <button type="button" className="btn shortcut-reset" disabled={!ready || saving} onClick={() => { held.current.clear(); setDraft(defaultSettings().quickAddShortcut); setError(""); capture.current?.focus(); }}>重置为默认</button>
        <button type="button" className="btn" disabled={saving} onClick={close}>取消</button>
        <button type="button" className="btn primary" disabled={!ready || saving || !!error || !draft} onClick={() => void save()}>保存</button>
      </footer>
    </div>
  </div>, document.body);
}

export default function ShortcutRecorder({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  // 稳定引用，避免每次敲键都卸载录制监听并恢复旧热键。
  const [close] = useState(() => () => setOpen(false));
  return <><button type="button" className="btn set-shortcut" aria-label={`设置全局快捷键，当前 ${value}`} onClick={() => setOpen(true)}>{value.replace(/Super/g, "Win")}</button>{open && <RecorderDialog value={value} close={close} />}</>;
}
