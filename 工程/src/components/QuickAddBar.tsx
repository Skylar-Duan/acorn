// 快速添加条：边打字边解析（chips 实时预览 + #/@// 自动补全），回车落库。
// /清单 不存在时自动新建；# 只管标签。
// withPickers = 再挂一排「点着选」的按钮（日期/清单/需求方/优先级/循环），
// 不背语法的人纯点也能把一条事记全；两边同时给了以打字为准。
import { useEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent as ReactFocusEvent } from "react";
import type { ParseResult } from "../core/parse";
import { parseQuickAdd } from "../core/parse";
import { deskDueRepeat, withOverride } from "../mobile/quickAddMerge";
import type { Overrides, PickField } from "../mobile/quickAddMerge";
import type { Priority, RepeatRule } from "../core/model";
import { LIST_COLORS } from "../core/model";
import { formatShort, todayYMD } from "../core/dates";
import { dateOptions } from "../core/options";
import { addList, addTask, allTags, allWho, useApp } from "../core/store";
import SyntaxInput from "./SyntaxInput";
import type { SyntaxInputEl } from "./SyntaxInput";
import { describeRepeat } from "../core/recur";
import DateField from "./DateField";
import type { DateFieldHandle } from "./DateField";
import RepeatPicker from "./RepeatPicker";
import RepeatMenu from "./RepeatMenu";
import { useLeaving } from "./motion";
import { useGuideEntry } from "./GuideSheet";

export interface QuickAddBarProps {
  /** 视图上下文默认值：如清单视图里默认加进该清单 */
  defaults?: { listId?: string | null; who?: string[]; due?: string | null };
  placeholder?: string;
  autoFocus?: boolean;
  /** 挂出「点着选」的一排按钮 */
  withPickers?: boolean;
  onAdded?: (id: string) => void;
}

interface Picks {
  due: string | null;
  listId: string | null;
  /** 需求方可以点好几个 */
  who: string[];
  priority: Priority;
  repeat: RepeatRule | null;
}

const EMPTY: Picks = { due: null, listId: null, who: [], priority: 0, repeat: null };

const PRIO_NAME = ["无", "低", "中", "高"] as const;

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
  // 关掉的时候让弹层多活一拍把退场演完（B6），不然是「啪一下没了」
  const pop = useLeaving(menu === id ? id : null);
  return (
    <span className="qa-slot">
      <button className={`qa-pick${on ? " on" : ""}`} onClick={() => setMenu(menu === id ? null : id)}>
        {label}
      </button>
      {pop.shown && <div className={`popmenu qa-pop${pop.leaving ? " leaving" : ""}`}>{children}</div>}
    </span>
  );
}

export default function QuickAddBar({
  defaults, placeholder, autoFocus, withPickers, onAdded,
}: QuickAddBarProps) {
  // B8：只订阅真用得上的三片，需求方/标签两张表也缓存起来。
  // 这条输入框每敲一个字都会重渲染（text 是本地 state），以前每敲一下就把全库的
  // 需求方和标签各数一遍——数据其实一个字都没变
  const lists = useApp((s) => s.data.lists);
  const tasks = useApp((s) => s.data.tasks);
  const settings = useApp((s) => s.data.settings);
  const [text, setText] = useState("");
  const [pick, setPick] = useState<Picks>(EMPTY);
  const [menu, setMenu] = useState<MenuId | null>(null);
  /** 🔁 那个菜单现在是常用项（false）还是「自定义…」面板（true） */
  const [repeatCustom, setRepeatCustom] = useState(false);
  /** 日期 / 循环两样「改过点选」的记号（跟手机 QuickAddSheet 同一套：谁后动谁说了算） */
  const [overrides, setOverrides] = useState<Overrides>({});
  /** 📅 那个日期框（DateField）的三个手：flush 提前落、cancel 作废、pending 看还欠着什么。
   *  草稿 / 闸门 / 去抖三件套都封在组件里，这儿不再各写一份 */
  const dueFieldRef = useRef<DateFieldHandle | null>(null);
  /** 整条快速添加条（含那排点选按钮）。失焦提交时用来判「焦点是不是还在自己家里」 */
  const wrapRef = useRef<HTMLDivElement>(null);
  const today = todayYMD();
  const whoNames = useMemo(() => allWho({ tasks, settings }).map((w) => w.who), [tasks, settings]);
  const tagNames = useMemo(() => allTags({ tasks }).map((t) => t.tag), [tasks]);
  const guide = useGuideEntry();
  const listNames = useMemo(() => lists.map((l) => l.name), [lists]);
  // 跟 SyntaxInput 里那份同样的参数再解析一次：点选那排要知道「打字这边现在给了哪天、哪种循环」，
  // 🔁 菜单的「每周X / 每月X号」按这条事最后会存下的日子出，而不是只看点选的那一天
  const parsed = useMemo(
    () => parseQuickAdd(text, { now: new Date(), listNames, weekendDay: settings.weekendDay }),
    [text, listNames, settings.weekendDay],
  );
  /** 现在生效的日期与循环：跟回车落库用的是同一个算法 */
  const eff = deskDueRepeat(
    parsed,
    { due: dueFieldRef.current?.pending() ?? pick.due ?? defaults?.due ?? null, repeat: pick.repeat },
    overrides,
  );
  const repeatAnchor = eff.due ?? today;

  /** 改了点选的日期 / 循环：记下签名，从此这一样以点选为准（打字那边再动又归打字） */
  function changePick(field: PickField, next: Partial<Picks>) {
    setOverrides((o) => withOverride(o, parsed, field));
    setPick((p) => ({ ...p, ...next }));
  }

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

  /** 点预设 / 点「不定日期」= 话已经说完了：把还欠着的那一次去抖丢掉，
   *  免得它一会儿回来把刚点的这个盖掉 */
  function pickDue(d: string | null) {
    dueFieldRef.current?.cancel();
    changePick("due", { due: d });
    setMenu(null);
  }

  function submit(parsed: ParseResult) {
    if (!parsed.title.trim()) return;
    // 📅 里刚选完、去抖还没烧到点的那一天：这条事必须带上它。
    // 不接这一手就是「点完日历格 350ms 内回车 → 这条事不带日期地建出来，
    // 而那个日期一会儿静默跟到下一条事身上」。点预设和「清空」都已经 cancel 过了，
    // 这是对称的另一半：flush 把它记进 pick（下一条接着用），pendingDue 给这条事现用
    const pendingDue = dueFieldRef.current?.pending() ?? null;
    dueFieldRef.current?.flush();
    // defaults.listId 可能指向一张刚被删除的清单，落库前验一遍存在性
    // 日期与循环：打字和点选谁后动谁说了算（deskDueRepeat，跟手机一个口径）
    const dr = deskDueRepeat(parsed, { due: pendingDue ?? pick.due ?? defaults?.due ?? null, repeat: pick.repeat }, overrides);
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
      // 打字写了 @谁 就以打字为准；没写才用点选的，再没有才用视图默认（在某人名下新建）
      who: parsed.who.length ? parsed.who : pick.who.length ? pick.who : defaults?.who ?? [],
      priority: parsed.priority || pick.priority,
      due: dr.due,
      dueTime: dr.dueTime,
      repeat: dr.repeat,
    });
    setText("");
    setOverrides({});
    onAdded?.(id);
  }

  /** A1「点走 = 提交」。但**点自己那排「点着选」的按钮不算点走**——
   *  那一下正是在给这条事补日期/清单，抢先落库等于帮倒忙。
   *  **窗口失焦同样不算点走**：alt-tab 出去时 relatedTarget 是 null，
   *  拦不住就是打了一半的那句被当场记成一条事 */
  // 事件的元素类型跟着 SyntaxInput 走：那个框开了 multiline 之后底下可能是 textarea
  // （随手记这处没开，但类型得对得上，不然 TS 那边参数逆变直接不给过）
  function commitOnBlur(parsed: ParseResult, e: ReactFocusEvent<SyntaxInputEl>): boolean {
    if (!document.hasFocus()) return false;
    const next = e.relatedTarget as Node | null;
    if (next && wrapRef.current?.contains(next)) return false;
    if (!parsed.title.trim()) return false;
    submit(parsed);
    return true;
  }

  const picked = pick.due || pick.listId || pick.who.length || pick.priority || pick.repeat;
  const pickedList = lists.find((l) => l.id === pick.listId);

  return (
    <div className={`quick-add${withPickers ? " tall" : ""}`} ref={wrapRef}>
      <div className="qa-line">
        <span className="plus">＋</span>
        <SyntaxInput
          value={text}
          onChange={(v) => { setText(v); if (!v) setOverrides({}); }}
          onSubmit={submit}
          onBlurCommit={commitOnBlur}
          onEscape={() => {
            // Esc 才是丢弃：把还没记的这句擦掉，留在原地接着打
            if (!text) return false;
            setText("");
            setOverrides({});
            return true;
          }}
          autoFocus={autoFocus}
          placeholder={placeholder ?? "记一条…「~周五下午3点 提交周报 /工作 @李哥 #紧要 !高」"}
          lists={lists.map((l) => l.name)}
          tags={tagNames}
          whos={whoNames}
          weekendDay={settings.weekendDay}
          showChips
        />
        <button className="qa-help" title="怎么写一句话" onClick={guide.open}>?</button>
      </div>
      {guide.sheet}

      {withPickers && (
        <div className="qa-picks">
          <span className="qa-hint">也可以点选：</span>

          <Pick menu={menu} setMenu={setMenu} id="due" on={!!pick.due} label={<>📅 {pick.due ? formatShort(pick.due) : "日期"}</>}>
            {/* 全应用选日子同一套（core/options.dateOptions）：今天 / 明天 / 本周末 / 下周末 / 本月末，
                下面那个日期框就是「选日期…」。一处算一处用，别在这儿再写一份 */}
            {dateOptions(today, { weekendDay: settings.weekendDay }).map((p) => (
              <button key={p.key} className="item" onClick={() => pickDue(p.ymd)}>
                {p.label}
              </button>
            ))}
            <div className="sep" />
            {/* 草稿 + 闸门 + 去抖三件套全在 DateField 里（这个框以前漏了草稿，
                键盘敲年份每敲一下都被 React 弹回原值，用户看到的是「框坏了」）。
                这儿只交代两件事：记下来（**只记，不关弹层**）、真的点走了才收弹层 */}
            <DateField
              ref={dueFieldRef}
              value={pick.due ?? ""}
              onCommit={(ymd) => changePick("due", { due: ymd })}
              onDone={(e) => {
                // 焦点还在这排点选按钮里（比如正按着上面的预设）就别收弹层——
                // 收了那一下 click 就落在正在退场的弹层上了
                const next = e.relatedTarget as HTMLElement | null;
                if (next && next.closest(".qa-picks")) return;
                setMenu(null);
              }}
            />
            <button className="item" onClick={() => pickDue(null)}>不定日期</button>
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

          {/* 需求方可以点好几个：点一下选中、再点一下取消，菜单不关，选完点别处收起 */}
          <Pick
            menu={menu}
            setMenu={setMenu}
            id="who"
            on={pick.who.length > 0}
            label={<>👤 {pick.who.length ? pick.who.join("、") : "需求方"}</>}
          >
            <button className="item" onClick={() => { setPick({ ...pick, who: [] }); setMenu(null); }}>不指定</button>
            {whoNames.map((w) => {
              const on = pick.who.includes(w);
              return (
                <button
                  key={w}
                  className="item"
                  onClick={() =>
                    setPick({ ...pick, who: on ? pick.who.filter((x) => x !== w) : [...pick.who, w] })
                  }
                >
                  <span style={{ width: 12, color: "var(--accent)" }}>{on ? "✓" : ""}</span>
                  {w}
                </button>
              );
            })}
            <div className="sep" />
            <input
              className="inline"
              placeholder="新需求方，回车确定"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  const el = e.target as HTMLInputElement;
                  const v = el.value.trim();
                  if (v && !pick.who.includes(v)) setPick({ ...pick, who: [...pick.who, v] });
                  el.value = ""; // 接着加下一个
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

          <Pick
            menu={menu}
            // 每次点开都先回到常用项那一页，不停在上回的自定义面板上
            setMenu={(m) => { if (m === "repeat") setRepeatCustom(false); setMenu(m); }}
            id="repeat"
            on={!!pick.repeat}
            label={<>🔁 {pick.repeat ? describeRepeat(pick.repeat) : "重复"}</>}
          >
            {repeatCustom ? (
              <RepeatPicker
                value={eff.repeat}
                anchor={repeatAnchor}
                onDone={(r) => { changePick("repeat", { repeat: r }); setMenu(null); }}
                onCancel={() => setRepeatCustom(false)}
              />
            ) : (
              // 全应用一套（core/options.repeatMenu）：[现值 ✓] 每天 / 每个工作日 / 每周X / 每月X号 /
              // 每隔几天… / 自定义… / 不重复。「每周/每月」按这条事现在生效的日期算（打字的、点选的、视图默认，
              // 跟回车落库同一个算法；都没有按今天），每次打开现算；打勾的也是现在生效的那条循环
              <RepeatMenu
                anchor={repeatAnchor}
                value={eff.repeat}
                onPick={(r) => { changePick("repeat", { repeat: r }); setMenu(null); }}
                onCustom={() => setRepeatCustom(true)}
              />
            )}
          </Pick>

          {picked && (
            <button className="qa-clear" title="清空这些选择" onClick={() => { dueFieldRef.current?.cancel(); setPick(EMPTY); setOverrides({}); setMenu(null); }}>
              清空
            </button>
          )}
          <span className="qa-tip">选中的会保持生效，方便连续记录</span>
        </div>
      )}
    </div>
  );
}
