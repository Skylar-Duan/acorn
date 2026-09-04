// 手机「记一条」里，打字与点选怎么合成一条事（纯逻辑，零 DOM，tests/mobile-quickadd-syntax.test.ts 直接测）。
//
// 用户 2026-09-03 改口：手机上也要像电脑一样，打一句话就认出日期 / 清单 / 需求方 / 标签 / 重要性 / 循环，
// 点选那一排照旧留着。两边碰上了谁说了算，全在这个文件里：
//   · 打出来的字段优先，点选只补没打的——跟桌面 QuickAddBar「两边同时给了以打字为准」同一个口径；
//   · 点选按钮上显示的是**现在生效的值**（打了「下周一」，日期那颗就写下周一），点它就能改：
//     改完以点选为准，原文已经被解析器从标题里拿掉了，不放回去；
//   · 改完点选之后再去改那句话里同一类的词，又以打字为准——谁后动谁说了算。
//     实现：改点选那一刻把「打字这边当时给的值」记成签名；签名没变 = 打字没再动 = 点选赢，
//     签名变了 = 打字又动了 = 打字赢。不用时间戳，纯值比较，可测；
//   · 胶囊上的 ×：那一类**整个别认**（走 parseQuickAdd 的 skip），原文回到标题里，一个字不丢。
//     同类的几颗（两个标签）一起回去——解析器只认「类」不认「颗」。
//   · 胶囊那一排只画**现在还由打字说了算**的那几颗（visibleChips）：改过点选的那一类不画——
//     它的值点选那一排在显示，同一张纸上两排各写一个日期会当面打架（2026-09-04 复核挑出来的）。
//
// 补全候选（打到 @ / / / # 之后横排一行）也在这儿算：跟 SyntaxInput 同一条 token 规则
// （触发符必须在句首或空白之后），只是那边是键盘上下选，这边是手指点。
import type { ParseChip, ParseResult } from "../core/parse";
import type { Priority, RepeatRule } from "../core/model";

export type ChipKind = ParseChip["kind"];

/** 点选那一排的五个字段。日期和钟点在同一段里改，算一个 */
export type PickField = "due" | "list" | "who" | "priority" | "repeat";

export interface Picks {
  due: string | null;
  dueTime: string | null;
  listId: string | null;
  /** 需求方可以点好几个 */
  who: string[];
  priority: Priority;
  repeat: RepeatRule | null;
}

export const EMPTY_PICKS: Picks = { due: null, dueTime: null, listId: null, who: [], priority: 0, repeat: null };

/** 每个字段：改点选那一刻打字这边给的签名。没改过的字段不在里面 */
export type Overrides = Partial<Record<PickField, string>>;

export type Source = "typed" | "picked" | "none";

export interface Merged {
  title: string;
  due: string | null;
  dueTime: string | null;
  /** 打字给的清单名（可能还不存在，调用方负责新建）；点选给的是 listId。两者最多一个有值 */
  listName: string | null;
  listId: string | null;
  who: string[];
  priority: Priority;
  repeat: RepeatRule | null;
  tags: string[];
  /** 五个字段各是谁给的（给界面标注、给测试看） */
  from: Record<PickField, Source>;
}

/** 胶囊上的 ×：这一类别认了。已经在里面就原样返回 */
export function dropKind(dropped: readonly ChipKind[], kind: ChipKind): ChipKind[] {
  return dropped.includes(kind) ? [...dropped] : [...dropped, kind];
}

/** 打字这边这个字段现在给的值，序列化成签名；没打就是空串 */
export function typedSig(parsed: ParseResult, field: PickField): string {
  switch (field) {
    case "due":
      return parsed.due === null && parsed.dueTime === null ? "" : JSON.stringify([parsed.due, parsed.dueTime]);
    case "list":
      return parsed.listName ?? "";
    case "who":
      return parsed.who.length ? JSON.stringify(parsed.who) : "";
    case "priority":
      return parsed.priority ? String(parsed.priority) : "";
    case "repeat":
      return parsed.repeat ? JSON.stringify(parsed.repeat) : "";
  }
}

export function hasTyped(parsed: ParseResult, field: PickField): boolean {
  return typedSig(parsed, field) !== "";
}

/** 这个字段现在是不是点选说了算：改过点选、而且打字那边从那以后没再动 */
export function pickWins(parsed: ParseResult, overrides: Overrides, field: PickField): boolean {
  const sig = overrides[field];
  return sig !== undefined && sig === typedSig(parsed, field);
}

/** 改了点选：把「此刻打字给的值」记成签名，从此这个字段以点选为准（直到打字那边再动） */
export function withOverride(overrides: Overrides, parsed: ParseResult, field: PickField): Overrides {
  return { ...overrides, [field]: typedSig(parsed, field) };
}

function pickHas(pick: Picks, field: PickField): boolean {
  switch (field) {
    case "due":
      return pick.due !== null;
    case "list":
      return pick.listId !== null;
    case "who":
      return pick.who.length > 0;
    case "priority":
      return pick.priority > 0;
    case "repeat":
      return pick.repeat !== null;
  }
}

/** 把解析结果和点选合成落库要的那份字段 */
export function merge(parsed: ParseResult, pick: Picks, overrides: Overrides = {}): Merged {
  const by = (f: PickField): Source => {
    if (pickWins(parsed, overrides, f)) return pickHas(pick, f) ? "picked" : "none";
    if (hasTyped(parsed, f)) return "typed";
    return pickHas(pick, f) ? "picked" : "none";
  };
  const from: Record<PickField, Source> = {
    due: by("due"),
    list: by("list"),
    who: by("who"),
    priority: by("priority"),
    repeat: by("repeat"),
  };

  // 日期：打了日期词（或循环词——「每周一」自带首个落点）才算打字给了日期；
  // 只打了「晚上」这种钟点时，解析器给的日期是「今天/明天」的兜底，点选过的日子要比它优先
  let due: string | null;
  let dueTime: string | null;
  if (pickWins(parsed, overrides, "due")) {
    due = pick.due;
    dueTime = due ? pick.dueTime : null;
  } else {
    const typedDate = parsed.chips.some((c) => c.kind === "date") || parsed.repeat !== null;
    due = typedDate ? parsed.due : pick.due ?? parsed.due;
    dueTime = due ? parsed.dueTime ?? (pick.due ? pick.dueTime : null) : null;
  }

  const listTyped = from.list === "typed";
  const whoTyped = from.who === "typed";
  const prioTyped = from.priority === "typed";
  const repTyped = from.repeat === "typed";

  return {
    title: parsed.title,
    due,
    dueTime,
    listName: listTyped ? parsed.listName : null,
    listId: listTyped ? null : pick.listId,
    who: whoTyped ? parsed.who : pick.who,
    priority: prioTyped ? parsed.priority : pick.priority,
    repeat: repTyped ? parsed.repeat : pick.repeat,
    tags: parsed.tags,
    from,
  };
}

/** 胶囊那一类对应点选那一排的哪个字段。日期和钟点同属「due」；标签没有点选，永远算打字 */
export function chipField(kind: ChipKind): PickField | null {
  switch (kind) {
    case "date":
    case "time":
      return "due";
    case "list":
      return "list";
    case "who":
      return "who";
    case "priority":
      return "priority";
    case "repeat":
      return "repeat";
    case "tag":
      return null;
  }
}

/** 胶囊那一排只画**现在还由打字说了算**的那几颗：
 *  改过点选的那一类（from 是 picked / none）不画——它的值点选那一排在显示，
 *  同一张纸上两排各写一个日期会当面打架，用户不知道到底记的是哪个。
 *  打字那边再动、签名对不上了，from 回到 typed，那一类的胶囊又回来 */
export function visibleChips(parsed: ParseResult, merged: Merged): ParseChip[] {
  return parsed.chips.filter((c) => {
    const f = chipField(c.kind);
    return f === null || merged.from[f] === "typed";
  });
}

// ---------- 补全候选 ----------

export type Trigger = "#" | "@" | "/";

export interface CandMatch {
  trigger: Trigger;
  /** 触发字符在全文中的下标 */
  start: number;
  /** 替换终点 = 光标位置 */
  end: number;
  prefix: string;
  items: string[];
}

/** 光标前的未完成 token：触发字符 + 已敲的前缀（不含空白与其他触发符）。跟 SyntaxInput 那条一字不差 */
const TOKEN_RE = /(?:^|\s)([#@/])([^\s#@/!！]*)$/;

/** 一行横排放得下的颗数：多了要横滚，少了不够挑 */
export const CAND_MAX = 8;

/** 前缀命中优先，其次包含命中；空前缀给全量前几个 */
function pickCandidates(source: readonly string[], prefix: string): string[] {
  if (prefix === "") return source.slice(0, CAND_MAX);
  const pre: string[] = [];
  const inc: string[] = [];
  for (const s of source) {
    if (s.startsWith(prefix)) pre.push(s);
    else if (s.includes(prefix)) inc.push(s);
  }
  return [...pre, ...inc].slice(0, CAND_MAX);
}

export function candidatesAt(
  text: string,
  caret: number,
  source: { lists: readonly string[]; whos: readonly string[]; tags: readonly string[] },
): CandMatch | null {
  const m = TOKEN_RE.exec(text.slice(0, caret));
  if (m === null) return null;
  const trigger = m[1] as Trigger;
  const prefix = m[2];
  const pool = trigger === "#" ? source.tags : trigger === "@" ? source.whos : source.lists;
  const items = pickCandidates(pool, prefix);
  if (items.length === 0) return null;
  return { trigger, start: caret - prefix.length - 1, end: caret, prefix, items };
}

/** 把半截 token 换成整个候选 + 一个空格，光标停在空格后面接着打 */
export function acceptCandidate(text: string, m: CandMatch, item: string): { text: string; caret: number } {
  const next = `${text.slice(0, m.start + 1)}${item} ${text.slice(m.end)}`;
  return { text: next, caret: m.start + 1 + item.length + 1 };
}
