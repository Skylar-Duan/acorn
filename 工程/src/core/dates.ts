// 日期工具：全应用统一用本地时区的 'YYYY-MM-DD' 字符串表示日期，
// 'HH:mm' 表示时间。避免 Date 序列化/时区带来的隐性偏移。

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Date -> 'YYYY-MM-DD'（本地时区） */
export function toYMD(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date（本地 00:00） */
export function fromYMD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function todayYMD(now: Date = new Date()): string {
  return toYMD(now);
}

export function addDays(ymd: string, n: number): string {
  const d = fromYMD(ymd);
  d.setDate(d.getDate() + n);
  return toYMD(d);
}

/** 0=周日 … 6=周六（与 Date.getDay 一致） */
export function dayOfWeek(ymd: string): number {
  return fromYMD(ymd).getDay();
}

export function isWorkday(ymd: string): boolean {
  const w = dayOfWeek(ymd);
  return w >= 1 && w <= 5;
}

export function daysInMonth(year: number, month1: number): number {
  // month1: 1..12
  return new Date(year, month1, 0).getDate();
}

/** 'YYYY-MM-DD' 比较：a<b 负数，a===b 0，a>b 正数（字符串序即时间序） */
export function cmpYMD(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 原生 `<input type="date">` 吐出来的这个值，是不是一个人真的会安排的日子。
 *
 *  拦的是**键盘敲年份时的中间态**：Chromium 的年份段是累加的，敲 2 / 0 / 2 / 7
 *  会依次发出 `0002-…` / `0020-…` / `0202-…` / `2027-…` 四次 change，
 *  而这四个都是**格式合法的完整日期**——只判空串一个都拦不住，于是四次全落库，
 *  postponeCount 一次连加 3、还连压好几张撤销快照，行上凭空冒出「顺延×3」。
 *
 *  判据取「年份 1900–2999」：四位年的中间态最大只到 299（floor(2999/10)），
 *  必定落在这一格外面；鼠标点日历格出来的一律是四位年，一点不受影响。 */
export function isPlausibleYMD(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = Number(v.slice(0, 4));
  return y >= 1900 && y <= 2999;
}

/** 两个日期相差的天数：b - a */
export function diffDays(a: string, b: string): number {
  const ms = fromYMD(b).getTime() - fromYMD(a).getTime();
  return Math.round(ms / 86400000);
}

/** 本周一（周作为回顾单位，周一开始） */
export function weekStart(ymd: string): string {
  const w = dayOfWeek(ymd);
  return addDays(ymd, w === 0 ? -6 : 1 - w);
}

/** 当月一号 */
export function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** 当月最后一天 */
export function monthEnd(ymd: string): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  return `${ymd.slice(0, 7)}-${pad2(daysInMonth(y, m))}`;
}

/** 从 ymd 起（**含当天**）往后最近的那个星期几。dow：0=周日 … 6=周六。
 *  「向后取最近的一个」是全部日期预设的统一口径：过了就顺延到下一个，绝不给出一个过去的日子 */
export function nextDow(ymd: string, dow: number): string {
  return addDays(ymd, (dow - dayOfWeek(ymd) + 7) % 7);
}

/** 安排日期的一个快捷预设 */
export interface DuePreset {
  /** 稳定标识，UI 拿它做 key，不随标签变 */
  key: "today" | "fri" | "sun" | "monthEnd";
  /** 按算出来的日子现取的名字：周六点开时「本周五」就写成「下周五」 */
  label: string;
  ymd: string;
}

/** 安排日期的快捷预设：今天 / 本周五 / 本周日 / 本月末。
 *
 *  三条规矩：
 *  ① 一律**向后取最近的一个**（周起始按周一），过了就顺延到下一个；
 *  ② 标签跟着算出来的日子走，落在下一周就叫「下周五」；
 *  ③ **跟「今天」撞上同一天的预设直接不出现**——两个按钮干同一件事，只会让人多犹豫一下。
 *     「本月末」正好是今天时也照此隐掉（它不可能往后跑到下个月，所以没有「下月末」这一说）。 */
export function duePresets(today: string): DuePreset[] {
  const weekEnd = addDays(weekStart(today), 6);
  const inThisWeek = (d: string) => cmpYMD(d, weekEnd) <= 0;
  const fri = nextDow(today, 5);
  const sun = nextDow(today, 0);
  const all: DuePreset[] = [
    { key: "today", label: "今天", ymd: today },
    { key: "fri", label: inThisWeek(fri) ? "本周五" : "下周五", ymd: fri },
    { key: "sun", label: inThisWeek(sun) ? "本周日" : "下周日", ymd: sun },
    { key: "monthEnd", label: "本月末", ymd: monthEnd(today) },
  ];
  return all.filter((p) => p.key === "today" || p.ymd !== today);
}

const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** '8月17日 · 星期一' */
export function formatCN(ymd: string): string {
  const d = fromYMD(ymd);
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${WEEK_CN[d.getDay()]}`;
}

/** 短格式：今天/明天/昨天/8月21日，超过今年附带年份 */
export function formatShort(ymd: string, now: Date = new Date()): string {
  const t = todayYMD(now);
  const diff = diffDays(t, ymd);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  if (diff === -1) return "昨天";
  const d = fromYMD(ymd);
  const base = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? base : `${d.getFullYear()}年${base}`;
}

/** 「完成于 / 放弃于」后面那半句（v1.9.1）：今天 / 昨天 / 8月28日 / 25年12月28日。
 *
 *  **刻意跟 formatShort 分家，不是图省事复制**。两处口径本来就不一样：
 *   ① formatShort 认「明天 / 后天」——收场日期不可能在未来，写「完成于 后天」是句胡话；
 *   ② 年份的门槛不同。formatShort 是「**不是今年**就带年份」，1 月 2 日回头看去年 12 月 31 日
 *      会写成「2025年12月31日」（实测 122px，塞不进为「完成于 12月28日」划的那条 88px 右侧线）；
 *      这里按用户说的「**超出一年**才显示年份」，跨年那两天照旧写「12月31日」。
 *   ③ 带年份时只写两位（25年12月28日），四位年那一档太宽。
 *  formatShort 有 8 处调用（语法高亮 chip、任务卡的日期按钮 ×2、快捷记、搜索、四象限、任务行 ×2），
 *  在它身上改年份规则会把「记一条」时的日期 chip 和四象限的日期口径一起改掉。别动它。
 *
 *  返回值里带不带年份，调用方要拿来决定右列放不放宽 —— 见 doneShortIsWide */
export function formatDoneShort(ymd: string, now: Date = new Date()): string {
  const t = todayYMD(now);
  const diff = diffDays(t, ymd);
  if (diff === 0) return "今天";
  if (diff === -1) return "昨天";
  const d = fromYMD(ymd);
  const base = `${d.getMonth() + 1}月${d.getDate()}日`;
  return doneShortIsWide(ymd, now) ? `${String(d.getFullYear()).slice(2)}年${base}` : base;
}

/** 这个日子归到「超过一年」那一档吗（= formatDoneShort 会给它加年份）。
 *  门槛取「今天往前推整一年的那一天」：那天本身还算一年之内，再早一天才带年份。
 *  分成两个函数是因为 UI 要**先知道宽不宽**才能决定给不给那一格放宽 */
export function doneShortIsWide(ymd: string, now: Date = new Date()): boolean {
  const cut = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  return fromYMD(ymd).getTime() < cut.getTime();
}

/** 'YYYY-MM-DDTHH:mm'（本地）；reminder 存储用 */
export function toLocalDT(ymd: string, hm: string): string {
  return `${ymd}T${hm}`;
}

export function nowLocalDT(now: Date = new Date()): string {
  return `${toYMD(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}
