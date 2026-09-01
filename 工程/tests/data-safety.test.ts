// 第一组「会永久丢数据」的修复，逐条钉死。
//
// 这一组的共同点：出问题时用户看不见任何报错，只是有一天发现东西没了。
// 所以每条都从「用户做了什么 → 盘上/云上少了什么」这个角度写。
//
// 覆盖：
// ① 同步闸门的两条竞态（往返期间的改动不许被抹成「干净」；闸门不许搭在途那一轮的顺风车）
// ② 从云端覆盖本机时，备份是硬前置——写不成就一个字节都不写
// ③ 清空之后那一次启动不许建默认账本（否则一登录就把「工作」「生活」推上云）
// ④ 卸载钩子里不许有任何破坏性动作
// ⑤ 清空的范围要跟「找回数据」的扫描范围一样宽
// ⑥ 登录状态下必须常驻两条出路，不能只有「清空」一条
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
// 结构性约束靠读源码钉住（?raw 是 vite 的原样导入，不用引 node:fs）
import nsisHookSource from "../src-tauri/nsis-hooks.nsh?raw";
import rustSource from "../src-tauri/src/lib.rs?raw";
import accountPanelSource from "../src/components/AccountPanel.tsx?raw";
import updaterSource from "../src/core/updater.ts?raw";
import settingsSource from "../src/views/Settings.tsx?raw";
import { defaultData, newTask } from "../src/core/model";
import type { AppData } from "../src/core/model";
import { addTask, appStore, clearUndo, flushSave, initStore } from "../src/core/store";
import * as persist from "../src/core/persist";
import * as cloud from "../src/core/cloud";
import { syncNow, syncNowChecked, syncStore } from "../src/core/syncCtl";
import { WipeBlocked, restoreFromCloud, wipeLocalData } from "../src/core/wipe";

/** inTauri 是模块里的常量，测试要两种环境都走一遍，所以做成可切换的 getter */
const env = vi.hoisted(() => ({ tauri: false, fresh: false }));

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
    get inTauri() {
      return env.tauri;
    },
    purgeLocalFiles: vi.fn(async () => {
      localStorage.removeItem("acorn-data");
    }),
    snapshotBackup: vi.fn(async () => "pre-restore-20260831-101010.json"),
    takeFreshStart: vi.fn(async () => env.fresh),
    ensureDailyBackup: vi.fn(async () => false),
    findDataCandidates: vi.fn(async () => []),
  };
});

const syncOnce = cloud.syncOnce as unknown as Mock;
const pullOnly = cloud.pullOnly as unknown as Mock;
const purgeLocalFiles = persist.purgeLocalFiles as unknown as Mock;
const snapshotBackup = persist.snapshotBackup as unknown as Mock;
const takeFreshStart = persist.takeFreshStart as unknown as Mock;

const SESSION: cloud.Session = { token: "tok", email: "a@b.c", rev: 3, syncedAt: null };
const NO_CHANGE = { added: 0, updated: 0, removed: 0 };

function localData(title = "本机的事"): AppData {
  const d = defaultData();
  d.tasks = [newTask({ title })];
  return d;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function titles(d: AppData): string[] {
  return d.tasks.map((t) => t.title);
}

function onDisk(): AppData {
  return JSON.parse(localStorage.getItem("acorn-data")!) as AppData;
}

beforeEach(async () => {
  vi.useRealTimers();
  env.tauri = false;
  env.fresh = false;
  await flushSave();
  clearUndo();
  localStorage.clear();
  syncOnce.mockReset();
  pullOnly.mockReset();
  purgeLocalFiles.mockClear();
  snapshotBackup.mockClear();
  snapshotBackup.mockResolvedValue("pre-restore-20260831-101010.json");
  takeFreshStart.mockClear();
  appStore.setState({
    data: localData(),
    loaded: true,
    loadError: null,
    dataTooNew: null,
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
  // 默认：把传进来那份原样还回去
  syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => ({
    rev: 9,
    data: local,
    changed: false,
    summary: NO_CHANGE,
  }));
});

describe("同步往返期间产生的改动，不许被这一次成功抹成「干净」", () => {
  it("对照组：期间什么都没改，成功后 dirty 归零", async () => {
    syncStore.setState({ ...syncStore.getState(), dirty: true });
    await syncNow();
    expect(syncStore.getState().dirty).toBe(false);
  });

  it("网络还在飞的时候又记了一条：dirty 保持 true", async () => {
    // 这条改动不在这一轮的快照里，云端根本没有它
    const gate = deferred<cloud.SyncOutcome>();
    let snap: AppData | null = null;
    syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => {
      snap = local;
      return gate.promise;
    });
    const round = syncNow();
    addTask({ title: "同步飞行途中记的一条" });
    gate.resolve({ rev: 9, data: snap!, changed: false, summary: NO_CHANGE });
    await round;

    expect(syncStore.getState().dirty).toBe(true);
    expect(titles(appStore.getState().data)).toContain("同步飞行途中记的一条");
  });

  it("闸门据此判不通过，一个文件都不许删", async () => {
    // 确认框弹着的那几秒里用户随手记了一条（全局快捷键、提醒到点自动清都算）
    syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => {
      addTask({ title: "确认框弹着时记的一条" });
      return { rev: 9, data: local, changed: false, summary: NO_CHANGE };
    });

    const res = await syncNowChecked();
    expect(res.ok).toBe(false);

    await expect(wipeLocalData()).rejects.toBeInstanceOf(WipeBlocked);
    expect(purgeLocalFiles).not.toHaveBeenCalled();
    expect(localStorage.getItem("acorn-data")).not.toBeNull();
  });

  it("**往返期间记的那条，不许被云端的合并结果整份盖掉**", async () => {
    // 以前这里是：drifted 判出来了，却照旧 applyRemoteData(outcome.data) 整份覆盖内存。
    // 那份是拿**起飞那一刻**的快照算出来的，往返期间记的东西云端没有、内存里也没了，
    // 紧接着 scheduleSave 把它写回盘，盘上那条也没了。
    // 于是闸门那句「再点一次把这次改动也传上去」是假的：那条改动已经不存在，
    // 第二次点必然放行 → 确认框 → purge 把盘删掉。用户那条任务两边都没有。
    const other = newTask({ title: "另一台设备记的" });
    const seen: AppData[] = [];
    let injected = false;
    syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => {
      seen.push(local);
      if (!injected) {
        injected = true;
        addTask({ title: "往返期间记的一条" }); // 小窗随手记、主窗勾掉一件事，都走这条
      }
      // 服务端把两边合起来还回来
      const has = local.tasks.some((t) => t.id === other.id);
      return {
        rev: 11,
        data: has ? local : { ...local, tasks: [...local.tasks, other] },
        changed: !has,
        summary: has ? NO_CHANGE : { added: 1, updated: 0, removed: 0 },
      };
    });

    await syncNow();
    // 云端那条收下了，本机那条也还在——两边都留住
    expect(titles(appStore.getState().data)).toContain("往返期间记的一条");
    expect(titles(appStore.getState().data)).toContain("另一台设备记的");

    // 而且立刻排了一轮新的，快照就是「合完之后」这份：那条改动这才真的上了云
    await new Promise((r) => setTimeout(r, 0));
    expect(syncOnce).toHaveBeenCalledTimes(2);
    expect(titles(seen[1])).toContain("往返期间记的一条");
    expect(syncStore.getState().dirty).toBe(false);
    await flushSave();
    expect(titles(onDisk())).toContain("往返期间记的一条");
  });

  it("同步把云端那份合并回来（引用换了但内容就是刚推上去的）不算「又改过」", async () => {
    syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => {
      const merged: AppData = { ...local, tasks: [...local.tasks, newTask({ title: "另一台设备记的" })] };
      return { rev: 11, data: merged, changed: true, summary: { added: 1, updated: 0, removed: 0 } };
    });
    const res = await syncNowChecked();
    expect(res).toEqual({ ok: true, rev: 11 });
    expect(syncStore.getState().dirty).toBe(false);
  });
});

describe("闸门不许搭一轮早就在飞的旧同步的顺风车", () => {
  it("不带 force 时照旧复用在途那一轮", async () => {
    const gate = deferred<cloud.SyncOutcome>();
    let snap: AppData | null = null;
    syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => {
      snap = local;
      return gate.promise;
    });
    const a = syncNow();
    const b = syncNow();
    gate.resolve({ rev: 9, data: snap!, changed: false, summary: NO_CHANGE });
    await Promise.all([a, b]);
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("闸门走 force：排队跑一轮全新的，快照是当前这份数据", async () => {
    const gate = deferred<cloud.SyncOutcome>();
    const seen: AppData[] = [];
    syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => {
      seen.push(local);
      if (seen.length === 1) return gate.promise;
      return { rev: 12, data: local, changed: false, summary: NO_CHANGE };
    });

    const inflight = syncNow(); // 防抖那一轮刚起飞
    addTask({ title: "起飞之后记的一条" }); // 它不在那一轮的快照里
    const checked = syncNowChecked();
    gate.resolve({ rev: 9, data: seen[0], changed: false, summary: NO_CHANGE });
    await inflight;
    const res = await checked;

    // 3 次不是 2 次，三次各有各的名分（都不是空转）：
    // ① 防抖那一轮，快照是「起飞那一刻」，没有新记的那条；
    // ② 它落地时发现数据漂移了，自己补跑一轮 chained，快照是当前这份；
    // ③ 闸门 force 的那一轮——它要的是「**当前这份**上去了」，不许搭前两轮的顺风车。
    // 补跑那一轮自己不再漂移（快照就是当前这份），所以到此为止，不会接力下去
    expect(syncOnce).toHaveBeenCalledTimes(3);
    expect(titles(seen[0])).not.toContain("起飞之后记的一条");
    expect(titles(seen[1])).toContain("起飞之后记的一条"); // 漂移补跑
    expect(titles(seen[2])).toContain("起飞之后记的一条"); // 闸门那一轮
    expect(res).toEqual({ ok: true, rev: 12 });
    // 再等几拍：没有第四轮，说明没人在原地空转
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(syncOnce).toHaveBeenCalledTimes(3);
  });
});

describe("从云端整份覆盖本机：备份是硬前置", () => {
  beforeEach(() => {
    pullOnly.mockResolvedValue({ rev: 7, data: localData("云端的事"), updatedAt: null });
  });

  it("备份写不成（磁盘满 / 目录被占）：中止，本机一个字节都不写", async () => {
    env.tauri = true;
    snapshotBackup.mockRejectedValueOnce(new Error("磁盘没空间了"));

    await expect(restoreFromCloud()).rejects.toThrow(/本机数据一条未动/);
    // 内存和盘上都还是本机那份
    expect(titles(appStore.getState().data)).toEqual(["本机的事"]);
    expect(titles(onDisk())).toEqual(["本机的事"]);
  });

  it("**本机本来就没有数据**：没有退路可言，直接放行覆盖", async () => {
    // snapshot_backup 在没有 data.json 时返回 null，这不是写失败。
    // 触发路径：清空本机 → reload → 重新登录那一轮同步没成 → 盘上确实没有 data.json，
    // 用户照着界面点「从云端覆盖到这台设备」。把这种情况当成写失败，
    // 会把清空之后唯一那条恢复路径堵死，报的原因还是错的（盘既没满也没只读）
    env.tauri = true;
    snapshotBackup.mockResolvedValueOnce(null);
    const out = await restoreFromCloud();
    expect(out.backup).toBeNull();
    expect(titles(appStore.getState().data)).toEqual(["云端的事"]);
    expect(titles(onDisk())).toEqual(["云端的事"]);
  });

  it("备份写成了才覆盖，并把备份文件名交出去给用户看", async () => {
    env.tauri = true;
    const out = await restoreFromCloud();
    expect(out.backup).toBe("pre-restore-20260831-101010.json");
    expect(titles(appStore.getState().data)).toEqual(["云端的事"]);
    expect(titles(onDisk())).toEqual(["云端的事"]);
  });

  it("浏览器 / 测试环境本来就没有文件系统：允许没有备份继续", async () => {
    env.tauri = false;
    const out = await restoreFromCloud();
    expect(titles(appStore.getState().data)).toEqual(["云端的事"]);
    expect(out.rev).toBe(7);
  });

  it("成功 toast 里带上备份位置，用户看得见退路在哪", () => {
    const start = accountPanelSource.indexOf("已用云端第");
    expect(start).toBeGreaterThan(0);
    expect(accountPanelSource.slice(start, start + 200)).toContain("out.backup");
  });
});

describe("清空之后那一次启动，不许建默认账本", () => {
  it("有 freshStart 标记：空账本开局，一个字都不落盘", async () => {
    env.fresh = true;
    localStorage.clear(); // 盘上确实被清干净了
    await initStore();

    const d = appStore.getState().data;
    expect(d.lists).toEqual([]);
    expect(d.tasks).toEqual([]);
    // 没落盘：重新登录之前，盘上一个字都不该有
    expect(localStorage.getItem("acorn-data")).toBeNull();
  });

  it("对照组：正常首次启动照旧建默认清单并落盘", async () => {
    env.fresh = false;
    localStorage.clear();
    await initStore();

    expect(appStore.getState().data.lists.map((l) => l.name)).toEqual(["工作", "生活"]);
    expect(localStorage.getItem("acorn-data")).not.toBeNull();
  });

  it("标记只能放 Rust 侧的 config.json——localStorage 会被 clearLocalPrefs 一起扫掉", () => {
    // clearLocalPrefs 按 acorn- 前缀全扫，标记放那儿等于没放
    expect(rustSource).toContain("\"freshStart\": true");
    expect(rustSource).toContain("fn take_fresh_start");
  });
});

describe("卸载钩子里不许有任何破坏性动作", () => {
  const body = nsisHookSource.slice(nsisHookSource.indexOf("!macro NSIS_HOOK_PREUNINSTALL"));

  it("只删登录令牌和 WebView2 缓存，一条待办都不碰", () => {
    expect(body).toContain("Delete \"$APPDATA\\${BUNDLEID}\\auth.json\"");
    expect(body).toContain("RMDir /r \"$LOCALAPPDATA\\${BUNDLEID}\\EBWebView\"");
  });

  it("绝不递归删用户自选的数据文件夹（那可能就是「我的文档」或一块共用盘）", () => {
    expect(body).not.toContain("datadir.txt");
    // 唯一允许的 RMDir /r 就是 EBWebView 那一条
    const recursive = body.match(/RMDir \/r [^\n]*/g) ?? [];
    expect(recursive).toEqual(['RMDir /r "$LOCALAPPDATA\\${BUNDLEID}\\EBWebView"']);
  });

  it("不碰模板自带的那两个应用数据目录——那归卸载向导的勾选框管", () => {
    expect(body).not.toContain('"$APPDATA\\${BUNDLEID}"');
    expect(body).not.toContain('"$LOCALAPPDATA\\${BUNDLEID}"');
  });

  it("升级闸留着，而且升级路径真的会带上 /UPDATE 让它成立", () => {
    expect(body).toContain("$UpdateMode <> 1");
    // 以前 App 内升级走 openPath，递不进命令行参数，$UpdateMode 两侧都是 0，
    // 于是每升一次这道闸就漏一次，auth.json 被删、用户静默登出。
    // 现在由 Rust 的 run_installer 带 /UPDATE 起安装器，注释里必须记着这件事
    expect(nsisHookSource).toContain("/UPDATE");
    expect(nsisHookSource).toContain("run_installer");
  });

  it("升级路径确实带了 /UPDATE：拉安装器的是 run_installer，不是 openPath", () => {
    // Rust 侧真的把参数递进去了
    expect(rustSource).toContain("fn run_installer");
    expect(rustSource).toContain('.arg("/UPDATE")');
    // 前端桌面分支不许再退回 openPath（安卓那一支还得留着，它没有安装器命令行可言）
    const install = updaterSource.slice(updaterSource.indexOf("export async function installPackage"));
    expect(install).toContain('inv("run_installer"');
  });
});

describe("清空的范围要跟「找回数据」扫的范围一样宽，但得有护栏", () => {
  const purge = rustSource.slice(
    rustSource.indexOf("fn purge_local_data"),
    rustSource.indexOf("fn list_purge_targets"),
  );
  const targets = rustSource.slice(
    rustSource.indexOf("fn purge_targets"),
    rustSource.indexOf("fn list_purge_targets"),
  );
  const helper = rustSource.slice(
    rustSource.indexOf("fn purge_data_files"),
    rustSource.indexOf("fn take_fresh_start"),
  );

  it("复用 candidate_dirs()，而且在清 recentDirs 之前就取", () => {
    expect(targets).toContain("candidate_dirs(current)");
    // recentDirs 被写空之前就得把候选目录取到手，否则换过文件夹的用户扫不全
    const cleared = purge.indexOf('"recentDirs": Vec::<String>::new()');
    expect(cleared).toBeGreaterThan(0);
    expect(purge.indexOf("purge_targets(&dir)")).toBeLessThan(cleared);
  });

  it("**只碰真有 data.json 的目录**：recentDirs 里躺着的是用户自选的普通文件夹", () => {
    // 没有这道护栏，「清空本机」就是对最多 8 个用户自选文件夹 + 沙箱镜像逐个动手
    expect(targets).toContain("data_file(&d).exists()");
    // 当前数据目录例外：那就是橡果正用着的那份，即使 data.json 缺了也该清干净
    expect(targets).toContain("d == current");
  });

  it("确认框拿得到这份名单，用户按确定之前看得见每一条路径", () => {
    expect(rustSource).toContain("fn list_purge_targets");
    expect(accountPanelSource).toContain("purgeTargets()");
    const wipeConfirm = accountPanelSource.slice(
      accountPanelSource.indexOf("const doSignOutAndWipe"),
      accountPanelSource.indexOf("const doSignOutOnly"),
    );
    expect(wipeConfirm).toContain("dirs.length > 0");
  });

  it("只按文件名删自己写出来的东西，绝不 RMDir 目录本身", () => {
    // 查的是**调用**而不是裸字符串——注释里说明「为什么不能 remove_dir_all」是应该的
    expect(purge).not.toContain("fs::remove_dir_all(");
    // backups 也一样：那个目录不归橡果独占，用户可能把数据目录选成「我的文档」，
    // 而 backups 是个再常见不过的目录名，递归删下去会把别人的东西一起删光
    expect(helper).not.toContain("fs::remove_dir_all(");
    expect(helper).toContain("is_acorn_backup_name");
    expect(helper).toContain("fs::remove_dir(&bdir)");
    for (const name of ["data.json.tmp", "data.json.old", "data.json.corrupt-", "backups", "smoke-report.json", ".acorn-probe"]) {
      expect(helper).toContain(name);
    }
  });

  it("橡果写出去的每一种备份名都在清理集合里——加一种就得登记一种", () => {
    // Settings 里的导入前备份是前端自己拼的文件名，Rust 那边的前缀集合必须盖得住它
    expect(settingsSource).toContain("pre-import-");
    expect(rustSource).toContain('const BACKUP_PREFIXES: [&str; 3] = ["data", "pre-restore", "pre-import"]');
    // snapshot_backup 只收登记过的前缀，堵死「写得出来却清不掉」那条缝
    const snap = rustSource.slice(
      rustSource.indexOf("fn snapshot_backup"),
      rustSource.indexOf("清空本机（登出时的隐私路径）"),
    );
    expect(snap).toContain("BACKUP_PREFIXES.contains");
  });
});

describe("登录状态下必须有两条出路", () => {
  const signedIn = accountPanelSource.slice(
    accountPanelSource.indexOf("if (session && step === \"signedIn\")"),
  );

  it("「退出登录并清空本机」和「只退出登录，保留本机」都常驻，清空那条排前面", () => {
    const wipe = signedIn.indexOf("退出登录并清空本机");
    const keep = signedIn.indexOf("只退出登录，保留本机");
    expect(wipe).toBeGreaterThan(0);
    expect(keep).toBeGreaterThan(0);
    expect(wipe).toBeLessThan(keep);
  });

  it("「只退出登录」走的是 signOut，不碰任何本机数据", () => {
    const start = accountPanelSource.indexOf("const doSignOutOnly");
    const tail = accountPanelSource.slice(start, start + 400);
    expect(tail).toContain("signOut()");
    expect(tail).not.toContain("wipeLocalData");
    expect(tail).not.toContain("purgeLocalFiles");
  });
});
