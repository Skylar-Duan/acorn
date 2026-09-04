// 自动更新的判断逻辑（手机 + 桌面共用）。这块最容易出的错有两个，都在这儿钉死：
// 1. 版本号按字符串比（那样 1.10.0 会小于 1.9.0，用户永远等不到更新）
// 2. 「查不到」跟「已是最新」混成一个 null——断网时界面会骗人说「已经是最新版了」
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  afterInstall, checkUpdateNow, dismissUpdate, INSTALL_FALLBACK_MSG, NEEDS_PERMISSION_MSG,
  readyPackageFor, skippedVersion, skipVersion, updateStore,
} from "../src/core/updateCtl";
import {
  compareVersions, downloadPackage, DOWNLOAD_CANCELLED, DOWNLOAD_STALL_MS, EXIT_GRACE_MS,
  fetchUpdate, installPackage, isCancelled, isNewer, isRequiredForSync, lastInstallError,
  packageName, parseManifest, shouldOffer, UPDATE_CHANNEL,
} from "../src/core/updater";
import { DATA_VERSION } from "../src/core/model";

// 这台设备「走不走这套」的开关是 updaterSupported = inTauri && …，浏览器里永远是 false。
// 下面要测的正是「查到之后弹不弹」「交接之后停在哪儿」，所以把 inTauri 顶成真。
vi.mock("../src/core/persist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/persist")>()),
  inTauri: true,
}));

/** 拉起安装器那一步要不要装作失败。Rust 的 Err(String) 到前端就是裸字符串，不是 Error */
const ipc = vi.hoisted(() => ({ fail: null as string | null }));

// 落盘和拉起安装器都是 Rust 那边的事，这儿默认只要它们「成功了」
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, _arg?: unknown, opts?: { headers?: Record<string, string> }) => {
    if (cmd === "run_installer" && ipc.fail) throw ipc.fail;
    return cmd === "save_download_raw" ? `saved:${opts?.headers?.["acorn-file-name"] ?? ""}` : null;
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: async () => undefined,
  openUrl: async () => undefined,
}));

const BASE = "https://acorn.cdpandas.com";

function manifest(over: Record<string, unknown> = {}) {
  return {
    available: true,
    version: "1.7.0",
    schema: DATA_VERSION,
    url: `${BASE}/download/android/Acorn_1.7.0_arm64.apk`,
    size: 33000000,
    sha256: "abc123",
    notes: "修了几个小问题",
    publishedAt: "2026-08-24T10:00:00Z",
    pageUrl: "https://github.com/Skylar-Duan/acorn/releases/latest",
    ...over,
  };
}

describe("版本号比较", () => {
  it("1.10.0 比 1.9.0 新（按字符串比会反）", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(isNewer("1.10.0", "1.9.0")).toBe(true);
  });

  it("一样就是一样，段数不同按缺位补零", () => {
    expect(compareVersions("1.7.0", "1.7.0")).toBe(0);
    expect(compareVersions("1.7", "1.7.0")).toBe(0);
    expect(compareVersions("1.7.0.0", "1.7")).toBe(0);
  });

  it("低版本不算新——绝不能提示「升级」到旧版", () => {
    expect(isNewer("1.5.0", "1.6.0")).toBe(false);
    expect(isNewer("1.6.0", "1.6.0")).toBe(false);
    expect(isNewer("0.9.9", "1.0.0")).toBe(false);
  });

  it("大版本进位", () => {
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.6.1", "1.6.0")).toBe(true);
  });

  it("乱七八糟的版本号不炸，按 0 处理", () => {
    expect(compareVersions("", "")).toBe(0);
    expect(compareVersions("dev", "1.0.0")).toBe(-1);
  });
});

describe("清单校验", () => {
  it("正常清单解得出来", () => {
    const u = parseManifest(manifest());
    expect(u?.version).toBe("1.7.0");
    expect(u?.size).toBe(33000000);
  });

  it("available=false / 缺版本 / 缺地址 → 当没有更新", () => {
    expect(parseManifest({ available: false })).toBeNull();
    expect(parseManifest(manifest({ version: "" }))).toBeNull();
    expect(parseManifest(manifest({ url: "" }))).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("字符串")).toBeNull();
  });

  it("**下载地址不是自家服务器的一律不认**——清单被人改过也不能把用户引去别处装东西", () => {
    expect(parseManifest(manifest({ url: "https://evil.example.com/x.apk" }))).toBeNull();
    expect(parseManifest(manifest({ url: "http://acorn.cdpandas.com/x.apk" }))).toBeNull();
    expect(parseManifest(manifest({ url: `${BASE}/download/android/ok.apk` }))).not.toBeNull();
  });

  it("缺可选字段时给安全默认值，不至于渲染出 undefined", () => {
    const u = parseManifest({ available: true, version: "1.7.0", url: `${BASE}/a.apk` });
    expect(u).not.toBeNull();
    expect(u?.notes).toBe("");
    expect(u?.sha256).toBe("");
    expect(u?.size).toBe(0);
  });
});

describe("要不要提示用户", () => {
  it("有更新就提示", () => {
    expect(shouldOffer(parseManifest(manifest({ version: "1.9.0" })), "1.6.0")).toBe(true);
  });

  it("已是最新 / 更旧 / 没清单 → 不提示", () => {
    expect(shouldOffer(parseManifest(manifest({ version: "1.6.0" })), "1.6.0")).toBe(false);
    expect(shouldOffer(parseManifest(manifest({ version: "1.5.0" })), "1.6.0")).toBe(false);
    expect(shouldOffer(null, "1.6.0")).toBe(false);
  });

  it("开发环境（版本号不是数字开头）不提示，免得天天弹", () => {
    expect(shouldOffer(parseManifest(manifest({ version: "9.9.9" })), "dev")).toBe(false);
  });
});

describe("是不是非升不可", () => {
  it("新版数据模型比本机高 = 不升就同步不了", () => {
    expect(isRequiredForSync(parseManifest(manifest({ schema: DATA_VERSION + 1 })))).toBe(true);
  });

  it("同版本或更低就只是普通更新", () => {
    expect(isRequiredForSync(parseManifest(manifest({ schema: DATA_VERSION })))).toBe(false);
    expect(isRequiredForSync(parseManifest(manifest({ schema: 1 })))).toBe(false);
    expect(isRequiredForSync(null)).toBe(false);
  });
});

// ---------- 查一次（fetchUpdate） ----------

/** 测试跑在 jsdom 里，UA 不是安卓，所以这儿一律按桌面算 */
function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("查一次更新", () => {
  it("测试环境按桌面通道走，包名是 .exe", () => {
    expect(UPDATE_CHANNEL).toBe("desktop");
    expect(packageName("1.9.1")).toBe("Acorn_1.9.1.exe");
  });

  it("查到了：ok=true，info 是解出来的清单，端点按通道拼", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      seen.push(url);
      return Promise.resolve(okResponse(manifest({ version: "1.9.1" })));
    });
    const res = await fetchUpdate();
    expect(res).toEqual({ ok: true, info: expect.objectContaining({ version: "1.9.1" }) });
    expect(seen[0]).toBe(`${BASE}/api/desktop/latest`);
  });

  it("**已经是最新和查不到必须分开**：没发过包是 ok=true + info=null，不是失败", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(okResponse({ available: false })));
    expect(await fetchUpdate()).toEqual({ ok: true, info: null });
  });

  it("断网：ok=false / offline——界面靠这个才说得出「检测失败请检查网络」", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await fetchUpdate()).toEqual({ ok: false, reason: "offline" });
  });

  it("服务器返回 5xx：ok=false / http，不能当成「已是最新」", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: false, status: 502 } as unknown as Response));
    expect(await fetchUpdate()).toEqual({ ok: false, reason: "http" });
  });

  it("清单不是 JSON：算服务端的事（http），别栽给网络", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      } as unknown as Response));
    expect(await fetchUpdate()).toEqual({ ok: false, reason: "http" });
  });

  it("网慢卡住：12 秒后自己断掉，报 timeout——**绝不能一直挂着挡住启动**", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")));
      }));
    const pending = fetchUpdate();
    await vi.advanceTimersByTimeAsync(12000);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });
});

// ---------- 「这一版不再提醒」 ----------

describe("开机弹窗的打发方式", () => {
  afterEach(() => {
    localStorage.removeItem("acorn-update-skip");
    updateStore.setState({ pending: null });
  });

  it("「稍后再说」只是关掉，不记任何东西——下次开机还会问", () => {
    updateStore.setState({ pending: parseManifest(manifest({ version: "1.9.1" })) });
    dismissUpdate();
    expect(updateStore.getState().pending).toBeNull();
    expect(skippedVersion()).toBe("");
  });

  it("「这一版不再提醒」按版本号记，**不是「永远别提醒」**——下一版照样弹", () => {
    updateStore.setState({ pending: parseManifest(manifest({ version: "1.9.1" })) });
    skipVersion("1.9.1");
    expect(updateStore.getState().pending).toBeNull();
    expect(skippedVersion()).toBe("1.9.1");
    expect(skippedVersion() === "1.9.2").toBe(false);
  });
});

// ---------- 下载这一段：超时、中断、复位 ----------
//
// 这里钉的是同一件事的三个面：下载 27MB 的时候界面上盖着一整块遮罩，
// 既没有 Esc 也点不掉背景，所以这条请求**永远不许挂死**，也永远得能叫停。

/** 一条「连上了但一个字节都不来」的连接：合盖、切到没网的热点、门户劫持、服务端 hang 都长这样 */
function hangingFetch() {
  return (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const s = init?.signal;
      const stop = () => reject(new DOMException("Aborted", "AbortError"));
      if (s?.aborted) stop(); // 已经断了的 signal 不会再发 abort 事件
      else s?.addEventListener("abort", stop);
    });
}

/** 一条真的在往下走的连接：每 gapMs 吐一块 */
function streamFetch(chunks: Uint8Array[], gapMs: number) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  let i = 0;
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => String(total) },
      body: {
        getReader: () => ({
          read: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve(i < chunks.length
                  ? { done: false, value: chunks[i++] }
                  : { done: true, value: undefined });
              }, gapMs);
            }),
        }),
      },
    } as unknown as Response);
}

/** sha256 留空：jsdom 里没有 crypto.subtle，校验那一段不在这几条用例的射程内 */
const pkg = () => ({ ...parseManifest(manifest())!, sha256: "" });

/** 把一次注定失败的下载收成 Error，好断言它到底是怎么断的 */
function failure(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => { throw new Error("这次下载本该失败"); },
    (e) => (e instanceof Error ? e : new Error(String(e))),
  );
}

describe("下载安装包", () => {
  it("**连接挂住就自己断掉**：30 秒没有新字节 → 报「卡住了」，不再永远挂着把应用锁死", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const caught = failure(downloadPackage(pkg(), () => {}));
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS);
    const e = await caught;
    expect(e.message).toContain("下载卡住了");
    expect(isCancelled(e)).toBe(false); // 不是用户取消的，界面该报错让人重试
  });

  it("慢但活着的连接不会被误杀：每收到一批新字节就把看门狗顶回去", async () => {
    vi.useFakeTimers();
    const gap = DOWNLOAD_STALL_MS - 5000; // 每块之间差一点就到超时，但一直有新字节
    vi.stubGlobal("fetch", streamFetch([new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)], gap));
    const seen: number[] = [];
    const done = downloadPackage(pkg(), (p) => seen.push(p.received)).then((v) => v, (e) => e as Error);
    await vi.advanceTimersByTimeAsync(gap * 6);
    expect(await done).toBe("saved:Acorn_1.7.0.exe");
    expect(seen).toEqual([10, 20, 30]); // 进度是一路报上来的
  });

  it("用户点「取消」：报的是取消不是失败——界面靠这个把状态打回 idle，而不是留一条红字", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const ctrl = new AbortController();
    const caught = failure(downloadPackage(pkg(), () => {}, ctrl.signal));
    ctrl.abort();
    const e = await caught;
    expect(e.message).toBe(DOWNLOAD_CANCELLED);
    expect(isCancelled(e)).toBe(true);
  });

  it("signal 递进来时就已经是 aborted：一样当取消处理，不会开一条下不完的连接", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const ctrl = new AbortController();
    ctrl.abort();
    const e = await failure(downloadPackage(pkg(), () => {}, ctrl.signal));
    expect(isCancelled(e)).toBe(true);
  });

  it("HTTP 错误照旧按下载失败报，别被取消/卡住这两条盖过去", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 502 } as unknown as Response));
    const e = await failure(downloadPackage(pkg(), () => {}));
    expect(e.message).toContain("502");
    expect(isCancelled(e)).toBe(false);
  });
});

// ---------- 交给系统安装器之后 ----------

describe("交接之后停在哪儿", () => {
  it("**没有「装好了」这一种**：能拿到返回值就说明橡果还活着，界面必须把按钮还回来", async () => {
    vi.useFakeTimers();
    const done = installPackage("C:/tmp/Acorn_1.9.1.exe").then((v) => v);
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS + 1000);
    expect(await done).toBe("handed-off");
  });

  it("交接成功后不是「安装中」：安卓那一下点了取消，用户得退得出去", () => {
    const rest = afterInstall("handed-off");
    expect(rest.phase).toBe("handed-off");
    // 关键：它不算 working，弹窗里那三个 !working 的按钮才会重新出现
    expect(rest.phase === "downloading" || rest.phase === "installing").toBe(false);
    expect(rest.manual).toBe(true); // 「改用浏览器下载」这条出口要在
    expect(rest.err).toBeNull(); // 装没装成只有用户知道，别先替他报个错
  });

  it("安装界面压根没拉起来：报失败并亮出备用方案，系统报的原话另起一行小字（why）", () => {
    expect(afterInstall("failed", "无法启动安装程序：拒绝访问。 (os error 5)")).toEqual({
      phase: "failed", manual: true, err: INSTALL_FALLBACK_MSG,
      why: "无法启动安装程序：拒绝访问。 (os error 5)", note: null,
    });
    // 没有原因可说时也不能糊一个 undefined 上去
    expect(afterInstall("failed", null).why).toBeNull();
  });

  it("拉起安装器失败：报 failed，系统报的原话留在 lastInstallError 里；下一次交接开头清零", async () => {
    ipc.fail = "无法启动安装程序：拒绝访问。 (os error 5)";
    try {
      expect(await installPackage("C:/tmp/Acorn_1.9.1.exe")).toBe("failed");
      expect(lastInstallError).toBe("无法启动安装程序：拒绝访问。 (os error 5)");
      // afterInstall 不递第二个参数时就是从这儿取的
      expect(afterInstall("failed").why).toBe("无法启动安装程序：拒绝访问。 (os error 5)");
    } finally {
      ipc.fail = null;
    }
    vi.useFakeTimers();
    const done = installPackage("C:/tmp/Acorn_1.9.1.exe");
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS + 1000);
    expect(await done).toBe("handed-off");
    expect(lastInstallError).toBeNull();
  });

  it("交接之前点了「稍后再说」：什么都没发生，安安静静回 idle", () => {
    expect(afterInstall("cancelled")).toEqual({
      phase: "idle", manual: false, err: null, why: null, note: null,
    });
  });

  it("（安卓）系统还没允许装应用：不是错误——回 idle 摆一句说明，等他开完开关回来再点", () => {
    expect(afterInstall("needs-permission")).toEqual({
      phase: "idle", manual: false, err: null, why: null, note: NEEDS_PERMISSION_MSG,
    });
  });

  it("（安卓）复用的包不见了（missing）万一漏到界面上：按失败报，原因在 why 里", () => {
    expect(afterInstall("missing", "上次下好的安装包不见了（系统清过缓存），需要重新下载")).toEqual({
      phase: "failed", manual: true, err: INSTALL_FALLBACK_MSG,
      why: "上次下好的安装包不见了（系统清过缓存），需要重新下载", note: null,
    });
  });

  it("桌面从不复用下好的包：什么都没记过时 readyPackageFor 是 null", () => {
    expect(readyPackageFor("1.9.1")).toBeNull();
  });
});

// ---------- installing 那几秒里的「稍后再说」 ----------
//
// 以前这一段是个按了不算数的按钮：cancel() 只 abort 已经结束的下载、把 runId +1，
// 而 installPackage 早就在跑了——照样拉起安装器、照样 exit_app。
// 用户以为自己取消了，几秒后橡果无声退出、安装程序跳出来，而他此刻可能正在别的窗口干活。
describe("交接途中的取消", () => {
  it("安装器还没拉起来：说停就停，一个进程都不起", async () => {
    const outcome = await installPackage("C:/tmp/Acorn_1.9.1.exe", () => false);
    expect(outcome).toBe("cancelled");
  });

  it("安装器已经起来了：不再假装没发生，但至少不把橡果关掉", async () => {
    // 停不下来的那一段：这时候界面上摆的是一句说明，不是按钮
    let launched = false;
    const outcome = await installPackage(
      "C:/tmp/Acorn_1.9.1.exe",
      () => !launched, // 拉起之后这一轮就作废了
      () => {
        launched = true;
      },
    );
    expect(launched).toBe(true);
    expect(outcome).toBe("handed-off");
  });

  it("没人传「还算不算数」时照旧交接（设置页那条路）", async () => {
    vi.useFakeTimers();
    const done = installPackage("C:/tmp/Acorn_1.9.1.exe");
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS + 1000);
    expect(await done).toBe("handed-off");
    vi.useRealTimers();
  });
});

// ---------- 提示条上的「检查更新」 ----------
//
// 去处是 NewerDataDialog（「已有更新版橡果」）的「现在更新」键。那个框劝人升级，
// 就得当场给一条升级的路，不能只说不给。
// （v1.9.1 之前它服务的是「版本过旧」那一整屏墙——那屏把设置页整个挡住了，墙已经拆了。）

describe("手动查一次", () => {
  afterEach(() => {
    localStorage.removeItem("acorn-update-skip");
    updateStore.setState({ pending: null });
  });

  it("查到新版就把弹窗顶出来（横幅上这是唯一的升级入口）", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(okResponse(manifest({ version: "99.0.0" }))));
    expect(await checkUpdateNow()).toBe("found");
    expect(updateStore.getState().pending?.version).toBe("99.0.0");
  });

  it("已是最新和查不到分开报，都不弹框——断网时不能骗人说「已经是最新版了」", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(okResponse({ available: false })));
    expect(await checkUpdateNow()).toBe("latest");
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await checkUpdateNow()).toBe("failed");
    expect(updateStore.getState().pending).toBeNull();
  });

  it("**不看「这一版不再提醒」**：是用户自己点的检查，得给他查出来", async () => {
    skipVersion("99.0.0");
    vi.stubGlobal("fetch", () => Promise.resolve(okResponse(manifest({ version: "99.0.0" }))));
    expect(await checkUpdateNow()).toBe("found");
    expect(updateStore.getState().pending?.version).toBe("99.0.0");
  });
});
