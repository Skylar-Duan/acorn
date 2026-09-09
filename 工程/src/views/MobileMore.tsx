// 「更多」（画板 ⑥，v1.11.0）——手机端把桌面侧栏下半截搬到这一页。
//
// 桌面侧栏是常驻的，十几项摊开也无所谓；手机上底部只放得下五格，所以除了
// 今天 / 习惯 / 计划 / 四象限，别的入口全在这儿：账号、日历、已完成、统计、回收站，
// 加上清单 / 需求方 / 标签三张表，右上角一颗齿轮进设置。
//
// 「习惯」2026-09-03 从这四宫格里撤了——它已经钉在底部导航上，同一个入口摆两遍
// 只会让人怀疑这两处是不是不一样的东西。空出来的那格先给了「四象限」；
// v1.14.1 四象限进了底部导航（用户：「四象限跟已完成换位置，已完成收进去」），
// 这一格换成「已完成」——回头看的地方收在这儿，天天要动手的地方留在导航上。
//
// 清单和需求方这两张表 v1.14.1 起**按住一行就能拖着换顺序**：手机上没有 HTML5 拖拽，
// 走的是 core/touchSort 那台长按状态机；落库仍是侧栏那两个函数，一处逻辑两端共用。
//
// 这一页**不是一个 ViewId**：它没有自己的数据、不需要被记住、桌面上也不存在。
// 开关就在 MobileShell 的一个本地 state 里，点走任何一项它自己就收了（onNavigate）。

import { useState } from "react";
import { LIST_COLORS } from "../core/model";
import {
  addList, aliveTasks, allTags, allWho, moveList, moveWho, navigate, trashedSubtaskRows, useApp,
} from "../core/store";
import { forceFoldOpen } from "../core/useFold";
import { useLongPressSort } from "../core/touchSort";
import { syncFootState, useSync } from "../core/syncCtl";
import MobileHead from "../mobile/MobileHead";
import { openLogin } from "../mobile/sheetStore";
import {
  IcoCalendar, IcoDone, IcoGear, IcoNext, IcoPlus, IcoStats, IcoTrash,
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
  /** 正拖着的那一行现在悬在谁头上（那一行上缘画一道落点线） */
  const [moveOver, setMoveOver] = useState<string | null>(null);
  const moveHint = { over: moveOver, set: setMoveOver };
  // 落库走侧栏那两个现成的函数，不在手机上另写一套：
  // 清单的顺序是数据（会同步到别的设备、能 Ctrl+Z 撤回），
  // 需求方的顺序是本机设置（每台设备各排各的，跟着 whoOrder 走）
  const listSort = useLongPressSort("list", moveList, moveHint);
  const whoSort = useLongPressSort("who", moveWho, moveHint);

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
        sub="日历、已完成、清单，和你的账号"
        search={false}
        right={
          <button className="mhead-btn" aria-label="设置" onClick={go(() => navigate("settings"))}>
            <IcoGear />
          </button>
        }
      />
      <div className="view-body">
        {/* 账号：登录了就报邮箱和上次同步的时刻；没登录，这一格本身就是登录入口。
            跳设置之前先把「云账号」那一节掰开：设置页 v1.14.1 起是手风琴、默认收着，
            不掰开的话点了账号进去还得自己再找一下（侧栏那行同步指示走的也是这条路） */}
        {session ? (
          <button className="mmore-acct" onClick={go(() => { forceFoldOpen("cloud", "acorn-set-"); navigate("settings"); })}>
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
          {/* 「已完成」v1.14.1 从底部导航收进来（四象限接了它那格）：
              做完的事是回头看的，一周想不起来点几次，一步能到就够了 */}
          <button className="mmore-tile" onClick={go(() => navigate("done"))}>
            <span className="ico">
              <IcoDone size={24} />
            </span>
            <b>已完成</b>
            <span>做完的事按天收着</span>
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

        {/* 按住一行就能拖着换顺序。这句小字是必须的：手机上没有鼠标可以「试着拖一下」，
            不说一声就没人知道这件事存在（桌面那边靠的是 title 提示） */}
        <div className="group-head">
          清单
          <span className="mgroup-hint">按住可换位置</span>
        </div>
        <div className="mcard">
          {lists.map((l) => (
            <button
              key={l.id}
              className={`mli${listSort.lifted(l.id) ? " lifted" : ""}${moveOver === `list:${l.id}` ? " move-over" : ""}`}
              onClick={go(() => navigate("list", { listId: l.id }))}
              {...listSort.props(l.id)}
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
            {/* 需求方的顺序跟清单不是一回事：它只存在这台设备的设置里（whoOrder），
                不上云、也不进撤销栈——手机上排的顺序不会跑到电脑上去，反过来也一样 */}
            <div className="group-head">
              需求方
              <span className="mgroup-hint">按住可换位置</span>
            </div>
            <div className="mcard">
              {whoList.map(({ who, open: n }) => (
                <button
                  key={who}
                  className={`mli${whoSort.lifted(who) ? " lifted" : ""}${moveOver === `who:${who}` ? " move-over" : ""}`}
                  onClick={go(() => navigate("who", { who }))}
                  {...whoSort.props(who)}
                >
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
