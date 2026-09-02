// 「登出不留本地」这条路的闸门（用户 2026-08-31 的口径：登出或删软件，本地不留，只留云端）。
//
// 这条需求做糙了会直接吃掉用户的数据，所以每一道闸门都在这儿钉一遍：
// 没登过账号的不许清、当场同步不成功不许清、清完撤销不许把数据写回盘、
// 401 那条**非自愿**登出绝不许触发清空、注销账号那条反过来钉死不清本地。
// 另外两件同一层的事也在这儿：从云端整份覆盖本机、每天自动同步一次。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
// 两处结构性约束靠读源码钉住（?raw 是 vite 的原样导入，不用引 node:fs）
import syncCtlSource from "../src/core/syncCtl.ts?raw";
import accountPanelSource from "../src/components/AccountPanel.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import settingsSource from "../src/views/Settings.tsx?raw";
import mainSource from "../src/main.tsx?raw";
import { defaultData, newTask } from "../src/core/model";
import type { AppData } from "../src/core/model";
import { addTask, appStore, clearUndo, flushSave, requestSave, undo } from "../src/core/store";
import * as persist from "../src/core/persist";
import * as cloud from "../src/core/cloud";
import { STALE_SYNC_MS, dailySyncIfNeeded, signOut, syncFootState, syncStore } from "../src/core/syncCtl";
import { WipeBlocked, checkWipeGate, restoreFromCloud, wipeLocalData } from "../src/core/wipe";

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return {
    ...actual,
    syncOnce: vi.fn(),
    pullOnly: vi.fn(),
    saveSession: vi.fn(async () => {}),
  };
});

vi.mock("../src/core/persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/persist")>();
  return {
    ...actual,
    // 删盘那一下在测试里只做「把浏览器那份抹掉」，其余照真的走
    purgeLocalFiles: vi.fn(async () => {
      localStorage.removeItem("acorn-data");
    }),
    snapshotBackup: vi.fn(async () => "pre-restore-20260831-101010.json"),
  };
});

const syncOnce = cloud.syncOnce as unknown as Mock;
const pullOnly = cloud.pullOnly as unknown as Mock;
const purgeLocalFiles = persist.purgeLocalFiles as unknown as Mock;
const snapshotBackup = persist.snapshotBackup as unknown as Mock;

const SESSION: cloud.Session = { token: "tok", email: "a@b.c", rev: 3, syncedAt: null };

function localData(title = "本机的事"): AppData {
  const d = defaultData();
  d.tasks = [newTask({ title })];
  return d;
}

/** 同步成功：把传进来那份原样还回去，不改动 */
function syncOk() {
  syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => ({
    rev: 9,
    data: local,
    changed: false,
    summary: { added: 0, updated: 0, removed: 0 },
  }));
}

beforeEach(async () => {
  vi.useRealTimers();
  await flushSave();
  clearUndo();
  localStorage.clear();
  syncOnce.mockReset();
  pullOnly.mockReset();
  purgeLocalFiles.mockClear();
  snapshotBackup.mockClear();
  appStore.setState({
    data: localData(),
    loaded: true,
    loadError: null,
    dataFromNewer: null,
    rescue: null,
    wiped: false,
  });
  syncStore.setState({
    session: { ...SESSION },
    phase: "idle",
    message: "",
    dirty: false,
    needsUpgrade: false,
    lastAttemptAt: null,
  });
  await persist.saveData(appStore.getState().data);
  syncOk();
});

describe("清空本机之前的闸门", () => {
  it("没登录过账号：这条路根本不可达，一个文件都不许删", async () => {
    syncStore.setState({ ...syncStore.getState(), session: null, phase: "off" });
    await expect(wipeLocalData()).rejects.toBeInstanceOf(WipeBlocked);
    expect(purgeLocalFiles).not.toHaveBeenCalled();
    expect(syncOnce).not.toHaveBeenCalled();
    expect(localStorage.getItem("acorn-data")).not.toBeNull();
  });

  it("当场同步失败（断网）：不删，把原因说清楚", async () => {
    syncOnce.mockRejectedValue(new cloud.ApiError(0, "offline", "连不上服务器（断网了？），这次先不同步"));
    const gate = await checkWipeGate();
    expect(gate.ok).toBe(false);
    await expect(wipeLocalData()).rejects.toBeInstanceOf(WipeBlocked);
    expect(purgeLocalFiles).not.toHaveBeenCalled();
    expect(localStorage.getItem("acorn-data")).not.toBeNull();
  });

  it("版本太老同步停摆（client_too_old）：不删", async () => {
    syncOnce.mockRejectedValue(new cloud.ApiError(0, "client_too_old", "这台设备的橡果太老了"));
    await expect(wipeLocalData()).rejects.toBeInstanceOf(WipeBlocked);
    expect(purgeLocalFiles).not.toHaveBeenCalled();
  });

  it("dirty 不算证据：它进程内为 false，同步照样得当场跑一轮", async () => {
    // dirty=false 常常只是「这次启动还没改过东西」，离线改的东西全被它谎报成干净
    syncStore.setState({ ...syncStore.getState(), dirty: false });
    syncOnce.mockRejectedValue(new cloud.ApiError(0, "offline", "断网"));
    await expect(wipeLocalData()).rejects.toBeInstanceOf(WipeBlocked);
    expect(syncOnce).toHaveBeenCalled(); // 真去同步了，没有偷看 dirty 就放行
    expect(purgeLocalFiles).not.toHaveBeenCalled();
  });

  it("数据还没正常读进来（rescue 等）时不许清", async () => {
    appStore.setState({ rescue: [] });
    const gate = await checkWipeGate();
    expect(gate.ok).toBe(false);
    expect(syncOnce).not.toHaveBeenCalled();
  });
});

describe("清空本机之后", () => {
  it("同步成功才真的删，并且断开登录态", async () => {
    const out = await wipeLocalData();
    expect(out.rev).toBe(9);
    expect(purgeLocalFiles).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("acorn-data")).toBeNull();
    expect(syncStore.getState().session).toBeNull();
  });

  it("撤销栈被清空，Ctrl+Z 撤不回来，也写不回盘", async () => {
    addTask({ title: "刚加的一件事" });
    expect(appStore.getState().undoDepth).toBeGreaterThan(0);
    await wipeLocalData();
    expect(appStore.getState().undoDepth).toBe(0);
    undo();
    await flushSave();
    expect(localStorage.getItem("acorn-data")).toBeNull();
  });

  it("wiped 闸门挡住一切后续落盘（提醒消费、防抖那几条路）", async () => {
    await wipeLocalData();
    expect(appStore.getState().wiped).toBe(true);
    requestSave();
    await flushSave();
    expect(localStorage.getItem("acorn-data")).toBeNull();
  });

  it("删盘失败就把闸门放开，别让用户接着用却一个字都存不下", async () => {
    purgeLocalFiles.mockRejectedValueOnce(new Error("目录被占用"));
    await expect(wipeLocalData()).rejects.toThrow("目录被占用");
    expect(appStore.getState().wiped).toBe(false);
  });
});

describe("绝不能把清空做成「登录态变 null」的副作用", () => {
  it("401 令牌过期是非自愿登出：断开登录态，本机一个字不动", async () => {
    syncOnce.mockRejectedValue(new cloud.ApiError(401, "unauthorized", "令牌过期了"));
    // 走一次同步把 401 触发出来
    const gate = await checkWipeGate();
    expect(gate.ok).toBe(false);
    expect(syncStore.getState().session).toBeNull(); // 确实被踢下线了
    expect(purgeLocalFiles).not.toHaveBeenCalled();
    expect(localStorage.getItem("acorn-data")).not.toBeNull();
    expect(appStore.getState().wiped).toBe(false);
  });

  it("signOut 自己只管登录态，永远不碰本机数据（注销账号走的就是它）", async () => {
    await signOut();
    expect(syncStore.getState().session).toBeNull();
    expect(purgeLocalFiles).not.toHaveBeenCalled();
    expect(appStore.getState().wiped).toBe(false);
    expect(localStorage.getItem("acorn-data")).not.toBeNull();
  });

  it("syncCtl 不许依赖 wipe：清空一旦挂进同步流程，401 就会顺手抹掉本地", () => {
    // 注释里可以提它（那儿正写着为什么不能挂），代码里一行都不许有
    const code = syncCtlSource
      .split("\n")
      .filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/from "\.\/wipe"/);
    expect(code).not.toMatch(/wipeLocalData/);
  });

  it("注销账号那段只调 signOut，不调清空", () => {
    const start = accountPanelSource.indexOf("deleteAccount");
    expect(start).toBeGreaterThan(0);
    const tail = accountPanelSource.slice(start, start + 600);
    expect(tail).toContain("signOut()");
    expect(tail).not.toContain("wipeLocalData");
  });
});

describe("从云端整份覆盖本机", () => {
  it("覆盖前先留一份备份，覆盖后撤销栈清空", async () => {
    const remote = localData("云端的事");
    pullOnly.mockResolvedValue({ rev: 7, data: remote, updatedAt: null });
    addTask({ title: "本机新加的，云端没有" });

    const out = await restoreFromCloud();

    expect(snapshotBackup).toHaveBeenCalledWith("pre-restore");
    expect(out.backup).toBe("pre-restore-20260831-101010.json");
    expect(out.rev).toBe(7);
    // 单向覆盖：本机多出来的那条没了
    expect(appStore.getState().data.tasks.map((t) => t.title)).toEqual(["云端的事"]);
    expect(appStore.getState().undoDepth).toBe(0);
    const onDisk = JSON.parse(localStorage.getItem("acorn-data")!) as AppData;
    expect(onDisk.tasks.map((t) => t.title)).toEqual(["云端的事"]);
    // 版本号跟着走，下一轮同步不会白撞一次 409
    expect(syncStore.getState().session?.rev).toBe(7);
  });

  it("云端是空的：报错，本机一个字不动", async () => {
    pullOnly.mockResolvedValue({ rev: 0, data: null, updatedAt: null });
    await expect(restoreFromCloud()).rejects.toThrow(/云端还没有数据/);
    expect(snapshotBackup).not.toHaveBeenCalled();
    expect(appStore.getState().data.tasks.map((t) => t.title)).toEqual(["本机的事"]);
  });

  it("拉取失败（断网）：报错，本机一个字不动", async () => {
    pullOnly.mockRejectedValue(new cloud.ApiError(0, "offline", "连不上服务器"));
    await expect(restoreFromCloud()).rejects.toThrow();
    expect(snapshotBackup).not.toHaveBeenCalled();
    expect(appStore.getState().data.tasks.map((t) => t.title)).toEqual(["本机的事"]);
  });

  it("没登录时不给覆盖", async () => {
    syncStore.setState({ ...syncStore.getState(), session: null });
    await expect(restoreFromCloud()).rejects.toThrow();
    expect(pullOnly).not.toHaveBeenCalled();
  });
});

// 同步停摆是无声的：升级会把令牌删掉（走 /UPDATE 之前每升一次登出一次）、
// 令牌过期、断网，哪一种都不会有弹窗。而同步状态以前**只在 设置 → 云账号 里显示**，
// 那一页用户一个月也未必点开一次——于是主界面上得有块表盘。
describe("侧栏那行同步指示", () => {
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("没登录：不显示。数据只在本机是常态，不是故障", () => {
    expect(syncFootState({ session: null, phase: "off", needsUpgrade: false })).toBeNull();
  });

  it("正常：低调一句，跟「数据已就绪」同款克制", () => {
    const foot = syncFootState({
      session: { ...SESSION, syncedAt: at(60000) }, phase: "idle", needsUpgrade: false,
    });
    expect(foot?.bad).toBe(false);
    expect(foot?.text).toContain("已同步");
  });

  it("服务端把这台设备挡回来了：明确可见，但口径是「暂停」不是「已停」", () => {
    // v1.9.1：这个状态不再是终态（退避到点、重开橡果都会自己再试一次），
    // 文案也跟着改——「同步已停，需升级」读着像「不升级就永远别想同步了」
    const foot = syncFootState({
      session: { ...SESSION, syncedAt: at(60000) }, phase: "idle", needsUpgrade: true,
    });
    expect(foot).toEqual({ bad: true, text: "同步暂停，升级后恢复" });
  });

  it("同步失败：明确可见", () => {
    const foot = syncFootState({ session: { ...SESSION }, phase: "error", needsUpgrade: false });
    expect(foot).toEqual({ bad: true, text: "同步失败" });
  });

  it("登录了却一次都没成功过：云端还什么都没有，得说", () => {
    const foot = syncFootState({
      session: { ...SESSION, syncedAt: null }, phase: "idle", needsUpgrade: false,
    });
    expect(foot).toEqual({ bad: true, text: "尚未同步" });
  });

  it("很久没同步了：也算出问题——升级后被登出就是这个样子", () => {
    const foot = syncFootState({
      session: { ...SESSION, syncedAt: at(STALE_SYNC_MS + 60000) }, phase: "idle", needsUpgrade: false,
    });
    expect(foot?.bad).toBe(true);
    expect(foot?.text).toContain("上次同步");
  });

  it("侧栏真的把它渲染出来了（以前全仓 useSync 只有 AccountPanel 一处）", () => {
    expect(sidebarSource).toContain("syncFootState");
    expect(sidebarSource).toContain("useSync");
  });

  it("点得动：一路点到 设置 → 云账号那一节，光看见问题没处去等于没说", () => {
    const foot = sidebarSource.slice(sidebarSource.indexOf('className="foot"'));
    expect(foot).toContain("foot-sync");
    expect(foot).toContain('navigate("settings")');
    expect(foot).toContain("revealCloudSection()");
    // 落点得真的在设置页上，不然滚了个寂寞
    expect(sidebarSource).toContain('getElementById("set-cloud")');
    expect(settingsSource).toContain('id="set-cloud"');
  });
});

describe("每天自动同步一次", () => {
  it("今天已经成功同步过：不再跑第二次", async () => {
    syncStore.setState({
      ...syncStore.getState(),
      session: { ...SESSION, syncedAt: new Date().toISOString() },
    });
    expect(await dailySyncIfNeeded()).toBe(false);
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("今天还没同步过：补一轮；补完当天不再跑", async () => {
    syncStore.setState({
      ...syncStore.getState(),
      session: { ...SESSION, syncedAt: new Date(Date.now() - 86400000).toISOString() },
    });
    expect(await dailySyncIfNeeded()).toBe(true);
    expect(syncOnce).toHaveBeenCalledTimes(1);
    // 成功那一下把 syncedAt 推到了今天，再触发一次不该再跑
    expect(await dailySyncIfNeeded()).toBe(false);
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("从来没同步过（刚登录）：也补一轮", async () => {
    expect(await dailySyncIfNeeded()).toBe(true);
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("没登录：什么都不做", async () => {
    syncStore.setState({ ...syncStore.getState(), session: null });
    expect(await dailySyncIfNeeded()).toBe(false);
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("没网：静默跳过，不报错；而且今天不再重试", async () => {
    syncOnce.mockRejectedValue(new cloud.ApiError(0, "offline", "断网"));
    syncStore.setState({
      ...syncStore.getState(),
      session: { ...SESSION, syncedAt: new Date(Date.now() - 86400000).toISOString() },
    });
    expect(await dailySyncIfNeeded()).toBe(false);
    // 失败不推进 session.syncedAt，只看它的话每次切回窗口都会重跑一整轮，
    // 状态行反复闪「正在同步…」→「同步失败」——所以失败也得记一次「今天试过了」
    expect(await dailySyncIfNeeded()).toBe(false);
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("focus / visibilitychange 那两条触发还有一道最短间隔", () => {
    // 这两个事件来得很密（alt-tab 一次、关掉说明窗一次、从托盘恢复一次），
    // 光靠「今天试过就早退」那道按日期的闸不够细，一分钟内能被戳十几次
    const boot = mainSource.slice(mainSource.indexOf("FOCUS_SYNC_GAP_MS"));
    expect(boot).toContain("10 * 60 * 1000");
    expect(boot).toContain("lastFocusSync");
    // 两条触发走的必须是同一个带间隔的入口，不许有谁绕过去直接调
    expect(boot).toContain('window.addEventListener("focus", onBackToApp)');
    expect(boot).toContain("if (document.visibilityState === \"visible\") onBackToApp()");
  });

  it("失败之后重开橡果还会再试一次（那个记号只活在进程内）", async () => {
    syncOnce.mockRejectedValue(new cloud.ApiError(0, "offline", "断网"));
    expect(await dailySyncIfNeeded()).toBe(false);
    expect(await dailySyncIfNeeded()).toBe(false);
    expect(syncOnce).toHaveBeenCalledTimes(1);
    // 重开 = 进程内那个记号没了
    syncStore.setState({ ...syncStore.getState(), lastAttemptAt: null, phase: "idle" });
    expect(await dailySyncIfNeeded()).toBe(false);
    expect(syncOnce).toHaveBeenCalledTimes(2);
  });
});
