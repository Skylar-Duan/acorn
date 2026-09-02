// 登录那一刻本机数据怎么办 + 首次启动的两个判据。
//
// 起因（用户 2026-09-02 在手机上第一次装 v1.10.1 之后的三条反馈）：
// ①「登录后，已经有的东西应该全部删除，这里两个『工作』的分类肯定不行」
//    —— 新装的橡果自带「工作 / 生活」，一登录跟云端一合就出现两个「工作」；
// ②「下载后没有检查更新的消息框」—— 查过版本却什么都不说；
// ③ 登录入口要从设置页里挪出来，首启该主动请人登录。
//
// 这一份钉的是判据本身。**下游动作是整份覆盖本机数据**，判松一点就是真丢数据，
// 所以每个分支都得有用例，尤其是那些「不算全新」的分支——它们才是保命的那一半。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import appSource from "../src/App.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import accountPanelSource from "../src/components/AccountPanel.tsx?raw";
import { defaultData, newTask } from "../src/core/model";
import type { AppData, List, Task } from "../src/core/model";
import { appStore, clearUndo, flushSave } from "../src/core/store";
import * as cloud from "../src/core/cloud";
import * as persist from "../src/core/persist";
import { signOut, syncStore } from "../src/core/syncCtl";
import { dedupeListsByName, mergeData } from "../src/core/merge";
import {
  DEFAULT_LIST_NAMES, LOGIN_LATER_KEY, isLoginLater, isPristineLocal, markLoginLater,
  planLoginData, shouldOfferLogin,
} from "../src/core/fresh";
import { signInWithLocalData } from "../src/core/loginCtl";
import type { LoginAsk } from "../src/core/loginCtl";
import {
  firstRunKind, readLastVersion, rememberLaunch, updateFootState,
} from "../src/core/updateCtl";

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return {
    ...actual,
    syncOnce: vi.fn(),
    pullOnly: vi.fn(),
    whoAmI: vi.fn(),
    saveSession: vi.fn(async () => {}),
  };
});

vi.mock("../src/core/persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/persist")>();
  return { ...actual, snapshotBackup: vi.fn(async () => "pre-restore-20260902-101010.json") };
});

const syncOnce = cloud.syncOnce as unknown as Mock;
const pullOnly = cloud.pullOnly as unknown as Mock;
const whoAmI = cloud.whoAmI as unknown as Mock;

const SESSION: cloud.Session = { token: "tok", email: "a@b.c", rev: 3, syncedAt: null };
const OLD = "2026-01-01T00:00:00.000Z";

function list(id: string, name: string, order: number, updatedAt = OLD): List {
  return { id, name, color: "clay", order, updatedAt };
}

function task(id: string, title: string, listId: string | null, extra: Partial<Task> = {}): Task {
  return { ...newTask({ title }), id, listId, updatedAt: OLD, ...extra };
}

/** 刚装好、一个字都没记过的样子 */
function brandNew(): AppData {
  return defaultData();
}

// ---------------------------------------------------------------- A · 全新判据

describe("A · 本机是不是「全新的」（宁可判严不判松）", () => {
  it("刚装好，只有默认那两条清单：算全新", () => {
    expect(isPristineLocal({ data: brandNew(), everSynced: false })).toBe(true);
  });

  it("默认清单名就是「工作 / 生活」——判据跟着 defaultData 走，不写死", () => {
    expect([...DEFAULT_LIST_NAMES]).toEqual(["工作", "生活"]);
  });

  it("记过一条事：不算全新，绝不覆盖", () => {
    const d = brandNew();
    d.tasks = [task("t1", "交周报", null)];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("那条事已经在回收站里：照样不算——回收站里的东西也是用户的东西", () => {
    const d = brandNew();
    d.tasks = [task("t1", "删掉的事", null, { deletedAt: OLD })];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("那条是习惯：照样不算", () => {
    const d = brandNew();
    d.tasks = [task("t1", "每天喝水", null, { kind: "habit", checkIns: ["2026-09-01"] })];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("默认清单被改过名：不算——改过名就是用过", () => {
    const d = brandNew();
    d.lists = [list("a", "公司", 0), list("b", "生活", 1)];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("自己多建了一条清单：不算", () => {
    const d = brandNew();
    d.lists = [...d.lists, list("c", "读书", 2)];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("自己删掉了一条默认清单：不算——留下的那条是他挑过的", () => {
    const d = brandNew();
    d.lists = [d.lists[0]];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("清单一条都没有：算全新——那正是「清空本机」之后那一次启动的样子", () => {
    const d = brandNew();
    d.lists = [];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(true);
  });

  it("有专注记录：不算", () => {
    const d = brandNew();
    d.sessions = [{ taskId: null, date: "2026-09-01", minutes: 25, startedAt: OLD }];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("墓碑里有东西（彻底删过）：不算", () => {
    const d = brandNew();
    d.graveyard = [{ id: "gone", at: OLD }];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("排过需求方顺序：不算——需求方不是记录，但排过就是用过", () => {
    const d = brandNew();
    d.settings = { ...d.settings, whoOrder: ["李哥"] };
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("这台设备成功同步过：一律不算，哪怕现在看着是空的", () => {
    expect(isPristineLocal({ data: brandNew(), everSynced: true })).toBe(false);
  });
});

describe("A · 登录时的处置决策表", () => {
  it("本机全新 + 云端有内容 → 覆盖", () => {
    expect(planLoginData({ pristine: true, cloudHasData: true })).toBe("replace");
  });

  it("本机有内容 + 云端有内容 → 问用户", () => {
    expect(planLoginData({ pristine: false, cloudHasData: true })).toBe("ask");
  });

  it("云端是空的 → 一律合并，不问也不覆盖（第一台设备开账号就是这样）", () => {
    expect(planLoginData({ pristine: true, cloudHasData: false })).toBe("merge");
    expect(planLoginData({ pristine: false, cloudHasData: false })).toBe("merge");
  });
});

// ------------------------------------------------------- A · 同名清单去重

describe("A · 同名清单去重", () => {
  const AT = "2026-09-02T10:00:00.000Z";

  it("两条「工作」并成一条，任务全归到留下的那条名下", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("cloud", "工作", 0), list("local", "工作", 1)],
      tasks: [task("t1", "云端的事", "cloud"), task("t2", "本机的事", "local")],
    };
    const out = dedupeListsByName(d, AT);
    expect(out.folded).toBe(1);
    expect(out.moved).toBe(1);
    expect(out.data.lists.map((l) => l.name)).toEqual(["工作"]);
    expect(out.data.tasks.map((t) => t.listId)).toEqual(["cloud", "cloud"]);
  });

  it("留下的是任务多的那条——空的默认清单不该让所有任务集体搬家", () => {
    const d: AppData = {
      ...brandNew(),
      // 空的那条更「老」，但它是空的：任务多的那条赢
      lists: [list("empty", "工作", 0, "2020-01-01T00:00:00.000Z"), list("used", "工作", 1)],
      tasks: [task("t1", "甲", "used"), task("t2", "乙", "used")],
    };
    const out = dedupeListsByName(d, AT);
    expect(out.data.lists.map((l) => l.id)).toEqual(["used"]);
    expect(out.moved).toBe(0); // 一条任务都不用搬
  });

  it("任务一样多就留老的——老的那条的颜色和位置是用户排过的", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [
        list("new", "工作", 0, "2026-08-01T00:00:00.000Z"),
        list("old", "工作", 1, "2025-01-01T00:00:00.000Z"),
      ],
      tasks: [],
    };
    expect(dedupeListsByName(d, AT).data.lists.map((l) => l.id)).toEqual(["old"]);
  });

  it("剩下的清单顺序一个字没动：用户看见的只是少了重复那条", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("a", "工作", 0), list("b", "生活", 1), list("c", "工作", 2), list("e", "读书", 3)],
      tasks: [task("t1", "甲", "c")],
    };
    // c 有任务所以 c 留下、a 被折掉；剩下三条的先后原样
    expect(dedupeListsByName(d, AT).data.lists.map((l) => l.id)).toEqual(["b", "c", "e"]);
  });

  it("被改挂的任务重新盖了改动时刻戳——不盖的话别的设备手里那份会赢，listId 指向一条已经不存在的清单", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("keep", "工作", 0), list("gone", "工作", 1)],
      // keep 名下两条、gone 名下一条 → keep 留下，gone 被折掉
      tasks: [
        task("still", "没动的", "keep"), task("still2", "也没动", "keep"),
        task("moved", "搬过来的", "gone"),
      ],
    };
    const out = dedupeListsByName(d, AT);
    expect(out.data.lists.map((l) => l.id)).toEqual(["keep"]);
    expect(out.data.tasks.find((t) => t.id === "moved")!.updatedAt).toBe(AT);
    // 没动的那条不许被顺手盖戳，否则一次登录把整库标成「本机刚改过」
    expect(out.data.tasks.find((t) => t.id === "still")!.updatedAt).toBe(OLD);
  });

  it("被折掉的那条立墓碑：别的设备同步过来也不会把它拉回去", () => {
    const now = new Date().toISOString();
    const d: AppData = {
      ...brandNew(),
      lists: [list("keep", "工作", 0), list("gone", "工作", 1)],
      // 任务都挂在 keep 名下 → 空着的 gone 被折掉
      tasks: [task("t1", "甲", "keep")],
    };
    const cleaned = dedupeListsByName(d, now).data;
    expect(cleaned.graveyard.map((g) => g.id)).toEqual(["gone"]);
    // 另一台设备手里还揣着被折掉那条：合并之后它不许复活
    const stale: AppData = { ...brandNew(), lists: [list("gone", "工作", 1)], tasks: [] };
    const merged = mergeData(cleaned, stale).data;
    expect(merged.lists.map((l) => l.id)).toEqual(["keep"]);
  });

  it("三条同名也只留一条", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("a", "工作", 0), list("b", "工作", 1), list("c", "工作", 2)],
      tasks: [task("t1", "甲", "b"), task("t2", "乙", "c")],
    };
    const out = dedupeListsByName(d, AT);
    expect(out.folded).toBe(2);
    expect(out.data.lists).toHaveLength(1);
    expect(new Set(out.data.tasks.map((t) => t.listId)).size).toBe(1);
  });

  it("名字前后有空格算同一个——用户看见的是一样的两条", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("a", "工作", 0), list("b", " 工作 ", 1)],
      tasks: [],
    };
    expect(dedupeListsByName(d, AT).folded).toBe(1);
  });

  it("没有重名时原样返回同一个对象——同步那边靠对象身份判断动没动过，不能白推一轮", () => {
    const d = brandNew();
    const out = dedupeListsByName(d, AT);
    expect(out.data).toBe(d);
    expect(out.folded).toBe(0);
  });

  it("随手记（listId 为 null）的事一条都不受影响", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("a", "工作", 0), list("b", "工作", 1)],
      tasks: [task("t1", "随手记的", null)],
    };
    const out = dedupeListsByName(d, AT);
    expect(out.data.tasks[0].listId).toBeNull();
    expect(out.data.tasks[0].updatedAt).toBe(OLD);
  });
});

// ------------------------------------------------------- A · 登录那一刻的实际走向

describe("A · 登录时怎么处置本机数据", () => {
  /** 云端那一份：一条「工作」清单 + 一条事 */
  function cloudData(): AppData {
    return {
      ...defaultData(),
      lists: [list("cloud-work", "工作", 0)],
      tasks: [task("c1", "云端记的事", "cloud-work")],
    };
  }

  beforeEach(async () => {
    vi.useRealTimers();
    await flushSave();
    await signOut(); // 停掉上一条用例留下的数据监听与防抖
    clearUndo();
    localStorage.clear();
    syncOnce.mockReset();
    pullOnly.mockReset();
    whoAmI.mockReset();
    syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => ({
      rev: 9, data: local, changed: false, summary: { added: 0, updated: 0, removed: 0 },
    }));
    pullOnly.mockResolvedValue({ rev: 7, data: cloudData(), updatedAt: OLD });
    whoAmI.mockResolvedValue({
      email: "a@b.c", rev: 7, updatedAt: OLD, device: "Android · 橡果 1.10.1", hasData: true,
    });
    appStore.setState({
      data: brandNew(), loaded: true, loadError: null, dataFromNewer: null, rescue: null, wiped: false,
    });
    syncStore.setState({ session: null, phase: "off", message: "", dirty: false });
  });

  it("本机全新 + 云端有内容 → 用云端整份覆盖，**不是**合并", async () => {
    const out = await signInWithLocalData({ ...SESSION });
    expect(out.action).toBe("replace");
    expect(pullOnly).toHaveBeenCalledTimes(1);
    // 合并那条路一次都不许走：走了就会把本机的默认清单推上云
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("覆盖之后自带的默认清单没了，侧栏不会出现两个「工作」", async () => {
    await signInWithLocalData({ ...SESSION });
    const d = appStore.getState().data;
    expect(d.lists.map((l) => l.name)).toEqual(["工作"]);
    expect(d.tasks.map((t) => t.title)).toEqual(["云端记的事"]);
  });

  it("覆盖前照现有规矩留了一份备份（走的就是「从云端覆盖到这台设备」那条现成的路）", async () => {
    const out = await signInWithLocalData({ ...SESSION });
    expect(persist.snapshotBackup).toHaveBeenCalledWith("pre-restore");
    expect(out.restored?.backup).toBe("pre-restore-20260902-101010.json");
    expect(out.restored?.rev).toBe(7);
  });

  it("本机有内容 + 云端有内容 → 停下来问用户，不擅自决定", async () => {
    appStore.setState({ data: { ...brandNew(), tasks: [task("t1", "本机的事", null)] } });
    const ask = vi.fn(async (_info: LoginAsk) => "merge" as const);
    const out = await signInWithLocalData({ ...SESSION }, ask);
    expect(out.plan).toBe("ask");
    expect(out.asked).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    // 问法里得有料：云端第几版、本机有几条，用户才判得了
    expect(ask.mock.calls[0][0]).toMatchObject({ rev: 7, localTasks: 1 });
  });

  it("用户选了合并 → 走合并，本机那条事还在", async () => {
    appStore.setState({ data: { ...brandNew(), tasks: [task("t1", "本机的事", null)] } });
    const out = await signInWithLocalData({ ...SESSION }, async () => "merge");
    expect(out.action).toBe("merge");
    expect(syncOnce).toHaveBeenCalledTimes(1);
    expect(pullOnly).not.toHaveBeenCalled();
  });

  it("用户选了覆盖 → 走覆盖", async () => {
    appStore.setState({ data: { ...brandNew(), tasks: [task("t1", "本机的事", null)] } });
    const out = await signInWithLocalData({ ...SESSION }, async () => "replace");
    expect(out.action).toBe("replace");
    expect(pullOnly).toHaveBeenCalledTimes(1);
    expect(appStore.getState().data.tasks.map((t) => t.title)).toEqual(["云端记的事"]);
  });

  it("界面还没接上问法时默认合并——绝不在没人拍板的时候覆盖", async () => {
    appStore.setState({ data: { ...brandNew(), tasks: [task("t1", "本机的事", null)] } });
    const out = await signInWithLocalData({ ...SESSION });
    expect(out.asked).toBe(true);
    expect(out.action).toBe("merge");
    expect(pullOnly).not.toHaveBeenCalled();
  });

  it("云端还是空的 → 照常合并，不问也不覆盖（第一台设备开账号）", async () => {
    whoAmI.mockResolvedValue({
      email: "a@b.c", rev: 0, updatedAt: null, device: "", hasData: false,
    });
    const ask = vi.fn(async (_info: LoginAsk) => "replace" as const);
    const out = await signInWithLocalData({ ...SESSION }, ask);
    expect(out.plan).toBe("merge");
    expect(ask).not.toHaveBeenCalled();
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("云端有没有东西问不出来（断网）→ 一律合并，本机一个字不动", async () => {
    whoAmI.mockRejectedValue(new cloud.ApiError(0, "offline", "连不上服务器"));
    const out = await signInWithLocalData({ ...SESSION });
    expect(out.action).toBe("merge");
    expect(pullOnly).not.toHaveBeenCalled();
  });

  it("覆盖半路失败（断网）→ 退回合并，登录本身照样算成功", async () => {
    pullOnly.mockRejectedValue(new cloud.ApiError(0, "offline", "连不上服务器"));
    const out = await signInWithLocalData({ ...SESSION });
    expect(out.action).toBe("merge");
    expect(syncStore.getState().session?.email).toBe("a@b.c");
  });

  it("登录之后顺手把重名清单并掉——用户账号里现在就躺着两条「工作」", async () => {
    // 云端那份自己就带着一对重复（用户手机推上去的那一对）
    pullOnly.mockResolvedValue({
      rev: 7,
      data: {
        ...defaultData(),
        lists: [list("w1", "工作", 0), list("w2", "工作", 1)],
        tasks: [task("c1", "云端记的事", "w2")],
      },
      updatedAt: OLD,
    });
    const out = await signInWithLocalData({ ...SESSION });
    expect(out.folded).toBe(1);
    expect(appStore.getState().data.lists.map((l) => l.name)).toEqual(["工作"]);
    // 清干净的这份得推回云端，否则下次换台设备又是两条
    expect(syncOnce).toHaveBeenCalled();
  });

  it("AccountPanel 三个入口（登录/验证/改密码）都走这条判断，没有漏网的 adoptSession", () => {
    expect(accountPanelSource).toContain("signInWithLocalData");
    expect(accountPanelSource).not.toContain("adoptSession");
    expect((accountPanelSource.match(/settleSignIn\(/g) ?? []).length).toBe(4); // 1 定义 + 3 调用
  });
});

// ---------------------------------------------------------------- B · 首次启动

describe("B · 这一版是不是第一次开", () => {
  it("从没启动过（连版本号都没记过）→ install", () => {
    expect(firstRunKind(null, "1.10.1")).toBe("install");
    expect(firstRunKind("", "1.10.1")).toBe("install");
  });

  it("同一个版本又开了一次 → same，什么都不该弹", () => {
    expect(firstRunKind("1.10.1", "1.10.1")).toBe("same");
  });

  it("装了新版之后第一次开 → upgrade", () => {
    expect(firstRunKind("1.9.1", "1.10.1")).toBe("upgrade");
  });

  it("降级安装也算这一版第一次开——它同样该看见这一版的日志", () => {
    expect(firstRunKind("1.10.1", "1.9.1")).toBe("upgrade");
  });

  it("rememberLaunch 写回去之后再问就是 same 了", () => {
    localStorage.clear();
    expect(firstRunKind(readLastVersion(), "1.10.1")).toBe("install");
    rememberLaunch("1.10.1");
    expect(readLastVersion()).toBe("1.10.1");
    expect(firstRunKind(readLastVersion(), "1.10.1")).toBe("same");
  });

  it("键名按 acorn- 前缀，清空本机时会被一并扫掉", () => {
    localStorage.clear();
    rememberLaunch("1.10.1");
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("acorn-"));
    expect(keys).toContain("acorn-last-version");
  });

  it("App 只在 upgrade 那一档弹更新日志：第一次装橡果的人该先看见登录，不是版本历史", () => {
    expect(appSource).toContain('firstRun === "upgrade"');
    expect(appSource).toContain("setChangelogOpen(true)");
  });
});

describe("B · 侧栏那截版本检查状态", () => {
  it("这台设备根本没有更新能力：不显示", () => {
    expect(updateFootState({ kind: "latest" }, false)).toBeNull();
  });

  it("这次还没查过：不显示（不是故障，不值得占地方）", () => {
    expect(updateFootState(null, true)).toBeNull();
  });

  it("查成功且已是最新：一句「已是最新」，不标红", () => {
    expect(updateFootState({ kind: "latest" }, true)).toEqual({
      bad: false, text: "已是最新", openable: false,
    });
  });

  it("查到新版：说清是哪一版，而且点得动", () => {
    expect(updateFootState({ kind: "found", version: "1.11.0" }, true)).toEqual({
      bad: false, text: "有新版本 v1.11.0", openable: true,
    });
  });

  it("查失败：标红说出来，不许骗人说「已经是最新版了」", () => {
    expect(updateFootState({ kind: "failed" }, true)).toEqual({
      bad: true, text: "版本检查失败", openable: false,
    });
  });

  it("侧栏真的把它渲染出来了，而且点得动那条能打开更新弹窗", () => {
    expect(sidebarSource).toContain("updateFootState");
    const foot = sidebarSource.slice(sidebarSource.indexOf('className="foot"'));
    expect(foot).toContain("upd.text");
    expect(foot).toContain("openFoundUpdate");
  });
});

// ---------------------------------------------------------------- C · 首启要不要请人登录

describe("C · 首次启动该不该请人登录", () => {
  beforeEach(() => localStorage.clear());

  it("没登录 + 本机全新 + 没点过「以后再说」→ 请他登录", () => {
    expect(shouldOfferLogin({ signedIn: false, pristine: true, later: false })).toBe(true);
  });

  it("已经登录了：不弹", () => {
    expect(shouldOfferLogin({ signedIn: true, pristine: true, later: false })).toBe(false);
  });

  it("本机已经记了东西：不弹——老用户不该被一个登录框拦在门口", () => {
    expect(shouldOfferLogin({ signedIn: false, pristine: false, later: false })).toBe(false);
  });

  it("点过「以后再说」：不弹", () => {
    expect(shouldOfferLogin({ signedIn: false, pristine: true, later: true })).toBe(false);
  });

  it("「以后再说」记得住、读得出来", () => {
    expect(isLoginLater()).toBe(false);
    markLoginLater();
    expect(isLoginLater()).toBe(true);
    expect(localStorage.getItem(LOGIN_LATER_KEY)).toBe("1");
  });

  it("键名按 acorn- 前缀：清空本机之后本来就该重新问一次", () => {
    expect(LOGIN_LATER_KEY.startsWith("acorn-")).toBe(true);
  });

  it("判据可以直接拿 isPristineLocal 的结果喂——两处是同一条口径", () => {
    const pristine = isPristineLocal({ data: brandNew(), everSynced: false });
    expect(shouldOfferLogin({ signedIn: false, pristine, later: false })).toBe(true);
  });
});
