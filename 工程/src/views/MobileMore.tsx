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
// v1.15.0 把「按住之后画一条落点线」换成真拖动：卡片贴着手指走，其余的行实时让位，
// 空出来的那一格就是落点（用户：「像 notability 一样可以真的把这个卡片拖着到处跑」）。
//
// 这一页**不是一个 ViewId**：它没有自己的数据、不需要被记住、桌面上也不存在。
// 开关就在 MobileShell 的一个本地 state 里，点走任何一项它自己就收了（onNavigate）。

import { useEffect, useReducer, useState } from "react";
import { LIST_COLORS } from "../core/model";
import {
  addList, aliveTasks, allTags, allWho, moveList, moveWho, navigate, trashedSubtaskRows, useApp,
} from "../core/store";
import { forceFoldOpen } from "../core/useFold";
import { isMobile, isStandalone, isWeb } from "../core/platform";
import { useCardSort } from "../core/touchSort";
import { syncFootState, useSync } from "../core/syncCtl";
import MobileHead from "../mobile/MobileHead";
import { openLogin } from "../mobile/sheetStore";
import {
  IcoCalendar, IcoDone, IcoGear, IcoNext, IcoPlus, IcoStats, IcoTrash,
} from "../mobile/icons";
import "../styles/mobile-shell.css";
import "../styles/mobile-pages.css";

// ---------- 添加到主屏幕（v1.15.0，只有手机浏览器里有这回事） ----------
//
// **这不是锦上添花，是网页版这一端的数据安全措施。** 不登录的话账本只在这个浏览器里，
// 而苹果对「普通网站」的数据是会主动清的（长期不打开就整站清掉）；已经添加到主屏幕的
// 那一份不在此列，打开也快，还没有地址栏来回收放。
//
// 两家的做法不一样：安卓 Chrome 会先给一个 beforeinstallprompt 事件，接住它就能摆一颗
// 真按钮、按下去弹系统的安装框；苹果至今没有这个事件，只能图文告诉他分享菜单在哪。

interface InstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
}

/** 关掉之后不再烦他。**必须 acorn- 开头**：清空本机时是按这个前缀扫 localStorage 的 */
const A2HS_OFF_KEY = "acorn-a2hs-off";

/** 浏览器给的那个「可以装」的机会。它来得早（往往在 React 挂载之前），
 *  所以在模块这一层就接住存起来，等界面问的时候再给 */
let installOffer: InstallPromptEvent | null = null;
const offerSubs = new Set<() => void>();

function tellSubs(): void {
  for (const f of offerSubs) f();
}

if (typeof window !== "undefined" && isWeb && isMobile) {
  window.addEventListener("beforeinstallprompt", (e) => {
    // 拦下来自己摆：浏览器自带那条横幅停在半屏中间，正好压着右下角那颗 ＋
    e.preventDefault();
    installOffer = e as InstallPromptEvent;
    tellSubs();
  });
  window.addEventListener("appinstalled", () => {
    installOffer = null;
    tellSubs();
  });
}

export function isAddToHomeHushed(): boolean {
  try {
    return localStorage.getItem(A2HS_OFF_KEY) === "1";
  } catch {
    return false;
  }
}

export function hushAddToHome(): void {
  try {
    localStorage.setItem(A2HS_OFF_KEY, "1");
  } catch {
    /* 存不下就下次再问一遍，不值得为这件事报错 */
  }
}

/** 这台设备该不该、能不能「添加到主屏幕」。
 *  · show —— 跑在手机浏览器里，而且还没装到主屏幕（装过的那一份 isStandalone 为真）
 *  · canPrompt —— 安卓那条路通着，按一下就能弹系统的安装框
 *  · prompt —— 弹它。**机会只有一次**，用掉就没了，所以用完当场清掉 */
export function useAddToHome(): { show: boolean; canPrompt: boolean; prompt: () => Promise<void> } {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    offerSubs.add(bump);
    return () => {
      offerSubs.delete(bump);
    };
  }, []);
  return {
    show: isWeb && isMobile && !isStandalone(),
    canPrompt: installOffer !== null,
    prompt: async () => {
      const offer = installOffer;
      if (!offer) return;
      installOffer = null;
      tellSubs();
      try {
        await offer.prompt();
      } catch {
        /* 用户按了取消也走这儿，没什么要交代的 */
      }
    },
  };
}

/** 苹果那边只能靠说的。这句话要跟他屏幕上看到的字一模一样，别自己发明叫法 */
const IOS_STEPS = "点底下那个分享，往下找「添加到主屏幕」";

/**
 * 导航上面那条提示（MobileShell 用）。**能关，关了不再烦。**
 *
 * 借的是撤销 toast 那身皮：位置、配色、给右下角那颗 ＋ 让出来的空当，
 * 全是现成的，不另起一套。有撤销 toast 在的时候自己先让开——两个抢同一个位置。
 */
export function AddToHomeNudge(): JSX.Element | null {
  const a2 = useAddToHome();
  const toast = useApp((s) => s.ui.toast);
  /** 「橡果有新版了 · 刷新」也站这个位置（App.tsx 那条）。两条都是 .toast、都 fixed 在
   *  屏幕底下同一处，谁都不让谁的话就是两行字压在一起、两颗按钮重合。
   *  定个先后：撤销 > 有新版了 > 放到桌面——前两条都是「这会儿不做就错过了」，
   *  而「放到桌面」什么时候说都行，下次进「更多」还找得到那条常驻入口 */
  const newVersion = useApp((s) => s.webNewVersion);
  const [hushed, setHushed] = useState(isAddToHomeHushed);
  if (!a2.show || hushed || toast || newVersion) return null;
  return (
    <div className="toast">
      {a2.canPrompt ? "把橡果放到桌面上，开起来更像个 App" : `把橡果放到桌面上：${IOS_STEPS}`}
      {a2.canPrompt && <button onClick={() => void a2.prompt()}>放到桌面</button>}
      <button
        aria-label="不用了"
        onClick={() => {
          hushAddToHome();
          setHushed(true);
        }}
      >
        不用了
      </button>
    </div>
  );
}

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
  // 落库走侧栏那两个现成的函数，不在手机上另写一套：
  // 清单的顺序是数据（会同步到别的设备、能 Ctrl+Z 撤回），
  // 需求方的顺序是本机设置（每台设备各排各的，跟着 whoOrder 走）。
  // 拖的手感两张表一模一样，落库仍旧各走各的
  const listSort = useCardSort("list", moveList);
  // 「添加到主屏幕」那条常驻入口：导航上面那条提示关掉之后，这儿仍然找得到
  const a2 = useAddToHome();
  const whoSort = useCardSort("who", moveWho);

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

        {/* 放到主屏幕。摆在账号下面是有道理的：这两件事说的是同一件——
            让记下的东西留得住。安卓能弹系统安装框，苹果只能照着步骤自己点一遍，
            所以那一档不做成按钮（按了没反应比没有更让人火大） */}
        {a2.show &&
          (a2.canPrompt ? (
            <button className="mmore-acct" onClick={() => void a2.prompt()}>
              <span className="mmore-avatar">⌂</span>
              <span className="txt">
                <span className="name wrap">把橡果放到主屏幕上</span>
                <span className="state dim">开起来更像个 App，数据也放得更稳</span>
              </span>
              <span className="go">
                <IcoNext />
              </span>
            </button>
          ) : (
            <div className="mmore-acct">
              <span className="mmore-avatar">⌂</span>
              <span className="txt">
                <span className="name wrap">把橡果放到主屏幕上</span>
                <span className="state dim">{IOS_STEPS}</span>
              </span>
            </div>
          ))}

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
        {/* 拖动中这张卡不能再裁切：被拎起来的那一行要浮出纸面（放大一点、带投影），
            .mcard 自己的 overflow: hidden 会把投影连着圆角一起切掉 */}
        <div className={`mcard${listSort.active ? " sorting" : ""}`} ref={listSort.box}>
          {lists.map((l) => (
            <button
              key={l.id}
              className={`mli${listSort.cls(l.id)}`}
              style={listSort.style(l.id)}
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
            <div className={`mcard${whoSort.active ? " sorting" : ""}`} ref={whoSort.box}>
              {whoList.map(({ who, open: n }) => (
                <button
                  key={who}
                  className={`mli${whoSort.cls(who)}`}
                  style={whoSort.style(who)}
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
