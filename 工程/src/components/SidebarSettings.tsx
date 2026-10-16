import { useState } from "react";
import { appStore, updateSettings, useApp } from "../core/store";
import { moveSidebarModule, setSidebarHidden, sidebarHidden, sidebarModules, sidebarName, type SidebarModuleId } from "../core/sidebar";
import SidebarIcon from "./SidebarIcon";
import SidebarModuleMenu, { type SidebarMenuTarget } from "./SidebarModuleMenu";
import { useSidebarModuleDrag } from "./sidebarModuleDrag";
import "../styles/sidebar.css";

export default function SidebarSettings() {
  const preferences = useApp((s) => s.data.settings.sidebar);
  const [menu, setMenu] = useState<SidebarMenuTarget | null>(null);
  const modules = sidebarModules(preferences);
  const shown = modules.filter((m) => !sidebarHidden(m.id, preferences));
  const hidden = modules.filter((m) => sidebarHidden(m.id, preferences));
  function reorder(from: string, to: string | null) {
    const next = moveSidebarModule(appStore.getState().data.settings.sidebar, from, to);
    if (next) updateSettings({ sidebar: next });
  }
  const drag = useSidebarModuleDrag(reorder);
  function visibility(id: SidebarModuleId, hide: boolean) {
    updateSettings({ sidebar: setSidebarHidden(appStore.getState().data.settings.sidebar, id, hide) });
  }
  return <div className="sidebar-settings">
    <p className="set-desc">拖动模块调整顺序。清单、需求方和标签保留分组，可在侧栏独立收展。隐藏只移走入口，任务和清单仍在。</p>
    <h3>已显示 <span>拖动整组排序</span></h3>
    {shown.length === 0 && <p className="sidebar-settings-empty">侧栏入口已全部隐藏。从下面点 ＋ 可以放回。</p>}
    {shown.map((m, i) => <div key={m.id} className={`sidebar-setting-row${drag.over === m.id ? " move-over" : ""}`}
      {...drag.source(m.id)} {...drag.target(m.id)}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ id: m.id, x: e.clientX, y: e.clientY }); }}>
      <span className="sidebar-drag-grip" aria-hidden="true">⠿</span><SidebarIcon path={m.icon} />
      <button className="sidebar-setting-name" title="编辑模块显示名称" onClick={(e) => {
        if (drag.swallowClick()) return;
        const box = e.currentTarget.getBoundingClientRect(); setMenu({ id: m.id, x: box.left, y: box.bottom });
      }}>{sidebarName(m.id, preferences)}</button>
      {m.group && <span className="sidebar-setting-kind">整组</span>}
      <button type="button" className="sidebar-order-key" aria-label={`${sidebarName(m.id, preferences)}向上移动`} disabled={i === 0} onClick={() => reorder(m.id, shown[i - 1].id)}>↑</button>
      <button type="button" className="sidebar-order-key" aria-label={`${sidebarName(m.id, preferences)}向下移动`} disabled={i === shown.length - 1} onClick={() => reorder(m.id, shown[i + 2]?.id ?? null)}>↓</button>
      <button type="button" className="sidebar-toggle minus" aria-label={`隐藏${sidebarName(m.id, preferences)}`} title="隐藏模块" onClick={() => visibility(m.id, true)}>−</button>
    </div>)}
    <div className={`sidebar-setting-end${drag.over === "end" ? " move-over" : ""}`} aria-label="排到最后" {...drag.target(null)}>拖到这里排在最后</div>
    <h3>可添加 <span>点 ＋ 放回侧栏</span></h3>
    {hidden.length === 0 && <p className="sidebar-settings-empty">所有模块都已显示。</p>}
    {hidden.map((m) => <div key={m.id} className="sidebar-setting-row hidden-module"><SidebarIcon path={m.icon} /><span className="sidebar-setting-name">{sidebarName(m.id, preferences)}</span><button type="button" className="sidebar-toggle" aria-label={`添加${sidebarName(m.id, preferences)}`} title="放回侧栏" onClick={() => visibility(m.id, false)}>＋</button></div>)}
    <p className="sidebar-settings-note">名称和排布只保存在这台设备上。组内的清单顺序继续使用原有设置。</p>
    {menu && <SidebarModuleMenu key={menu.id} target={menu} onClose={() => setMenu(null)} onEditSidebar={() => setMenu(null)} />}
  </div>;
}
