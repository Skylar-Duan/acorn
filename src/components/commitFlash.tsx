// 提交回执（v1.9.0 · A2）：打字类操作「存上了」的那一声轻响，全应用共用这一份。
//
// 为什么不用 toast：toast 是留给**可撤销的破坏性操作**的（完成/删除/顺延），
// 那条底部黑条一出现就意味着「你可以反悔」。打字存上了不需要反悔，只需要被看见——
// 所以做成输入框自己亮一下边框 + 右边浮个「✓」，不多一次点击、也不抢注意力。
import { useCallback, useEffect, useRef, useState } from "react";

/** 一次回执从头到尾多久：边框亮 200ms（CSS 里那段），「✓」停 800ms 再淡出 */
export const FLASH_MS = 1100;
/** 逐键落库那几处（任务标题/备注/子任务名/习惯名）停手多久才算「这一下打完了」 */
export const TYPING_IDLE_MS = 600;

/** 手动触发的回执：回车 / 失焦提交的那一下调 flash()。
 *  `on` 挂到输入框的 className 上（.commit-lit）与 <CommitMark> 上 */
export function useCommitFlash(): { on: boolean; flash: () => void } {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    // 连着提交两次也得看得见第二次：先摘掉 class 让 CSS 动画能重头再来，下一拍再挂回去
    setOn(false);
    timer.current = setTimeout(() => {
      setOn(true);
      timer.current = setTimeout(() => {
        timer.current = null;
        setOn(false);
      }, FLASH_MS);
    }, 0);
  }, []);
  return { on, flash };
}

/** 逐键落库那几处的回执（A7）：没有「提交」这个动作，就以**停手** TYPING_IDLE_MS 为准闪一下。
 *  首次渲染不闪——那是打开卡片，不是刚存了东西 */
export function useTypingFlash(value: string): boolean {
  const { on, flash } = useCommitFlash();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(flash, TYPING_IDLE_MS);
    return () => clearTimeout(t);
  }, [value, flash]);
  return on;
}

/** 浮在输入框右边的那个「✓」。本身零宽，插在输入框后面即可，不会把同行的东西挤走 */
export function CommitMark({ on }: { on: boolean }) {
  return (
    <span className="commit-slot" aria-hidden="true">
      {on && <span className="commit-ok">✓</span>}
    </span>
  );
}
