import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import type { EyeCareState } from "../core/eyeCare";
import "../styles/themes.css";
import "../styles/base.css";
import "../styles/eye-care.css";

async function command(cmd: "skip" | "ready") {
  const { emitTo } = await import("@tauri-apps/api/event");
  await emitTo("main", "eye-care:cmd", cmd);
}

export function EyeCareWindow() {
  const [state, setState] = useState<EyeCareState | null>(null);
  useEffect(() => {
    let disposed = false;
    let received = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<EyeCareState>("eye-care:state", ({ payload }) => {
        if (disposed) return;
        received = true;
        document.documentElement.dataset.theme = payload.theme;
        document.documentElement.dataset.mode = payload.mode;
        setState(payload);
      });
      if (disposed) { stop(); return; }
      unlisten = stop;
      await command("ready");
    })();
    // 主窗可能比预加载的小窗晚完成启动；一直握手到第一份状态到达。
    const retry = setInterval(() => { if (!disposed && !received) void command("ready"); }, 3000);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") void command("skip"); };
    window.addEventListener("keydown", onKey);
    return () => { disposed = true; unlisten?.(); clearInterval(retry); window.removeEventListener("keydown", onKey); };
  }, []);
  const resting = state?.phase === "rest";
  return (
    <main className={`eye-care ${state?.display === "full" ? "full" : "small"}`}>
      <button className="eye-close" aria-label="关闭这次提醒" onClick={() => void command("skip")}>×</button>
      <span className="eye-leaf" aria-hidden="true">◒</span>
      <h1>{resting ? "让眼睛看看远处" : "准备休息一下"}</h1>
      <p>{resting ? "望向远处，让眼睛放松一会儿" : "先把手边的事放好，马上开始护眼休息"}</p>
      <div className="eye-count" aria-label={`还剩 ${state?.remain ?? 0} 秒`}>{state?.remain ?? 10}<span>秒</span></div>
      <button className="eye-skip" onClick={() => void command("skip")}>{resting ? "结束这次休息" : "跳过这次"}</button>
      <span className="eye-hint">随时可以关闭 · 下次提醒会重新计时</span>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<EyeCareWindow />);
