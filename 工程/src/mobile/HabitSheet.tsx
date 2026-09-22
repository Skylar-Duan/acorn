// 加一个习惯 / 改一个习惯（v1.11.2）——习惯页右下角那颗 ＋ 拉出来的纸，点一行习惯也是它。
//
// 为什么要有这张纸：v1.11.1 的习惯页把桌面那张「输入框 + 周期下拉 + 加上」的横条原样搬到了
// 手机上，390px 宽根本排不下，三件东西挤成两行半；而右下角那颗 ＋ 又被藏了起来（NO_FAB 里
// 写着 habits），用户看到的就是「加号被遮住了」。现在反过来：页面上一件多余的控件都没有，
// 要加就点 ＋，跟这本 App 其它每一页一个手势。
//
// 跟「记一条」同一个规矩：**全靠点，不用背语法**。名字是一个输入框，周期是一排胶囊，
// 底下一颗主按钮。编辑态多一颗「删除这个习惯」，按两下才真删——手机上没有右键、
// 也没有「刚才那下是不是点歪了」的余地（跟清单设置那张纸同一道闸）。

import { useEffect, useState } from "react";
import type { RepeatRule } from "../core/model";
import { addHabit, aliveHabits, deleteTasks, setHabitRepeat, updateTask, useApp } from "../core/store";
import { habitRepeatMenu } from "../core/habits";
import { todayYMD } from "../core/dates";
import { describeRepeat } from "../core/recur";
import { everyNDays, sameRepeat } from "../core/options";
import RepeatPicker from "../components/RepeatPicker";
import Sheet from "./Sheet";
import { closeSheet, topSheet, useSheet } from "./sheetStore";
import { IcoTrash } from "./icons";
import "../styles/mobile-shell.css";
import "../styles/mobile-sheet.css";
import "../styles/mobile-pages.css";

export function HabitSheetHost() {
  const top = useSheet((s) => topSheet(s.stack));
  const open = top?.kind === "habit";
  const id = top?.kind === "habit" ? top.id : undefined;
  return (
    <Sheet open={open} onClose={closeSheet} label={id ? "改这个习惯" : "加一个习惯"} className="msh-sheet mhs-sheet">
      {/* key 带上 id：从一个习惯切到另一个要重开一份草稿，否则上一个的名字会串过来 */}
      {open && <HabitBody key={id ?? "new"} id={id} />}
    </Sheet>
  );
}

function HabitBody({ id }: { id?: string }) {
  const tasks = useApp((s) => s.data.tasks);
  const habit = id ? aliveHabits({ tasks }).find((h) => h.id === id) ?? null : null;
  const editing = habit !== null;

  const [title, setTitle] = useState(habit?.title ?? "");
  const [rule, setRule] = useState<RepeatRule>(habit?.repeat ?? { kind: "daily", every: 1 });
  /** 周期那排底下摊开的是什么：「每隔几天…」的天数框 / 「自定义…」的天·周·月面板 / 都不摊 */
  const [panel, setPanel] = useState<null | "every" | "custom">(null);
  const [everyText, setEveryText] = useState(() =>
    String(habit?.repeat?.kind === "daily" && habit.repeat.every > 1 ? habit.repeat.every : 2),
  );
  /** 删除按两下：第一下把这一行换成「真的删掉」＋「取消」 */
  const [confirming, setConfirming] = useState(false);

  // 打开着的这个习惯被别处拿走了（另一台设备同步过来、或者撤销把它撤没了）：
  // 纸自己收掉，别对着一个已经不存在的东西继续编辑。
  // 放 effect 里而不是渲染中途调——渲染时改别的 store 会把 React 的一轮更新搅乱
  const gone = id !== undefined && !habit;
  useEffect(() => {
    if (gone) closeSheet();
  }, [gone]);
  if (gone) return null;

  const name = title.trim();

  function save() {
    if (!name) return;
    if (habit) {
      if (name !== habit.title) updateTask(habit.id, { title: name });
      if (!sameRepeat(rule, habit.repeat)) setHabitRepeat(habit.id, rule);
    } else {
      addHabit({ title: name, repeat: rule });
    }
    closeSheet();
  }

  // 周期选项跟任务的循环、桌面的习惯页同一份（core/habits.habitRepeatMenu ← core/options.repeatMenu，09-21 统一口径）：
  //   [现值] 每天 / 每个工作日 / 每周X / 每月X号 / 每隔几天… / 自定义…
  // 习惯没有日期，「每周X / 每月X号」按今天算；习惯天生重复，没有「不重复」。
  // 现有周期不在常用项里（每周一三五、每 2 天、每月 8 号……）挂在最前面亮着；
  // 点了别的再反悔，存着的那个也还在最前面（不然点歪一下就再也找不回来了）
  const today = todayYMD();
  const items = habitRepeatMenu(today, rule);
  const saved = habit?.repeat ?? null;
  const savedLost =
    saved && !sameRepeat(saved, rule) && !items.some((it) => it.kind === "rule" && sameRepeat(it.rule, saved));
  const everyRule = everyNDays(everyText);

  function choose(r: RepeatRule) {
    setRule(r);
    setPanel(null);
  }

  return (
    <div className="mhs-body">
      <div className="msheet-label">{editing ? "改这个习惯" : "加一个习惯"}</div>

      <div className="mhs-line">
        <input
          className="mhs-input"
          value={title}
          autoFocus={!editing}
          placeholder="比如「喝水 2L」"
          aria-label="习惯的名字"
          enterKeyHint="done"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            save();
          }}
        />
      </div>

      <div className="msheet-label">多久做一次</div>
      <div className="mhs-seg">
        <div className="msh-chips">
          {savedLost && saved && (
            <button key="saved" className="msh-opt" onClick={() => choose(saved)}>
              {describeRepeat(saved)}
            </button>
          )}
          {items.map((it) => {
            switch (it.kind) {
              case "current":
                return (
                  // 现值不在常用项里：挂在最前面、亮着，点它进自定义接着改（跟 RepeatOptions / 桌面 RepeatMenu 同一个手感）
                  <button key="current" className="msh-opt on" onClick={() => setPanel("custom")}>
                    ✓ {it.label}
                  </button>
                );
              case "rule":
                return (
                  <button key={`rule-${it.rule.kind}`} className={`msh-opt${it.on ? " on" : ""}`} onClick={() => choose(it.rule)}>
                    {it.label}
                  </button>
                );
              case "every":
              case "custom":
                // 展开中的那颗只描边（.open），实心 .on 只留给现在存的周期——跟 RepeatOptions 一样
                return (
                  <button
                    key={it.kind}
                    className={`msh-opt${panel === it.kind ? " open" : ""}`}
                    aria-expanded={panel === it.kind}
                    onClick={() => setPanel(panel === it.kind ? null : it.kind)}
                  >
                    {it.label}
                  </button>
                );
              default:
                return null;
            }
          })}
        </div>
      </div>

      {panel === "every" && (
        // 每 [n] 天 · 好：只收 1–365 的整数，不合法时「好」按不动
        <div className="mhs-seg mhs-every">
          每
          <input
            className="msh-field"
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            autoFocus
            value={everyText}
            aria-label="隔几天"
            enterKeyHint="done"
            onChange={(e) => setEveryText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (everyRule) choose(everyRule);
            }}
          />
          天
          <button className="msh-opt on" disabled={!everyRule} onClick={() => everyRule && choose(everyRule)}>
            好
          </button>
        </div>
      )}

      {panel === "custom" && (
        // 天 / 周 / 月勾选面板：跟桌面「自定义…」同一个面板，点「好」才改周期
        <div className="mhs-seg mhs-custom">
          <RepeatPicker value={rule} anchor={today} onDone={choose} onCancel={() => setPanel(null)} />
        </div>
      )}

      <div className="mhs-foot">
        <button className="mhs-go" disabled={!name} onClick={save}>
          {editing ? "保存" : "加上"}
        </button>
      </div>

      {editing && (confirming ? (
        <>
          <button
            className="mls-opt danger"
            onClick={() => {
              deleteTasks([habit!.id]);
              closeSheet();
            }}
          >
            <IcoTrash size={20} />
            真的删掉「{habit!.title || "这个习惯"}」
            <span className="why">进回收站，30 天内能捞回来</span>
          </button>
          <button className="mls-opt" onClick={() => setConfirming(false)}>
            取消
          </button>
        </>
      ) : (
        <button className="mls-opt danger" onClick={() => setConfirming(true)}>
          <IcoTrash size={20} />
          删除这个习惯
          <span className="why">进回收站，30 天内能捞回来</span>
        </button>
      ))}
    </div>
  );
}
