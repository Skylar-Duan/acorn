// 手机端的线性图标（v1.11.0）。统一 24×24 网格、1.8 描边、圆头圆角——跟设计稿一套笔画。
//
// 为什么不用 emoji：emoji 的长相由系统字体决定，同一颗在不同安卓机上差得离谱（有的还是彩色方块），
// 而且它跟不了主题色——底部导航「当前项变 accent 色」这件事 emoji 根本做不到。
// 描边一律 currentColor，颜色的事交给 CSS，图标本身不认任何色值。

import type { ReactNode } from "react";

function Ico({ size = 24, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

export interface IconProps {
  size?: number;
}

/** 随手记：一支笔 */
export function IcoInbox({ size }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M4 20l4-1 10-10-3-3L5 16z" />
      <path d="M13 7l3 3" />
    </Ico>
  );
}

/** 今天：一轮日头 */
export function IcoToday({ size }: IconProps) {
  return (
    <Ico size={size}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
    </Ico>
  );
}

/** 计划：三条横线（末行短一截） */
export function IcoPlan({ size }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M5 7h14M5 12h14M5 17h9" />
    </Ico>
  );
}

/** 已完成：一个勾 */
export function IcoDone({ size }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M5 12l4.5 4.5L19 7" />
    </Ico>
  );
}

/** 更多：四个格子 */
export function IcoMore({ size }: IconProps) {
  return (
    <Ico size={size}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </Ico>
  );
}

export function IcoSearch({ size = 20 }: IconProps) {
  return (
    <Ico size={size}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4-4" />
    </Ico>
  );
}

export function IcoGear({ size = 20 }: IconProps) {
  return (
    <Ico size={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </Ico>
  );
}

/** 返回：左尖括号 */
export function IcoBack({ size = 22 }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M15 6l-6 6 6 6" />
    </Ico>
  );
}

/** 往右的尖括号（列表行尾） */
export function IcoNext({ size = 16 }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M9 6l6 6-6 6" />
    </Ico>
  );
}

/** 「···」：这是唯一一个实心的，三个点描边画出来只是三个小圈 */
export function IcoDots({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <circle cx="6" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="18" cy="12" r="1.8" />
    </svg>
  );
}

export function IcoPlus({ size = 26 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      aria-hidden
      focusable="false"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** 推明天：一支往右的箭头 */
export function IcoPostpone({ size = 22 }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M5 12h12" />
      <path d="M13 7l5 5-5 5" />
    </Ico>
  );
}

/** 放弃：画了一道的圆 */
export function IcoDrop({ size = 22 }: IconProps) {
  return (
    <Ico size={size}>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 17.5l11-11" />
    </Ico>
  );
}

export function IcoTrash({ size = 22 }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12" />
    </Ico>
  );
}

export function IcoCalendar({ size = 22 }: IconProps) {
  return (
    <Ico size={size}>
      <rect x="4" y="5" width="16" height="15" rx="3" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </Ico>
  );
}

/** 习惯：转一圈的两支箭头（v1.11.1 起进底部导航常驻位）。
 *  为什么不是钟面：钟说的是「几点」，而习惯这一页说的是「反复做」——
 *  一圈箭头正是这本 App 自己给习惯下的定义（「需要反复做的事放在这里，每天打卡」）。
 *  笔画跟另外四格同一套：24 网格、1.8 描边、圆头圆角 */
export function IcoHabits({ size = 24 }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M20.5 12a8.5 8.5 0 00-14.5-6L3.5 8.5" />
      <path d="M3.5 4v4.5H8" />
      <path d="M3.5 12a8.5 8.5 0 0014.5 6l2.5-2.5" />
      <path d="M20.5 20v-4.5H16" />
    </Ico>
  );
}

/** 统计：三根柱子 */
export function IcoStats({ size = 24 }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M5 19V9M12 19V5M19 19v-7" />
    </Ico>
  );
}

/** 重要性：一面旗 */
export function IcoFlag({ size = 22 }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M5 20V5l7 3 7-3v15l-7 3z" />
    </Ico>
  );
}

/** 需求方：一个人 */
export function IcoWho({ size = 22 }: IconProps) {
  return (
    <Ico size={size}>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 20c1.5-4 4-6 7-6s5.5 2 7 6" />
    </Ico>
  );
}

/** 复制标题：两张叠着的纸 */
export function IcoCopy({ size = 22 }: IconProps) {
  return (
    <Ico size={size}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 6.5A2.5 2.5 0 0012.5 4h-6A2.5 2.5 0 004 6.5v6A2.5 2.5 0 006.5 15" />
    </Ico>
  );
}

/** 拖动排序的握把 */
export function IcoGrip({ size = 20 }: IconProps) {
  return (
    <Ico size={size}>
      <path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" />
    </Ico>
  );
}
