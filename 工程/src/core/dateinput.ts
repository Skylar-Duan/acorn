// 原生 `<input type="date">` 的落库节奏：**一次键盘编辑 = 一次落库**。
//
// 为什么非要有这一层：Chromium 的年 / 月 / 日**三段全都是累加**的，段内每敲一下就发一次
// change。把 2026-09-10 用键盘改成 2026-10-15（月段敲「1」「0」，日段敲「1」「5」），
// 控件依次吐出这四个值：
//   2026-01-10 → 2026-10-10 → 2026-10-01 → 2026-10-15
// 后三个的年份都是 2026，四个也全是格式合法的完整日期——
// dates.isPlausibleYMD 那张白名单只拦得住**年份段**累加出来的 0002/0020/0202，
// 月/日段本来就没有「不可能的中间值」可判，白名单永远拦不住它。
//
// 逐个放行的代价（v1.9.0 复核实测）：中间那两个假日期**真的落了盘**（任务当场跳进逾期区、
// 提醒被重算成过去时刻，sweep 撞上就弹一次假通知），而「变晚了」的那两拍各让
// postponeCount 加一次——用户只做了一次「挪到 10 月 15」，计数却变成 2。
// 2 正好是所有判据的门槛：行尾当场挂出「顺延×2」、周报里写「（顺延 2 次）」，
// 而这个数没有任何入口能清零。
//
// 所以落库这一步统一压进一个短去抖：连着敲的那几拍只留最后一下。
// 鼠标点日历格那条路本来就一次 change 到位，多等这一拍手感上无感。
//
// **但去抖治不了 postponeCount**，别指望它：date 是分段控件，用户在月段和日段之间
// 抬眼确认一下就轻松超过下面这个 350ms——月段落一次（变晚了，+1）、日段再落一次（又变晚，+1），
// 净结果照样是 2。跟「停手多久」较劲永远有漏。顺延次数改成跟时长完全无关的算法：
// **弹层打开时记下当时的日子，弹层关掉时跟最终日期比一次**，往后挪了才 +1，只加这一次；
// 弹层期间的落库一律不计数（TaskCard.settleDuePopup / store.UpdateTaskOpts.noPostponeCount）。
// 去抖在这之后剩下的活是：少往盘里落几个中间态假日期（免得任务闪进逾期区、提醒被重算到过去时刻），
// 以及一串连打只占一格撤销栈。
//
// 闸门（isPlausibleYMD）**照旧留着**：它对年份段仍然有用，另外几个 date 输入也在用。
// 这里管的是「落几次」，那里管的是「这个值像不像话」，两件事。

/** 停手多久算「这一次编辑结束了」。
 *  比逐键落库那个 800ms 短不少：日期是点着改的，等太久会让人以为没生效 */
export const DATE_COMMIT_MS = 350;

export interface DateCommitter {
  /** 收到一个**已经过闸**的完整日期：排一次落库。同一串连打只留最后这一下 */
  schedule(ymd: string): void;
  /** 把还欠着的那一次立刻做掉（点到卡外、关弹层这种「话说完了」的时刻） */
  flush(): void;
  /** 丢掉还欠着的那一次，一个字都不落（点了预设 / 清了日期，中途那句作废） */
  cancel(): void;
  /** 还欠着的那个值，没有就是 null（给测试和调试看的） */
  pending(): string | null;
}

/** 造一个去抖落库器。
 *
 *  `commit` 会在停手之后被调**一次**。**别把 commit 写成捕获了组件 state 的闭包**：
 *  它烧到点时已经是 DATE_COMMIT_MS 之后了，闭包停在按下那一帧，回写的就是旧值。
 *  组件里的用法是让 commit 转手去调一个每次渲染都刷新的 ref。 */
export function makeDateCommitter(
  commit: (ymd: string) => void,
  ms: number = DATE_COMMIT_MS,
): DateCommitter {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting: string | null = null;

  function fire() {
    timer = null;
    const v = waiting;
    waiting = null;
    if (v != null) commit(v);
  }

  return {
    schedule(ymd) {
      waiting = ymd;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, ms);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (waiting != null) fire();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      waiting = null;
    },
    pending() {
      return waiting;
    },
  };
}
