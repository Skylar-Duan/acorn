// 手机端的一行事（画板 ①②，v1.11.0）。桌面那份 TaskRow 一个字节都没动。
//
// 为什么另写一个而不是给 TaskRow 加分支：两边要的东西几乎不重叠——
// TaskRow 有 hover、右键、HTML5 拖拽、Ctrl/Shift 连选、行尾一串徽标、内嵌展开卡；
// 手机上这些要么没有（没鼠标就没 hover 和右键），要么被换掉了（卡片改成从底下抽出来的纸）。
// 把两套塞进一个组件，结果是桌面那条路上多十几个 isMobile 分支——桌面端「一个像素都不许变」
// 这条承诺就没人守得住了。
//
// 这一行只做四件事，都是手指能直接够到的：
//   · 点圆圈 = 完成（可撤销）
//   · 右滑 = 完成，松手即生效（底下那层绿的随进度渐显）
//   · 左滑 = 露出 推明天 / 放弃 / 删除；已了结的行只露一个删除
//   · 长按 = 底部动作单（取代桌面的右键菜单）；轻点 = 拉出任务详情那张纸
//
// 一条硬规矩：**一件事一行，绝不折行**。标题超长就省略号，不许把日期挤到第二行去。

import { useRef, useState } from "react";
import type { Subtask, Task } from "../core/model";
import { cmpYMD, formatDoneShort, formatShort, todayYMD } from "../core/dates";
import { isMobile } from "../core/platform";
// 长按的两个数跟侧栏拖动排序、桌面 TaskRow 共用一份：「按住多久算长按」全应用只该有一个口径
import { LONG_PRESS_MS, SLOP_PX } from "../core/touchSort";
import {
  completeTasks, deleteTasks, dropSubtask, dropTasks, postponeRows, postponeTasks,
  removeSubtask, rowDue, rowPriority, rowTime, uncompleteTask, updateSubtask,
} from "../core/store";
import { openSheet } from "./sheetStore";
import { useSwipeRow } from "./swipe";
import { IcoDone, IcoDrop, IcoPostpone, IcoTrash } from "./icons";
import "../styles/mobile.css";
import "../styles/mobile-shell.css";

/** 左滑露出来的那条动作条有多宽：三块 72px（.swipe-act 的宽度，定义在 mobile.css） */
const ACT_W = 72;
const LEFT_FULL = ACT_W * 3;
/** 母任务名在子任务行前面最多写几个字，多了整行会被它吃掉 */
const PARENT_MAX = 6;

/**
 * 长按弹出动作单之后，手指抬起来浏览器会补发一串鼠标兼容事件（mousedown → mouseup → click），
 * 那一下 click 会落在行上，把任务详情也一起拉出来。
 * 治本的做法跟桌面 TaskRow 一样：在**这一次 touchend 上 preventDefault**——
 * 被取消的 touchend 不再派发兼容鼠标事件，后果当场消失。
 * 只吃一次；5 秒兜底是防手指按住不放又没抬起来，别把监听永久留在 document 上。
 */
function eatNextTouchEnd() {
  const stop = (e: Event) => e.preventDefault();
  document.addEventListener("touchend", stop, { capture: true, once: true, passive: false });
  window.setTimeout(() => document.removeEventListener("touchend", stop, true), 5000);
}

/** 「往右滑一下」的示意演过没有。按 `acorn-` 前缀存 localStorage——
 *  清空本机数据时会被 persist.clearLocalPrefs 一并扫掉，那正好：新装的橡果本来就该再演一次 */
export const SWIPE_HINT_KEY = "acorn-swipe-hinted";

/**
 * 第一次进「今天」演一次的手势提示（画板 ① 的说明便签：**不做横条**，做一次性的轻提示）。
 *
 * 横条那种「右滑完成，左滑更多」的说明条，看过一次就是永久的噪音，而且它讲的是操作说明，
 * 不是给人看一眼就懂的东西。改成让第一行自己往右滑出去一点再回来——
 * 「这行能推」这件事被演出来，不用一个字。
 *
 * 读的同时就把标记写下去：不管这一次演没演完，都只演这一次。
 */
export function useSwipeHint(): boolean {
  const [on] = useState(() => {
    if (!isMobile) return false;
    try {
      if (localStorage.getItem(SWIPE_HINT_KEY) === "1") return false;
      localStorage.setItem(SWIPE_HINT_KEY, "1");
      return true;
    } catch {
      return false; // 存不了就干脆不演，总好过每次进来都演一遍
    }
  });
  return on;
}

export interface MobileRowProps {
  task: Task;
  /** 子任务行：勾选 / 日期 / 重要性都取子任务自己的（没设就继承母任务，口径走 store 的 row*） */
  sub?: Subtask | null;
  /** 右边写完成 / 放弃日期而不是截止日期（「已完成」视图用） */
  doneDate?: string | null;
  /** 第一次进「今天」时给第一行演一次「往右滑一下再回来」的示意（画板 ① 的说明便签） */
  hint?: boolean;
}

export default function MobileRow({ task, sub = null, doneDate, hint }: MobileRowProps) {
  const row = { task, sub };
  const due = rowDue(row);
  const dueTime = rowTime(row);
  const priority = rowPriority(row);
  const isDone = sub ? sub.done : task.done;
  const isDropped = sub ? !!sub.droppedAt : !!task.droppedAt;
  /** 了结了的行：做完的和不做了的，两种手势都换一套 */
  const settled = isDone || isDropped;
  const today = todayYMD();
  const overdue = !settled && !!due && cmpYMD(due, today) < 0;

  /** 圆圈和右滑共用这一个：了结了的行是「放回未完成」，没了结的是「完成」。
   *  完成走 completeTasks（不是 completeTask）——它带那条可撤销的 toast，
   *  手滑勾错一件事时有路可退，这正是「松手即生效」敢这么干脆的前提 */
  function toggleDone() {
    if (isDropped) {
      if (sub) dropSubtask(task.id, sub.id, false);
      else dropTasks([task.id], false);
      return;
    }
    if (sub) {
      updateSubtask(task.id, sub.id, { done: !sub.done });
      return;
    }
    if (task.done) {
      uncompleteTask(task.id);
      return;
    }
    completeTasks([task.id]);
  }

  const swipe = useSwipeRow({
    onRight: toggleDone,
    // 了结了的行左边只有一个「删除」，动作条就窄成一块
    leftWidth: settled ? ACT_W : LEFT_FULL,
  });

  // 长按：跟桌面同一套判定思路（按住够久 + 期间别挪），只是弹的东西换成了底部动作单
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  /** 长按刚弹过单子，抬手带出来的那一下 click 不算「点开这件事」 */
  const sheetJustOpened = useRef(false);
  const [pressing, setPressing] = useState(false);

  function clearPress() {
    if (press.current) {
      clearTimeout(press.current.timer);
      press.current = null;
    }
    setPressing(false);
  }

  function onPointerDown(e: React.PointerEvent) {
    sheetJustOpened.current = false;
    swipe.bind.onPointerDown(e);
    // 有鼠标的设备不做长按：桌面窗口拖窄时仍然是桌面，那儿有右键
    if (e.pointerType === "mouse") return;
    const x = e.clientX;
    const y = e.clientY;
    const timer = window.setTimeout(() => {
      press.current = null;
      setPressing(false);
      sheetJustOpened.current = true;
      openSheet({ kind: "actions", taskId: task.id, subId: sub?.id });
      eatNextTouchEnd();
    }, LONG_PRESS_MS);
    press.current = { timer, x, y };
    setPressing(true);
  }

  function onPointerMove(e: React.PointerEvent) {
    const p = press.current;
    // 按住之后手指挪起来了 = 在滑这一行或在滚列表，长按作废（滑动那一路照常走 swipe）
    if (p && (Math.abs(e.clientX - p.x) > SLOP_PX || Math.abs(e.clientY - p.y) > SLOP_PX)) clearPress();
    swipe.bind.onPointerMove(e);
  }

  function onPointerUp(e: React.PointerEvent) {
    clearPress();
    swipe.bind.onPointerUp(e);
  }

  function onPointerCancel(e: React.PointerEvent) {
    clearPress();
    swipe.bind.onPointerCancel(e);
  }

  function onClick() {
    if (sheetJustOpened.current) {
      sheetJustOpened.current = false;
      return;
    }
    openSheet({ kind: "task", taskId: task.id });
  }

  /** 左滑那条动作条上的按钮：做完事情顺手把动作条收回去 */
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
    swipe.close();
  };

  const title = sub ? sub.title : task.title;
  const parent = task.title || "（未命名）";
  const when = doneDate
    ? `${isDropped ? "放弃于" : "完成于"} ${formatDoneShort(doneDate)}`
    : due
      ? `${formatShort(due)}${dueTime ? ` ${dueTime}` : ""}`
      : "";

  return (
    <div
      // .shifted：行让开了就给它一点投影，看着像浮起来的一张纸，而不是同一张纸被涂了色
      className={`swipe-wrap${swipe.state === "dragging" ? " dragging" : ""}${swipe.dx !== 0 ? " shifted" : ""}${hint ? " mrow-hint" : ""}`}
      style={{ ["--dx" as string]: `${swipe.dx}px` }}
    >
      {/* 右滑那层：整行让开之后露出来的绿色。字和勾跟着进度渐显，还没拉够的时候是暗的，
          「再拉一点就生效了」这句话不用写出来 */}
      <div className="swipe-under right" aria-hidden>
        <div className="swipe-done-mark" style={{ ["--p" as string]: swipe.rightProgress }}>
          <IcoDone size={22} />
          {settled ? "标记未完成" : "完成"}
        </div>
      </div>

      {/* 左滑那层：三个动作。已了结的行只留删除——一件做完的事没有「推到明天」这回事 */}
      <div className="swipe-under left">
        {!settled && (
          <>
            <button
              className="swipe-act postpone"
              onClick={act(() => (sub ? postponeRows([{ task, sub }]) : postponeTasks([task.id])))}
            >
              <IcoPostpone />
              推明天
            </button>
            <button
              className="swipe-act drop"
              onClick={act(() => (sub ? dropSubtask(task.id, sub.id, true) : dropTasks([task.id], true)))}
            >
              <IcoDrop />
              放弃
            </button>
          </>
        )}
        <button
          className="swipe-act delete"
          onClick={act(() => (sub ? removeSubtask(task.id, sub.id) : deleteTasks([task.id])))}
        >
          <IcoTrash />
          删除
        </button>
      </div>

      <div
        className={`swipe-body mrow${settled ? " settled" : ""}${pressing ? " pressing" : ""}`}
        data-task-id={task.id}
        onClick={onClick}
        onClickCapture={swipe.bind.onClickCapture}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <span className={`mrow-bar p${priority}`} />
        <button
          className={`mrow-cb${isDone ? " done" : ""}`}
          aria-label={isDropped ? "放回未完成" : isDone ? "标记未完成" : "完成"}
          onClick={(e) => {
            e.stopPropagation();
            toggleDone();
          }}
        />
        <span className="mrow-title">
          {sub && (
            <span className="mrow-parent">
              {parent.length > PARENT_MAX ? `${parent.slice(0, PARENT_MAX)}…` : parent} ›
            </span>
          )}
          {title || "（未命名）"}
        </span>
        {when && <span className={`mrow-when${overdue ? " warn" : ""}`}>{when}</span>}
      </div>
    </div>
  );
}
