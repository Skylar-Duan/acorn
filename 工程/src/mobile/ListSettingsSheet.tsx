// 清单设置（画板 ⑤，v1.11.0）——清单页顶上那颗「···」点开的一张纸。
//
// 桌面的清单页把改名框、六颗颜色点和一颗红色的「删除清单」全摊在标题这一行上。
// 那一行在 390px 宽的屏幕上根本排不下，而且「删除」这种一步到位的动作
// 不该跟标题挤在一起随时等着被误碰。所以手机上顶栏只剩「返回 · 色点 + 名字 · N 件 · ···」，
// 剩下的全收进这里。
//
// 删除清单说清后果，而且**说的是它真做的那件事**：现有的 store.deleteList 只是把这张清单里的事
// 变成「没有清单」，一件都不丢、也不丢进回收站——设计稿上那句「会一起进回收站」跟代码对不上，
// 照着写就是骗人。宁可跟设计稿差一句话，也不能让用户按着一句假话去点删除。

import { useState } from "react";
import { LIST_COLORS } from "../core/model";
import { aliveTasks, deleteList, renameList, setListColor, useApp } from "../core/store";
import Sheet from "./Sheet";
import { closeSheet, topSheet, useSheet } from "./sheetStore";
import { IcoGrip, IcoTrash } from "./icons";
import "../styles/mobile-shell.css";

export function ListSettingsSheetHost() {
  const top = useSheet((s) => topSheet(s.stack));
  const open = top?.kind === "listSettings";
  return (
    <Sheet open={open} onClose={closeSheet} label="清单设置">
      {/* key 带上清单 id：换一张清单要重开一个改名框，否则上一张的草稿会串过来 */}
      {open && top.kind === "listSettings" && <Body key={top.listId} listId={top.listId} />}
    </Sheet>
  );
}

function Body({ listId }: { listId: string }) {
  const data = useApp((s) => s.data);
  const list = data.lists.find((l) => l.id === listId);
  const [draft, setDraft] = useState(list?.name ?? "");
  /** 删除要按两下：第一下把这一行换成「真的删」＋「取消」。
   *  手机上没有右键、也没有「刚才那下是不是点歪了」的余地，一步到位太险 */
  const [confirming, setConfirming] = useState(false);

  if (!list) return null;

  // 「里面还有几件事」按跟侧栏角标一样的口径：还欠着的（没做完也没放弃）
  const n = aliveTasks(data).filter((t) => !t.done && !t.droppedAt && t.listId === list.id).length;

  function commitName() {
    const v = draft.trim();
    if (!v) {
      setDraft(list!.name); // 清空则还原，不许把清单改成没名字
      return;
    }
    if (v !== list!.name) renameList(list!.id, v);
  }

  return (
    <div className="mls-body">
      <div className="msheet-label">清单设置</div>

      <div className="mls-name">
        <span>名字</span>
        <input
          value={draft}
          aria-label="清单名"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              commitName();
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(list.name);
            }
          }}
          // 点走 = 存下。**窗口失焦不是点走**：切到别的应用时框原样悬着，
          // 等人回来自己了结（跟桌面清单页那个框同一道闸）
          onBlur={() => { if (document.hasFocus()) commitName(); }}
        />
      </div>

      <div className="msheet-label">颜色</div>
      <div className="mls-colors">
        {LIST_COLORS.map((c) => (
          <button
            key={c}
            className={`mls-sw${list.color === c ? " on" : ""}`}
            aria-label="换个颜色"
            style={{ background: `var(--list-${c})`, color: `var(--list-${c})` }}
            onClick={() => setListColor(list.id, c)}
          />
        ))}
      </div>

      {/* 清单的顺序跟着数据走，改它要能拖。手机上的拖动排序还在桌面侧栏那套里，
          这一版先如实说明去哪儿改，不做一个按了没反应的按钮 */}
      <div className="mls-opt dim">
        <IcoGrip />
        调整清单顺序
        <span className="why">在电脑上长按拖动</span>
      </div>

      {confirming ? (
        <>
          <button
            className="mls-opt danger"
            onClick={() => {
              deleteList(list.id);
              closeSheet();
            }}
          >
            <IcoTrash size={20} />
            真的删除「{list.name}」
            <span className="why">{n > 0 ? `${n} 件事会变成没有清单` : "这张清单是空的"}</span>
          </button>
          <button className="mls-opt" onClick={() => setConfirming(false)}>
            取消
          </button>
        </>
      ) : (
        <button className="mls-opt danger" onClick={() => setConfirming(true)}>
          <IcoTrash size={20} />
          删除清单
          <span className="why">
            {n > 0 ? `里面的 ${n} 件事会变成没有清单` : "这张清单是空的"}
          </span>
        </button>
      )}
    </div>
  );
}
