// 「一行起步、内容多了就长一行」的 textarea（v1.9.1）。
//
// 由来：任务卡里的标题、子任务标题、底下那条「整句改」原本都是 <input>，长句子一律单行截断——
// 而列表行上它已经是一行省略号了，点开这张卡本来就是「看全」的唯一地方，
// 卡里再截断一次等于哪儿都看不全。换成 textarea 之后高度得自己算，就是这两个小工具。
//
// 放在单独一个文件里是为了**躲开循环引用**：TaskCard 引 SyntaxInput，
// 两边都要用它，谁存着都会绕回去。

/** 按内容重算高度。
 *
 *  为什么不用 CSS 的 `field-sizing: content` —— 它 2024 年才进 Chromium，
 *  这个 App 还要在安卓 WebView 和别人的浏览器里跑，兜不住的地方就是标题框永远一行高。
 *
 *  先设 auto 再读 scrollHeight 是**必须的两步**：不归零的话 scrollHeight 永远不小于
 *  当前高度，框只会越长越高、删字也缩不回去。
 *  传 null 是 ref 卸载那一下（React 会用 null 调一次），直接放过。 */
export function growArea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** 换行符当空格吃掉。
 *
 *  标题、「整句改」那句话都是**一行字段**（子任务标题原来也是，v1.15 起允许换行，见下面 keepLines）。换成 textarea 之后 Enter 已经被
 *  各自的 onKeyDown 拦掉了，但**粘贴**还能带进 \n —— input 那边是浏览器替我们吃的，
 *  换了元素就得自己吃。标题里混进换行会一路脏到列表行、搜索结果和整句改那句话里。 */
export function oneLine(v: string): string {
  return v.replace(/[\r\n]+/g, " ");
}

/** 换行留着，只把 \r\n / \r 统一成 \n。
 *
 *  **只给子任务标题用**：用户要在子任务里 Shift+Enter 写几行（任务卡里加子任务、改子任务）。
 *  母任务标题、整句改那句话还是一行字段，照旧走上面的 oneLine */
export function keepLines(v: string): string {
  return v.replace(/\r\n?/g, "\n");
}
