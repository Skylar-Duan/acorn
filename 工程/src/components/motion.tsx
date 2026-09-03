// 动效要用到的几个共用件（v1.9.0 · B 组）。时长一律来自 core/motion.ts，这里不写死任何毫秒数。
//
// 解决的是同一个毛病：条件渲染的东西**只有进场没有退场**——一到该消失的时候就是「啪一下没了」。
// 办法都一样：让它比状态多活一拍，那一拍里挂上 .leaving / .shut 把退场动画播完。
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { cardMs, popMs } from "../core/motion";

/** 弹层 / 提示条 / 批量条的退场（B6）。
 *
 *  传进来的是「现在该显示的那个值」，null = 该没了。返回的 shown 会比 null 多留一拍，
 *  leaving 期间调用方给元素挂上 .leaving，退场动画才有机会播完。
 *
 *  状态在渲染里翻、不放 useEffect：放那儿元素已经被卸载掉了，动画根本没机会开始。 */
export function useLeaving<T>(value: T | null): { shown: T | null; leaving: boolean } {
  const [prev, setPrev] = useState<T | null>(value);
  const [held, setHeld] = useState<T | null>(value);
  if (prev !== value) {
    setPrev(value);
    // 值变没了不动 held，交给下面那个计时器收——中间这一拍正是退场动画
    if (value !== null) setHeld(value);
  }
  const leaving = value === null && held !== null;
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setHeld(null), popMs());
    return () => clearTimeout(t);
  }, [leaving]);
  return { shown: value ?? held, leaving };
}

/** 任务卡收起来的那一拍（B1）。open 从 true 变 false 之后再返回 true 一段时间，
 *  好让卡片留在树上把「收回去」演完 */
export function useCardClosing(open: boolean): boolean {
  const [prev, setPrev] = useState(open);
  const [closing, setClosing] = useState(false);
  if (prev !== open) {
    setPrev(open);
    setClosing(!open);
  }
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setClosing(false), cardMs());
    return () => clearTimeout(t);
  }, [closing]);
  return closing;
}

/** 任务卡的外壳：高度 0fr↔1fr，卡片是「长出来」的而不是糊上去的（B1）。
 *
 *  clip 只在动的那一拍挂：0fr 的轨道自己关不住里面的内容，得靠 overflow 关；
 *  但**常驻关着不行**——任务卡里那几个弹层（日期/清单/需求方）会被裁掉半截。 */
export function CardSlot({ shut, children }: { shut: boolean; children: ReactNode }) {
  const [clip, setClip] = useState(true);
  useEffect(() => {
    // 兜底：万一 animationend 没来（动画被降级成 0 之类），也不能一直关着
    const t = setTimeout(() => setClip(false), cardMs() * 3);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      className={`card-slot${shut ? " shut" : ""}${clip || shut ? " clip" : ""}`}
      onAnimationEnd={(e) => {
        if (e.animationName === "slot-open") setClip(false);
      }}
    >
      {children}
    </div>
  );
}

/** 一行 ↔ 一张卡的位置。行和卡**同时挂在树上**，靠高度互相让位，
 *  所以收起来跟展开一样有动画。
 *
 *  只给「一件事就占一行」的视图用（清单/需求方/标签这类）。今天/计划那边一件事会拆成好几行、
 *  卡片得按任务 id 认 key，走 RowList 自己那一套，不能用这个。 */
export function RowCard({
  open,
  row,
  card,
}: {
  open: boolean;
  /** 参数是「这一行要不要让位」——让位时行收成 0 高，卡片顶上来 */
  row: (collapsed: boolean) => ReactNode;
  card: () => ReactNode;
}) {
  const closing = useCardClosing(open);
  return (
    <>
      {row(open)}
      {(open || closing) && <CardSlot shut={!open}>{card()}</CardSlot>}
    </>
  );
}
