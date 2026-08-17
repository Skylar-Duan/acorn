// 「随手记一条」浮窗：独立小窗，Alt+Space 唤起。
// 不碰数据文件——解析后把结果发给主窗落库，用完即隐。补全候选（清单/标签/需求方）由主窗随 context 事件下发。
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "../styles/themes.css";
import "../styles/base.css";
import type { ParseResult } from "../core/parse";
import SyntaxInput from "../components/SyntaxInput";

function applyThemeAttrs(theme: string, mode: string) {
  const el = document.documentElement;
  el.dataset.theme = theme || "forest";
  el.dataset.mode =
    mode === "system" || !mode
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : mode;
}

interface Ctx {
  listNames: string[];
  tagNames: string[];
  whoNames: string[];
  theme: string;
  mode: string;
}

function QuickAddApp() {
  const [text, setText] = useState("");
  const [ctx, setCtx] = useState<Ctx>({ listNames: [], tagNames: [], whoNames: [], theme: "forest", mode: "system" });

  useEffect(() => {
    applyThemeAttrs("forest", "system");
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      await listen<Ctx>("quickadd:context", (e) => {
        setCtx(e.payload);
        applyThemeAttrs(e.payload.theme, e.payload.mode);
      });
      await listen("quickadd:show", async () => {
        setText("");
        await emitTo("main", "quickadd:pull", {});
      });
      await emitTo("main", "quickadd:pull", {});
    })();
  }, []);

  async function hide() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  }

  async function submit(parsed: ParseResult) {
    if (!parsed.title.trim()) return;
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
      onKeyDown={(e) => {
        if (e.key === "Escape") void hide();
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }} data-tauri-drag-region>
        <span style={{ fontFamily: "var(--serif)", fontSize: 15, letterSpacing: 2, color: "var(--ink-2)" }} data-tauri-drag-region>
          🌰 随手记一条
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3)" }}>Esc 关闭 · 回车收下</span>
      </div>
      <SyntaxInput
        value={text}
        onChange={setText}
        onSubmit={submit}
        autoFocus
        placeholder="想到什么记什么…「周五下午3点 提交周报 /工作 @李哥 #紧要 !高」"
        lists={ctx.listNames}
        tags={ctx.tagNames}
        whos={ctx.whoNames}
        showChips
        inputStyle={{ fontSize: 15, padding: "10px 14px" }}
      />
    </div>
  );
}

document.body.style.background = "transparent";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QuickAddApp />
  </React.StrictMode>,
);
