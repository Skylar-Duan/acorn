// 跑在什么上面。桌面独有的东西（托盘、全局快捷键、开机自启、第二个窗口、
// 换数据文件夹）在手机上要么不存在、要么会直接报错，所以每一处都得先问一句这里。
//
// 判断用 UA 而不是 @tauri-apps/plugin-os：少一个依赖、少一次异步等待，
// 而且这些开关必须在首屏渲染前就确定，不能等一个 Promise。

export const isAndroid: boolean =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

export const isIOS: boolean =
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ 的 UA 伪装成 Mac，靠触摸点数区分
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** 手机 / 平板。只有它为真时才走抽屉式侧栏、放大点击区 */
export const isMobile: boolean = isAndroid || isIOS;

/** 桌面独有能力可用吗（托盘 / 全局快捷键 / 开机自启 / 多窗口 / 换数据文件夹） */
export const hasDesktopFeatures: boolean = !isMobile;

/** 窄屏（含桌面把窗口拖窄）。布局用它，能力开关用 isMobile——两件事别混 */
export const NARROW_PX = 760;
