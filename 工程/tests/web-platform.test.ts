// 网页版接进 App 本体（v1.15.0）。
//
// 这一版之前，「跑在什么上面」全应用只有一个开关：hasDesktopFeatures = !isMobile。
// 它把两件毫不相干的事混成了一件——
//   · 界面长什么样（常驻侧栏、hover、右键菜单）
//   · 这台机器有什么本事（托盘、系统热键、开机自启、文件对话框）
// 桌面 App 和安卓 App 这两端恰好一一对应，所以混着用了一年多都没出事。
// 网页版一来就穿帮了：**电脑上的浏览器**长得是桌面那副样子、本事却一样都没有，
// 于是设置页摆着一个按了没反应的全局快捷键，导出按钮点下去当场一句「导出失败」。
//
// 这份钉的就是拆开之后的那条线：
//   ① 四个开关的真值表（四种设备各站各的位）
//   ② 浏览器里的账本：IndexedDB 存得进、读得回，老的 localStorage 那份自动搬家
//   ③ 没登录时顶上那条提示必须出现，而且**不许**换成一堵登录墙
//   ④ 几处「按了不管用 / 说的和做的不一样」：右键菜单、导出、导入
//   ⑤ 添加到主屏幕的引导：能关，关了不再烦
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { defaultData, newTask } from "../src/core/model";

const read = (p: string): string => readFileSync(p, "utf8");
const platformSource = read("src/core/platform.ts");
const persistSource = read("src/core/persist.ts");
const appSource = read("src/App.tsx");
const baseCss = read("src/styles/base.css");
const shellSource = read("src/mobile/MobileShell.tsx");
const moreSource = read("src/views/MobileMore.tsx");
const accountSource = read("src/components/AccountPanel.tsx");
const webUpdateSource = read("src/core/webUpdate.ts");

const UA_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/122 Mobile Safari/537.36";
const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile Safari/604.1";

/** 把「这台设备」换成指定的那一种，重新加载一次 platform.ts。
 *  那几个开关都是模块常量（**故意的**：首屏渲染之前就得有答案，不能等一个 Promise），
 *  所以只能靠 resetModules 重新算一遍 */
async function loadPlatform(ua: string, tauri: boolean) {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgent: ua, platform: ua.includes("iPhone") ? "iPhone" : "Win32", maxTouchPoints: 0 });
  const w = window as unknown as Record<string, unknown>;
  if (tauri) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
  return import("../src/core/platform");
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.resetModules();
});

describe("① 四个开关的真值表", () => {
  it("装在电脑上的橡果：长相是桌面，本事也齐全", async () => {
    const p = await loadPlatform(UA_WIN, true);
    expect(p.isMobile).toBe(false);
    expect(p.hasDesktopFeatures).toBe(true); // 长相
    expect(p.isDesktopShell).toBe(true); // 本事
    expect(p.isWeb).toBe(false);
    expect(p.canSaveFile).toBe(true);
  });

  it("🔴 电脑上的浏览器：长相仍是桌面，但托盘 / 热键 / 开机自启一样都没有", async () => {
    // 这一格就是这一版要修的那个洞。以前 hasDesktopFeatures 一个开关同时为真，
    // 于是设置页把三件它根本做不到的事摆了出来
    const p = await loadPlatform(UA_WIN, false);
    expect(p.isMobile).toBe(false);
    expect(p.hasDesktopFeatures).toBe(true);
    expect(p.isDesktopShell).toBe(false);
    expect(p.isWeb).toBe(true);
    // 但文件还是交得出去的——走浏览器下载，不是系统对话框
    expect(p.canSaveFile).toBe(true);
  });

  it("安卓 App：手机长相，没有桌面本事，而且是唯一一个连文件都交不出去的", async () => {
    const p = await loadPlatform(UA_ANDROID, true);
    expect(p.isAndroid).toBe(true);
    expect(p.isMobile).toBe(true);
    expect(p.isDesktopShell).toBe(false);
    expect(p.isWeb).toBe(false);
    // save() 给回的是 content:// URI，Rust 侧 fs::write 写不了（v1.10.0 那笔账）
    expect(p.canSaveFile).toBe(false);
  });

  it("iPhone 上的网页版：天然就是手机长相，布局那边一个字都不用改", async () => {
    const p = await loadPlatform(UA_IPHONE, false);
    expect(p.isIOS).toBe(true);
    expect(p.isMobile).toBe(true); // 所以自动走 .mshell 那一套
    expect(p.isWeb).toBe(true);
    expect(p.isDesktopShell).toBe(false);
    expect(p.canSaveFile).toBe(true); // iPhone 上下载得到文件
  });

  it("inTauri 的真源在 platform.ts，persist.ts 只是转手再导出一次", async () => {
    // 「我是谁」这类判断全放一处。persist 那句转手导出必须留着：
    // 全仓十几处 import { inTauri } from \"./persist\" 认的是它
    expect(platformSource).toContain('export const inTauri: boolean =');
    expect(persistSource).toContain('import { inTauri } from "./platform";');
    expect(persistSource).toContain("export { inTauri };");
  });

  it("「这是不是网页版那个包」认 VITE_ACORN_WEB，而且全仓只有一处判断", async () => {
    expect(platformSource).toContain('import.meta.env.VITE_ACORN_WEB === "1"');
    // webUpdate.ts 里原来自己写了一份，v1.15.0 并了过来（它自己的注释里也约好了这件事）
    expect(webUpdateSource).toContain('export { isWebBuild } from "./platform";');
    expect(webUpdateSource).not.toContain("VITE_ACORN_WEB");
  });
});

// ---------------------------------------------------------------------------
// ② 浏览器里的账本
// ---------------------------------------------------------------------------

/** 一个够用的假 IndexedDB：只要能 open / 一次读一次写一次删就行。
 *  回调一律**异步**触发——真实环境里请求返回之后调用方才来挂 onsuccess，
 *  同步触发的假货会让这份测试对着一条永远走不到的路全绿 */
/** opts 是**边跑边能改的**：要模拟「库先写不进去、后来又好了」，把同一个对象的
 *  putFails 翻过来就行（fakeIdb 每次用到时才读它） */
function fakeIdb(opts: { putFails?: boolean; openFails?: boolean } = {}) {
  const mem = new Map<string, unknown>();
  const store = {
    get(k: string) {
      const req: Record<string, unknown> = {};
      setTimeout(() => {
        req.result = mem.get(k);
        (req.onsuccess as (() => void) | undefined)?.();
      }, 0);
      return req;
    },
    put(v: unknown, k: string) {
      if (!opts.putFails) mem.set(k, v);
      return {};
    },
    delete(k: string) {
      mem.delete(k);
      return {};
    },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction(_store?: string, mode?: string) {
      const tx: Record<string, unknown> = { objectStore: () => store };
      // 写事务在提交那一下失败（配额、存储压力下被驱逐、iOS 后台回来 abort）——
      // 请求的 onsuccess 早就响过了，认的必须是事务的结局
      const doomed = !!opts.putFails && mode === "readwrite";
      setTimeout(() => {
        const cb = doomed ? tx.onabort : tx.oncomplete;
        (cb as (() => void) | undefined)?.();
      }, 0);
      return tx;
    },
  };
  return {
    mem,
    impl: {
      open() {
        const req: Record<string, unknown> = { result: db };
        setTimeout(() => {
          const cb = opts.openFails ? req.onerror : req.onsuccess;
          (cb as (() => void) | undefined)?.();
        }, 0);
        return req;
      },
    },
  };
}

/** 一个当场就抛 QuotaExceededError 的 localStorage：模拟「这台设备真的一个字节都塞不下了」 */
function stubFullLocalStorage() {
  vi.stubGlobal("localStorage", {
    length: 0,
    key: () => null,
    getItem: () => null,
    removeItem: () => {},
    clear: () => {},
    setItem: () => {
      throw new DOMException("exceeded the quota", "QuotaExceededError");
    },
  });
}

describe("② 浏览器里的账本：存得进、读得回", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("🔴 存了能读回来（走 IndexedDB）", async () => {
    const idb = fakeIdb();
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    const data = { ...defaultData(), tasks: [newTask({ title: "网页上记的这一条" })] };
    await persist.saveData(data);
    const back = await persist.loadData();
    expect(back.data?.tasks[0].title).toBe("网页上记的这一条");
    // 真的落在 IndexedDB 里，不是绕回 localStorage 了
    expect(idb.mem.size).toBe(1);
    expect(localStorage.getItem("acorn-data")).toBeNull();
  });

  it("🔴 老用户那份 localStorage 自动搬家，搬完不留两份", async () => {
    // 两份留着更危险：哪天 IndexedDB 被清空，兜底就会端出一本陈年旧账
    const old = { ...defaultData(), tasks: [newTask({ title: "v1.14 存在 localStorage 里的" })] };
    localStorage.setItem("acorn-data", JSON.stringify(old));
    const idb = fakeIdb();
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    const back = await persist.loadData();
    expect(back.data?.tasks[0].title).toBe("v1.14 存在 localStorage 里的");
    expect(idb.mem.size).toBe(1);
    expect(localStorage.getItem("acorn-data")).toBeNull();
  });

  it("压根没有 IndexedDB（隐私模式之类）照样能用：退回 localStorage", async () => {
    const persist = await import("../src/core/persist");
    const data = { ...defaultData(), tasks: [newTask({ title: "退回去那条路" })] };
    await persist.saveData(data);
    expect(localStorage.getItem("acorn-data")).not.toBeNull();
    const back = await persist.loadData();
    expect(back.data?.tasks[0].title).toBe("退回去那条路");
  });

  it("🔴 没有 IndexedDB 时那条路上一个 await 都不许有", () => {
    // 上层「防抖 400 毫秒到点就落盘」的时序是照同步写立的（store.test 钉着那一下），
    // 中间多一个微任务，定时器一到手数据还没在盘上
    const fn = persistSource.slice(persistSource.indexOf("async function webSave"));
    // 注释里正好解释着「不许有 await」，连注释一起搜会把自己判死（B 波踩过同一个坑）
    const head = fn.slice(0, fn.indexOf("if (await idbPut")).replace(/\/\/.*$/gm, "");
    expect(head).toContain("if (!hasIdb()) {");
    expect(head).toContain("localStorage.setItem(LS_KEY, json);");
    expect(head).not.toContain("await ");
  });

  it("为什么要换掉 localStorage：一个域名总共 5 MB，而账本上限本身就是 5 MB", () => {
    // 这条钉的是理由本身。哪天有人觉得「localStorage 挺好」想换回去，先来读这段
    expect(persistSource).toContain("5 MB");
    expect(persistSource).toContain("navigator.storage?.persist?.()");
  });

  it("界面上说人话：不许把「IndexedDB」这种词摆到用户眼前", async () => {
    const persist = await import("../src/core/persist");
    const st = await persist.dataStatus();
    expect(st.dir).toBe("存在这台设备的浏览器里");
    expect(st.dir).not.toMatch(/IndexedDB|localStorage/);
  });

  it("清空本机时两处都得清干净", () => {
    const fn = persistSource.slice(persistSource.indexOf("export async function purgeLocalFiles"));
    const web = fn.slice(0, fn.indexOf("return inv<string[]>"));
    expect(web).toContain("await idbDel();");
    expect(web).toContain("lsDrop();");
    // 兜底那份、覆盖前留的那份退路，同样是「这台设备上的数据」，一起清
    expect(web).toContain("lsDrop(FB_KEY);");
    expect(web).toContain("lsDrop(PRE_KEY);");
    expect(web).toContain("await idbDel(IDB_PRE_KEY);");
  });
});

// ---------------------------------------------------------------------------
// ②之二 写不进库的那一次：兜底不许是个黑洞
//
// 这一组钉的是 v1.15.0 复核挑出来的那个洞：写路在 IndexedDB 写不进去时悄悄兜到
// localStorage，读路却只认 IndexedDB——那次失败之后记的全部东西，关掉页面再打开
// 就被库里那本旧账原样盖掉，中间一句提示都没有。
// ---------------------------------------------------------------------------
describe("②之二 库写不进去的那一次，兜底那份必须被读回来", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("🔴 库写不进去 → 兜底存下来，重开读回的是兜底这份，不是库里那本旧账", async () => {
    const idb = fakeIdb({ putFails: true });
    // 库里躺着上一次成功写入的那本（用户今天之前记的）
    const old = { ...defaultData(), tasks: [newTask({ title: "上午那本旧账" })] };
    idb.mem.set("data", JSON.stringify(old));
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");

    const fresh = { ...defaultData(), tasks: [newTask({ title: "库写不进去之后记的一下午" })] };
    await persist.saveData(fresh);
    expect(localStorage.getItem("acorn-data-fallback")).not.toBeNull();
    // 库里那份没被动（它旧，但 localStorage 万一被清掉，它还是一条退路）
    expect(JSON.parse(idb.mem.get("data") as string).tasks[0].title).toBe("上午那本旧账");

    const back = await persist.loadData();
    expect(back.data?.tasks[0].title).toBe("库写不进去之后记的一下午");
  });

  it("🔴 兜底的名字必须跟「老用户搬家那份」分开，而且 acorn- 开头", () => {
    // 两份东西含义正相反：老地方那份比库里旧（要搬进去），兜底那份比库里新（要优先读）。
    // 共用一个键名，读的时候就再也分不清谁是谁
    expect(persistSource).toContain('const FB_KEY = "acorn-data-fallback";');
    expect(persistSource).toContain('const PRE_KEY = "acorn-data-prerestore";');
  });

  it("🔴 库又好了以后，兜底那份要清掉——留着会冒充「最新的那份」", async () => {
    const opts = { putFails: true };
    const idb = fakeIdb(opts);
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");

    await persist.saveData({ ...defaultData(), tasks: [newTask({ title: "写不进去那一次" })] });
    expect(localStorage.getItem("acorn-data-fallback")).not.toBeNull();

    opts.putFails = false; // 空间腾出来了 / 从后台回来了
    await persist.saveData({ ...defaultData(), tasks: [newTask({ title: "这次写进去了" })] });
    expect(localStorage.getItem("acorn-data-fallback")).toBeNull();
    const back = await persist.loadData();
    expect(back.data?.tasks[0].title).toBe("这次写进去了");
  });

  it("🔴 两处都存不下时必须抛出来：doSave 要靠它弹「保存失败」", async () => {
    const idb = fakeIdb({ putFails: true });
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    stubFullLocalStorage();
    await expect(
      persist.saveData({ ...defaultData(), tasks: [newTask({ title: "无处可去" })] }),
    ).rejects.toThrow(/存不下/);
  });

  it("🔴 连 IndexedDB 都没有的环境，写不下去同样抛，不许静静吞掉", async () => {
    const persist = await import("../src/core/persist");
    stubFullLocalStorage();
    await expect(persist.saveData(defaultData())).rejects.toThrow(/存不下/);
  });

  it("那句话得让人知道下一步干什么，不是一串报错代号", async () => {
    const persist = await import("../src/core/persist");
    stubFullLocalStorage();
    await expect(persist.saveData(defaultData())).rejects.toThrow(/导出一份收着，别关页面/);
  });
});

// ---------------------------------------------------------------------------
// ②之三 「打不开数据库」不等于「这是台新设备」
// ---------------------------------------------------------------------------
describe("②之三 库打不开的时候，别把人当新设备", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("🔴 库打不开又哪儿都没有：报读不出来，不许返回一本空账本", async () => {
    // 返回空账本 → store 判定 noDataFile → 开机自动从云端取回一份盖在本机上。
    // 而本机那份其实好端端在库里，只是这一刻另一个标签页拦着没打开
    const idb = fakeIdb({ openFails: true });
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    await expect(persist.loadData()).rejects.toThrow(/打不开/);
  });

  it("那句话说得清是怎么回事、能怎么办", async () => {
    const idb = fakeIdb({ openFails: true });
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    await expect(persist.loadData()).rejects.toThrow(/关掉其他标签页再刷新试试/);
    expect(persistSource).not.toMatch(/throw new Error\(\s*\n?\s*"[^"]*IndexedDB/);
  });

  it("库打不开、但老地方还存着老用户那份：照样读得出来，不许在这儿报错", async () => {
    const old = { ...defaultData(), tasks: [newTask({ title: "v1.14 留在本机的" })] };
    localStorage.setItem("acorn-data", JSON.stringify(old));
    const idb = fakeIdb({ openFails: true });
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    const back = await persist.loadData();
    expect(back.data?.tasks[0].title).toBe("v1.14 留在本机的");
    // 搬家没成也不许把老地方那份删掉
    expect(localStorage.getItem("acorn-data")).not.toBeNull();
  });

  it("库打不开、但兜底那份在：先读兜底，压根轮不到报错", async () => {
    const fb = { ...defaultData(), tasks: [newTask({ title: "兜底那份" })] };
    localStorage.setItem("acorn-data-fallback", JSON.stringify(fb));
    const idb = fakeIdb({ openFails: true });
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    const back = await persist.loadData();
    expect(back.data?.tasks[0].title).toBe("兜底那份");
  });

  it("真的是台新设备（库打得开、里面就是空的）：照旧返回 null，别误报", async () => {
    const idb = fakeIdb();
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    const back = await persist.loadData();
    expect(back.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ②之四 网页版「覆盖前先留一份」
//
// 桌面那条硬前置（wipe.restoreFromCloud 里的 snapshotBackup）被 inTauri 挡住了，
// 网页版整条退路是空的。这里做的是能力本身：存一份、读回来、清空时一起清。
// ---------------------------------------------------------------------------
describe("②之四 网页版覆盖前的那条退路", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("🔴 留一份、读回来，内容一字不差", async () => {
    const idb = fakeIdb();
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    const mine = { ...defaultData(), tasks: [newTask({ title: "覆盖之前本机有的" })] };
    await persist.saveData(mine);

    expect(await persist.snapshotWebBackup()).toBe(true);
    // 覆盖下来一份别的
    await persist.saveData({ ...defaultData(), tasks: [newTask({ title: "云端那份" })] });
    const snap = await persist.readWebSnapshot();
    expect(JSON.parse(snap!).tasks[0].title).toBe("覆盖之前本机有的");
  });

  it("账本可能有 5 MB，所以优先放 IndexedDB，localStorage 只是退一步", async () => {
    const idb = fakeIdb();
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    await persist.saveData({ ...defaultData(), tasks: [newTask({ title: "留一份" })] });
    await persist.snapshotWebBackup();
    expect(idb.mem.has("prerestore")).toBe(true);
    expect(localStorage.getItem("acorn-data-prerestore")).toBeNull();
  });

  it("放不进库就退回 localStorage，键名 acorn- 开头（清空本机按前缀扫）", async () => {
    const opts = { putFails: false };
    const idb = fakeIdb(opts);
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    await persist.saveData({ ...defaultData(), tasks: [newTask({ title: "留一份" })] });
    opts.putFails = true;
    expect(await persist.snapshotWebBackup()).toBe(true);
    expect(localStorage.getItem("acorn-data-prerestore")).not.toBeNull();
  });

  it("本机本来就没有账本时返回 false —— 这不是失败，是没东西可备份", async () => {
    const idb = fakeIdb();
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    expect(await persist.snapshotWebBackup()).toBe(false);
  });

  it("清空本机之后，那条退路也没了", async () => {
    const idb = fakeIdb();
    vi.stubGlobal("indexedDB", idb.impl);
    const persist = await import("../src/core/persist");
    await persist.saveData({ ...defaultData(), tasks: [newTask({ title: "留一份" })] });
    await persist.snapshotWebBackup();
    await persist.purgeLocalFiles();
    expect(await persist.readWebSnapshot()).toBeNull();
    expect(localStorage.getItem("acorn-data-fallback")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ③ 没登录那条提示：说清楚代价，但不拦路
// ---------------------------------------------------------------------------
describe("③ 网页上没登录：提示条必须出现，登录墙不许有", () => {
  it("🔴 顶上那条提示在网页上挂得出来", () => {
    expect(appSource).toContain("const webNote = isWeb && webSessionKnown === false && !session;");
    expect(appSource).toContain('<div className="web-note">');
    expect(appSource).toContain("没登录，这些事只存在这台设备的浏览器里");
  });

  it("🔴 而且它不给关：这是实情，不是一条可以划掉的广告", () => {
    const bar = appSource.slice(appSource.indexOf('<div className="web-note">'));
    const one = bar.slice(0, bar.indexOf("</div>"));
    // 里面只有一句话和一颗「登录」，没有任何「关掉 / 知道了 / ×」
    expect(one).toContain("登录");
    expect(one).not.toMatch(/知道了|不再提示|×/);
  });

  it("桌面 App 和安卓 App 里一个节点都不该有", () => {
    // 那两端的数据在自己的磁盘上，根本没有这回事
    expect(appSource).toContain("webNote = isWeb &&");
  });

  it("🔴 网页版第一次打开不弹登录页（用户拍板：不做登录墙）", () => {
    expect(appSource).toContain('if (offer && !isWeb) openLogin("first-run");');
  });

  it("问过登录态之前不显示：否则已登录的人每次刷新都要被晃一下", () => {
    // syncCtl 里那个 session 是 initSync 异步填进去的，刚起来时必然是 null
    expect(appSource).toContain("setWebSessionKnown(!!s)");
    expect(appSource).toContain("webSessionKnown === false");
  });

  it("新加的可点元素都补了按压反馈：全局关掉了原生高亮，不补就是「按了没动静」", () => {
    // base.css 里那条 * { -webkit-tap-highlight-color: transparent } 是全仓唯一一处，
    // 它的规矩是「关掉就必须自己补回来」（v1.15.0 第三波留下的）
    expect(baseCss).toContain(".web-note-btn:active, .toast button:active { opacity: .55; }");
  });

  it("界面往下让出那条的高度，而且刘海只让一次", () => {
    expect(baseCss).toContain(".shell.web-note-on { padding-top: calc(var(--web-note-h) + env(safe-area-inset-top, 0px)); }");
    // 提示条自己顶着刘海了，手机顶栏就别再让第二次，否则标题底下空出一大片
    expect(baseCss).toContain('.shell.web-note-on .mshell { --m-safe-top: 0px; }');
  });
});

// ---------------------------------------------------------------------------
// ④ 按了不管用 / 说的和做的不一样
// ---------------------------------------------------------------------------
describe("④ 网页上那几处「按了没反应」", () => {
  it("🔴 全局屏蔽右键菜单只在 Tauri 里做", () => {
    // 那一句是为 WebView2 自带的「刷新 / 后退 / 检查」写的。搬到真浏览器里，
    // 人家的刷新、后退、复制链接、在新标签页打开全被掐了——用户只会以为这页坏了
    const eff = appSource.slice(appSource.indexOf("屏蔽 WebView2 原生右键菜单"));
    const upto = eff.slice(0, eff.indexOf("document.addEventListener(\"contextmenu\""));
    expect(upto).toContain("if (!persist.inTauri) return;");
  });

  it("账号页那颗「先导出一份 JSON」在网页上也给得出来", () => {
    // 用户正卡在「清空之前先留一份」这一步，这颗按钮尤其不能是个空壳
    expect(accountSource).toContain("{canSaveFile && (");
    expect(accountSource).toContain("if (!inTauri) {");
    expect(accountSource).toContain("downloadTextFile(`acorn-${todayYMD()}.json`, json);");
  });

  it("浏览器那两条通道摆在存取层里，各页面不再自己造一遍", () => {
    expect(persistSource).toContain("export function downloadTextFile(");
    expect(persistSource).toContain("export function pickTextFile(");
    // 下载地址不许当场 revoke：下载还没开始就撤，存下来是个空文件
    expect(persistSource).toContain("setTimeout(() => URL.revokeObjectURL(url), 60_000);");
  });
});

// ---------------------------------------------------------------------------
// ⑤ 添加到主屏幕
// ---------------------------------------------------------------------------
describe("⑤ 添加到主屏幕：这是数据安全措施，不是锦上添花", () => {
  it("安卓接 beforeinstallprompt 给一颗真按钮，苹果只能照着说", () => {
    expect(moreSource).toContain('window.addEventListener("beforeinstallprompt"');
    expect(moreSource).toContain("e.preventDefault();"); // 拦下来自己摆，不用浏览器那条压着 ＋ 的横幅
    expect(moreSource).toContain("点底下那个分享，往下找「添加到主屏幕」");
  });

  it("🔴 能关，关了不再烦；记的那个键必须 acorn- 开头（清空本机按前缀扫）", () => {
    expect(moreSource).toContain('const A2HS_OFF_KEY = "acorn-a2hs-off";');
    expect(moreSource).toContain("export function hushAddToHome()");
    expect(moreSource).toContain("hushAddToHome();");
  });

  it("已经装到主屏幕的那一份不再提", () => {
    expect(moreSource).toContain("!isStandalone()");
    expect(platformSource).toContain('window.matchMedia?.("(display-mode: standalone)").matches');
    // 苹果至今没实现 display-mode，只有这个自家属性
    expect(platformSource).toContain("standalone?: boolean");
  });

  it("桌面 App / 安卓 App 里一个节点都不渲染", () => {
    expect(moreSource).toContain("show: isWeb && isMobile && !isStandalone(),");
  });

  it("导航上面那条借的是现成的 toast，有撤销 toast 在时自己先让开", () => {
    // 两个抢同一个位置（那儿还得给右下角那颗 ＋ 让出空当），叠在一起就是一团糊
    // 「橡果有新版了 · 刷新」也站这个位置，所以要让的是两条，不是一条
    expect(moreSource).toContain("if (!a2.show || hushed || toast || newVersion) return null;");
    expect(shellSource).toContain("<AddToHomeNudge />");
  });
});

// ---------------------------------------------------------------------------
// ⑥ 网页版有新代码了
// ---------------------------------------------------------------------------
describe("⑥ 「有新版了，点这里刷新」", () => {
  it("只有网页版那个包才去问服务器", () => {
    expect(appSource).toContain("if (!isWebBuild) return;");
    expect(appSource).toContain("return startWebUpdateWatch({ onNewVersion: (v) => setWebNewVersion(v) });");
  });

  it("提示不会自己消失：刷新是用户的事，不该一眼没看见就过去了", () => {
    expect(appSource).toContain("{webNewVersion && !toastShown && (");
    expect(appSource).toContain("<button onClick={reloadForUpdate}>刷新</button>");
  });
});
