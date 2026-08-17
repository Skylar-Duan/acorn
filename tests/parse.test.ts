// parseQuickAdd 中文自然语言解析测试。
// 所有「现在」均为注入的固定时刻,不依赖真实时间。
// 基准时刻:2026-08-21 是周五,上午 10:00。

import { describe, it, expect } from "vitest";
import { parseQuickAdd } from "../src/core/parse";
import type { ParseResult } from "../src/core/parse";

const LISTS = ["工作", "生活"];
const FRI = new Date(2026, 7, 21, 10, 0); // 2026-08-21 周五 10:00

const p = (input: string, now: Date = FRI, listNames: string[] = LISTS): ParseResult =>
  parseQuickAdd(input, { now, listNames });

describe("日期 · 相对词", () => {
  it("今天", () => {
    const r = p("今天 买菜");
    expect(r.due).toBe("2026-08-21");
    expect(r.dueTime).toBeNull();
    expect(r.title).toBe("买菜");
  });

  it("明天(与正文无空格相连)", () => {
    const r = p("明天交报告");
    expect(r.due).toBe("2026-08-22");
    expect(r.title).toBe("交报告");
  });

  it("后天", () => {
    const r = p("后天 取快递");
    expect(r.due).toBe("2026-08-23");
    expect(r.title).toBe("取快递");
  });

  it("大后天(不被「后天」抢先)", () => {
    const r = p("大后天 复查");
    expect(r.due).toBe("2026-08-24");
    expect(r.title).toBe("复查");
  });

  it("今晚 = 今天,无显式时间时 dueTime 默认 20:00", () => {
    const r = p("今晚追剧");
    expect(r.due).toBe("2026-08-21");
    expect(r.dueTime).toBe("20:00");
    expect(r.title).toBe("追剧");
    expect(r.chips[0]).toEqual({ kind: "date", text: "今晚" });
  });

  it("今晚 + 显式时间:显式时间优先", () => {
    const r = p("今晚 21:30 交稿");
    expect(r.due).toBe("2026-08-21");
    expect(r.dueTime).toBe("21:30");
    expect(r.title).toBe("交稿");
  });
});

describe("日期 · 星期", () => {
  it("now 为周五时「周五」= 今天", () => {
    const r = p("周五 提交周报");
    expect(r.due).toBe("2026-08-21");
    expect(r.title).toBe("提交周报");
  });

  it("周一 = 下一个最近的周一", () => {
    expect(p("周一 汇报").due).toBe("2026-08-24");
  });

  it("星期天 = 最近的周日", () => {
    expect(p("星期天 大扫除").due).toBe("2026-08-23");
  });

  it("下周五 = 下一个自然周的周五(不是今天)", () => {
    const r = p("下周五 团建");
    expect(r.due).toBe("2026-08-28");
    expect(r.title).toBe("团建");
  });

  it("下周日 = 下一个自然周的周日", () => {
    expect(p("下周日 爬山").due).toBe("2026-08-30");
  });

  it("本周三 = 本自然周的周三(允许已过)", () => {
    expect(p("本周三 补记录").due).toBe("2026-08-19");
  });
});

describe("日期 · 月日与数字", () => {
  it("8月28日", () => {
    const r = p("8月28日 提案");
    expect(r.due).toBe("2026-08-28");
    expect(r.dueTime).toBeNull();
    expect(r.chips[0]).toEqual({ kind: "date", text: "8月28日" });
  });

  it("9月1号", () => {
    expect(p("9月1号 缴学费").due).toBe("2026-09-01");
  });

  it("N月N日早于今天 → 明年", () => {
    expect(p("8月1日 纪念日").due).toBe("2027-08-01");
  });

  it("12月31日输入「1月2日」→ 跨年取明年", () => {
    const r = p("1月2日 拜年", new Date(2026, 11, 31, 9, 0));
    expect(r.due).toBe("2027-01-02");
    expect(r.title).toBe("拜年");
  });

  it("N号(当月未过)", () => {
    expect(p("25号 交水电费").due).toBe("2026-08-25");
  });

  it("N号(当月已过 → 下月)", () => {
    expect(p("5号 领工资").due).toBe("2026-09-05");
  });

  it("汉字数字:三十一号 交房租", () => {
    const r = p("三十一号 交房租");
    expect(r.due).toBe("2026-08-31");
    expect(r.title).toBe("交房租");
  });

  it("汉字数字:八月二十八日", () => {
    expect(p("八月二十八日 交材料").due).toBe("2026-08-28");
  });

  it("YYYY-MM-DD", () => {
    const r = p("2026-09-10 复诊");
    expect(r.due).toBe("2026-09-10");
    expect(r.chips[0]?.kind).toBe("date");
  });

  it("MM-DD", () => {
    expect(p("9-10 体检").due).toBe("2026-09-10");
  });

  it("MM/DD", () => {
    expect(p("12/31 年终总结").due).toBe("2026-12-31");
  });

  it("MM-DD 已过 → 明年", () => {
    expect(p("3-1 续保").due).toBe("2027-03-01");
  });
});

describe("日期 · N天后/N周后", () => {
  it("3天后", () => {
    const r = p("3天后 跟进");
    expect(r.due).toBe("2026-08-24");
    expect(r.title).toBe("跟进");
  });

  it("一天后(汉字)", () => {
    expect(p("一天后 回访").due).toBe("2026-08-22");
  });

  it("两周后(汉字「两」)", () => {
    expect(p("两周后 复盘").due).toBe("2026-09-04");
  });
});

describe("日期 · 月底家族", () => {
  it("月底 = 当月最后一天", () => {
    const r = p("月底 报销");
    expect(r.due).toBe("2026-08-31");
    expect(r.title).toBe("报销");
    expect(r.chips[0]).toEqual({ kind: "date", text: "8月31日" });
  });

  it("月底:now 已是当月最后一天 → 就是今天(不跳下月)", () => {
    const r = p("月底 冲刺", new Date(2026, 7, 31, 9, 0)); // 2026-08-31 周一
    expect(r.due).toBe("2026-08-31");
    expect(r.title).toBe("冲刺");
  });

  it("十月底(汉字月份)", () => {
    const r = p("十月底 交材料");
    expect(r.due).toBe("2026-10-31");
    expect(r.title).toBe("交材料");
  });

  it("3月底 已过 → 明年", () => {
    expect(p("3月底 续约").due).toBe("2027-03-31");
  });

  it("二月底 已过 → 明年二月末(平年 28 号)", () => {
    expect(p("二月底 报表").due).toBe("2027-02-28");
  });

  it("8月底 = 本月底(未过不跳年)", () => {
    expect(p("8月底 结项").due).toBe("2026-08-31");
  });

  it("月初 已过 → 下月 1 号", () => {
    const r = p("月初 交房租");
    expect(r.due).toBe("2026-09-01");
    expect(r.title).toBe("交房租");
  });

  it("月初:now 恰是 1 号 → 当天", () => {
    expect(p("月初 交房租", new Date(2026, 8, 1, 8, 0)).due).toBe("2026-09-01");
  });

  it("月中 已过 → 下月 15 号", () => {
    expect(p("月中 发工资").due).toBe("2026-09-15");
  });

  it("月中:15 号未过 → 当月 15 号", () => {
    expect(p("月中 查进度", new Date(2026, 7, 10, 8, 0)).due).toBe("2026-08-15");
  });

  it("年底 = 当年 12月31日", () => {
    const r = p("年底 年度总结");
    expect(r.due).toBe("2026-12-31");
    expect(r.title).toBe("年度总结");
  });
});

describe("日期 · 之前后缀(deadline 语气词,日期不变)", () => {
  it("十月底之前 交材料", () => {
    const r = p("十月底之前 交材料");
    expect(r.due).toBe("2026-10-31");
    expect(r.title).toBe("交材料");
  });

  it("明天之前 回复邮件", () => {
    const r = p("明天之前 回复邮件");
    expect(r.due).toBe("2026-08-22");
    expect(r.title).toBe("回复邮件");
  });

  it("月底前 报销", () => {
    const r = p("月底前 报销");
    expect(r.due).toBe("2026-08-31");
    expect(r.title).toBe("报销");
  });

  it("周五以前 提交周报", () => {
    const r = p("周五以前 提交周报");
    expect(r.due).toBe("2026-08-21");
    expect(r.title).toBe("提交周报");
  });

  it("9月1号之前 缴学费", () => {
    const r = p("9月1号之前 缴学费");
    expect(r.due).toBe("2026-09-01");
    expect(r.title).toBe("缴学费");
  });

  it("后缀不相邻(隔空白)不吞:「明天 之前的会议纪要」", () => {
    const r = p("明天 之前的会议纪要");
    expect(r.due).toBe("2026-08-22");
    expect(r.title).toBe("之前的会议纪要");
  });
});

describe("时间", () => {
  it("HH:MM 未过 → 今天", () => {
    const r = p("14:30 面试");
    expect(r.due).toBe("2026-08-21");
    expect(r.dueTime).toBe("14:30");
    expect(r.title).toBe("面试");
  });

  it("HH:MM 已过 → 明天", () => {
    const r = p("9:30 站会");
    expect(r.due).toBe("2026-08-22");
    expect(r.dueTime).toBe("09:30");
  });

  it("独立 21:00 → 今天", () => {
    const r = p("21:00 还信用卡");
    expect(r.due).toBe("2026-08-21");
    expect(r.dueTime).toBe("21:00");
  });

  it("下午3点 = 15:00", () => {
    const r = p("下午3点 开会");
    expect(r.due).toBe("2026-08-21");
    expect(r.dueTime).toBe("15:00");
    expect(r.chips[0]).toEqual({ kind: "time", text: "15:00" });
  });

  it("晚上8点 = 20:00", () => {
    expect(p("晚上8点 看电影").dueTime).toBe("20:00");
  });

  it("上午11点 = 11:00", () => {
    const r = p("上午11点 客户会");
    expect(r.dueTime).toBe("11:00");
    expect(r.due).toBe("2026-08-21");
  });

  it("下午12点 = 12:00(不加 12)", () => {
    expect(p("下午12点 午餐").dueTime).toBe("12:00");
  });

  it("独立「中午」= 12:00", () => {
    const r = p("中午 吃饭");
    expect(r.dueTime).toBe("12:00");
    expect(r.due).toBe("2026-08-21");
    expect(r.title).toBe("吃饭");
  });

  it("裸 4点半 = 04:30,已过 → 明天", () => {
    const r = p("4点半 喝药");
    expect(r.dueTime).toBe("04:30");
    expect(r.due).toBe("2026-08-22");
  });

  it("下午4点半 = 16:30", () => {
    const r = p("下午4点半 喝下午茶");
    expect(r.dueTime).toBe("16:30");
    expect(r.due).toBe("2026-08-21");
  });

  it("8点15分 = 08:15,已过 → 明天", () => {
    const r = p("8点15分 晨跑");
    expect(r.dueTime).toBe("08:15");
    expect(r.due).toBe("2026-08-22");
  });

  it("汉字:三点十五分 = 03:15", () => {
    expect(p("三点十五分 观测").dueTime).toBe("03:15");
  });

  it("恰好等于现在的时刻视为已过 → 明天", () => {
    const r = p("十点 复盘会");
    expect(r.dueTime).toBe("10:00");
    expect(r.due).toBe("2026-08-22");
  });

  it("反例:「观点整理」不产生时间", () => {
    const r = p("观点整理");
    expect(r.title).toBe("观点整理");
    expect(r.due).toBeNull();
    expect(r.dueTime).toBeNull();
    expect(r.chips).toEqual([]);
  });
});

describe("循环", () => {
  it("每天:due 取今天", () => {
    const r = p("每天 背单词");
    expect(r.repeat).toEqual({ kind: "daily", every: 1 });
    expect(r.due).toBe("2026-08-21");
    expect(r.title).toBe("背单词");
  });

  it("每3天", () => {
    const r = p("每3天 浇花");
    expect(r.repeat).toEqual({ kind: "daily", every: 3 });
    expect(r.due).toBe("2026-08-21");
  });

  it("每两天(汉字)", () => {
    expect(p("每两天 提醒喝水").repeat).toEqual({ kind: "daily", every: 2 });
  });

  it("每周一三五:days 升序,今天周五在列 → due 今天", () => {
    const r = p("每周一三五 健身");
    expect(r.repeat).toEqual({ kind: "weekly", days: [1, 3, 5] });
    expect(r.due).toBe("2026-08-21");
    expect(r.chips[0]).toEqual({ kind: "repeat", text: "每周一、三、五" });
    expect(r.title).toBe("健身");
  });

  it("每周二:due 取下周二", () => {
    const r = p("每周二 例会");
    expect(r.repeat).toEqual({ kind: "weekly", days: [2] });
    expect(r.due).toBe("2026-08-25");
  });

  it("每周日:days=[0]", () => {
    const r = p("每周日 家庭日");
    expect(r.repeat).toEqual({ kind: "weekly", days: [0] });
    expect(r.due).toBe("2026-08-23");
  });

  it("每月28号:due 取本月 28 号", () => {
    const r = p("每月28号 对账");
    expect(r.repeat).toEqual({ kind: "monthly", day: 28 });
    expect(r.due).toBe("2026-08-28");
    expect(r.chips[0]).toEqual({ kind: "repeat", text: "每月28号" });
  });

  it("每月5号已过 → due 取下月 5 号", () => {
    const r = p("每月5号 房贷");
    expect(r.repeat).toEqual({ kind: "monthly", day: 5 });
    expect(r.due).toBe("2026-09-05");
  });

  it("每个工作日:今天周五 → due 今天", () => {
    const r = p("每个工作日 打卡");
    expect(r.repeat).toEqual({ kind: "workday" });
    expect(r.due).toBe("2026-08-21");
    expect(r.title).toBe("打卡");
  });

  it("每工作日:周六说 → due 下周一", () => {
    const r = p("每工作日 晨会", new Date(2026, 7, 22, 9, 0)); // 周六
    expect(r.repeat).toEqual({ kind: "workday" });
    expect(r.due).toBe("2026-08-24");
  });
});

describe("标签(#只管标签)", () => {
  it("#与清单同名也进 tags,不再产生 listName", () => {
    const r = p("#工作 写方案");
    expect(r.listName).toBeNull();
    expect(r.tags).toEqual(["工作"]);
    expect(r.title).toBe("写方案");
    expect(r.chips[0]).toEqual({ kind: "tag", text: "工作" });
  });

  it("#清单名前缀也只是 tag", () => {
    const r = p("#工 写方案");
    expect(r.listName).toBeNull();
    expect(r.tags).toEqual(["工"]);
  });

  it("#任意词 → 进 tags", () => {
    const r = p("#不存在的清单 试试");
    expect(r.listName).toBeNull();
    expect(r.tags).toEqual(["不存在的清单"]);
    expect(r.chips[0]).toEqual({ kind: "tag", text: "不存在的清单" });
  });

  it("多个 #:全部按出现顺序进 tags", () => {
    const r = p("#工作 #重要 #生活 整理");
    expect(r.listName).toBeNull();
    expect(r.tags).toEqual(["工作", "重要", "生活"]);
    expect(r.title).toBe("整理");
  });
});

describe("清单(/)", () => {
  it("/精确命中清单", () => {
    const r = p("/工作 写方案");
    expect(r.listName).toBe("工作");
    expect(r.tags).toEqual([]);
    expect(r.title).toBe("写方案");
    expect(r.chips[0]).toEqual({ kind: "list", text: "工作" });
  });

  it("/前缀命中清单:「/工」→ 工作", () => {
    const r = p("/工 写方案");
    expect(r.listName).toBe("工作");
    expect(r.tags).toEqual([]);
  });

  it("/未命中 → 原样返回作 listName(调用方自动新建)", () => {
    const r = p("/新清单 试试");
    expect(r.listName).toBe("新清单");
    expect(r.tags).toEqual([]);
    expect(r.title).toBe("试试");
    expect(r.chips[0]).toEqual({ kind: "list", text: "新清单" });
  });

  it("多个 /:最后一个生效,chips 保留全部", () => {
    const r = p("/生活 /工作 整理");
    expect(r.listName).toBe("工作");
    expect(r.chips.filter((c) => c.kind === "list")).toHaveLength(2);
    expect(r.title).toBe("整理");
  });

  it("「8/20」不被 / 规则误吞:仍是日期", () => {
    const r = p("8/20 交材料");
    expect(r.listName).toBeNull();
    expect(r.due).toBe("2027-08-20"); // 8月20日已过 → 明年
    expect(r.title).toBe("交材料");
    expect(r.chips[0]?.kind).toBe("date");
  });

  it("正文中间无空白的 / 不触发:「下载A/B测试报告」", () => {
    const r = p("下载A/B测试报告");
    expect(r.listName).toBeNull();
    expect(r.title).toBe("下载A/B测试报告");
    expect(r.chips).toEqual([]);
  });

  it("/清单名取到下一个 ! 符号为止:「/工作!高」", () => {
    const r = p("跟进合同 /工作!高");
    expect(r.listName).toBe("工作");
    expect(r.priority).toBe(3);
    expect(r.title).toBe("跟进合同");
  });

  it("# 与 / 并存:各管各的", () => {
    const r = p("#重要 /工作 开会");
    expect(r.listName).toBe("工作");
    expect(r.tags).toEqual(["重要"]);
    expect(r.title).toBe("开会");
  });
});

describe("@人", () => {
  it("@李哥", () => {
    const r = p("@李哥 汇报进展");
    expect(r.who).toBe("李哥");
    expect(r.title).toBe("汇报进展");
    expect(r.chips[0]).toEqual({ kind: "who", text: "李哥" });
  });

  it("多个 @:最后一个生效,chips 保留全部", () => {
    const r = p("@张三 @李四 沟通");
    expect(r.who).toBe("李四");
    expect(r.chips.filter((c) => c.kind === "who")).toHaveLength(2);
  });

  it("@ 取到下一个 ! 符号为止:@李哥!高", () => {
    const r = p("跟进合同@李哥!高");
    expect(r.who).toBe("李哥");
    expect(r.priority).toBe(3);
    expect(r.title).toBe("跟进合同");
  });
});

describe("优先级", () => {
  it("!高 = 3", () => {
    const r = p("修水管 !高");
    expect(r.priority).toBe(3);
    expect(r.title).toBe("修水管");
    expect(r.chips[0]).toEqual({ kind: "priority", text: "高" });
  });

  it("!中 = 2", () => {
    expect(p("整理照片 !中").priority).toBe(2);
  });

  it("全角:！低 = 1", () => {
    const r = p("擦窗 ！低");
    expect(r.priority).toBe(1);
    expect(r.title).toBe("擦窗");
  });

  it("!!! = 3", () => {
    const r = p("!!! 修复线上bug");
    expect(r.priority).toBe(3);
    expect(r.title).toBe("修复线上bug");
  });

  it("!! = 2", () => {
    expect(p("优化启动速度 !!").priority).toBe(2);
  });

  it("句尾单个 ! = 1", () => {
    const r = p("买菜!");
    expect(r.priority).toBe(1);
    expect(r.title).toBe("买菜");
  });

  it("全角句尾:报税！ = 1", () => {
    const r = p("报税！");
    expect(r.priority).toBe(1);
    expect(r.title).toBe("报税");
  });

  it("全角:！！ = 2", () => {
    const r = p("！！ 优化启动");
    expect(r.priority).toBe(2);
    expect(r.title).toBe("优化启动");
  });

  it("全角:！！！ = 3", () => {
    expect(p("！！！ 处理线上事故").priority).toBe(3);
  });

  it("混合:!！ = 2", () => {
    const r = p("催审批 !！");
    expect(r.priority).toBe(2);
    expect(r.title).toBe("催审批");
  });

  it("超过 3 个一律 3:！！！！", () => {
    expect(p("！！！！ 加急").priority).toBe(3);
  });

  it("反例:「!棒」不吞正文", () => {
    const r = p("!棒 点子");
    expect(r.priority).toBe(0);
    expect(r.title).toBe("!棒 点子");
    expect(r.chips).toEqual([]);
  });
});

describe("组合与标题清理", () => {
  it("周五下午3点 提交周报 /工作 @李哥 !高", () => {
    const r = p("周五下午3点 提交周报 /工作 @李哥 !高");
    expect(r.due).toBe("2026-08-21"); // now 为周五 → 今天
    expect(r.dueTime).toBe("15:00");
    expect(r.listName).toBe("工作");
    expect(r.who).toBe("李哥");
    expect(r.priority).toBe(3);
    expect(r.repeat).toBeNull();
    expect(r.title).toBe("提交周报");
    expect(r.chips.map((c) => c.kind)).toEqual(["date", "time", "list", "who", "priority"]);
  });

  it("同样组合改用 #:进 tags,listName 为空", () => {
    const r = p("周五下午3点 提交周报 #工作 @李哥 !高");
    expect(r.listName).toBeNull();
    expect(r.tags).toEqual(["工作"]);
    expect(r.chips.map((c) => c.kind)).toEqual(["date", "time", "tag", "who", "priority"]);
  });

  it("每月28号 还信用卡 21:00", () => {
    const r = p("每月28号 还信用卡 21:00");
    expect(r.repeat).toEqual({ kind: "monthly", day: 28 });
    expect(r.due).toBe("2026-08-28");
    expect(r.dueTime).toBe("21:00");
    expect(r.title).toBe("还信用卡");
  });

  it("明天上午11点@王姐 对账 /生活", () => {
    const r = p("明天上午11点@王姐 对账 /生活");
    expect(r.due).toBe("2026-08-22");
    expect(r.dueTime).toBe("11:00");
    expect(r.who).toBe("王姐");
    expect(r.listName).toBe("生活");
    expect(r.title).toBe("对账");
  });

  it("chips 按出现顺序排列", () => {
    const r = p("@李哥 明天 !高 开会");
    expect(r.chips.map((c) => c.kind)).toEqual(["who", "date", "priority"]);
    expect(r.title).toBe("开会");
  });

  it("纯 token 输入 → 标题为空", () => {
    expect(p("明天").title).toBe("");
  });

  it("标题多余空白收拢", () => {
    expect(p("  明天   开会   别迟到  ").title).toBe("开会 别迟到");
  });

  it("空输入", () => {
    const r = p("");
    expect(r.title).toBe("");
    expect(r.due).toBeNull();
    expect(r.dueTime).toBeNull();
    expect(r.repeat).toBeNull();
    expect(r.listName).toBeNull();
    expect(r.tags).toEqual([]);
    expect(r.who).toBeNull();
    expect(r.priority).toBe(0);
    expect(r.chips).toEqual([]);
  });
});

describe("指令词「提醒我」清理", () => {
  it("时间后缀的「提醒我」不留在标题里", () => {
    const r = p("给妈妈订火车票 20点提醒我");
    expect(r.title).toBe("给妈妈订火车票");
    expect(r.dueTime).toBe("20:00");
  });

  it("句首「提醒我」+时间", () => {
    const r = p("8点提醒我买菜");
    expect(r.title).toBe("买菜");
    expect(r.dueTime).toBe("08:00");
  });

  it("日期后独立的「提醒」也清理", () => {
    const r = p("明天 交材料 提醒");
    expect(r.title).toBe("交材料");
  });

  it("没识别出时间/日期时不动「提醒」二字", () => {
    const r = p("整理提醒事项清单");
    expect(r.title).toBe("整理提醒事项清单");
  });

  it("内容词「提醒事项」不受影响", () => {
    const r = p("明天 写提醒事项模板");
    expect(r.title).toBe("写提醒事项模板");
  });
});

describe("v1.1 复审修复：边界不吞正文", () => {
  it("「前端」不被单字「前」后缀吞首字", () => {
    const r = p("明天前端联调");
    expect(r.due).toBe("2026-08-22");
    expect(r.title).toBe("前端联调");
  });

  it("日期后紧跟「前」且成词尾时仍然吞掉", () => {
    const r = p("明天前 交接文档");
    expect(r.due).toBe("2026-08-22");
    expect(r.title).toBe("交接文档");
  });

  it("#标签止步于 /：「#紧要/工作」标签只取紧要（/清单需空格隔开，保护 8/20 与 URL）", () => {
    const r = p("开会 #紧要/工作");
    expect(r.tags).toEqual(["紧要"]);
    expect(r.listName).toBeNull();
    const r2 = p("开会 #紧要 /工作");
    expect(r2.tags).toEqual(["紧要"]);
    expect(r2.listName).toBe("工作");
  });

  it("正文里的比分不被吞成日期：「比分3-2 复盘」", () => {
    const r = p("比分3-2 复盘");
    expect(r.due).toBeNull();
    expect(r.title).toBe("比分3-2 复盘");
  });

  it("正文里的分数不被吞成日期：「完成了3/4 汇报」", () => {
    const r = p("完成了3/4 汇报");
    expect(r.due).toBeNull();
    expect(r.title).toBe("完成了3/4 汇报");
  });

  it("行首 MM/DD 仍然生效", () => {
    expect(p("12/31 年终总结").due).toBe("2026-12-31");
  });
});
