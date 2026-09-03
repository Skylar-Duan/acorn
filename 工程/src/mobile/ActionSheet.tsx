// 长按一行弹出来的动作单（画板 ②，v1.11.0）——手机上取代桌面右键菜单的那张纸。
//
// 每一个动作都调**现有的 store 函数**，跟 ContextMenu 一一对应（完成 / 放弃 / 推到明天 /
// 安排日期 / 重要性 / 移到清单 / 需求方 / 复制标题 / 删除）。手机端绝不新造一套语义：
// 同一个词在两端干不一样的事，是这类跨端应用最容易崩掉信任的地方。
//
// 长按到的是一条**子任务**行时（subId 有值），作用对象就是那条子任务本身，绝不打到母任务上——
// 跟桌面 ContextMenu 的 SubRowMenu 同一个口径。子任务没有「归哪张清单 / 谁的需求」这回事
// （那是任务级的属性），所以那两格不出现。
//
// 「安排日期」的候选日一律走 core/dates.duePresets，不在这儿再写一份「明天 / 下周一」——
// README 上「安排日期只有一套规矩」这句承诺，得是全仓每个入口都算数。

import { useState } from "react";
import type { ReactNode } from "react";
import type { Priority } from "../core/model";
import { duePresets, todayYMD } from "../core/dates";
import {
  addTasksWho, allWho, completeTasks, deleteTasks, dropSubtask, dropTasks, postponeRows,
  postponeTasks, removeSubtask, removeTaskWho, setTasksDue, setTasksList, showToast,
  uncompleteTask, updateSubtask, updateTask, useApp,
} from "../core/store";
import DateField from "../components/DateField";
import Sheet from "./Sheet";
import { closeSheet, topSheet, useSheet } from "./sheetStore";
import { IcoCalendar, IcoCopy, IcoDone, IcoDrop, IcoFlag, IcoPlan, IcoPostpone, IcoTrash, IcoWho } from "./icons";
import "../styles/mobile-shell.css";

const PRIORITY_LABEL: Record<Priority, string> = { 0: "无", 1: "低", 2: "中", 3: "高" };
const PRIORITIES: Priority[] = [3, 2, 1, 0];

type Pane = "date" | "priority" | "list" | "who" | null;

export function ActionSheetHost() {
  const top = useSheet((s) => topSheet(s.stack));
  const open = top?.kind === "actions";
  return (
    <Sheet open={open} onClose={closeSheet} label="这件事能做什么">
      {/* key 让每次长按都重挂一遍：上一次展开过的那一格不该留到下一件事身上 */}
      {open && top.kind === "actions" && (
        <ActionSheetBody key={`${top.taskId}/${top.subId ?? ""}`} taskId={top.taskId} subId={top.subId} />
      )}
    </Sheet>
  );
}

function ActionSheetBody({ taskId, subId }: { taskId: string; subId?: string }) {
  const data = useApp((s) => s.data);
  const [pane, setPane] = useState<Pane>(null);

  const task = data.tasks.find((t) => t.id === taskId && !t.deletedAt);
  const sub = subId ? task?.subtasks.find((s) => s.id === subId) : null;
  // 单子开着的时候这件事没了（撤销、云同步换了一份数据）：收掉，别对着一个空对象画界面
  if (!task || (subId && !sub)) return null;

  const today = todayYMD();
  const lists = [...data.lists].sort((a, b) => a.order - b.order);
  const whoAll = allWho(data);
  const isDone = sub ? sub.done : task.done;
  const isDropped = sub ? !!sub.droppedAt : !!task.droppedAt;
  const curDue = (sub ? sub.due : task.due) ?? "";
  const curPriority: Priority | null = sub ? (sub.priority ?? null) : task.priority;

  /** 做完一个动作就把单子收了——这张纸是为「一下就好」存在的，不是让人在里面待着的 */
  const run = (fn: () => void) => () => {
    fn();
    closeSheet();
  };

  /** 安排日期。子任务只改自己那一条，母任务走 setTasksDue（它会顺手管顺延计数和提醒）。
   *  **不收单子**：日期框那条路上收单子等于把框拆掉，用户敲到一半的日子会全落空
   *  （tests/commit-guards.ts 钉着这条，全仓四个日期框都栽过） */
  const applyDue = (ymd: string) => {
    if (sub) updateSubtask(task.id, sub.id, { due: ymd });
    else setTasksDue([task.id], ymd);
  };

  const applyPriority = (p: Priority) => {
    if (sub) updateSubtask(task.id, sub.id, { priority: p });
    else updateTask(task.id, { priority: p });
  };

  const tile = (id: Exclude<Pane, null>, label: string, icon: ReactNode) => (
    <button
      className={`msheet-tile${pane === id ? " on" : ""}`}
      onClick={() => setPane(pane === id ? null : id)}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div>
      <div className="msheet-title">{(sub ? sub.title : task.title) || "（未命名）"}</div>

      <div className={`msheet-grid${sub ? " two" : ""}`}>
        {tile("date", "安排日期", <IcoCalendar />)}
        {tile("priority", "重要性", <IcoFlag />)}
        {/* 清单和需求方是**任务**的属性，长按的是子任务时这两格不出现 */}
        {!sub && tile("list", "换清单", <IcoPlan size={22} />)}
        {!sub && tile("who", "需求方", <IcoWho />)}
      </div>

      {pane === "date" && (
        <div className="msheet-pane">
          {duePresets(today).map((p) => (
            <button
              key={p.key}
              className={`msheet-chip${curDue === p.ymd ? " on" : ""}`}
              onClick={() => applyDue(p.ymd)}
            >
              {p.label}
            </button>
          ))}
          {/* 「选个日子…」用的是全仓唯一那个日期框（DateField）：草稿 / 合理性闸 / 去抖
              三件套都在它里面，手机上键盘敲年份同样会连发好几个合法日期 */}
          <label className="msheet-chip">
            选个日子
            <DateField className="msheet-date" value={curDue} onCommit={applyDue} />
          </label>
          <button
            className="msheet-chip"
            onClick={() => (sub ? updateSubtask(task.id, sub.id, { due: null, dueTime: null }) : setTasksDue([task.id], null))}
          >
            {sub ? "继承母任务" : "清除日期"}
          </button>
        </div>
      )}

      {pane === "priority" && (
        <div className="msheet-pane">
          {PRIORITIES.map((p) => (
            <button
              key={p}
              className={`msheet-chip${curPriority === p ? " on" : ""}`}
              onClick={() => applyPriority(p)}
            >
              <span className={`mrow-bar p${p}`} />
              {PRIORITY_LABEL[p]}
            </button>
          ))}
          {sub && (
            <button className="msheet-chip" onClick={() => updateSubtask(task.id, sub.id, { priority: null })}>
              继承母任务
            </button>
          )}
        </div>
      )}

      {pane === "list" && !sub && (
        <div className="msheet-pane">
          <button
            className={`msheet-chip${task.listId ? "" : " on"}`}
            onClick={() => setTasksList([task.id], null)}
          >
            <span className="msheet-dot" style={{ background: "var(--ink-3)" }} />
            移出清单
          </button>
          {lists.map((l) => (
            <button
              key={l.id}
              className={`msheet-chip${task.listId === l.id ? " on" : ""}`}
              onClick={() => setTasksList([task.id], l.id)}
            >
              <span className="msheet-dot" style={{ background: `var(--list-${l.color})` }} />
              {l.name}
            </button>
          ))}
        </div>
      )}

      {pane === "who" && !sub && (
        <div className="msheet-pane">
          {whoAll.length === 0 && <span className="msheet-title">还没有记过需求方。在电脑上或详情里加一个。</span>}
          {whoAll.map(({ who }) => {
            const on = task.who.includes(who);
            return (
              <button
                key={who}
                className={`msheet-chip${on ? " on" : ""}`}
                // 多选：点一下加上、再点一下去掉，跟任务卡上那排徽标同一个意思
                onClick={() => (on ? removeTaskWho(task.id, who) : addTasksWho([task.id], who))}
              >
                {who}
              </button>
            );
          })}
        </div>
      )}

      <div className="msheet-acts">
        <button
          className="msheet-act"
          onClick={run(() => {
            if (sub) updateSubtask(task.id, sub.id, { done: !sub.done });
            else if (isDone) uncompleteTask(task.id);
            else completeTasks([task.id]);
          })}
        >
          <IcoDone size={18} /> {isDone ? "标记未完成" : "完成"}
        </button>
        <button
          className="msheet-act"
          onClick={run(() => (sub ? dropSubtask(task.id, sub.id, !isDropped) : dropTasks([task.id], !isDropped)))}
        >
          <IcoDrop size={18} /> {isDropped ? "取消放弃" : "放弃"}
        </button>
        <button
          className="msheet-act"
          onClick={run(() => (sub ? postponeRows([{ task, sub }]) : postponeTasks([task.id])))}
        >
          <IcoPostpone size={18} /> 推到明天
        </button>
        <button
          className="msheet-act"
          onClick={run(() => {
            void navigator.clipboard.writeText((sub ? sub.title : task.title) || "").then(
              () => showToast("已复制", false),
              () => showToast("复制失败", false),
            );
          })}
        >
          <IcoCopy size={18} /> 复制标题
        </button>
        <button
          className="msheet-act danger"
          onClick={run(() => (sub ? removeSubtask(task.id, sub.id) : deleteTasks([task.id])))}
        >
          <IcoTrash size={18} /> {sub ? "删除子任务" : "删除"}
        </button>
      </div>
    </div>
  );
}
