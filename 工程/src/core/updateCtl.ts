// 更新的调度层：开机自动查一次，以及「下载 → 安装」这段共用的状态机。
//
// 分成两块是为了别再各写一份：设置页的 UpdatePanel 和开机弹的 UpdateDialog
// 走的是同一个 useUpdateRun，哪天下载或安装的逻辑改了，两处一起改到。
//
// 底线跟同步一样：**查更新绝不能挡住启动**。调用方一律 void 不 await，
// 没网就报一条小消息，本地照常用。

import { useCallback, useEffect, useRef, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { showToast } from "./store";
import { todayYMD } from "./dates";
import { APP_VERSION } from "./model";
import { isAndroid } from "./platform";
import {
  compareVersions, downloadPackage, fetchUpdate, installFailureSay, installPackage, installStatusText, installWhy,
  isCancelled, lastInstallVia, shouldOffer, updaterSupported, watchInstallResult,
  type InstallOutcome, type UpdateInfo,
} from "./updater";

/**
 * 上一次**查成功**的结果（v1.10.0）。更新日志弹窗顶上那个「检查新版本」按钮靠它：
 * 今天已经查过、而且是最新，就不再给按钮，换成一个绿勾「你用的已经是最新版本」（用户点名）。
 * 只记查成功的；查失败不记——失败不是「已知状态」，下次进来还该让人能再查。
 */
export interface CheckMemo {
  /** 查的那天，YYYY-MM-DD */
  date: string;
  result: "latest" | "found";
  /** latest 时是本机版本，found 时是服务器上那个新版本 */
  version: string;
}

/** 这一次查版本的结果。跟 CheckMemo 的分工：memo 是**跨启动**记着的（「今天查过了」），
 *  这个只活在本次会话里，专门喂侧栏那行小字——用户新装完打开，得当场看见
 *  「查过了，已是最新」或者「没查着」，而不是一片安静
 *  （2026-09-02 用户原话：「下载后没有检查更新的消息框」） */
export type CheckOutcome =
  | { kind: "latest" }
  | { kind: "found"; version: string }
  | { kind: "failed" };

/** 这一次启动，是不是这个版本第一次跑。
 *  · install = 这台设备**第一次**打开橡果（localStorage 里连上次版本号都没有）
 *  · upgrade = 装了新版之后第一次打开
 *  · same    = 同一个版本又开了一次（绝大多数情况） */
export type FirstRun = "install" | "upgrade" | "same";

interface UpdateStore {
  /** 开机查到的新版本，还没被打发走。null = 不弹 */
  pending: UpdateInfo | null;
  /** 上一次查成功的结果；null = 从没查成功过 */
  memo: CheckMemo | null;
  /** 本次会话查版本的结果；null = 还没查过（或这台设备根本没有更新能力） */
  lastCheck: CheckOutcome | null;
  /** 最近一次查到的那个新版本。「有新版本 vX」那行字点得动，靠它把 UpdateDialog 顶出来——
   *  pending 会被「稍后再说」「这一版不再提醒」清掉，清掉之后那行字就没东西可点了 */
  found: UpdateInfo | null;
  /** 这次启动是这个版本第一次跑吗 */
  firstRun: FirstRun;
  /** 这次启动之前，这台设备上装的是哪一版（没装过 / 读不到就是 null）。
   *  跨版本升级时更新日志要靠它决定「哪几版是这次一起装上的」——
   *  main.tsx 的 rememberLaunch() 一跑就会把 localStorage 里那个值改成当前版本，
   *  所以只能在模块初始化这一刻读一次存下来 */
  prevVersion: string | null;
}

const MEMO_KEY = "acorn-update-last-check";
/** 上一次启动时的版本号。**只用来判「这一版第一次开」**，不参与任何更新决策 */
const LAUNCH_KEY = "acorn-last-version";

function loadMemo(): CheckMemo | null {
  try {
    const raw = localStorage.getItem(MEMO_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<CheckMemo>;
    if (typeof m.date !== "string" || typeof m.version !== "string") return null;
    if (m.result !== "latest" && m.result !== "found") return null;
    return { date: m.date, result: m.result, version: m.version };
  } catch {
    return null; // 存的东西坏了就当没查过，让人能再查一次
  }
}

/**
 * 「这一版第一次开」的判据。纯函数，三个分支各有用例钉着。
 *
 * 为什么要它：装完新版打开，用户该看见这一版做了什么（更新日志）；
 * 而**第一次装橡果**的人不该被更新日志迎面糊一脸——他还什么都没用过，
 * 那一刻该请他登录（见 fresh.shouldOfferLogin），不是给他念版本历史。
 */
export function firstRunKind(stored: string | null, current: string): FirstRun {
  if (stored === null || stored === "") return "install";
  return stored === current ? "same" : "upgrade";
}

/** 上次启动记下的版本号；没有（或读不了）就是 null */
export function readLastVersion(): string | null {
  try {
    return localStorage.getItem(LAUNCH_KEY);
  } catch {
    return null;
  }
}

/** 把这一次的版本号写回去。**由 main.tsx 在启动流程里调一次**，
 *  不放在模块初始化里：模块一被 import 就写，测试和别的入口都会误伤它 */
export function rememberLaunch(version: string = APP_VERSION): void {
  try {
    localStorage.setItem(LAUNCH_KEY, version);
  } catch {
    /* 记不住只是下次开机多弹一次更新日志，不值得为它出错 */
  }
}

export const updateStore = createStore<UpdateStore>(() => ({
  pending: null,
  memo: loadMemo(),
  lastCheck: null,
  found: null,
  // 在模块初始化时**只读不写**就算出来：App 第一次渲染就要问它，
  // 等到启动流程跑到某一步再算，那一帧已经过去了
  firstRun: firstRunKind(readLastVersion(), APP_VERSION),
  prevVersion: readLastVersion(),
}));

/** 更新日志里「这次一起装上的」是哪几版：比 prev 新的全算（不止最新那一条）。
 *  用户 2026-09-09 提的：他电脑停在 v1.14.0，一次升到 v1.14.2，
 *  而弹窗只讲最新那一版（讲的还是手机上的事），中间那版给他做的改动全被折叠起来了。
 *  prev 为空（头一次装）或只有一条时，退回原来的样子：主卡一条、其余折叠。 */
export function entriesSince<T extends { version: string }>(list: T[], prev: string | null): T[] {
  if (!prev) return list.slice(0, 1);
  const fresh = list.filter((e) => compareVersions(e.version, prev) > 0);
  return fresh.length > 0 ? fresh : list.slice(0, 1);
}

/** 记下这次查成功的结果。开机那次和手动那次都走这里，两处口径一致 */
export function rememberCheck(result: CheckMemo["result"], version: string, today: string = todayYMD()): void {
  const memo: CheckMemo = { date: today, result, version };
  try {
    localStorage.setItem(MEMO_KEY, JSON.stringify(memo));
  } catch {
    /* 记不住只是下次多按一下按钮 */
  }
  updateStore.setState({ memo });
}

/** 今天查成功过的话给那条记录，没有就 null。跨天就算过期——版本一天一发也不稀奇 */
export function checkedToday(memo: CheckMemo | null, today: string = todayYMD()): CheckMemo | null {
  return memo && memo.date === today ? memo : null;
}

export function useUpdate<T>(selector: (s: UpdateStore) => T): T {
  return useStore(updateStore, selector);
}

/** 用户说「这一版不再提醒」时记下的版本号。按版本记，下一版照样弹 */
const SKIP_KEY = "acorn-update-skip";

export function skippedVersion(): string {
  try {
    return localStorage.getItem(SKIP_KEY) ?? "";
  } catch {
    return ""; // 存不了偏好只是少个便利，不能让它挡住更新提示
  }
}

/** 这一版不再提醒。只记版本号，不记「永远别提醒我」——那样用户会永远停在老版本上 */
export function skipVersion(version: string): void {
  try {
    localStorage.setItem(SKIP_KEY, version);
  } catch {
    /* 记不住就下次再弹一遍，比弹不出来强 */
  }
  updateStore.setState({ pending: null });
}

/** 这次先不弹了，下次开机还会问 */
export function dismissUpdate(): void {
  updateStore.setState({ pending: null });
}

/** 按用户原话写的那条小消息。注意是 toast 不是弹窗——查不到更新不值得占一整块屏 */
export const CHECK_FAILED_MSG = "版本更新检测失败，请检查网络连接";

/**
 * 开机自动查一次。
 *
 * **只在 main.tsx 里调**：quickadd.html / focus.html 是各自独立的 webview 入口，
 * 放进它们共享的模块会变成一次开机查三遍。
 */
export async function checkUpdateOnBoot(): Promise<void> {
  if (!updaterSupported) return;
  const res = await fetchUpdate();
  if (!res.ok) {
    showToast(CHECK_FAILED_MSG, false);
    updateStore.setState({ lastCheck: { kind: "failed" } });
    return;
  }
  const info = res.info;
  if (!info || !shouldOffer(info)) {
    rememberCheck("latest", APP_VERSION);
    // 「已经是最新」以前是**完全安静**的，用户新装完打开，看不出橡果到底查没查过
    // （2026-09-02 反馈：「下载后没有检查更新的消息框」）。不弹框不弹 toast——
    // 一切正常不值得占一整块屏，只把结果落到侧栏那行小字上
    updateStore.setState({ lastCheck: { kind: "latest" }, found: null });
    return;
  }
  rememberCheck("found", info.version);
  updateStore.setState({ lastCheck: { kind: "found", version: info.version }, found: info });
  if (skippedVersion() === info.version) return;
  updateStore.setState({ pending: info });
}

/** 侧栏底下那行小字里，版本检查那一截。null = 不显示
 *  （这台设备根本没有更新能力，或者这次还没查过）。
 *
 *  跟同步那一截（syncCtl.syncFootState）同一套口径：话短、灰字、出问题才标红。
 *  `openable` = 点得动（点了把 UpdateDialog 顶出来）——只有真查到新版本时才给。 */
export interface UpdateFoot {
  bad: boolean;
  text: string;
  openable: boolean;
}

export function updateFootState(
  last: CheckOutcome | null,
  supported: boolean = updaterSupported,
): UpdateFoot | null {
  if (!supported || last === null) return null;
  if (last.kind === "failed") return { bad: true, text: "版本检查失败", openable: false };
  if (last.kind === "found") {
    return { bad: false, text: `有新版本 v${last.version}`, openable: true };
  }
  return { bad: false, text: "已是最新", openable: false };
}

/** 点那行「有新版本 vX」时调：把查到的那一版重新顶成弹窗。
 *  为什么不直接用 pending——「稍后再说」「这一版不再提醒」都会把 pending 清掉，
 *  但那行字还在，点了必须仍然有反应 */
export function openFoundUpdate(): void {
  const found = updateStore.getState().found;
  if (found) updateStore.setState({ pending: found });
}

/** 用户自己点「检查更新」的结果。跟开机那次的差别：不看「这一版不再提醒」——是他自己要查的 */
export type ManualCheck = "found" | "latest" | "failed" | "unsupported";

/**
 * 手动查一次，查到就把弹窗顶出来。
 *
 * 给的是设置页之外的入口用的——现在是 NewerDataDialog（「已有更新版橡果」那个框）的「现在更新」键。
 * 那个框劝人升级，就得当场给一条升级的路，不能只说不给。
 * （v1.9.1 之前它服务的是「版本过旧」那一整屏墙，那屏把设置页整个挡住了。墙已经拆了。）
 */
export async function checkUpdateNow(): Promise<ManualCheck> {
  if (!updaterSupported) return "unsupported";
  const res = await fetchUpdate();
  if (!res.ok) {
    updateStore.setState({ lastCheck: { kind: "failed" } });
    return "failed";
  }
  const info = res.info;
  if (!info || !shouldOffer(info)) {
    rememberCheck("latest", APP_VERSION);
    updateStore.setState({ lastCheck: { kind: "latest" }, found: null });
    return "latest";
  }
  rememberCheck("found", info.version);
  updateStore.setState({
    lastCheck: { kind: "found", version: info.version },
    found: info,
    pending: info,
  });
  return "found";
}

// ---------- 下好了、只差一步的那个包 ----------
//
// 安卓上第一次装要先去系统里开「允许安装未知应用」。开关页在另一个界面，人开完回来再点一次
// 「下载并安装」——以前这一下会把 12MB 重新下一遍，等第二次进度条时人已经以为又出问题了。
// 所以包下好之后要是只差系统这一步（needs-permission；安卓上交给安装器之后点了取消也算），
// 把它的路径记下来，下一次同版本直接交给安装器。记在 localStorage 里：开关页开着的时候
// 系统可能把橡果杀掉，回来是重新启动的，内存里的东西早没了。
// 包被系统清掉了怎么办：安装器那边会回 "missing"，调用方当场重新下，不算失败（见 start）。

const READY_KEY = "acorn-update-ready";

/** 已经下好、只差系统那一步的包 */
export interface ReadyPackage {
  version: string;
  path: string;
}

export function rememberReadyPackage(version: string, path: string): void {
  const p: ReadyPackage = { version, path };
  try {
    localStorage.setItem(READY_KEY, JSON.stringify(p));
  } catch {
    /* 记不住只是下次多下一遍 */
  }
}

export function forgetReadyPackage(): void {
  try {
    localStorage.removeItem(READY_KEY);
  } catch {
    /* 同上 */
  }
}

/** 这个版本有没有下好的包在等着；有就给路径。换了版本的旧包不算——那是另一个安装包 */
export function readyPackageFor(version: string): string | null {
  try {
    const raw = localStorage.getItem(READY_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<ReadyPackage>;
    if (typeof p.path !== "string" || p.path === "" || p.version !== version) return null;
    return p.path;
  } catch {
    return null;
  }
}

// ---------- 下载 + 安装的共用状态机 ----------

/**
 * `installing` = 正在交接，**这一段还叫得停**（安装器还没起来）。
 * `launching` = 安装器已经起来了，**从这一刻起停不下来**：界面得把「稍后再说」
 * 换成一句说明，别摆一个按了不算数的按钮。
 * `handed-off` = 包已经交给系统安装器了，但橡果还活着（安卓一定是这样；桌面是没退成）。
 * 它**不算 working**：界面必须把按钮还回来，用户才退得出去。
 */
export type RunPhase = "idle" | "downloading" | "installing" | "launching" | "handed-off" | "failed";

/** App 内装不上时的说辞。两端的出路不一样，话也不一样 */
export const INSTALL_FALLBACK_MSG = isAndroid
  ? "这台手机无法直接启动安装界面。可以用下面的按钮在浏览器里打开下载页，手动安装。"
  : "无法启动安装程序。可以用下面的按钮在浏览器里打开下载页，下载后双击安装。";

/** 已经交给系统安装器、但橡果还在跑时说的话 */
export const HANDOFF_MSG = isAndroid
  ? "安装包已交给系统安装器。装完系统会自己重开橡果；刚才要是点了取消（首次安装需要允许「安装未知来源应用」），可以再点一次「下载并安装」，或改用浏览器下载手动装。"
  : "安装程序已经启动，但橡果没能自己退出。请手动关掉橡果再继续安装——不退出的话新版本装不进来。";

/** （安卓）系统还没允许橡果装应用时说的话。**不是红字**：什么都没坏，只是要先开一个开关 */
export const NEEDS_PERMISSION_MSG =
  "系统要先允许橡果安装应用。已经跳到那个开关，打开后回来再点一次「下载并安装」。";

/**
 * （安卓 v1.14.2 起）系统**真的动手装了、但没装成**时说的话。
 *
 * 跟 INSTALL_FALLBACK_MSG 分得很清：那句说的是「安装界面压根没起来」，这句说的是
 * 「起来了、系统把它拒了」，出路也不一样——前者只能改用浏览器，后者多半再点一次就成。
 * 最后一句是给我们自己留的：以前用户只能说「装不上」，现在他截那一行就够了。
 */
export const INSTALL_FAILED_MSG =
  "系统没能把这一版装上。可以再点一次「重试」；还是不行就用下面的按钮在浏览器里下载、手动安装。" +
  "把下面「原因：」那一行截图发给我们，就能查出是哪一步被挡住了。";

/** 装成功了、而橡果居然还活着时说的话（正常情况下这个进程早被系统换掉了，看不到这句） */
export const INSTALL_DONE_MSG = "新版本已经装好了。";

/** 交接之后界面该停在哪儿。抽成纯函数是为了测得到：这里每一个分支都对应
 *  「用户回到橡果时还点不点得动东西」，卡死过一次的就是这一段 */
export interface RunRest {
  phase: RunPhase;
  manual: boolean;
  err: string | null;
  /** 红字底下那行小字：系统报的原话（界面画成「（原因：…）」）。null = 没有可说的 */
  why: string | null;
  /** 一句说明，不是错误——比如「先去开那个开关」 */
  note: string | null;
}

/**
 * `why` 默认取最近一次交接的原话：失败了就是失败原话（lastInstallError），
 * 没失败但走了兜底那条就说明这件事（viaNote）——两样都由 installWhy() 算。测试里可以直接递。
 * `say` 只有 "install-failed" 用得上：状态码翻出来的那句人话。
 */
export function afterInstall(
  outcome: InstallOutcome,
  why: string | null = installWhy(),
  say: string | null = null,
): RunRest {
  // "missing" 正常到不了这儿（start 里复用的包不见了会当场重下）；万一刚下好的包转眼就没了，
  // 按失败报、原因在 why 里
  if (outcome === "failed" || outcome === "missing") {
    return { phase: "failed", manual: true, err: INSTALL_FALLBACK_MSG, why, note: null };
  }
  // 系统真的装了、没装成，而且这回它说了为什么：三行各干一件事——
  // 红字说「怎么办」、note 说「发生了什么」（人话）、why 说「状态码 + 系统原话」（可截图）
  if (outcome === "install-failed") {
    return { phase: "failed", manual: true, err: INSTALL_FAILED_MSG, why, note: say };
  }
  // 系统还没允许橡果装应用：人已经被送到那个开关了，这儿什么都没坏，
  // 安安静静回 idle 摆一句说明，等他开完回来再点一次
  if (outcome === "needs-permission") {
    return { phase: "idle", manual: false, err: null, why: null, note: NEEDS_PERMISSION_MSG };
  }
  // 交接前叫停了：什么都没发生，安安静静回到原样，不留红字也不给备用方案
  if (outcome === "cancelled") return { phase: "idle", manual: false, err: null, why: null, note: null };
  // 交出去了。装没装成这一刻还不知道（安卓主路会在后面问出来），所以既不报错也不停在「安装中」：
  // 把出口全摆出来。why 这时不是错误，而是「走的是兜底那条」那句说明——没走兜底就是 null
  return { phase: "handed-off", manual: true, err: null, why, note: null };
}

/**
 * 盯安装终态的节奏。默认走真表（1.5 秒问一次、最多五分钟）；
 * 测试里换成「立刻返回、只问几次」，免得挂着一个五分钟的定时器。
 */
export interface WatchOpts {
  wait?: (ms: number) => Promise<void>;
  tries?: number;
}

export function useUpdateRun(watchOpts: WatchOpts = {}) {
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [pct, setPct] = useState(0);
  const [got, setGot] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  /** 红字底下那行小字：系统报的原话。跟 err 分开存，界面才画得成小字 */
  const [why, setWhy] = useState<string | null>(null);
  /** 一句说明（不是错误）：「先去开那个开关」这种 */
  const [note, setNote] = useState<string | null>(null);
  /** 备用方案（浏览器下载）该不该露出来 */
  const [manual, setManual] = useState(false);
  /** 正在飞的那次下载。「取消」按钮靠它把 fetch 断掉 */
  const ctrlRef = useRef<AbortController | null>(null);
  /** 第几轮。取消和重开都让它 +1——**作废掉的那一轮不许再改界面**：
   *  取消完立刻再点一次「下载并安装」的话，上一轮的 reject 会晚一步到，
   *  没有这道闸门它就会把新一轮的「下载中」按回 idle，进度条从此不动 */
  const runIdRef = useRef(0);
  /** 盯终态的节奏。放进 ref 是因为 start 是 useCallback([])，直接闭包会永远用第一次渲染那份 */
  const watchRef = useRef(watchOpts);
  watchRef.current = watchOpts;

  // 组件没了就把这一轮作废。盯安装终态那个循环靠 mine() 退出——不作废的话它会自己转满五分钟，
  // 还会对着已经卸载的组件 setState
  useEffect(
    () => () => {
      runIdRef.current += 1;
    },
    [],
  );

  /** 中止这次下载，回到什么都没发生的样子。
   *  下载 27MB 要走一会儿，中途一定得有一条走得掉的路——这条路以前根本不存在 */
  const cancel = useCallback(() => {
    runIdRef.current += 1;
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    setPhase("idle");
    setErr(null);
    setWhy(null);
    setNote(null);
    setManual(false);
    setPct(0);
    setGot(0);
  }, []);

  const start = useCallback(async (info: UpdateInfo) => {
    const myRun = (runIdRef.current += 1);
    const mine = () => runIdRef.current === myRun;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    // 上一次下好、只差系统那一步的包还在？在就不重下，直接交给安装器
    const ready = readyPackageFor(info.version);
    setPhase(ready ? "installing" : "downloading");
    setErr(null);
    setWhy(null);
    setNote(null);
    setManual(false);
    setPct(0);
    setGot(0);
    const fetchPackage = () =>
      downloadPackage(info, ({ received, total }) => {
        if (!mine()) return;
        setGot(received);
        setPct(total > 0 ? Math.round((received / total) * 100) : 0);
      }, ctrl.signal);
    // 安装器起来了，停不下来了：界面从这一刻起不再给「稍后再说」
    const onLaunched = () => {
      if (mine()) setPhase("launching");
    };
    /**
     * 交出去之后守着系统的回话（只在安卓主路）。这是 v1.14.2 的重点：
     * 以前装失败了界面什么都不知道，用户只能说「装不上」。现在拿到状态码就当场摆出来。
     */
    const settle = async (still: () => boolean) => {
      const st = await watchInstallResult(still, watchRef.current.wait, watchRef.current.tries);
      if (st === null || !still()) return;
      if (st.ok) {
        // 极少走到：装成功系统会把橡果换掉。真走到了就把包清掉、说一句
        forgetReadyPackage();
        setNote(INSTALL_DONE_MSG);
        return;
      }
      // 只有「包本身坏了」才把它忘掉（下次老老实实重下）。被拦下 / 被取消时包是好的，
      // 留着让人一键重试——重下 12MB 才是真惹人烦
      if (st.code === "STATUS_FAILURE_INVALID") forgetReadyPackage();
      const done = afterInstall("install-failed", installStatusText(st), installFailureSay(st.code));
      setPhase(done.phase);
      setManual(done.manual);
      setErr(done.err);
      setWhy(done.why);
      setNote(done.note);
    };
    try {
      let path = ready ?? (await fetchPackage());
      if (!mine()) return; // 已经被取消（或被新的一轮顶掉）：包下好了也不装
      setPhase("installing");
      // 交接要走好几秒（拉起安装器 → 落盘 → 退掉自己），这几秒里「稍后再说」必须真的算数：
      // runId 那道闸门只让**返回之后**的 setPhase 失效，拦不住已经跑起来的 installPackage，
      // 所以把 mine 递进去，让它每一步之前自己再看一眼
      let outcome = await installPackage(path, mine, onLaunched);
      if (outcome === "missing" && ready !== null) {
        // 上次留下的包被系统清掉了：这一次就老老实实重新下，别让人再点一遍
        forgetReadyPackage();
        if (!mine()) return;
        setPhase("downloading");
        path = await fetchPackage();
        if (!mine()) return;
        setPhase("installing");
        outcome = await installPackage(path, mine, onLaunched);
      }
      if (!mine()) return;
      // 只差系统那一步的包留着，下次同版本不重下（安卓上交给安装器之后点了取消也算——
      // HANDOFF_MSG 就是让人再点一次）；装上了 / 失败了 / 包不见了都清掉；叫停了不动
      if (outcome === "needs-permission" || (isAndroid && outcome === "handed-off")) {
        rememberReadyPackage(info.version, path);
      } else if (outcome !== "cancelled") {
        forgetReadyPackage();
      }
      const rest = afterInstall(outcome);
      setPhase(rest.phase);
      setManual(rest.manual);
      setErr(rest.err);
      setWhy(rest.why);
      setNote(rest.note);
      // 安卓主路（PackageInstaller）：包交出去了，终态还在后头。盯着它——
      // 装成了这个进程会被系统换掉、根本问不到；问得到的基本都是失败，那正是要摆到界面上的东西。
      // 兜底那条（ACTION_VIEW）没有回执，问也白问，不盯
      if (isAndroid && rest.phase === "handed-off" && lastInstallVia === "session") {
        void settle(mine);
      }
    } catch (e) {
      if (!mine()) return; // 作废掉的那一轮，取消时状态已经复位过了
      if (isCancelled(e)) {
        // 用户自己叫停的，不是出错：安安静静退回原样，不留红字
        setPhase("idle");
        setErr(null);
        setManual(false);
        return;
      }
      setErr(e instanceof Error ? e.message : "下载失败，请稍后重试");
      setManual(true);
      setPhase("failed");
    } finally {
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
    }
  }, []);

  return { phase, pct, got, err, why, note, manual, start, cancel };
}
