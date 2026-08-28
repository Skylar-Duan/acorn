// 「整句改」的底稿：一件事 → 一句便捷语（2026-08-28 需求单第 11 条）。
//
// 这里最要紧的一条不是「生成得好不好看」，而是**读回来必须是同一件事**。
// 生成的句子会直接摆进输入框当底稿，用户一回车就照它改整条任务——
// 只要有一处读错，用户什么都没动就把自己的事改坏了。所以只要对不上就必须 safe=false。
import { describe, expect, it } from "vitest";
import { newTask } from "../src/core/model";
import type { RepeatRule, Task } from "../src/core/model";
import { parseQuickAdd } from "../src/core/parse";
import { repeatToSyntax, taskToSentence } from "../src/core/syntax";

const NOW = new Date("2026-08-28T10:00:00");
const LISTS = ["工作", "生活", "投顾"];

function say(task: Task, listName: string | null = null) {
  return taskToSentence(task, { listName, listNames: LISTS, now: NOW });
}

describe("生成的句子长什么样", () => {
  it("光秃秃一条只剩标题", () => {
    expect(say(newTask({ title: "买牛奶" })).text).toBe("买牛奶");
  });

  it("要素按 日期 时间 循环 重要性 清单 需求方 标签 标题 的顺序摆", () => {
    const t = newTask({
      title: "写周报",
      due: "2026-08-31",
      dueTime: "15:00",
      repeat: { kind: "weekly", days: [1] },
      priority: 3,
      who: ["李哥", "王姐"],
      tags: ["周报"],
    });
    expect(say(t, "工作").text).toBe("2026-08-31 15:00 每周一 !高 /工作 @李哥 @王姐 #周报 写周报");
  });

  it("日期写成带年份的 2026-08-31，不写「8月31日」", () => {
    // 「8月31日」这种写法遇到已经过去的日子会被理解成明年——
    // 倒着生成时任务本来就可能逾期，那样一改就把逾期任务悄悄推到明年了
    const overdue = newTask({ title: "补交材料", due: "2026-08-20" });
    const s = say(overdue);
    expect(s.text).toBe("2026-08-20 补交材料");
    expect(s.safe).toBe(true);
    expect(parseQuickAdd(s.text, { now: NOW, listNames: LISTS }).due).toBe("2026-08-20");
  });

  it("没日期就不写钟点——「有时间没日期」是个悬空状态，写出来读回去会变成今天", () => {
    const t = newTask({ title: "打电话", due: null, dueTime: "09:00" });
    expect(say(t).text).toBe("打电话");
  });
});

describe("循环怎么写", () => {
  it("每周多天连着写，不能用顿号（顿号解析器不认）", () => {
    expect(repeatToSyntax({ kind: "weekly", days: [1, 3, 5] })).toBe("每周一三五");
  });

  it("每天 / 每N天 / 每月N号 / 每个工作日", () => {
    expect(repeatToSyntax({ kind: "daily", every: 1 })).toBe("每天");
    expect(repeatToSyntax({ kind: "daily", every: 3 })).toBe("每3天");
    expect(repeatToSyntax({ kind: "monthly", day: 15 })).toBe("每月15号");
    expect(repeatToSyntax({ kind: "workday" })).toBe("每个工作日");
  });

  it("四种循环都能原样读回来", () => {
    const rules: RepeatRule[] = [
      { kind: "daily", every: 1 },
      { kind: "daily", every: 3 },
      { kind: "weekly", days: [1, 3, 5] },
      { kind: "monthly", day: 15 },
      { kind: "workday" },
    ];
    for (const repeat of rules) {
      const t = newTask({ title: "例行", due: "2026-09-07", repeat });
      const s = say(t);
      expect(s.safe, `${JSON.stringify(repeat)} 读不回来：${s.text}`).toBe(true);
      expect(parseQuickAdd(s.text, { now: NOW, listNames: LISTS }).repeat).toEqual(repeat);
    }
  });
});

describe("读不回来的一律 safe=false（这是这个模块存在的理由）", () => {
  it("标题里正好有个日期词 → 不 safe", () => {
    const t = newTask({ title: "明天要用的材料" });
    expect(say(t).safe).toBe(false);
  });

  it("标题里带 # 或 @ → 不 safe", () => {
    expect(say(newTask({ title: "改 #tag 的样式" })).safe).toBe(false);
    expect(say(newTask({ title: "回复 @所有人" })).safe).toBe(false);
  });

  it("清单名里有空格 → 不 safe（写进去读回来就断了）", () => {
    const t = newTask({ title: "整理", listId: "x" });
    expect(say(t, "工作 A组").safe).toBe(false);
  });

  it("需求方名字里带斜杠 → 不 safe", () => {
    const t = newTask({ title: "对账", who: ["财务/出纳"] });
    expect(say(t).safe).toBe(false);
  });

  it("普通的一条 → safe，且读回来每个字段都对得上", () => {
    const t = newTask({
      title: "写季度总结",
      due: "2026-09-30",
      dueTime: "14:30",
      priority: 2,
      who: ["李哥"],
      tags: ["总结"],
    });
    const s = say(t, "工作");
    expect(s.safe).toBe(true);
    const back = parseQuickAdd(s.text, { now: NOW, listNames: LISTS });
    expect(back.title).toBe("写季度总结");
    expect(back.due).toBe("2026-09-30");
    expect(back.dueTime).toBe("14:30");
    expect(back.priority).toBe(2);
    expect(back.who).toEqual(["李哥"]);
    expect(back.tags).toEqual(["总结"]);
    expect(back.listName).toBe("工作");
  });

  it("三档重要性都读得回来", () => {
    for (const [priority, word] of [[1, "!低"], [2, "!中"], [3, "!高"]] as const) {
      const s = say(newTask({ title: "报税", priority }));
      expect(s.text).toBe(`${word} 报税`);
      expect(s.safe).toBe(true);
    }
  });

  it("重要性为「无」时句子里不留痕迹——删掉 !X 就是降回无", () => {
    expect(say(newTask({ title: "报税", priority: 0 })).text).toBe("报税");
  });
});
