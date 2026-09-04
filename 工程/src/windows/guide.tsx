// 「一句话记事」说明窗：独立小窗，从随手记的 ? 或设置里打开。
// 不碰数据文件——清单/标签/需求方/主题全由主窗随 context 事件下发，这里只负责显示。
import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "../styles/themes.css";
import "../styles/base.css";
import GuideContent from "../components/GuideContent";

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
  weekendDay?: "sat" | "sun";
}

function GuideApp() {
  const [ctx, setCtx] = useState<Ctx>({ listNames: [], tagNames: [], whoNames: [], theme: "forest", mode: "system" });
  // 窗口只隐藏不销毁，可能开着好几天。每次重新显示都把「今天」推到当下
  const [nowMs, setNowMs] = useState(() => Date.now());
  // matchMedia 的回调只挂一次，闭包会锁死在初始值上；最后一次收到的 theme/mode 存 ref 里
  const themeRef = useRef({ theme: "forest", mode: "system" });

  useEffect(() => {
    applyThemeAttrs("forest", "system");
    const onFocus = () => setNowMs(Date.now());
    // mode 是「跟随系统」时，系统夜里自动切深色也得跟上。这条不经过主窗：
    // 那会儿设置没人动，主窗的 themeCtl 也只会给自己改，等不到 guide:context
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      const t = themeRef.current;
      if (!t.mode || t.mode === "system") applyThemeAttrs(t.theme, t.mode);
    };
    mq.addEventListener("change", onScheme);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void hide();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("keydown", onKey);
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      await listen<Ctx>("guide:context", (e) => {
        setCtx(e.payload);
        themeRef.current = { theme: e.payload.theme, mode: e.payload.mode };
        applyThemeAttrs(e.payload.theme, e.payload.mode);
        setNowMs(Date.now());
      });
      await listen("guide:show", async () => {
        await emitTo("main", "guide:pull", {});
      });
      await emitTo("main", "guide:pull", {});
    })();
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onScheme);
    };
  }, []);

  async function hide() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  }

  return (
    <div className="gd-win">
      <div className="gd-win-head">
        <h1>一句话记事</h1>
        <span className="sub">日期、清单、需求方、重要性、循环，都能写在同一句里</span>
      </div>
      <div className="gd-win-body">
        <GuideContent
          listNames={ctx.listNames}
          tagNames={ctx.tagNames}
          whoNames={ctx.whoNames}
          nowMs={nowMs}
          weekendDay={ctx.weekendDay}
        />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <GuideApp />
  </React.StrictMode>,
);
