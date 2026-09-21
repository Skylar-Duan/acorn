// 桌面侧栏宽度（可拖）。
//
// 侧栏右边缘那条竖向把手按住左右拖，就改 `--side-w` 这一个 CSS 变量（.shell 两列网格、
// 主题风景水印的 left 都读它，base.css 里默认 232px）。
//
// **存本机 localStorage，不进 settings**：settings 会云同步到手机，手机根本没有侧栏；
// 两台电脑屏幕宽度也不一样，各记各的才对（同类先例：需求方排序每台设备各排各的）。
// 键名带 `acorn-` 前缀，清空本机时 persist.clearLocalPrefs 会一并扫掉；
// **但绝不能以 `acorn-side-` 开头**——那是侧栏折叠记忆 useFold 的前缀，一撞就被当成某一节的折叠位。
//
// 窄于 760px 的抽屉模式不看这个变量（抽屉宽写死 min(82vw,300px)、网格退成一列），
// 所以这里不用管窄屏；把手本身在窄屏由 CSS 藏掉。

export const SIDE_W_KEY = "acorn-sidew";
export const SIDE_W_DEFAULT = 232;
/** 窗口最小 880px（tauri.conf.json），侧栏最宽 360 时正文还剩 520，够排一张任务卡 */
export const SIDE_W_MIN = 180;
export const SIDE_W_MAX = 360;

/** 夹到允许范围里；不是有限数字就回落默认 */
export function clampSideW(w: number): number {
  if (!Number.isFinite(w)) return SIDE_W_DEFAULT;
  return Math.round(Math.min(SIDE_W_MAX, Math.max(SIDE_W_MIN, w)));
}

/** 本机记下的宽度。没记过、读不到、存了坏值，一律回落 232 */
export function loadSideW(): number {
  try {
    const raw = localStorage.getItem(SIDE_W_KEY);
    if (raw == null || raw.trim() === "") return SIDE_W_DEFAULT;
    return clampSideW(Number(raw));
  } catch {
    return SIDE_W_DEFAULT;
  }
}

/** 记下宽度。等于默认值就把键删掉（双击恢复默认之后，本机不留一条没用的记录） */
export function saveSideW(w: number): void {
  const v = clampSideW(w);
  try {
    if (v === SIDE_W_DEFAULT) localStorage.removeItem(SIDE_W_KEY);
    else localStorage.setItem(SIDE_W_KEY, String(v));
  } catch {
    /* 存不下就算了：这一次照样生效，只是下次打开回到默认 */
  }
}

/** 只改 CSS 变量，不写盘。拖动过程中每一帧走这里 */
export function applySideW(w: number): void {
  const v = clampSideW(w);
  if (v === SIDE_W_DEFAULT) document.documentElement.style.removeProperty("--side-w");
  else document.documentElement.style.setProperty("--side-w", `${v}px`);
}

/** 启动时套上本机记下的宽度。要在 React 第一次渲染之前调，免得第一帧先闪 232 再跳 */
export function applySavedSideW(): void {
  applySideW(loadSideW());
}
