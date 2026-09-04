// 手机「记一条」把便捷输入加回来了（用户 2026-09-03：「手机版，便捷输入还是加回去，便捷卡片也加上」）。
// 起因：他在手机上打了「下周一晚上bill朋友来取东西。」，日期没被认出来，整句留在了标题里。
//
// 钉四件事：
//   ① 记一条那张纸真的在解析——用的是全仓那一个 parseQuickAdd，喂了清单名和周末日设置；
//      认出来的东西有一排带 × 的胶囊；打到 @ / / 有候选行；标题行右边有「?」
//   ② 打字 × 点选谁说了算，是 mobile/quickAddMerge.ts 里的纯函数——直接拿值测，不靠读源码：
//      打出来的优先、点选只补没打的；改了点选以点选为准；打字再动又以打字为准；
//      × 之后那一类整个不认，原文回到标题
//   ③ 「便捷卡片」在手机上是一张纸：sheetStore 多一种 guide，App 挂了 GuideSheetHost，
//      useGuideEntry 在手机上走 openSheet（设置页那颗「打开用法」跟着一起活）
//   ④ 样式全在 mobile-sheet.css，颜色只用 token（那份文件的色值检查在 mobile-sheets.test.ts）
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import quickAddSheetSource from "../src/mobile/QuickAddSheet.tsx?raw";
import guideHostSource from "../src/mobile/GuideSheetHost.tsx?raw";
import guideSheetSource from "../src/components/GuideSheet.tsx?raw";
import sheetStoreSource from "../src/mobile/sheetStore.ts?raw";
import mergeSource from "../src/mobile/quickAddMerge.ts?raw";
import appSource from "../src/App.tsx?raw";
import { parseQuickAdd } from "../src/core/parse";
import type { ParseChip } from "../src/core/parse";
import {
  EMPTY_PICKS, acceptCandidate, candidatesAt, chipField, dropKind, merge, pickWins, typedSig, visibleChips, withOverride,
} from "../src/mobile/quickAddMerge";
import type { Picks } from "../src/mobile/quickAddMerge";

const read = (p: string) => readFileSync(p, "utf8");
const sheetCss = read("src/styles/mobile-sheet.css");

/** 仓库里 CRLF / LF 混着用，断言不许把行尾当内容的一部分 */
const nl = (s: string) => s.replace(/\r\n/g, "\n");
/** 写给后人的注释里出现什么都不算数，看的是真代码 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

/** 一段函数体：从 `from` 到下一个 `to` */
function slice(src: string, from: string, to: string): string {
  const i = src.indexOf(from);
  expect(i, `源码里找不到：${from}`).toBeGreaterThan(-1);
  const j = src.indexOf(to, i + from.length);
  expect(j, `${from} 之后找不到收尾记号：${to}`).toBeGreaterThan(-1);
  return src.slice(i, j);
}

// 2026-09-03 周四 10:00。下周一 = 09-07，明天 = 09-04
const NOW = new Date(2026, 8, 3, 10, 0, 0);
const LISTS = ["工作", "生活", "产品"];
const parse = (s: string, skip?: ParseChip["kind"][]) => parseQuickAdd(s, { now: NOW, listNames: LISTS, skip });
/** 用户那句原话（加了空格、清单、需求方、重要性） */
const SENTENCE = "下周一晚上 bill朋友来取东西 /生活 @bill !高";

describe("① 记一条那张纸：真的在解析，认出来的有胶囊、胶囊有 ×、标题行有「?」", () => {
  it("解析走全仓那一个 parseQuickAdd，喂了清单名（/生 能对上生活）和周末日设置", () => {
    expect(quickAddSheetSource).toContain('import { parseQuickAdd } from "../core/parse";');
    const call = slice(quickAddSheetSource, "parseQuickAdd(text, {", "})");
    expect(call).toContain("listNames,");
    expect(call).toContain("weekendDay: settings.weekendDay,");
    // × 过的那几类走 skip：原文留在标题里，不是事后再拼回去
    expect(call).toContain("skip: dropped.length ? dropped : undefined,");
  });

  it("胶囊一排：每颗一个 ×，× 走 dropKind（那一类整个别认）", () => {
    // 画的是 visibleChips 过滤后的那几颗（改过点选的那一类不画），不是 parsed.chips 全画——
    // 不然点选改成今天之后，胶囊还写着下周一、点选那排写着今天，两排当面打架
    expect(quickAddSheetSource).toContain("const chips = useMemo(() => visibleChips(parsed, eff), [parsed, eff]);");
    expect(quickAddSheetSource).toContain("{chips.length > 0 && (");
    expect(quickAddSheetSource).toContain("{chips.map((c: ParseChip, i) => (");
    expect(quickAddSheetSource).not.toContain("parsed.chips.map(");
    expect(quickAddSheetSource).not.toContain("parsed.chips.length");
    expect(quickAddSheetSource).toContain('className="msh-qa-x"');
    expect(quickAddSheetSource).toContain("setDropped((d) => dropKind(d, c.kind))");
    // 读屏能听懂 × 是干什么的
    expect(quickAddSheetSource).toContain("aria-label={`不要认${KIND_NAME[c.kind]}`}");
    // 按 × 不许把键盘收掉（按住不抢焦点）
    const x = slice(quickAddSheetSource, 'className="msh-qa-x"', "</button>");
    expect(x).toContain("onPointerDown={(e) => e.preventDefault()}");
  });

  it("打到 @ / / / # 有一行候选，点一个填进去", () => {
    expect(quickAddSheetSource).toContain("candidatesAt(text, caret,");
    expect(quickAddSheetSource).toContain('className="msh-qa-cand"');
    expect(quickAddSheetSource).toContain("onClick={() => accept(it)}");
    expect(quickAddSheetSource).toContain("acceptCandidate(text, cand, item)");
  });

  it("标题行右边一颗「?」：跟桌面 QuickAddBar 同一个入口（useGuideEntry），读屏叫「怎么记一句话」", () => {
    expect(quickAddSheetSource).toContain('import { useGuideEntry } from "../components/GuideSheet";');
    expect(quickAddSheetSource).toContain('aria-label="怎么记一句话"');
    expect(quickAddSheetSource).toContain("onClick={guide.open}");
    // 这张纸自己不往栈上推：开举例卡片是 useGuideEntry 的事
    expect(quickAddSheetSource).not.toContain("openSheet");
  });

  it("落库：解析后的标题 + 合并后的字段；/清单 不存在时自动新建（跟 QuickAddBar 同一条）", () => {
    const record = slice(quickAddSheetSource, "function record()", "function toggleSeg");
    expect(record).toContain("const t = parsed.title.trim();");
    expect(record).toContain("merge(parsed,");
    expect(record).toContain("addList(m.listName, LIST_COLORS[lists.length % LIST_COLORS.length])");
    for (const f of ["title: t,", "tags: m.tags,", "who: m.who,", "priority: m.priority,", "due: m.due,", "repeat: m.repeat,"]) {
      expect(record, f).toContain(f);
    }
    // 记完清的是那句话和它的记号，点选一个不清
    expect(record).toContain('setText("");');
    expect(record).toContain("setDropped([]);");
    expect(record).toContain("setOverrides({});");
    expect(record).not.toContain("setPick(");
  });

  it("点选那一排显示的是**现在生效的值**（打了「下周一」，日期那颗就写下周一），不是只看点选", () => {
    const picks = slice(quickAddSheetSource, '<div className="msh-picks">', "{/* 点哪个");
    expect(picks).toContain("eff.due ? `${formatShort(eff.due)}");
    expect(picks).toContain("eff.who.length ? eff.who.join");
    expect(picks).toContain("eff.priority ? PRIO_NAME[eff.priority]");
    expect(picks).toContain("eff.repeat ? repeatLabel(eff.repeat)");
    expect(picks).not.toContain("pick.due");
  });

  it("改点选一律走 changePick：先记签名（从此以点选为准）再改值，而且从生效的值出发", () => {
    expect(quickAddSheetSource).toContain("setOverrides((o) => withOverride(o, parsed, field));");
    // 打了 @bill 再点「王工」是两个人，不是把 bill 挤掉
    expect(quickAddSheetSource).toContain("who: on ? eff.who.filter((x) => x !== w) : [...eff.who, w]");
    // 换日子不换钟点
    expect(quickAddSheetSource).toContain("changePick(\"due\", { due: d, dueTime: d ? eff.dueTime : null });");
  });

  it("举例卡片可以叠在这张纸上面：这张纸看「栈里有没有」，不看「栈顶是不是」（否则一收就丢字）", () => {
    expect(quickAddSheetSource).toContain('s.stack.find((x) => x.kind === "quickAdd") ?? null');
  });

  it("举例卡片叠上来时把键盘收掉（blur），收掉之后焦点还给输入框接着打", () => {
    expect(quickAddSheetSource).toContain('useSheet((s) => s.stack.some((x) => x.kind === "guide"))');
    const eff = slice(quickAddSheetSource, "const guideWas = useRef(false);", "// 点完补全候选");
    expect(eff).toContain("inputRef.current?.blur();");
    expect(eff).toContain("setTimeout(() => inputRef.current?.focus(), 240)");
  });

  it("抽屉里没有「随手记」这个词，也没有「随手记」那套写死的日子", () => {
    for (const [name, src] of [["记一条", quickAddSheetSource], ["举例卡片", guideHostSource], ["合并规则", mergeSource]] as const) {
      expect(stripComments(src), name).not.toContain("随手记");
    }
  });
});

describe("② 打字 × 点选：谁说了算（quickAddMerge 纯函数）", () => {
  it("先钉住解析：用户那句话认出日期、钟点、清单、需求方、重要性，标题是干净的", () => {
    const p = parse(SENTENCE);
    expect(p.title).toBe("bill朋友来取东西");
    expect(p.due).toBe("2026-09-07");
    expect(p.dueTime).toBe("20:00");
    expect(p.listName).toBe("生活");
    expect(p.who).toEqual(["bill"]);
    expect(p.priority).toBe(3);
    expect(p.chips.map((c) => c.kind)).toEqual(["date", "time", "list", "who", "priority"]);
  });

  it("只打字不点选：全从打字来", () => {
    const m = merge(parse(SENTENCE), EMPTY_PICKS);
    expect(m.title).toBe("bill朋友来取东西");
    expect(m.due).toBe("2026-09-07");
    expect(m.dueTime).toBe("20:00");
    expect(m.listName).toBe("生活");
    expect(m.listId).toBeNull();
    expect(m.who).toEqual(["bill"]);
    expect(m.priority).toBe(3);
    expect(m.repeat).toBeNull();
    expect(m.from).toEqual({ due: "typed", list: "typed", who: "typed", priority: "typed", repeat: "none" });
  });

  it("只点选不打字：全从点选来（老行为一个字没变）", () => {
    const pick: Picks = {
      due: "2026-09-10", dueTime: "09:30", listId: "l-work", who: ["王工"], priority: 2, repeat: { kind: "daily", every: 1 },
    };
    const m = merge(parse("买菜"), pick);
    expect(m.title).toBe("买菜");
    expect(m.due).toBe("2026-09-10");
    expect(m.dueTime).toBe("09:30");
    expect(m.listId).toBe("l-work");
    expect(m.listName).toBeNull();
    expect(m.who).toEqual(["王工"]);
    expect(m.priority).toBe(2);
    expect(m.repeat).toEqual({ kind: "daily", every: 1 });
    expect(m.from).toEqual({ due: "picked", list: "picked", who: "picked", priority: "picked", repeat: "picked" });
  });

  it("两边都给了：打字优先，点选只补没打的（跟桌面「两边同时给了以打字为准」同一个口径）", () => {
    const pick: Picks = { ...EMPTY_PICKS, due: "2026-09-10", who: ["王工"], listId: "l-work", priority: 1 };
    const m = merge(parse("下周一 买菜 @bill"), pick);
    expect(m.due).toBe("2026-09-07"); // 打的下周一赢
    expect(m.who).toEqual(["bill"]); // 打的 @bill 赢，王工不合并进来
    expect(m.listId).toBe("l-work"); // 没打清单，点选补上
    expect(m.priority).toBe(1); // 没打重要性，点选补上
    expect(m.from).toEqual({ due: "typed", list: "picked", who: "typed", priority: "picked", repeat: "none" });
  });

  it("只打了「晚上」这种钟点：日期用点选过的那天，钟点用打的（解析器给的「今天/明天」只是兜底）", () => {
    const m = merge(parse("晚上 买菜"), { ...EMPTY_PICKS, due: "2026-09-10" });
    expect(m.due).toBe("2026-09-10");
    expect(m.dueTime).toBe("20:00");
    // 没点过日子就用兜底：10 点还没到晚上 8 点 → 今天
    expect(merge(parse("晚上 买菜"), EMPTY_PICKS).due).toBe("2026-09-03");
  });

  it("打了日期、点选里有钟点：日期用打的，钟点由点选补（点选只补没打的）", () => {
    const m = merge(parse("下周一 买菜"), { ...EMPTY_PICKS, due: "2026-09-10", dueTime: "18:00" });
    expect(m.due).toBe("2026-09-07");
    expect(m.dueTime).toBe("18:00");
  });

  it("改了点选：以点选为准（打字给的那个不再算），标题不变（原文不放回去）", () => {
    const p = parse(SENTENCE);
    const o = withOverride({}, p, "due");
    expect(pickWins(p, o, "due")).toBe(true);
    const m = merge(p, { ...EMPTY_PICKS, due: "2026-09-10", dueTime: "20:00" }, o);
    expect(m.due).toBe("2026-09-10");
    expect(m.dueTime).toBe("20:00");
    expect(m.from.due).toBe("picked");
    expect(m.title).toBe("bill朋友来取东西");
    // 别的字段不受影响，照旧打字优先
    expect(m.who).toEqual(["bill"]);
    expect(m.listName).toBe("生活");
  });

  it("改了点选之后打字那边又动了：签名对不上，重新以打字为准（谁后动谁说了算）", () => {
    const p1 = parse("下周一 买菜");
    const o = withOverride({}, p1, "due");
    expect(merge(p1, { ...EMPTY_PICKS, due: "2026-09-10" }, o).due).toBe("2026-09-10");
    const p2 = parse("明天 买菜");
    expect(pickWins(p2, o, "due")).toBe(false);
    expect(merge(p2, { ...EMPTY_PICKS, due: "2026-09-10" }, o).due).toBe("2026-09-04");
  });

  it("点选里「不要」= 以点选为准且点选是空：这个字段就是没有（打的那个不再算）", () => {
    const p = parse(SENTENCE);
    const o = withOverride(withOverride({}, p, "due"), p, "who");
    const m = merge(p, EMPTY_PICKS, o);
    expect(m.due).toBeNull();
    expect(m.dueTime).toBeNull();
    expect(m.who).toEqual([]);
    expect(m.from.due).toBe("none");
    expect(m.from.who).toBe("none");
  });

  it("胶囊那一类对应点选哪个字段：日期和钟点同属 due，标签没有点选（null）", () => {
    expect(chipField("date")).toBe("due");
    expect(chipField("time")).toBe("due");
    expect(chipField("list")).toBe("list");
    expect(chipField("who")).toBe("who");
    expect(chipField("priority")).toBe("priority");
    expect(chipField("repeat")).toBe("repeat");
    expect(chipField("tag")).toBeNull();
  });

  it("改过点选的那一类不再画胶囊：打了下周一晚上、日期段点了今天 → 📅 和跟着它的 🕒 都不画，别的三颗照旧", () => {
    const p = parse(SENTENCE);
    // 没改过点选：五颗都在
    expect(visibleChips(p, merge(p, EMPTY_PICKS)).map((c) => c.kind)).toEqual(["date", "time", "list", "who", "priority"]);
    const o = withOverride({}, p, "due");
    const m = merge(p, { ...EMPTY_PICKS, due: "2026-09-03" }, o);
    expect(m.due).toBe("2026-09-03");
    expect(m.from.due).toBe("picked");
    expect(visibleChips(p, m).map((c) => c.kind)).toEqual(["list", "who", "priority"]);
  });

  it("打了 @李哥、需求方段点「不指定」→ ＠ 那颗不画（落库 who 本来就是空）", () => {
    const p = parse("乙事 @李哥");
    const o = withOverride({}, p, "who");
    const m = merge(p, EMPTY_PICKS, o);
    expect(m.who).toEqual([]);
    expect(m.from.who).toBe("none");
    expect(visibleChips(p, m)).toEqual([]);
  });

  it("打了 /工作、清单段点「生活」→ ▤ 那颗不画（落库是点的那张清单）", () => {
    const p = parse("丙事 /工作");
    const o = withOverride({}, p, "list");
    const m = merge(p, { ...EMPTY_PICKS, listId: "l-life" }, o);
    expect(m.listId).toBe("l-life");
    expect(m.listName).toBeNull();
    expect(visibleChips(p, m)).toEqual([]);
  });

  it("胶囊跟着「谁说了算」走：改完点选再改那句话，打字又赢，那颗又回来；标签永远画（没有点选）", () => {
    const p1 = parse("下周一 买菜 #家务");
    const o = withOverride({}, p1, "due");
    expect(visibleChips(p1, merge(p1, { ...EMPTY_PICKS, due: "2026-09-10" }, o)).map((c) => c.kind)).toEqual(["tag"]);
    const p2 = parse("明天 买菜 #家务");
    expect(visibleChips(p2, merge(p2, { ...EMPTY_PICKS, due: "2026-09-10" }, o)).map((c) => c.kind)).toEqual(["date", "tag"]);
  });

  it("先点选、后打字：签名是空串记的，打了之后签名变了 → 打字赢", () => {
    const p0 = parse("买菜");
    const o = withOverride({}, p0, "who"); // 什么都没打的时候点了需求方
    expect(typedSig(p0, "who")).toBe("");
    expect(merge(p0, { ...EMPTY_PICKS, who: ["王工"] }, o).who).toEqual(["王工"]);
    const p1 = parse("买菜 @bill");
    expect(merge(p1, { ...EMPTY_PICKS, who: ["王工"] }, o).who).toEqual(["bill"]);
  });

  it("× 之后：那一类整个别认，原文回到标题里，一个字不丢", () => {
    const d = dropKind([], "date");
    expect(d).toEqual(["date"]);
    expect(dropKind(d, "date")).toEqual(["date"]); // 按两下不会重复
    // 「下周一」回到标题；贴在它后面的「晚上」失去了依托，也一起留在标题里（解析器的成词规则）
    const p = parse("下周一晚上 bill朋友来取东西", d);
    expect(p.title).toBe("下周一晚上 bill朋友来取东西");
    expect(p.due).toBeNull();
    expect(p.dueTime).toBeNull();
    // 只 × 钟点：日期还认，「晚上」两个字回到标题
    const p2 = parse("明天 晚上 买菜", dropKind([], "time"));
    expect(p2.title).toBe("晚上 买菜");
    expect(p2.due).toBe("2026-09-04");
    expect(p2.dueTime).toBeNull();
    // × 掉清单：「/生活」原样留着，不会再凭空建清单
    const p3 = parse(SENTENCE, dropKind([], "list"));
    expect(p3.listName).toBeNull();
    expect(p3.title).toBe("bill朋友来取东西 /生活");
  });

  it("循环词自带首个落点：「每周一」算打了日期，点选的日子不抢", () => {
    const m = merge(parse("每周一 交周报"), { ...EMPTY_PICKS, due: "2026-09-10" });
    expect(m.repeat).toEqual({ kind: "weekly", days: [1] });
    expect(m.due).toBe("2026-09-07");
  });
});

describe("③ 补全候选：@ 需求方 / /清单 / #标签", () => {
  const SRC = { lists: ["工作", "生活", "产品"], whos: ["李哥", "王工", "lisa"], tags: ["紧要"] };

  it("刚打一个 @：把现有的需求方全摆出来", () => {
    const c = candidatesAt("@", 1, SRC);
    expect(c).not.toBeNull();
    expect(c!.trigger).toBe("@");
    expect(c!.items).toEqual(["李哥", "王工", "lisa"]);
    expect(c!.start).toBe(0);
    expect(c!.end).toBe(1);
  });

  it("带前缀就筛：前缀命中在前，包含命中在后；点一个换成整个词 + 空格，光标停在空格后", () => {
    const text = "买菜 @li";
    const c = candidatesAt(text, text.length, SRC)!;
    expect(c.items).toEqual(["lisa"]);
    const r = acceptCandidate(text, c, "lisa");
    expect(r.text).toBe("买菜 @lisa ");
    expect(r.caret).toBe(r.text.length);
    // 光标在句中也行：替换的只是光标前那半截
    const mid = "@li 买菜";
    const c2 = candidatesAt(mid, 3, SRC)!;
    expect(acceptCandidate(mid, c2, "lisa")).toEqual({ text: "@lisa  买菜", caret: 6 });
  });

  it("/ 要在句首或空白之后才算清单（跟解析器同一条边界：8/20 不是清单）", () => {
    expect(candidatesAt("/生", 2, SRC)!.items).toEqual(["生活"]);
    expect(candidatesAt("8/2", 3, SRC)).toBeNull();
    expect(candidatesAt("交材料 #紧", 6, SRC)!.items).toEqual(["紧要"]);
  });

  it("没有一个候选就不弹；光标不在 token 末尾也不弹", () => {
    expect(candidatesAt("@张", 2, SRC)).toBeNull();
    expect(candidatesAt("@李哥 买菜", 5, SRC)).toBeNull();
    expect(candidatesAt("", 0, SRC)).toBeNull();
  });
});

describe("④ 便捷卡片在手机上是一张纸", () => {
  it("sheetStore 多了 guide 这一种（排在 habit 前面，habit 那行照旧收尾）", () => {
    expect(sheetStoreSource).toContain('| { kind: "guide" }');
    expect(sheetStoreSource).toContain('| { kind: "habit"; id?: string };');
  });

  it("useGuideEntry 在手机上走 openSheet，不再试着开独立窗口 / 应用内弹层", () => {
    expect(guideSheetSource).toContain('import { isMobile } from "../core/platform";');
    expect(guideSheetSource).toContain('import { openSheet } from "../mobile/sheetStore";');
    const open = slice(guideSheetSource, "const open = useCallback(() => {", "}, []);");
    expect(open).toContain("if (isMobile) {");
    expect(open).toContain('openSheet({ kind: "guide" });');
    expect(open.indexOf("if (isMobile) {")).toBeLessThan(open.indexOf("openGuide()"));
  });

  it("GuideSheetHost：只认栈顶、全高、装的是那份 GuideContent（例子不另写），周末日跟设置走", () => {
    expect(guideHostSource).toContain('import GuideContent from "../components/GuideContent";');
    expect(guideHostSource).toContain('const open = top?.kind === "guide";');
    expect(guideHostSource).toContain('size="full"');
    expect(guideHostSource).toContain('label="怎么记一句话"');
    expect(guideHostSource).toContain("onClose={closeSheet}");
    expect(guideHostSource).toContain("weekendDay={settings.weekendDay}");
    // 例子只有一份：这个文件里一张卡片都不许自己写
    expect(guideHostSource).not.toContain("gd-card");
    expect(guideHostSource).not.toContain("SECTIONS");
  });

  it("App 只在手机上挂 GuideSheetHost，跟别的纸并排", () => {
    expect(nl(appSource)).toContain('import { GuideSheetHost } from "./mobile/GuideSheetHost";');
    const hosts = appSource.slice(appSource.indexOf("{isMobile && ("), appSource.indexOf("<LoginPageHost />"));
    expect(hosts).toContain("<GuideSheetHost />");
    expect(hosts).toContain("<QuickAddSheetHost />");
  });

  it("样式全在 mobile-sheet.css：胶囊、候选、举例纸；圆角跟纸里别的件一致（14）", () => {
    for (const sel of [".msh-qa-help {", ".msh-qa-chips {", ".msh-qa-chip {", ".msh-qa-x {", ".msh-qa-cands {", ".msh-qa-cand {", ".msh-guide {", ".msh-guide-body {"]) {
      expect(sheetCss, sel).toContain(sel);
    }
    expect(sheetCss).toMatch(/\.msh-qa-cand \{[\s\S]{0,160}border-radius: 14px;/);
    expect(sheetCss).toContain(".msh-guide .gd-try, .msh-guide .gd-card { border-radius: 14px;");
    // 候选那排也横滚，跟点选那排一个手势
    const cands = sheetCss.slice(sheetCss.indexOf(".msh-qa-cands {"), sheetCss.indexOf(".msh-qa-cand {"));
    expect(cands).toContain("touch-action: pan-x;");
    // 胶囊进场那一下走动效常量
    expect(sheetCss).toContain("animation: msh-chip-in var(--dur-1) var(--ease);");
  });
});
