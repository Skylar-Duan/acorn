// 手机端各视图共用的顶栏（画板 ①⑤⑥，v1.11.0）。
//
// 桌面的 .view-head 是「标题 + 一行小字 + 右边一排控件」，挤在 26px 的字号里；
// 手机上照设计稿重排成：大标题（文楷 30px）+ 一行副标题 + 右边的进度环与搜索圆钮。
// 三件事都是为了「打开 3 秒内知道今天几件事、做完几件」：
//   · 标题大，一眼认得出自己在哪一页；
//   · 副标题写「9月2日 · 星期三 · 还剩 4 件」，把桌面沉在底部的那句话提上来；
//   · 进度环取代底部那条「完成 2/6」——底下那条在手机上被导航压着，等于没有。
//
// 单独一个文件而不是塞进 MobileShell：壳子要引「更多」那一页，而「更多」自己也要用这个顶栏，
// 两边互引会绕成环。抽出来之后谁都只依赖它，不依赖对方。

import type { ReactNode } from "react";
import { setSearchOpen } from "../core/store";
import { IcoBack, IcoSearch } from "./icons";
import "../styles/mobile-shell.css";

export interface MobileHeadProps {
  title: string;
  /** 标题底下那一行小字 */
  sub?: ReactNode;
  /** 完成进度环。total 为 0 时不画——一件事都没有的时候摆个空环只是噪音 */
  ring?: { done: number; total: number } | null;
  /** 右上角那颗搜索圆钮 */
  search?: boolean;
  /** 返回（清单页用）。给了就在标题左边画一颗 */
  onBack?: () => void;
  /** 标题前的色点（清单页用），传的是 CSS 颜色值 */
  dot?: string | null;
  /** 标题小一号（清单名 26px，跟设计稿一致） */
  small?: boolean;
  /** 塞在进度环 / 搜索钮左边的自定义件（清单页的「6 件」和「···」） */
  right?: ReactNode;
  /** 另起一行的筛选控件（计划的「列表 / 四象限」、已完成的三选一） */
  extra?: ReactNode;
}

/** 环的半径与描边照设计稿：44×44 的方盒里 r=18、4px 描边 */
const R = 18;
const C = 2 * Math.PI * R;

export function ProgressRing({ done, total }: { done: number; total: number }) {
  // 一件都没有时按 0 算，别让 0/0 变成 NaN 把整个环画没
  const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  return (
    <div className="mring" title={`完成 ${done} / ${total}`}>
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle className="track" cx="22" cy="22" r={R} fill="none" strokeWidth="4" />
        <circle
          className="fill"
          cx="22"
          cy="22"
          r={R}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - ratio)}
          transform="rotate(-90 22 22)"
        />
      </svg>
      <div className="num">
        {done}/{total}
      </div>
    </div>
  );
}

export default function MobileHead({
  title, sub, ring, search = true, onBack, dot, small, right, extra,
}: MobileHeadProps) {
  return (
    <div className="view-head mhead">
      <div className="mhead-top">
        {onBack && (
          <button className="mhead-plain" aria-label="返回" onClick={onBack}>
            <IcoBack />
          </button>
        )}
        {dot && <span className="mhead-dot" style={{ background: dot }} />}
        <div className="mhead-txt">
          <div className={`serif mhead-title${small ? " small" : ""}`}>{title}</div>
          {sub != null && sub !== "" && <div className="mhead-sub">{sub}</div>}
        </div>
        {right}
        {ring && ring.total > 0 && <ProgressRing done={ring.done} total={ring.total} />}
        {search && (
          <button className="mhead-btn" aria-label="搜索" onClick={() => setSearchOpen(true)}>
            <IcoSearch />
          </button>
        )}
      </div>
      {extra && <div className="mhead-extra">{extra}</div>}
    </div>
  );
}
