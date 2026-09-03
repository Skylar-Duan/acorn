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
import { IcoDone, IcoHabits, IcoMore, IcoPlan, IcoPlus, IcoToday } from "./icons";
import "../styles/mobile-shell.css";

/** 底部那五格。**固定五项**——常驻位再多一个就谁都记不住了。
 *
 *  v1.11.1 起那个「随手」记东西的常驻位撤了（用户原话：「手机版没必要，那个加号标签就能记」）：
 *  记一条走右下角那颗 ＋，一个入口就够了。v1.11.2 把这条走完——手机上那个词一处都不留了，
 *  没归清单的事在「计划」「今天」「日历」里照常排着，一条都没少。
 *  空出来的那格给「习惯」——它是每天都要点开打卡的，收在「更多」里等于逼人每天多点两下。 */
const TABS = [
  { id: "today", label: "今天", Icon: IcoToday },
  { id: "habits", label: "习惯", Icon: IcoHabits },
  { id: "plan", label: "计划", Icon: IcoPlan },
  { id: "done", label: "已完成", Icon: IcoDone },
] as const;

/** 这几页上不出现「记一条」：它们要么是回头看的（已完成 / 统计 / 回收站 / 日历），
 *  要么根本不是记事的地方（设置 / 更多）。摆一颗按了没意义的按钮，比不摆更糟。
 *
 *  v1.11.2 把「习惯」从这张表里拿掉了：用户看到那一页没有 ＋，第一反应是
 *  「那个加号被遮住了是什么问题」——一颗每页都在的按钮突然缺席，读起来是坏了，不是没有。
 *  现在习惯页也有 ＋，只是它加出来的是**一个习惯**（拉 HabitSheet），不是一条任务 */
const NO_FAB: ViewId[] = ["done", "calendar", "settings", "stats", "trash"];

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
          aria-label={view === "habits" ? "加一个习惯" : "记一条"}
          // 习惯页那颗 ＋ 加的是**习惯**：这一页里一件事都不该以任务的身份冒出来。
          // 别处从清单页点 ＋ 记的这一条默认就归这张清单——人在哪儿记，就记在哪儿
          onClick={() =>
            view === "habits"
              ? openSheet({ kind: "habit" })
              : openSheet({ kind: "quickAdd", listId: view === "list" ? listId : null })
          }
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
            {/* 图标外面这层是当前项那颗小胶囊的落脚点（.mnav-ico，见 mobile-shell.css）：
                垫在图标底下而不是整颗按钮底下，五格才不会变成五颗挤在一起的药丸 */}
            <span className="mnav-ico">
              <Icon />
            </span>
            {label}
          </button>
        ))}
        <button
          className={`mnav-tab${moreOpen ? " on" : ""}`}
          aria-current={moreOpen ? "page" : undefined}
          onClick={() => setMoreOpen(true)}
        >
          <span className="mnav-ico">
            <IcoMore />
          </span>
          更多
        </button>
      </nav>
    </div>
  );
}
