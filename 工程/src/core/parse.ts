// 快速添加输入框的中文自然语言解析(纯逻辑,零 DOM)。
// 符号分工:#标签 /清单 @需求方 !优先级 ~时间。
// 策略:按固定优先级依次扫描各类 token,用字符占用表防止同一段文字被解析两次;
// 未被占用的字符收拢空白后即标题。同一字段出现多个 token 时,按出现位置后者生效。
//
// **时间严格模式(v1.15.0,用户拍板)**:跟时间有关的三类——日期、时段与钟点、循环——
// 必须由一个 `~` 领着才算数。「~周五下午3点 提交周报」设日期;「下周去体检」一个字不动,
// 整句就是标题。为什么这么定:不打符号的误认没法预防(「比分3-2」「上午班次表」这类防不胜防),
// 而一件事被悄悄排到某一天,用户是在错过之后才发现的。代价是每次写时间多打一个字符,
// 好处是规矩简单到不用记——**凡是跟时间有关的,前面打个 ~**,跟另外三个符号一个待遇。
// 下面那 25 条日期/钟点正则一条没改,闸门只在 scan 里加了一处(见 gate)。

import type { Priority, RepeatRule } from "./model";
import {
  addDays,
  cmpYMD,
  dayOfWeek,
  daysInMonth,
  formatShort,
  isWorkday,
  nowLocalDT,
  pad2,
  todayYMD,
  weekStart,
} from "./dates";
import { HOLIDAY_WORDS, holidayDate } from "./holidays";
import { describeRepeat } from "./recur";

export interface ParseChip {
  kind: "date" | "time" | "repeat" | "list" | "tag" | "who" | "priority";
  text: string;
}

export interface ParseResult {
  title: string;
  due: string | null;
  dueTime: string | null;
  repeat: RepeatRule | null;
  listName: string | null;
  tags: string[];
  /** 需求方，可以有多个（@李哥 @张总）；没写就是空数组 */
  who: string[];
  priority: Priority;
  chips: ParseChip[];
}

// ---------- 数字 ----------

const CN_DIGIT: Record<string, number | undefined> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** '21' / '三十一' -> 数值;非法汉字组合(如「一二三」)返回 null */
function num(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  const i = s.indexOf("十");
  if (i === -1) return s.length === 1 ? CN_DIGIT[s] ?? null : null;
  const tens = i === 0 ? 1 : i === 1 ? CN_DIGIT[s[0]] ?? null : null;
  const rest = s.slice(i + 1);
  const ones = rest === "" ? 0 : rest.length === 1 ? CN_DIGIT[rest] ?? null : null;
  return tens === null || ones === null ? null : tens * 10 + ones;
}

/** 阿拉伯或汉字数字的正则片段(不含捕获组) */
const NUM = "(?:\\d{1,2}|[一二两三四五六七八九十]{1,3})";

const DAY_CH: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const DAY_NAME = ["日", "一", "二", "三", "四", "五", "六"];

/** 下午/晚上把 12 以下的钟点换到下半天;12 点本身不再加(下午12点=12:00) */
function adjustHour(mer: string | undefined, h: number): number {
  if (mer === "下午" || mer === "晚上") return h < 12 ? h + 12 : h;
  if (mer === "中午") return h < 6 ? h + 12 : h;
  return h; // 上午/早上/无前缀
}

/** 循环规则从 today(含今天)起的第一个落点 */
function firstOccurrence(rule: RepeatRule, today: string): string {
  switch (rule.kind) {
    case "daily":
      return today;
    case "weekly": {
      const d0 = dayOfWeek(today);
      for (let i = 0; i < 7; i++) if (rule.days.includes((d0 + i) % 7)) return addDays(today, i);
      return today;
    }
    case "monthly": {
      let y = Number(today.slice(0, 4));
      let m = Number(today.slice(5, 7));
      for (;;) {
        // 与 RepeatRule 语义一致:超出当月末取月末
        const cand = `${y}-${pad2(m)}-${pad2(Math.min(rule.day, daysInMonth(y, m)))}`;
        if (cmpYMD(cand, today) >= 0) return cand;
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
    }
    case "workday": {
      let d = today;
      while (!isWorkday(d)) d = addDays(d, 1);
      return d;
    }
  }
}

// ---------- 正则(共享实例,scan 内每次重置 lastIndex) ----------

const RE = {
  // 字符类统一排斥 / ——否则「#紧要/工作」会整体吞成一个标签,清单丢失;
  // 同样排斥 ~ 与 ～:「@李哥~3点」的人名到 ~ 为止,时间不能被吃进名字里
  tag: /#([^\s#@/!！~～]+)/g,
  // '/' 必须在行首或空白之后,防止误吞 8/20 这类日期
  list: /(?<!\S)\/([^\s#@/!！~～]+)/g,
  who: /@([^\s#@/!！~～]+)/g,
  prioWord: /[!！](高|中|低)/g,
  prioBang: /[!！]+/g,
  repWorkday: /每个?工作日/g,
  // 「个」可写可不写,「周」「星期」都认:每周一 / 每个星期三 / 每星期一三五
  repWeekly: /每个?(?:周|星期)([一二三四五六日天]+)/g,
  // 每周末:按设置里的周末日循环(循环先于日期扫,所以不会被「周末」截成「每」+「周末」)
  repWeekend: /每个?周末/g,
  // 每月最后一天 / 每个月末 / 每月底:存成 day 31(当月没有 31 号就落在月末,三端老版本都这么算)。
  // 必须在日期之前扫——不然「月末」两个字会被当成一次性的「这个月底」抢走
  repMonthEnd: /每个?月(?:最后一天|末|底)/g,
  repMonthly: new RegExp(`每个?月(${NUM})[号日]`, "g"),
  // 光写「每周」「每个月」、没说哪天:按这件事写了的日期推(没写就按今天)。
  // 否定前瞻把带了下文的留给上面那几条——「每周末」「每周一」「每月15号」「每月底」不能被它截走;
  // 「每月初」「每月中」这次不认,也不许被截成「每月」+「初」,整串原样留给标题
  repWeekBare: /每个?(?:周|星期)(?![一二三四五六日天末])/g,
  repMonthBare: new RegExp(`每个?月(?!${NUM}|[末底初中]|最后)`, "g"),
  repEveryN: new RegExp(`每(${NUM})天`, "g"),
  repDaily: /每天/g,
  ymd: /(?<![\d-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d-])/g,
  // 节日:要成词——前面得是句首、空白或要素符号(「集中秋招」「全国庆祝」「周五一起」里的都不算);
  // 可带「今年/明年」前缀。长词在前(「五一劳动节」不能被拆成「五一」+「劳动节」两截);
  // 「五一」「六一」后面不许贴着数字和量词——「五一号」「六一班」「十六一天」都不是节日
  holiday: new RegExp(
    `(?<![^\\s#@/!！~～])(今年|明年)?(${HOLIDAY_WORDS.filter((w) => w !== "五一" && w !== "六一").join("|")}|(?:五一|六一)(?![\\d一二两三四五六七八九十号日月点起天周年个次份班届楼期]))`,
    "g",
  ),
  // 今年年底 / 今年底 / 明年年底 / 明年底(须在裸「年底」之前,否则「今年」两个字会漏在标题里)
  yearEnd: /(今年|明年)年?底/g,
  // 明年3月 = 明年 3 月 1 号;明年3月5日 / 明年3月底 也一并认(须在「N月N日」「N月底」之前)
  nextYearMonth: new RegExp(`明年(${NUM})月(?:(${NUM})[日号]|(底)|份)?`, "g"),
  monthDay: new RegExp(`(?<!\\d)(${NUM})月(${NUM})[日号]`, "g"),
  // 下个月5号 / 这个月5号 / 本月5号(须在裸「5号」之前)
  monthPrefixDay: new RegExp(`(下个?|这个?|本)月(${NUM})[日号]`, "g"),
  monthEndN: new RegExp(`(?<!\\d)(${NUM})月底`, "g"),
  // 三个月后 / 3月后:往后数 N 个月
  monthsAfter: new RegExp(`(?<!\\d)(${NUM})个?月后`, "g"),
  // 月底/月末/月初/月中,可带「下(个)/这(个)/本」前缀;年底
  monthPart: /(下个?|这个?|本)?月(底|末|初|中)|年底/g,
  // 与 RE.list 同款左边界:必须在行首、空白后或那个 ~ 后(严格模式下真正写日期的写法是「~8-31」),
  // 防止「比分3-2」「得了3/4」这类正文被吞成日期
  mmDd: /(?<![^\s~～])(\d{1,2})-(\d{1,2})(?![\d-])/g,
  mmSlashDd: /(?<![^\s~～])(\d{1,2})\/(\d{1,2})(?![\d/])/g,
  relWord: /大后天|后天|明天|明早|明晚|今早|今晚|今天/g,
  // 周末 / 本周末 / 这周末 / 下周末 / 下下周末(「上周末」为容错,产出过去日期)
  weekend: /(下下|下|上|本|这)?周末/g,
  // 下周前 / 本周前 / 这周前 = 本周日。「前」要成词尾,否则「下周前端联调」的「前」会被吞
  weekDeadline: /[下本这]周(?:之前|以前|前(?![^\s#@/!！~～]))/g,
  // 下下周三(须在「下周三」之前,否则会被截成「下」+「下周三」)
  nextNextWeek: /下下(?:周|星期)([一二三四五六日天])/g,
  otherWeek: /([上下本这])(?:周|星期)([一二三四五六日天])/g,
  weekday: /(?:周|星期)([一二三四五六日天])/g,
  daysAfter: new RegExp(`(?<!\\d)(${NUM})天后`, "g"),
  // N天内 = N天后
  daysWithin: new RegExp(`(?<!\\d)(${NUM})天内`, "g"),
  weeksAfter: new RegExp(`(?<!\\d)(${NUM})周后`, "g"),
  bareDay: new RegExp(`(?<!\\d)(${NUM})号`, "g"),
  // 钟点前面的时段词可以隔个空格:「下午 3点」「下午 3:30」都是 15 点。
  // 空格只许夹在时段词和数字之间——没有时段词时 token 必须从数字起,否则「票 20点提醒我」
  // 会把那个空格一起吃掉,「提醒我」就粘到标题上删不掉了
  hhmm: /(?:(上午|早上|早晨|中午|下午|晚上)\s*)?(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g,
  clock: new RegExp(`(?:(上午|早上|早晨|中午|下午|晚上)\\s*)?(?<!\\d)(${NUM})点(半|(${NUM})分)?`, "g"),
  // 光秃秃的时段词(带钟点的已被上两条吃掉),给个默认钟点
  period: /早上|早晨|上午|中午|下午|晚上/g,
};

// 长词在前:「之前」自身含「前」
const DEADLINE = ["之前", "以前", "前"];

/** 时段词的默认钟点:早/上午 9 点、中午 12 点、下午 3 点、晚上 8 点。句子里另有明确钟点时以钟点为准 */
const PERIOD_TIME: Record<string, string> = {
  早上: "09:00",
  早晨: "09:00",
  上午: "09:00",
  中午: "12:00",
  下午: "15:00",
  晚上: "20:00",
};

/** 今天/明天/后天/大后天,以及自带时段的 今早/今晚/明早/明晚。
 *  时段词既给默认钟点(PERIOD_TIME),也决定句子里裸钟点落在上半天还是下半天(「明晚8点」= 20 点) */
const REL_WORD: Record<string, { off: number; mer: string | null }> = {
  今天: { off: 0, mer: null },
  今早: { off: 0, mer: "早上" },
  今晚: { off: 0, mer: "晚上" },
  明天: { off: 1, mer: null },
  明早: { off: 1, mer: "早上" },
  明晚: { off: 1, mer: "晚上" },
  后天: { off: 2, mer: null },
  大后天: { off: 3, mer: null },
};

// ---------- 主入口 ----------

export interface ParseOpts {
  now: Date;
  listNames: string[];
  /** 不认这几类要素（认不了的地方用，比如子任务没有清单/标签/需求方）。
   *  被关掉的那类原文照留在标题里，不会被悄悄吃掉 */
  skip?: ParseChip["kind"][];
  /** 「周末」指周六还是周日,跟设置里那一项走;不给就当周日 */
  weekendDay?: "sat" | "sun";
  /** 标题里的换行留着(每行各自压空白、去首尾空格,空行扔掉)。**只有子任务那条路开**:
   *  任务卡里加子任务、改子任务可以 Shift+Enter 写成几行。记一条 / 整句改 / 快捷记浮窗都不开,
   *  那几处一句话就是一句话,换行照旧压成一个空格 */
  keepNewlines?: boolean;
}

/** 压空白。不留换行:所有空白(含换行)压成一个空格;留换行:按行各自做一遍 fix,空行扔掉。
 *  fix 只管「一行之内」怎么清理,两种口径共用它,免得同一套清理写两遍 */
function tidyTitle(s: string, keepNewlines: boolean | undefined, fix: (line: string) => string): string {
  if (!keepNewlines) return fix(s);
  return s
    .split(/\r\n|\r|\n/)
    .map(fix)
    .filter((l) => l !== "")
    .join("\n");
}

export function parseQuickAdd(input: string, opts: ParseOpts): ParseResult {
  const today = todayYMD(opts.now);
  const skip = new Set<ParseChip["kind"]>(opts.skip ?? []);
  const consumed: boolean[] = new Array<boolean>(input.length).fill(false);

  const st = {
    due: null as string | null,
    dateSet: false,
    dueTime: null as string | null,
    /** 「今晚」「明早」「下午」这类时段词给的默认钟点;句子里另有明确钟点(dueTime)时以钟点为准 */
    periodTime: null as string | null,
    /** 那个时段词本身(早上/中午/下午/晚上):「明晚8点」的裸「8点」要靠它换到 20 点 */
    periodMer: null as string | null,
    /** 明确钟点自己没带时段词(「8点」而不是「晚上8点」),才轮得到 periodMer 来换算 */
    timeBare: false,
    /** 明确钟点那枚芯片——换算之后芯片文字要跟着改,不然「明晚」旁边挂着「08:00」自相矛盾 */
    timeChip: null as ParseChip | null,
    repeat: null as RepeatRule | null,
    /** 光写「每周」「每个月」时那条循环还没定哪天,等日期那边汇总完再按日期补(见汇总那一段);
     *  chip 是它那枚芯片,补完之后文字要跟着改 */
    repeatBare: null as { unit: "week" | "month"; rule: RepeatRule; chip: ParseChip } | null,
    priority: 0 as Priority,
    who: [] as string[],
    listName: null as string | null,
    tags: [] as string[],
  };
  type State = typeof st;

  interface Tok {
    start: number;
    chip: ParseChip;
    apply: (s: State) => void;
  }
  const tokens: Tok[] = [];

  const free = (a: number, b: number): boolean => {
    for (let i = a; i < b; i++) if (consumed[i]) return false;
    return true;
  };

  /** 被某个 ~ 领进门的那些字符。跟 consumed 分开记:只有时间那三类才「传染」,
   *  「@李哥」后面紧跟的「3点」不算被李哥领着 */
  const licensed: boolean[] = new Array<boolean>(input.length).fill(false);
  /** 要过闸门的三类:日期、钟点(含时段词)、循环 */
  const TIMEY = new Set<ParseChip["kind"]>(["date", "time", "repeat"]);
  const isTilde = (c: string | undefined): boolean => c === "~" || c === "～";

  /** 时间闸门:这个 token 前面有没有人领着?
   *  · 紧邻的前一个字符是还没被占用的 ~ / ～,而且**那个 ~ 自己站在词头** → 认,
   *    并把这个符号一起并进占用区间(返回它的下标);
   *  · 紧邻的前一个字符已经在某个 ~ 领着的那一串里 → 也认(一个 ~ 管一整串:「~周五下午3点」);
   *  · 别的一律不认(返回 -1),原文原样留在标题里。
   *  中间空了格就断了——空格不在 licensed 里,得再打一个 ~。这条规矩写在用法页上。
   *
   *  **「~ 要站在词头」这条左边界跟 RE.list 的 / 是一个路数,是为了中文里当范围号用的波浪线**:
   *  「预计 3～5天内 出结果」「报销 1~2个月后 到账」「档期 8/20~8/25」「面试 14:00～15:00 二轮」
   *  ——范围号左边贴着的是正文(数字),不是词头,这时右半截不算时间,整句原样留给标题。
   *  不然就正好是这一版要消灭的那件事:悄悄排了期,标题还被啃掉半截。
   *  前面是「已被别的要素占掉的字符」照旧算词头,「@李哥~3点」「#紧要~明天」「/工作~明天」
   *  「!高~明天」这些扫到时间之前就已经占上了。裸感叹号串(RE.prioBang)排在日期之后扫,
   *  这会儿还没占上字,所以 [!！] 在这儿单独放行——「!!~明天」得照旧认。 */
  const gate = (a: number): number => {
    if (a === 0) return -1;
    if (isTilde(input[a - 1]) && !consumed[a - 1]) {
      const t = a - 1;
      return t === 0 || consumed[t - 1] || /[\s!！]/.test(input[t - 1]) ? t : -1;
    }
    return licensed[a - 1] ? a : -1;
  };

  // eatDeadline:日期 token 紧跟的「之前/以前/前」是 deadline 语气词,一并吞掉(日期不变)
  const scan = (
    re: RegExp,
    on: (m: RegExpExecArray) => { chip: ParseChip; apply: (s: State) => void } | null,
    eatDeadline = false,
  ): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      const a = m.index;
      let b = a + m[0].length;
      if (!free(a, b)) continue;
      const t = on(m);
      if (t === null) continue;
      if (skip.has(t.chip.kind)) continue; // 关掉的类别：不认、不吃字，原文留给标题
      // 时间那三类过闸门：没有 ~ 领着就当没看见，这一串原样留给标题
      const timey = TIMEY.has(t.chip.kind);
      let start = a;
      if (timey) {
        start = gate(a);
        if (start === -1) continue;
      }
      if (eatDeadline) {
        const suf = DEADLINE.find((w) => input.startsWith(w, b));
        if (suf !== undefined && free(b, b + suf.length)) {
          // 单字「前」只在词尾（后面是空白/行尾/token 符号）才算语气词，
          // 否则会吞掉「前端」「前台」这类内容词的首字
          const after = input[b + suf.length];
          const atBoundary = after === undefined || /[\s#@/!！~～]/.test(after);
          if (suf !== "前" || atBoundary) b += suf.length;
        }
      }
      for (let i = start; i < b; i++) {
        consumed[i] = true;
        if (timey) licensed[i] = true; // 这一串后面还能再接时间词，不必重新打 ~
      }
      tokens.push({ start, chip: t.chip, apply: t.apply });
    }
  };

  const dateChip = (ymd: string): ParseChip => ({ kind: "date", text: formatShort(ymd, opts.now) });
  const setDate =
    (ymd: string) =>
    (s: State): void => {
      s.due = ymd;
      s.dateSet = true;
    };

  /** N月N日:当年已过取明年;所选年份里该日不存在(如平年 2月29日)则视为无效 token */
  const resolveMonthDay = (mo: number, d: number): string | null => {
    if (mo < 1 || mo > 12 || d < 1) return null;
    let y = Number(today.slice(0, 4));
    for (let k = 0; k < 2; k++) {
      if (d <= daysInMonth(y, mo)) {
        const cand = `${y}-${pad2(mo)}-${pad2(d)}`;
        if (cmpYMD(cand, today) >= 0) return cand;
      }
      y += 1;
    }
    return null;
  };

  /** 裸 N号:当月已过则往后找下一个真的有 N 号的月份 */
  const resolveBareDay = (d: number): string | null => {
    if (d < 1 || d > 31) return null;
    let y = Number(today.slice(0, 4));
    let mo = Number(today.slice(5, 7));
    for (let k = 0; k < 24; k++) {
      if (d <= daysInMonth(y, mo)) {
        const cand = `${y}-${pad2(mo)}-${pad2(d)}`;
        if (cmpYMD(cand, today) >= 0) return cand;
      }
      mo += 1;
      if (mo > 12) {
        mo = 1;
        y += 1;
      }
    }
    return null;
  };

  /** 月底/月初/月中:当月对应日子已过(严格早于今天)则顺延到下个月 */
  const resolveMonthPoint = (day: number | "end"): string => {
    let y = Number(today.slice(0, 4));
    let mo = Number(today.slice(5, 7));
    for (;;) {
      const d = day === "end" ? daysInMonth(y, mo) : day;
      const cand = `${y}-${pad2(mo)}-${pad2(d)}`;
      if (cmpYMD(cand, today) >= 0) return cand;
      mo += 1;
      if (mo > 12) {
        mo = 1;
        y += 1;
      }
    }
  };

  /** N月底:当年该月最后一天,已过则明年 */
  const resolveMonthEnd = (mo: number): string | null => {
    if (mo < 1 || mo > 12) return null;
    let y = Number(today.slice(0, 4));
    let cand = `${y}-${pad2(mo)}-${pad2(daysInMonth(y, mo))}`;
    if (cmpYMD(cand, today) < 0) {
      y += 1;
      cand = `${y}-${pad2(mo)}-${pad2(daysInMonth(y, mo))}`;
    }
    return cand;
  };

  /** 今天往后 n 个月的同一天;那个月没有这一天(1月31日 往后一个月)就取该月最后一天 */
  const addMonths = (n: number): string => {
    const m0 = Number(today.slice(5, 7)) - 1 + n; // 0 起算的月序号,可能超过 11
    const y = Number(today.slice(0, 4)) + Math.floor(m0 / 12);
    const mo = (m0 % 12) + 1;
    const d = Math.min(Number(today.slice(8, 10)), daysInMonth(y, mo));
    return `${y}-${pad2(mo)}-${pad2(d)}`;
  };

  /** 下月初 / 下月中 / 下月底:下个月的 1 / 15 / 最后一天 */
  const resolveNextMonthPoint = (day: number | "end"): string => {
    const ym = addMonths(1).slice(0, 7);
    const d = day === "end" ? daysInMonth(Number(ym.slice(0, 4)), Number(ym.slice(5, 7))) : day;
    return `${ym}-${pad2(d)}`;
  };

  /** 下个月N号 / 这个月N号 / 本月N号。那个月没有 N 号(1 月里说「下个月30号」)就落在月末——
   *  跟「每月N号」一个口径;不认的话裸「30号」会把它抢走,「下个月」三个字漏在标题里 */
  const resolveMonthPrefixDay = (prefix: string, d: number): string | null => {
    if (d < 1 || d > 31) return null;
    const ym = (prefix.startsWith("下") ? addMonths(1) : today).slice(0, 7);
    const last = daysInMonth(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)));
    return `${ym}-${pad2(Math.min(d, last))}`;
  };

  /** 周末日:周六还是周日跟设置走,默认周日 */
  const weekendDow = opts.weekendDay === "sat" ? 6 : 0;
  /** 周末 / 下周末 / 下下周末:本周(shift=0)或往后第 shift 周的周末日。
   *  今天已经是周日而周末日设成周六 → 本周的周六已经过了,「周末」就算今天(不往下周跳) */
  const resolveWeekend = (shift: number): string => {
    const d = addDays(weekStart(today), shift * 7 + (weekendDow === 0 ? 6 : 5));
    return shift === 0 && cmpYMD(d, today) < 0 ? today : d;
  };

  // ---- 1. #标签(只管标签,取到空白或下一个 #@! 为止) ----
  // 这三类(标签/清单/需求方)在扫描回调里就写了 st,所以要在外层拦,不能只靠 scan 里的 skip
  if (!skip.has("tag"))
    scan(RE.tag, (m) => {
      const name = m[1];
      st.tags.push(name);
      return { chip: { kind: "tag", text: name }, apply: () => {} };
    });

  // ---- 2. /清单(先精确后前缀,都不中原样返回交由调用方新建;扫描序即出现序,覆盖实现「最后一个生效」) ----
  if (!skip.has("list"))
    scan(RE.list, (m) => {
      const name = m[1];
      const hit =
        opts.listNames.find((n) => n === name) ?? opts.listNames.find((n) => n.startsWith(name));
      const final = hit ?? name;
      st.listName = final;
      return { chip: { kind: "list", text: final }, apply: () => {} };
    });

  // ---- 3. @人(可以写多个,像标签一样累加;重复的同一个人只算一次) ----
  if (!skip.has("who"))
    scan(RE.who, (m) => {
      const name = m[1];
      if (!st.who.includes(name)) st.who.push(name);
      return { chip: { kind: "who", text: name }, apply: () => {} };
    });

  // ---- 4. 优先级(带字形式) ----
  scan(RE.prioWord, (m) => {
    const lv: Priority = m[1] === "高" ? 3 : m[1] === "中" ? 2 : 1;
    return {
      chip: { kind: "priority", text: m[1] },
      apply: (s) => {
        s.priority = lv;
      },
    };
  });

  // ---- 5. 循环(须在日期之前:每周一/每月28号 会被 周一/28号 抢走) ----
  scan(RE.repWorkday, () => ({
    chip: { kind: "repeat", text: "每个工作日" },
    apply: (s) => {
      s.repeat = { kind: "workday" };
    },
  }));

  scan(RE.repWeekly, (m) => {
    const days = [...new Set([...m[1]].map((c) => DAY_CH[c]))].sort((x, y) => x - y);
    return {
      chip: { kind: "repeat", text: `每周${days.map((d) => DAY_NAME[d]).join("、")}` },
      apply: (s) => {
        s.repeat = { kind: "weekly", days };
      },
    };
  });

  // 每周末:按设置里的周末日循环(默认周日);芯片直接写换算出来的那一天,用户一眼能看出设置生效了
  scan(RE.repWeekend, () => ({
    chip: { kind: "repeat", text: `每周${DAY_NAME[weekendDow]}` },
    apply: (s) => {
      s.repeat = { kind: "weekly", days: [weekendDow] };
    },
  }));

  // 每月最后一天:芯片写「每月最后一天」,跟任务卡上显示的一个说法
  scan(RE.repMonthEnd, () => ({
    chip: { kind: "repeat", text: describeRepeat({ kind: "monthly", day: 31 }) },
    apply: (s) => {
      s.repeat = { kind: "monthly", day: 31 };
    },
  }));

  scan(RE.repMonthly, (m) => {
    const d = num(m[1]);
    if (d === null || d < 1 || d > 31) return null;
    return {
      chip: { kind: "repeat", text: describeRepeat({ kind: "monthly", day: d }) },
      apply: (s) => {
        s.repeat = { kind: "monthly", day: d };
      },
    };
  });

  // 光写「每周」「每个月」:先按今天占个位,汇总时这句话里写了日期就改按那个日期(见汇总那一段)。
  // 按今天这个口径跟快速添加菜单里原来的「每周(按今天是周几)」是同一个
  const bareRepeat = (unit: "week" | "month") => {
    const rule: RepeatRule =
      unit === "week"
        ? { kind: "weekly", days: [dayOfWeek(today)] }
        : { kind: "monthly", day: Number(today.slice(8, 10)) };
    const chip: ParseChip = { kind: "repeat", text: describeRepeat(rule) };
    return {
      chip,
      apply: (s: State) => {
        s.repeat = rule;
        s.repeatBare = { unit, rule, chip };
      },
    };
  };
  scan(RE.repWeekBare, () => bareRepeat("week"));
  scan(RE.repMonthBare, () => bareRepeat("month"));

  scan(RE.repEveryN, (m) => {
    const n = num(m[1]);
    if (n === null || n < 1) return null;
    return {
      chip: { kind: "repeat", text: `每${n}天` },
      apply: (s) => {
        s.repeat = { kind: "daily", every: n };
      },
    };
  });

  scan(RE.repDaily, () => ({
    chip: { kind: "repeat", text: "每天" },
    apply: (s) => {
      s.repeat = { kind: "daily", every: 1 };
    },
  }));

  // ---- 6. 日期(长格式在前,防止部分吞噬;末参 true = 吞「之前/以前/前」后缀) ----
  scan(
    RE.ymd,
    (m) => {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
      const ymd = `${y}-${pad2(mo)}-${pad2(d)}`;
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 节日:公历的按月日,春节/清明/端午/中秋查表(core/holidays.ts);表外年份不认,原文留在标题里。
  // 「明年春节」取明年那次(明年不在表里就整个不认),「今年春节」照字面取今年那次
  scan(
    RE.holiday,
    (m) => {
      const ymd = holidayDate(m[2], today, m[1] as "今年" | "明年" | undefined);
      if (ymd === null) return null;
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 今年年底 / 明年年底
  scan(
    RE.yearEnd,
    (m) => {
      const y = Number(today.slice(0, 4)) + (m[1] === "明年" ? 1 : 0);
      const ymd = `${y}-12-31`;
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 明年3月 = 明年 3 月 1 号;明年3月5日 / 明年3月底 照字面
  scan(
    RE.nextYearMonth,
    (m) => {
      const mo = num(m[1]);
      if (mo === null || mo < 1 || mo > 12) return null;
      const y = Number(today.slice(0, 4)) + 1;
      const last = daysInMonth(y, mo);
      const d = m[3] !== undefined ? last : m[2] !== undefined ? num(m[2]) : 1;
      if (d === null || d < 1 || d > last) return null;
      const ymd = `${y}-${pad2(mo)}-${pad2(d)}`;
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  scan(
    RE.monthDay,
    (m) => {
      const mo = num(m[1]);
      const d = num(m[2]);
      if (mo === null || d === null) return null;
      const ymd = resolveMonthDay(mo, d);
      if (ymd === null) return null;
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 下个月5号 / 这个月5号 / 本月5号(须在裸「5号」之前)
  scan(
    RE.monthPrefixDay,
    (m) => {
      const d = num(m[2]);
      if (d === null) return null;
      const ymd = resolveMonthPrefixDay(m[1], d);
      if (ymd === null) return null;
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // N月底(须在裸「月底」之前,否则「十月底」的「十」会漏在标题里)
  scan(
    RE.monthEndN,
    (m) => {
      const mo = num(m[1]);
      if (mo === null) return null;
      const ymd = resolveMonthEnd(mo);
      if (ymd === null) return null;
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 三个月后 / 3月后:往后数 N 个月的同一天(月末溢出取那个月最后一天)
  scan(
    RE.monthsAfter,
    (m) => {
      const n = num(m[1]);
      if (n === null || n < 1) return null;
      const ymd = addMonths(n);
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 月底/月末/月初/月中/年底;带「下(个)」前缀就是下个月的那一天,「这(个)/本」跟不带前缀一样
  scan(
    RE.monthPart,
    (m) => {
      const w = m[0];
      let ymd: string;
      if (w === "年底") {
        const y = Number(today.slice(0, 4));
        ymd = cmpYMD(`${y}-12-31`, today) >= 0 ? `${y}-12-31` : `${y + 1}-12-31`;
      } else {
        const day = m[2] === "底" || m[2] === "末" ? "end" : m[2] === "初" ? 1 : 15;
        ymd = m[1]?.startsWith("下") ? resolveNextMonthPoint(day) : resolveMonthPoint(day);
      }
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  scan(
    RE.mmDd,
    (m) => {
      const ymd = resolveMonthDay(Number(m[1]), Number(m[2]));
      if (ymd === null) return null;
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  scan(
    RE.mmSlashDd,
    (m) => {
      const ymd = resolveMonthDay(Number(m[1]), Number(m[2]));
      if (ymd === null) return null;
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  scan(
    RE.relWord,
    (m) => {
      const w = m[0];
      const { off, mer } = REL_WORD[w];
      const ymd = addDays(today, off);
      // 今晚/明早这类自带时段:芯片照原词写,钟点走 periodTime(另有明确钟点时让位;
      // 但「明晚8点」的裸 8 点要跟着「晚」换到 20 点——见汇总那一段)
      if (mer !== null) {
        return {
          chip: { kind: "date", text: w },
          apply: (s) => {
            s.due = ymd;
            s.dateSet = true;
            s.periodTime = PERIOD_TIME[mer];
            s.periodMer = mer;
          },
        };
      }
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 周末 / 本周末 / 这周末 → 本周的周末日;下周末 → 下周;下下周末 → 再下一周。周末日看设置(默认周日)
  scan(
    RE.weekend,
    (m) => {
      const shift = m[1] === "下下" ? 2 : m[1] === "下" ? 1 : m[1] === "上" ? -1 : 0;
      const ymd = resolveWeekend(shift);
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 下周前 / 本周前 / 这周前 = 本周日:这一周的最后一天,「前」只是措辞,跟周末日设置无关
  scan(RE.weekDeadline, () => {
    const ymd = addDays(weekStart(today), 6);
    return { chip: dateChip(ymd), apply: setDate(ymd) };
  });

  // 下下周X:再下一周(须在「下周X」之前)
  scan(
    RE.nextNextWeek,
    (m) => {
      const target = DAY_CH[m[1]];
      const ymd = addDays(weekStart(today), 14 + (target === 0 ? 6 : target - 1));
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 上/下/本/这 + 周X:以周一为一周开始的自然周定位(「上周X」为容错,产出过去日期)
  scan(
    RE.otherWeek,
    (m) => {
      const target = DAY_CH[m[2]];
      const off = target === 0 ? 6 : target - 1;
      const shift = m[1] === "下" ? 7 : m[1] === "上" ? -7 : 0;
      const ymd = addDays(weekStart(today), shift + off);
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 周X/星期X:>= 今天的最近一个(今天就是周X 时取今天)
  scan(
    RE.weekday,
    (m) => {
      const delta = (DAY_CH[m[1]] - dayOfWeek(today) + 7) % 7;
      const ymd = addDays(today, delta);
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  scan(
    RE.daysAfter,
    (m) => {
      const n = num(m[1]);
      if (n === null) return null;
      const ymd = addDays(today, n);
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // N天内 = N天后(同义)
  scan(
    RE.daysWithin,
    (m) => {
      const n = num(m[1]);
      if (n === null) return null;
      const ymd = addDays(today, n);
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  scan(
    RE.weeksAfter,
    (m) => {
      const n = num(m[1]);
      if (n === null) return null;
      const ymd = addDays(today, n * 7);
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  scan(
    RE.bareDay,
    (m) => {
      const d = num(m[1]);
      if (d === null) return null;
      const ymd = resolveBareDay(d);
      if (ymd === null) return null;
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // ---- 7. 时间 ----
  scan(RE.hhmm, (m) => {
    const raw = Number(m[2]);
    const mi = Number(m[3]);
    if (raw > 23 || mi > 59) return null;
    const h = adjustHour(m[1] as string | undefined, raw);
    if (h > 23) return null;
    const hm = `${pad2(h)}:${pad2(mi)}`;
    const chip: ParseChip = { kind: "time", text: hm };
    return {
      chip,
      apply: (s) => {
        s.dueTime = hm;
        s.timeBare = m[1] === undefined;
        s.timeChip = chip;
      },
    };
  });

  scan(RE.clock, (m) => {
    const mer = m[1] as string | undefined;
    const raw = num(m[2]);
    if (raw === null || raw > 23) return null;
    const h = adjustHour(mer, raw);
    if (h > 23) return null;
    const minPart = m[3] as string | undefined;
    let mi = 0;
    if (minPart === "半") mi = 30;
    else if (minPart !== undefined) {
      const v = num(m[4]);
      if (v === null || v > 59) return null;
      mi = v;
    }
    const hm = `${pad2(h)}:${pad2(mi)}`;
    const chip: ParseChip = { kind: "time", text: hm };
    return {
      chip,
      apply: (s) => {
        s.dueTime = hm;
        s.timeBare = mer === undefined;
        s.timeChip = chip;
      },
    };
  });

  // 光秃秃的时段词(「明天下午」「今天晚上」「中午」),给个默认钟点;带钟点的「下午3点」已被上一条吃掉。
  // 只认成词的:紧贴在刚认出的日期后面(「明天下午开会」),或者前后都是句首/空白/句尾/要素符号(「下午 开会」)。
  // 夹在正文里的「喝下午茶」「上午班」不吞;句首直接连着正文的「下午茶 约小王」「晚上好 问候」也不吞
  // 时段词自己那枚「默认钟点」芯片:句子里另有明确钟点时就不出了,免得「12:00」「13:00」并排打架
  const periodChips = new Set<ParseChip>();
  scan(RE.period, (m) => {
    const a = m.index;
    const b = a + m[0].length;
    const glued = a > 0 && consumed[a - 1];
    // 领着它的那个 ~ 也算左边界（「~下午 开会」：这时 ~ 还没被占用，glued 是 false）
    const leftOk = a === 0 || glued || /[\s~～]/.test(input[a - 1]);
    const rightOk = b === input.length || consumed[b] || /[\s#@/!！~～]/.test(input[b]);
    if (!leftOk || (!rightOk && !glued)) return null;
    const w = m[0];
    const hm = PERIOD_TIME[w];
    const chip: ParseChip = { kind: "time", text: hm };
    periodChips.add(chip);
    return {
      chip,
      apply: (s) => {
        s.periodTime = hm;
        s.periodMer = w;
      },
    };
  });

  // ---- 8. 裸感叹号串(放最后:此时紧随的 token 已被占用,可视作边界) ----
  // 全角/半角混合按总长度计级;紧跟普通正文(「!棒」)时按标点处理,不吞。
  scan(RE.prioBang, (m) => {
    const b = m.index + m[0].length;
    if (b < input.length && !consumed[b] && !/[\s#@~～]/.test(input[b])) return null;
    const n = m[0].length;
    const lv: Priority = n >= 3 ? 3 : n === 2 ? 2 : 1;
    return {
      chip: { kind: "priority", text: lv === 3 ? "高" : lv === 2 ? "中" : "低" },
      apply: (s) => {
        s.priority = lv;
      },
    };
  });

  // ---- 汇总:按出现位置应用(后者覆盖前者) ----
  tokens.sort((x, y) => x.start - y.start);
  for (const t of tokens) t.apply(st);

  // 光写「每周」「每个月」的那条循环最后生效(没被后面写的别的循环盖掉),而且这句话里写了日期:
  // 改按那个日期是周几 / 几号。「~明天 ~每周 倒垃圾」是每周X(明天那个星期几),不是每周(今天)
  if (st.repeatBare !== null && st.repeat === st.repeatBare.rule && st.dateSet && st.due !== null) {
    const rule: RepeatRule =
      st.repeatBare.unit === "week"
        ? { kind: "weekly", days: [dayOfWeek(st.due)] }
        : { kind: "monthly", day: Number(st.due.slice(8, 10)) };
    st.repeat = rule;
    st.repeatBare.chip.text = describeRepeat(rule);
  }

  // 明确钟点优先,没有才用时段词的默认钟点(今晚 20:00、明天下午 15:00)。
  // 钟点自己没带时段词、句子里却有「今晚/明晚/晚上/中午」这类词时,按那个时段换算:
  // 「明晚8点」是 20 点不是早上 8 点;「明早8点」「明晚 21:30」不受影响。芯片文字跟着改
  let dueTime = st.dueTime;
  if (dueTime !== null && st.timeBare && st.periodMer !== null) {
    dueTime = `${pad2(adjustHour(st.periodMer, Number(dueTime.slice(0, 2))))}${dueTime.slice(2)}`;
    if (st.timeChip !== null) st.timeChip.text = dueTime;
  }
  if (dueTime === null) dueTime = st.periodTime;

  let due: string | null = null;
  if (st.dateSet) due = st.due;
  else if (st.repeat !== null) due = firstOccurrence(st.repeat, today);
  else if (dueTime !== null) {
    // 只给时间没给日期:默认今天,该时刻已过(含恰好等于现在)则明天
    const nowHM = nowLocalDT(opts.now).slice(11);
    due = dueTime <= nowHM ? addDays(today, 1) : today;
  }

  let title = "";
  for (let i = 0; i < input.length; i++) if (!consumed[i]) title += input[i];
  title = tidyTitle(title, opts.keepNewlines, (l) => l.replace(/\s+/g, " ").trim());
  // 识别出时间/日期后，「20点提醒我」这类说法残留的"提醒(我)"是指令词不是内容，去掉。
  // 只删两种安全形态：独立成词的"提醒/提醒我"、句首的"提醒我"——"写提醒事项"这类内容词不动
  if (dueTime !== null || st.dateSet) {
    // 留换行时按行各做一遍(「句首」就成了每行行首),换行本身不会被当成词边界吃掉
    title = tidyTitle(title, opts.keepNewlines, (l) =>
      l
        .replace(/(?:^|\s)提醒我?(?=\s|$)/g, " ")
        .replace(/^提醒我/, "")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }

  return {
    title,
    due,
    dueTime,
    repeat: st.repeat,
    listName: st.listName,
    tags: st.tags,
    who: st.who,
    priority: st.priority,
    chips: tokens.map((t) => t.chip).filter((c) => st.dueTime === null || !periodChips.has(c)),
  };
}

/** 子任务能带日期 / 时间 / 重要性 / **循环**——清单、标签、需求方仍归母任务管,
 *  那三类在子任务行里不认,原文照留在标题里(打 #紧要 就真的叫「#紧要」)。
 *
 *  **循环 v8 起认了**(PM 原话:「每周末」在子任务里认循环)。以前它也在这张表里,
 *  于是「每周末 大扫除」既没循环、「每」还被下面那句清理正则吃掉,只剩一个一次性的周末。
 *  现在所有循环词在子任务里一视同仁:每天 / 每周一三五 / 每周末 / 每月5号 / 每个工作日 / 每2天,
 *  以及 v1.15 补上的 每个月末 / 每月底 / 每月最后一天 / 每个月15号 / 每个星期三 / 光写的每周、每个月。
 *  没写日期时 due 落在哪跟整件事同一条路——parseQuickAdd 里那句 firstOccurrence(rule, today),
 *  两边共用,不在这儿另算一遍;不然一条有循环、没日期的子任务永远不会推进。 */
export const SUBTASK_SKIP: ParseChip["kind"][] = ["tag", "list", "who"];

export function parseSubtaskInput(
  input: string,
  now: Date,
  listNames: string[] = [],
  weekendDay?: ParseOpts["weekendDay"],
  /** keepNewlines:任务卡子任务栏 Shift+Enter 写的换行留着(见 ParseOpts)。手机那条路不传,照旧压成空格 */
  more: { keepNewlines?: boolean } = {},
): ParseResult {
  const keepNewlines = more.keepNewlines;
  const r = parseQuickAdd(input, { now, listNames, skip: SUBTASK_SKIP, weekendDay, keepNewlines });
  if (r.due === null && r.dueTime === null) return r;
  // 光杆「每」/「每月」的清理**留着**。循环认了之后它只剩一种触发场景:用户打了个孤零零的「每」、
  // 日期另写在别处(「每 交周报 明天」)——那个「每」是半句没说完的话,不是标题的一部分。
  // 仍然只在识别出日期/时间时才扫,所以「每日一记」「每人一份」这类正文一个字都不动。
  // 「每个月」跟「每月」同一个待遇(说法放宽之后,光杆的「每个月」也得扫得掉)
  const title = tidyTitle(r.title, keepNewlines, (l) =>
    l.replace(/(?:^|\s)每(?:个?月)?(?=\s|$)/g, " ").replace(/\s+/g, " ").trim(),
  );
  return { ...r, title };
}
