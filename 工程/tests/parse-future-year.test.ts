import { describe, expect, it } from "vitest";
import { holidayDate } from "../src/core/holidays";
import { parseQuickAdd, parseSubtaskInput } from "../src/core/parse";

const NOW = new Date(2026, 9, 21, 10, 0);
const parse = (input: string, now = NOW) => parseQuickAdd(input, { now, listNames: [] });

describe("后年沿用明年的指定年份语法", () => {
  it.each([
    ["后年三月", "2028-03-01"],
    ["后年3月", "2028-03-01"],
    ["后年三月份", "2028-03-01"],
    ["后年十二月", "2028-12-01"],
    ["后年3月5日", "2028-03-05"],
    ["后年三月五号", "2028-03-05"],
    ["后年十二月三十一日", "2028-12-31"],
    ["后年两月二十九号", "2028-02-29"],
    ["后年二月底", "2028-02-29"],
    ["后年底", "2028-12-31"],
    ["后年年底", "2028-12-31"],
  ])("~%s按字面排到%s", (phrase, due) => {
    const r = parse(`~${phrase} 交计划`);
    expect(r.due).toBe(due);
    expect(r.title).toBe("交计划");
    expect(r.chips).toHaveLength(1);
    expect(r.chips[0].kind).toBe("date");
  });

  it("缺省日与明年一致取1号，芯片带年份", () => {
    expect(parse("~后年三月 交计划").chips).toEqual([{ kind: "date", text: "2028年3月1日" }]);
    expect(parse("~明年三月 交计划").due).toBe("2027-03-01");
  });

  it("目标年份始终为当前年加二，不受月日已过或跨年影响", () => {
    expect(parse("~后年一月 行程", new Date(2026, 11, 31, 23, 59)).due).toBe("2028-01-01");
    expect(parse("~后年一月 行程", new Date(2027, 0, 1, 0, 0)).due).toBe("2029-01-01");
    expect(parse("~后年二月底 报表", new Date(2027, 0, 1)).due).toBe("2029-02-28");
    expect(parse("~后年二月底 报表", new Date(2098, 0, 1)).due).toBe("2100-02-28");
  });

  it.each([
    "后年0月", "后年13月", "后年十三月", "后年一二月", "后年3月0日",
    "后年四月三十一日", "后年三月三十二号", "后年三月一二日", "后年二月300日", "后年二月29",
  ])("非法日期%s完整保留，不拆出月份", (phrase) => {
    const input = `~${phrase} 计划`;
    const r = parse(input);
    expect(r.due).toBeNull();
    expect(r.title).toBe(input);
    expect(r.chips).toEqual([]);
  });

  it("平年的二月二十九日不顺延到下一年或月底", () => {
    const input = "~后年二月二十九日 纪念日";
    const r = parse(input, new Date(2027, 0, 1));
    expect(r.due).toBeNull();
    expect(r.title).toBe(input);
  });

  it("沿用~闸门、全角符号、期限语气词与后者覆盖规则", () => {
    expect(parse("后年三月 交计划").due).toBeNull();
    expect(parse("后年三月 交计划").title).toBe("后年三月 交计划");
    expect(parse("～ 后年底前 交计划").title).toBe("交计划");
    expect(parse("～ 后年底前 交计划").due).toBe("2028-12-31");
    expect(parse("~明天 ~后年三月 交计划").due).toBe("2028-03-01");
    expect(parse("~后年三月 ~明天 交计划").due).toBe("2026-10-22");
  });

  it("同一个~下可以继续写钟点，子任务共用同一套日期识别", () => {
    const r = parseSubtaskInput("~后年三月五号下午3点 交计划", NOW);
    expect(r.due).toBe("2028-03-05");
    expect(r.dueTime).toBe("15:00");
    expect(r.title).toBe("交计划");
  });

  it.each([['"', '"'], ['“', '”'], ['＂', '＂']])("%s%s保护后年的日期正文", (open, close) => {
    const input = `${open}~后年三月${close} ${open}~后年底${close} 计划`;
    const r = parse(input);
    expect(r.due).toBeNull();
    expect(r.title).toBe(input);
    expect(parse(`${input} ~明天`).due).toBe("2026-10-22");
  });

  it("后年节日与明年一致，农历只认已有表内年份", () => {
    expect(parse("~后年元旦 休息").due).toBe("2028-01-01");
    expect(parse("~后年春节前 买票").due).toBe("2028-01-26");
    expect(parse("~后年春节前 买票").title).toBe("买票");
    const input = "~后年春节 回家";
    expect(parse(input, new Date(2029, 0, 1)).due).toBeNull();
    expect(parse(input, new Date(2029, 0, 1)).title).toBe(input);
    expect(holidayDate("元旦", "2029-01-01", "后年")).toBe("2031-01-01");
    expect(holidayDate("春节", "2029-01-01", "后年")).toBeNull();
  });
});
