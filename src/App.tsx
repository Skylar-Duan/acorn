// 主窗外壳：侧栏 + 视图路由 + 全局快捷键 + 撤销 toast + 批量操作条。
import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import Today from "./views/Today";
import ListView from "./views/ListView";
import Habits from "./views/Habits";
import Plan from "./views/Plan";
import Done from "./views/Done";
import Guide from "./views/Guide";
import Calendar from "./views/Calendar";
import FocusView from "./views/FocusView";
import StatsView from "./views/StatsView";
import Settings from "./views/Settings";
import CommandPalette from "./components/CommandPalette";
import SearchOverlay from "./components/SearchOverlay";
import ContextMenu from "./components/ContextMenu";
import ThemeScene from "./components/ThemeScene";
import DataRescue from "./components/DataRescue";
import {
  clearSelection, completeTasks, deleteTasks, dismissToast, expandTask,
  navigate, postponeTasks, setPaletteOpen, setSearchOpen, setSelection,
  setTasksList, undo, useApp,
} from "./core/store";

function inEditable(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

/** 屏幕上当前可见任务行的 id（DOM 顺序即视觉顺序）。
 *  有子任务的事被拆成好几行、共用同一个任务 id，去重后方向键才是一件事一停 */
function visibleTaskIds(): string[] {
  const ids = [...document.querySelectorAll<HTMLElement>(".task-row[data-task-id]")].map(
    (el) => el.dataset.taskId!,
  );
  return [...new Set(ids)];
}

export default function App() {
  const view = useApp((s) => s.ui.view);
  const loaded = useApp((s) => s.loaded);
  const loadError = useApp((s) => s.loadError);
  const toast = useApp((s) => s.ui.toast);
  const selectedIds = useApp((s) => s.ui.selectedIds);
  const paletteOpen = useApp((s) => s.ui.paletteOpen);
  const searchOpen = useApp((s) => s.ui.searchOpen);
  const lists = useApp((s) => s.data.lists);
  const theme = useApp((s) => s.data.settings.theme);
  const [bulkListMenu, setBulkListMenu] = useState(false);
  /** 窄屏（手机 / 把窗口拖窄）时侧栏收成抽屉，这里记它开没开 */
  const [drawer, setDrawer] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // toast 自动消散
  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(dismissToast, 4000);
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [toast]);

  // 屏蔽 WebView2 原生右键菜单（输入框里保留系统菜单，用户要粘贴）
  useEffect(() => {
    function onCtx(e: MouseEvent) {
      const el = e.target as HTMLElement | null;
      const editable = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (!editable) e.preventDefault();
    }
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  // 全局快捷键
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !inEditable()) {
        e.preventDefault();
        undo();
        return;
      }
      if (mod && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        navigate((["inbox", "today", "habits", "plan", "done"] as const)[Number(e.key) - 1]);
        return;
      }
      if (inEditable()) return;

      const ids = visibleTaskIds();
      const cur = selectedIds.length === 1 ? ids.indexOf(selectedIds[0]) : -1;
      if (e.key === "ArrowDown" && ids.length) {
        e.preventDefault();
        const next = ids[Math.min(cur + 1, ids.length - 1)];
        setSelection([next]);
        document.querySelector(`.task-row[data-task-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp" && ids.length) {
        e.preventDefault();
        const next = ids[Math.max(cur <= 0 ? 0 : cur - 1, 0)];
        setSelection([next]);
        document.querySelector(`.task-row[data-task-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && selectedIds.length === 1) {
        e.preventDefault();
        expandTask(selectedIds[0]);
      } else if (mod && e.key.toLowerCase() === "d" && selectedIds.length) {
        e.preventDefault();
        // 走 completeTasks 一次做完：一件一次的话撤销只撤得回最后一件
        completeTasks(selectedIds);
      } else if (mod && e.key === "ArrowRight" && selectedIds.length) {
        e.preventDefault();
        postponeTasks(selectedIds);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.length) {
        e.preventDefault();
        deleteTasks(selectedIds);
      } else if (e.key === "Escape") {
        setDrawer(false);
        clearSelection();
        expandTask(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedIds]);

  // 换了视图就把抽屉收起来——手机上点完一项还挡着半屏很烦
  useEffect(() => setDrawer(false), [view]);

  const body = useMemo(() => {
    switch (view) {
      case "today": return <Today />;
      case "inbox": return <ListView kind="inbox" />;
      case "plan": return <Plan />;
      case "done": return <Done />;
      case "list": return <ListView kind="list" />;
      case "who": return <ListView kind="who" />;
      case "tag": return <ListView kind="tag" />;
      case "habits": return <Habits />;
      case "trash": return <ListView kind="trash" />;
      case "calendar": return <Calendar />;
      case "guide": return <Guide />;
      case "focus": return <FocusView />;
      case "stats": return <StatsView />;
      case "settings": return <Settings />;
    }
  }, [view]);

  if (!loaded) {
    return <div className="center-note"><span className="big">橡果</span>正在打开数据…</div>;
  }
  if (loadError) {
    return (
      <div className="center-note">
        <span className="big">数据打不开</span>
        <span>{loadError}</span>
        <span>数据文件夹现在不可用。若数据放在移动硬盘或网盘上，接好后点重试；也可以去设置换一个文件夹。</span>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn primary" onClick={() => location.reload()}>重试</button>
          <button className="btn" onClick={() => navigate("settings")}>打开设置</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`shell${drawer ? " drawer-open" : ""}`}>
      <ThemeScene theme={theme} />
      {/* 窄屏才出现：点开左边的抽屉。宽屏由 CSS 藏起来 */}
      <button className="drawer-btn" title="菜单" onClick={() => setDrawer(true)}>☰</button>
      <Sidebar drawerOpen={drawer} onNavigate={() => setDrawer(false)} />
      {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} />}
      {body}

      <DataRescue />
      {paletteOpen && <CommandPalette />}
      {searchOpen && <SearchOverlay />}
      <ContextMenu />

      {toast && (
        <div className="toast" key={toast.key}>
          {toast.msg}
          {toast.undoable && <button onClick={() => { undo(); dismissToast(); }}>撤销</button>}
        </div>
      )}

      {selectedIds.length > 1 && (
        <div className="bulk-bar">
          <span className="cnt">{selectedIds.length}</span> 项已选
          <button className="btn ghost" onClick={() => postponeTasks(selectedIds)}>推到明天</button>
          <span style={{ position: "relative" }}>
            <button className="btn ghost" onClick={() => setBulkListMenu(!bulkListMenu)}>移到清单</button>
            {bulkListMenu && (
              <div className="popmenu" style={{ bottom: "130%", left: 0 }}>
                <button className="item" onClick={() => { setTasksList(selectedIds, null); setBulkListMenu(false); }}>随手记</button>
                {lists.map((l) => (
                  <button key={l.id} className="item" onClick={() => { setTasksList(selectedIds, l.id); setBulkListMenu(false); }}>
                    <span style={{ width: 7, height: 7, borderRadius: 99, background: `var(--list-${l.color})`, display: "inline-block" }} />
                    {l.name}
                  </button>
                ))}
              </div>
            )}
          </span>
          <button className="btn danger" onClick={() => deleteTasks(selectedIds)}>删除</button>
          <button className="btn ghost" onClick={clearSelection}>取消</button>
        </div>
      )}
    </div>
  );
}
