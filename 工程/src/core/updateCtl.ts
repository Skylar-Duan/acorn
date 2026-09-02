// 更新的调度层：开机自动查一次，以及「下载 → 安装」这段共用的状态机。
//
// 分成两块是为了别再各写一份：设置页的 UpdatePanel 和开机弹的 UpdateDialog
// 走的是同一个 useUpdateRun，哪天下载或安装的逻辑改了，两处一起改到。
//
// 底线跟同步一样：**查更新绝不能挡住启动**。调用方一律 void 不 await，
// 没网就报一条小消息，本地照常用。

import { useCallback, useRef, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { showToast } from "./store";
import { todayYMD } from "./dates";
import { APP_VERSION } from "./model";
import { isAndroid } from "./platform";
import {
  downloadPackage, fetchUpdate, installPackage, isCancelled, shouldOffer, updaterSupported,
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
}));

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

/** 交接之后界面该停在哪儿。抽成纯函数是为了测得到：这里每一个分支都对应
 *  「用户回到橡果时还点不点得动东西」，卡死过一次的就是这一段 */
export interface RunRest {
  phase: RunPhase;
  manual: boolean;
  err: string | null;
}

export function afterInstall(outcome: InstallOutcome): RunRest {
  if (outcome === "failed") return { phase: "failed", manual: true, err: INSTALL_FALLBACK_MSG };
  // 交接前叫停了：什么都没发生，安安静静回到原样，不留红字也不给备用方案
  if (outcome === "cancelled") return { phase: "idle", manual: false, err: null };
  // 装没装成只有用户知道，所以既不报错也不停在「安装中」：把出口全摆出来
  return { phase: "handed-off", manual: true, err: null };
}

export function useUpdateRun() {
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [pct, setPct] = useState(0);
  const [got, setGot] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  /** 备用方案（浏览器下载）该不该露出来 */
  const [manual, setManual] = useState(false);
  /** 正在飞的那次下载。「取消」按钮靠它把 fetch 断掉 */
  const ctrlRef = useRef<AbortController | null>(null);
  /** 第几轮。取消和重开都让它 +1——**作废掉的那一轮不许再改界面**：
   *  取消完立刻再点一次「下载并安装」的话，上一轮的 reject 会晚一步到，
   *  没有这道闸门它就会把新一轮的「下载中」按回 idle，进度条从此不动 */
  const runIdRef = useRef(0);

  /** 中止这次下载，回到什么都没发生的样子。
   *  下载 27MB 要走一会儿，中途一定得有一条走得掉的路——这条路以前根本不存在 */
  const cancel = useCallback(() => {
    runIdRef.current += 1;
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    setPhase("idle");
    setErr(null);
    setManual(false);
    setPct(0);
    setGot(0);
  }, []);

  const start = useCallback(async (info: UpdateInfo) => {
    const myRun = (runIdRef.current += 1);
    const mine = () => runIdRef.current === myRun;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setPhase("downloading");
    setErr(null);
    setManual(false);
    setPct(0);
    setGot(0);
    try {
      const path = await downloadPackage(info, ({ received, total }) => {
        if (!mine()) return;
        setGot(received);
        setPct(total > 0 ? Math.round((received / total) * 100) : 0);
      }, ctrl.signal);
      if (!mine()) return; // 已经被取消（或被新的一轮顶掉）：包下好了也不装
      setPhase("installing");
      // 交接要走好几秒（拉起安装器 → 落盘 → 退掉自己），这几秒里「稍后再说」必须真的算数：
      // runId 那道闸门只让**返回之后**的 setPhase 失效，拦不住已经跑起来的 installPackage，
      // 所以把 mine 递进去，让它每一步之前自己再看一眼
      if (!mine()) return;
      const rest = afterInstall(
        await installPackage(path, mine, () => {
          // 安装器起来了，停不下来了：界面从这一刻起不再给「稍后再说」
          if (mine()) setPhase("launching");
        }),
      );
      if (!mine()) return;
      setPhase(rest.phase);
      setManual(rest.manual);
      setErr(rest.err);
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

  return { phase, pct, got, err, manual, start, cancel };
}
