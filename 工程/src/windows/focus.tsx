// 专注迷你浮窗：只显示与转发命令，状态源在主窗。
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "../styles/themes.css";
import "../styles/base.css";

interface FocusBroadcast {
  title: string;
  endsAt: number | null;
  paused: boolean;
  remainMs: number;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function FocusApp() {
  const [st, setSt] = useState<FocusBroadcast | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = "forest";
    document.documentElement.dataset.mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<FocusBroadcast>("focus:state", (e) => setSt(e.payload));
    })();
    const t = setInterval(() => force((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);

  async function cmd(c: "pause" | "resume" | "stop") {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("main", "focus:cmd", c);
  }

  const remain = st ? (st.paused ? st.remainMs : Math.max(0, (st.endsAt ?? 0) - Date.now())) : 0;

  return (
    <div
      data-tauri-drag-region
      style={{
        background: "var(--card)", border: "1px solid var(--hair)", borderRadius: 14,
        boxShadow: "var(--shadow)", padding: "12px 16px", margin: 6,
        display: "flex", alignItems: "center", gap: 12,
      }}
    >
      <span
        data-tauri-drag-region
        style={{ fontSize: 22, fontWeight: 700, color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}
      >
        {fmt(remain)}
      </span>
      <span
        data-tauri-drag-region
        style={{
          fontSize: 12, color: "var(--ink-2)", maxWidth: 120,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}
      >
        {st?.title ?? "专注"}
      </span>
      <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
        <button className="btn ghost" style={{ padding: "3px 8px" }} onClick={() => cmd(st?.paused ? "resume" : "pause")}>
          {st?.paused ? "▶" : "⏸"}
        </button>
        <button className="btn ghost" style={{ padding: "3px 8px" }} onClick={() => cmd("stop")}>✕</button>
      </span>
    </div>
  );
}

document.body.style.background = "transparent";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FocusApp />
  </React.StrictMode>,
);
