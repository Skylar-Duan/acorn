// 「一句话记事」说明正文。举例卡片右边的解析结果是真跑 parseQuickAdd 出来的，不是画的。
//
// 这个文件不许 import store：它同时被主窗（应用内弹层）和 guide 独立窗口用，
// 第二个 webview 有自己的 JS 世界，import store 会新起一个实例去读 userdata。
// 候选清单/标签/需求方一律走 props 传进来。
import { useMemo, useState } from "react";
import { parseQuickAdd } from "../core/parse";
import type { ParseChip } from "../core/parse";
// platform.ts 只读 navigator.userAgent，不碰 store，独立窗口里一样能用
import { isMobile } from "../core/platform";
import SyntaxInput from "./SyntaxInput";
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
    lead: "按平时的说法写，不限格式。「月底」「年底」这类会换算成具体日期。",
    cards: [
      { text: "明天 交周报", note: "今天 / 明天 / 后天 / 大后天" },
      { text: "周五 和李哥对一版", note: "「周五」指本周五；本周五已过则算下周五" },
      { text: "下周三 体检", note: "上周 / 本周 / 下周 + 周几；「下周前」= 本周日" },
      { text: "下下周三 复查", note: "再下一周的周三" },
      { text: "周末 陪爸妈吃饭", note: "周末指周六还是周日，在设置里选；也可以写「下周末」" },
      { text: "8月31日 交学费", note: "也可以写 8/31、8-31、31号、下个月5号" },
      { text: "十月底之前 交材料", note: "月底 / 月初 / 月中 / 下月底 / 年底。「之前」不影响日期" },
      { text: "3天后 复查", note: "N天后 / N周后 / N个月后" },
      { text: "三天内 回复邮件", note: "「N天内」和「N天后」是一个意思" },
      { text: "春节前 买好车票", note: "元旦 / 春节 / 清明 / 五一 / 端午 / 中秋 / 国庆 / 圣诞，过了就算明年的" },
    ],
  },
  {
    title: "几点做",
    lead: "写了钟点会到点提醒；只写日期不提醒。",
    cards: [
      { text: "明天下午3点 面谈", note: "下午 / 晚上 换算成 24 小时制" },
      { text: "15:30 拿快递", note: "只写钟点算今天；今天这个点已过则算明天" },
      { text: "周一早上9点半 例会", note: "支持「半」和「N分」" },
      { text: "今晚 收拾行李", note: "今晚 / 明早 / 明晚 / 明天下午 这类说法给一个默认钟点：早上 9 点、中午 12 点、下午 3 点、晚上 8 点" },
    ],
  },
  {
    title: "多重要",
    lead: "写感叹号，或者直接写等级。",
    cards: [
      { text: "!高 报税", note: "!高 / !中 / !低" },
      { text: "报税 !!!", note: "!!! 高，!! 中，! 低。全角！同样识别" },
    ],
  },
  {
    title: "算谁的事",
    lead: "三个符号分工：/ 是清单，@ 是需求方，# 是标签。",
    cards: [
      { text: "/工作 写季度总结", note: "清单不存在时自动新建" },
      { text: "@李哥 @王姐 出差报销", note: "一件事可以挂多个需求方，侧栏每人名下都会出现" },
      { text: "#紧要 #对外 场地确认", note: "标签数量不限" },
      { text: "周五 !高 /投顾 @知更鸟 #财报 写 NVDA 点评", note: "可以混写，顺序不限" },
    ],
  },
  {
    title: "每隔多久做一次",
    lead: "重复的事写一次。完成一条后，下一次自动排上。",
    cards: [
      { text: "每周一 交周报", note: "「每周一三五」这样连写也识别；「每周末」按设置里的周末日算" },
      { text: "每个工作日 看盘", note: "周一至周五" },
      { text: "每月15号 还款", note: "当月没有这一天时落在月末" },
      { text: "每3天 浇花", note: "每天 / 每N天" },
    ],
  },
  {
    title: "子任务也这么写",
    lead: "子任务同样识别日期、钟点和重要性。清单、需求方、标签属于整件事，写在子任务里只当普通文字。",
    cards: [
      { text: "明天 15点 !高 画趋势图", note: "子任务可以单独排期；不写则跟随母任务" },
    ],
  },
];

function ExampleCard({
  card, listNames, nowMs, weekendDay,
}: { card: Card; listNames: string[]; nowMs: number; weekendDay?: "sat" | "sun" }) {
  // nowMs 必须进依赖：这份内容会挂在一个常驻不销毁的窗口里，跨天之后
  // 「明天」不重算就会停在窗口第一次打开那天
  const parsed = useMemo(
    () => parseQuickAdd(card.text, { now: new Date(nowMs), listNames, weekendDay }),
    [card.text, listNames, nowMs, weekendDay],
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
        <span className="gd-title">{parsed.title || "（只有要素，没有标题）"}</span>
      </div>
      <div className="gd-note">{card.note}</div>
    </div>
  );
}

export interface GuideContentProps {
  listNames: string[];
  tagNames: string[];
  whoNames: string[];
  /** 卡片按这个时刻解析。窗口常驻时由外面在每次显示/聚焦时刷新 */
  nowMs: number;
  /** 「周末」指周六还是周日（设置里那一项）。不给就当周日 */
  weekendDay?: "sat" | "sun";
}

export default function GuideContent({ listNames, tagNames, whoNames, nowMs, weekendDay }: GuideContentProps) {
  const [tryIt, setTryIt] = useState("");

  return (
    <div className="gd-body">
      <div className="gd-try">
        <div className="gd-try-label">在这里试写一句，右边显示解析结果。不会创建任务。</div>
        <div className="gd-try-box">
          <SyntaxInput
            value={tryIt}
            onChange={setTryIt}
            // 只是试写，不落库——返回 false 是明着告诉输入框「这一下什么都没存」，
            // 别闪那个 ✓：旁边的说明白纸黑字写着「不会创建任务」
            onSubmit={() => false}
            // 手机上这句被硬裁在「场地确」，末尾没有省略号，读起来像输入框坏了。
            // 短的那句一样把「日期 + 重要性 + 清单」三件事说全了
            placeholder={isMobile ? "例如：下周三3点 !高 /工作" : "例如：下周三下午3点 !高 /工作 @李哥 场地确认"}
            lists={listNames}
            tags={tagNames}
            whos={whoNames}
            weekendDay={weekendDay}
          />
        </div>
      </div>

      {SECTIONS.map((s) => (
        <div key={s.title} className="gd-section">
          <h2>{s.title}</h2>
          <p className="gd-lead">{s.lead}</p>
          <div className="gd-grid">
            {s.cards.map((c) => (
              <ExampleCard key={c.text} card={c} listNames={listNames} nowMs={nowMs} weekendDay={weekendDay} />
            ))}
          </div>
        </div>
      ))}

      <div className="gd-section">
        <h2>改一件已经记下的事</h2>
        <p className="gd-lead">
          打开任务，最底下一栏是这件事的<strong>完整一句话</strong>，按当前状态生成。
          改这句话就是改这件事：删掉「!高」是降级，改日期是改期，删掉「@李哥」是移除需求方。
          旁边的 ↺ 放弃当前编辑，退回这件事现在的样子。
          <br />
          少数任务写不成完整一句话（标题里正好有会被认成日期的词，或者清单名带空格）。
          这时左边的标签会显示<strong>「快捷改」</strong>，输入框留空，规则也换成
          <strong>写了哪类就改哪类，没写的不动</strong>；这种模式只能增改不能删除，要移除某项请用上面那排按钮。
        </p>
        <div className="gd-grid">
          <ExampleCard
            card={{ text: "2026-08-31 !高 /工作 @李哥 写周报", note: "打开任务时它就是这个样子，直接改" }}
            listNames={listNames}
            nowMs={nowMs}
            weekendDay={weekendDay}
          />
        </div>
      </div>

      <div className="gd-section">
        <h2>不写语法也能记</h2>
        <p className="gd-lead">
          「记一条」输入框下面有一排按钮：日期、清单、需求方、重要性、循环，点选即可。
          选中的会保持生效，方便连着记好几条。两种方式可以混用。
        </p>
      </div>
    </div>
  );
}
