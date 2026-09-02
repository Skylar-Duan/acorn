// 手机端的壳子（画板 ①⑥，v1.11.0）：底部五格导航 + 悬浮「记一条」+「更多」那一页。
//
// 手机不是缩小的电脑。桌面那套侧栏（十几项 + 三段可折叠的清单 / 需求方 / 标签）在手机上
// 是一个要先拉开、再找、再点的抽屉；这里换成**四个最常去的地方钉在底下**，剩下的全收进「更多」。
//
// 几条用户点过名的规矩：
//   · 底部导航**固定不动、不能左右滑**。整页里唯一能左右滑的是「一行事」。
//   · 顶上留 env(safe-area-inset-top)，但**不画假状态栏**——那是系统的地盘。
//   · ＋只在「记得下东西」的页面出现：已完成 / 更多 / 设置 / 统计 / 回收站 都不该有它。
//
// 「更多」不进 store 的 ViewId：它没有自己的数据、不需要被 navigate 记住、也不该出现在
// 桌面的路由里。就是这个壳子的一个本地开关，切走任何一个视图它自己就收了。

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { navigate, useApp } from "../core/store";
import type { ViewId } from "../core/store";
import { openSheet } from "./sheetStore";
import MobileMore from "../views/MobileMore";
import { IcoDone, IcoInbox, IcoMore, IcoPlan, IcoPlus, IcoToday } from "./icons";
import "../styles/mobile-shell.css";

/** 底部那五格。顺序照设计稿，**固定五项**——常驻位再多一个就谁都记不住了 */
const TABS = [
  { id: "inbox", label: "随手记", Icon: IcoInbox },
  { id: "today", label: "今天", Icon: IcoToday },
  { id: "plan", label: "计划", Icon: IcoPlan },
  { id: "done", label: "已完成", Icon: IcoDone },
] as const;

/** 这几页上不出现「记一条」：它们要么是回头看的（已完成 / 统计 / 回收站），
 *  要么根本不是记事的地方（设置 / 更多）。摆一颗按了没意义的按钮比不摆更糟 */
const NO_FAB: ViewId[] = ["done", "settings", "stats", "trash"];

export default function MobileShell({ children }: { children: ReactNode }) {
  const view = useApp((s) => s.ui.view);
  const listId = useApp((s) => s.ui.listId);
  const [moreOpen, setMoreOpen] = useState(false);

  // 切到别的视图就把「更多」收了。正常路径上 MobileMore 自己会调 onNavigate 收，
  // 这条是兜底：命令面板、搜索结果、撤销之类也能把视图换掉，那几条路不经过「更多」
  useEffect(() => setMoreOpen(false), [view]);

  const go = (id: ViewId) => {
    setMoreOpen(false);
    navigate(id);
  };

  const showFab = !moreOpen && !NO_FAB.includes(view);

  return (
    <div className="mshell">
      {moreOpen ? <MobileMore onNavigate={() => setMoreOpen(false)} /> : children}

      {showFab && (
        <button
          className="mfab"
          aria-label="记一条"
          // 从清单页点 ＋ 记的这一条默认就归这张清单——人在哪儿记，就记在哪儿
          onClick={() => openSheet({ kind: "quickAdd", listId: view === "list" ? listId : null })}
        >
          <IcoPlus />
        </button>
      )}

      <nav className="mnav">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`mnav-tab${!moreOpen && view === id ? " on" : ""}`}
            aria-current={!moreOpen && view === id ? "page" : undefined}
            onClick={() => go(id)}
          >
            <Icon />
            {label}
          </button>
        ))}
        <button
          className={`mnav-tab${moreOpen ? " on" : ""}`}
          aria-current={moreOpen ? "page" : undefined}
          onClick={() => setMoreOpen(true)}
        >
          <IcoMore />
          更多
        </button>
      </nav>
    </div>
  );
}
