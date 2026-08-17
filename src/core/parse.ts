// 快速添加输入框的中文自然语言解析(纯逻辑,零 DOM)。
// 符号分工:#标签 /清单 @需求方 !优先级。
// 策略:按固定优先级依次扫描各类 token,用字符占用表防止同一段文字被解析两次;
// 未被占用的字符收拢空白后即标题。同一字段出现多个 token 时,按出现位置后者生效。

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
  who: string | null;
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
  // 字符类统一排斥 / ——否则「#紧要/工作」会整体吞成一个标签,清单丢失
  tag: /#([^\s#@/!！]+)/g,
  // '/' 必须在行首或空白之后,防止误吞 8/20 这类日期
  list: /(?<!\S)\/([^\s#@/!！]+)/g,
  who: /@([^\s#@/!！]+)/g,
  prioWord: /[!！](高|中|低)/g,
  prioBang: /[!！]+/g,
  repWorkday: /每个?工作日/g,
  repWeekly: /每周([一二三四五六日天]+)/g,
  repMonthly: new RegExp(`每月(${NUM})[号日]`, "g"),
  repEveryN: new RegExp(`每(${NUM})天`, "g"),
  repDaily: /每天/g,
  ymd: /(?<![\d-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d-])/g,
  monthDay: new RegExp(`(?<!\\d)(${NUM})月(${NUM})[日号]`, "g"),
  monthEndN: new RegExp(`(?<!\\d)(${NUM})月底`, "g"),
  monthPart: /月底|月初|月中|年底/g,
  // 与 RE.list 同款左边界:必须在行首或空白后,防止「比分3-2」「得了3/4」这类正文被吞成日期
  mmDd: /(?<!\S)(\d{1,2})-(\d{1,2})(?![\d-])/g,
  mmSlashDd: /(?<!\S)(\d{1,2})\/(\d{1,2})(?![\d/])/g,
  relWord: /大后天|后天|明天|今晚|今天/g,
  otherWeek: /([上下本])(?:周|星期)([一二三四五六日天])/g,
  weekday: /(?:周|星期)([一二三四五六日天])/g,
  daysAfter: new RegExp(`(?<!\\d)(${NUM})天后`, "g"),
  weeksAfter: new RegExp(`(?<!\\d)(${NUM})周后`, "g"),
  bareDay: new RegExp(`(?<!\\d)(${NUM})号`, "g"),
  hhmm: /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g,
  clock: new RegExp(`(上午|早上|中午|下午|晚上)?(?<!\\d)(${NUM})点(半|(${NUM})分)?`, "g"),
  noon: /中午/g,
};

// 长词在前:「之前」自身含「前」
const DEADLINE = ["之前", "以前", "前"];

// ---------- 主入口 ----------

export function parseQuickAdd(input: string, opts: { now: Date; listNames: string[] }): ParseResult {
  const today = todayYMD(opts.now);
  const consumed: boolean[] = new Array<boolean>(input.length).fill(false);

  const st = {
    due: null as string | null,
    dateSet: false,
    tonight: false,
    dueTime: null as string | null,
    repeat: null as RepeatRule | null,
    priority: 0 as Priority,
    who: null as string | null,
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
      if (eatDeadline) {
        const suf = DEADLINE.find((w) => input.startsWith(w, b));
        if (suf !== undefined && free(b, b + suf.length)) {
          // 单字「前」只在词尾（后面是空白/行尾/token 符号）才算语气词，
          // 否则会吞掉「前端」「前台」这类内容词的首字
          const after = input[b + suf.length];
          const atBoundary = after === undefined || /[\s#@/!！]/.test(after);
          if (suf !== "前" || atBoundary) b += suf.length;
        }
      }
      for (let i = a; i < b; i++) consumed[i] = true;
      tokens.push({ start: a, chip: t.chip, apply: t.apply });
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

  // ---- 1. #标签(只管标签,取到空白或下一个 #@! 为止) ----
  scan(RE.tag, (m) => {
    const name = m[1];
    st.tags.push(name);
    return { chip: { kind: "tag", text: name }, apply: () => {} };
  });

  // ---- 2. /清单(先精确后前缀,都不中原样返回交由调用方新建;扫描序即出现序,覆盖实现「最后一个生效」) ----
  scan(RE.list, (m) => {
    const name = m[1];
    const hit =
      opts.listNames.find((n) => n === name) ?? opts.listNames.find((n) => n.startsWith(name));
    const final = hit ?? name;
    st.listName = final;
    return { chip: { kind: "list", text: final }, apply: () => {} };
  });

  // ---- 3. @人(同一正则扫描顺序即出现顺序,直接覆盖实现「最后一个生效」) ----
  scan(RE.who, (m) => {
    const name = m[1];
    st.who = name;
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

  scan(RE.repMonthly, (m) => {
    const d = num(m[1]);
    if (d === null || d < 1 || d > 31) return null;
    return {
      chip: { kind: "repeat", text: `每月${d}号` },
      apply: (s) => {
        s.repeat = { kind: "monthly", day: d };
      },
    };
  });

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

  // 月底/月初/月中/年底
  scan(
    RE.monthPart,
    (m) => {
      const w = m[0];
      let ymd: string;
      if (w === "年底") {
        const y = Number(today.slice(0, 4));
        ymd = cmpYMD(`${y}-12-31`, today) >= 0 ? `${y}-12-31` : `${y + 1}-12-31`;
      } else {
        ymd = resolveMonthPoint(w === "月底" ? "end" : w === "月初" ? 1 : 15);
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
      if (w === "今晚") {
        return {
          chip: { kind: "date", text: "今晚" },
          apply: (s) => {
            s.due = today;
            s.dateSet = true;
            s.tonight = true;
          },
        };
      }
      const off = w === "今天" ? 0 : w === "明天" ? 1 : w === "后天" ? 2 : 3;
      const ymd = addDays(today, off);
      return { chip: dateChip(ymd), apply: setDate(ymd) };
    },
    true,
  );

  // 上/下/本 + 周X:以周一为一周开始的自然周定位(「上周X」为容错,产出过去日期)
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
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    const hm = `${pad2(h)}:${pad2(mi)}`;
    return {
      chip: { kind: "time", text: hm },
      apply: (s) => {
        s.dueTime = hm;
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
    return {
      chip: { kind: "time", text: hm },
      apply: (s) => {
        s.dueTime = hm;
      },
    };
  });

  // 独立的「中午」= 12:00(带钟点的「中午N点」已被上一条吃掉)
  scan(RE.noon, () => ({
    chip: { kind: "time", text: "12:00" },
    apply: (s) => {
      s.dueTime = "12:00";
    },
  }));

  // ---- 8. 裸感叹号串(放最后:此时紧随的 token 已被占用,可视作边界) ----
  // 全角/半角混合按总长度计级;紧跟普通正文(「!棒」)时按标点处理,不吞。
  scan(RE.prioBang, (m) => {
    const b = m.index + m[0].length;
    if (b < input.length && !consumed[b] && !/[\s#@]/.test(input[b])) return null;
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

  let due: string | null = null;
  if (st.dateSet) due = st.due;
  else if (st.repeat !== null) due = firstOccurrence(st.repeat, today);
  else if (st.dueTime !== null) {
    // 只给时间没给日期:默认今天,该时刻已过(含恰好等于现在)则明天
    const nowHM = nowLocalDT(opts.now).slice(11);
    due = st.dueTime <= nowHM ? addDays(today, 1) : today;
  }

  const dueTime = st.dueTime !== null ? st.dueTime : st.tonight ? "20:00" : null;

  let title = "";
  for (let i = 0; i < input.length; i++) if (!consumed[i]) title += input[i];
  title = title.replace(/\s+/g, " ").trim();
  // 识别出时间/日期后，「20点提醒我」这类说法残留的"提醒(我)"是指令词不是内容，去掉。
  // 只删两种安全形态：独立成词的"提醒/提醒我"、句首的"提醒我"——"写提醒事项"这类内容词不动
  if (st.dueTime !== null || st.dateSet) {
    title = title
      .replace(/(?:^|\s)提醒我?(?=\s|$)/g, " ")
      .replace(/^提醒我/, "")
      .replace(/\s+/g, " ")
      .trim();
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
    chips: tokens.map((t) => t.chip),
  };
}
