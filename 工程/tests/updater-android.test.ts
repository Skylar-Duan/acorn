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
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPackage, lastInstallError, packageName, parseManifest, UPDATE_CHANNEL,
} from "../src/core/updater";
import {
  afterInstall, forgetReadyPackage, INSTALL_FALLBACK_MSG, NEEDS_PERMISSION_MSG,
  readyPackageFor, rememberReadyPackage, useUpdateRun,
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

/** 假的 IPC：记下每一次调用，install_apk 按 mode 回话 */
const ipc = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  mode: "ok" as "ok" | "permission" | "missing" | "throw",
  /** 一次测试里 install_apk 要被调好几回、每回回话不同时用这个队列；空了就按 mode */
  plan: [] as ("ok" | "permission" | "missing" | "throw")[],
  /** 安卓 save_download 落盘后回的绝对路径就长这样 */
  cache: "/data/user/0/com.cdpandas.acorn/cache",
  // 安卓那边 reject(ex.toString()) 的样子：带类名，后面是系统的原话
  error:
    "android.content.ActivityNotFoundException: No Activity found to handle Intent " +
    "{ act=android.intent.action.VIEW dat=content://com.cdpandas.acorn.fileprovider/my_cache_images/Acorn_1.12.0.apk " +
    "typ=application/vnd.android.package-archive }",
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    ipc.calls.push({ cmd, args });
    if (cmd === "save_download") return `${ipc.cache}/${(args as { name: string }).name}`;
    if (cmd !== "install_apk") return null;
    const mode = ipc.plan.length > 0 ? ipc.plan.shift()! : ipc.mode;
    if (mode === "throw") throw ipc.error; // Rust 的 Err(String) 到前端就是裸字符串
    if (mode === "permission") return { launched: false, reason: "permission" };
    if (mode === "missing") return { launched: false, reason: "missing" };
    return { launched: true };
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
  opener.openPath = 0;
});

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

// ---------- 开完开关回来再点一次：不重下 ----------
//
// useUpdateRun 是个 hook，仓库不装 testing-library，就拿 react-dom 真渲染一个空组件把它接出来
// （act 是 React 18.3 自带的）。下面走的是真的 downloadPackage → installPackage 那条链，
// 只有 fetch 和 IPC 是假的。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Run = ReturnType<typeof useUpdateRun>;

function mountRun(): { run: () => Run; unmount: () => void } {
  let latest: Run | null = null;
  function Harness() {
    latest = useUpdateRun();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Harness)));
  return {
    run: () => latest!,
    unmount: () => act(() => root.unmount()),
  };
}

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
    const handler = rustSource.slice(rustSource.indexOf("generate_handler!["));
    expect(handler).toContain("install_apk,");
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
    "安卓插件：先查「允许安装未知应用」，再走 FileProvider 出 content://、带 APK 的 mime",
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
});
