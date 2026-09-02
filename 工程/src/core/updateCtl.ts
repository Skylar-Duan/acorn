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
import { isAndroid } from "./platform";
import {
  downloadPackage, fetchUpdate, installPackage, isCancelled, shouldOffer, updaterSupported,
  type InstallOutcome, type UpdateInfo,
} from "./updater";

interface UpdateStore {
  /** 开机查到的新版本，还没被打发走。null = 不弹 */
  pending: UpdateInfo | null;
}

export const updateStore = createStore<UpdateStore>(() => ({ pending: null }));

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
    return;
  }
  const info = res.info;
  if (!info || !shouldOffer(info)) return; // 已经是最新：安静地什么都不做
  if (skippedVersion() === info.version) return;
  updateStore.setState({ pending: info });
}

/** 用户自己点「检查更新」的结果。跟开机那次的差别：不看「这一版不再提醒」——是他自己要查的 */
export type ManualCheck = "found" | "latest" | "failed" | "unsupported";

/**
 * 手动查一次，查到就把弹窗顶出来。
 *
 * 给的是设置页之外的入口用的——现在是顶上那条 SchemaBanner（「这份数据是新版本写的」）。
 * 那条横幅劝人升级，就得当场给一条升级的路，不能只说不给。
 * （v1.9.1 之前它服务的是「版本过旧」那一整屏墙，那屏把设置页整个挡住了。墙已经拆了。）
 */
export async function checkUpdateNow(): Promise<ManualCheck> {
  if (!updaterSupported) return "unsupported";
  const res = await fetchUpdate();
  if (!res.ok) return "failed";
  const info = res.info;
  if (!info || !shouldOffer(info)) return "latest";
  updateStore.setState({ pending: info });
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
