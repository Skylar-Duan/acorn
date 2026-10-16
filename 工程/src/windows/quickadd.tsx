// 「随手记一条」浮窗：独立小窗，Alt+Space 唤起。
// 不碰数据文件——解析后把结果发给主窗落库，用完即隐。补全候选（清单/标签/需求方）由主窗随 context 事件下发。
import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "../styles/themes.css";
import "../styles/base.css";
import type { ParseResult } from "../core/parse";
import SyntaxInput from "../components/SyntaxInput";
import ImageAttachments from "../components/ImageAttachments";
import type { TaskImage } from "../core/model";
import { IS_ULTRA } from "../core/version";
import "../styles/task-quickadd-window.css";

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
  /** 「周末」指周六还是周日，主窗随 context 一起下发；还没收到时当周日 */
  weekendDay?: "sat" | "sun";
  imageContextId?: string;
  imageBudgetUsed?: number;
}

function QuickAddApp() {
  const [text, setText] = useState("");
  const [images, setImages] = useState<TaskImage[]>([]);
  const ctxRef = useRef<Ctx | null>(null);
  const imageRevision = useRef(0);
  const imageBusy = useRef(false);
  const [ctx, setCtx] = useState<Ctx>({ listNames: [], tagNames: [], whoNames: [], theme: "forest", mode: "system" });
  const pending = useRef<string | null>(null);

  useEffect(() => {
    applyThemeAttrs("forest", "system");
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      await listen<Ctx>("quickadd:context", (e) => {
        if (ctxRef.current?.imageContextId !== e.payload.imageContextId) { setImages([]); imageRevision.current++; }
        ctxRef.current = e.payload;
        setCtx(e.payload);
        applyThemeAttrs(e.payload.theme, e.payload.mode);
      });
      await listen("quickadd:show", async () => {
        if (pending.current) { await hide(); return; }
        setText("");
        setImages([]); imageRevision.current++;
        await emitTo("main", "quickadd:pull", {});
      });
      await listen<{ requestId?: string; saved: boolean }>("quickadd:result", async (e) => {
        if (e.payload.requestId !== pending.current) return;
        pending.current = null;
        if (e.payload.saved) { setText(""); setImages([]); imageRevision.current++; }
        else {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const current = getCurrentWindow();
          await current.show();
          await current.setFocus();
          document.querySelector<HTMLInputElement>(".si-wrap input")?.focus();
        }
      });
      await emitTo("main", "quickadd:pull", {});
    })();
  }, []);

  async function hide() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  }

  async function submit(parsed: ParseResult) {
    if (!parsed.title.trim() || pending.current || imageBusy.current) return;
    const { emitTo } = await import("@tauri-apps/api/event");
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pending.current = requestId;
    try {
      await hide();
      await emitTo("main", "quickadd:submit", {
      requestId,
      title: parsed.title.trim(),
      listName: parsed.listName,
      tags: parsed.tags,
      who: parsed.who,
      priority: parsed.priority,
      due: parsed.due,
      dueTime: parsed.dueTime,
      repeat: parsed.repeat,
      ...(IS_ULTRA ? { images, imageContextId: ctxRef.current?.imageContextId } : {}),
      });
    } catch {
      pending.current = null;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().show();
      await getCurrentWindow().setFocus();
    }
  }

  return (
    <div
      className="task-quickadd-window"
      onKeyDown={(e) => {
        if (e.key === "Escape") { imageRevision.current++; setImages([]); void hide(); }
      }}
    >
      <div className="task-quickadd-window-head" data-tauri-drag-region>
        <span data-tauri-drag-region>
          随手记一条
        </span>
        <span className="task-quickadd-window-hint">Esc 关闭 · 回车保存</span>
      </div>
      <SyntaxInput
        value={text}
        onChange={setText}
        // 回执照实说：没标题就什么都没发出去（submit 自己会退回），那一下不该闪 ✓。
        // submit 是异步的，这儿显式吞掉那个 Promise，把「存没存下」当场答复输入框
        onSubmit={(p) => {
          if (!p.title.trim()) return false;
          void submit(p);
          return false;
        }}
        autoFocus
        placeholder="记一条…「~周五下午3点 提交周报 /工作 @李哥 #紧要 !高」"
        lists={ctx.listNames}
        tags={ctx.tagNames}
        whos={ctx.whoNames}
        weekendDay={ctx.weekendDay}
        showChips
      />
      <ImageAttachments images={images} draft label="这件事的图片"
        onBusyChange={(busy) => { imageBusy.current = busy; }}
        createContext={() => { const revision = imageRevision.current; const context = ctxRef.current?.imageContextId; return { valid: () => !!context && revision === imageRevision.current && context === ctxRef.current?.imageContextId && !pending.current, dispose: () => {} }; }}
        usedBytes={() => ctxRef.current?.imageBudgetUsed ?? 0}
        onChange={setImages} />
    </div>
  );
}

document.body.style.background = "transparent";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QuickAddApp />
  </React.StrictMode>,
);
