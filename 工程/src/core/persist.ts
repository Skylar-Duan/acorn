// 存取层：Tauri 环境走 Rust 命令（原子写 + 备份）；浏览器（网页版 / vite dev / 测试）走 IndexedDB。
//
// v1.15.0 网页版上线，浏览器那条路从 localStorage 换成了 IndexedDB：
// localStorage 一个域名总共就 5 MB，而**账本本身的上限就是 5 MB**（云端单账号给的额度），
// 也就是说一本用满的账本在浏览器里根本存不下——存到一半抛 QuotaExceededError，
// 用户看到的是「保存失败」，东西却已经记进去了。IndexedDB 没有这条线（按剩余磁盘算）。
// localStorage 只留作兜底，而且**兜底分两种、名字必须分开**（混用一个键就再也分不清谁新谁旧）：
//   · acorn-data          老用户本机存着的那份，比库里旧，读到就顺手搬进 IndexedDB
//   · acorn-data-fallback 这一次没能写进库、兜下来的那份，比库里新，读的时候优先
// 实在没有 IndexedDB 的环境（jsdom、某些浏览器的隐私模式）就直接用 acorn-data 当正本。
//
// **上层一行都不用改**：loadData / saveData 的样子跟以前一模一样。

import type { AppData } from "./model";
import { DATA_VERSION, migrate } from "./model";
import { unpack } from "./transfer";
import { inTauri } from "./platform";

// 「外面套着 Tauri 吗」的真源 v1.15.0 挪去了 platform.ts（跟 isWeb / isDesktopShell 摆在一起）。
// 这里转手再导出一次：全仓十几处 `import { inTauri } from "./persist"` 一个字都不用改
export { inTauri };

async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface DataStatus {
  dir: string;
  dirOk: boolean; // 目录存在且可写
  hasFile: boolean;
}

const LS_KEY = "acorn-data";

// ---------- 浏览器里的账本（IndexedDB，兜底 localStorage） ----------

const IDB_NAME = "acorn";
const IDB_STORE = "kv";
const IDB_KEY = "data";
/** 覆盖前留的那份退路（浏览器版的 pre-restore 备份）在 IndexedDB 里的位置 */
const IDB_PRE_KEY = "prerestore";

/** **这一次没能写进 IndexedDB**，于是兜在 localStorage 里的那份。
 *
 *  跟 LS_KEY 分开两个名字，是因为这两份东西的含义正相反，混用一个名字读的时候就再也分不清：
 *   · LS_KEY  = v1.14 及以前老用户留在本机的那份，**比 IndexedDB 里的旧**（搬家用）
 *   · FB_KEY  = 刚刚那次保存没进库、兜下来的那份，**比 IndexedDB 里的新**（读的时候要优先）
 *  只要 FB_KEY 还在，就说明「最近一次保存落在兜底这儿」，读路必须先看它。
 *  名字必须 `acorn-` 开头：清空本机是照这个前缀扫 localStorage 的。 */
const FB_KEY = "acorn-data-fallback";

/** 浏览器版「覆盖前先留一份」的退路，存在 localStorage 时用的名字（同样 `acorn-` 开头） */
const PRE_KEY = "acorn-data-prerestore";

/** 打开那个库。任何一步不顺利都返回 null（隐私模式、被策略禁掉、磁盘满、版本冲突），
 *  由调用方退回 localStorage——**存取层不许因为浏览器脾气怪就把数据丢在半路** */
/** 这个环境有 IndexedDB 吗。**同步问得出来**很要紧，见 webSave 里那条注释 */
function hasIdb(): boolean {
  return typeof indexedDB !== "undefined" && !!indexedDB;
}

let dbOnce: Promise<IDBDatabase | null> | null = null;
function idbOpen(): Promise<IDBDatabase | null> {
  if (dbOnce) return dbOnce;
  dbOnce = new Promise<IDBDatabase | null>((resolve) => {
    if (!hasIdb()) return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // 另一个标签页拦着不让升级：别干等，这次就走兜底
    req.onblocked = () => resolve(null);
  });
  return dbOnce;
}

/** 读出来的三态。**「打不开」和「里面是空的」必须分得开**：
 *  打不开（另一个标签页拦着升级、隐私模式、被企业策略禁掉、open 直接报错）要是被当成
 *  「里面没有数据」，上层就会判定这是台新设备 → 开机自动把云端那份取回来盖在本机上，
 *  而本机那份其实好端端在库里、只是这一刻没打开。所以打不开一律 ok:false，由调用方另作处置 */
type IdbRead = { ok: true; json: string | null } | { ok: false };

async function idbGet(key: string = IDB_KEY): Promise<IdbRead> {
  const db = await idbOpen();
  if (!db) return { ok: false };
  return new Promise<IdbRead>((resolve) => {
    try {
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      req.onsuccess = () =>
        resolve({ ok: true, json: typeof req.result === "string" ? req.result : null });
      // 读这一下本身失败，同样不等于「里面没有」
      req.onerror = () => resolve({ ok: false });
    } catch {
      resolve({ ok: false });
    }
  });
}

/** 写进去了返回 true。返回 false 不是「写坏了」，是「这儿写不了」，调用方还得去写 localStorage */
async function idbPut(json: string, key: string = IDB_KEY): Promise<boolean> {
  const db = await idbOpen();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(json, key);
      // 认事务的 oncomplete 而不是请求的 onsuccess：后者只说「排进去了」，
      // 事务还可能在提交那一下因为配额失败，那时数据并没有落下
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function idbDel(key: string = IDB_KEY): Promise<void> {
  const db = await idbOpen();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 请浏览器把这份数据算作「用户要留着的」，清理空间时别顺手扫掉。
 *  只是保险，不是保障：苹果那边**七天没打开就会清掉网站数据**，而已经「添加到主屏幕」的
 *  那一份不在此列——所以这一端真正的安全网是登录云账号 + 加到主屏幕，不是这一句。 */
let persistAsked = false;
function askPersist(): void {
  if (persistAsked) return;
  persistAsked = true;
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* 不支持就算了，本来也只是客气一句 */
  }
}

function lsGet(key: string = LS_KEY): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsDrop(key: string = LS_KEY): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 删不掉也不要紧：读的时候 IndexedDB 优先 */
  }
}

/** 浏览器里哪儿都存不下时给用户看的那句话。
 *  说清楚三件事：没存上、现在该干什么、别关页面（内存里那份还在，导出还来得及） */
function noRoom(e: unknown): Error {
  const why = e instanceof Error ? e.name : String(e);
  return new Error(`这台设备的浏览器存不下了（${why}）。先去账号页导出一份收着，别关页面。`);
}

/** 浏览器里读账本，**顺序就是正确性**：
 *   ① 兜底那份（FB_KEY）——它只会在「上一次保存没进 IndexedDB」时存在，所以它一定最新；
 *   ② IndexedDB 里那份；
 *   ③ 老地方（LS_KEY）：v1.14 及以前的用户升上来第一次读会命中，顺手搬进库里；
 *   ④ 三处都没有，而库又**打不开**：这不是「新设备」，得让上层知道读失败了（往下看）。
 *
 *  ①排在最前面是这一版补的那个洞：以前读路只认 IndexedDB，
 *  写路却会在库写不进去时悄悄兜到 localStorage，于是那次失败之后记的所有东西，
 *  关掉页面再打开就被库里那份旧账本原样盖掉，全程一句提示都没有。 */
async function webLoad(): Promise<string | null> {
  if (!hasIdb()) return lsGet();
  const fallback = lsGet(FB_KEY);
  if (fallback != null) return fallback;
  const got = await idbGet();
  if (got.ok && got.json != null) return got.json;
  const old = lsGet();
  if (old != null) {
    // 库打不开的时候别去搬家：搬不成还白删一次老地方那份
    if (got.ok && (await idbPut(old))) lsDrop();
    return old;
  }
  // 到这儿三处都空。库要是**打不开**（另一个标签页拦着、隐私模式、被策略禁掉），
  // 就绝不能报「没有数据」——上层会把它当成新设备，开机自动从云端取回一份盖在本机上。
  // 抛出去，用户看到的是「数据打不开」那一屏（还留着退路），而不是一本空账本
  if (!got.ok) {
    throw new Error(
      "打不开这台设备上存橡果数据的地方。可能是另一个标签页正开着橡果，也可能是浏览器的无痕模式不让存。关掉其他标签页再刷新试试。",
    );
  }
  return null;
}

/** 浏览器里写账本。IndexedDB 写成了就把另外两份（老地方、上次的兜底）都删掉——
 *  **多留一份就多一条会被误读的路**：读路认的就是「兜底还在 ⇒ 上次没写进库」。
 *
 *  两处都写不下去时**把错抛出去**：store 的 doSave 接着它弹「保存失败」。
 *  吞掉等于让用户在一屏「一切正常」的界面上继续记一下午，关掉页面全没了 */
async function webSave(json: string): Promise<void> {
  askPersist();
  // 压根没有 IndexedDB（jsdom、某些隐私模式）就当场写，**这条路上一个 await 都不许有**：
  // 上层那个「防抖 400 毫秒，到点就落盘」的时序是照着同步写立的，
  // 中间多一个微任务，定时器一到手数据还没在盘上（store.test 有一条钉着这一下）
  if (!hasIdb()) {
    try {
      localStorage.setItem(LS_KEY, json);
    } catch (e) {
      throw noRoom(e);
    }
    return;
  }
  if (await idbPut(json)) {
    lsDrop();
    lsDrop(FB_KEY);
    return;
  }
  // 库这一次没收下（配额、存储压力下被驱逐、iOS 从后台回来事务被 abort）。
  // 兜到 localStorage，并且**兜底这份从此就是最新的**——读路认 FB_KEY 优先，库里那份留着不删：
  // 它虽然旧，但万一 localStorage 哪天被清掉，它还是一条退路
  try {
    localStorage.setItem(FB_KEY, json);
  } catch (e) {
    throw noRoom(e);
  }
}

/** 浏览器里那份数据待的地方，说给人听。
 *  不写「IndexedDB」这种词：用户要知道的是「它只在这台设备上」，不是它叫什么 */
const WEB_DATA_PLACE = "存在这台设备的浏览器里";

export async function dataStatus(): Promise<DataStatus> {
  if (!inTauri) return { dir: WEB_DATA_PLACE, dirOk: true, hasFile: (await webLoad()) != null };
  return inv<DataStatus>("data_status");
}

export interface LoadResult {
  /** 文件不存在时是 null（首次运行） */
  data: AppData | null;
  /** 磁盘上那份数据的模型版本（认不出来时按 DATA_VERSION 算，等于「不当回事」） */
  schema: number;
  /** **磁盘上那份比本机新**：只是一个事实，供界面提示。**不是拒绝加载的理由** */
  tooNew: boolean;
}

/** 载入数据。
 *
 *  走 unpack 而不是直接 migrate：本地文件同样可能比本机新——降级安装、恢复一份新版本做的备份、
 *  或者数据目录放在两台机器共用的移动硬盘上（这个项目就是这么用的）。
 *  这种文件**照读**（v1.9.1 起）：不认识的字段原样留着，界面顶上给一条可关的提示条。
 *  能这么读是有前提的——migrate 顶层先铺开、墓碑不重建、version 取 max，三条缺一不可，
 *  缺了任何一条，读一次存一次就吃掉一层新数据。
 *
 *  unpack 解不出来的（文件损坏、根本不是橡果的数据）维持原样走 migrate：那条路通向
 *  「空账本 + 找回数据屏」，是现成的兜底，不要顺手改成报错。 */
export async function loadData(): Promise<LoadResult> {
  const raw = inTauri ? await inv<string | null>("load_data") : await webLoad();
  if (!raw) return { data: null, schema: DATA_VERSION, tooNew: false };
  const parsed = JSON.parse(raw) as unknown;
  const res = unpack(parsed);
  if (!res.ok) return { data: migrate(parsed), schema: DATA_VERSION, tooNew: false };
  return { data: res.data, schema: res.schema, tooNew: res.tooNew };
}

export async function saveData(data: AppData): Promise<void> {
  const json = JSON.stringify(data);
  if (!inTauri) {
    await webSave(json);
    return;
  }
  await inv("save_data", { json });
}

/** 当天首存前调用：滚动每日备份（保留 30 份），返回是否新建了备份 */
export async function ensureDailyBackup(): Promise<boolean> {
  if (!inTauri) return false;
  return inv<boolean>("ensure_daily_backup");
}

export interface BackupInfo { name: string; size: number }

export async function listBackups(): Promise<BackupInfo[]> {
  if (!inTauri) return [];
  return inv<BackupInfo[]>("list_backups");
}

/** 恢复前会先把当前数据另存一份 pre-restore 备份 */
export async function restoreBackup(name: string): Promise<void> {
  await inv("restore_backup", { name });
}

/** 覆盖类操作之前先把当前数据留一份备份，返回备份文件名。
 *  **返回 null 有两种，都不是失败**：浏览器环境没有文件系统；本机压根还没有 data.json
 *  （刚清空过、新机器、登录后那一轮同步没成）。真正写不进去时 Rust 侧抛错。
 *  前缀只收 Rust 侧登记过的那几个（BACKUP_PREFIXES）——它要拼进文件名，
 *  而清空本机时是照着这一组前缀删的 */
export async function snapshotBackup(prefix: string): Promise<string | null> {
  if (!inTauri) return null;
  return inv<string | null>("snapshot_backup", { prefix });
}

/** 浏览器版的「覆盖前先留一份」。
 *
 *  桌面那条路是 snapshotBackup：Rust 侧把 data.json 复制进 backups/。浏览器里没有文件系统，
 *  所以这份退路就存在这台设备自己身上——**能放进 IndexedDB 就放那儿**（账本可以到 5 MB，
 *  而 localStorage 整个域名总共才 5 MB，正本加备份必然放不下），放不进去再退回 localStorage
 *  的 `acorn-data-prerestore`。两个名字都 `acorn-` 开头：清空本机是照这个前缀扫的。
 *
 *  返回 true = 真的留下了一份。返回 false **不代表出错**，两种情况：
 *  这台设备上本来就还没有账本（新设备、刚清空过），或者两处都放不下。
 *  调用方（wipe.restoreFromCloud）按跟桌面同一个口径处置：没东西可备份不算失败。
 *
 *  在桌面里调是空操作（直接 false）：那一端用 snapshotBackup，别留两份含义不同的退路。 */
export async function snapshotWebBackup(): Promise<boolean> {
  if (inTauri) return false;
  let current: string | null = null;
  try {
    current = await webLoad();
  } catch {
    return false; // 当前这份都读不出来，也就没有退路可留
  }
  if (current == null) return false;
  if (hasIdb() && (await idbPut(current, IDB_PRE_KEY))) {
    lsDrop(PRE_KEY); // 只留最新那一份，别让旧的那份在另一处冒充
    return true;
  }
  try {
    localStorage.setItem(PRE_KEY, current);
    return true;
  } catch {
    return false;
  }
}

/** 把上面留的那份退路读回来，没有就是 null。
 *  覆盖之后用户喊「不是这个」时，界面拿它把人捞回来（照 loadData 那套解析即可）。 */
export async function readWebSnapshot(): Promise<string | null> {
  if (hasIdb()) {
    const got = await idbGet(IDB_PRE_KEY);
    if (got.ok && got.json != null) return got.json;
  }
  return lsGet(PRE_KEY);
}

/** 把这台设备上的橡果数据删干净：data.json 与它的中间态、backups/ 里橡果自己写的那些、
 *  冒烟报告、登录令牌，并清空 config.json 的 recentDirs。返回真正清过的目录。
 *  **Rust 侧自己会拒绝没登录过账号的调用**，这里不是唯一的闸门。 */
export async function purgeLocalFiles(): Promise<string[]> {
  if (!inTauri) {
    // 浏览器里「这台设备上的那一份」就是这两处，两处都得清干净
    await idbDel();
    lsDrop();
    // 上次没写进库时兜下来的那份、以及覆盖前留的那份退路，同样是「这台设备上的数据」。
    // localStorage 那两个键 clearLocalPrefs 按 acorn- 前缀也会扫到，这里不指望它：
    // 清空本机是一次性的事，漏一处就是用户以为删干净了、其实还留着一本
    lsDrop(FB_KEY);
    lsDrop(PRE_KEY);
    await idbDel(IDB_PRE_KEY);
    return [];
  }
  return inv<string[]>("purge_local_data");
}

/** 清空本机会动到哪些目录。确认框在弹之前调一次，把路径逐条列给用户看——
 *  数据文件夹是用户拿文件夹选择器随便挑的，换过几次之后旧目录也在名单里，
 *  他得在按下确定之前看见 `D:\我的文档` 这种自己的通用文件夹也在其中 */
export async function purgeTargets(): Promise<string[]> {
  if (!inTauri) return [];
  return inv<string[]>("list_purge_targets");
}

/** 清空本机之后那一次启动的一次性标记：读到就清掉，只生效一次。
 *
 *  用途：那一次启动**不许建默认账本**。defaultData() 带两条每次都换新 id 的清单
 *  「工作」「生活」，落了盘用户一登录就把它们推上云，云端和另一台设备各多出一对。
 *
 *  标记存在 Rust 侧的 config.json 里，**不能放 localStorage**——清空的最后一步
 *  clearLocalPrefs() 会把 `acorn-` 开头的 key 全扫掉，放那儿等于没放。 */
export async function takeFreshStart(): Promise<boolean> {
  if (!inTauri) return false;
  return inv<boolean>("take_fresh_start");
}

/** 界面偏好那几个 localStorage key（折叠状态、侧栏展开、计划页页签、日历筛选、令牌回退位）。
 *  一律按 `acorn-` 前缀扫——列白名单迟早漏掉新加的那个 */
export function clearLocalPrefs(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("acorn-")) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* 存储不可用就算了，本来也没存下什么 */
  }
}

export interface DataCandidate {
  dir: string;
  tasks: number;
  lists: number;
  modified: string;
}

/** 扫一遍数据可能待着的地方（指针丢了、换了机器、装机工具把指针写歪了都靠它兜底） */
export async function findDataCandidates(): Promise<DataCandidate[]> {
  if (!inTauri) return [];
  return inv<DataCandidate[]>("find_data_candidates");
}

export async function getDataDir(): Promise<string> {
  if (!inTauri) return WEB_DATA_PLACE;
  return inv<string>("get_data_dir");
}

export async function setDataDir(dir: string): Promise<void> {
  await inv("set_data_dir", { dir });
}

export async function writeSmokeReport(json: string): Promise<void> {
  await inv("write_smoke_report", { json });
}

/** 导出：path 必须来自系统保存对话框 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await inv("write_text_file", { path, content });
}

/** 导入：path 必须来自系统打开对话框 */
export async function readTextFile(path: string): Promise<string> {
  return inv<string>("read_text_file", { path });
}

// ---------- 浏览器里的「存一份出来 / 挑一份进来」 ----------
//
// 桌面走的是系统对话框给一个路径、Rust 侧写文件（writeTextFile / readTextFile）。
// 浏览器里没有「路径」这回事，只有下载和选文件——所以这两个是网页版的那半边，
// 摆在存取层里跟上面那两个作伴，省得每个页面自己造一遍。

/** 让浏览器下载一份文本文件。name 就是用户在下载列表里看到的那个名字 */
export function downloadTextFile(name: string, text: string): void {
  const type = name.endsWith(".json") ? "application/json" : "text/plain;charset=utf-8";
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  // 先挂到树上再点：有的浏览器对不在文档里的 <a> 不响应 click()
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 别当场 revoke：下载还没真正开始，撤掉地址就是一个空文件。留一分钟够了
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 弹系统选文件框，把选中的那份读成文本。用户取消、或者读不出来都返回 null */
export function pickTextFile(accept = ".json,application/json"): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsText(f);
    };
    // 取消也要有个了结，否则这个 Promise 永远悬着（新一点的浏览器都给这个事件）
    input.oncancel = () => resolve(null);
    input.click();
  });
}
