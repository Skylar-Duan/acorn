// 「更多」（画板 ⑥，v1.11.0）——手机端把桌面侧栏下半截搬到这一页。
//
// 桌面侧栏是常驻的，十几项摊开也无所谓；手机上底部只放得下五格，所以除了
// 今天 / 习惯 / 计划 / 已完成，别的入口全在这儿：账号、日历、四象限、统计、回收站，
// 加上清单 / 需求方 / 标签三张表，右上角一颗齿轮进设置。
//
// 「习惯」2026-09-03 从这四宫格里撤了——它已经钉在底部导航上，同一个入口摆两遍
// 只会让人怀疑这两处是不是不一样的东西。空出来的那格给「四象限」（手机上它独立成页了）。
//
// 这一页**不是一个 ViewId**：它没有自己的数据、不需要被记住、桌面上也不存在。
// 开关就在 MobileShell 的一个本地 state 里，点走任何一项它自己就收了（onNavigate）。

import { useState } from "react";
import { LIST_COLORS } from "../core/model";
import {
  addList, aliveTasks, allTags, allWho, navigate, trashedSubtaskRows, useApp,
} from "../core/store";
import { syncFootState, useSync } from "../core/syncCtl";
import MobileHead from "../mobile/MobileHead";
import { openLogin } from "../mobile/sheetStore";
import {
  IcoCalendar, IcoGear, IcoNext, IcoPlus, IcoQuad, IcoStats, IcoTrash,
} from "../mobile/icons";
import "../styles/mobile-shell.css";
import "../styles/mobile-pages.css";

export default function MobileMore({ onNavigate }: { onNavigate?: () => void }) {
  const tasks = useApp((s) => s.data.tasks);
  const rawLists = useApp((s) => s.data.lists);
  const settings = useApp((s) => s.data.settings);
  // 三个 selector 分开取：syncFootState 每次都返回新对象，整份算会一直重渲染（跟侧栏同一处教训）
  const session = useSync((s) => s.session);
  const phase = useSync((s) => s.phase);
  const needsUpgrade = useSync((s) => s.needsUpgrade);
  const sync = syncFootState({ session, phase, needsUpgrade });
  const [adding, setAdding] = useState(false);

  const open = aliveTasks({ tasks }).filter((t) => !t.done && !t.droppedAt);
  const lists = [...rawLists].sort((a, b) => a.order - b.order);
  const whoList = allWho({ tasks, settings });
  const tagList = allTags({ tasks });
  // 跟侧栏角标同口径：整件事 + 单独删掉的子任务（v1.13.0）
  const trashCount = tasks.filter((t) => t.deletedAt).length + trashedSubtaskRows({ tasks }).length;

  const go = (fn: () => void) => () => {
    fn();
    onNavigate?.();
  };

  return (
    <section className="main">
      <MobileHead
        title="更多"
        sub="日历、四象限、清单，和你的账号"
        search={false}
        right={
          <button className="mhead-btn" aria-label="设置" onClick={go(() => navigate("settings"))}>
            <IcoGear />
          </button>
        }
      />
      <div className="view-body">
        {/* 账号：登录了就报邮箱和上次同步的时刻；没登录，这一格本身就是登录入口 */}
        {session ? (
          <button className="mmore-acct" onClick={go(() => navigate("settings"))}>
            <span className="mmore-avatar">{session.email.slice(0, 1).toUpperCase()}</span>
            <span className="txt">
              <span className="name">{session.email}</span>
              <span className={`state${sync?.bad ? " dim" : ""}`}>{sync?.text ?? "已登录"}</span>
            </span>
            <span className="go">
              <IcoNext />
            </span>
          </button>
        ) : (
          <button className="mmore-acct" onClick={() => openLogin("manual")}>
            <span className="mmore-avatar">＋</span>
            <span className="txt">
              <span className="name wrap">登录，让手机和电脑记的是同一本</span>
              <span className="state dim">现在这些事只存在这台设备上</span>
            </span>
            <span className="go">
              <IcoNext />
            </span>
          </button>
        )}

        <div className="mmore-tiles">
          <button className="mmore-tile" onClick={go(() => navigate("calendar"))}>
            <span className="ico">
              <IcoCalendar size={24} />
            </span>
            <b>日历</b>
            <span>按月、按周看安排</span>
          </button>
          <button className="mmore-tile" onClick={go(() => navigate("quadrant"))}>
            <span className="ico">
              <IcoQuad />
            </span>
            <b>四象限</b>
            <span>按重要和紧急分四格</span>
          </button>
          <button className="mmore-tile" onClick={go(() => navigate("stats"))}>
            <span className="ico">
              <IcoStats />
            </span>
            <b>统计</b>
            <span>这周做完了几件</span>
          </button>
          <button className="mmore-tile" onClick={go(() => navigate("trash"))}>
            <span className="ico">
              <IcoTrash size={24} />
            </span>
            <b>回收站</b>
            <span>{trashCount > 0 ? `${trashCount} 件，删掉的留 30 天` : "删掉的留 30 天"}</span>
          </button>
        </div>

        <div className="group-head">清单</div>
        <div className="mcard">
          {lists.map((l) => (
            <button
              key={l.id}
              className="mli"
              onClick={go(() => navigate("list", { listId: l.id }))}
            >
              <span className="msheet-dot" style={{ background: `var(--list-${l.color})` }} />
              {l.name}
              <span className="n">{open.filter((t) => t.listId === l.id).length || ""}</span>
            </button>
          ))}
          {adding ? (
            <div className="mli">
              <input
                className="input"
                autoFocus
                placeholder="清单名，回车创建"
                onKeyDown={(e) => {
                  const el = e.target as HTMLInputElement;
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    const v = el.value.trim();
                    if (v) {
                      addList(v, LIST_COLORS[rawLists.length % LIST_COLORS.length]);
                      el.value = "";
                    } else {
                      setAdding(false);
                    }
                  }
                  // Esc 才是丢弃。先清空再关：万一 blur 还是来了，读到的也是空的
                  if (e.key === "Escape") {
                    el.value = "";
                    setAdding(false);
                  }
                }}
                // 「点走 = 存下」，但**窗口失焦不是点走**（跟侧栏那个框同一道闸）：
                // 切到别的应用时框原样悬着，等人回来自己了结，不会凭空多出一张叫「工」的清单
                onBlur={(e) => {
                  if (!document.hasFocus()) return;
                  const v = e.target.value.trim();
                  if (v) addList(v, LIST_COLORS[rawLists.length % LIST_COLORS.length]);
                  setAdding(false);
                }}
              />
            </div>
          ) : (
            <button className="mli add" onClick={() => setAdding(true)}>
              <IcoPlus size={18} />
              新建清单
            </button>
          )}
        </div>

        {whoList.length > 0 && (
          <>
            <div className="group-head">需求方</div>
            <div className="mcard">
              {whoList.map(({ who, open: n }) => (
                <button key={who} className="mli" onClick={go(() => navigate("who", { who }))}>
                  <span className="who-ava">{who.slice(0, 1)}</span>
                  {who}
                  <span className="n">{n || ""}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {tagList.length > 0 && (
          <>
            <div className="group-head">标签</div>
            <div className="mcard">
              {tagList.map(({ tag, open: n }) => (
                <button key={tag} className="mli" onClick={go(() => navigate("tag", { tag }))}>
                  <span className="hash">#</span>
                  {tag}
                  <span className="n">{n || ""}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
