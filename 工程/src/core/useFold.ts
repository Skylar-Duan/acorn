// 「这一块收着还是摊着」的记忆，落 localStorage。
//
// 2026-09-01 从 Sidebar 里抽出来共用：设置页分节折叠也要这一套，别抄第三份。
// key 一律 `acorn-` 开头——退出登录清空本机时 persist.clearLocalPrefs() 按这个前缀扫。
//
// ── 给调用方的一句话（v1.14.1 新增第四个参数 group）────────────────────────────
//   useFold(key, initial, prefix, group?) —— 传了**同一个 group** 的那几块自动成为手风琴：
//   展开其中一块，同组别的自己收起（一次只摊开一块）。**不传 group 的调用方行为一个字不变**。
//   forceFoldOpen(key, prefix) 签名照旧：把那一块掰开，同组别的跟着收起，
//   哪怕那一页这会儿还没挂上来也算数（见下面 pendingOpen）。
//   例：设置页每个 SetSection 传 group="settings" 就够了，别的什么都不用改。
//
//   两条约定，越界了会出怪事：
//   · 一个 prefix 只归一家折叠用（设置页 acorn-set-、侧栏 acorn-side-）。
//     forceFoldOpen 只认 prefix+key，认不出 group，同前缀的邻居因此会给被点名的那块让位。
//   · forceFoldOpen 之后那一页得真的挂上来。占位条只等 PENDING_TTL 这么久，
//     过期就作废——免得它一直躺着，下次那页挂载时凭空把手风琴的位子抢走。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";

const OPEN_EVENT = "acorn:fold-open";
/** 「同组只留我一个开着」的广播。跟 OPEN_EVENT 一样走事件而不进 store：
 *  这是纯界面记忆，不该进撤销栈也不该跟着云同步跑 */
const SOLO_EVENT = "acorn:fold-solo";

interface SoloDetail {
  group: string;
  lsKey: string;
}

/** 占着一组位子的那一块 */
interface Owner {
  lsKey: string;
  /** 它的「开」是本机记着的，还是压根没记过、按 initial 默认开的。
   *  这一位是 2026-09-06 那个「首帧两节同时摊着」的关键：光看 localStorage
   *  分不出「没记过所以按默认开着」和「记忆被清了所以没开」，判错就会放第二块也开。 */
  byDefault: boolean;
}

/** 每个 group 现在开着的是哪一块（只活在这次会话的内存里，不落盘）。
 *
 *  为什么光有事件不够：同一页的几块是**同一轮渲染里一起挂上来**的，那一刻谁的监听都还没装，
 *  互相通知不到。localStorage 里又完全可能好几块都写着「开」（老用户在手风琴之前
 *  就是全摊着的，或者 forceFoldOpen 刚把某一块掰开）。所以要有这么一张表当场分胜负：
 *  先挂载的先占位，后来的自己收着——**在第一帧之前就分完**，不能等 effect 再收，
 *  那是用户眼睛看得见的一下。
 *
 *  ⚠️ 这张表是在 render 里写的（useState 初始化器），严格说是渲染期副作用。
 *  它只是内存里的一张便签、可以重复调用、也自己纠错，所以留着；但别把设置页
 *  包进 startTransition / Suspense —— 被丢弃的那次渲染会在这儿留下痕迹。
 *  真要写记忆（localStorage）一律放到 effect 里，见下面「挂载那一拍」。 */
const owner = new Map<string, Owner>();

/** forceFoldOpen 点名要开、但那一页还没挂载的那些 lsKey → 点名的时刻。
 *
 *  这是一张占位条：那一块挂载时凭它把位子从先到的邻居手里抢过来。没有它的话，
 *  「点侧栏同步指示 → 跳设置页 → 滚到云账号」会滚到一个被同组邻居挤收起来的标题上，
 *  用户什么也看不见——正是当初加 forceFoldOpen 要解决的那件事。
 *
 *  记时刻是为了会过期：喊了却始终没挂载的那张条，超过 PENDING_TTL 就不算数了。 */
const pendingOpen = new Map<string, number>();

/** 占位条的保质期。navigate 排下一轮渲染最多也就几十毫秒的事，3 秒足够宽； */
const PENDING_TTL = 3000;

type Mark = "1" | "0" | null;

/** 本机记忆里这一块写的是什么，没写过是 null */
function readMark(lsKey: string): Mark {
  try {
    const raw = localStorage.getItem(lsKey);
    return raw === null ? null : raw === "1" ? "1" : "0";
  } catch {
    return null;
  }
}

function readOpen(lsKey: string, initial: boolean): boolean {
  const mark = readMark(lsKey);
  return mark === null ? initial : mark === "1";
}

function remember(lsKey: string, open: boolean): void {
  try {
    localStorage.setItem(lsKey, open ? "1" : "0");
  } catch {
    /* 隐私模式之类存不了就算了，只是这次会话不记住 */
  }
}

/** 这张占位条还算数吗（顺手把过期的扔掉） */
function pending(lsKey: string): boolean {
  const at = pendingOpen.get(lsKey);
  if (at === undefined) return false;
  if (Date.now() - at <= PENDING_TTL) return true;
  pendingOpen.delete(lsKey);
  return false;
}

/** 同一家折叠里，是不是有**别的**块正被点名要开。
 *  只能按 prefix 认亲：forceFoldOpen 拿到的是 prefix+key，它不知道 group。
 *  认出来了我就先收着——不然「点同步指示跳设置页」的第一帧还是两节都摊着。 */
function forcedNeighbor(prefix: string, lsKey: string): boolean {
  for (const other of [...pendingOpen.keys()]) {
    if (other !== lsKey && other.startsWith(prefix) && pending(other)) return true;
  }
  return false;
}

/** 占着位子的那块这会儿是不是真开着。
 *  记过的以本机记忆为准；没记过的，只有当初就是「按默认开」的才算数——
 *  登出清空本机记忆之后那条旧记录就该作废（当初加这条复核就是为了这个）。 */
function ownerOpen(o: Owner): boolean {
  const mark = readMark(o.lsKey);
  return mark === null ? o.byDefault : mark === "1";
}

function take(group: string, lsKey: string): void {
  owner.set(group, { lsKey, byDefault: readMark(lsKey) === null });
}

/** 占住这一组的位子，再广播给在场的邻居：除了我，都收起来 */
function solo(group: string, lsKey: string): void {
  take(group, lsKey);
  window.dispatchEvent(new CustomEvent<SoloDetail>(SOLO_EVENT, { detail: { group, lsKey } }));
}

/**
 * 挂载这一刻，这一块到底开不开。
 * 纯粹按上面那张表 + localStorage 判，**可以重复调用**（React 严格模式下初始化器会跑两遍）：
 * 只动内存里的 owner，不写 localStorage。
 */
function claim(group: string | undefined, lsKey: string, prefix: string, want: boolean): boolean {
  if (!group) return want;
  // 被点名的那块：位子归它，占位条留给挂载那一拍去消费
  if (pending(lsKey)) {
    take(group, lsKey);
    return true;
  }
  if (!want || forcedNeighbor(prefix, lsKey)) {
    if (owner.get(group)?.lsKey === lsKey) owner.delete(group);
    return false;
  }
  const cur = owner.get(group);
  if (cur !== undefined && cur.lsKey !== lsKey && ownerOpen(cur)) return false;
  take(group, lsKey);
  return true;
}

/**
 * 返回 [open, toggle]。
 * @param key    这一块的名字（会拼上 prefix 当 localStorage 键）
 * @param initial 没记过时的默认态
 * @param prefix  localStorage 键前缀。侧栏是 `acorn-side-`，设置页是 `acorn-set-`
 * @param group   传了就跟同 group 的其它块互斥：开一块，别的自动收起（不传＝各管各的，跟以前一样）
 */
export function useFold(
  key: string,
  initial: boolean,
  prefix = "acorn-side-",
  group?: string,
): [boolean, () => void] {
  const lsKey = `${prefix}${key}`;
  const [open, setOpen] = useState<boolean>(() =>
    claim(group, lsKey, prefix, readOpen(lsKey, initial)),
  );
  // 两条 window 监听的闭包都停在首帧，当前开合只能靠每次渲染刷新的 ref 送进去
  const openRef = useRef(open);
  openRef.current = open;

  // 别处要求「把这一块打开」（比如侧栏同步指示点一下要滚到「云账号」）——
  // 那一块要是收着，滚到一个收起的标题上用户什么也看不见
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== lsKey) return;
      pendingOpen.delete(lsKey); // 我在场、自己接住了，占位条用不上了
      openRef.current = true;
      setOpen(true);
      if (group) solo(group, lsKey); // 同组别的跟着收起
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [lsKey, group]);

  // 同组有人被展开了：我收起来（记忆也跟着改口）
  useEffect(() => {
    if (!group) return;
    const onSolo = (e: Event) => {
      const d = (e as CustomEvent<SoloDetail>).detail;
      if (d.group !== group || d.lsKey === lsKey || !openRef.current) return;
      openRef.current = false;
      remember(lsKey, false);
      setOpen(false);
    };
    window.addEventListener(SOLO_EVENT, onSolo);
    return () => window.removeEventListener(SOLO_EVENT, onSolo);
  }, [lsKey, group]);

  // 挂载那一拍：写记忆的活儿都在这里，render 里一个字都不写。
  //  · 占位条我接住了，销掉
  //  · 我是这一组现在开着的那一块，就把在场的邻居收掉。平时这是空转（同组本来就只有我开着），
  //    真正要紧的是 forceFoldOpen 点名把我掰开、而同组另一块排在我前面也开着的那一次。
  //    必须放在上面那条 SOLO 监听**之后**：同一次提交里，排在前面的邻居先装好监听，我才听得见。
  //  · 刚才在 claim 里被邻居挤下来了（我收着、本机却记着「开」）：记忆跟着改口，
  //    下次进来不会又是两块都想摊开。
  useEffect(() => {
    pendingOpen.delete(lsKey);
    if (!group) return;
    if (openRef.current) {
      if (owner.get(group)?.lsKey === lsKey) solo(group, lsKey);
    } else if (readMark(lsKey) === "1") {
      remember(lsKey, false);
    }
  }, [lsKey, group]);

  return [
    open,
    () => {
      const next = !openRef.current;
      openRef.current = next;
      remember(lsKey, next);
      setOpen(next);
      if (!group) return;
      if (next) solo(group, lsKey);
      else if (owner.get(group)?.lsKey === lsKey) owner.delete(group);
    },
  ];
}

/** 让某一块强制打开（同时写进记忆，这样还没挂载的那一页挂载时读到的也是「开」） */
export function forceFoldOpen(key: string, prefix = "acorn-side-"): void {
  const lsKey = `${prefix}${key}`;
  remember(lsKey, true);
  // 留一张占位条：那一页还没挂上来时，它挂载时凭这张条把同组的位子抢到手。
  // 同前缀的邻居也认这张条，会先收着，免得第一帧两块一起摊开
  pendingOpen.set(lsKey, Date.now());
  window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: lsKey }));
}
