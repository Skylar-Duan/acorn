// 循环任务的下次日期引擎：纯函数，不读系统时钟。
// 所有日期参数与返回值都是 'YYYY-MM-DD'（本地语义，见 dates.ts）。

import type { RepeatRule } from "./model";
import { addDays, cmpYMD, dayOfWeek, daysInMonth, isWorkday, pad2 } from "./dates";

/** 判断 ymd 是否本身就是 rule 的一个落点（daily 锚点随完成日浮动，任意日期都算） */
function matches(rule: RepeatRule, ymd: string): boolean {
  switch (rule.kind) {
    case "daily":
      return true;
    case "weekly":
      return rule.days.includes(dayOfWeek(ymd));
    case "monthly": {
      const y = Number(ymd.slice(0, 4));
      const m = Number(ymd.slice(5, 7));
      // clamp 后的月末落点（如 2 月的 28/29 号）也算 31 号规则的落点
      return Number(ymd.slice(8, 10)) === Math.min(rule.day, daysInMonth(y, m));
    }
    case "workday":
      return isWorkday(ymd);
  }
}

/** 严格大于 after 的下一个落点 */
export function nextOccurrence(rule: RepeatRule, after: string): string {
  switch (rule.kind) {
    case "daily":
      // 以完成时的 due 为锚：直接顺推 N 天
      return addDays(after, Math.max(1, rule.every));
    case "weekly": {
      if (rule.days.length === 0) throw new Error("weekly 规则的 days 不能为空");
      for (let i = 1; i <= 7; i++) {
        const cand = addDays(after, i);
        if (rule.days.includes(dayOfWeek(cand))) return cand;
      }
      throw new Error("weekly 规则的 days 含非法值"); // days ⊆ 0..6 时不可达
    }
    case "monthly": {
      let y = Number(after.slice(0, 4));
      let m = Number(after.slice(5, 7));
      // clamp 只对当前候选月生效：2 月落到 28/29 后，3 月仍回到原始 day
      for (;;) {
        const d = Math.min(Math.max(1, rule.day), daysInMonth(y, m));
        const cand = `${y}-${pad2(m)}-${pad2(d)}`;
        if (cmpYMD(cand, after) > 0) return cand;
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
    }
    case "workday": {
      let cand = addDays(after, 1);
      while (!isWorkday(cand)) cand = addDays(cand, 1);
      return cand;
    }
  }
}

/** 大于等于 from 的第一个落点 */
export function firstOccurrence(rule: RepeatRule, from: string): string {
  return matches(rule, from) ? from : nextOccurrence(rule, from);
}

const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** 规则的中文描述，用于 UI 展示 */
export function describeRepeat(rule: RepeatRule): string {
  switch (rule.kind) {
    case "daily":
      return rule.every <= 1 ? "每天" : `每${rule.every}天`;
    case "weekly":
      return `每周${rule.days.map((d) => WEEK_CN[d]).join("、")}`;
    case "monthly":
      return `每月${rule.day}号`;
    case "workday":
      return "每个工作日";
  }
}
