// 手机上那一下轻震（10-30）。只在手指「做成了一件事」的那一刻震：勾掉、滑过生效线、长按弹出单子。
//
// 走浏览器自带的 navigator.vibrate：安卓 WebView 认它（清单里要有 VIBRATE 权限，打包脚本会补上），
// iPhone 的 Safari 不认——不认就安静地什么都不做，不报错、不弹提示。
// 时长 10ms：比系统键盘的按键反馈还轻一点，是「到位了」的提示，不是「出事了」的警报。

import { isMobile } from "../core/platform";

export function haptic(ms = 10): void {
  if (!isMobile) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* 有的系统在省电模式下直接抛错，震不了就算了 */
  }
}
