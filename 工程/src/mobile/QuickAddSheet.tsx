// 记一条抽屉（画板 ③）——贴着键盘的那张纸。
//
// v1.11.0 时这张纸**一个字都不解析**（用户 2026-09-02：「手机版就不用快捷输入了，直接选择就好了」）。
// 用户 2026-09-03 改口：「手机版，便捷输入还是加回去，便捷卡片也加上」——他在手机上打了
// 「下周一晚上bill朋友来取东西。」，日期没被认出来，整句留在了标题里。所以现在这张纸：
//   · 打一句话，边打边解析（core/parse.parseQuickAdd，跟电脑同一个解析器、同一套写法），
//     认出来的东西在输入框底下变成一排小胶囊（📅 🕒 ▤ ＠ # ⚑ ↻），每颗带 ×：
//     × 一下 = 「这个别认」——那一类整个不认，原文回到标题里，一个字不丢；
//     改过点选的那一类不画胶囊（值在点选那一排显示，两排别各说各的）；
//   · 点选那一排照旧留着。打字和点选谁说了算见 ./quickAddMerge.ts（纯逻辑、有单测）：
//     打出来的优先、点选只补没打的；点选按钮上显示的是现在生效的值，点它能改，改完以点选为准；
//   · 打到 @ / / / # 时，输入框底下横排现有的需求方 / 清单 / 标签，点一个填进去；
//   · 「?」打开举例卡片——跟电脑「怎么记一句话」同一份 GuideContent，手机上是叠在上面的一张全高的纸。
//
// 落库这条路仍然是桌面那一条（core/store.addTask），跟 QuickAddBar 同一个口径：
//   · /清单 不存在时自动新建（addList）；
//   · 📅 里刚选完、去抖还没烧到点的那一天要先接过来（pending + flush），
//     不然「点完日历格 350ms 内按记下」这条事会不带日期地建出来，而那个日期一会儿静默跟到下一条上；
//   · 记完**只清那句话、不清点选**——跟桌面「选中的会保持生效，方便连续记录」同一个口径。
import { useEffect, useMemo, useRef, useState } from "react";
import type { Priority, RepeatRule } from "../core/model";
import { LIST_COLORS } from "../core/model";
import { parseQuickAdd } from "../core/parse";
import type { ParseChip } from "../core/parse";
import { dayOfWeek, duePresets, formatShort, todayYMD } from "../core/dates";
import { addList, addTask, allTags, allWho, useApp } from "../core/store";
import DateField from "../components/DateField";
import type { DateFieldHandle } from "../components/DateField";
import { CommitMark, useCommitFlash } from "../components/commitFlash";
import { useGuideEntry } from "../components/GuideSheet";
import { closeSheet, useSheet } from "./sheetStore";
import Sheet from "./Sheet";
import {
  EMPTY_PICKS, acceptCandidate, candidatesAt, dropKind, merge, visibleChips, withOverride,
} from "./quickAddMerge";
import type { ChipKind, Overrides, PickField, Picks } from "./quickAddMerge";
import "../styles/mobile-sheet.css";

const PRIO_NAME = ["无", "低", "中", "高"] as const;

/** 胶囊图标：跟 SyntaxInput / GuideContent 那两份一致，用户在电脑和手机上看到的是同一套记号 */
const CHIP_ICON: Record<ChipKind, string> = {
  date: "📅", time: "🕒", repeat: "↻", list: "▤", tag: "#", who: "＠", priority: "⚑",
};
/** × 的读屏文案用的名字 */
const KIND_NAME: Record<ChipKind, string> = {
  date: "日期", time: "钟点", repeat: "循环", list: "清单", tag: "标签", who: "需求方", priority: "重要性",
};

type Seg = "due" | "list" | "who" | "prio" | "repeat" | null;

export function QuickAddSheetHost() {
  // 举例卡片那张纸（guide）可以叠在这张上面：栈顶是它的时候这张纸也得留着，
  // 不然它一收、里面打了一半的那句话就没了。所以看的是「栈里有没有」，不是「栈顶是不是」
  const entry = useSheet((s) => s.stack.find((x) => x.kind === "quickAdd") ?? null);
  const open = entry !== null;
  const listId = entry?.kind === "quickAdd" ? entry.listId ?? null : null;
  // 纸一收，这里面的组件就整个卸载，点选也跟着清干净——「保持生效」只在一次打开期间成立
  return (
    <Sheet open={open} onClose={closeSheet} label="记一条" className="msh-sheet msh-qa-sheet">
      <QuickAddBody listId={listId} />
    </Sheet>
  );
}

function QuickAddBody({ listId }: { listId: string | null }) {
  const lists = useApp((s) => s.data.lists);
  const tasks = useApp((s) => s.data.tasks);
  const settings = useApp((s) => s.data.settings);
  const whoNames = useMemo(() => allWho({ tasks, settings }).map((w) => w.who), [tasks, settings]);
  const tagNames = useMemo(() => allTags({ tasks }).map((t) => t.tag), [tasks]);
  const listNames = useMemo(() => lists.map((l) => l.name), [lists]);
  const today = todayYMD();
  // 快捷预设走 core/dates.duePresets 那一份，全仓一处算一处用
  const presets = duePresets(today);
  const guide = useGuideEntry();

  /** 那句话本身（原文）。标题是解析之后剩下的那部分 */
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  /** 胶囊上按过 × 的那几类：这几类别认，原文留在标题里 */
  const [dropped, setDropped] = useState<ChipKind[]>([]);
  /** 改过点选的字段（值是改那一刻打字给的签名）：这些字段以点选为准，直到打字那边再动 */
  const [overrides, setOverrides] = useState<Overrides>({});
  // 从清单页点 ＋ 进来时，这条事默认就归那张清单
  const [pick, setPick] = useState<Picks>({ ...EMPTY_PICKS, listId });
  const [seg, setSeg] = useState<Seg>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dueFieldRef = useRef<DateFieldHandle | null>(null);
  /** 点完补全候选之后光标要停的位置（受控 value 落地后再设） */
  const pendingCaret = useRef<number | null>(null);
  const flash = useCommitFlash();

  // 边打边解析。喂清单名是为了「/生」能对上「生活」；周末日跟设置走（「周末」指周六还是周日）
  const parsed = useMemo(
    () => parseQuickAdd(text, {
      now: new Date(),
      listNames,
      weekendDay: settings.weekendDay,
      skip: dropped.length ? dropped : undefined,
    }),
    [text, listNames, settings.weekendDay, dropped],
  );
  /** 现在生效的那份：点选那一排显示它，记下也是记它 */
  const eff = useMemo(() => merge(parsed, pick, overrides), [parsed, pick, overrides]);
  /** 胶囊那一排画的：只有现在还由打字说了算的那几颗。改过点选的那一类不画——
   *  它的值点选那一排在显示，两排各写一个日期用户不知道记的是哪个 */
  const chips = useMemo(() => visibleChips(parsed, eff), [parsed, eff]);
  const cand = useMemo(
    () => candidatesAt(text, caret, { lists: listNames, whos: whoNames, tags: tagNames }),
    [text, caret, listNames, whoNames, tagNames],
  );

  // 一打开就聚焦，键盘马上顶上来——这张纸的全部意义就是「现在就把它记下来」。
  // 补两拍再 focus 一次：安卓 WebView 在抽屉还在做进场位移的那一帧经常把 focus 丢掉，
  // 只在挂载那一下调一次会出现「纸开了、键盘没来」
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const t1 = setTimeout(() => el.focus(), 60);
    const t2 = setTimeout(() => el.focus(), 240);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  // 举例卡片叠上来的时候把键盘收掉——全高的那张纸底下还顶着键盘就只剩半张能看；
  // 看完收掉，焦点还给输入框（等纸退场那一拍演完），打了一半的那句接着打
  const guideOpen = useSheet((s) => s.stack.some((x) => x.kind === "guide"));
  const guideWas = useRef(false);
  useEffect(() => {
    const was = guideWas.current;
    guideWas.current = guideOpen;
    if (guideOpen) {
      inputRef.current?.blur();
      return;
    }
    if (!was) return;
    const t = setTimeout(() => inputRef.current?.focus(), 240);
    return () => clearTimeout(t);
  }, [guideOpen]);

  // 点完补全候选：受控 value 落地之后，把光标挪到填进去的那个词后面，接着打
  useEffect(() => {
    const p = pendingCaret.current;
    if (p === null) return;
    pendingCaret.current = null;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(p, p);
  }, [text]);

  /** 改了点选：先记签名（从此这个字段以点选为准），再改值。
   *  next 由调用方从**现在生效的值**出发算——打了 @bill 再点「王工」是两个人，不是把 bill 挤掉 */
  function changePick(field: PickField, next: Partial<Picks>) {
    setOverrides((o) => withOverride(o, parsed, field));
    setPick((p) => ({ ...p, ...next }));
  }

  /** 点预设 / 点「不要」= 话已经说完了：把还欠着的那一次去抖丢掉，
   *  免得它一会儿回来把刚点的这个盖掉（跟 QuickAddBar.pickDue 同一条）。
   *  换日子不换钟点：「下周一晚上」改成明天，还是晚上 */
  function pickDue(d: string | null) {
    dueFieldRef.current?.cancel();
    changePick("due", { due: d, dueTime: d ? eff.dueTime : null });
  }

  function record() {
    const t = parsed.title.trim();
    if (!t) return;
    // 📅 里刚选完、去抖还没烧到点的那一天：这条事必须带上它（flush 把它记进 pick 给下一条接着用）
    const pendingDue = dueFieldRef.current?.pending() ?? null;
    dueFieldRef.current?.flush();
    const m = merge(parsed, pendingDue !== null ? { ...pick, due: pendingDue } : pick, overrides);
    // 点选的清单可能刚被删掉，落库前验一遍存在性；打的 /清单 不存在就新建（跟 QuickAddBar 同一条）
    let listId = m.listId && lists.some((l) => l.id === m.listId) ? m.listId : null;
    if (m.listName !== null) {
      const hit = lists.find((l) => l.name === m.listName);
      listId = hit ? hit.id : addList(m.listName, LIST_COLORS[lists.length % LIST_COLORS.length]);
    }
    addTask({
      title: t,
      listId,
      tags: m.tags,
      who: m.who,
      priority: m.priority,
      due: m.due,
      dueTime: m.due ? m.dueTime : null,
      repeat: m.repeat,
    });
    // 只清那句话（连带它的 × 和「以点选为准」的记号）；点选原样留着，焦点也留着：
    // 连着记三条不用重选清单、也不用重新点输入框
    setText("");
    setDropped([]);
    setOverrides({});
    flash.flash();
    inputRef.current?.focus();
  }

  function toggleSeg(name: Exclude<Seg, null>) {
    setSeg((cur) => (cur === name ? null : name));
  }

  /** 那句话改了。整句擦空 = 从头来：× 过的、改过点选的记号一起清掉 */
  function onText(v: string) {
    setText(v);
    if (!v) {
      setDropped([]);
      setOverrides({});
    }
  }

  /** 点了补全候选：把半截 token 换成整个词 */
  function accept(item: string) {
    if (cand === null) return;
    const r = acceptCandidate(text, cand, item);
    pendingCaret.current = r.caret;
    setCaret(r.caret);
    onText(r.text);
  }

  /** 生效的清单：点选的按 id 找；打的按名字找，找不到（要新建的）就先拿名字画 */
  const effList = eff.listId
    ? lists.find((l) => l.id === eff.listId) ?? null
    : eff.listName !== null
      ? lists.find((l) => l.name === eff.listName) ?? { id: null, name: eff.listName, color: null }
      : null;

  return (
    <div className="msh-qa">
      <div className="msh-qa-line">
        <span className="msh-qa-cb" aria-hidden />
        <input
          ref={inputRef}
          className={`msh-qa-input${flash.on ? " commit-lit" : ""}`}
          value={text}
          autoFocus
          placeholder="记一条…"
          enterKeyHint="done"
          aria-label="要记的这件事"
          onChange={(e) => {
            setCaret(e.target.selectionStart ?? e.target.value.length);
            onText(e.target.value);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            record();
          }}
        />
        <CommitMark on={flash.on} />
        {/* 跟桌面 QuickAddBar 那颗一样贴在输入框右边：打开举例卡片 */}
        <button className="msh-qa-help" aria-label="怎么记一句话" onClick={guide.open}>?</button>
        <button className="msh-qa-go" disabled={!parsed.title.trim()} onClick={record}>
          记下
        </button>
      </div>
      {guide.sheet}

      {/* 认出来的东西：一颗一颗摆在输入框底下，用户立刻知道「下周一 20:00」被读懂了。
          × 是「这个别认」，原文回到标题里。改过点选的那一类不在这排（点选那排在显示它） */}
      {chips.length > 0 && (
        <div className="msh-qa-chips" aria-label="认出来的">
          {chips.map((c: ParseChip, i) => (
            <span key={`${c.kind}-${i}`} className={`msh-qa-chip ${c.kind}`}>
              <span className="msh-qa-chip-t">{CHIP_ICON[c.kind]} {c.text}</span>
              <button
                type="button"
                className="msh-qa-x"
                aria-label={`不要认${KIND_NAME[c.kind]}`}
                // 按住不抢焦点：键盘留着，× 完接着打
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setDropped((d) => dropKind(d, c.kind))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 打到 @ / / / # 之后：现有的需求方 / 清单 / 标签横排一行，点一个填进去 */}
      {cand !== null && (
        <div className="msh-qa-cands" aria-label="补全">
          {cand.items.map((it) => (
            <button
              key={it}
              type="button"
              className="msh-qa-cand"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => accept(it)}
            >
              <span className="msh-qa-mark">{cand.trigger === "@" ? "＠" : cand.trigger === "/" ? "▤" : "#"}</span>
              {it}
            </button>
          ))}
        </div>
      )}

      {/* 已选的亮起来（带上值），没选的灰着——显示的是**现在生效的**：打了「下周一」，日期这颗就写下周一。
          这一排是内容不是导航，允许左右滚 */}
      <div className="msh-picks">
        <button className={`msh-pick${eff.due ? " on" : ""}`} onClick={() => toggleSeg("due")}>
          <IconDate on={!!eff.due} />
          {eff.due ? `${formatShort(eff.due)}${eff.dueTime ? ` ${eff.dueTime}` : ""}` : "日期"}
        </button>
        <button className={`msh-pick${effList ? " on" : ""}`} onClick={() => toggleSeg("list")}>
          <span className="msh-dot" style={{ background: effList?.color ? `var(--list-${effList.color})` : "var(--ink-3)" }} />
          {effList ? effList.name : "清单"}
        </button>
        <button className={`msh-pick${eff.who.length ? " on" : ""}`} onClick={() => toggleSeg("who")}>
          <IconWho />
          {eff.who.length ? eff.who.join("、") : "需求方"}
        </button>
        <button className={`msh-pick${eff.priority ? " on" : ""}`} onClick={() => toggleSeg("prio")}>
          <span className={`flag p${eff.priority}`} />
          {eff.priority ? PRIO_NAME[eff.priority] : "重要性"}
        </button>
        <button className={`msh-pick${eff.repeat ? " on" : ""}`} onClick={() => toggleSeg("repeat")}>
          <span aria-hidden>↻</span>
          {eff.repeat ? repeatLabel(eff.repeat) : "重复"}
        </button>
      </div>

      {/* 点哪个就在这张纸里长出对应的一段：不跳页，也不再往上叠第二层抽屉 */}
      {seg === "due" && (
        <div className="msh-seg">
          <div className="msh-row">
            {presets.map((p) => (
              <button key={p.key} className={`msh-opt${eff.due === p.ymd ? " on" : ""}`} onClick={() => pickDue(p.ymd)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="msh-row">
            <input
              className="msh-field"
              type="time"
              value={eff.dueTime ?? ""}
              aria-label="时间"
              // 只填了时间没填日期 → 落到今天，不留「有时间无日期」的悬空状态（跟任务卡同口径）
              onChange={(e) =>
                changePick("due", { dueTime: e.target.value || null, due: eff.due ?? (e.target.value ? today : null) })
              }
            />
            {/* 草稿 / 闸门 / 去抖三件套都在 DateField 里。**不给 onDone**：选完这一段留着，好接着设时间 */}
            <DateField
              ref={dueFieldRef}
              className="msh-field date"
              value={eff.due ?? ""}
              onCommit={(ymd) => changePick("due", { due: ymd, dueTime: eff.dueTime })}
            />
            <button className="msh-opt narrow" onClick={() => pickDue(null)}>
              不要
            </button>
          </div>
        </div>
      )}

      {seg === "list" && (
        <div className="msh-seg">
          <div className="msh-chips">
            <button
              className={`msh-opt${effList ? "" : " on"}`}
              onClick={() => changePick("list", { listId: null })}
            >
              先不分清单
            </button>
            {lists.map((l) => (
              <button
                key={l.id}
                className={`msh-opt${effList?.id === l.id ? " on" : ""}`}
                onClick={() => changePick("list", { listId: l.id })}
              >
                <span className="msh-dot" style={{ background: `var(--list-${l.color})` }} />
                {l.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {seg === "who" && (
        <div className="msh-seg">
          <div className="msh-chips">
            {whoNames.map((w) => {
              const on = eff.who.includes(w);
              return (
                <button
                  key={w}
                  className={`msh-opt${on ? " on" : ""}`}
                  onClick={() =>
                    changePick("who", { who: on ? eff.who.filter((x) => x !== w) : [...eff.who, w] })
                  }
                >
                  {w}
                </button>
              );
            })}
            {eff.who.length > 0 && (
              <button className="msh-opt" onClick={() => changePick("who", { who: [] })}>
                不指定
              </button>
            )}
          </div>
          <input
            className="msh-field wide"
            placeholder="新需求方，回车确定"
            enterKeyHint="done"
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault(); // 别让这一下回车顺着跑成「记下」
              const el = e.currentTarget;
              const v = el.value.trim();
              if (v && !eff.who.includes(v)) changePick("who", { who: [...eff.who, v] });
              el.value = ""; // 非受控：落完自己清，留在原地接着加下一个
            }}
          />
        </div>
      )}

      {seg === "prio" && (
        <div className="msh-seg">
          <div className="msh-row">
            {([3, 2, 1, 0] as Priority[]).map((p) => (
              <button
                key={p}
                className={`msh-opt${eff.priority === p ? " on" : ""}`}
                onClick={() => changePick("priority", { priority: p })}
              >
                <span className={`flag p${p}`} />
                {PRIO_NAME[p]}
              </button>
            ))}
          </div>
        </div>
      )}

      {seg === "repeat" && (
        <div className="msh-seg">
          <div className="msh-chips">
            {repeatChoices(today).map((r) => (
              <button
                key={r.label}
                className={`msh-opt${sameRule(eff.repeat, r.rule) ? " on" : ""}`}
                onClick={() => changePick("repeat", { repeat: r.rule })}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 「每周 / 每月」按当天算，所以每次现算——跨过零点也不会用昨天的星期几 */
function repeatChoices(today: string): { label: string; rule: RepeatRule | null }[] {
  return [
    { label: "不重复", rule: null },
    { label: "每天", rule: { kind: "daily", every: 1 } },
    { label: "每个工作日", rule: { kind: "workday" } },
    { label: "每周（按今天是周几）", rule: { kind: "weekly", days: [dayOfWeek(today)] } },
    { label: "每月（按今天几号）", rule: { kind: "monthly", day: Number(today.slice(8)) } },
  ];
}

function repeatLabel(r: RepeatRule): string {
  switch (r.kind) {
    case "daily":
      return r.every === 1 ? "每天" : `每 ${r.every} 天`;
    case "workday":
      return "每工作日";
    case "weekly":
      return "每周";
    case "monthly":
      return `每月 ${r.day} 号`;
  }
}

function sameRule(a: RepeatRule | null, b: RepeatRule | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function IconDate({ on }: { on: boolean }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke={on ? "currentColor" : "var(--ink-2)"} strokeWidth="1.8" strokeLinecap="round" aria-hidden
    >
      <rect x="4" y="5" width="16" height="15" rx="3" />
      <path d="M4 10h16" />
    </svg>
  );
}

function IconWho() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 20c1.5-4 4-6 7-6s5.5 2 7 6" />
    </svg>
  );
}
