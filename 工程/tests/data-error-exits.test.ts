// 「数据打不开」那一屏必须是一条走得通的路，不是死胡同。
//
// 起因（用户 2026-09-14，账本里标着最高优先级）：
// 「本体设备桌面版数据错误，既无法登出登入，也无法更新优化，陷入死循环」
// 「打开了有个弹窗啥的就是说数据错误，但是没有地方可以关，后面的软件看不见，
//   但应该是打开了的，只能直接把整个软件关掉。」
//
// 根在哪：App.tsx 画那一屏之前就提前 return 了——侧栏、设置页、更新弹窗、登录窗
// 一个都没上树。那颗「打开设置」只是把「我想去设置」记进了 state，没有任何东西会读它。
// 于是换不了文件夹、登不出也登不回、查不了更新，只剩一颗「重试」，重试完还是那一屏。
// 这颗死按钮从 v1.8.0 活到 v1.14.3。
//
// 这一份钉四件事：
// ① 那一屏至少留下五条出路：看得到路径、找数据、换文件夹、检查更新、退出登录
// ② 「存不回去」不许再报成「打不开」——读成功就算成功
// ③ 已经登录过、而盘上连账本文件都没有时，不许自己造那两条默认清单
// ④ 开机自动取回云端那份：三道闸门，缺一不取
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import appSource from "../src/App.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import rescueSource from "../src/components/DataRescue.tsx?raw";
import moreSource from "../src/views/MobileMore.tsx?raw";
import { defaultData, newTask } from "../src/core/model";
import type { AppData } from "../src/core/model";
import { appStore, clearUndo, flushSave, initStore, resolveRescue } from "../src/core/store";
import * as persist from "../src/core/persist";
import * as cloud from "../src/core/cloud";
import { initSync, shouldAutoRestore, signOut, syncStore } from "../src/core/syncCtl";
import { isPristineLocal } from "../src/core/fresh";

/** 写给后人的注释里出现什么都不算数，看的是真代码 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

const env = vi.hoisted(() => ({ tauri: false, fresh: false }));

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return {
    ...actual,
    loadSession: vi.fn(async () => null),
    saveSession: vi.fn(async () => {}),
    whoAmI: vi.fn(),
    pullOnly: vi.fn(),
    syncOnce: vi.fn(),
  };
});

vi.mock("../src/core/persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/persist")>();
  return {
    ...actual,
    get inTauri() {
      return env.tauri;
    },
    takeFreshStart: vi.fn(async () => env.fresh),
    ensureDailyBackup: vi.fn(async () => false),
    findDataCandidates: vi.fn(async () => []),
    snapshotBackup: vi.fn(async () => null),
    saveData: vi.fn(actual.saveData),
  };
});

const loadSession = cloud.loadSession as unknown as Mock;
const whoAmI = cloud.whoAmI as unknown as Mock;
const pullOnly = cloud.pullOnly as unknown as Mock;
const syncOnce = cloud.syncOnce as unknown as Mock;
const saveData = persist.saveData as unknown as Mock;
const findDataCandidates = persist.findDataCandidates as unknown as Mock;

const SESSION: cloud.Session = { token: "tok", email: "a@b.c", rev: 3, syncedAt: "2026-09-10T02:00:00.000Z" };

function cloudBook(): AppData {
  return { ...defaultData(), lists: [], tasks: [newTask({ title: "云端记的事" })] };
}

beforeEach(async () => {
  vi.useRealTimers();
  env.tauri = false;
  env.fresh = false;
  await flushSave();
  await signOut();
  clearUndo();
  localStorage.clear();
  loadSession.mockReset();
  loadSession.mockResolvedValue(null);
  whoAmI.mockReset();
  pullOnly.mockReset();
  syncOnce.mockReset();
  syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => ({
    rev: 9, data: local, changed: false, summary: { added: 0, updated: 0, removed: 0 },
  }));
  saveData.mockClear();
  findDataCandidates.mockReset();
  findDataCandidates.mockResolvedValue([]);
  appStore.setState({
    data: defaultData(), loaded: true, loadError: null, dataFromNewer: null,
    rescue: null, noDataFile: false, wiped: false, saveError: null,
  });
  syncStore.setState({
    session: null, phase: "off", message: "", dirty: false,
    needsUpgrade: false, upgradeRetryAt: null, lastAttemptAt: null, restored: null,
    restoring: false,
  });
});

// ------------------------------------------------------------------ ① 那一屏的出路

describe("①「数据打不开」那一屏必须自带出路", () => {
  /** 那一屏的源码。它在文件末尾，整段单拎出来看 */
  const screen = appSource.slice(appSource.indexOf("function DataErrorScreen"));

  it("App 的 loadError 分支交给这一屏，不再自己摆两颗按钮", () => {
    expect(appSource).toContain("if (loadError) return <DataErrorScreen error={loadError} />;");
    expect(screen.length).toBeGreaterThan(500);
  });

  it("🔴 那颗「打开设置」的死按钮没了：这一屏上一切往设置页转的路都是死的", () => {
    // 程序画这一屏之前就 return 了，设置页压根没上树。
    // navigate("settings") 在这儿只是把一个字段写进 state，没有任何东西会读它
    expect(screen).not.toContain('navigate("settings")');
    expect(screen).not.toContain("打开设置");
  });

  it("出路一：当前数据文件夹的完整路径摆出来（他最需要的一条线索）", () => {
    expect(screen).toContain(".getDataDir()");
    expect(screen).toContain("{dir ?? ");
    // 报错原文也还在——那是「为什么读不到」，跟「在哪儿读」是两件事，都得说
    expect(screen).toContain("{error}");
  });

  it("出路二：去别处找找我的数据，找到了就地摆出那张选择卡", () => {
    expect(screen).toContain("persist.findDataCandidates()");
    expect(screen).toContain("appStore.setState({ rescue: found })");
    expect(screen).toContain("去别处找找我的数据");
    // 卡片本体得挂在这一屏上，否则找到了也弹不出来（以前它只挂在正常界面里）
    expect(screen).toContain("<DataRescue />");
  });

  it("出路三：换个文件夹——选文件夹 → 改指针 → 重开，跟设置里那套同一个动作", () => {
    expect(screen).toContain("@tauri-apps/plugin-dialog");
    expect(screen).toContain("persist.setDataDir(picked)");
    expect(screen).toContain("location.reload()");
    expect(screen).toContain("换个文件夹");
  });

  it("出路四：检查更新用现成的 UpdateNudge，弹窗本体也得挂上", () => {
    expect(appSource).toContain('import UpdateDialog, { UpdateNudge } from "./components/UpdateDialog";');
    expect(screen).toContain("<UpdateNudge />");
    // 查到了要把 UpdateDialog 顶出来，它不在树上就等于没查
    expect(screen).toContain("<UpdateDialog />");
  });

  it("🔴 出路五：退出登录只断登录态，一个字数据都不碰", () => {
    expect(screen).toContain("signOut()");
    expect(screen).toContain("退出登录");
    // 「退出并清空本机」那条绝不能接到这儿来：它要先过闸门（当场同步一轮成功），
    // 而这一屏上数据根本没读进来，闸门必然不通；真接上了就是在数据读不出来的机器上删盘。
    // 看的是真代码——写给后人的注释里提到那几个名字是应该的
    const code = stripComments(screen);
    expect(code).not.toContain("wipeLocalData");
    expect(code).not.toContain("checkWipeGate");
    expect(code).not.toContain("purgeLocalFiles");
  });

  it("保险：导出一份 JSON，且只在内存里确实还有东西、这台设备又真给得出文件时才摆", () => {
    expect(screen).toContain("toJsonFile(");
    expect(screen).toContain("导出一份 JSON");
    expect(screen).toContain("const hasTasks = useApp((s) => s.data.tasks.length > 0);");
    // canSaveFile：安卓上 save() 回的是 content:// URI，Rust 写不了，按下去只有一句「存不下来」
    expect(screen).toContain("{hasTasks && canSaveFile && (");
    // 浏览器里没有「保存到哪个路径」，得走下载那条（不然这颗按钮在网页版上也是死的）
    expect(screen).toContain("persist.downloadTextFile(");
  });

  it("🔴 这一屏上一颗死按钮都不许有：每条出路都按这台设备做不做得到分叉", () => {
    // 复核抓到的三颗：
    // ① 「换个文件夹」——安卓没有目录选择器，网页版连 __TAURI_INTERNALS__ 都没有，
    //    按下去当场抛「Cannot read properties of undefined (reading 'invoke')」
    expect(screen).toContain("{isDesktopShell && (");
    const dirRow = screen.slice(screen.indexOf("{isDesktopShell && ("));
    expect(dirRow.slice(0, 400)).toContain("换个文件夹");
    // ② 「去别处找找」——findDataCandidates 在浏览器里恒返回空，翻了个寂寞
    expect(screen).toContain("{persist.inTauri && (");
    // ③ 没找到时那句回话不许再把人往「换个文件夹」上引——那颗按钮在安卓上根本不存在
    expect(screen).toContain("else if (isDesktopShell) {");
    // 电脑上才敢说「用下面的『换个文件夹』」；别的地方就是一句「没找到」，不指死路
    expect(screen).toContain("没找到别的账本。可以用下面的「换个文件夹」直接指给橡果。");
    expect(screen).toContain('setSaid("常放数据的那几个位置都找过了，没找到别的账本。");');
  });

  it("🔴 顶上那句话分两端说：网页版没有「文件夹」这回事", () => {
    // getDataDir() 在网页版返回的是「存在这台设备的浏览器里」，
    // 接在「它们还在下面这个文件夹里」后面读出来是病句
    expect(screen).toContain("{isWeb ? (");
    expect(screen).toContain('{isWeb ? "这些事存在哪儿：" : "橡果正在这个文件夹里找："}');
  });

  it("这一屏上的那张选择卡换了说法：那儿的文件夹不是「空的」，是读不到", () => {
    expect(rescueSource).toContain("const failed = useApp((s) => !!s.loadError);");
    expect(rescueSource).toContain("读不到");
    // 「从空数据开始」在出错屏上会把一本空账本写到盘上去，那儿只能是「关掉」
    expect(rescueSource).toContain('failed ? "都不是，关掉"');
  });

  it("🔴 出错屏上点「都不是」一个字节都不许写盘", async () => {
    appStore.setState({ loadError: "目录不可用", rescue: [] });
    await persist.saveData({ ...defaultData(), tasks: [newTask({ title: "盘上原来那条" })] });
    saveData.mockClear();
    await resolveRescue(null);
    expect(saveData).not.toHaveBeenCalled();
    expect(appStore.getState().rescue).toBeNull();
  });

  it("侧栏那行「数据异常」点得动，去设置 → 数据（跟旁边「同步失败」一个口径）", () => {
    const foot = sidebarSource.slice(sidebarSource.indexOf('className="foot"'));
    expect(foot).toContain("revealDataSection()");
    expect(sidebarSource).toContain('revealSetSection("data", "set-data")');
  });
});

// ------------------------------------------------------------------ ② 存不回去 ≠ 打不开

describe("②「存不回去」不许再报成「打不开」", () => {
  it("🔴 读成功、写盘失败：照常进主界面，只挂一条提示条（不上那一屏墙）", async () => {
    saveData.mockRejectedValueOnce(new Error("磁盘没空间了"));
    await initStore(); // 盘上什么都没有 → 会走「首存」那一下，而它这次失败

    const s = appStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.loadError).toBeNull(); // 不上那一屏墙
    // v1.15.0 改口径：这条提示**不再是 4 秒就没的 toast**，而是一条常驻的 saveError。
    // 理由见下面那一组——写不进去的时候还接着自动保存，是会把空账本盖到真账本上的
    expect(s.saveError).toContain("磁盘没空间了");
    // 账本本身好端端在内存里
    expect(s.data.lists.map((l) => l.name)).toEqual(["工作", "生活"]);
  });

  it("备份失败同理：那是一次写，不是一次读", async () => {
    (persist.ensureDailyBackup as unknown as Mock).mockRejectedValueOnce(new Error("备份目录被锁着"));
    await initStore();
    expect(appStore.getState().loadError).toBeNull();
    expect(appStore.getState().saveError).toContain("备份目录被锁着");
  });

  it("对照组：真的读不出来才上那一屏，而且带着原因", async () => {
    const boom = vi.spyOn(persist, "loadData").mockRejectedValue(new Error("目录不可用"));
    await initStore();
    expect(appStore.getState().loadError).toContain("目录不可用");
    boom.mockRestore();
  });
});

// ------------------------------------------------------------------ ②之二 屏幕底下同一时刻只准站一条

describe("②之二 底下那个位置只站得下一条，谁都得知道现在轮到谁", () => {
  it("🔴「有新版了」和「放到桌面」不许叠在一起", () => {
    // 两条都是 className="toast"、都 fixed 在同一处。以前各存各的 state：
    // 「有新版了」只回避了撤销 toast，「放到桌面」也只回避了撤销 toast，谁都没回避对方——
    // 手机浏览器打开 /app/ 而服务器又有新版时，两行字互相压着、两颗按钮重合
    expect(appSource).toContain("const webNewVersion = useApp((s) => s.webNewVersion);");
    expect(appSource).toContain("{webNewVersion && !toastShown && (");
    // 「放到桌面」认同一个真源，并且排在它后面让位
    expect(moreSource).toContain("const newVersion = useApp((s) => s.webNewVersion);");
    expect(moreSource).toContain("if (!a2.show || hushed || toast || newVersion) return null;");
  });

  it("真源在 store 里，不是 App 自己的一个 useState", () => {
    // 存在组件自己身上的话，手机上那条压根问不到它
    expect(appSource).not.toContain("const [webNewVersion, setWebNewVersion] = useState");
    expect(appSource).toContain("startWebUpdateWatch({ onNewVersion: (v) => setWebNewVersion(v) })");
  });
});

// ------------------------------------------------------------------ ③ 空账本别自己造清单

describe("③ 登录过 + 盘上没有账本文件 → 不许自己造那两条默认清单", () => {
  it("🔴 登录过就空着，也不落盘：等云端那份填回来", async () => {
    loadSession.mockResolvedValue({ ...SESSION });
    await initStore();

    const d = appStore.getState().data;
    expect(d.lists).toEqual([]);
    expect(d.tasks).toEqual([]);
    // 那两条清单每次都换新 id，一落盘就被当成本机新建的推上云，
    // 另一台设备上凭空多出一对重复清单——正是这么来的
    expect(saveData).not.toHaveBeenCalled();
    expect(appStore.getState().noDataFile).toBe(true);
  });

  it("对照组：没登录过照旧建「工作 / 生活」并落盘（第一次装橡果的人该有个样子）", async () => {
    loadSession.mockResolvedValue(null);
    await initStore();
    expect(appStore.getState().data.lists.map((l) => l.name)).toEqual(["工作", "生活"]);
    expect(saveData).toHaveBeenCalled();
  });

  it("🔴 「读出来是 0 件事」不算「没有账本文件」：那可能是用户自己把事都删光了", async () => {
    await persist.saveData({ ...defaultData(), lists: [], tasks: [] });
    loadSession.mockResolvedValue({ ...SESSION });
    await initStore();
    expect(appStore.getState().noDataFile).toBe(false);
  });
});

// ------------------------------------------------------------------ ④ 开机自动取回

describe("④ 开机自动取回：三道闸门，缺一不取", () => {
  it("三条同时成立才取", () => {
    expect(shouldAutoRestore({ noDataFile: true, signedIn: true, cloudHasData: true })).toBe(true);
  });

  it("盘上有账本文件 → 不取（那份是用户的，凭什么盖）", () => {
    expect(shouldAutoRestore({ noDataFile: false, signedIn: true, cloudHasData: true })).toBe(false);
  });

  it("没登录 → 不取（压根没有云端那份可言）", () => {
    expect(shouldAutoRestore({ noDataFile: true, signedIn: false, cloudHasData: true })).toBe(false);
  });

  it("云端是空的、或者问不出来 → 不取（问不出来一律当没有）", () => {
    expect(shouldAutoRestore({ noDataFile: true, signedIn: true, cloudHasData: false })).toBe(false);
  });

  it("🔴 不能拿 fresh.isPristineLocal 当这条判据：它明文规定同步过的设备一律不算全新", () => {
    // 本体那台机器同步过好多回，数据文件却不见了——拿那条判据来问永远是 false，
    // 自动取回就永远不会发生。这也正是当初要另写一条更窄判据的理由
    const emptyBook = { ...defaultData(), lists: [], tasks: [] };
    expect(isPristineLocal({ data: emptyBook, everSynced: true })).toBe(false);
    expect(shouldAutoRestore({ noDataFile: true, signedIn: true, cloudHasData: true })).toBe(true);
  });

  it("🔴 走通一整轮：空壳设备开机，云端那份自己回来了，并且给了回执", async () => {
    appStore.setState({ data: { ...defaultData(), lists: [], tasks: [] }, noDataFile: true });
    loadSession.mockResolvedValue({ ...SESSION });
    whoAmI.mockResolvedValue({ email: "a@b.c", rev: 7, updatedAt: null, device: "x", hasData: true });
    pullOnly.mockResolvedValue({ rev: 7, data: cloudBook(), updatedAt: null });

    await initSync();

    expect(pullOnly).toHaveBeenCalledTimes(1);
    expect(appStore.getState().data.tasks.map((t) => t.title)).toEqual(["云端记的事"]);
    // 回执：侧栏那行「已从云端取回 N 件事」读的就是它
    expect(syncStore.getState().restored).toMatchObject({ tasks: 1 });
    // 取回之前照旧先留一份退路（浏览器环境没有文件系统，返回 null 不算失败）
    expect(persist.snapshotBackup).toHaveBeenCalledWith("pre-restore");
    // 取回那条路自己就跟云端对齐了，开机这一轮不用再合并一次；
    // 也不许因为「数据变了」就当成用户改了东西排一轮推送
    await new Promise((r) => setTimeout(r, 0));
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("🔴 盘上有账本文件：一个字都不碰，照旧走合并那条老路", async () => {
    const mine = { ...defaultData(), tasks: [newTask({ title: "本机的事" })] };
    appStore.setState({ data: mine, noDataFile: false });
    loadSession.mockResolvedValue({ ...SESSION });
    whoAmI.mockResolvedValue({ email: "a@b.c", rev: 7, updatedAt: null, device: "x", hasData: true });

    await initSync();
    await new Promise((r) => setTimeout(r, 0));

    expect(whoAmI).not.toHaveBeenCalled();
    expect(pullOnly).not.toHaveBeenCalled();
    expect(syncOnce).toHaveBeenCalledTimes(1);
    expect(appStore.getState().data.tasks.map((t) => t.title)).toEqual(["本机的事"]);
  });

  it("云端说它也没有内容：什么都不做，退回合并", async () => {
    appStore.setState({ data: { ...defaultData(), lists: [], tasks: [] }, noDataFile: true });
    loadSession.mockResolvedValue({ ...SESSION });
    whoAmI.mockResolvedValue({ email: "a@b.c", rev: 0, updatedAt: null, device: "x", hasData: false });

    await initSync();
    await new Promise((r) => setTimeout(r, 0));

    expect(pullOnly).not.toHaveBeenCalled();
    expect(syncStore.getState().restored).toBeNull();
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("断网（问不出来云端有没有）：不猜，退回合并", async () => {
    appStore.setState({ data: { ...defaultData(), lists: [], tasks: [] }, noDataFile: true });
    loadSession.mockResolvedValue({ ...SESSION });
    whoAmI.mockRejectedValue(new Error("网络不通"));

    await initSync();
    await new Promise((r) => setTimeout(r, 0));

    expect(pullOnly).not.toHaveBeenCalled();
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("取回半路失败（云端那份拉不下来）：本机一个字没动，退回合并", async () => {
    appStore.setState({ data: { ...defaultData(), lists: [], tasks: [] }, noDataFile: true });
    loadSession.mockResolvedValue({ ...SESSION });
    whoAmI.mockResolvedValue({ email: "a@b.c", rev: 7, updatedAt: null, device: "x", hasData: true });
    pullOnly.mockRejectedValue(new Error("服务器抽风"));

    await initSync();
    await new Promise((r) => setTimeout(r, 0));

    expect(syncStore.getState().restored).toBeNull();
    expect(appStore.getState().data.tasks).toEqual([]);
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("🔴 取回这几秒里用户记了东西：不覆盖，退回合并，一条都不许消失", async () => {
    // 这是最要命的时序：initStore 一返回界面就能用了（loaded=true，摆着一本空账本），
    // 而 initSync 是 void 出去的——whoAmI 一个往返、pullOnly 拉整份账本，手机网络上
    // 轻松几秒到几十秒。用户看见橡果空空如也，第一反应就是开始重新记。
    // 以前这几条会被 restoreFromCloud 整份覆盖掉，撤销栈还被清空，Ctrl+Z 都撤不回来
    appStore.setState({ data: { ...defaultData(), lists: [], tasks: [] }, noDataFile: true });
    loadSession.mockResolvedValue({ ...SESSION });
    whoAmI.mockResolvedValue({ email: "a@b.c", rev: 7, updatedAt: null, device: "x", hasData: true });
    pullOnly.mockImplementation(async () => {
      // 拉整份的这会儿，用户在界面上记了一条
      appStore.setState({
        data: { ...appStore.getState().data, tasks: [newTask({ title: "等的时候记的一条" })] },
      });
      return { rev: 7, data: cloudBook(), updatedAt: null };
    });

    await initSync();
    await new Promise((r) => setTimeout(r, 0));

    // 刚记的那条还在，云端那份没有整份盖下来
    expect(appStore.getState().data.tasks.map((t) => t.title)).toEqual(["等的时候记的一条"]);
    expect(syncStore.getState().restored).toBeNull();
    // 退回合并那条老路：这条改动会跟云端那份并起来，还会被推上云
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("🔴 取回期间界面挂占位，别让人对着一本假的空账本干活", async () => {
    appStore.setState({ data: { ...defaultData(), lists: [], tasks: [] }, noDataFile: true });
    loadSession.mockResolvedValue({ ...SESSION });
    let sawRestoring = false;
    whoAmI.mockImplementation(async () => {
      sawRestoring = syncStore.getState().restoring;
      return { email: "a@b.c", rev: 7, updatedAt: null, device: "x", hasData: true };
    });
    pullOnly.mockResolvedValue({ rev: 7, data: cloudBook(), updatedAt: null });

    await initSync();

    expect(sawRestoring).toBe(true);
    // 落地之后一定要收掉，否则用户对着「正在取回…」再也回不来
    expect(syncStore.getState().restoring).toBe(false);
    // 界面上真有这块占位，而且排在 loadError 那一屏后面
    expect(appSource).toContain("const restoring = useSync((s) => s.restoring);");
    expect(appSource).toContain("if (restoring) {");
  });

  it("取回半路走岔了，占位也得收掉（断网、云端空、用户已经动手）", async () => {
    appStore.setState({ data: { ...defaultData(), lists: [], tasks: [] }, noDataFile: true });
    loadSession.mockResolvedValue({ ...SESSION });
    whoAmI.mockRejectedValue(new Error("网络不通"));
    await initSync();
    expect(syncStore.getState().restoring).toBe(false);
  });

  it("侧栏那行回执带上退路在哪（跟手动登录那条路一个口径）", () => {
    const foot = sidebarSource.slice(sidebarSource.indexOf('className="foot"'));
    expect(foot).toContain("已从云端取回 {restored.tasks} 件事");
    expect(foot).toContain("覆盖前那份存进了 backups/${restored.backup}");
  });

  it("「数据打不开」和「正等着用户挑文件夹」这两种状态下都不许自动取回", async () => {
    for (const patch of [{ loadError: "目录不可用" }, { rescue: [] as never[] }]) {
      whoAmI.mockClear();
      await signOut();
      appStore.setState({
        data: { ...defaultData(), lists: [], tasks: [] }, noDataFile: true,
        loadError: null, rescue: null, ...patch,
      });
      loadSession.mockResolvedValue({ ...SESSION });
      whoAmI.mockResolvedValue({ email: "a@b.c", rev: 7, updatedAt: null, device: "x", hasData: true });
      await initSync();
      expect(whoAmI).not.toHaveBeenCalled();
    }
  });
});
