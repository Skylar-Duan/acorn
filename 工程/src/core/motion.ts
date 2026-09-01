// 动效时长的读法（v1.9.0 · B0）。
//
// **真源只有一处**：styles/base.css 里的 --dur-1 / --dur-2 / --ease。
// 这里不定义时长，只负责把 CSS 里那两个值读出来给 setTimeout 用——
// 凡是「动画演完了东西还赖着」或者「东西已经没了动画还在跑」，都是 JS 和 CSS 各写一遍写出来的。
//
// 想整体调轻 / 调慢 / 关掉动效：改 base.css 那三个值，这边跟着走，不用回来动代码。

/** 读一个 CSS 时长变量，单位毫秒。读不到（单测这类没有 DOM 的环境）用兜底值 */
function cssMs(name: string, fallback: number): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw) return fallback;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    // 写成 120ms 还是 .12s 都认
    return raw.endsWith("ms") ? n : n * 1000;
  } catch {
    return fallback;
  }
}

/** 小动作：淡入淡出、弹层退场、箭头转 */
export function dur1(): number {
  return cssMs("--dur-1", 120);
}

/** 大动作：卡片长出来、行收走、面折叠 */
export function dur2(): number {
  return cssMs("--dur-2", 180);
}

/** 勾掉一件事到那行真的消失，一共多久。
 *  跟 app.css 的 `.row-slot.leaving` 那条 animation 逐项对应：先停 --dur-1 让人看见勾上了，
 *  再用 --dur-2 把行收走。改 CSS 就够了，这里不写第二遍 */
export function doneRowMs(): number {
  return dur1() + dur2();
}

/** 任务卡长出来 / 收回去 */
export function cardMs(): number {
  return dur2();
}

/** 弹层、提示条、批量条的退场 */
export function popMs(): number {
  return dur1();
}

/** 「一次性翻掉整列」的时候关掉行的高度过渡（B5）。
 *
 *  为什么要有这个：`.row-slot` 收放靠 grid-template-rows，这属性上不了合成器，
 *  每一帧都要重算轨道并回流它下方的全部内容。单条小三角一次只动几行，随便动；
 *  但「收起/展开子任务」那个总开关一次翻掉的可能是上百行——而这个按钮存在的理由
 *  恰恰就是「行太多了」，于是它在最需要快的时候最卡。一次性翻掉整列本来也不该有动画。
 *
 *  做法是给 <html> 挂一拍 `.no-row-anim`（见 app.css），让这一次状态变化不走过渡。
 *  两帧之后才摘：第一个 rAF 跑在「带着新状态的那次绘制」**之前**，那会儿摘掉等于没硬切。
 *  后台标签页里 rAF 根本不调度，所以再挂一个计时器兜底——这个类绝不能永久留在那儿。 */
export const HARD_CUT_CLASS = "no-row-anim";

export function hardCutRows(): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.classList.add(HARD_CUT_CLASS);
  const off = () => el.classList.remove(HARD_CUT_CLASS);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(off));
  }
  setTimeout(off, Math.max(dur2() * 2, 200));
}
