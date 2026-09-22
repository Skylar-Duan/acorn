// 主窗外壳：侧栏 + 视图路由 + 全局快捷键 + 撤销 toast + 批量操作条。
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Sidebar from "./components/Sidebar";
import { SideGrip } from "./components/SideGrip";
import Today from "./views/Today";
import ListView from "./views/ListView";
import Habits from "./views/Habits";
import Plan from "./views/Plan";
import Quadrant from "./views/Quadrant";
import Done from "./views/Done";
import Calendar from "./views/Calendar";
import FocusView from "./views/FocusView";
import StatsView from "./views/StatsView";
import Settings from "./views/Settings";
import CommandPalette from "./components/CommandPalette";
import SearchOverlay from "./components/SearchOverlay";
import ContextMenu from "./components/ContextMenu";
import ThemeScene from "./components/ThemeScene";
import DataRescue from "./components/DataRescue";
import UpdateDialog, { UpdateNudge } from "./components/UpdateDialog";
import NewerDataDialog from "./components/NewerDataDialog";
import ChangelogDialog from "./components/ChangelogDialog";
import QuickAddDialog from "./components/QuickAddDialog";
import AccountCorner from "./components/AccountPopover";
import PostponeButton from "./components/PostponeMenu";
import { useLeaving } from "./components/motion";
import {
  appStore, clearSelection, completeTasks, deleteTasks, dismissToast, expandTask,
  hasChain, navigate, postponeTasks, retrySave, setChainFolded, setChangelogOpen, setPaletteOpen,
  setQuickAddOpen, setSearchOpen, setSelection, setTasksList, setWebNewVersion, undo, useApp,
  postponeRowsForTasks,
} from "./core/store";
import { useUpdate } from "./core/updateCtl";
// 「数据打不开」那一屏上「检查更新」摆不摆得出来，认这一条（网页版没有包可下）
import { updaterSupported } from "./core/updater";
import { canSaveFile, isDesktopShell, isMobile, isWeb, isWebBuild } from "./core/platform";
import { isLoginLater, isPristineLocal, shouldOfferLogin } from "./core/fresh";
// 网页版「有新版了」：那边只管去问一句服务器，怎么提示在这儿（借的是撤销 toast 那身皮）
import { reloadForUpdate, startWebUpdateWatch } from "./core/webUpdate";
import * as cloud from "./core/cloud";
// 「数据打不开」那一屏要就地办事，用的全是现成的那几套（见文件末尾 DataErrorScreen）
import * as persist from "./core/persist";
import { signOut, useSync } from "./core/syncCtl";
import { toJsonFile } from "./core/transfer";
import { APP_VERSION } from "./core/model";
import { todayYMD } from "./core/dates";
// 手机端（v1.11.0）：壳子 + 四张从底下抽出来的纸。桌面上这几个一个都不挂
import MobileShell from "./mobile/MobileShell";
import { TaskSheetHost } from "./mobile/TaskSheet";
import { QuickAddSheetHost } from "./mobile/QuickAddSheet";
import { ActionSheetHost } from "./mobile/ActionSheet";
import { ListSettingsSheetHost } from "./mobile/ListSettingsSheet";
import { HabitSheetHost } from "./mobile/HabitSheet";
import { GuideSheetHost } from "./mobile/GuideSheetHost";
import { AccountSheetHost } from "./mobile/AccountSheet";
import { PostponeSheetHost } from "./mobile/PostponeSheet";
import { openLogin } from "./mobile/sheetStore";
// 登录页两端都用：手机上是整页，桌面上是居中弹窗（组件自己分叉）
import { LoginPageHost } from "./components/LoginPage";

function inEditable(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

/** 屏幕上当前可见任务行的 id（DOM 顺序即视觉顺序）。
 *  有子任务的事被拆成好几行、共用同一个任务 id，去重后方向键才是一件事一停 */
function visibleTaskIds(): string[] {
  const ids = [...document.querySelectorAll<HTMLElement>(".task-row[data-task-id]")].map(
    (el) => el.dataset.taskId!,
  );
  return [...new Set(ids)];
}

export default function App() {
  const view = useApp((s) => s.ui.view);
  // 这三个只为 B3 的正文淡入服务：清单/需求方/标签共用 ListView 这一个组件，
  // 光看 view 的话「清单 A → 清单 B」是同一个值，DOM 节点不重挂，淡入就不播——
  // 而这三段恰恰是侧栏里条目最多、点得最频繁的
  const listId = useApp((s) => s.ui.listId);
  const whoFilter = useApp((s) => s.ui.who);
  const tagFilter = useApp((s) => s.ui.tag);
  const loaded = useApp((s) => s.loaded);
  const loadError = useApp((s) => s.loadError);
  const dataFromNewer = useApp((s) => s.dataFromNewer);
  /** 「已有更新版橡果」那个框这次会话里点过取消的版本号。**只记这次会话**：
   *  每次冷启动都要再弹一次——它带着「现在更新」这条行动，不该关一次就永远不提 */
  const [noticeClosed, setNoticeClosed] = useState<number | null>(null);
  const toast = useApp((s) => s.ui.toast);
  const selectedIds = useApp((s) => s.ui.selectedIds);
  const paletteOpen = useApp((s) => s.ui.paletteOpen);
  const searchOpen = useApp((s) => s.ui.searchOpen);
  const changelogOpen = useApp((s) => s.ui.changelogOpen);
  /** 桌面的「记一条」弹窗（v1.11.2）。手机上不挂：那儿右下角那颗 ＋ 抽的是自己的纸 */
  const quickAddOpen = useApp((s) => s.ui.quickAddOpen);
  /** 这次启动是「装了新版第一次开」还是「第一次装橡果」还是「同一版又开一次」 */
  const firstRun = useUpdate((s) => s.firstRun);
  const lists = useApp((s) => s.data.lists);
  const theme = useApp((s) => s.data.settings.theme);
  const [bulkListMenu, setBulkListMenu] = useState(false);
  /** 窄屏（手机 / 把窗口拖窄）时侧栏收成抽屉，这里记它开没开 */
  const [drawer, setDrawer] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // B6：退场那一拍里这两条还得挂在树上，元素没了动画就无从播起。
  // 期间 .leaving 会把它们的 pointer-events 关掉，不会误点到正在消失的按钮
  const { shown: toastShown, leaving: toastLeaving } = useLeaving(toast);
  /** 顶上那条「没登录」提示要跟着登录态走，登录成功当场就该消失 */
  const session = useSync((s) => s.session);
  /** 这台设备上到底有没有登录过：**问过之前一律不显示**。
   *  syncCtl 里那个 session 是 initSync 异步填进去的，刚起来时必然是 null，
   *  照它判的话已经登录的人每次刷新都要先被那条提示晃一下 */
  const [webSessionKnown, setWebSessionKnown] = useState<boolean | null>(null);
  /** 网页版查到服务器上有新版了（桌面 / 安卓走 updater.ts 那条自己下包的路，跟这条无关）。
   *  **存在 store 里**：屏幕底下那个位置只站得下一条，手机上「把橡果放到桌面」也想站那儿，
   *  各存各的就谁也看不见谁，两条一起出现时叠成一团 */
  const webNewVersion = useApp((s) => s.webNewVersion);
  /** 写盘停手了（盘掉线 / 目录只读 / 磁盘满）。常驻一条提示，不给关，只给「重试」 */
  const saveError = useApp((s) => s.saveError);
  /** 开机正在从云端取回那份：先摆一块占位，别让人对着一本假的空账本干活 */
  const restoring = useSync((s) => s.restoring);
  const { shown: bulkShown, leaving: bulkLeaving } = useLeaving(
    selectedIds.length > 1 ? selectedIds : null,
  );

  // 网页版：没登录时顶上挂一条说清楚「这些事只在这台设备的浏览器里」。先问一次登录态
  useEffect(() => {
    if (!isWeb) return;
    void cloud
      .loadSession()
      .then((s) => setWebSessionKnown(!!s))
      .catch(() => setWebSessionKnown(false));
  }, []);

  // 网页版：隔一阵问一句服务器现在是哪一版，比手里这份新就说一声。
  // 加到主屏幕的那个窗口按 Home 键收起来、隔天再点开是**不重新加载**的，
  // 不提一句的话它能跑着上礼拜那份代码
  useEffect(() => {
    if (!isWebBuild) return;
    return startWebUpdateWatch({ onNewVersion: (v) => setWebNewVersion(v) });
  }, []);

  // toast 自动消散
  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(dismissToast, 4000);
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [toast]);

  // 屏蔽 WebView2 原生右键菜单（输入框里保留系统菜单，用户要粘贴）。
  // **只在 Tauri 里做**（v1.15.0）：这一句是为 WebView2 那个「刷新 / 后退 / 检查」菜单写的，
  // 搬到真浏览器里就把人家的刷新、后退、复制链接、在新标签页打开一起掐了——
  // 网页版用户右键一次什么都没有，第一反应是这页坏了
  useEffect(() => {
    if (!persist.inTauri) return;
    function onCtx(e: MouseEvent) {
      const el = e.target as HTMLElement | null;
      const editable = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (!editable) e.preventDefault();
    }
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  // 全局快捷键
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        // 计划视图里 Ctrl+F = 聚焦它自己那个搜索框（同一个动作只给一种界面）；
        // 别的视图照旧弹全局搜索浮层。看 DOM 而不看 view：搜索框只在计划的「列表」tab 下才挂着
        const planBox = document.querySelector<HTMLInputElement>(".plan-search input");
        if (planBox) {
          planBox.focus();
          planBox.select();
          return;
        }
        setSearchOpen(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !inEditable()) {
        e.preventDefault();
        undo();
        return;
      }
      // Ctrl+1 不再是切视图而是「记一条」（v1.11.2 随手记退场）：它原来就排在第一位，
      // 手指记得的还是那一下，换成弹窗对用户是同一个动作、少走一趟
      if (mod && e.key === "1") {
        e.preventDefault();
        setQuickAddOpen(true);
        return;
      }
      // Ctrl+2~5 = 侧栏常驻四项从上往下数（2026-09 跟着侧栏重排）：计划 / 日历 / 今日任务 / 习惯。
      // 这组键的意思就是「第几个」，顺序变了还按老对应，手指记的就跟眼睛看到的对不上
      if (mod && /^[2-5]$/.test(e.key)) {
        e.preventDefault();
        navigate((["plan", "calendar", "today", "habits"] as const)[Number(e.key) - 2]);
        return;
      }
      if (inEditable()) return;

      const ids = visibleTaskIds();
      const cur = selectedIds.length === 1 ? ids.indexOf(selectedIds[0]) : -1;
      if (e.key === "ArrowDown" && ids.length) {
        e.preventDefault();
        const next = ids[Math.min(cur + 1, ids.length - 1)];
        setSelection([next]);
        document.querySelector(`.task-row[data-task-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp" && ids.length) {
        e.preventDefault();
        const next = ids[Math.max(cur <= 0 ? 0 : cur - 1, 0)];
        setSelection([next]);
        document.querySelector(`.task-row[data-task-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && selectedIds.length === 1) {
        e.preventDefault();
        expandTask(selectedIds[0]);
      } else if (mod && e.key.toLowerCase() === "d" && selectedIds.length) {
        e.preventDefault();
        // 走 completeTasks 一次做完：一件一次的话撤销只撤得回最后一件
        completeTasks(selectedIds);
      } else if (mod && e.key === "ArrowRight" && selectedIds.length) {
        e.preventDefault();
        postponeTasks(selectedIds);
      } else if (
        !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        selectedIds.length === 1 && hasChain(selectedIds[0])
      ) {
        // ←收链 / →摊开（v1.9.1）。这两个键原本完全空着，零冲突：
        // mod+→ 是「顺延」，在上一条就被接走了，所以这里必须带 !mod 且排在它后面。
        // 摆状态不 toggle：连按 ← 应该一直收着。
        // hasChain 先把关：没子任务链的事一个字节都不该写进 foldExcept（那份落 localStorage）
        e.preventDefault();
        setChainFolded(selectedIds[0], e.key === "ArrowLeft");
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.length) {
        e.preventDefault();
        deleteTasks(selectedIds);
      } else if (e.key === "Escape") {
        setDrawer(false);
        clearSelection();
        expandTask(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedIds]);

  // 换了视图就把抽屉收起来——手机上点完一项还挡着半屏很烦
  useEffect(() => setDrawer(false), [view]);

  // 装了新版之后第一次打开：把更新日志摆出来，让人知道这一版改了什么。
  // **只在 upgrade 这一档弹**：第一次装橡果的人（install）什么都还没用过，
  // 迎面一屏版本历史毫无意义——那一刻该请他登录（判据见 core/fresh.shouldOfferLogin，
  // 登录框的界面另有人做）。同一版又开一次（same）当然也不弹。
  // 测试版照样弹：它在更新日志里有自己的第一块（比上一个正式版多了什么，见 core/changelog.ts）
  useEffect(() => {
    if (firstRun === "upgrade") setChangelogOpen(true);
  }, [firstRun]);

  // 第一次装橡果、还什么都没记过的那一刻，请人登录一次（判据全在 core/fresh.ts，纯函数、有单测）：
  // 没登录 + 本机是全新的 + 没点过「以后再说」，三件事同时成立才弹。
  // 记了一堆事的老用户不该被一个登录框拦在门口——那是把云账号从「可选的便利」变成进门收费站。
  //
  // 登录态**直接问 cloud.loadSession()**，不看 syncCtl 里那个 session：那一份是 initSync
  // 异步填进去的，应用刚起来时它必然还是 null，照它判会给已经登录的人也弹一次
  const loginOffered = useRef(false);
  useEffect(() => {
    if (!loaded || loadError || loginOffered.current) return;
    loginOffered.current = true;
    void cloud
      .loadSession()
      .then((session) => {
        const s = appStore.getState();
        // 「找回数据」那一屏正等着用户拍板：那件事比登录要紧，别在它上面再压一层
        if (s.rescue) return;
        const offer = shouldOfferLogin({
          signedIn: !!session,
          pristine: isPristineLocal({ data: s.data, everSynced: !!session?.syncedAt }),
          later: isLoginLater(),
        });
        // 网页版**不拦登录墙**（v1.15.0，用户拍板）：打开就能记事，东西先存在这个浏览器里，
        // 哪天登录了自动并进云端。代价（清缓存 / 换设备就没了）由顶上那条提示条如实说，
        // 不靠一扇迎面挡住的门来说
        if (offer && !isWeb) openLogin("first-run");
      })
      .catch(() => {
        /* 读不出登录态就当这次别问了：宁可少问一次，也不能给已登录的人弹一个登录框 */
      });
  }, [loaded, loadError]);

  // key 是给 B3 用的：清单/需求方/标签共用 ListView 这一个组件，
  // 不给 key 的话它们之间来回切属于「同一个组件换了个 prop」，.view-body 不重挂，淡入就不播。
  // 光用 view 还不够：清单 A → 清单 B 的 view 一直是 "list"，需求方和标签同理，
  // （随手记原来也在这一串里，桌面上 v1.11.2 撤了）
  // 结果侧栏上半截切过去有淡入、条目最多的下半截一律没有——一半有一半没有比全都没有更像坏了。
  // 所以 key 带上具体目标。这会连带把该视图内部的 state 与滚动位置一起重置，
  // 切清单时这正是想要的；ListView 自己没有跨清单要保留的 state（清单名那个框已自带 key={list.id}）
  const bodyKey = `${view}:${listId ?? whoFilter ?? tagFilter ?? ""}`;
  const body = useMemo(() => {
    switch (view) {
      case "today": return <Today key={bodyKey} />;
      // 桌面上「随手记」这个视图 v1.11.2 撤了（记录那半边成了「＋ 记一条」弹窗），
      // 但 ViewId 一个字没删：老设置里存着 "inbox" 的照样得开得起来，落到「计划」上。
      // 手机那边这一页还在（「更多」里进得去），跟四象限同一个写法各走各的
      case "inbox": return isMobile ? <ListView key={bodyKey} kind="inbox" /> : <Plan key={bodyKey} />;
      case "plan": return <Plan key={bodyKey} />;
      // 四象限只在手机上是一页；桌面上它是「计划」里的一个 tab，路由到这儿就等于计划
      case "quadrant": return isMobile ? <Quadrant key={bodyKey} /> : <Plan key={bodyKey} />;
      case "done": return <Done key={bodyKey} />;
      case "list": return <ListView key={bodyKey} kind="list" />;
      case "who": return <ListView key={bodyKey} kind="who" />;
      case "tag": return <ListView key={bodyKey} kind="tag" />;
      case "habits": return <Habits key={bodyKey} />;
      case "trash": return <ListView key={bodyKey} kind="trash" />;
      case "calendar": return <Calendar key={bodyKey} />;
      case "focus": return <FocusView key={bodyKey} />;
      case "stats": return <StatsView key={bodyKey} />;
      case "settings": return <Settings key={bodyKey} />;
    }
  }, [view, bodyKey]);

  if (!loaded) {
    return <div className="center-note"><span className="big">橡果</span>正在读取数据…</div>;
  }
  if (loadError) return <DataErrorScreen error={loadError} />;
  // 这台设备上还没有账本、而这个账号云端有东西：开机这一轮正在把它取回来。
  // 那是一个网络往返加一整份账本，手机上可能要好几秒——这几秒里界面**不能**摆一本空账本
  // 让人对着它开始记，取回一落地就是整份覆盖，刚记的当着面就没了（撤销也撤不回来）
  if (restoring) {
    return (
      <div className="center-note">
        <span className="big">橡果</span>
        正在把你在云端的那份取回这台设备…
      </div>
    );
  }

  // 这份数据由更新版本的橡果写入：**照常渲染整个应用**，弹一次「已有更新版橡果」的框，
  // 给「现在更新 / 取消」两条路，取消了照常用（用户 2026-09-01 定的口径）。
  // 以前这里是一整屏墙，用户连自己的任务都看不见——那是拒绝加载，是产品原则上的错
  /** 顶上那条提示到底挂不挂：跑在浏览器里 + 问过了 + 确实没登录，三条都成立才挂。
   *  登录之后 session 立刻有值，这一条当场收掉 */
  const webNote = isWeb && webSessionKnown === false && !session;

  const schemaNotice =
    dataFromNewer !== null && noticeClosed !== dataFromNewer.schema ? dataFromNewer.schema : null;

  return (
    <div
      className={`shell${drawer ? " drawer-open" : ""}${isMobile ? " mobile" : ""}${
        webNote ? " web-note-on" : ""
      }`}
    >
      {/* 网页版没登录时顶上那一条（v1.15.0）。**这不是可关的小提示，是这一端的实情**：
          东西存在这个浏览器里，清了缓存、换台设备就没了，苹果还会把长期不开的网站数据清掉。
          登录之后它自己消失（本地这些事会自动并进云端，fresh + merge 那条路早就跑通了）。
          外面那个 web-note-on 负责把整个界面往下让出这一条的高度，见 base.css */}
      {webNote && (
        <div className="web-note">
          <span className="web-note-txt">没登录，这些事只存在这台设备的浏览器里</span>
          <button className="web-note-btn" onClick={() => openLogin("manual")}>登录</button>
        </div>
      )}
      {/* 主题风景水印只在桌面贴主区底部。手机上这一幅要撤掉：
          它 fixed 在屏幕底部、高 137px，而底部导航只有 60px——画里那颗太阳正好从
          导航条上沿露出小半个淡圆来（实测 390×844：风景 708→844，导航 784→844，
          露在外面 76px）。PM 第一眼就看见了那个「幽灵圆」。
          手机上这片风景改挂在顶栏后面（mobile/MobileHead 的 .mhead-scene），那才是它该在的地方 */}
      {/* 🔴 写盘停手了。**不给关、也不会自己消失**（v1.15.0）：
          数据文件夹这会儿写不进去（随身盘没接上、网盘锁着、磁盘满），而界面上这份很可能
          根本不是用户的账本——盘没挂上时橡果读不到文件，长得跟第一次打开一模一样。
          再继续自动保存，盘一接回来就把这本空账本盖在真账本上。所以：停手 + 一直说着，
          直到用户点「重试」真的存回去为止 */}
      {saveError && <SaveHaltBar error={saveError} top={webNote} />}
      {!isMobile && <ThemeScene theme={theme} />}
      {/* 手机上侧栏整套不上树：那儿走底部五格导航（MobileShell）。
          **抽屉那一套一个字没删**——桌面把窗口拖窄仍然是桌面，它还得靠 ☰ 拉开侧栏 */}
      {!isMobile && (
        <>
          {/* 窄屏才出现：点开左边的抽屉。宽屏由 CSS 藏起来 */}
          <button className="drawer-btn" title="菜单" onClick={() => setDrawer(true)}>☰</button>
          <Sidebar drawerOpen={drawer} onNavigate={() => setDrawer(false)} />
          {/* 侧栏右边缘的宽度把手（拖动改宽、双击恢复）。窄屏抽屉模式由 CSS 藏掉 */}
          <SideGrip />
          {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} />}
        </>
      )}
      {isMobile ? <MobileShell>{body}</MobileShell> : body}
      {/* 主区右上角那颗头像 + 账号小面板，桌面各页共用这一颗（手机的在「今天」顶栏里） */}
      {!isMobile && <AccountCorner />}

      {/* 手机端那四张纸：任务详情 / 记一条 / 长按的动作单 / 清单设置。
          都读同一个抽屉栈（mobile/sheetStore），谁在栈顶谁开 */}
      {isMobile && (
        <>
          <TaskSheetHost />
          <QuickAddSheetHost />
          <ActionSheetHost />
          <ListSettingsSheetHost />
          <HabitSheetHost />
          <GuideSheetHost />
          <AccountSheetHost />
          <PostponeSheetHost />
        </>
      )}
      {/* 登录页两端都挂：手机上盖满一整页，桌面上是居中弹窗 */}
      <LoginPageHost />

      <DataRescue />
      {/* 排在 DataRescue 后面：两个都在时由 UpdateDialog 自己让位（见组件里那段判断） */}
      <UpdateDialog />
      {schemaNotice !== null && (
        <NewerDataDialog schema={schemaNotice} onClose={() => setNoticeClosed(schemaNotice)} />
      )}
      {changelogOpen && <ChangelogDialog />}
      {/* 「记一条」弹窗只在桌面：手机上那个动作是右下角的 ＋（QuickAddSheet） */}
      {!isMobile && quickAddOpen && <QuickAddDialog />}
      {paletteOpen && <CommandPalette />}
      {searchOpen && <SearchOverlay />}
      <ContextMenu />

      {/* B6：这两条以前都是「啪一下没了」。useLeaving 让它们比状态多活一拍，把退场演完 */}
      {toastShown && (
        <div className={`toast${toastLeaving ? " leaving" : ""}`} key={toastShown.key}>
          {toastShown.msg}
          {toastShown.undoable && <button onClick={() => { undo(); dismissToast(); }}>撤销</button>}
        </div>
      )}

      {/* 网页版有新代码了。借撤销 toast 那身皮，但**不会自己消失**——刷新是用户的事，
          不该错过一眼就没了。撤销 toast 在时先让一让：两个抢同一个位置，会叠在一起 */}
      {webNewVersion && !toastShown && (
        <div className="toast">
          橡果有新版了（v{webNewVersion}）
          <button onClick={reloadForUpdate}>刷新</button>
        </div>
      )}

      {bulkShown && (
        <div className={`bulk-bar${bulkLeaving ? " leaving" : ""}`}>
          <span className="cnt">{bulkShown.length}</span> 项已选
          {/* 原来是「推到明天」，只能推一天；现在点开选哪天。多选是按「件」选的，
              推的是看得见的那几行：有过期子任务的推那几条子任务，其余推母任务（store.postponeRowsForTasks）。
              Ctrl+→ 照旧是原日期加一天 */}
          <PostponeButton
            className="btn ghost"
            label="顺延"
            getRows={() => {
              const ids = appStore.getState().ui.selectedIds;
              return postponeRowsForTasks(
                appStore.getState().data.tasks.filter((t) => ids.includes(t.id) && !t.deletedAt),
              );
            }}
          />
          <span style={{ position: "relative" }}>
            <button className="btn ghost" onClick={() => setBulkListMenu(!bulkListMenu)}>移到清单</button>
            {bulkListMenu && (
              <div className="popmenu" style={{ bottom: "130%", left: 0 }}>
                <button className="item" onClick={() => { setTasksList(selectedIds, null); setBulkListMenu(false); }}>移出清单</button>
                {lists.map((l) => (
                  <button key={l.id} className="item" onClick={() => { setTasksList(selectedIds, l.id); setBulkListMenu(false); }}>
                    <span style={{ width: 7, height: 7, borderRadius: 99, background: `var(--list-${l.color})`, display: "inline-block" }} />
                    {l.name}
                  </button>
                ))}
              </div>
            )}
          </span>
          <button className="btn danger" onClick={() => deleteTasks(selectedIds)}>删除</button>
          <button className="btn ghost" onClick={clearSelection}>取消</button>
        </div>
      )}
    </div>
  );
}

// ---------- 「存不回去，已经停手」那一条 ----------

/**
 * 写盘失败时那条**常驻**提示。
 *
 * 为什么不是 toast：toast 四秒就没了，而「橡果已经停止保存」这件事得一直摆在眼前——
 * 用户在这期间记的每一条都只在内存里，关掉窗口就没了，这不是说一句就算完的事。
 *
 * 为什么必须停止保存（本体那台机器的真实用法）：数据文件夹在一块随身盘上。
 * 盘没挂上就打开橡果，读不到文件跟「第一次打开」长得一模一样，界面上是一本空账本；
 * 盘一接回来，随便哪一次自动保存都会把这本空账本盖在真账本上，旧文件被改名再删掉，
 * 当天的备份也没生成。所以出事之后一个字都不写，等用户把盘接上、点一下「重试」。
 */
function SaveHaltBar({ error, top }: { error: string; top: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        // 网页版顶上那条「没登录」也占着最上面一行，别叠上去
        top: top ? "calc(var(--web-note-h) + 10px + env(safe-area-inset-top, 0px))" : "calc(10px + env(safe-area-inset-top, 0px))",
        left: "50%", transform: "translateX(-50%)",
        zIndex: 300, maxWidth: "min(560px, calc(100vw - 24px))",
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        padding: "9px 14px", borderRadius: "var(--r-md)",
        background: "var(--card)", color: "var(--ink)",
        border: "1px solid var(--warn)", boxShadow: "var(--shadow)",
        fontSize: "var(--fs-sm)", lineHeight: 1.6,
      }}
    >
      <span>
        <b style={{ color: "var(--warn)" }}>数据暂时存不回文件夹，已经停止保存</b>
        ，免得把空的那份盖到你的数据上。接上硬盘或腾出空间后点「重试」；在这之前记的东西只在窗口里。
        <span style={{ color: "var(--ink-2)" }}>（{error}）</span>
        {failed && <span style={{ color: "var(--warn)" }}> 还是存不回去，再试试。</span>}
      </span>
      <button
        className="btn primary"
        style={{ flex: "none" }}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          void retrySave()
            .then((ok) => setFailed(!ok))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "正在重试…" : "重试"}
      </button>
    </div>
  );
}

// ---------- 「数据打不开」那一屏 ----------

/** 一行：一颗按钮 + 一句「点了会发生什么」。按钮等宽，六行才排得齐 */
// 窄窗口（手机、桌面把窗口拖窄）上让说明那半句换行落到按钮下面去，
// 不换行的话 136px 的按钮加一句话在 390px 宽的屏上必然撑破边
const DE_ROW: CSSProperties = { display: "flex", gap: 12, alignItems: "center", textAlign: "left", flexWrap: "wrap" };
const DE_BTN: CSSProperties = { minWidth: 136, flex: "none" };
const DE_SAY: CSSProperties = { color: "var(--ink-2)", fontSize: "var(--fs-sm)", lineHeight: 1.6 };

/**
 * 数据读不出来时看到的那一屏。
 *
 * **这一屏必须自带出路。** 程序画它之前就提前 return 了：侧栏、设置页、更新弹窗、登录窗
 * 一个都没上树，所以任何「去设置里…」的按钮在这儿都是死的——v1.8.0 到 v1.14.3 那颗
 * 「打开设置」就是这么一颗死按钮，它只把「我想去设置」记进 state，没有任何东西会读它。
 * 用户于是卡在这一屏上：换不了文件夹、登不出也登不回、更不了新，只能把整个软件关掉，
 * 下次打开还是它（2026-09-14 用户原话：「陷入死循环」）。
 *
 * 所以这里的规矩是：**能做的事就地摆出来，一件都不往别处转。**
 */
function DataErrorScreen({ error }: { error: string }) {
  const session = useSync((s) => s.session);
  /** 内存里还有没有东西值得导出。读失败时内存里通常是一本空账本，那就没什么可存的 */
  const hasTasks = useApp((s) => s.data.tasks.length > 0);
  const [dir, setDir] = useState<string | null>(null);
  const [busy, setBusy] = useState<"find" | "dir" | "out" | "off" | null>(null);
  /** 刚才那一下的回话。只留一句，说完就停在那儿，不做成会自己消失的 toast——
   *  这一屏上没有别的东西会动，消失的提示等于没说过 */
  const [said, setSaid] = useState<string | null>(null);

  // 用户最需要的一条线索：橡果到底在哪儿找他的账本。报错原文里几乎从来没有这个路径，
  // 他看着「数据打不开」根本不知道该去哪个文件夹找
  useEffect(() => {
    let alive = true;
    void persist
      .getDataDir()
      .then((d) => alive && setDir(d))
      .catch(() => alive && setDir(null));
    return () => {
      alive = false;
    };
  }, []);

  /** 去别处找找。找到了就把现成的那张选择卡就地挂出来（这一屏上也挂着 DataRescue） */
  async function findData() {
    setBusy("find");
    setSaid(null);
    try {
      const found = (await persist.findDataCandidates()).filter((c) => c.tasks > 0);
      if (found.length) appStore.setState({ rescue: found });
      // 指路只能指向这台设备上真有的那颗按钮：安卓上没有「换个文件夹」，
      // 照着说就是把人往一颗不存在的按钮上引
      else if (isDesktopShell) {
        setSaid("常放数据的那几个位置都找过了，没找到别的账本。可以用下面的「换个文件夹」直接指给橡果。");
      } else {
        setSaid("常放数据的那几个位置都找过了，没找到别的账本。");
      }
    } catch (e) {
      setSaid(`找的时候出错了：${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  /** 换个文件夹。跟设置 → 数据 → 更换文件夹是同一套动作：选文件夹 → 改指针 → 重开 */
  async function changeDir() {
    setBusy("dir");
    setSaid(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true });
      if (typeof picked !== "string") return;
      await persist.setDataDir(picked); // 目标已有数据时不会被覆盖，只改指针
      location.reload();
    } catch (e) {
      setSaid(`换不过去：${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  /** 退出登录。**只断登录态，一个字数据都不碰**——这一屏上连数据都读不出来，
   *  「退出并清空本机」那条路更不能走（它要先过 checkWipeGate，而闸门在这儿必然不通） */
  async function doSignOut() {
    setBusy("off");
    setSaid(null);
    try {
      await signOut();
      setSaid("已退出登录。这台设备上的数据一个字都没动；文件夹恢复正常之后重开橡果，就能重新登录。");
    } catch (e) {
      setSaid(`退不出去：${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  /** 保险：把内存里这份存成 JSON。只在内存里确实还有东西时才给这颗按钮 */
  async function exportJson() {
    setBusy("out");
    setSaid(null);
    try {
      // 浏览器里没有「保存到哪个路径」这回事，只有下载（跟设置页导出那条同一个口径）
      if (isWeb) {
        persist.downloadTextFile(
          `acorn-${todayYMD()}.json`,
          toJsonFile(appStore.getState().data, APP_VERSION),
        );
        setSaid("已经下载下来了。这份文件用「设置 → 导出与导入」能再读回来。");
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `acorn-${todayYMD()}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await persist.writeTextFile(path, toJsonFile(appStore.getState().data, APP_VERSION));
      setSaid("已存好。这份文件用「设置 → 导出与导入」能再读回来。");
    } catch (e) {
      setSaid(`存不下来：${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    // 这一屏比原来那两行字高得多：小窗口上得能滚，也得留出左右两边的边距，
    // 否则最要紧的那条路径会贴到屏幕边上
    <div className="center-note" style={{ overflowY: "auto", padding: "24px 16px" }}>
      <span className="big">数据打不开</span>
      <p style={{ maxWidth: 540, textAlign: "center", lineHeight: 1.7, margin: 0 }}>
        {isWeb ? (
          <>
            橡果没能读出存在这个浏览器里的那份数据。<b>先别清浏览器缓存</b>，
            下面这几条路可以试试。
          </>
        ) : (
          <>
            橡果没能读到这台设备上的账本文件。<b>你记的事没有丢</b>，
            它们还在下面这个文件夹里，只是橡果这会儿读不到。
          </>
        )}
      </p>

      {/* 路径摆在最前面：这是他最需要的一条线索。
          网页版没有「文件夹」这回事，getDataDir() 在那边给回的是一句「存在这台设备的浏览器里」——
          接在「橡果正在这个文件夹里找：」后面就成了病句，所以这行提示两端各说各的 */}
      <div
        style={{
          maxWidth: 540, width: "100%", textAlign: "left", lineHeight: 1.7,
          background: "var(--paper-2, transparent)", borderRadius: 8,
        }}
      >
        <div style={DE_SAY}>{isWeb ? "这些事存在哪儿：" : "橡果正在这个文件夹里找："}</div>
        <div style={{ wordBreak: "break-all", color: "var(--ink)" }}>{dir ?? "（正在确认…）"}</div>
        <div style={{ ...DE_SAY, marginTop: 6 }}>读不到的原因：{error}</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 540, width: "100%" }}>
        <div style={DE_ROW}>
          <button className="btn primary" style={DE_BTN} onClick={() => location.reload()}>重试</button>
          <span style={DE_SAY}>
            {isWeb ? "刷新一次再看看，多半是这一次没读上来。" : "数据放在移动硬盘或网盘上的话，接上再点这里。"}
          </span>
        </div>
        {/* 「去别处找找」翻的是这台机器上的文件夹：浏览器里压根没有文件夹可翻
            （findDataCandidates 在那边恒返回空），摆出来就是一颗按了什么都不会发生的按钮 */}
        {persist.inTauri && (
          <div style={DE_ROW}>
            <button className="btn" style={DE_BTN} disabled={busy === "find"} onClick={() => void findData()}>
              {busy === "find" ? "正在找…" : "去别处找找我的数据"}
            </button>
            <span style={DE_SAY}>到常放数据的几个位置翻一遍，找到了摆出来给你挑。</span>
          </div>
        )}
        {/* 「换个文件夹」只有装在电脑上的橡果做得到：安卓上没有文件夹选择器，
            浏览器里连 invoke 都不存在（按下去只会当场抛一句 TypeError 给用户看） */}
        {isDesktopShell && (
          <div style={DE_ROW}>
            <button className="btn" style={DE_BTN} disabled={busy === "dir"} onClick={() => void changeDir()}>
              换个文件夹
            </button>
            <span style={DE_SAY}>自己指一个文件夹给橡果，指完橡果重开一次。</span>
          </div>
        )}
        {/* 现成的那颗「检查更新」：查到了把更新弹窗顶出来，下载安装还是走那一套。
            这一屏上 UpdateDialog 也挂着，不然查到了也弹不出来。
            网页版没有包可下（UpdateNudge 自己会返回 null），那就连这一行说明也别摆——
            剩一句没有按钮的话挂在那儿，跟一颗死按钮一样让人干瞪眼 */}
        {updaterSupported && (
          <div style={DE_ROW}>
            <span style={{ ...DE_BTN, display: "inline-flex", gap: 8, alignItems: "center" }}>
              <UpdateNudge />
            </span>
            <span style={DE_SAY}>新版本可能已经修好了这个毛病。</span>
          </div>
        )}
        {session && (
          <div style={DE_ROW}>
            <button className="btn" style={DE_BTN} disabled={busy === "off"} onClick={() => void doSignOut()}>
              退出登录
            </button>
            <span style={DE_SAY}>只断开 {session.email} 这个账号，本机数据一个字都不动。</span>
          </div>
        )}
        {/* canSaveFile：安卓上给不出文件（save() 回的是 content:// URI，写不了），
            按下去只有一句「存不下来」。这一屏的立意就是一颗死按钮都不留 */}
        {hasTasks && canSaveFile && (
          <div style={DE_ROW}>
            <button className="btn ghost" style={DE_BTN} disabled={busy === "out"} onClick={() => void exportJson()}>
              导出一份 JSON
            </button>
            <span style={DE_SAY}>把橡果这会儿手里有的内容另存一份，留个底。</span>
          </div>
        )}
      </div>

      {said && <div style={{ maxWidth: 540, textAlign: "left", lineHeight: 1.7 }}>{said}</div>}

      {/* 「找到了以前的数据」那张选择卡：以前它只挂在正常界面里，出错屏上根本挂不出来，
          于是「去别处找找」这条路在最需要它的地方反而没有 */}
      <DataRescue />
      <UpdateDialog />
    </div>
  );
}
