// 时间严格模式（v1.15.0）：跟时间有关的一律要打 ~ 才算数。
//
// 用户 2026-09-14 拍板的原话：「严格：不加 ~ 就不认——打『~周五下午3点 提交周报』才设日期；
// 『下周去体检』这种不加符号的一律只当标题。误认从此归零，代价是以后每次写日期都要多打一个 ~。
// 跟另外三个符号的规矩完全一致。」
//
// 这个文件专测那道闸门本身（词汇表怎么认在 parse.test.ts / parse-phrases.test.ts）：
// 带 ~ 认、不带不认、全角 ～ 一样认、~ 后面接不上东西就当普通字符、一个 ~ 管一整串、
// 空格断开要再打一个 ~、~ 不跟别的符号串味。
import { describe, expect, it } from "vitest";
import { parseQuickAdd, parseSubtaskInput } from "../src/core/parse";
import type { ParseResult } from "../src/core/parse";
import guideSource from "../src/components/GuideContent.tsx?raw";
import quickAddBarSource from "../src/components/QuickAddBar.tsx?raw";
import quickAddWinSource from "../src/windows/quickadd.tsx?raw";
import quickAddSheetSource from "../src/mobile/QuickAddSheet.tsx?raw";
import taskCardSource from "../src/components/TaskCard.tsx?raw";
import settingsSource from "../src/views/Settings.tsx?raw";
import taskSheetSource from "../src/mobile/TaskSheet.tsx?raw";
import syntaxInputSource from "../src/components/SyntaxInput.tsx?raw";
import mergeSource from "../src/mobile/quickAddMerge.ts?raw";

const LISTS = ["工作", "生活"];
const FRI = new Date(2026, 7, 21, 10, 0); // 2026-08-21 周五 10:00

const p = (input: string, now: Date = FRI): ParseResult =>
  parseQuickAdd(input, { now, listNames: LISTS });

describe("带 ~ 才认：日期 / 钟点 / 循环三类一视同仁", () => {
  it("日期：~明天 认，明天 不认", () => {
    const yes = p("~明天 交周报");
    expect(yes.due).toBe("2026-08-22");
    expect(yes.title).toBe("交周报");
    expect(yes.chips.map((c) => c.kind)).toEqual(["date"]);

    const no = p("明天 交周报");
    expect(no.due).toBeNull();
    expect(no.title).toBe("明天 交周报"); // 一个字不动，整句都是标题
    expect(no.chips).toEqual([]);
  });

  it("钟点：~下午3点 认，下午3点 不认", () => {
    expect(p("~下午3点 面谈").dueTime).toBe("15:00");
    expect(p("~下午3点 面谈").title).toBe("面谈");
    expect(p("下午3点 面谈").dueTime).toBeNull();
    expect(p("下午3点 面谈").title).toBe("下午3点 面谈");
    // 光秃秃的时段词同理
    expect(p("~晚上 遛狗").dueTime).toBe("20:00");
    expect(p("晚上 遛狗").dueTime).toBeNull();
    expect(p("晚上 遛狗").title).toBe("晚上 遛狗");
  });

  it("循环：~每周一 认，每周一 不认", () => {
    const yes = p("~每周一 交周报");
    expect(yes.repeat).toEqual({ kind: "weekly", days: [1] });
    expect(yes.title).toBe("交周报");

    const no = p("每周一 交周报");
    expect(no.repeat).toBeNull();
    expect(no.due).toBeNull();
    expect(no.title).toBe("每周一 交周报");
  });

  it("用户那句原话：「下周去体检」现在只是一句话", () => {
    const r = p("下周去体检");
    expect(r.due).toBeNull();
    expect(r.dueTime).toBeNull();
    expect(r.repeat).toBeNull();
    expect(r.title).toBe("下周去体检");
    expect(r.chips).toEqual([]);
  });

  it("各种写法不打 ~ 一律不认（日期家族全走一遍）", () => {
    for (const s of [
      "8月31日 交学费",
      "8/31 交学费",
      "8-31 交学费",
      "2026-09-10 复诊",
      "31号 交房租",
      "月底 报销",
      "年底 总结",
      "三天后 复查",
      "下下周三 复查",
      "周末 陪爸妈吃饭",
      "春节 回家",
      "明年3月 换工作",
      "15:30 拿快递",
      "每天 背单词",
      "每个工作日 打卡",
      "每月15号 还款",
    ]) {
      const r = p(s);
      expect(r.due, s).toBeNull();
      expect(r.dueTime, s).toBeNull();
      expect(r.repeat, s).toBeNull();
      expect(r.title, s).toBe(s);
    }
  });

  it("同样这些写法，前面加个 ~ 就全都认", () => {
    for (const s of [
      "8月31日 交学费",
      "8/31 交学费",
      "8-31 交学费",
      "2026-09-10 复诊",
      "31号 交房租",
      "月底 报销",
      "三天后 复查",
      "下下周三 复查",
      "周末 陪爸妈吃饭",
      "春节 回家",
      "15:30 拿快递",
      "每天 背单词",
    ]) {
      const r = p(`~${s}`);
      expect(r.due ?? r.dueTime, s).not.toBeNull();
      expect(r.title, s).toBe(s.slice(s.indexOf(" ") + 1));
    }
  });
});

describe("半角 ~ 和全角 ～ 都认", () => {
  // 中文输入法按 shift+` 出来的是全角 ～，不认等于这个功能在中文键盘下整个是坏的
  it("全角 ～ 跟半角一模一样", () => {
    const half = p("~周五下午3点 提交周报");
    const full = p("～周五下午3点 提交周报");
    expect(full.due).toBe(half.due);
    expect(full.dueTime).toBe(half.dueTime);
    expect(full.title).toBe("提交周报");
  });

  it("两种符号混着用也各管各的", () => {
    const r = p("～明天 ~下午3点 交周报");
    expect(r.due).toBe("2026-08-22");
    expect(r.dueTime).toBe("15:00");
    expect(r.title).toBe("交周报");
  });
});

describe("~ 后面接不上时间词：当普通字符留在标题里，不报错也不吃字", () => {
  it("孤零零一个 ~", () => {
    expect(p("~ 买菜").title).toBe("~ 买菜");
    expect(p("~ 买菜").due).toBeNull();
  });

  it("~ 后面跟的不是时间词", () => {
    for (const s of ["~午饭 约小王", "报价~1000 再谈", "网址~user 备份", "~"]) {
      const r = p(s);
      expect(r.title, s).toBe(s.trim());
      expect(r.due, s).toBeNull();
      expect(r.dueTime, s).toBeNull();
    }
  });

  it("句尾的 ~ 也原样留着", () => {
    expect(p("到底行不行~").title).toBe("到底行不行~");
  });
});

describe("一个 ~ 管紧跟着它的一整串，空格断开就要再打一个", () => {
  it("~周五下午3点：一个 ~ 把日期和钟点一起领进来", () => {
    const r = p("~周五下午3点 提交周报");
    expect(r.due).toBe("2026-08-21"); // 今天就是周五
    expect(r.dueTime).toBe("15:00");
    expect(r.title).toBe("提交周报");
    expect(r.chips.map((c) => c.kind)).toEqual(["date", "time"]);
  });

  it("~明天下午 / ~今天中午 这类连写照样是一串", () => {
    expect(p("~明天下午 开会").dueTime).toBe("15:00");
    expect(p("~明天下午 开会").due).toBe("2026-08-22");
    expect(p("~明天上午11点 对账").dueTime).toBe("11:00");
    expect(p("~明晚8点 看球").dueTime).toBe("20:00");
  });

  it("中间空了格就断了：「~明天 下午3点」只认明天", () => {
    const r = p("~明天 下午3点 交周报");
    expect(r.due).toBe("2026-08-22");
    expect(r.dueTime).toBeNull();
    expect(r.title).toBe("下午3点 交周报"); // 后半截没人领，原样留在标题里
  });

  it("断开的那一段自己打个 ~ 就认了", () => {
    const r = p("~明天 ~下午3点 交周报");
    expect(r.due).toBe("2026-08-22");
    expect(r.dueTime).toBe("15:00");
    expect(r.title).toBe("交周报");
  });

  it("一句话里两处时间各带各的 ~", () => {
    const r = p("~每周一 交周报 ~21:00");
    expect(r.repeat).toEqual({ kind: "weekly", days: [1] });
    expect(r.dueTime).toBe("21:00");
    expect(r.title).toBe("交周报");
  });
});

describe("跟另外三个符号不串味", () => {
  it("@李哥~3点：人名到 ~ 为止，3点 是钟点", () => {
    const r = p("跟进合同 @李哥~3点");
    expect(r.who).toEqual(["李哥"]);
    expect(r.dueTime).toBe("03:00"); // 裸「3点」照旧是凌晨三点（闸门只管认不认，不改换算口径）
    expect(r.title).toBe("跟进合同");
  });

  it("#标签~明天 / /清单~明天 同理", () => {
    const a = p("#紧要~明天 交材料");
    expect(a.tags).toEqual(["紧要"]);
    expect(a.due).toBe("2026-08-22");
    expect(a.title).toBe("交材料");

    const b = p("/工作~明天 交材料");
    expect(b.listName).toBe("工作");
    expect(b.due).toBe("2026-08-22");
    expect(b.title).toBe("交材料");
  });

  it("!高~明天：重要性和日期各是各的", () => {
    const r = p("报税 !高~明天");
    expect(r.priority).toBe(3);
    expect(r.due).toBe("2026-08-22");
    expect(r.title).toBe("报税");
  });

  it("混写一句完整的：顺序不限", () => {
    const r = p("~周五下午3点 !高 /工作 @李哥 #周报 写 NVDA 点评");
    expect(r.due).toBe("2026-08-21");
    expect(r.dueTime).toBe("15:00");
    expect(r.priority).toBe(3);
    expect(r.listName).toBe("工作");
    expect(r.who).toEqual(["李哥"]);
    expect(r.tags).toEqual(["周报"]);
    expect(r.title).toBe("写 NVDA 点评");
  });
});

describe("严格模式最实在的好处：从前那些误认，现在一个都不会发生", () => {
  it("正文里长得像时间的字眼原样留着", () => {
    for (const s of [
      "比分3-2 复盘",
      "完成了3/4 汇报",
      "下周前端联调",
      "上午班次表 打印",
      "喝下午茶 约小王",
      "观点整理",
      "集中秋招 面试",
      "六一班 家长会",
      "整理提醒事项清单",
      "每日一记",
      "下周一晚上bill朋友来取东西",
    ]) {
      const r = p(s);
      expect(r.title, s).toBe(s);
      expect(r.due, s).toBeNull();
      expect(r.dueTime, s).toBeNull();
      expect(r.repeat, s).toBeNull();
      expect(r.chips, s).toEqual([]);
    }
  });
});

describe("中文里当范围号用的 ~／～ 不是时间标记", () => {
  // 「3～5天内」「1~2个月后」这类是标准写法。闸门只放行站在词头的 ~
  // （句首 / 空白之后 / 已被别的要素占掉的字符之后），范围号左边贴着的是数字，不算词头。
  // 漏掉这条的后果正是这一版要消灭的那件事：悄悄排了期，标题还被啃掉半截
  it("范围号写法一个字都不动，也不设日期", () => {
    for (const s of [
      "预计 3～5天内 出结果",
      "报销 1~2个月后 到账",
      "工期 2~3周后 完工",
      "备货 5~10号",
      "档期 8/20~8/25",
      "面试 14:00～15:00 二轮",
      "周一~周五 值班",
      "会期 3~5号",
    ]) {
      const r = p(s);
      expect(r.title, s).toBe(s);
      expect(r.due, s).toBeNull();
      expect(r.dueTime, s).toBeNull();
      expect(r.repeat, s).toBeNull();
      expect(r.chips, s).toEqual([]);
    }
  });

  it("同一句话里，词头那个 ~ 照样算数", () => {
    // 范围号被挡住，不连累后面正经打的那个 ~
    const r = p("预计 3～5天内 出结果 ~下周三");
    expect(r.due).toBe("2026-08-26");
    expect(r.title).toBe("预计 3～5天内 出结果");
  });

  it("裸感叹号串后面紧跟的 ~ 不受连累（!!~明天）", () => {
    // 裸感叹号排在日期之后扫，闸门看过去时它还没占上字，所以 [!！] 单独放行
    const r = p("报税 !!~明天");
    expect(r.priority).toBe(2);
    expect(r.due).toBe("2026-08-22");
    expect(r.title).toBe("报税");

    const one = p("交材料 !~周五");
    expect(one.priority).toBe(1);
    expect(one.due).toBe("2026-08-21");
    expect(one.title).toBe("交材料");
  });
});

describe("子任务那条输入框走的是同一道闸门", () => {
  it("子任务里也要打 ~", () => {
    const yes = parseSubtaskInput("~明天 ~15点 !高 画趋势图", FRI);
    expect(yes.due).toBe("2026-08-22");
    expect(yes.dueTime).toBe("15:00");
    expect(yes.priority).toBe(3);
    expect(yes.title).toBe("画趋势图");

    const no = parseSubtaskInput("明天 15点 !高 画趋势图", FRI);
    expect(no.due).toBeNull();
    expect(no.dueTime).toBeNull();
    expect(no.priority).toBe(3); // 重要性不归时间管，照旧认
    expect(no.title).toBe("明天 15点 画趋势图");
  });
});

describe("界面上教的写法要跟规矩对得上（教错了用户照着打就没反应）", () => {
  it("用法页：例句卡片里凡是带时间的都打了 ~，并且明写了这条规矩", () => {
    // 卡片右边的解析结果是真跑解析器出来的：例句少个 ~，那张卡片当场就露馅
    expect(guideSource).toContain("时间前面打个 ~");
    expect(guideSource).toContain('{ text: "~明天 交周报"');
    expect(guideSource).toContain('{ text: "~周五下午3点 提交周报"');
    expect(guideSource).toContain('{ text: "~每周一 交周报"');
    expect(guideSource).toContain('{ text: "~明天 ~15点 !高 画趋势图"');
    // 反面那张（故意不打 ~）也要留着：一正一反并排，规矩一眼就懂
    expect(guideSource).toContain('{ text: "下周三 去体检"');
  });

  it("三个输入框的提示语都带着 ~", () => {
    expect(quickAddBarSource).toContain("记一条…「~周五下午3点 提交周报");
    expect(quickAddWinSource).toContain("记一条…「~周五下午3点 提交周报");
    expect(quickAddSheetSource).toContain("时间前打个 ~"); // 手机屏窄，只提一句
    // 子任务那两条也得改口，不然照着「明天 !高」打，日期不会被认出来
    expect(taskCardSource).toContain("可以写「~明天 !高」");
    expect(taskSheetSource).toContain("可以直接写「~明天 !高」");
    // 任务卡底下那栏「快捷改」的提示语：这一档的框是空的，照着它打就是用户唯一的依据。
    // 少个 ~ 的话，「明天 15点」会被当成新标题把原标题整条换掉
    expect(taskCardSource).toContain("快捷改：输入「~明天 ~15点 !高 #标签 /清单 @人」");
    expect(taskCardSource).not.toContain("快捷改：输入「明天");
    // 提示语改对了还不够：万一用户漏打 ~，那句时间词也不许把原标题整条换掉。
    // 这一档撤销当场按不出来（焦点在框里，Ctrl+Z 被 inEditable 挡着），所以要在写库前拦一道
    expect(taskCardSource).toContain("const bareTime = isBareTimeOnly(p.title, settings.weekendDay);");
    expect(taskCardSource).toContain("if (p.title.trim() && !bareTime) patch.title = p.title.trim();");
    expect(taskCardSource).toContain('showToast("时间前面要打个 ~ 才算数，标题先没动", false)');
  });

  it("设置里「周末指的是」那句也带着 ~（照着写「周末」是不设日期的）", () => {
    expect(settingsSource).toContain("记事时写「~周末」「~下周末」");
    // 用法页那张周末卡的注释跟卡片正文得对得上：正文有 ~，注释不能没有
    expect(guideSource).toContain("也可以写「~下周末」");
    expect(guideSource).toContain("「~每周一三五」这样连写也识别");
    expect(guideSource).toContain("「~每周末」按设置里的周末日算");
  });

  it("两处补全的 token 规则口径一致：~ 也当边界（@李哥~3点 不再筛人名）", () => {
    // 两个文件里各写着一条 TOKEN_RE，口径必须一样（SyntaxInput 那条把 / 转义了，先抹平再比）
    const line = (src: string): string => {
      const m = /const TOKEN_RE = .*/.exec(src);
      expect(m, "找不到 TOKEN_RE").not.toBeNull();
      return m![0].replace(/\\\//g, "/");
    };
    expect(line(syntaxInputSource)).toBe(line(mergeSource));
    expect(line(mergeSource)).toContain("!！~～");
  });
});
