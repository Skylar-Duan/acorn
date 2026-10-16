/** 项目自绘的 24px 线条图标。人物与清单各一套，离线可用。 */
export const CATEGORY_ICONS = {
  list: [
    { id: "list", name: "清单", path: "M5 4h14v16H5z M9 8h6M9 12h6M9 16h4" },
    { id: "folder", name: "文件夹", path: "M3 7h7l2-3h8v16H3z M3 9h17" },
    { id: "briefcase", name: "公文包", path: "M3 8h18v12H3z M8 8V4h8v4 M3 12c5 4 13 4 18 0 M10 14h4" },
    { id: "book", name: "书本", path: "M12 5v15 M12 6C8 3 4 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1z" },
    { id: "home", name: "家", path: "M3 10l9-7 9 7 M5 9v12h14V9 M9 21v-7h6v7" },
    { id: "leaf", name: "叶子", path: "M5 19C1 7 11 3 21 3c0 11-4 20-16 16z M4 21L16 9 M9 16l-1-5 M12 13h5" },
    { id: "flag", name: "旗帜", path: "M5 21V3 M5 4c5-3 9 3 15 0v10c-6 3-10-3-15 0" },
    { id: "spark", name: "灵感", path: "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" },
    { id: "calendar", name: "日程", path: "M4 5h16v16H4z M8 3v4M16 3v4M4 10h16 M8 14h2M14 14h2M8 18h2" },
    { id: "target", name: "目标", path: "M21 12a9 9 0 1 1-9-9 M17 12a5 5 0 1 1-5-5 M12 12l9-9 M16 3h5v5" },
    { id: "coffee", name: "生活", path: "M4 8h13v8a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z M17 9h2a3 3 0 0 1 0 6h-2 M7 3v2M11 2v3M15 3v2" },
    { id: "palette", name: "创作", path: "M12 3a9 9 0 0 0 0 18h2a2 2 0 0 0 1-4c-2-1-1-3 1-3h2c5 0 4-11-6-11z M7 9h.01M10 6h.01M15 6h.01M18 9h.01" },
    { id: "music", name: "音乐", path: "M9 18V5l12-2v13 M9 8l12-2 M9 18a3 3 0 1 1-3-3h3 M21 16a3 3 0 1 1-3-3h3" },
    { id: "plane", name: "旅行", path: "M22 3 14 21l-4-8-8-4z M10 13 22 3" },
    { id: "basket", name: "购物", path: "M3 9h18l-2 12H5z M7 9l5-7 5 7 M9 13v4M15 13v4" },
    { id: "sun", name: "日常", path: "M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0z M12 1v2M12 21v2M1 12h2M21 12h2 M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2" },
  ],
  who: [
    { id: "person", name: "个人", path: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M4 21v-2a8 8 0 0 1 16 0v2" },
    { id: "team", name: "团队", path: "M14 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M4 20v-2a7 7 0 0 1 14 0v2 M17 4a3 3 0 0 1 0 6 M20 20v-3a5 5 0 0 0-3-4" },
    { id: "smile", name: "朋友", path: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M8 9h.01M16 9h.01 M7.5 14a5 5 0 0 0 9 0" },
    { id: "heart", name: "家人", path: "M12 20L4.5 13A5.5 5.5 0 0 1 12 5a5.5 5.5 0 0 1 7.5 8z" },
    { id: "contact", name: "联系人", path: "M4 3h16v18H4z M15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M8 17v-1a4 4 0 0 1 8 0v1 M2 7h3M2 12h3M2 17h3" },
    { id: "graduate", name: "老师", path: "M2 7l10-4 10 4-10 4z M6 9v5c3 3 9 3 12 0V9 M22 7v7 M6 21a7 7 0 0 1 12 0" },
    { id: "partner", name: "合作方", path: "M3 9l5-5 4 2 4-2 5 5-9 11z M8 8l4-2 4 4-3 3-3-2 M6 13l5 5 M8 11l6 6" },
    { id: "building", name: "机构", path: "M4 21V5l8-2 8 2v16 M2 21h20 M8 7h1M15 7h1M8 11h1M15 11h1M9 21v-6h6v6" },
    { id: "badge", name: "同事", path: "M5 4h14v17H5z M9 4V2h6v2 M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M8 18a4 4 0 0 1 8 0" },
    { id: "chat", name: "沟通", path: "M21 11a9 8 0 0 1-9 8H8l-5 3 1-6a8 8 0 0 1-1-5 9 8 0 0 1 18 0z M8 10h.01M12 10h.01M16 10h.01" },
    { id: "crown", name: "负责人", path: "M3 6l5 4 4-7 4 7 5-4-2 12H5z M5 21h14" },
    { id: "glasses", name: "顾问", path: "M10 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M22 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M10 12h4 M2 12l2-7h3M22 12l-2-7h-3" },
    { id: "hand", name: "支持", path: "M3 15h4l4 3h5a2 2 0 0 0 0-4h-5 M7 15l4-4h5l5 4-6 7H8l-5-3z M12 7V2M8 7 5 4M16 7l3-3" },
    { id: "shield", name: "信赖", path: "M12 2 3 6v6c0 5 5 8 9 10 4-2 9-5 9-10V6z M8 12l3 3 5-6" },
    { id: "stethoscope", name: "专业", path: "M5 3v6a5 5 0 0 0 10 0V3 M3 3h4M13 3h4 M10 14v2a5 5 0 0 0 10 0v-3 M22 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" },
    { id: "network", name: "社群", path: "M15 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M8 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M22 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M10 8l-4 8M14 8l4 8M8 19h8" },
  ],
} as const;

export type CategoryKind = keyof typeof CATEGORY_ICONS;
export function categoryIcon(kind: CategoryKind, id?: string): string {
  return CATEGORY_ICONS[kind].find((i) => i.id === id)?.path ?? CATEGORY_ICONS[kind][0].path;
}

export const CATEGORY_COLORS = [
  { id: "clay", name: "陶土" }, { id: "moss", name: "苔绿" },
  { id: "sea", name: "海蓝" }, { id: "sand", name: "麦黄" },
  { id: "slate", name: "岩灰" }, { id: "plum", name: "梅紫" },
] as const;
