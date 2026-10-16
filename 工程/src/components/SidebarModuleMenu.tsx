import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { appStore, updateSettings, useApp } from "../core/store";
import { setSidebarHidden, setSidebarName, sidebarName, type SidebarModuleId } from "../core/sidebar";

export interface SidebarMenuTarget { id: SidebarModuleId; x: number; y: number }

export default function SidebarModuleMenu({ target, onClose, onEditSidebar }: {
  target: SidebarMenuTarget;
  onClose: () => void;
  onEditSidebar: () => void;
}) {
  const preferences = useApp((s) => s.data.settings.sidebar);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => sidebarName(target.id, preferences));
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const commitRef = useRef(() => {});
  function commit() {
    const current = appStore.getState().data.settings.sidebar;
    if (editing && draft.trim() && draft.trim() !== sidebarName(target.id, current)) {
      updateSettings({ sidebar: setSidebarName(current, target.id, draft) });
    }
  }
  commitRef.current = commit;
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      commitRef.current();
      closeRef.current();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  return createPortal(
    <div ref={ref} className="popmenu sidebar-module-menu" role={editing ? "dialog" : "menu"}
      aria-label={editing ? "编辑模块显示名称" : "侧栏模块菜单"}
      style={{ position: "fixed", left: Math.max(8, Math.min(target.x, window.innerWidth - 250)), top: Math.max(8, Math.min(target.y, window.innerHeight - 225)) }}
    >
      {editing ? <form onSubmit={(e) => { e.preventDefault(); commit(); onClose(); }}>
        <label htmlFor="sidebar-module-name">显示名称</label>
        <input id="sidebar-module-name" className="input" autoFocus maxLength={40} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <p>只改变这台设备上的模块名称。</p>
        <div className="sidebar-name-actions"><button type="button" onClick={() => {
          updateSettings({ sidebar: setSidebarName(appStore.getState().data.settings.sidebar, target.id, "") });
          onClose();
        }}>恢复默认名称</button><button type="submit" className="btn primary" disabled={!draft.trim()}>保存</button></div>
      </form> : <>
        <button className="item" role="menuitem" onClick={() => setEditing(true)}>编辑显示名称</button>
        <button className="item" role="menuitem" onClick={() => {
          updateSettings({ sidebar: setSidebarHidden(appStore.getState().data.settings.sidebar, target.id, true) });
          onClose();
        }}>隐藏模块</button>
        <div className="sep" />
        <button className="item" role="menuitem" onClick={() => { onClose(); onEditSidebar(); }}>功能区设置</button>
      </>}
    </div>, document.body,
  );
}
