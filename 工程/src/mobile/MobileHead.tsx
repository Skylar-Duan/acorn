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
import { setSearchOpen, useApp } from "../core/store";
import ThemeScene from "../components/ThemeScene";
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
  /** 标题右边那颗有表情的小橡果。**只有「今天」传 true**——见下面 AcornMascot 的注脚 */
  mascot?: boolean;
}

/**
 * 一颗有表情的小橡果（画板 PolishA 里那 30×30 的 SVG，路径原样抄过来）。
 *
 * 它是「方向 A」唯一的拟人笔触，也是用户说的「可爱」落到实处的那一下。
 * **只在「今天」的标题右边露一次脸**：每一页都摆一颗，第二次见就不可爱了，是噪音。
 *
 * 颜色写死不是漏了 token：橡果在哪个主题里都是这颗橡果（跟 logo 同理），
 * 六款主题换的是纸和墨，不换这颗果子的皮。
 */
function AcornMascot() {
  return (
    <svg className="mhead-acorn" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
      <path d="M8 12c0-4.5 3-8 7-8s7 3.5 7 8H8z" fill="#8F6B3E" />
      <rect x="6" y="11" width="18" height="3.4" rx="1.7" fill="#A67D4A" />
      <path d="M8.5 14.4c0 6.5 3 9.6 6.5 12 3.5-2.4 6.5-5.5 6.5-12z" fill="#D6B47E" />
      <circle cx="12.4" cy="18.6" r="1.1" fill="#4A3A23" />
      <circle cx="17.6" cy="18.6" r="1.1" fill="#4A3A23" />
      <path d="M13.2 21.3c1 .9 2.6.9 3.6 0" stroke="#4A3A23" strokeWidth="1" strokeLinecap="round" fill="none" />
      <circle cx="10.6" cy="20.4" r="1.1" fill="#F0A9A0" opacity=".8" />
      <circle cx="19.4" cy="20.4" r="1.1" fill="#F0A9A0" opacity=".8" />
    </svg>
  );
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
  title, sub, ring, search = true, onBack, dot, small, right, extra, mascot,
}: MobileHeadProps) {
  // 顶栏后面那片风景用的就是桌面那六幅（ThemeScene，颜色全走主题 token）。
  // 挂在这儿而不是壳子里：每个视图的第一块都是 .mhead，挂在它身上就等于每页都有，
  // 而且它跟着标题一起钉在顶上——列表滚起来时风景不动，像窗外的景
  const theme = useApp((s) => s.data.settings.theme);
  return (
    <div className="view-head mhead">
      {/* z-index:-1 沉在内容之下（样式见 mobile-shell.css 的 .mhead-scene）。
          桌面那幅贴在主区**底部**的水印在手机上已经撤了（App.tsx 只在 !isMobile 时挂），
          否则它会从底部导航条底下露出小半个太阳来——PM 一眼就看见的那个「幽灵圆」 */}
      <div className="mhead-scene" aria-hidden="true">
        <ThemeScene theme={theme} />
      </div>
      <div className="mhead-top">
        {onBack && (
          <button className="mhead-plain" aria-label="返回" onClick={onBack}>
            <IcoBack />
          </button>
        )}
        {dot && <span className="mhead-dot" style={{ background: dot }} />}
        <div className="mhead-txt">
          <div className="mhead-titleline">
            <div className={`serif mhead-title${small ? " small" : ""}`}>{title}</div>
            {mascot && <AcornMascot />}
          </div>
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
