// 主窗外壳：侧栏 + 视图路由 + 全局快捷键 + 撤销 toast + 批量操作条。
import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
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
import UpdateDialog from "./components/UpdateDialog";
import NewerDataDialog from "./components/NewerDataDialog";
import ChangelogDialog from "./components/ChangelogDialog";
import QuickAddDialog from "./components/QuickAddDialog";
import { useLeaving } from "./components/motion";
import {
  appStore, clearSelection, completeTasks, deleteTasks, dismissToast, expandTask,
  hasChain, navigate, postponeTasks, setChainFolded, setChangelogOpen, setPaletteOpen,
  setQuickAddOpen, setSearchOpen, setSelection, setTasksList, undo, useApp,
} from "./core/store";
import { useUpdate } from "./core/updateCtl";
import { isMobile } from "./core/platform";
import { isLoginLater, isPristineLocal, shouldOfferLogin } from "./core/fresh";
import * as cloud from "./core/cloud";
// 手机端（v1.11.0）：壳子 + 四张从底下抽出来的纸。桌面上这几个一个都不挂
import MobileShell from "./mobile/MobileShell";
import { TaskSheetHost } from "./mobile/TaskSheet";
import { QuickAddSheetHost } from "./mobile/QuickAddSheet";
import { ActionSheetHost } from "./mobile/ActionSheet";
import { ListSettingsSheetHost } from "./mobile/ListSettingsSheet";
import { HabitSheetHost } from "./mobile/HabitSheet";
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
  const { shown: bulkShown, leaving: bulkLeaving } = useLeaving(
    selectedIds.length > 1 ? selectedIds : null,
  );

  // toast 自动消散
  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(dismissToast, 4000);
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [toast]);

  // 屏蔽 WebView2 原生右键菜单（输入框里保留系统菜单，用户要粘贴）
  useEffect(() => {
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
      if (mod && /^[2-5]$/.test(e.key)) {
        e.preventDefault();
        navigate((["today", "habits", "plan", "done"] as const)[Number(e.key) - 2]);
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
  // 登录框的界面另有人做）。同一版又开一次（same）当然也不弹
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
        if (offer) openLogin("first-run");
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
  if (loadError) {
    return (
      <div className="center-note">
        <span className="big">数据打不开</span>
        <span>{loadError}</span>
        <span>数据文件夹当前不可用。数据若放在移动硬盘或网盘上，连接后点重试；也可以到设置里更换文件夹。</span>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn primary" onClick={() => location.reload()}>重试</button>
          <button className="btn" onClick={() => navigate("settings")}>打开设置</button>
        </div>
      </div>
    );
  }

  // 这份数据由更新版本的橡果写入：**照常渲染整个应用**，弹一次「已有更新版橡果」的框，
  // 给「现在更新 / 取消」两条路，取消了照常用（用户 2026-09-01 定的口径）。
  // 以前这里是一整屏墙，用户连自己的任务都看不见——那是拒绝加载，是产品原则上的错
  const schemaNotice =
    dataFromNewer !== null && noticeClosed !== dataFromNewer.schema ? dataFromNewer.schema : null;

  return (
    <div className={`shell${drawer ? " drawer-open" : ""}${isMobile ? " mobile" : ""}`}>
      {/* 主题风景水印只在桌面贴主区底部。手机上这一幅要撤掉：
          它 fixed 在屏幕底部、高 137px，而底部导航只有 60px——画里那颗太阳正好从
          导航条上沿露出小半个淡圆来（实测 390×844：风景 708→844，导航 784→844，
          露在外面 76px）。PM 第一眼就看见了那个「幽灵圆」。
          手机上这片风景改挂在顶栏后面（mobile/MobileHead 的 .mhead-scene），那才是它该在的地方 */}
      {!isMobile && <ThemeScene theme={theme} />}
      {/* 手机上侧栏整套不上树：那儿走底部五格导航（MobileShell）。
          **抽屉那一套一个字没删**——桌面把窗口拖窄仍然是桌面，它还得靠 ☰ 拉开侧栏 */}
      {!isMobile && (
        <>
          {/* 窄屏才出现：点开左边的抽屉。宽屏由 CSS 藏起来 */}
          <button className="drawer-btn" title="菜单" onClick={() => setDrawer(true)}>☰</button>
          <Sidebar drawerOpen={drawer} onNavigate={() => setDrawer(false)} />
          {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} />}
        </>
      )}
      {isMobile ? <MobileShell>{body}</MobileShell> : body}

      {/* 手机端那四张纸：任务详情 / 记一条 / 长按的动作单 / 清单设置。
          都读同一个抽屉栈（mobile/sheetStore），谁在栈顶谁开 */}
      {isMobile && (
        <>
          <TaskSheetHost />
          <QuickAddSheetHost />
          <ActionSheetHost />
          <ListSettingsSheetHost />
          <HabitSheetHost />
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

      {bulkShown && (
        <div className={`bulk-bar${bulkLeaving ? " leaving" : ""}`}>
          <span className="cnt">{bulkShown.length}</span> 项已选
          <button className="btn ghost" onClick={() => postponeTasks(selectedIds)}>推到明天</button>
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
