import { describe, expect, it } from "vitest";
import { parseQuickAdd, parseSubtaskInput } from "../src/core/parse";

const NOW = new Date(2026, 9, 28, 11, 0);
const parse = (input: string, now = NOW) => parseQuickAdd(input, { now, listNames: [] });

describe("数字年份的年底", () => {
  it.each([
    ["28年底", "2028-12-31"],
    ["32年底", "2032-12-31"],
    ["2028年底", "2028-12-31"],
    ["2032年年底", "2032-12-31"],
    ["28年末", "2028-12-31"],
    ["00年底", "2000-12-31"],
    ["99年底", "2099-12-31"],
    ["今年底", "2026-12-31"],
    ["明年年末", "2027-12-31"],
    ["后年年底", "2028-12-31"],
  ])("~%s完整识别为%s", (phrase, due) => {
    const r = parse(`~${phrase} 交计划`);
    expect(r.due).toBe(due);
    expect(r.title).toBe("交计划");
    expect(r.chips).toHaveLength(1);
    expect(r.chips[0].kind).toBe("date");
  });

  it("明确年份允许过去日期，两位年始终指20xx", () => {
    expect(parse("~25年底 补记录").due).toBe("2025-12-31");
    expect(parse("~28年底 计划", new Date(2099, 0, 1)).due).toBe("2028-12-31");
    expect(parse("~32年底 计划").chips).toEqual([{ kind: "date", text: "2032年12月31日" }]);
  });
});

describe("自然季度的结束日期", () => {
  it.each([
    ["明年第一季度末", "2027-03-31"],
    ["明年第二季度末", "2027-06-30"],
    ["明年第三季度底", "2027-09-30"],
    ["明年第四季度末", "2027-12-31"],
    ["后年1季度末", "2028-03-31"],
    ["今年第1季度末", "2026-03-31"],
    ["2028年第一季度末", "2028-03-31"],
    ["32年第二季度末", "2032-06-30"],
    ["第一季度末", "2027-03-31"],
    ["第四季度末", "2026-12-31"],
    ["本季度末", "2026-12-31"],
    ["这个季度末", "2026-12-31"],
    ["季度末", "2026-12-31"],
    ["下季度末", "2027-03-31"],
    ["下个季度末", "2027-03-31"],
  ])("~%s完整识别为%s", (phrase, due) => {
    const r = parse(`~${phrase} 交计划`);
    expect(r.due).toBe(due);
    expect(r.title).toBe("交计划");
    expect(r.chips).toHaveLength(1);
  });

  it("今天恰好季末不跳年，过一天才找下次；下季跨年正常", () => {
    expect(parse("~第一季度末 复盘", new Date(2026, 2, 31)).due).toBe("2026-03-31");
    expect(parse("~第一季度末 复盘", new Date(2026, 3, 1)).due).toBe("2027-03-31");
    expect(parse("~本季度末 复盘", new Date(2026, 3, 1)).due).toBe("2026-06-30");
    expect(parse("~下季度末 复盘", new Date(2026, 11, 31)).due).toBe("2027-03-31");
    expect(parse("~明年第一季度末 复盘", new Date(2026, 11, 31)).due).toBe("2027-03-31");
    expect(parse("~明年第一季度末 复盘", new Date(2027, 0, 1)).due).toBe("2028-03-31");
  });
});

describe("新期限语法遵循所有输入的现有规则", () => {
  it.each(["128年底", "20285年底", "2年底", "0000年底", "明年第0季度末", "明年第五季度末", "明年第十一季度末", "28年第12季度末"])("非法期限%s整句保留", (phrase) => {
    const input = `~${phrase} 计划`;
    expect(parse(input)).toMatchObject({ due: null, title: input, chips: [] });
  });

  it("没有~则不排期，全角~、期限语气词和符号相邻都支持", () => {
    const input = "28年底 明年第一季度末 交计划";
    expect(parse(input)).toMatchObject({ due: null, title: input, chips: [] });
    expect(parse("～ 明年第一季度末之前 交计划")).toMatchObject({ due: "2027-03-31", title: "交计划" });
    expect(parse("交计划~32年底前")).toMatchObject({ due: "2032-12-31", title: "交计划" });
    expect(parse("~明年第一季度末前端评审")).toMatchObject({ due: "2027-03-31", title: "前端评审" });
  });

  it.each([["\"", "\""], ["“", "”"], ["＂", "＂"]])("%s%s里的期限保留正文", (open, close) => {
    const input = `${open}~28年底${close} ${open}~明年第一季度末${close} 计划`;
    expect(parse(input)).toMatchObject({ due: null, title: input, chips: [] });
  });

  it("母子任务共用，可接钟点，后写的日期生效", () => {
    const input = "~明年第一季度末下午3点 交计划";
    const r = parse(input);
    expect(r).toMatchObject({ due: "2027-03-31", dueTime: "15:00", title: "交计划" });
    expect(parseSubtaskInput(input, NOW)).toEqual(r);
    expect(parseSubtaskInput("~28年底 交计划", NOW).due).toBe("2028-12-31");
    expect(parse("~32年底 ~明天 计划").due).toBe("2026-10-29");
    expect(parse("~明天 ~32年底 计划").due).toBe("2032-12-31");
    expect(parse("~28年底 ~明年第一季度末 计划").due).toBe("2027-03-31");
  });

  it("网址、文件路径和范围号不会误排期", () => {
    for (const input of ["https://example.test/~28年底", "D:/plans/~明年第一季度末", "计划25~28年底", "计划2027年~明年第一季度末"]) {
      expect(parse(input)).toMatchObject({ due: null, title: input, chips: [] });
    }
  });
});
