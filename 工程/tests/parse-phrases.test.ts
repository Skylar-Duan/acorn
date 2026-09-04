// v1.12.x 日期便捷语扩充 + 「周末指周几」设置。
// PM 批准的清单：周末/下周末（周六还是周日看设置，默认周日）、下下周X、N天内、N个月后、
// 下月初/中/底、月末、下个月X号、明早/明晚/后天晚上 这类「日 + 时段」、X前、今年年底/明年X月、节日。
// 所有「现在」都是注入的固定时刻，不依赖真实日期。基准：2026-08-21 周五 10:00。

import { beforeEach, describe, expect, it } from "vitest";
import { parseQuickAdd, parseSubtaskInput } from "../src/core/parse";
import type { ParseOpts, ParseResult } from "../src/core/parse";
import { holidayDate } from "../src/core/holidays";
import { defaultSettings, migrate } from "../src/core/model";
import { appStore, updateSettings } from "../src/core/store";
import { windowContext } from "../src/core/windowCtx";
import settingsSource from "../src/views/Settings.tsx?raw";
import quickAddBarSource from "../src/components/QuickAddBar.tsx?raw";
import taskCardSource from "../src/components/TaskCard.tsx?raw";
import quickAddWinSource from "../src/windows/quickadd.tsx?raw";
import guideContentSource from "../src/components/GuideContent.tsx?raw";

const LISTS = ["工作", "生活"];
const FRI = new Date(2026, 7, 21, 10, 0); // 2026-08-21 周五 10:00
const SAT = new Date(2026, 7, 22, 10, 0); // 周六
const SUN = new Date(2026, 7, 23, 10, 0); // 周日

const p = (input: string, now: Date = FRI, weekendDay?: ParseOpts["weekendDay"]): ParseResult =>
  parseQuickAdd(input, { now, listNames: LISTS, weekendDay });

describe("1. 周末 / 本周末 / 这周末 / 下周末（周末日看设置，默认周日）", () => {
  it("周末 = 本周日（默认）", () => {
    const r = p("周末 陪爸妈吃饭");
    expect(r.due).toBe("2026-08-23");
    expect(r.title).toBe("陪爸妈吃饭");
    expect(r.chips[0]).toEqual({ kind: "date", text: "后天" });
  });

  it("设置成周六：周末 = 本周六", () => {
    const r = p("周末 陪爸妈吃饭", FRI, "sat");
    expect(r.due).toBe("2026-08-22");
    expect(r.title).toBe("陪爸妈吃饭");
  });

  it("本周末 / 这周末 跟「周末」一样", () => {
    expect(p("本周末 大扫除").due).toBe("2026-08-23");
    expect(p("这周末 大扫除").due).toBe("2026-08-23");
    expect(p("本周末 大扫除", FRI, "sat").due).toBe("2026-08-22");
    expect(p("这周末 大扫除", FRI, "sat").due).toBe("2026-08-22");
  });

  it("下周末 = 下周的周末日", () => {
    expect(p("下周末 爬山").due).toBe("2026-08-30");
    expect(p("下周末 爬山", FRI, "sat").due).toBe("2026-08-29");
    expect(p("下周末 爬山").title).toBe("爬山");
  });

  it("下下周末 = 再下一周", () => {
    expect(p("下下周末 露营").due).toBe("2026-09-06");
    expect(p("下下周末 露营", FRI, "sat").due).toBe("2026-09-05");
  });

  it("今天已经是周六：周日档算明天，周六档算今天", () => {
    expect(p("周末 睡懒觉", SAT).due).toBe("2026-08-23");
    expect(p("周末 睡懒觉", SAT, "sat").due).toBe("2026-08-22");
  });

  it("今天已经是周日：两档都算今天（本周末就是今天）", () => {
    expect(p("周末 睡懒觉", SUN).due).toBe("2026-08-23");
    expect(p("周末 睡懒觉", SUN, "sat").due).toBe("2026-08-23");
    // 下周末不受这条特例影响：周六档照旧给下周六
    expect(p("下周末 露营", SUN, "sat").due).toBe("2026-08-29");
  });

  it("周末前 = 周末那天本身（「前」只是措辞）", () => {
    const r = p("周末前 交稿");
    expect(r.due).toBe("2026-08-23");
    expect(r.title).toBe("交稿");
  });

  it("不认识的值当周日", () => {
    expect(parseQuickAdd("周末 走走", { now: FRI, listNames: [], weekendDay: "xx" as never }).due).toBe("2026-08-23");
  });

  it("子任务输入同样吃这个设置", () => {
    expect(parseSubtaskInput("周末 画图", FRI, [], "sat").due).toBe("2026-08-22");
    expect(parseSubtaskInput("周末 画图", FRI).due).toBe("2026-08-23");
  });
});

describe("2. 下下周X", () => {
  it("下下周三 = 再下一周的周三", () => {
    const r = p("下下周三 复查");
    expect(r.due).toBe("2026-09-02");
    expect(r.title).toBe("复查");
  });

  it("下周三 不被「下下周三」污染，仍是下周", () => {
    expect(p("下周三 体检").due).toBe("2026-08-26");
    expect(p("下周三 体检").title).toBe("体检");
  });

  it("下下周日 / 下下星期一", () => {
    expect(p("下下周日 爬山").due).toBe("2026-09-06");
    expect(p("下下星期一 汇报").due).toBe("2026-08-31");
  });

  it("这周三 = 本周三（跟「本周三」一样，允许已过）", () => {
    expect(p("这周三 补记录").due).toBe("2026-08-19");
  });
});

describe("3. N天内 = N天后；N个月后 / N月后", () => {
  it("三天内 = 三天后", () => {
    const a = p("三天内 回复邮件");
    const b = p("三天后 回复邮件");
    expect(a.due).toBe("2026-08-24");
    expect(a.due).toBe(b.due);
    expect(a.title).toBe("回复邮件");
    expect(p("10天内 交稿").due).toBe("2026-08-31");
  });

  it("三个月后 = 往后三个月的同一天", () => {
    const r = p("三个月后 复查");
    expect(r.due).toBe("2026-11-21");
    expect(r.title).toBe("复查");
    expect(p("1个月后 复查").due).toBe("2026-09-21");
    expect(p("3月后 复查").due).toBe("2026-11-21");
  });

  it("月末溢出取那个月最后一天：1月31日 + 一个月 = 2月28日", () => {
    expect(p("一个月后 体检", new Date(2026, 0, 31, 9, 0)).due).toBe("2026-02-28");
    expect(p("四个月后 体检", new Date(2026, 9, 31, 9, 0)).due).toBe("2027-02-28");
    expect(p("一个月后 体检", new Date(2028, 0, 31, 9, 0)).due).toBe("2028-02-29");
  });

  it("跨年：11月15日 + 两个月 = 明年1月15日", () => {
    expect(p("两个月后 续约", new Date(2026, 10, 15, 9, 0)).due).toBe("2027-01-15");
  });
});

describe("4. 下月初 / 下月中 / 下月底 / 月末", () => {
  it("下月初 / 下月中 / 下月底", () => {
    expect(p("下月初 交房租").due).toBe("2026-09-01");
    expect(p("下月中 发工资").due).toBe("2026-09-15");
    expect(p("下月底 结项").due).toBe("2026-09-30");
    expect(p("下个月底 结项").due).toBe("2026-09-30");
    expect(p("下月底 结项").title).toBe("结项");
  });

  it("月末 = 月底；本月底 / 这个月底 同", () => {
    expect(p("月末 报销").due).toBe("2026-08-31");
    expect(p("本月底 报销").due).toBe("2026-08-31");
    expect(p("这个月底 报销").due).toBe("2026-08-31");
    expect(p("月末 报销").title).toBe("报销");
  });

  it("跨年：12 月里说下月初 / 下月底", () => {
    expect(p("下月初 交房租", new Date(2026, 11, 10, 9, 0)).due).toBe("2027-01-01");
    expect(p("下月底 结算", new Date(2026, 11, 10, 9, 0)).due).toBe("2027-01-31");
  });

  it("2 月：平年 28、闰年 29", () => {
    expect(p("下月底 报表", new Date(2027, 0, 10, 9, 0)).due).toBe("2027-02-28");
    expect(p("下月底 报表", new Date(2028, 0, 10, 9, 0)).due).toBe("2028-02-29");
  });

  it("下月底前 = 下月底", () => {
    const r = p("下月底前 结算");
    expect(r.due).toBe("2026-09-30");
    expect(r.title).toBe("结算");
  });
});

describe("5. 下个月X号 / 这个月X号 / 本月X号", () => {
  it("下个月5号 / 下月5号", () => {
    expect(p("下个月5号 领工资").due).toBe("2026-09-05");
    expect(p("下月5号 领工资").due).toBe("2026-09-05");
    expect(p("下个月5号 领工资").title).toBe("领工资");
  });

  it("这个月25号 / 本月5号（本月的，哪怕已过）", () => {
    expect(p("这个月25号 交水电费").due).toBe("2026-08-25");
    expect(p("本月5号 交房租").due).toBe("2026-08-05");
    expect(p("本月三十一号 交房租").due).toBe("2026-08-31");
  });

  it("那个月没有这一天就落在月末（跟每月N号一个口径）", () => {
    expect(p("下个月30号 还款", new Date(2026, 0, 20, 9, 0)).due).toBe("2026-02-28");
    expect(p("下个月30号 还款", new Date(2026, 0, 20, 9, 0)).title).toBe("还款");
  });

  it("跨年：12 月里说下个月3号", () => {
    expect(p("下个月3号 复诊", new Date(2026, 11, 20, 9, 0)).due).toBe("2027-01-03");
  });
});

describe("6. 日 + 时段：明早 / 明晚 / 后天晚上 / 今天下午", () => {
  it("明早 = 明天 09:00，芯片写原词", () => {
    const r = p("明早 晨跑");
    expect(r.due).toBe("2026-08-22");
    expect(r.dueTime).toBe("09:00");
    expect(r.title).toBe("晨跑");
    expect(r.chips[0]).toEqual({ kind: "date", text: "明早" });
  });

  it("明晚 = 明天 20:00；今早 = 今天 09:00", () => {
    expect(p("明晚 看电影").due).toBe("2026-08-22");
    expect(p("明晚 看电影").dueTime).toBe("20:00");
    expect(p("今早 喝药").due).toBe("2026-08-21");
    expect(p("今早 喝药").dueTime).toBe("09:00");
  });

  it("后天晚上 = 后天 20:00，日期芯片 + 时间芯片", () => {
    const r = p("后天晚上 聚餐");
    expect(r.due).toBe("2026-08-23");
    expect(r.dueTime).toBe("20:00");
    expect(r.title).toBe("聚餐");
    expect(r.chips).toEqual([
      { kind: "date", text: "后天" },
      { kind: "time", text: "20:00" },
    ]);
  });

  it("今天下午 / 明天上午 / 明天中午（各自的默认钟点）", () => {
    expect(p("今天下午 开会").dueTime).toBe("15:00");
    expect(p("今天下午 开会").due).toBe("2026-08-21");
    expect(p("明天上午 面试").dueTime).toBe("09:00");
    expect(p("明天中午 吃饭").dueTime).toBe("12:00");
    expect(p("明天早上 晨跑").dueTime).toBe("09:00");
  });

  it("时段紧贴正文也认：「明天下午开会」", () => {
    const r = p("明天下午开会");
    expect(r.due).toBe("2026-08-22");
    expect(r.dueTime).toBe("15:00");
    expect(r.title).toBe("开会");
  });

  it("周五下午 = 周五 15:00", () => {
    const r = p("周五下午 复盘");
    expect(r.due).toBe("2026-08-21");
    expect(r.dueTime).toBe("15:00");
    expect(r.title).toBe("复盘");
  });

  it("句子里另有明确钟点则以钟点为准", () => {
    expect(p("明天下午3点 面谈").dueTime).toBe("15:00");
    expect(p("明晚 21:30 交稿").dueTime).toBe("21:30");
    expect(p("明早 8点 晨跑").dueTime).toBe("08:00");
    expect(p("明早 8点 晨跑").title).toBe("晨跑");
  });

  it("时段和钟点之间隔个空格也算一起的：「下午 3点」「下午 3:30」= 15 点", () => {
    expect(p("明天下午 3点 面谈").dueTime).toBe("15:00");
    expect(p("明天下午 3点 面谈").title).toBe("面谈");
    expect(p("下午 3:30 面谈").dueTime).toBe("15:30");
    expect(p("下午 3:30 面谈").due).toBe("2026-08-21");
  });

  it("只有时段没有日期：今天，这个点已过则明天", () => {
    expect(p("下午 开会").due).toBe("2026-08-21");
    expect(p("下午 开会").dueTime).toBe("15:00");
    expect(p("早上 晨跑").due).toBe("2026-08-22"); // 09:00 已过（现在 10:00）
    expect(p("晚上 遛狗").dueTime).toBe("20:00");
    expect(p("晚上 遛狗").title).toBe("遛狗");
  });

  it("夹在正文里的时段词不吞：「喝下午茶」「讨论下午茶方案」", () => {
    expect(p("下午4点半 喝下午茶").title).toBe("喝下午茶");
    const r = p("明天 讨论下午茶方案");
    expect(r.title).toBe("讨论下午茶方案");
    expect(r.dueTime).toBeNull();
    expect(p("开会 上午班次表").title).toBe("开会 上午班次表");
  });

  it("独立「中午」照旧 = 12:00（老行为不变）", () => {
    const r = p("中午 吃饭");
    expect(r.dueTime).toBe("12:00");
    expect(r.due).toBe("2026-08-21");
    expect(r.title).toBe("吃饭");
  });
});

describe("7. X前：日期取那一天本身", () => {
  it("周五前 / 明天前 / 月底前 / 9月1日前", () => {
    expect(p("周五前 交周报").due).toBe("2026-08-21");
    expect(p("周五前 交周报").title).toBe("交周报");
    expect(p("明天前 回复").due).toBe("2026-08-22");
    expect(p("月底前 报销").due).toBe("2026-08-31");
    expect(p("9月1日前 缴学费").due).toBe("2026-09-01");
    expect(p("9月1日前 缴学费").title).toBe("缴学费");
  });

  it("下周前 / 本周前 / 这周前 = 本周日（跟周末日设置无关）", () => {
    const r = p("下周前 定方案");
    expect(r.due).toBe("2026-08-23");
    expect(r.title).toBe("定方案");
    expect(p("本周前 交材料").due).toBe("2026-08-23");
    expect(p("这周前 交材料").due).toBe("2026-08-23");
    expect(p("下周之前 定方案").due).toBe("2026-08-23");
    expect(p("下周前 定方案", FRI, "sat").due).toBe("2026-08-23");
  });

  it("今天就是周日：下周前 = 今天", () => {
    expect(p("下周前 定方案", SUN).due).toBe("2026-08-23");
  });

  it("「下周前端联调」不是日期", () => {
    const r = p("下周前端联调");
    expect(r.due).toBeNull();
    expect(r.title).toBe("下周前端联调");
  });

  it("春节前 / 下下周三前", () => {
    expect(p("春节前 买好车票").due).toBe("2027-02-06");
    expect(p("春节前 买好车票").title).toBe("买好车票");
    expect(p("下下周三前 交稿").due).toBe("2026-09-02");
  });
});

describe("8. 今年年底 / 明年X月", () => {
  it("今年年底 / 今年底 = 今年 12 月 31 日", () => {
    const r = p("今年年底 年度总结");
    expect(r.due).toBe("2026-12-31");
    expect(r.title).toBe("年度总结");
    expect(p("今年底 年度总结").due).toBe("2026-12-31");
    expect(p("今年底 年度总结").title).toBe("年度总结");
  });

  it("明年年底 / 明年底", () => {
    expect(p("明年年底 换车").due).toBe("2027-12-31");
    expect(p("明年底 换车").due).toBe("2027-12-31");
  });

  it("明年3月 = 明年 3 月 1 号，芯片带年份", () => {
    const r = p("明年3月 换工作");
    expect(r.due).toBe("2027-03-01");
    expect(r.title).toBe("换工作");
    expect(r.chips[0]).toEqual({ kind: "date", text: "2027年3月1日" });
    expect(p("明年三月 换工作").due).toBe("2027-03-01");
    expect(p("明年3月份 换工作").due).toBe("2027-03-01");
  });

  it("明年3月5日 / 明年2月底 照字面", () => {
    expect(p("明年3月5日 纪念日").due).toBe("2027-03-05");
    expect(p("明年2月底 报表").due).toBe("2027-02-28");
    expect(p("明年2月底 报表", new Date(2027, 7, 21, 9, 0)).due).toBe("2028-02-29");
  });

  it("明年13月 不认", () => {
    const r = p("明年13月 胡说");
    expect(r.due).toBeNull();
    expect(r.title).toBe("明年13月 胡说");
  });

  it("裸「年底」不受影响", () => {
    expect(p("年底 总结").due).toBe("2026-12-31");
  });
});

describe("9. 节日", () => {
  it("公历节日：已过取明年，没过取今年", () => {
    expect(p("元旦 放假").due).toBe("2027-01-01");
    expect(p("情人节 订餐厅").due).toBe("2027-02-14");
    expect(p("劳动节 出游").due).toBe("2027-05-01");
    expect(p("五一 出游").due).toBe("2027-05-01");
    expect(p("五一劳动节 出游").due).toBe("2027-05-01");
    expect(p("儿童节 买礼物").due).toBe("2027-06-01");
    expect(p("六一儿童节 买礼物").due).toBe("2027-06-01");
    expect(p("国庆 出游").due).toBe("2026-10-01");
    expect(p("国庆节 出游").due).toBe("2026-10-01");
    expect(p("圣诞 聚会").due).toBe("2026-12-25");
    expect(p("圣诞节 聚会").due).toBe("2026-12-25");
    expect(p("五一劳动节 出游").title).toBe("出游");
  });

  it("农历节日：查表", () => {
    expect(p("春节 回家").due).toBe("2027-02-06");
    expect(p("春节 回家").title).toBe("回家");
    expect(p("清明 扫墓").due).toBe("2027-04-05");
    expect(p("清明节 扫墓").due).toBe("2027-04-05");
    expect(p("端午 包粽子").due).toBe("2027-06-09");
    expect(p("端午节 包粽子").due).toBe("2027-06-09");
    expect(p("中秋 送礼").due).toBe("2026-09-25");
    expect(p("中秋节 送礼").due).toBe("2026-09-25");
  });

  it("就是今天：算今天；刚过一天：取明年那次", () => {
    expect(p("中秋 团圆饭", new Date(2026, 8, 25, 9, 0)).due).toBe("2026-09-25");
    expect(p("中秋 团圆饭", new Date(2026, 8, 26, 9, 0)).due).toBe("2027-09-15");
  });

  it("表外年份不认，原文留在标题里", () => {
    const r = p("中秋 送礼", new Date(2030, 9, 1, 9, 0)); // 2030 的中秋已过，2031 不在表里
    expect(r.due).toBeNull();
    expect(r.title).toBe("中秋 送礼");
    expect(p("春节 回家", new Date(2030, 2, 1, 9, 0)).due).toBeNull();
    // 公历节日不受表的限制
    expect(p("国庆 出游", new Date(2031, 0, 5, 9, 0)).due).toBe("2031-10-01");
  });

  it("2025–2030 整张表逐格核对", () => {
    const table: Record<number, [string, string, string, string]> = {
      2025: ["01-29", "04-04", "05-31", "10-06"],
      2026: ["02-17", "04-05", "06-19", "09-25"],
      2027: ["02-06", "04-05", "06-09", "09-15"],
      2028: ["01-26", "04-04", "05-28", "10-03"],
      2029: ["02-13", "04-04", "06-16", "09-22"],
      2030: ["02-03", "04-05", "06-05", "09-12"],
    };
    for (const [y, [cj, qm, dw, zq]] of Object.entries(table)) {
      const jan1 = `${y}-01-01`;
      expect(holidayDate("春节", jan1)).toBe(`${y}-${cj}`);
      expect(holidayDate("清明", jan1)).toBe(`${y}-${qm}`);
      expect(holidayDate("端午", jan1)).toBe(`${y}-${dw}`);
      expect(holidayDate("中秋", jan1)).toBe(`${y}-${zq}`);
    }
    expect(holidayDate("春节", "2031-01-01")).toBeNull();
    expect(holidayDate("元旦", "2031-01-02")).toBe("2032-01-01");
    expect(holidayDate("不是节日", "2026-01-01")).toBeNull();
  });

  it("「周五一起吃饭」「星期五一起」不是劳动节", () => {
    const r = p("周五一起吃饭");
    expect(r.due).toBe("2026-08-21");
    expect(r.title).toBe("一起吃饭");
    expect(p("星期五一起 复盘").due).toBe("2026-08-21");
    expect(p("星期五一起 复盘").title).toBe("一起 复盘");
  });
});

describe("10. 芯片文字沿用现有格式", () => {
  it("周末 / 下周末 / 三个月后 / 春节 的芯片", () => {
    expect(p("周末 走走").chips[0]).toEqual({ kind: "date", text: "后天" });
    expect(p("下周末 走走").chips[0]).toEqual({ kind: "date", text: "8月30日" });
    expect(p("三个月后 复查").chips[0]).toEqual({ kind: "date", text: "11月21日" });
    expect(p("春节 回家").chips[0]).toEqual({ kind: "date", text: "2027年2月6日" });
    expect(p("下月初 交房租").chips[0]).toEqual({ kind: "date", text: "9月1日" });
  });

  it("带时段的：今晚 / 明早 照原词，后天晚上 = 日期 + 时间两枚", () => {
    expect(p("今晚 追剧").chips).toEqual([{ kind: "date", text: "今晚" }]);
    expect(p("明早 晨跑").chips).toEqual([{ kind: "date", text: "明早" }]);
    expect(p("明天下午 开会").chips).toEqual([
      { kind: "date", text: "明天" },
      { kind: "time", text: "15:00" },
    ]);
  });
});

describe("复核修正 1：今晚 / 明晚 + 裸钟点，钟点跟着「晚」走", () => {
  it("明晚8点 = 明天 20:00，时间芯片也写 20:00", () => {
    const r = p("明晚8点 看球");
    expect(r.due).toBe("2026-08-22");
    expect(r.dueTime).toBe("20:00");
    expect(r.title).toBe("看球");
    expect(r.chips).toEqual([
      { kind: "date", text: "明晚" },
      { kind: "time", text: "20:00" },
    ]);
  });

  it("明晚 8点（隔空格）/ 今晚8点 / 今晚 8:30", () => {
    expect(p("明晚 8点 看球").dueTime).toBe("20:00");
    expect(p("明晚 8点 看球").title).toBe("看球");
    expect(p("今晚8点 看球").dueTime).toBe("20:00");
    expect(p("今晚8点 看球").due).toBe("2026-08-21");
    expect(p("今晚8点 看球").title).toBe("看球");
    expect(p("今晚 8:30 看球").dueTime).toBe("20:30");
    expect(p("今晚 8:30 看球").chips[1]).toEqual({ kind: "time", text: "20:30" });
  });

  it("已经是下半天的钟点不动：明晚 21:30 / 今晚18点", () => {
    expect(p("明晚 21:30 交稿").dueTime).toBe("21:30");
    expect(p("今晚18点 吃饭").dueTime).toBe("18:00");
  });

  it("明早8点 仍是 08:00；早上的词不往下半天挪", () => {
    expect(p("明早8点 晨跑").dueTime).toBe("08:00");
    expect(p("明早 8点 晨跑").dueTime).toBe("08:00");
    expect(p("今早 7:30 喝药").dueTime).toBe("07:30");
  });

  it("钟点自己带了时段词就听钟点的：明晚 上午8点（写岔了也照字面）", () => {
    expect(p("明晚 上午8点 开会").dueTime).toBe("08:00");
  });

  it("时段词和钟点隔着正文也算一起的：明天晚上 看球 8点 / 今天中午 吃饭 1点", () => {
    expect(p("明天晚上 看球 8点").dueTime).toBe("20:00");
    expect(p("明天晚上 看球 8点").title).toBe("看球");
    expect(p("今天中午 吃饭 1点").dueTime).toBe("13:00");
    expect(p("明天下午 开会 提醒我 3点").dueTime).toBe("15:00");
    expect(p("明天下午 开会 提醒我 3点").title).toBe("开会");
    // 有明确钟点时，时段词那枚「默认钟点」芯片不另出，免得「12:00」「13:00」并排打架
    expect(p("明天晚上 看球 8点").chips).toEqual([
      { kind: "date", text: "明天" },
      { kind: "time", text: "20:00" },
    ]);
    expect(p("今天中午 吃饭 1点").chips).toEqual([
      { kind: "date", text: "今天" },
      { kind: "time", text: "13:00" },
    ]);
    // 没有明确钟点时照旧出那枚默认钟点芯片
    expect(p("后天晚上 聚餐").chips).toEqual([
      { kind: "date", text: "后天" },
      { kind: "time", text: "20:00" },
    ]);
  });

  it("没有时段词的裸钟点照旧：买票 20点提醒我 / 8点提醒我买菜", () => {
    expect(p("买票 20点提醒我").dueTime).toBe("20:00");
    expect(p("买票 20点提醒我").title).toBe("买票");
    expect(p("8点提醒我买菜").dueTime).toBe("08:00");
    expect(p("8点提醒我买菜").title).toBe("买菜");
  });
});

describe("复核修正 2：每周末 = 按周末日循环，不再被「周末」截胡", () => {
  it("每周末 大扫除 → 每周日循环（默认），首个落点本周日", () => {
    const r = p("每周末 大扫除");
    expect(r.repeat).toEqual({ kind: "weekly", days: [0] });
    expect(r.due).toBe("2026-08-23");
    expect(r.title).toBe("大扫除");
    expect(r.chips).toEqual([{ kind: "repeat", text: "每周日" }]);
  });

  it("设置成周六：每周六循环", () => {
    const r = p("每周末 大扫除", FRI, "sat");
    expect(r.repeat).toEqual({ kind: "weekly", days: [6] });
    expect(r.due).toBe("2026-08-22");
    expect(r.title).toBe("大扫除");
    expect(r.chips).toEqual([{ kind: "repeat", text: "每周六" }]);
  });

  it("子任务不认循环：「每周末」退化成一次性的周末，「每」不留在标题里", () => {
    const r = parseSubtaskInput("每周末 大扫除", FRI);
    expect(r.repeat).toBeNull();
    expect(r.due).toBe("2026-08-23");
    expect(r.title).toBe("大扫除");
  });
});

describe("复核修正 3：句首连着正文的时段词不吞", () => {
  it("下午茶 约小王 / 晚上好 问候 / 上午的会 改期 / 中午饭 一起：原样留在标题里", () => {
    for (const s of ["下午茶 约小王", "晚上好 问候", "上午的会 改期", "下午茶时间 讨论", "中午饭 一起"]) {
      const r = p(s);
      expect(r.title, s).toBe(s);
      expect(r.dueTime, s).toBeNull();
      expect(r.chips, s).toEqual([]);
    }
  });

  it("成词的句首时段词照认：下午 开会 / 晚上 遛狗 / 光一个「下午」；紧贴日期的照认：明天下午开会", () => {
    expect(p("下午 开会").dueTime).toBe("15:00");
    expect(p("下午 开会").title).toBe("开会");
    expect(p("晚上 遛狗").dueTime).toBe("20:00");
    expect(p("下午").dueTime).toBe("15:00");
    expect(p("明天下午开会").dueTime).toBe("15:00");
    expect(p("明天下午开会").title).toBe("开会");
    expect(p("周五晚上聚餐").dueTime).toBe("20:00");
    expect(p("周五晚上聚餐").title).toBe("聚餐");
  });
});

describe("复核修正 4：节日要成词；元旦节 / 五一节 / 六一 也认", () => {
  it("「集中秋招」「其中秋季」「全国庆祝」里的不是节日", () => {
    for (const s of ["集中秋招 面试", "其中秋季 汇报", "全国庆祝 活动", "看清明白 再说"]) {
      const r = p(s);
      expect(r.due, s).toBeNull();
      expect(r.title, s).toBe(s);
    }
  });

  it("句首 / 空格后 / 要素后 的节日照认", () => {
    expect(p("中秋 送礼").due).toBe("2026-09-25");
    expect(p("送礼 中秋").due).toBe("2026-09-25");
    expect(p("送礼 中秋").title).toBe("送礼");
    expect(p("#家人 中秋 送礼").due).toBe("2026-09-25");
    expect(p("#家人 中秋 送礼").tags).toEqual(["家人"]);
    expect(p("#家人 中秋 送礼").title).toBe("送礼");
  });

  it("元旦节 / 五一节 / 六一：认成节日，标题不剩「节」", () => {
    expect(p("元旦节 放假").due).toBe("2027-01-01");
    expect(p("元旦节 放假").title).toBe("放假");
    expect(p("五一节 出游").due).toBe("2027-05-01");
    expect(p("五一节 出游").title).toBe("出游");
    expect(p("六一 买礼物").due).toBe("2027-06-01");
    expect(p("六一 买礼物").title).toBe("买礼物");
  });

  it("「六一班 家长会」不是节日；「十一」太像数字，不认（写「国庆」）", () => {
    expect(p("六一班 家长会").due).toBeNull();
    expect(p("六一班 家长会").title).toBe("六一班 家长会");
    expect(p("十一 出游").due).toBeNull();
    expect(p("十一 出游").title).toBe("十一 出游");
  });

  it("取舍：贴着别的字的「过中秋」不认，得写「中秋 回家」", () => {
    expect(p("过中秋 回家").due).toBeNull();
    expect(p("过中秋 回家").title).toBe("过中秋 回家");
  });
});

describe("复核修正 5：明年春节 / 今年春节", () => {
  it("明年春节 = 明年那次，「明年」不留在标题里", () => {
    const r = p("明年春节 回家");
    expect(r.due).toBe("2027-02-06");
    expect(r.title).toBe("回家");
    expect(r.chips[0]).toEqual({ kind: "date", text: "2027年2月6日" });
  });

  it("2027 年 1 月：春节 = 2027-02-06，明年春节 = 2028-01-26", () => {
    const jan = new Date(2027, 0, 10, 9, 0);
    expect(p("春节 回家", jan).due).toBe("2027-02-06");
    expect(p("明年春节 回家", jan).due).toBe("2028-01-26");
    expect(p("明年春节前 买票", jan).due).toBe("2028-01-26");
    expect(p("明年春节前 买票", jan).title).toBe("买票");
    expect(p("明年国庆 出游", jan).due).toBe("2028-10-01");
    expect(p("明年元旦 放假", jan).due).toBe("2028-01-01");
  });

  it("今年春节 照字面取今年那次（哪怕已过）", () => {
    expect(p("今年春节 回家").due).toBe("2026-02-17");
    expect(p("今年春节 回家").title).toBe("回家");
    expect(p("今年国庆 出游").due).toBe("2026-10-01");
  });

  it("明年不在表里就整个不认，「明年春节」原样留在标题里", () => {
    const r = p("明年春节 回家", new Date(2030, 0, 10, 9, 0));
    expect(r.due).toBeNull();
    expect(r.title).toBe("明年春节 回家");
    expect(holidayDate("春节", "2027-01-10", "明年")).toBe("2028-01-26");
    expect(holidayDate("春节", "2030-01-10", "明年")).toBeNull();
    expect(holidayDate("春节", "2030-06-10", "今年")).toBe("2030-02-03");
    expect(holidayDate("元旦", "2030-06-10", "明年")).toBe("2031-01-01");
  });

  it("「明年3月」「明年底」不受节日前缀影响", () => {
    expect(p("明年3月 换工作").due).toBe("2027-03-01");
    expect(p("明年底 换车").due).toBe("2027-12-31");
  });
});

describe("设置：周末指周几", () => {
  beforeEach(() => {
    localStorage.clear();
    appStore.setState({ data: migrate({}), loaded: true, loadError: null });
  });

  it("默认周日；老设置缺这个字段时读成周日", () => {
    expect(defaultSettings().weekendDay).toBe("sun");
    expect(migrate({}).settings.weekendDay).toBe("sun");
    const old = migrate({ settings: { sortMode: "priority" } });
    expect(old.settings.weekendDay).toBe("sun");
    expect(old.settings.sortMode).toBe("priority");
    expect(migrate({ settings: { weekendDay: "sat" } }).settings.weekendDay).toBe("sat");
  });

  it("独立小窗拿到的 context 带着这个设置", () => {
    expect(windowContext().weekendDay).toBe("sun");
    updateSettings({ weekendDay: "sat" });
    expect(windowContext().weekendDay).toBe("sat");
  });

  it("设置页「行为」一节有「周末指的是」两个选项，且两端都渲染这一节", () => {
    expect(settingsSource).toContain("周末指的是");
    expect(settingsSource).toContain('["sat", "周六"]');
    expect(settingsSource).toContain('["sun", "周日"]');
    expect(settingsSource).toContain("updateSettings({ weekendDay: id })");
    // 以前整节被 (hasDesktopFeatures || FOCUS_ENABLED) 挡住，手机上会连这个选项一起藏掉
    expect(settingsSource).not.toContain("{(hasDesktopFeatures || FOCUS_ENABLED) && (");
  });

  it("每一个 SyntaxInput 调用点都把 weekendDay 喂进去了", () => {
    for (const [name, src] of [
      ["QuickAddBar", quickAddBarSource],
      ["TaskCard", taskCardSource],
      ["quickadd 小窗", quickAddWinSource],
      ["GuideContent", guideContentSource],
    ] as const) {
      const inputs = (src.match(/<SyntaxInput\b/g) ?? []).length;
      const fed = (src.match(/weekendDay=\{/g) ?? []).length;
      expect(inputs, name).toBeGreaterThan(0);
      expect(fed, `${name} 里 ${inputs} 个 SyntaxInput 只喂了 ${fed} 个`).toBeGreaterThanOrEqual(inputs);
    }
  });
});
