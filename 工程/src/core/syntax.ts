// 把一件事**倒着**写回一句便捷语（纯函数，可单测）。
//
// 为什么要有它：用户想改一件事的时候，不该先想「这个字段的按钮在哪」，
// 而是看见一句「2026-08-31 15:00 !高 /工作 @李哥 #周报 写周报」，改哪儿点哪儿。
// 用户口径（2026-08-28）：**自动生成**这句话，**不存**当初输入时打的那句——
// 存了就得跟着字段改动同步维护，迟早对不上；现算永远是对的。
//
// 日期一律写成 2026-08-31 这种带年份的写法，不写「8月31日」：
// 「8月31日」在解析器里遇到已经过去的日子会被理解成明年（本来就该这样，
// 记事的时候没人会记去年的事），但倒着生成时任务本来就可能逾期，
// 那样一来「改一句话」会把逾期任务悄悄推到明年——不能有这种事。

import type { Priority, RepeatRule, Task } from "./model";
import { parseQuickAdd } from "./parse";

const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

const PRIO_TOKEN: Record<Priority, string> = { 0: "", 1: "!低", 2: "!中", 3: "!高" };

/** 名字里带这些字符就写不进一句话（会被当成下一个标记的开头） */
const UNSAFE_NAME = /[\s#@/!！]/;

/** 循环规则写成解析器认得的样子。注意每周是「每周一三五」不是「每周一、三、五」——
 *  顿号不在解析器的字符类里，写了就读不回来 */
export function repeatToSyntax(r: RepeatRule): string | null {
  switch (r.kind) {
    case "daily":
      return r.every <= 1 ? "每天" : `每${r.every}天`;
    case "weekly":
      return r.days.length ? `每周${[...r.days].sort((a, b) => a - b).map((d) => WEEK_CN[d]).join("")}` : null;
    case "monthly":
      return `每月${r.day}号`;
    case "workday":
      return "每个工作日";
  }
}

export interface TaskSentence {
  /** 生成的那句话 */
  text: string;
  /** 这句话原样读回来能不能还原成同一件事。false = 别拿它当「整句改」用（见下面为什么） */
  safe: boolean;
}

export interface SentenceCtx {
  /** 这件事所属清单的名字；无清单传 null */
  listName: string | null;
  /** 现有清单名（校验时用来还原 listName 的匹配口径） */
  listNames: string[];
  now?: Date;
}

/** 一件事 → 一句便捷语。
 *
 *  safe=false 的意思是「这件事没法用一句话无损表达」——比如标题里正好写着
 *  「明天」「#」这类会被解析器吃掉的字，或者清单名里有空格。这时候界面**不能**
 *  拿这句话当「整句改」的底稿，否则用户什么都没动、一回车就把自己的事改坏了。 */
export function taskToSentence(task: Task, ctx: SentenceCtx): TaskSentence {
  const parts: string[] = [];
  const omitted = new Set<string>();

  if (task.due) parts.push(task.due);
  if (task.due && task.dueTime) parts.push(task.dueTime);
  if (task.repeat) {
    const rep = repeatToSyntax(task.repeat);
    if (rep) parts.push(rep);
    else omitted.add("repeat");
  }
  if (task.priority) parts.push(PRIO_TOKEN[task.priority]);
  if (ctx.listName) {
    if (UNSAFE_NAME.test(ctx.listName)) omitted.add("list");
    else parts.push(`/${ctx.listName}`);
  }
  for (const w of task.who) {
    if (UNSAFE_NAME.test(w)) omitted.add("who");
    else parts.push(`@${w}`);
  }
  for (const t of task.tags) {
    if (UNSAFE_NAME.test(t)) omitted.add("tag");
    else parts.push(`#${t}`);
  }
  parts.push(task.title.trim());

  const text = parts.filter(Boolean).join(" ").trim();
  if (omitted.size) return { text, safe: false };

  // 读回来对一遍。对不上就是不 safe——宁可退回原来的「打一段改一处」，
  // 也不能让一句读错的话当底稿
  const back = parseQuickAdd(text, { now: ctx.now ?? new Date(), listNames: ctx.listNames });
  const same =
    back.title === task.title.trim() &&
    back.due === (task.due ?? null) &&
    back.dueTime === (task.due ? task.dueTime ?? null : null) &&
    back.priority === task.priority &&
    JSON.stringify(back.repeat) === JSON.stringify(task.repeat ?? null) &&
    (back.listName ?? null) === (ctx.listName ?? null) &&
    JSON.stringify(back.who) === JSON.stringify(task.who) &&
    JSON.stringify(back.tags) === JSON.stringify(task.tags);

  return { text, safe: same };
}
