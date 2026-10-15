// 桌面侧栏布局是本机偏好。只排模块，不改清单、需求方或任务记录。
import type { Settings } from "./model";
import { FOCUS_ENABLED } from "./features";

export const SIDEBAR_MODULES = [
  { id: "plan", name: "计划", icon: "M4 6h16 M4 12h16 M4 18h10", group: false },
  { id: "calendar", name: "日历", icon: "M3 5h18v16H3z M8 3v4M16 3v4M3 10h18M9 10v11M15 10v11M3 15.5h18", group: false },
  { id: "today", name: "今日任务", icon: "M12 8a4 4 0 100 8 4 4 0 000-8z M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1", group: false },
  { id: "habits", name: "习惯", icon: "M20.5 12a8.5 8.5 0 1 1-2.6-6.1 M20.5 3.5v4h-4 M8.6 12.2l2.4 2.4 4.6-4.8", group: false },
  { id: "done", name: "已完成", icon: "M20 6L9 17l-5-5", group: false },
  { id: "focus", name: "专注", icon: "M12 5a8 8 0 100 16 8 8 0 000-16z M12 9v4l3 2 M9 2h6", group: false },
  { id: "stats", name: "统计", icon: "M4 20V10 M10 20V4 M16 20v-9 M21 20H3", group: false },
  { id: "trash", name: "回收站", icon: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6", group: false },
  { id: "lists", name: "清单", icon: "M4 5h16v15H4z M8 9h8 M8 13h8 M8 17h5", group: true },
  { id: "who", name: "需求方", icon: "M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M5 21v-3a7 7 0 0 1 14 0v3", group: true },
  { id: "tags", name: "标签", icon: "M4 4h7l10 10-7 7L4 11z M8 8h.01", group: true },
] as const;

export type SidebarModuleId = typeof SIDEBAR_MODULES[number]["id"];
export type SidebarPreferences = NonNullable<Settings["sidebar"]>;
export const SIDEBAR_MODULE_MIME = "text/acorn-sidebar-module";

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string"))] : [];
}

/** 不认识的模块暂不画，但保留存储原样，供别的版本继续使用。 */
export function sidebarModules(preferences?: Settings["sidebar"], focusEnabled = FOCUS_ENABLED) {
  const order = strings(preferences?.order);
  const rank = new Map(order.map((id, i) => [id, i]));
  return SIDEBAR_MODULES.filter((m) => m.id !== "focus" || focusEnabled)
    .map((m, i) => ({ ...m, rank: rank.get(m.id) ?? order.length + i }))
    .sort((a, b) => a.rank - b.rank);
}

export function sidebarName(id: SidebarModuleId, preferences?: Settings["sidebar"]): string {
  const alias = preferences?.labels?.[id];
  return typeof alias === "string" && alias.trim() ? alias.trim() : SIDEBAR_MODULES.find((m) => m.id === id)!.name;
}

export function sidebarHidden(id: SidebarModuleId, preferences?: Settings["sidebar"]): boolean {
  return strings(preferences?.hidden).includes(id);
}

export function setSidebarHidden(preferences: Settings["sidebar"], id: SidebarModuleId, hidden: boolean): SidebarPreferences {
  const ids = strings(preferences?.hidden).filter((key) => key !== id);
  return { ...preferences, hidden: hidden ? [...ids, id] : ids };
}

export function setSidebarName(preferences: Settings["sidebar"], id: SidebarModuleId, name: string): SidebarPreferences {
  const labels = { ...preferences?.labels };
  const clean = name.trim().slice(0, 40);
  if (!clean || clean === SIDEBAR_MODULES.find((m) => m.id === id)!.name) delete labels[id];
  else labels[id] = clean;
  return { ...preferences, labels };
}

/** 把整个模块移到目标前，null 表示末尾；隐藏项及未来字段都跟着保留。 */
export function moveSidebarModule(preferences: Settings["sidebar"], from: string, to: string | null): SidebarPreferences | null {
  const known = SIDEBAR_MODULES.map((m) => m.id as string);
  if (!known.includes(from) || from === to || (to !== null && !known.includes(to))) return null;
  const order = [...new Set([...strings(preferences?.order), ...known])].filter((id) => id !== from);
  order.splice(to === null ? order.length : order.indexOf(to), 0, from);
  return { ...preferences, order };
}
