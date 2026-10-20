import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseQuickAdd, parseSubtaskInput } from "../src/core/parse";
import { editedCategoryPatch, editedTitlePatch, parseEditedTitle } from "../src/core/editSyntax";
import { newTask } from "../src/core/model";
import { candidatesAt } from "../src/mobile/quickAddMerge";
import SyntaxInput from "../src/components/SyntaxInput";
import GuideContent from "../src/components/GuideContent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const now = new Date(2026, 9, 20, 12);
const options = { now, listNames: ["工作", "生活"] };
const parse = (input: string) => parseQuickAdd(input, options);
const styles = [['"', '"'], ["“", "”"], ["＂", "＂"]] as const;

describe("引用正文不参与语法识别", () => {
  it.each(styles)("%s…%s 内的全部语法保持原文，不产生属性", (open, close) => {
    const text = `核对${open}~明天下午3点 !!! ！高 @李哥 /工作 #紧要 ~每周一${close}`;
    for (const parsed of [parse(text), parseSubtaskInput(text, now), parseEditedTitle(text, options)]) {
      expect(parsed).toMatchObject({ title: text, due: null, dueTime: null, priority: 0, repeat: null, who: [], listName: null, tags: [], chips: [] });
    }
  });

  it.each(styles)("%s…%s 内最后出现的标记也不会覆盖引号外的属性", (open, close) => {
    const literal = `${open}~明天 !低 @王工 /生活 #生活 ~每天${close}`;
    const parsed = parse(`~周五下午3点 !!! @李哥 /工作 #项目 ~每周一 核对${literal}`);
    expect(parsed).toMatchObject({ title: `核对${literal}`, due: "2026-10-23", dueTime: "15:00", priority: 3, who: ["李哥"], listName: "工作", tags: ["项目"], repeat: { kind: "weekly", days: [1] } });
    expect(parsed.chips).toHaveLength(7);
  });

  it("引用可紧接普通归类，正文与引号不会被吞进名字", () => {
    expect(parse('@李哥"@王工" #项目“#紧要” /工作＂/生活＂ 核对')).toMatchObject({
      title: '"@王工" “#紧要” ＂/生活＂ 核对', who: ["李哥"], tags: ["项目"], listName: "工作",
    });
  });

  it.each(styles)("%s…%s 内空格、提醒词和换行均不被标题清理改写", (open, close) => {
    const literal = `${open}  提醒我  @李哥\n\t~明天  ${close}`;
    expect(parse(`~明天   核对 ${literal}`).title).toBe(`核对 ${literal}`);
  });

  it.each(styles)("%s…%s 输入尚未闭合时不提前更改已有属性，补完后恢复引号外识别", (open, close) => {
    const text = `记录${open}~明天 !!! @李哥 /工作 #项目`;
    expect(parse(text)).toMatchObject({ title: text, chips: [] });
    expect(parse(`${text}${close} ~后天 !低`)).toMatchObject({ title: `${text}${close}`, due: "2026-10-22", priority: 1, who: [], tags: [], listName: null });
    const newline = `${text}\n~后天 复核`;
    expect(parseQuickAdd(newline, { ...options, keepNewlines: true })).toMatchObject({ title: `${text}\n复核`, due: "2026-10-22", priority: 0 });
  });

  it("成对多行引用整体保留，混用另一类引号和转义引号不提前关闭引用", () => {
    const multiline = '“第一行 ~今天\n第二行 "!!!" @李哥”';
    expect(parse(`${multiline} ~明天`)).toMatchObject({ title: multiline, due: "2026-10-21", priority: 0, who: [] });
    const escaped = '"正文 \\" ~明天 !!! @李哥"';
    expect(parse(`${escaped} ~后天`)).toMatchObject({ title: escaped, due: "2026-10-22", priority: 0, who: [] });
  });

  it("引用中的波浪线不会跨越引号给外面的时间授权，外面的波浪线也不穿过引用", () => {
    for (const text of ['"~"明天', '~"正文"明天', '~ “正文” 明天']) {
      expect(parse(text)).toMatchObject({ title: text, due: null, chips: [] });
    }
  });

  it("原文包含内部占位字符时仍完整恢复多段引用", () => {
    const text = '\u00000\u0000 “@李哥” "!!!" ＂~明天＂';
    expect(parse(text)).toMatchObject({ title: text, chips: [] });
  });

  it("引用不覆盖原记录，外部显式标记仍可修改日期；未知字段保留", () => {
    const current = { ...newTask({ title: "旧标题", priority: 3, due: "2026-11-01" }), who: ["李哥"], futureField: { keep: [1, 2] } };
    const literal = '“~今天 !低 @王工 /生活 #新标签 ~每天”';
    const parsed = parseEditedTitle(`${literal} ~明天`, options);
    const patch = { ...editedTitlePatch(current, parsed), ...editedCategoryPatch(current, parsed, null) };
    expect(patch).toEqual({ title: literal, due: "2026-10-21" });
    expect({ ...current, ...patch }).toMatchObject({ priority: 3, who: ["李哥"], futureField: { keep: [1, 2] } });
  });
});

describe("时间符号后的行内空白", () => {
  it.each(["~ 明天", "～　明天", "~\t明天", "~  明天下午3点", "~ 每周一"])("%s 在主任务、子任务与改标题中保持同一语义", (marker) => {
    const baseline = parse(`${marker.replace(/\s/g, "")} 核对`);
    for (const parsed of [parse(`${marker} 核对`), parseSubtaskInput(`${marker} 核对`, now), parseEditedTitle(`${marker} 核对`, options)]) {
      expect(parsed).toEqual(baseline);
    }
  });

  it("不会跨行领入日期、不会跨正文领入日期，范围号仍是原文", () => {
    for (const text of ["~\n明天 核对", "~ 正文 明天 核对", "预计3~ 5天内交稿", "会期周日～ 周五"]) {
      expect(parse(text)).toMatchObject({ due: null, dueTime: null, repeat: null, chips: [] });
    }
    expect(parse("~ 明天 下午3点 核对")).toMatchObject({ due: "2026-10-21", dueTime: null, title: "下午3点 核对" });
  });
});

describe("真实输入框与说明卡片", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

  const pools = { lists: ["工作"], whos: ["李哥"], tags: ["项目"] };
  function renderInput(value: string, onSubmit = vi.fn()) {
    act(() => root.render(createElement(SyntaxInput, { value, onChange: vi.fn(), onSubmit, ...pools })));
    const input = host.querySelector("input")!;
    act(() => { input.focus(); input.setSelectionRange(value.length, value.length); input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
    return input;
  }

  it.each(styles)("%s…%s 引用内不弹补全，回车提交的归类为空", (open, close) => {
    for (const [trigger, name] of [["@", "李"], ["#", "项"], ["/", "工"]]) {
      const draft = `记录${open} ${trigger}${name}`;
      const submit = vi.fn(); const input = renderInput(draft, submit);
      expect(host.querySelector(".si-drop")).toBeNull();
      expect(host.querySelector(".si-chips")).toBeNull();
      expect(candidatesAt(draft, draft.length, pools)).toBeNull();
      act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ title: draft, who: [], tags: [], listName: null, chips: [] }));
      const outside = `${draft}${close} ${trigger}${name}`;
      renderInput(outside);
      expect(host.querySelector(".si-drop")).not.toBeNull();
      expect(candidatesAt(outside, outside.length, pools)).not.toBeNull();
    }
  });

  it("已有闭合引用中移动光标时同样不补全，引用后面重新输入可正常补全", () => {
    const text = '核对“ @李 ” @李';
    expect(candidatesAt(text, text.indexOf("李") + 1, pools)).toBeNull();
    expect(candidatesAt(text, text.length, pools)?.items).toEqual(["李哥"]);
  });

  it("说明卡片真跑解析器：引用卡只显示外部日期，引用原文完整保留", () => {
    act(() => root.render(createElement(GuideContent, { listNames: ["工作"], whoNames: ["李哥"], tagNames: ["紧要"], nowMs: now.getTime() })));
    const section = Array.from(host.querySelectorAll(".gd-section")).find((section) => section.querySelector("h2")?.textContent === "引号里的内容保持原样")!;
    expect(section).toBeDefined();
    const cards = section.querySelectorAll(".gd-card");
    expect(cards[0].querySelectorAll(".chip")).toHaveLength(1);
    expect(cards[0].querySelector(".gd-title")?.textContent).toBe("核对“~明天 !!! @李哥 /工作 #紧要”");
    expect(cards[1].querySelectorAll(".chip")).toHaveLength(0);
    expect(cards[1].querySelector(".gd-title")?.textContent).toBe('记录 "~每周一 !高" 和＂~下午3点＂');
    expect(host.textContent).toContain("直接改标题即可");
    expect(host.textContent).not.toContain("完整一句话");
  });
});
