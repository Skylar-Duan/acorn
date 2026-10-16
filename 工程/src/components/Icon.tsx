import type { CSSProperties } from "react";

const paths = {
  menu: "M4 6h16M4 12h16M4 18h16",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  search: "M21 21l-5-5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0",
  plus: "M12 5v14M5 12h14", close: "m6 6 12 12M18 6 6 18",
  chevronDown: "m6 9 6 6 6-6", chevronRight: "m9 6 6 6-6 6",
  arrowLeft: "M20 12H4m6-6-6 6 6 6", arrowRight: "M4 12h16m-6-6 6 6-6 6",
  arrowUp: "M12 20V4m-6 6 6-6 6 6", arrowDown: "M12 4v16m-6-6 6 6 6-6",
  calendar: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM7 3v4M17 3v4M3 10h18M7 14h2M15 14h2",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2",
  repeat: "m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4M21 13v3a2 2 0 0 1-2 2H3",
  flag: "M5 21V3h11l-1 4 4 1-2 6H5",
  tag: "M20 13 11 22 2 13V3h10l8 8a1.5 1.5 0 0 1 0 2ZM7 8h.01",
  person: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2",
  users: "M15 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM3 21v-2a8 8 0 0 1 16 0v2M18 3a4 4 0 0 1 0 8M21 15a7 7 0 0 1 2 5",
  folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  check: "m5 12 4 4L19 6", checkCircle: "M21 11v1a9 9 0 1 1-5.3-8.2M21 4 12 13l-3-3",
  skip: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM6 6l12 12",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  restore: "M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2",
  sliders: "M4 7h16M4 17h16M8 4v6M16 14v6",
  palette: "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4A9 9 0 0 0 12 3ZM7 9h.01M11 6h.01M16 7h.01M7 14h.01",
  cloud: "M7 18a5 5 0 1 1 .5-10 6 6 0 0 1 11.4 1A4.5 4.5 0 1 1 18 18H7",
  devices: "M3 3h16v12H3zM7 21h8M11 15v6M17 12h5v9h-5z",
  file: "M14 2H5v20h14V7ZM14 2v6h5M8 12h8M8 16h6",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  upload: "M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5",
  feedback: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2ZM7 7h10M7 11h7",
  info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v6M12 7h.01",
  image: "M3 3h18v18H3zM3 16l5-5 5 5 3-3 5 5M8 7h.01",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  settings: "m9 3 1-1h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  keyboard: "M2 5h20v14H2zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10",
  eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  help: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01",
  lock: "M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4M12 14v3",
  sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 1v2M12 21v2M1 12h2M21 12h2M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2",
  moon: "M20.5 13a9 9 0 0 1-9.5-9.5A9 9 0 1 0 20.5 13",
  edit: "m15 3 6 6-12 12-7 1 1-7zM13 5l6 6",
  logout: "M9 3H3v18h6M9 12h12m-5-5 5 5-5 5",
  alert: "m12 3 10 18H2ZM12 9v5M12 18h.01",
} as const;

export type IconName = keyof typeof paths;
export default function Icon({ name, size = 18, label, className = "", style }: {name: IconName; size?: number; label?: string; className?: string; style?: CSSProperties}) {
  return <svg className={`ui-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} aria-label={label} role={label ? "img" : undefined} style={{flexShrink:0,...style}}>
    <path d={paths[name]} />
  </svg>;
}
