// 「随手记一条」浮窗：独立小窗，Alt+Space 唤起。
// 不碰数据文件——解析后把结果发给主窗落库，用完即隐。
import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "../styles/themes.css";
import "../styles/base.css";
import { parseQuickAdd } from "../core/parse";

const CHIP_ICON: Record<string, string> = {
  date: "📅", time: "🕒", repeat: "↻", list: "▤", tag: "#", who: "＠", priority: "⚑",
};

function applyThemeAttrs(theme: string, mode: string) {
  const el = document.documentElement;
  el.dataset.theme = theme || "forest";
  el.dataset.mode =
    mode === "system" || !mode
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : mode;
}

function QuickAddApp() {
  const [text, setText] = useState("");
  const [listNames, setListNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    applyThemeAttrs("forest", "system");
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      await listen<{ listNames: string[]; theme: string; mode: string }>("quickadd:context", (e) => {
        setListNames(e.payload.listNames);
        applyThemeAttrs(e.payload.theme, e.payload.mode);
      });
      await listen("quickadd:show", async () => {
        setText("");
        await emitTo("main", "quickadd:pull", {});
        setTimeout(() => inputRef.current?.focus(), 50);
      });
      await emitTo("main", "quickadd:pull", {});
    })();
  }, []);

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    return parseQuickAdd(text, { now: new Date(), listNames });
  }, [text, listNames]);

  async function hide() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  }

  async function submit() {
    if (!parsed || !parsed.title.trim()) return;
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("main", "quickadd:submit", {
      title: parsed.title.trim(),
      listName: parsed.listName,
      tags: parsed.tags,
      who: parsed.who,
      priority: parsed.priority,
      due: parsed.due,
      dueTime: parsed.dueTime,
      repeat: parsed.repeat,
    });
    setText("");
    await hide();
  }

  return (
    <div
      style={{
        background: "var(--card)", border: "1px solid var(--hair)", borderRadius: 14,
        boxShadow: "var(--shadow)", padding: "16px 18px", margin: 8,
        display: "flex", flexDirection: "column", gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }} data-tauri-drag-region>
        <span style={{ fontFamily: "var(--serif)", fontSize: 15, letterSpacing: 2, color: "var(--ink-2)" }} data-tauri-drag-region>
          🌰 随手记一条
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3)" }}>Esc 关闭 · 回车收下</span>
      </div>
      <input
        ref={inputRef}
        className="input"
        autoFocus
        style={{ fontSize: 15, padding: "10px 14px" }}
        placeholder="想到什么记什么…「周五下午3点 提交周报 #工作 @李哥 !高」"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
          if (e.key === "Escape") void hide();
        }}
      />
      <div style={{ display: "flex", gap: 6, minHeight: 22, flexWrap: "wrap" }}>
        {parsed?.chips.map((c, i) => (
          <span key={i} className="chip">
            {CHIP_ICON[c.kind] ?? ""} {c.text}
          </span>
        ))}
      </div>
    </div>
  );
}

document.body.style.background = "transparent";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QuickAddApp />
  </React.StrictMode>,
);
