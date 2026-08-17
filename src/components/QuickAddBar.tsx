// 快速添加条：边打字边解析（chips 实时预览 + #/@// 自动补全），回车落库。
// /清单 不存在时自动新建；# 只管标签。
// withPickers = 再挂一排「点着选」的按钮（日期/清单/需求方/优先级/循环），
// 不背语法的人纯点也能把一条事记全；两边同时给了以打字为准。
import { useEffect, useState } from "react";
import type { ParseResult } from "../core/parse";
import type { Priority, RepeatRule } from "../core/model";
import { LIST_COLORS } from "../core/model";
import { addDays, dayOfWeek, formatShort, todayYMD } from "../core/dates";
import { addList, addTask, allTags, allWho, useApp } from "../core/store";
import SyntaxInput from "./SyntaxInput";

export interface QuickAddBarProps {
  /** 视图上下文默认值：如清单视图里默认加进该清单 */
  defaults?: { listId?: string | null; who?: string | null; due?: string | null };
  placeholder?: string;
  autoFocus?: boolean;
  /** 挂出「点着选」的一排按钮 */
  withPickers?: boolean;
  onAdded?: (id: string) => void;
}

interface Picks {
  due: string | null;
  listId: string | null;
  who: string | null;
  priority: Priority;
  repeat: RepeatRule | null;
}

const EMPTY: Picks = { due: null, listId: null, who: null, priority: 0, repeat: null };

const PRIO_NAME = ["不标", "低", "中", "高"] as const;

/** 「每周/每月」按当天算，所以每次打开菜单现算——常驻托盘跨过零点也不会用昨天的星期几 */
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
    case "daily": return r.every === 1 ? "每天" : `每 ${r.every} 天`;
    case "workday": return "每工作日";
    case "weekly": return "每周";
    case "monthly": return `每月 ${r.day} 号`;
  }
}

type MenuId = "due" | "list" | "who" | "prio" | "repeat";

/** 一枚选择按钮 + 它自己的小菜单：没选是淡的，选了就变成主题色小签。
 *  必须放在组件外——写在 render 里每次渲染都是新组件类型，菜单里的输入框会被卸载重建 */
function Pick({ id, on, label, menu, setMenu, children }: {
  id: MenuId;
  on: boolean;
  label: React.ReactNode;
  menu: MenuId | null;
  setMenu: (m: MenuId | null) => void;
  children: React.ReactNode;
}) {
  return (
    <span className="qa-slot">
      <button className={`qa-pick${on ? " on" : ""}`} onClick={() => setMenu(menu === id ? null : id)}>
        {label}
      </button>
      {menu === id && <div className="popmenu qa-pop">{children}</div>}
    </span>
  );
}

export default function QuickAddBar({
  defaults, placeholder, autoFocus, withPickers, onAdded,
}: QuickAddBarProps) {
  const data = useApp((s) => s.data);
  const lists = data.lists;
  const [text, setText] = useState("");
  const [pick, setPick] = useState<Picks>(EMPTY);
  const [menu, setMenu] = useState<MenuId | null>(null);
  const today = todayYMD();
  const whoNames = allWho(data).map((w) => w.who);

  // 点别处关掉打开的小菜单
  useEffect(() => {
    if (!menu) return;
    function onDoc(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest(".qa-picks")) setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu(null);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function submit(parsed: ParseResult) {
    if (!parsed.title.trim()) return;
    // defaults.listId 可能指向一张刚被删除的清单，落库前验一遍存在性
    const defaultListId =
      defaults?.listId && lists.some((l) => l.id === defaults.listId) ? defaults.listId : null;
    const pickedListId = pick.listId && lists.some((l) => l.id === pick.listId) ? pick.listId : null;
    let listId = pickedListId ?? defaultListId;
    if (parsed.listName != null) {
      const hit = lists.find((l) => l.name === parsed.listName);
      listId = hit ? hit.id : addList(parsed.listName, LIST_COLORS[lists.length % LIST_COLORS.length]);
    }
    const id = addTask({
      title: parsed.title.trim(),
      listId,
      tags: parsed.tags,
      who: parsed.who ?? pick.who ?? defaults?.who ?? null,
      priority: parsed.priority || pick.priority,
      due: parsed.due ?? pick.due ?? defaults?.due ?? null,
      dueTime: parsed.dueTime,
      repeat: parsed.repeat ?? pick.repeat,
    });
    setText("");
    onAdded?.(id);
  }

  const picked = pick.due || pick.listId || pick.who || pick.priority || pick.repeat;
  const pickedList = lists.find((l) => l.id === pick.listId);

  return (
    <div className={`quick-add${withPickers ? " tall" : ""}`}>
      <div className="qa-line">
        <span className="plus">＋</span>
        <SyntaxInput
          value={text}
          onChange={setText}
          onSubmit={submit}
          autoFocus={autoFocus}
          placeholder={placeholder ?? "记一条…「周五下午3点 提交周报 /工作 @李哥 #紧要 !高」"}
          lists={lists.map((l) => l.name)}
          tags={allTags(data).map((t) => t.tag)}
          whos={whoNames}
          showChips
        />
      </div>

      {withPickers && (
        <div className="qa-picks">
          <span className="qa-hint">或者点着选：</span>

          <Pick menu={menu} setMenu={setMenu} id="due" on={!!pick.due} label={<>📅 {pick.due ? formatShort(pick.due) : "日期"}</>}>
            <button className="item" onClick={() => { setPick({ ...pick, due: today }); setMenu(null); }}>今天</button>
            <button className="item" onClick={() => { setPick({ ...pick, due: addDays(today, 1) }); setMenu(null); }}>明天</button>
            <button className="item" onClick={() => {
              const wd = dayOfWeek(today);
              setPick({ ...pick, due: addDays(today, wd === 0 ? 1 : 8 - wd) });
              setMenu(null);
            }}>下周一</button>
            <div className="sep" />
            <input
              className="inline"
              type="date"
              value={pick.due ?? ""}
              onChange={(e) => { if (e.target.value) { setPick({ ...pick, due: e.target.value }); setMenu(null); } }}
            />
            <button className="item" onClick={() => { setPick({ ...pick, due: null }); setMenu(null); }}>不定日期</button>
          </Pick>

          <Pick
            menu={menu}
            setMenu={setMenu}
            id="list"
            on={!!pickedList}
            label={pickedList
              ? <><span className="dot" style={{ background: `var(--list-${pickedList.color})` }} /> {pickedList.name}</>
              : <>🗂 清单</>}
          >
            <button className="item" onClick={() => { setPick({ ...pick, listId: null }); setMenu(null); }}>不归清单</button>
            {lists.map((l) => (
              <button key={l.id} className="item" onClick={() => { setPick({ ...pick, listId: l.id }); setMenu(null); }}>
                <span className="dot" style={{ background: `var(--list-${l.color})` }} />
                {l.name}
              </button>
            ))}
          </Pick>

          <Pick menu={menu} setMenu={setMenu} id="who" on={!!pick.who} label={<>👤 {pick.who ?? "需求方"}</>}>
            <button className="item" onClick={() => { setPick({ ...pick, who: null }); setMenu(null); }}>不指定</button>
            {whoNames.map((w) => (
              <button key={w} className="item" onClick={() => { setPick({ ...pick, who: w }); setMenu(null); }}>{w}</button>
            ))}
            <div className="sep" />
            <input
              className="inline"
              placeholder="新需求方，回车确定"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v) setPick({ ...pick, who: v });
                  setMenu(null);
                }
              }}
            />
          </Pick>

          <Pick
            menu={menu}
            setMenu={setMenu}
            id="prio"
            on={pick.priority > 0}
            label={<><span className={`flag p${pick.priority}`} /> {pick.priority ? PRIO_NAME[pick.priority] : "重要性"}</>}
          >
            {([3, 2, 1, 0] as Priority[]).map((p) => (
              <button key={p} className="item" onClick={() => { setPick({ ...pick, priority: p }); setMenu(null); }}>
                <span className={`flag p${p}`} />
                {PRIO_NAME[p]}
              </button>
            ))}
          </Pick>

          <Pick menu={menu} setMenu={setMenu} id="repeat" on={!!pick.repeat} label={<>🔁 {pick.repeat ? repeatLabel(pick.repeat) : "重复"}</>}>
            {repeatChoices(today).map((r) => (
              <button key={r.label} className="item" onClick={() => { setPick({ ...pick, repeat: r.rule }); setMenu(null); }}>
                {r.label}
              </button>
            ))}
          </Pick>

          {picked && (
            <button className="qa-clear" title="清空这些选择" onClick={() => { setPick(EMPTY); setMenu(null); }}>
              清空
            </button>
          )}
          <span className="qa-tip">选了就一直生效，方便连着记好几条</span>
        </div>
      )}
    </div>
  );
}
