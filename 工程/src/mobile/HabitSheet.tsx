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
import { describeHabitRule } from "../core/habits";
import { RULE_CHOICES } from "../views/Habits";
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
      if (JSON.stringify(rule) !== JSON.stringify(habit.repeat)) setHabitRepeat(habit.id, rule);
    } else {
      addHabit({ title: name, repeat: rule });
    }
    closeSheet();
  }

  // 现有周期不在六个预设里（比如从任务转过来的「每月 8 号」）也要看得见、也不许被悄悄改掉
  const extra =
    habit && !RULE_CHOICES.some((c) => JSON.stringify(c.rule) === JSON.stringify(habit.repeat))
      ? { label: describeHabitRule(habit), rule: habit.repeat as RepeatRule }
      : null;
  const choices = extra ? [extra, ...RULE_CHOICES] : RULE_CHOICES;

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
          {choices.map((c) => (
            <button
              key={c.label}
              className={`msh-opt${JSON.stringify(rule) === JSON.stringify(c.rule) ? " on" : ""}`}
              onClick={() => setRule(c.rule)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

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
