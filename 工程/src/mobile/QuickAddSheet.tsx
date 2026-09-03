// 记一条抽屉（画板 ③）——贴着键盘的那张纸，v1.11.0。
//
// **手机上不用背语法**（用户 2026-09-02 定）：这张纸里打进去的字**原样**就是标题，
// 一个字都不解析——「/工作」不会变成清单、「!高」不会变成重要性，它们就是标题的一部分。
// 日期 / 清单 / 需求方 / 重要性 / 重复全靠点：手指打不快，边打边背 chip 语法是桌面才成立的事。
// 所以这个文件里**既没有解析器、也没有那个快捷语法输入框**——
// tests/mobile-sheets.test.ts 直接按名字禁着它们，连注释里都不许提，免得哪天被顺手加回来。
//
// 落库这条路仍然是桌面那一条（core/store.addTask），跟 QuickAddBar 一字不差：
//   · 📅 里刚选完、去抖还没烧到点的那一天要先接过来（pending + flush），
//     不然「点完日历格 350ms 内按记下」这条事会不带日期地建出来，而那个日期一会儿静默跟到下一条上；
//   · 记完**只清标题、不清点选**——跟桌面「选中的会保持生效，方便连续记录」同一个口径。
import { useEffect, useMemo, useRef, useState } from "react";
import type { Priority, RepeatRule } from "../core/model";
import { dayOfWeek, duePresets, formatShort, todayYMD } from "../core/dates";
import { addTask, allWho, useApp } from "../core/store";
import DateField from "../components/DateField";
import type { DateFieldHandle } from "../components/DateField";
import { CommitMark, useCommitFlash } from "../components/commitFlash";
import { closeSheet, topSheet, useSheet } from "./sheetStore";
import Sheet from "./Sheet";
import "../styles/mobile-sheet.css";

const PRIO_NAME = ["无", "低", "中", "高"] as const;

type Seg = "due" | "list" | "who" | "prio" | "repeat" | null;

interface Picks {
  due: string | null;
  dueTime: string | null;
  listId: string | null;
  /** 需求方可以点好几个 */
  who: string[];
  priority: Priority;
  repeat: RepeatRule | null;
}

export function QuickAddSheetHost() {
  const top = useSheet((s) => topSheet(s.stack));
  const open = top?.kind === "quickAdd";
  const listId = top?.kind === "quickAdd" ? top.listId ?? null : null;
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
  const today = todayYMD();
  // 快捷预设走 core/dates.duePresets 那一份，全仓一处算一处用
  const presets = duePresets(today);

  const [title, setTitle] = useState("");
  // 从清单页点 ＋ 进来时，这条事默认就归那张清单
  const [pick, setPick] = useState<Picks>({
    due: null, dueTime: null, listId, who: [], priority: 0, repeat: null,
  });
  const [seg, setSeg] = useState<Seg>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dueFieldRef = useRef<DateFieldHandle | null>(null);
  const flash = useCommitFlash();

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

  /** 点预设 / 点「不要」= 话已经说完了：把还欠着的那一次去抖丢掉，
   *  免得它一会儿回来把刚点的这个盖掉（跟 QuickAddBar.pickDue 同一条） */
  function pickDue(d: string | null) {
    dueFieldRef.current?.cancel();
    setPick((p) => ({ ...p, due: d, dueTime: d ? p.dueTime : null }));
  }

  function record() {
    const t = title.trim();
    if (!t) return;
    // 📅 里刚选完、去抖还没烧到点的那一天：这条事必须带上它（flush 把它记进 pick 给下一条接着用）
    const pendingDue = dueFieldRef.current?.pending() ?? null;
    dueFieldRef.current?.flush();
    // pick.listId 可能指向一张刚被删掉的清单，落库前验一遍存在性
    const listOk = pick.listId && lists.some((l) => l.id === pick.listId) ? pick.listId : null;
    const due = pendingDue ?? pick.due;
    addTask({
      title: t, // 原样：手机上这行字**不过解析**
      listId: listOk,
      who: pick.who,
      priority: pick.priority,
      due,
      dueTime: due ? pick.dueTime : null,
      repeat: pick.repeat,
    });
    setTitle("");
    flash.flash();
    // 点选原样留着，焦点也留着：连着记三条不用重选清单、也不用重新点输入框
    inputRef.current?.focus();
  }

  function toggleSeg(name: Exclude<Seg, null>) {
    setSeg((cur) => (cur === name ? null : name));
  }

  const pickedList = lists.find((l) => l.id === pick.listId);

  return (
    <div className="msh-qa">
      <div className="msh-qa-line">
        <span className="msh-qa-cb" aria-hidden />
        <input
          ref={inputRef}
          className={`msh-qa-input${flash.on ? " commit-lit" : ""}`}
          value={title}
          autoFocus
          placeholder="记一条…"
          enterKeyHint="done"
          aria-label="要记的这件事"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            record();
          }}
        />
        <CommitMark on={flash.on} />
        <button className="msh-qa-go" disabled={!title.trim()} onClick={record}>
          记下
        </button>
      </div>

      {/* 已选的亮起来（带上值），没选的灰着。这一排是内容不是导航，允许左右滚 */}
      <div className="msh-picks">
        <button className={`msh-pick${pick.due ? " on" : ""}`} onClick={() => toggleSeg("due")}>
          <IconDate on={!!pick.due} />
          {pick.due ? `${formatShort(pick.due)}${pick.dueTime ? ` ${pick.dueTime}` : ""}` : "日期"}
        </button>
        <button className={`msh-pick${pickedList ? " on" : ""}`} onClick={() => toggleSeg("list")}>
          <span className="msh-dot" style={{ background: pickedList ? `var(--list-${pickedList.color})` : "var(--ink-3)" }} />
          {pickedList ? pickedList.name : "清单"}
        </button>
        <button className={`msh-pick${pick.who.length ? " on" : ""}`} onClick={() => toggleSeg("who")}>
          <IconWho />
          {pick.who.length ? pick.who.join("、") : "需求方"}
        </button>
        <button className={`msh-pick${pick.priority ? " on" : ""}`} onClick={() => toggleSeg("prio")}>
          <span className={`flag p${pick.priority}`} />
          {pick.priority ? PRIO_NAME[pick.priority] : "重要性"}
        </button>
        <button className={`msh-pick${pick.repeat ? " on" : ""}`} onClick={() => toggleSeg("repeat")}>
          <span aria-hidden>↻</span>
          {pick.repeat ? repeatLabel(pick.repeat) : "重复"}
        </button>
      </div>

      {/* 点哪个就在这张纸里长出对应的一段：不跳页，也不再往上叠第二层抽屉 */}
      {seg === "due" && (
        <div className="msh-seg">
          <div className="msh-row">
            {presets.map((p) => (
              <button key={p.key} className={`msh-opt${pick.due === p.ymd ? " on" : ""}`} onClick={() => pickDue(p.ymd)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="msh-row">
            <input
              className="msh-field"
              type="time"
              value={pick.dueTime ?? ""}
              aria-label="时间"
              // 只填了时间没填日期 → 落到今天，不留「有时间无日期」的悬空状态（跟任务卡同口径）
              onChange={(e) =>
                setPick((p) => ({ ...p, dueTime: e.target.value || null, due: p.due ?? (e.target.value ? today : null) }))
              }
            />
            {/* 草稿 / 闸门 / 去抖三件套都在 DateField 里。**不给 onDone**：选完这一段留着，好接着设时间 */}
            <DateField
              ref={dueFieldRef}
              className="msh-field date"
              value={pick.due ?? ""}
              onCommit={(ymd) => setPick((p) => ({ ...p, due: ymd }))}
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
              className={`msh-opt${pick.listId ? "" : " on"}`}
              onClick={() => setPick((p) => ({ ...p, listId: null }))}
            >
              先不分清单
            </button>
            {lists.map((l) => (
              <button
                key={l.id}
                className={`msh-opt${pick.listId === l.id ? " on" : ""}`}
                onClick={() => setPick((p) => ({ ...p, listId: l.id }))}
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
              const on = pick.who.includes(w);
              return (
                <button
                  key={w}
                  className={`msh-opt${on ? " on" : ""}`}
                  onClick={() =>
                    setPick((p) => ({ ...p, who: on ? p.who.filter((x) => x !== w) : [...p.who, w] }))
                  }
                >
                  {w}
                </button>
              );
            })}
            {pick.who.length > 0 && (
              <button className="msh-opt" onClick={() => setPick((p) => ({ ...p, who: [] }))}>
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
              if (v) setPick((p) => (p.who.includes(v) ? p : { ...p, who: [...p.who, v] }));
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
                className={`msh-opt${pick.priority === p ? " on" : ""}`}
                onClick={() => setPick((cur) => ({ ...cur, priority: p }))}
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
                className={`msh-opt${sameRule(pick.repeat, r.rule) ? " on" : ""}`}
                onClick={() => setPick((p) => ({ ...p, repeat: r.rule }))}
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
