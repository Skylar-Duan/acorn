import { appStore, updateSettings, useApp } from "../core/store";
import { setSidebarHidden, sidebarHidden, sidebarModules, sidebarName, type SidebarModuleId } from "../core/sidebar";
import SidebarIcon from "./SidebarIcon";
import "../styles/sidebar.css";

export default function SidebarSettings() {
  const preferences = useApp((s) => s.data.settings.sidebar);
  const modules = sidebarModules(preferences);
  const shown = modules.filter((m) => !sidebarHidden(m.id, preferences));
  const hidden = modules.filter((m) => sidebarHidden(m.id, preferences));
  function visibility(id: SidebarModuleId, hide: boolean) {
    updateSettings({ sidebar: setSidebarHidden(appStore.getState().data.settings.sidebar, id, hide) });
  }
  return <div className="sidebar-settings">
    <p className="set-desc">点 − 隐藏，点 ＋ 放回。顺序直接在左侧拖动，清单和需求方按整组移动。</p>
    <h3>已显示</h3>
    {shown.length === 0 && <p className="sidebar-settings-empty">侧栏入口已全部隐藏。从下面点 ＋ 可以放回。</p>}
    <div className="sidebar-setting-chips">{shown.map((m) => <button key={m.id} type="button" className="sidebar-setting-chip" aria-label={`隐藏${sidebarName(m.id, preferences)}`} onClick={() => visibility(m.id, true)}>
      <SidebarIcon path={m.icon} /><span>{sidebarName(m.id, preferences)}</span><span className="sidebar-chip-sign" aria-hidden="true">−</span>
    </button>)}</div>
    <h3>已隐藏</h3>
    {hidden.length === 0 && <p className="sidebar-settings-empty">所有模块都已显示。</p>}
    <div className="sidebar-setting-chips">{hidden.map((m) => <button key={m.id} type="button" className="sidebar-setting-chip hidden-module" aria-label={`添加${sidebarName(m.id, preferences)}`} onClick={() => visibility(m.id, false)}>
      <SidebarIcon path={m.icon} /><span>{sidebarName(m.id, preferences)}</span><span className="sidebar-chip-sign" aria-hidden="true">＋</span>
    </button>)}</div>
    <p className="sidebar-settings-note">隐藏入口不删除任务。名称与排布只保存在这台设备上。</p>
  </div>;
}
