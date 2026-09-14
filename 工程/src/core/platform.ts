// 跑在什么上面。桌面独有的东西（托盘、全局快捷键、开机自启、第二个窗口、
// 换数据文件夹）在手机上要么不存在、要么会直接报错，所以每一处都得先问一句这里。
//
// 判断用 UA 而不是 @tauri-apps/plugin-os：少一个依赖、少一次异步等待，
// 而且这些开关必须在首屏渲染前就确定，不能等一个 Promise。
//
// v1.15.0 网页版上线之后，这里的开关拆成了**两件事**，别再混着用：
//   · isMobile —— 界面长什么样。电脑上的浏览器仍然给桌面版界面，这是对的。
//   · isDesktopShell / isWeb —— 有没有这个本事。原来只有 hasDesktopFeatures 一个，
//     它等于 !isMobile，于是「电脑上的浏览器」一开就被当成装好的桌面 App：
//     设置页摆一个按了没反应的全局快捷键、点导出当场报「导出失败」。

export const isAndroid: boolean =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

export const isIOS: boolean =
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ 的 UA 伪装成 Mac，靠触摸点数区分
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** 手机 / 平板。只有它为真时才走抽屉式侧栏、放大点击区。
 *  **这一条只管界面长相**：iPhone 上开网页版也是真，所以网页版在手机上自动就是手机那副样子 */
export const isMobile: boolean = isAndroid || isIOS;

/** 外面套着 Tauri 吗（装好的桌面 App / 安卓 App）。为假就是跑在普通浏览器里。
 *  **真源在这儿**（v1.15.0 从 persist.ts 挪过来的，persist 现在转手再导出一次）：
 *  「我是谁」这类判断全放一处，省得下一个人又在别的文件里写一遍。 */
export const inTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 跑在浏览器里：网页版、也包括 `npm run dev` 那个预览。
 *  没有文件系统、没有托盘、没有系统对话框——凡是要这些的地方都得给浏览器另留一条路 */
export const isWeb: boolean = !inTauri;

/** 这份代码是不是 `vite build --mode web` 打出来的那一份（见 vite.config.ts 的 define）。
 *  跟 isWeb 的区别：isWeb 问「现在跑在哪」，这一条问「这是哪个包」——
 *  查服务器上有没有新版（core/webUpdate）这种事只有真发出去的网页版才该做 */
export const isWebBuild: boolean = import.meta.env.VITE_ACORN_WEB === "1";

/** 真装在电脑上的那个橡果。托盘 / 开机自启 / 全局快捷键 / 第二个窗口 / 换数据文件夹 /
 *  系统文件对话框——这几件事**只有它做得到**，电脑上的浏览器一件都做不了。
 *  凡是「按了要真的管用」的开关，判据用它，不要用 hasDesktopFeatures */
export const isDesktopShell: boolean = inTauri && !isMobile;

/** 能不能把一份文件交到用户手上：电脑上的橡果走系统保存对话框，浏览器走下载。
 *  **唯一做不到的是安卓 App**——save() 给回的是 content:// URI，Rust 侧 fs::write 写不了，
 *  用户只会看到一句「导出失败」（v1.10.0 那笔账）。导出类按钮的显示与否一律认这一条 */
export const canSaveFile: boolean = isDesktopShell || isWeb;

/** 桌面版**界面**（宽屏那一套：常驻侧栏、hover、右键菜单）。
 *  **它只说长相，不说本事**——电脑上的浏览器这一条也是真。
 *  要判「这台机器做不做得到」请用 isDesktopShell / canSaveFile */
export const hasDesktopFeatures: boolean = !isMobile;

/** 窄屏（含桌面把窗口拖窄）。布局用它，能力开关用 isMobile——两件事别混 */
export const NARROW_PX = 760;

/** 已经「添加到主屏幕」了吗（从主屏那个图标点进来的那一份，没有浏览器地址栏）。
 *  用函数不用常量：显示模式是可以变的（Safari 里同一份代码既可能在标签页里也可能在主屏窗口里），
 *  而且 jsdom 没有 matchMedia，取值时再问才好兜住 */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    /* 老引擎不认这个媒体查询，往下走 */
  }
  // iOS Safari 至今没实现 display-mode，只有这个自家属性
  return (navigator as { standalone?: boolean }).standalone === true;
}
