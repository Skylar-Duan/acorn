// 安卓那条交接。v1.12.0 之前 App 内安装**从来没成功过**，根因是走了官方 opener 插件的 openPath——
// 它的安卓实现只有一个 open(url)，拿到缓存目录里的裸文件路径就直接 ACTION_VIEW，
// 没有 content:// 也没有 mime，系统找不到能开它的 Activity，每台手机都报「无法直接启动安装界面」。
// 现在换成 App 自己的安卓插件（InstallPlugin.kt，前端命令 install_apk）。这里钉的是：
//   ① 安卓分支调的是 install_apk，不再碰 openPath
//   ② 插件说「先去开权限」→ needs-permission，不是错误
//   ③ 插件抛上来的原话被留下来，界面把它画成小字
//   ④ Rust / Kotlin / 两个界面组件那几处结构还在（读源码钉住）
//   ⑤ 开完开关回来再点一次**不重下**：包的路径记在 localStorage，同版本直接交给安装器；包被系统清了当场重下
//   ⑥ Rust 那头注册插件失败不许把 App 启动搞崩（存成 Result，原因交给界面），.kt 不在盘上编译期就拦
//
// v1.14.2 换主路（PackageInstaller 会话）之后又多钉了：
//   ⑦ 走的是主路（mode "session"），兜底那条（ACTION_VIEW）还在、走了会明说
//   ⑧ 交出去之后**问得到终态**：状态码 + 系统原话一路到界面那行可截图的小字
//   ⑨ 终态各分支的界面语义（被拦下 / 被取消 / 包坏了 / 装成了）与「包留不留」的取舍
//   ⑩ 主路那段活儿在工作线程上跑（主线程拷 13MB 会 ANR）；终态 / 接收器 / 会话号是进程级的
//      （Activity 一重建也丢不了结果）；回执按会话号认领（连点两次不会张冠李戴）
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFailureSay, installPackage, installStatusText, installWhy, lastFallbackReason,
  lastInstallError, lastInstallVia, packageName, parseManifest, readInstallStatus,
  UPDATE_CHANNEL, viaNote, watchInstallResult,
} from "../src/core/updater";
import {
  afterInstall, forgetReadyPackage, INSTALL_DONE_MSG, INSTALL_FAILED_MSG, INSTALL_FALLBACK_MSG,
  NEEDS_PERMISSION_MSG, readyPackageFor, rememberReadyPackage, useUpdateRun, type WatchOpts,
} from "../src/core/updateCtl";
import updaterSource from "../src/core/updater.ts?raw";
import ctlSource from "../src/core/updateCtl.ts?raw";
import rustSource from "../src-tauri/src/lib.rs?raw";
import dialogSource from "../src/components/UpdateDialog.tsx?raw";
import panelSource from "../src/components/UpdatePanel.tsx?raw";

// jsdom 的 UA 不是安卓，整份文件把「这台设备」顶成安卓
vi.mock("../src/core/platform", () => ({
  isAndroid: true, isIOS: false, isMobile: true, hasDesktopFeatures: false, NARROW_PX: 760,
}));
vi.mock("../src/core/persist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/persist")>()),
  inTauri: true,
}));

type Mode = "ok" | "permission" | "missing" | "throw" | "view";

/** 假的 IPC：记下每一次调用，install_apk 按 mode 回话，install_status 回 status 那份 */
const ipc = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  mode: "ok" as Mode,
  /** 一次测试里 install_apk 要被调好几回、每回回话不同时用这个队列；空了就按 mode */
  plan: [] as Mode[],
  /** install_status 的回话。null = 系统还没给结果（{ done: false }） */
  status: null as null | Record<string, unknown>,
  /** 安卓 save_download 落盘后回的绝对路径就长这样 */
  cache: "/data/user/0/com.cdpandas.acorn/cache",
  // 安卓那边 reject(ex.toString()) 的样子：带类名，后面是系统的原话
  error:
    "android.content.ActivityNotFoundException: No Activity found to handle Intent " +
    "{ act=android.intent.action.VIEW dat=content://com.cdpandas.acorn.fileprovider/my_cache_images/Acorn_1.12.0.apk " +
    "typ=application/vnd.android.package-archive }",
  // 会话 API 起不来时插件回的那句（然后它自己退去走 ACTION_VIEW 兜底）
  sessionFail: "java.lang.SecurityException: Permission Denial: createSession",
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    ipc.calls.push({ cmd, args });
    if (cmd === "save_download") return `${ipc.cache}/${(args as { name: string }).name}`;
    if (cmd === "install_status") return ipc.status ?? { done: false };
    if (cmd !== "install_apk") return null;
    const mode = ipc.plan.length > 0 ? ipc.plan.shift()! : ipc.mode;
    if (mode === "throw") throw ipc.error; // Rust 的 Err(String) 到前端就是裸字符串
    if (mode === "permission") return { launched: false, reason: "permission" };
    if (mode === "missing") return { launched: false, reason: "missing" };
    // 兜底那条：主路起不来，插件退回 ACTION_VIEW，并把主路失败的原话带上来
    if (mode === "view") return { launched: true, mode: "view", fallback: ipc.sessionFail };
    // 主路：PackageInstaller 会话开起来了，终态稍后由 install_status 问
    return { launched: true, mode: "session", session: 7 };
  },
}));
const opener = vi.hoisted(() => ({ openPath: 0 }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: async () => {
    opener.openPath += 1;
  },
  openUrl: async () => undefined,
}));

const APK = `${ipc.cache}/Acorn_1.12.0.apk`;
const BASE = "https://acorn.cdpandas.com";

beforeEach(() => {
  ipc.calls.length = 0;
  ipc.mode = "ok";
  ipc.plan.length = 0;
  ipc.status = null;
  opener.openPath = 0;
});

/** 系统回过来的终态长这样（install_status 的回话，见 InstallPlugin.kt 的 lastResult） */
function terminal(code: string, status: number, message = ""): Record<string, unknown> {
  return { done: true, ok: code === "STATUS_SUCCESS", status, code, message };
}

describe("安卓：把 APK 交给系统安装器", () => {
  it("测试里这台「设备」是安卓：通道 android、包名 .apk", () => {
    expect(UPDATE_CHANNEL).toBe("android");
    expect(packageName("1.12.0")).toBe("Acorn_1.12.0.apk");
  });

  it("走的是 install_apk（App 自己的插件），路径原样递过去；**不再碰 openPath**", async () => {
    let launched = false;
    const out = await installPackage(APK, () => true, () => {
      launched = true;
    });
    expect(out).toBe("handed-off");
    expect(launched).toBe(true);
    expect(ipc.calls).toEqual([{ cmd: "install_apk", args: { path: APK } }]);
    expect(opener.openPath).toBe(0);
    expect(lastInstallError).toBeNull();
  });

  it("主路：插件回 mode=session（PackageInstaller 会话），界面小字不提兜底", async () => {
    expect(await installPackage(APK)).toBe("handed-off");
    expect(lastInstallVia).toBe("session");
    expect(lastFallbackReason).toBeNull();
    expect(viaNote()).toBeNull();
    expect(installWhy()).toBeNull();
  });

  it("兜底那条还在：主路起不来时插件退回 ACTION_VIEW，**回话里标明走的是兜底**", async () => {
    ipc.mode = "view";
    expect(await installPackage(APK)).toBe("handed-off");
    expect(lastInstallVia).toBe("view");
    expect(lastFallbackReason).toBe(ipc.sessionFail);
    // 这句会进界面那行小字：装上了但走的哪条路，是排查的第一个岔口
    expect(installWhy()).toContain("兜底");
    expect(installWhy()).toContain("SecurityException");
    // 交接完这一条也要落到界面上（handed-off 不再一律 why: null）
    expect(afterInstall("handed-off").why).toContain("兜底");
  });

  it("换一轮就把上一次走哪条路清掉：不把上回的兜底说明挂到这回头上", async () => {
    ipc.mode = "view";
    await installPackage(APK);
    expect(lastInstallVia).toBe("view");
    ipc.mode = "ok";
    await installPackage(APK);
    expect(lastInstallVia).toBe("session");
    expect(lastFallbackReason).toBeNull();
  });

  it("安卓交接完不退自己：exit_app 一次都不调（装没装成系统说了算，橡果得留着让人回来）", async () => {
    await installPackage(APK);
    expect(ipc.calls.map((c) => c.cmd)).not.toContain("exit_app");
  });

  it("系统还没允许橡果装应用：回 needs-permission，不算失败，安装器也没起来", async () => {
    ipc.mode = "permission";
    let launched = false;
    const out = await installPackage(APK, () => true, () => {
      launched = true;
    });
    expect(out).toBe("needs-permission");
    expect(launched).toBe(false); // 「稍后再说」不该被收掉
    expect(lastInstallError).toBeNull();
  });

  it("插件抛上来：failed，系统报的原话留在 lastInstallError 里——界面拿它当小字", async () => {
    ipc.mode = "throw";
    expect(await installPackage(APK)).toBe("failed");
    expect(lastInstallError).toContain("ActivityNotFoundException");
    // 下一次交接开头就清掉，别把上次的原因挂到这次头上
    ipc.mode = "ok";
    await installPackage(APK);
    expect(lastInstallError).toBeNull();
  });

  it("复用的包被系统清掉了：回 missing（不是失败），话留在 lastInstallError 里", async () => {
    ipc.mode = "missing";
    let launched = false;
    expect(await installPackage(APK, () => true, () => {
      launched = true;
    })).toBe("missing");
    expect(launched).toBe(false);
    expect(lastInstallError).toContain("不见了");
  });

  it("交接前就叫停：什么都不调", async () => {
    expect(await installPackage(APK, () => false)).toBe("cancelled");
    expect(ipc.calls).toEqual([]);
  });
});

describe("交接结果落到界面上", () => {
  it("failed：红字是安卓那句，系统原话另起一行小字（why），备用方案亮出来", () => {
    const rest = afterInstall("failed", ipc.error);
    expect(rest.phase).toBe("failed");
    expect(rest.manual).toBe(true);
    expect(rest.err).toBe(INSTALL_FALLBACK_MSG);
    expect(INSTALL_FALLBACK_MSG).toContain("这台手机");
    expect(rest.why).toBe(ipc.error);
    expect(rest.note).toBeNull();
  });

  it("failed 时不递原因，默认从 lastInstallError 里取", async () => {
    ipc.mode = "throw";
    const rest = afterInstall(await installPackage(APK));
    expect(rest.why).toContain("ActivityNotFoundException");
  });

  it("needs-permission：回 idle、没红字、不亮备用方案，摆一句「先去开那个开关」", () => {
    expect(afterInstall("needs-permission")).toEqual({
      phase: "idle", manual: false, err: null, why: null, note: NEEDS_PERMISSION_MSG,
    });
    // 讲人话，不带工程词
    expect(NEEDS_PERMISSION_MSG).not.toMatch(/权限|API|Intent|permission/i);
    expect(NEEDS_PERMISSION_MSG).toContain("下载并安装");
  });

  it("missing 万一漏到界面上：按失败报、原因在 why 里（正常情况 start 会当场重下，到不了这儿）", () => {
    const rest = afterInstall("missing", "上次下好的安装包不见了（系统清过缓存），需要重新下载");
    expect(rest.phase).toBe("failed");
    expect(rest.manual).toBe(true);
    expect(rest.err).toBe(INSTALL_FALLBACK_MSG);
    expect(rest.why).toContain("不见了");
  });
});

// ---------- 终态：系统到底装没装上，为什么没装上 ----------
//
// 这是 v1.14.2 的重点。以前交接完就到此为止，装失败了 App 一无所知，
// 用户只能说「装不上」，我们连是被谁挡的都不知道，连查三个版本。

describe("问系统要终态", () => {
  it("系统还没给结果：null（不是错误，界面什么都不改）", async () => {
    expect(await readInstallStatus()).toBeNull();
    expect(ipc.calls.map((c) => c.cmd)).toEqual(["install_status"]);
  });

  it("有终态了：状态码 / 名字 / 系统原话原样带回来", async () => {
    ipc.status = terminal("STATUS_FAILURE_BLOCKED", 2, "Install blocked by the device policy");
    expect(await readInstallStatus()).toEqual({
      status: 2, code: "STATUS_FAILURE_BLOCKED", ok: false,
      message: "Install blocked by the device policy",
    });
  });

  it("回话缺斤少两也不崩：补全成能显示的样子", async () => {
    ipc.status = { done: true };
    expect(await readInstallStatus()).toEqual({ status: 0, code: "STATUS_UNKNOWN", ok: false, message: "" });
  });

  it("盯着问，问到终态就收工；一直没有就到点收手（不能永远转下去）", async () => {
    const nap = () => Promise.resolve();
    // 第三次才有结果
    let asked = 0;
    ipc.status = null;
    const st = watchInstallResult(() => {
      asked += 1;
      if (asked === 3) ipc.status = terminal("STATUS_FAILURE_ABORTED", 3, "");
      return true;
    }, nap, 10);
    expect(await st).toEqual({ status: 3, code: "STATUS_FAILURE_ABORTED", ok: false, message: "" });
    // 一直没有结果时不许转成死循环
    ipc.status = null;
    expect(await watchInstallResult(() => true, nap, 3)).toBeNull();
  });

  it("这一轮作废了就别再问（取消 / 又点了一次 / 界面已经卸载）", async () => {
    ipc.status = terminal("STATUS_FAILURE_BLOCKED", 2, "");
    ipc.calls.length = 0;
    expect(await watchInstallResult(() => false, () => Promise.resolve(), 5)).toBeNull();
    expect(ipc.calls).toEqual([]);
  });

  it("可截图的那一行：状态码 + 名字 + 系统原话，一行讲完", () => {
    const line = installStatusText({ status: 2, code: "STATUS_FAILURE_BLOCKED", ok: false, message: "blocked by policy" });
    expect(line).toContain("STATUS_FAILURE_BLOCKED");
    expect(line).toContain("状态码 2");
    expect(line).toContain("blocked by policy");
    // 系统没给原话时也得是一句完整的话，不能留个空尾巴
    expect(installStatusText({ status: 4, code: "STATUS_FAILURE_INVALID", ok: false, message: "" }))
      .toBe("安装没成：STATUS_FAILURE_INVALID（状态码 4）");
  });

  it("每个状态码都有一句人话，且都不带工程词", () => {
    const codes = [
      "STATUS_FAILURE_ABORTED", "STATUS_FAILURE_BLOCKED", "STATUS_FAILURE_CONFLICT",
      "STATUS_FAILURE_INCOMPATIBLE", "STATUS_FAILURE_INVALID", "STATUS_FAILURE_STORAGE",
      "STATUS_FAILURE", "CONFIRM_NOT_LAUNCHED",
    ];
    for (const c of codes) {
      const say = installFailureSay(c);
      expect(say.length, c).toBeGreaterThan(6);
      expect(say, c).not.toMatch(/STATUS_|Intent|API|PackageInstaller/);
    }
    // 认不出来的码不硬编一句话：那时界面只显示状态码和系统原话，照样能截图
    expect(installFailureSay("STATUS_-42")).toBe("");
  });

  it("install-failed 落到界面上：红字说怎么办、note 说发生了什么、why 是可截图的那行", () => {
    const st = { status: 2, code: "STATUS_FAILURE_BLOCKED", ok: false, message: "blocked" };
    const rest = afterInstall("install-failed", installStatusText(st), installFailureSay(st.code));
    expect(rest.phase).toBe("failed");
    expect(rest.manual).toBe(true); // 还是要给「改用浏览器下载」这条出路
    expect(rest.err).toBe(INSTALL_FAILED_MSG);
    expect(rest.note).toBe(installFailureSay("STATUS_FAILURE_BLOCKED"));
    expect(rest.why).toContain("STATUS_FAILURE_BLOCKED");
    // 「安装界面没起来」和「起来了、系统拒了」是两句不同的话，出路也不一样
    expect(INSTALL_FAILED_MSG).not.toBe(INSTALL_FALLBACK_MSG);
    expect(INSTALL_FAILED_MSG).toContain("重试");
    // 这句是留给我们自己的：用户不必会描述，截那一行就够
    expect(INSTALL_FAILED_MSG).toContain("截图");
  });
});

// ---------- 开完开关回来再点一次：不重下 ----------
//
// useUpdateRun 是个 hook，仓库不装 testing-library，就拿 react-dom 真渲染一个空组件把它接出来
// （act 是 React 18.3 自带的）。下面走的是真的 downloadPackage → installPackage 那条链，
// 只有 fetch 和 IPC 是假的。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Run = ReturnType<typeof useUpdateRun>;

/** 默认 tries: 0 = 交接完不去问终态。要测「问」的那几条自己把节奏递进来 */
function mountRun(opts: WatchOpts = { wait: () => Promise.resolve(), tries: 0 }): {
  run: () => Run;
  unmount: () => void;
} {
  let latest: Run | null = null;
  function Harness() {
    latest = useUpdateRun(opts);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Harness)));
  return {
    run: () => latest!,
    unmount: () => act(() => root.unmount()),
  };
}

/** 盯终态那条链全是微任务，让它跑完再看界面 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 问终态的节奏：立刻返回、问三次就够 */
const FAST: WatchOpts = { wait: () => Promise.resolve(), tries: 3 };

/** 一条只吐 8 个字节就完的下载（sha256 留空：jsdom 没有 crypto.subtle） */
function tinyFetch() {
  let served = false;
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "8" },
      body: {
        getReader: () => ({
          read: async () => {
            if (served) return { done: true, value: undefined };
            served = true;
            return { done: false, value: new Uint8Array(8) };
          },
        }),
      },
    } as unknown as Response);
}

describe("开完开关回来再点一次：不重下", () => {
  const info = () =>
    parseManifest({
      available: true, version: "1.12.0", url: `${BASE}/download/android/Acorn_1.12.0_arm64.apk`, size: 8, sha256: "",
    })!;
  let fetches = 0;

  beforeEach(() => {
    forgetReadyPackage();
    fetches = 0;
    vi.stubGlobal("fetch", () => {
      fetches += 1;
      return tinyFetch()();
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetReadyPackage();
  });

  it("第一次：下载 → 插件说先去开开关 → 记住包的路径，界面回 idle 摆说明", async () => {
    ipc.plan.push("permission");
    const h = mountRun();
    await act(() => h.run().start(info()));
    expect(fetches).toBe(1);
    expect(ipc.calls.map((c) => c.cmd)).toEqual(["save_download", "install_apk"]);
    expect(readyPackageFor("1.12.0")).toBe(APK);
    expect(h.run().phase).toBe("idle");
    expect(h.run().err).toBeNull();
    expect(h.run().note).toBe(NEEDS_PERMISSION_MSG);
    h.unmount();
  });

  it("第二次（开关开好了）：**一个字节都不下**，直接把上次那个包交给安装器", async () => {
    rememberReadyPackage("1.12.0", APK);
    const h = mountRun();
    await act(() => h.run().start(info()));
    expect(fetches).toBe(0);
    expect(ipc.calls).toEqual([{ cmd: "install_apk", args: { path: APK } }]);
    expect(h.run().phase).toBe("handed-off");
    // 安卓上交给安装器之后点了取消还能再点（HANDOFF_MSG 就是这么说的）：包留着
    expect(readyPackageFor("1.12.0")).toBe(APK);
    h.unmount();
  });

  it("上次的包被系统清掉了：当场重新下，不报错、不让人再点一遍", async () => {
    rememberReadyPackage("1.12.0", APK);
    ipc.plan.push("missing", "ok");
    const h = mountRun();
    await act(() => h.run().start(info()));
    expect(fetches).toBe(1);
    expect(ipc.calls.map((c) => c.cmd)).toEqual(["install_apk", "save_download", "install_apk"]);
    expect(ipc.calls[2].args).toEqual({ path: APK });
    expect(h.run().phase).toBe("handed-off");
    expect(h.run().err).toBeNull();
    h.unmount();
  });

  it("真失败了就把记住的包忘掉：下一次「重试」老老实实重下，别在同一个坏包上打转", async () => {
    rememberReadyPackage("1.12.0", APK);
    ipc.plan.push("throw");
    const h = mountRun();
    await act(() => h.run().start(info()));
    expect(fetches).toBe(0);
    expect(h.run().phase).toBe("failed");
    expect(h.run().err).toBe(INSTALL_FALLBACK_MSG);
    expect(h.run().why).toContain("ActivityNotFoundException");
    expect(readyPackageFor("1.12.0")).toBeNull();
    h.unmount();
  });

  it("换了版本就不复用：那是另一个安装包", () => {
    rememberReadyPackage("1.12.0", APK);
    expect(readyPackageFor("1.13.0")).toBeNull();
    expect(readyPackageFor("1.12.0")).toBe(APK);
  });

  // ---------- 交出去之后：系统的回话要落到界面上 ----------

  it("系统把安装挡下了：界面当场变红字 + 一句人话 + 可截图的小字，包留着让人一键重试", async () => {
    ipc.status = terminal("STATUS_FAILURE_BLOCKED", 2, "Install blocked by device policy");
    const h = mountRun(FAST);
    await act(() => h.run().start(info()));
    // （测试里问终态是「立刻返回」的，所以这一步就已经问完了；
    //   「问不到时界面停在 handed-off」由下面那条单独钉）
    await flush();
    expect(ipc.calls.map((c) => c.cmd)).toContain("install_status");
    expect(h.run().phase).toBe("failed");
    expect(h.run().err).toBe(INSTALL_FAILED_MSG);
    expect(h.run().note).toBe(installFailureSay("STATUS_FAILURE_BLOCKED"));
    expect(h.run().why).toContain("STATUS_FAILURE_BLOCKED");
    expect(h.run().why).toContain("Install blocked by device policy");
    expect(h.run().manual).toBe(true); // 「改用浏览器下载」那条出路仍然给
    // 包是好的（是被系统拦下的），留着——重试不必再下 12MB
    expect(readyPackageFor("1.12.0")).toBe(APK);
    h.unmount();
  });

  it("用户在系统那页点了取消：一样有原因，一样能一键重试", async () => {
    ipc.status = terminal("STATUS_FAILURE_ABORTED", 3, "Session was abandoned");
    const h = mountRun(FAST);
    await act(() => h.run().start(info()));
    await flush();
    expect(h.run().phase).toBe("failed");
    expect(h.run().note).toContain("中止");
    expect(h.run().why).toContain("STATUS_FAILURE_ABORTED");
    expect(readyPackageFor("1.12.0")).toBe(APK);
    h.unmount();
  });

  it("系统说这个包本身有问题：把它忘掉，下次老老实实重下（别在坏包上打转）", async () => {
    ipc.status = terminal("STATUS_FAILURE_INVALID", 4, "Failed to parse APK");
    const h = mountRun(FAST);
    await act(() => h.run().start(info()));
    await flush();
    expect(h.run().phase).toBe("failed");
    expect(h.run().why).toContain("STATUS_FAILURE_INVALID");
    expect(readyPackageFor("1.12.0")).toBeNull();
    h.unmount();
  });

  it("居然装成了而橡果还活着：说一句「装好了」，把包清掉，不摆红字", async () => {
    ipc.status = terminal("STATUS_SUCCESS", 0);
    const h = mountRun(FAST);
    await act(() => h.run().start(info()));
    await flush();
    expect(h.run().phase).toBe("handed-off");
    expect(h.run().err).toBeNull();
    expect(h.run().note).toBe(INSTALL_DONE_MSG);
    expect(readyPackageFor("1.12.0")).toBeNull();
    h.unmount();
  });

  it("系统一直没回话：界面就停在「已交给系统安装器」，不许自己变成红字", async () => {
    ipc.status = null;
    const h = mountRun(FAST);
    await act(() => h.run().start(info()));
    await flush();
    expect(h.run().phase).toBe("handed-off");
    expect(h.run().err).toBeNull();
    h.unmount();
  });

  it("走兜底那条（ACTION_VIEW）就不问终态：那条根本没有回执，但界面会说明走的是兜底", async () => {
    ipc.plan.push("view");
    const h = mountRun(FAST);
    await act(() => h.run().start(info()));
    await flush();
    expect(ipc.calls.map((c) => c.cmd)).toEqual(["save_download", "install_apk"]);
    expect(h.run().phase).toBe("handed-off");
    expect(h.run().why).toContain("兜底");
    h.unmount();
  });

  it("记在 localStorage 里：开关页开着时橡果被系统杀掉、重开也还认得；忘掉就真没了", () => {
    rememberReadyPackage("1.12.0", APK);
    expect(JSON.parse(localStorage.getItem("acorn-update-ready")!)).toEqual({ version: "1.12.0", path: APK });
    forgetReadyPackage();
    expect(localStorage.getItem("acorn-update-ready")).toBeNull();
    expect(readyPackageFor("1.12.0")).toBeNull();
    // 存的东西坏了就当没有，别让它把「下载并安装」卡住
    localStorage.setItem("acorn-update-ready", "{坏的");
    expect(readyPackageFor("1.12.0")).toBeNull();
  });
});

describe("结构钉住：这条路的每一段都还在", () => {
  it("前端安卓分支：inv(\"install_apk\")，installPackage 里再没有 openPath", () => {
    const install = updaterSource.slice(updaterSource.indexOf("export async function installPackage"));
    expect(install).toContain('inv<InstallReply>("install_apk"');
    expect(install).not.toContain("openPath(");
    // 备用方案「改用浏览器下载」照旧走 openUrl，那条没坏
    expect(updaterSource).toContain("openUrl(url)");
  });

  it("Rust：注册了 com.cdpandas.acorn.InstallPlugin，install_apk 在 invoke_handler 那张表里", () => {
    expect(rustSource).toContain('register_android_plugin("com.cdpandas.acorn", "InstallPlugin")');
    expect(rustSource).toContain("async fn install_apk");
    expect(rustSource).toContain('run_mobile_plugin::<serde_json::Value>("install"');
    // v1.14.2：问终态的那条命令，走插件的 lastResult
    expect(rustSource).toContain("async fn install_status");
    expect(rustSource).toContain('run_mobile_plugin::<serde_json::Value>("lastResult"');
    const handler = rustSource.slice(rustSource.indexOf("generate_handler!["));
    expect(handler).toContain("install_apk,");
    expect(handler).toContain("install_status,");
    // 安卓那条不许把 Windows 编译弄坏：句柄和注册都关在 cfg(target_os = "android") 里
    const handle = rustSource.indexOf("struct InstallHandle");
    expect(rustSource.slice(handle - 60, handle)).toContain('#[cfg(target_os = "android")]');
    const reg = rustSource.indexOf('new("acorn-install")');
    expect(rustSource.slice(reg - 200, reg)).toContain('#[cfg(target_os = "android")]');
  });

  it("Rust：注册失败不许用 ? 抛（那是 App 启动即崩）——存成 Result，install_apk 把原因交给界面", () => {
    expect(rustSource).not.toContain('register_android_plugin("com.cdpandas.acorn", "InstallPlugin")?');
    expect(rustSource).toContain(
      "struct InstallHandle<R: tauri::Runtime>(Result<tauri::plugin::PluginHandle<R>, String>)",
    );
    const cmd = rustSource.slice(rustSource.indexOf("async fn install_apk"));
    expect(cmd).toContain("Err(why) => Err(format!(");
    // 编译期钉住 InstallPlugin.kt 在盘上：gen/ 可再生，文件丢了宁可编不过，也不出一个少组件的包
    expect(rustSource).toContain(
      'include_bytes!("../gen/android/app/src/main/java/com/cdpandas/acorn/InstallPlugin.kt")',
    );
  });

  it("start：先看有没有下好的包（readyPackageFor），有就跳过下载；包不见了当场重下；只在安卓留包", () => {
    const start = ctlSource.slice(ctlSource.indexOf("const start = useCallback("));
    const ready = start.indexOf("readyPackageFor(info.version)");
    expect(ready).toBeGreaterThan(-1);
    expect(ready).toBeLessThan(start.indexOf("downloadPackage("));
    expect(start).toContain('outcome === "missing" && ready !== null');
    expect(start).toContain('(isAndroid && outcome === "handed-off")');
  });

  it("两个界面都把原话画成小字、把「先去开开关」画成说明而不是红字", () => {
    for (const src of [dialogSource, panelSource]) {
      expect(src).toContain("（原因：{run.why}）");
      expect(src).toContain("run.note &&");
    }
    // 弹窗里：小字用的是 --ink-3 那个 class（update-hint），不是红字 update-err
    const at = dialogSource.indexOf("run.why &&");
    const whyLine = dialogSource.slice(at, at + 200);
    expect(whyLine).toContain("update-hint");
    expect(whyLine).not.toContain("update-err");
    // 设置页里：hint 那个 class 就是 --ink-3 的小字
    const at2 = panelSource.indexOf("run.why &&");
    expect(panelSource.slice(at2, at2 + 120)).toContain('className="hint"');
  });

  // v1.13.0 起真源入库在 src-tauri/android/，build-android.sh 每次幂等拷进 gen/
  const KT = "src-tauri/android/InstallPlugin.kt";
  // gen/ 不入库（可再生），fresh clone 上没有这个文件——那种情况下跳过而不是红；
  // 但只要它在（这块盘上一直在），下面每一条都得成立。
  // （tests/node-fs.d.ts 只声明了 readFileSync / readdirSync，所以「在不在」用 try/catch 判）
  const ktSource = (() => {
    try {
      return readFileSync(KT, "utf8");
    } catch {
      return null;
    }
  })();
  (ktSource !== null ? it : it.skip)(
    "安卓插件：先查「允许安装未知应用」；兜底那条仍走 FileProvider 出 content://、带 APK 的 mime",
    () => {
      const kt = ktSource!;
      expect(kt).toContain("package com.cdpandas.acorn");
      expect(kt).toContain("@TauriPlugin");
      expect(kt).toContain("class InstallPlugin(private val activity: Activity) : Plugin(activity)");
      expect(kt).toContain("@Command");
      expect(kt).toContain("fun install(invoke: Invoke)");
      expect(kt).toContain("canRequestPackageInstalls()");
      expect(kt).toContain("Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES");
      expect(kt).toContain('"reason", "permission"');
      expect(kt).toContain("FileProvider.getUriForFile(");
      expect(kt).toContain('.fileprovider"');
      expect(kt).toContain("application/vnd.android.package-archive");
      expect(kt).toContain("Intent.FLAG_GRANT_READ_URI_PERMISSION");
      // 异常要带类名：光 message 常常是 null，界面上就成了「（原因：null）」
      expect(kt).toContain("invoke.reject(ex.toString())");
      // 递来的包不在了：回 reason: "missing" 让前端重下，不是 reject（那会变成红字）
      expect(kt).toContain('"reason", "missing"');
      expect(kt).not.toContain('invoke.reject("安装包不见了');
      // 绝不能再用裸路径 / file:// 递给别的应用（那就是 opener 插件的病）
      expect(kt).not.toContain("Uri.fromFile(");
      expect(kt).not.toContain("Uri.parse(args.path)");
    },
  );

  (ktSource !== null ? it : it.skip)(
    "安卓插件主路：PackageInstaller 会话——开会话、写字节、fsync、commit，结果按状态码回来",
    () => {
      const kt = ktSource!;
      expect(kt).toContain("PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)");
      expect(kt).toContain("installer.createSession(params)");
      expect(kt).toContain("session.openWrite(");
      // 不 fsync 就 commit，系统拿到的可能是半份包
      expect(kt).toContain("session.fsync(out)");
      expect(kt).toContain("session.commit(");
      // 出事要把会话丢掉，不能在系统里堆一串开着的死会话
      expect(kt).toContain("installer.abandonSession(id)");
      // 回执通道：API 31 起 PendingIntent 必须显式可变（系统要往里塞状态 extra）
      expect(kt).toContain("PendingIntent.getBroadcast(");
      expect(kt).toContain("PendingIntent.FLAG_MUTABLE");
      expect(kt).toContain("Build.VERSION_CODES.S");
      // 接收器**运行时**注册（AndroidManifest 在 gen/ 里是可再生的，不往里加东西）。
      // 走 ContextCompat：Android 13 以上传系统的 RECEIVER_NOT_EXPORTED，13 以下 androidx 自动
      // 改用签名级权限。**不许再裸注册**——minSdk 24，那段区间里裸注册的接收器对外开放，
      // 别的应用能广播一条假终态进来，界面上就是一条假原因
      expect(kt).toContain("ContextCompat.registerReceiver(");
      expect(kt).toContain("ContextCompat.RECEIVER_NOT_EXPORTED");
      expect(kt).not.toMatch(/ctx\.registerReceiver\(r, filter\)/);
      expect(kt).toContain("Build.VERSION_CODES.TIRAMISU");
      expect(kt).toContain("com.cdpandas.acorn.INSTALL_SESSION_RESULT");
      // 状态码和系统原话——界面那行可截图的小字全靠它俩
      expect(kt).toContain("PackageInstaller.EXTRA_STATUS");
      expect(kt).toContain("PackageInstaller.EXTRA_STATUS_MESSAGE");
      for (const code of [
        "STATUS_SUCCESS", "STATUS_FAILURE_ABORTED", "STATUS_FAILURE_BLOCKED",
        "STATUS_FAILURE_CONFLICT", "STATUS_FAILURE_INCOMPATIBLE", "STATUS_FAILURE_INVALID",
        "STATUS_FAILURE_STORAGE",
      ]) {
        expect(kt, code).toContain(`PackageInstaller.${code} ->`);
      }
      // 「系统要用户点一下安装」不是终态：把系统给的确认页拉起来。
      // 用接收器自己那个 context（applicationContext），不碰插件实例手里的 Activity——
      // 那个可能早被重建掉了
      expect(kt).toContain("PackageInstaller.STATUS_PENDING_USER_ACTION");
      expect(kt).toContain("Intent.EXTRA_INTENT");
      expect(kt).toContain("ctx.startActivity(confirm)");
      expect(kt).not.toContain("activity.startActivity(confirm)");
      // 前端问终态的那条命令
      expect(kt).toContain("fun lastResult(invoke: Invoke)");
      expect(kt).toContain('put("done", true)');
      expect(kt).toContain('put("done", false)');
      // 兜底那条还在，而且回话里说得清走的是哪条
      expect(kt).toContain("Intent.ACTION_VIEW");
      expect(kt).toContain('put("mode", "session")');
      expect(kt).toContain('put("mode", "view")');
      expect(kt).toContain('put("fallback", why)');
    },
  );

  (ktSource !== null ? it : it.skip)(
    "会话那段活儿在工作线程上跑：主线程只留两个便宜的检查，13MB 的拷贝不许压在上面",
    () => {
      const kt = ktSource!;
      // 插件的方法是 Tauri 从安卓 UI 线程同步调进来的。开会话之后要把整个 APK 拷进去再 fsync，
      // 留在主线程上就是慢机器上界面全不响应、极端情况「橡果无响应」（ANR）——
      // 而这恰好会砸在最该照顾的那类机器上（老的 ACTION_VIEW 那条一次磁盘 IO 都没有，所以以前没这问题）
      const install = kt.slice(
        kt.indexOf("fun install(invoke: Invoke)"),
        kt.indexOf("private fun runInstall"),
      );
      expect(install).toContain("worker.execute { runInstall(");
      // 留在主线程上的就这两件：问一句权限、看一眼包在不在
      expect(install).toContain("canRequestPackageInstalls()");
      expect(install).toContain("file.isFile");
      // 重活一件都不许留下（只看代码，注释里提到这些词不算）
      const code = install
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      for (const heavy of ["createSession", "openWrite", "copyTo", "fsync", "commit(", "startViewer"]) {
        expect(code, heavy).not.toContain(heavy);
      }
      // 一条长期活着的线程，不是每次 new 一个
      expect(kt).toContain("Executors.newSingleThreadExecutor");
      // 工作线程上没有 PluginManager 那张兜底的网了：漏一条异常出去，前端那句 await 就永远不返回，
      // 界面停在「安装中」再没有出口。所以这一段必须兜住一切（Throwable，不只是 Exception）
      const work = kt.slice(kt.indexOf("private fun runInstall"), kt.indexOf("fun lastResult"));
      expect(work).toContain("catch (ex: Throwable)");
      // 兜底那条现在也在工作线程上，所以不能再用 Activity 起页面（那条会去碰窗口的 view）
      expect(kt).toContain("ctx.startActivity(intent)");
      expect(kt).not.toContain("activity.startActivity(intent)");
    },
  );

  (ktSource !== null ? it : it.skip)(
    "终态、接收器、会话号都是**进程级**的：Activity 一重建也丢不了结果",
    () => {
      const kt = ktSource!;
      // 接收器注册在 applicationContext 上、从不反注册，跟着进程活；而插件实例是跟着 Activity 走的
      // （用户改一下字体大小 / 显示大小，MainActivity 就重建，Tauri 随之新建一个 InstallPlugin）。
      // 状态挂在实例上的话：旧实例的接收器抢到终态、写进没人读的旧字段，前端永远只问到「还没有结果」——
      // 恰好把这次改动唯一想拿到的东西丢掉
      const at = kt.indexOf("private companion object");
      expect(at).toBeGreaterThan(-1);
      const companion = kt.slice(at);
      expect(companion).toContain("var last: JSObject? = null");
      expect(companion).toContain("var liveSession: Int = NO_SESSION");
      expect(companion).toContain("var receiver: BroadcastReceiver? = null");
      // 实例上不许再留一份
      const body = kt.slice(kt.indexOf("class InstallPlugin("), at);
      expect(body).not.toContain("private var receiver");
      expect(body).not.toContain("private var last");
      // trigger 仍要找得到活着的那个实例，但只能是弱引用——强引用会把旧 Activity 永远留在内存里
      expect(kt).toContain("newest = WeakReference(this)");
      expect(kt).toContain("newest?.get()?.trigger(RESULT_EVENT, out)");
    },
  );

  (ktSource !== null ? it : it.skip)(
    "连点两次不会张冠李戴：上一轮的会话先丢掉，回执按会话号认领",
    () => {
      const kt = ktSource!;
      // 场景：点更新 → 系统确认页弹出 → 返回橡果 → 又点一次「重试」→ 再去把第一个确认页取消掉。
      // 不认会话号的话，第一个会话的 STATUS_FAILURE_ABORTED 会被当成第二轮的失败原因画成红字
      expect(kt).toContain("PackageInstaller.EXTRA_SESSION_ID");
      expect(kt).toContain("if (want < 0) return");
      expect(kt).toContain("if (id >= 0 && id != want) return");
      // 开新会话之前先把上一轮那个丢掉，而且**先停止认账再丢**（丢弃本身会引出一条 ABORTED）
      const install = kt.slice(
        kt.indexOf("fun install(invoke: Invoke)"),
        kt.indexOf("private fun runInstall"),
      );
      expect(install).toContain("val prev = liveSession");
      expect(install).toContain("liveSession = NO_SESSION");
      expect(kt).toContain("abandon(ctx, prev)");
      expect(kt).toContain("abandonSession(id)");
      // 会话一开起来就认它——回执随时可能回来，所以这一步必须在 commit 之前
      const session = kt.slice(kt.indexOf("private fun startSession"));
      expect(session.indexOf("liveSession = id")).toBeGreaterThan(-1);
      expect(session.indexOf("liveSession = id")).toBeLessThan(session.indexOf("session.commit("));
    },
  );
});
