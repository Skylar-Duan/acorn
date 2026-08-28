// 用法：一句话怎么写。
//
// 用户口径（2026-08-28）：「直接用举例卡片的模式来说明便捷语」——
// 所以这一页不写语法表，只摆例子：左边是你会打的那句，右边是橡果读出来的东西（真解析，不是画的）。
// 手机上一屏一张卡、竖着刷；电脑上铺成两三列。
import { useMemo, useState } from "react";
import { parseQuickAdd } from "../core/parse";
import type { ParseChip } from "../core/parse";
import { allTags, allWho, useApp } from "../core/store";
import SyntaxInput from "../components/SyntaxInput";
import "../styles/guide.css";

const CHIP_ICON: Record<ParseChip["kind"], string> = {
  date: "📅", time: "🕒", repeat: "↻", list: "▤", tag: "#", who: "＠", priority: "⚑",
};

interface Card {
  text: string;
  note: string;
}

interface Section {
  title: string;
  lead: string;
  cards: Card[];
}

const SECTIONS: Section[] = [
  {
    title: "什么时候做",
    lead: "口语怎么说就怎么打，不用挑格式。说不准的日子（月底、年底）它自己算。",
    cards: [
      { text: "明天 交周报", note: "今天 / 明天 / 后天 / 大后天 都认" },
      { text: "周五 和李哥对一版", note: "光写「周五」是本周那个周五；已经过了就是下周" },
      { text: "下周三 体检", note: "上周 / 本周 / 下周 + 周几" },
      { text: "8月31日 交学费", note: "也可以写 8/31、8-31、31号" },
      { text: "十月底之前 交材料", note: "月底 / 月初 / 月中 / 年底；「之前」只是语气，不影响日子" },
      { text: "3天后 复查", note: "N天后 / N周后" },
    ],
  },
  {
    title: "几点做",
    lead: "写了钟点就会到点提醒你；只写日子不打扰。",
    cards: [
      { text: "明天下午3点 面谈", note: "下午 / 晚上 会自动换成 24 小时制" },
      { text: "15:30 拿快递", note: "只写钟点 = 今天；今天这个点过了就算明天" },
      { text: "周一早上9点半 例会", note: "「半」和「N分」都认" },
      { text: "今晚 收拾行李", note: "今晚 = 今天 20:00" },
    ],
  },
  {
    title: "多重要",
    lead: "感叹号越多越重要，或者直接写字。",
    cards: [
      { text: "!高 报税", note: "!高 / !中 / !低" },
      { text: "报税 !!!", note: "!!! = 高，!! = 中，! = 低（全角！也认）" },
    ],
  },
  {
    title: "算谁的事",
    lead: "三个符号分工：/ 是清单，@ 是需求方（为谁做），# 是标签。",
    cards: [
      { text: "/工作 写季度总结", note: "清单不存在会当场新建" },
      { text: "@李哥 @王姐 出差报销", note: "一件事可以挂好几个人，侧栏每人名下都看得到" },
      { text: "#紧要 #对外 场地确认", note: "标签想加几个加几个" },
      { text: "周五 !高 /投顾 @知更鸟 #财报 写 NVDA 点评", note: "全部混着写也行，顺序随意" },
    ],
  },
  {
    title: "每隔多久做一次",
    lead: "重复的事写一次就够。做完一条，下一次自动排上。",
    cards: [
      { text: "每周一 交周报", note: "每周一三五 这样连着写也认" },
      { text: "每个工作日 看盘", note: "周一到周五" },
      { text: "每月15号 还款", note: "当月没有这一天就落在月末" },
      { text: "每3天 浇花", note: "每天 / 每N天" },
    ],
  },
  {
    title: "子任务也能这么写",
    lead: "在任务卡里加子任务时，日期 / 钟点 / 重要性一并记上。清单、需求方、标签归整件事管，在子任务里就是普通文字。",
    cards: [
      { text: "明天 15点 !高 画趋势图", note: "子任务可以自己排一天，不写就跟着母任务走" },
    ],
  },
];

function ExampleCard({ card, listNames }: { card: Card; listNames: string[] }) {
  const parsed = useMemo(
    () => parseQuickAdd(card.text, { now: new Date(), listNames }),
    [card.text, listNames],
  );
  return (
    <div className="gd-card">
      <div className="gd-say">{card.text}</div>
      <div className="gd-out">
        {parsed.chips.map((c, i) => (
          <span key={i} className="chip">
            {CHIP_ICON[c.kind]} {c.text}
          </span>
        ))}
        <span className="gd-title">{parsed.title || "（只写要素，没有标题）"}</span>
      </div>
      <div className="gd-note">{card.note}</div>
    </div>
  );
}

export default function Guide() {
  const data = useApp((s) => s.data);
  const listNames = useMemo(() => data.lists.map((l) => l.name), [data.lists]);
  const [tryIt, setTryIt] = useState("");

  return (
    <section className="main">
      <div className="view-head">
        <h1>一句话记事</h1>
        <span className="sub">想到什么打一句，日期、清单、需求方、重要性它自己认</span>
      </div>
      <div className="view-body gd-body">
        <div className="gd-try">
          <div className="gd-try-label">在这儿试一句，右边实时告诉你它读懂了什么（不会真的建任务）</div>
          <div className="gd-try-box">
            <SyntaxInput
              value={tryIt}
              onChange={setTryIt}
              onSubmit={() => { /* 只是试试，不落库 */ }}
              placeholder="比如：下周三下午3点 !高 /工作 @李哥 场地确认"
              lists={listNames}
              tags={allTags(data).map((t) => t.tag)}
              whos={allWho(data).map((w) => w.who)}
            />
          </div>
        </div>

        {SECTIONS.map((s) => (
          <div key={s.title} className="gd-section">
            <h2>{s.title}</h2>
            <p className="gd-lead">{s.lead}</p>
            <div className="gd-grid">
              {s.cards.map((c) => (
                <ExampleCard key={c.text} card={c} listNames={listNames} />
              ))}
            </div>
          </div>
        ))}

        <div className="gd-section">
          <h2>改一件已经记下的事</h2>
          <p className="gd-lead">
            点开任务，最底下那一栏里就是这件事的<strong>一整句话</strong>——橡果按当前状态现写的。
            改这句话就是改这件事：把「!高」删掉就降级，把日期改掉就改期，删掉「@李哥」就把人摘了。
            旁边的 ↺ 丢掉手上这句、换回这件事现在的样子。
            <br />
            少数任务写不成一句话（标题里正好有「明天」这类会被认成日期的词，或者清单名里有空格）。
            那种情况下这一栏左边的标签会变成<strong>「快捷改」</strong>，框是空的，规矩也换回老的那套：
            <strong>写了哪类就改哪类，没写的不动</strong>——所以它只能加不能删，要摘掉什么请用上面那排按钮。
          </p>
          <div className="gd-grid">
            <ExampleCard
              card={{ text: "2026-08-31 !高 /工作 @李哥 写周报", note: "打开任务时它自己长这样，你只管改" }}
              listNames={listNames}
            />
          </div>
        </div>

        <div className="gd-section">
          <h2>不想背这些</h2>
          <p className="gd-lead">
            「随手记」输入框下面有一排按钮：日期、清单、需求方、重要性、循环，点着选就行，
            选中的会一直生效，方便连着记好几条。两种记法可以混着用。
          </p>
        </div>
      </div>
    </section>
  );
}
