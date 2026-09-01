// 日期输入：全仓**每一个** `<input type="date">` 都从这儿出，别再手写第二个。
// （测试 tests/commit-guards.test.ts 会当场拦下裸的 `<input type="date">`。）
//
// 为什么非得抽出来：同一个病在 v1.9.0 连着复发了四轮，每轮都是「某一处漏装了三件套里的一件」。
// 原生 date 是**分段控件**（年 / 月 / 日各自累加），用键盘改一次日期会连发好几个
// **格式合法的完整日期**，三件套缺一不可：
//
// ① **本地草稿**（这儿的 draft）
//    受控输入必须把中间值显出来。不显它，React 在 change 事件末尾就按 props 把 DOM 的 value
//    复原一次——键盘每敲一下都被弹回原值，用户看到的是「这个框坏了，按什么都没反应」。
//    所以 onChange 第一件事是**无条件**写草稿，闸门和落库都排在它后面。
//
// ② **合理性闸**（core/dates.isPlausibleYMD）
//    只拦得住**年份段**：敲 2/0/2/7 会依次吐出 0002-… / 0020-… / 0202-… / 2027-…，
//    前三个也是格式合法的完整日期，不拦就是把这件事排到公元 2 年去。
//    判据取「年份 1900–2999」，四位年的中间态最大只到 299，必定落在格子外面。
//
// ③ **去抖落库**（core/dateinput.makeDateCommitter）
//    月/日段的中间值年份也合法，**闸门对它们完全无效**，也没有别的白名单可判——
//    「把 9-10 改成 10-15」会连发 2026-01-10 / 2026-10-10 / 2026-10-01 / 2026-10-15 四拍。
//    逐个落库 = 两个假日期真进盘（任务闪进逾期区、提醒被重算成过去时刻），
//    postponeCount 还净加 2，正好够行尾挂出「顺延×2」。
//    所以一串连打只留最后一下：一次键盘编辑 = 一次落库。原委见 core/dateinput.ts。
//
// **第四件事是「不许自己关弹层」**：`onCommit` 只落库。收弹层归调用方，挂在 `onDone` 上
// （它由 onBlur 触发，且带着 `document.hasFocus()` 那道窗口判据，跟全仓口径一致）。
// 把收弹层写进去抖回调里，就是同一个「停手 350ms」把弹层连同这个框一起卸载——
// 用户接着敲的键全部落空，半截日期被当成他的选择，顺手还 +1 顺延。这个 bug 出过两回了。
//
// 对外还给调用方留了三个手（DateFieldHandle）：
//   flush()   —— 把还欠着的那一次立刻做掉（提交前、点走前）
//   cancel()  —— 那一次作废（点了预设 / 清了日期 / Esc 丢弃）
//   pending() —— 还欠着的那个值（回车落库时得把它捎上）
// 组件**卸载前会自己 flush 一次**：弹层被别处收掉时，刚敲完那一天不至于白敲。
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FocusEvent as ReactFocusEvent } from "react";
import { isPlausibleYMD } from "../core/dates";
import type { DateCommitter } from "../core/dateinput";
import { makeDateCommitter } from "../core/dateinput";

export interface DateFieldHandle {
  /** 还欠着的那一次立刻做掉（没欠着就什么都不做，不会白写一次） */
  flush(): void;
  /** 还欠着的那一次作废，一个字都不落 */
  cancel(): void;
  /** 还欠着的那个值，没有就是 null */
  pending(): string | null;
}

export interface DateFieldProps {
  /** 这个框**现在代表的那一天**（'' = 没有日期）。只在没焦点时直接显示它；
   *  有焦点时以草稿为准——不然键盘敲到一半会被 React 弹回原值 */
  value: string;
  /** 停手之后落库，**只落库**。绝不要在这儿收弹层 / 卸载这个框 */
  onCommit: (ymd: string) => void;
  /** 真的点走了（窗口失焦不算）。收弹层写在这儿 */
  onDone?: (e: ReactFocusEvent<HTMLInputElement>) => void;
  /** 默认 "inline"，跟弹层里那几个内联框一套样式 */
  className?: string;
}

const DateField = forwardRef<DateFieldHandle, DateFieldProps>(function DateField(
  { value, onCommit, onDone, className = "inline" },
  ref,
) {
  /** ① 本地草稿：键盘敲出来的中间值先无条件落在这儿 */
  const [draft, setDraft] = useState(value);
  /** 有没有焦点。没焦点时框显示的永远是 value（半截草稿不许留在界面上冒充结果） */
  const [focused, setFocused] = useState(false);
  /** 去抖烧到点时得用**那一刻**的 onCommit：闭包停在按下那一帧，回写的就是旧值 */
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  /** ③ 去抖器本身只造一次（每次渲染重造就等于没有去抖） */
  const committerRef = useRef<DateCommitter | null>(null);
  if (!committerRef.current) {
    committerRef.current = makeDateCommitter((ymd) => commitRef.current(ymd));
  }
  const committer = committerRef.current;

  useImperativeHandle(
    ref,
    (): DateFieldHandle => ({
      flush: () => committer.flush(),
      cancel: () => committer.cancel(),
      pending: () => committer.pending(),
    }),
    [committer],
  );

  // 卸载前把欠着的那一次做掉：弹层被 Esc / 点别处 / 收卡片收掉时，
  // 刚敲完的那一天不能就这么没了（不欠着的时候它什么都不做）
  useEffect(() => () => committer.flush(), [committer]);

  return (
    <input
      className={className}
      type="date"
      value={focused ? draft : value}
      onFocus={() => {
        setFocused(true);
        setDraft(value);
      }}
      onChange={(e) => {
        const v = e.target.value;
        // ① 先无条件写草稿——闸门和落库都排在它后面，否则键盘敲不动这个框
        setDraft(v);
        // ② 空串（三段没填满）和年份段的中间态都不算数：一个是「日期被清掉了」的误判，
        //    一个是公元 2 年。清日期由调用方那个「清除 / 不定日期」按钮承担
        if (!isPlausibleYMD(v)) return;
        // ③ 过了闸也不当场落：一串连打并成一次，停手才写
        committer.schedule(v);
      }}
      onBlur={(e) => {
        // **窗口失焦不是点走**：alt-tab 出去时框和草稿原样悬着，等人回来自己了结
        if (!document.hasFocus()) return;
        setFocused(false);
        // 话说完了：欠着的那一次提前做掉（不做它也会自己烧到点，只是要多等一拍）
        committer.flush();
        // 收弹层是**调用方**的事，不写在去抖回调里——那会在人还在敲的时候把框拆掉
        doneRef.current?.(e);
      }}
    />
  );
});

export default DateField;
