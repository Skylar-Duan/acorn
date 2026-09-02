// 任务行：一行看清一件事。点击行展开为 TaskCard；勾选有停留动画。
// sub 非 null 时是「子任务行」——显示 母任务 › 子任务，勾选只勾子任务。
// 有未完成子任务的任务在日期/总览视图里被分拆成若干子任务行（母任务行收起），
// 日期/重要性没单独设的子任务显示的是继承自母任务的那份（口径统一走 store 的 row* 系列）。
import { useRef, useState } from "react";
import type { Subtask, Task } from "../core/model";
import { doneRowMs } from "../core/motion";
import { formatShort, formatDoneShort, doneShortIsWide, todayYMD, cmpYMD } from "../core/dates";
import { describeRepeat } from "../core/recur";
// 长按的两个数跟侧栏拖动排序共用一份：手机上「按住多久算长按」只该有一个口径
import { LONG_PRESS_MS, SLOP_PX } from "../core/touchSort";
import {
  completeTask, uncompleteTask, expandTask, useApp, setSelection,
  updateSubtask, openCtxMenu, rowDue, rowTime, rowPriority, dropTasks, dropSubtask,
} from "../core/store";

export function WhoBadge({ who }: { who: string }) {
  return (
    <span className="who-badge" title={`需求方：${who}`}>
      <span className="avatar">{who.slice(0, 1)}</span>
      {who}
    </span>
  );
}

/**
 * 长按弹出菜单之后，手指抬起来浏览器会补发一串**鼠标兼容事件**（mousedown → mouseup → click）。
 * 后果有两条，都是实测出来的：
 *   · ContextMenu 判「关掉」用的是 document 上的 mousedown，那一下落在行上、不在菜单里，
 *     于是菜单刚弹出来就被自己关掉（实测：抬手后约 200ms 消失）；
 *   · 接着那一下 click 会走 onRowClick，把任务卡也展开。
 *
 * 治本的做法是在**这一次 touchend 上 preventDefault**：按 Touch Events 的规矩，
 * 被取消的 touchend 不再派发那串兼容鼠标事件，所以两个后果一起没了。
 * 不用「在 document 上抢先吞 mousedown」那招——ContextMenu 的监听也挂在 document 上，
 * stopPropagation 管不到同一个节点上的别的监听，能不能拦住全看谁先注册，太脆。
 *
 * 只吃一次：菜单弹出来的时候手指还按着，下一次 touchend 一定就是这一press 的抬手。
 * 5 秒的兜底删除是防手指按住不放又没抬起来，别把监听永久留在 document 上。
 */
function eatNextTouchEnd() {
  const stop = (e: Event) => e.preventDefault();
  document.addEventListener("touchend", stop, { capture: true, once: true, passive: false });
  window.setTimeout(() => document.removeEventListener("touchend", stop, true), 5000);
}

export interface TaskRowProps {
  task: Task;
  /** 子任务行：勾选/日期/优先级都取子任务自己的 */
  sub?: Subtask | null;
  /** 本视图内可见任务的有序 id 列表（shift 连选用） */
  orderedIds: string[];
  /** 隐藏所属清单标签（清单视图里冗余） */
  hideList?: boolean;
  /** 紧挨着上一行、属于同一件事的子任务行：需求方/清单只由这一束的头一行交代，不逐行重复 */
  bundled?: boolean;
  /** 完成后是否播放淡出（今天/清单视图 true；已完成视图 false） */
  fadeOnDone?: boolean;
  /** 子任务链的头一行：给它一个小三角，收起时后面几条并成 +N。undefined = 这行不是链头。
   *  more = 现在被折起来的条数（摊开时是 0）；total = 这条链除自己外一共几条（两态都有值） */
  chain?: { folded: boolean; more: number; total: number; onToggle: () => void };
  /** 「已完成」视图用：右边显示完成日期而不是截止日期（都做完了，还看截止日没意义） */
  doneDate?: string | null;
  /** 这行让位：收成 0 高。两种情况——它摊成任务卡了（B1），或者被「只看下一步」收起来了（B5）。
   *  不是从树上摘掉而是收起来，收/放才都有动画 */
  collapsed?: boolean;
  /** 行尾那块信息区画多少（v1.9.1）。用户原话：「归类、@ 统一都隐藏」「能够显示 ddl 和重要性」。
   *   · "lean"（默认，全局口径）—— 不画清单色点、需求方徽标、#标签。
   *     行首的重要性小旗和右边的日期都留着，那两样是用户点名要的。
   *   · "date" —— 右边**只剩一格日期**（已完成视图 / 今天视图的「已完成 N」那组）。
   *     用户原话：「已完成界面右侧太乱，只留下完成日期，不是 ddl 日期，其他的展开自然能看到」。
   *   · "full" —— v1.9.0 以前的老样子，全画。**留着不是摆设**：这是一条退路，
   *     哪天觉得清单色点还是得有，改回来只要在调用处传一个词，不用把代码再抄一遍。 */
  tail?: "full" | "lean" | "date";
}

export default function TaskRow({ task, sub = null, orderedIds, hideList, bundled, fadeOnDone = true, chain, doneDate, collapsed, tail = "lean" }: TaskRowProps) {
  const lists = useApp((s) => s.data.lists);
  const selected = useApp((s) => s.ui.selectedIds.includes(task.id));
  const selectedIds = useApp((s) => s.ui.selectedIds);
  const [leaving, setLeaving] = useState(false);
  const anchor = useRef<string | null>(null);

  const list = task.listId ? lists.find((l) => l.id === task.listId) : null;
  const today = todayYMD();
  const row = { task, sub };
  const due = rowDue(row);
  const dueTime = rowTime(row);
  const priority = rowPriority(row);
  // 子任务没单独设日期/重要性时，这行显示的是母任务那份——改母任务会连带动，鼠标停上去说明白
  const dueInherited = !!sub && sub.due == null && task.due != null;
  const prioInherited = !!sub && sub.priority == null;
  const isDone = sub ? sub.done : task.done;
  // 放弃：行上只是「删除线 + 一个灰标签」，圈圈永远不制造放弃。
  // 唯一的例外在 onCheck 里：本来就是放弃的那行，点圆圈 = 放回未完成（取消放弃）
  const isDropped = sub ? !!sub.droppedAt : !!task.droppedAt;
  const overdue = !isDone && !isDropped && !!due && cmpYMD(due, today) < 0;
  // 「N/total」是进度，放弃掉的那几步既不算做完也不该占分母——不然一件事永远差那么一两条
  const counted = task.subtasks.filter((s) => !s.droppedAt);
  const subDone = counted.filter((s) => s.done).length;
  // 「了结」= 做完了 **或者** 不做了。顺延徽标原来的判据是 `!task.done`，
  // 而放弃的那件事 done 仍然是 false，于是「顺延×4」照样跟去「已完成」视图里站着——
  // 一件已经不做了的事没有「又往后拖了几次」这回事
  const settled = task.done || !!task.droppedAt;
  // 行尾画多少（见 tail 那条 prop 的注释）
  const leanTail = tail !== "full";
  const dateOnlyTail = tail === "date";

  function onCheck(e: React.MouseEvent) {
    e.stopPropagation();
    if (leaving) return; // 完成动画播放中，重复点击不能把循环任务推进两轮
    // 这一行本来就是「放弃的」：圈圈的意思是**放回未完成**，跟「已完成」视图表头那句
    // 「点圆圈可以放回未完成」对齐。绝不是把它标成完成——那会把放弃的并进完成数，
    // 完成率当场虚高，正是这个功能最要防的那件事。
    // 时刻一律交给 store 盖/清（子任务走 applySubPatch 的互斥），调用点不自己算
    if (isDropped) {
      if (sub) dropSubtask(task.id, sub.id, false);
      else dropTasks([task.id], false);
      return;
    }
    if (sub) {
      // 完成时刻由 store.applySubPatch 统一盖/清（这里走的是 updateSubtask，不经 toggleSubtask），
      // 所以下面几处都不用、也不该自己算时间戳
      // 用幂等置位而非 toggle：动画窗口内用户可能已在展开卡片里改过状态
      if (sub.done) {
        updateSubtask(task.id, sub.id, { done: false });
        return;
      }
      if (fadeOnDone) {
        setLeaving(true);
        setTimeout(() => {
          updateSubtask(task.id, sub.id, { done: true });
          setLeaving(false);
        }, doneRowMs());
      } else {
        updateSubtask(task.id, sub.id, { done: true });
      }
      return;
    }
    if (task.done) {
      uncompleteTask(task.id);
      return;
    }
    if (fadeOnDone) {
      setLeaving(true);
      // 动画演完再真正完成（store 变更会让行从列表消失）。
      // 等多久由 app.css 的 .row-slot.leaving 说了算，这边只是读它（B2），不另写一个数
      setTimeout(() => {
        completeTask(task.id);
        setLeaving(false);
      }, doneRowMs());
    } else {
      completeTask(task.id);
    }
  }

  // 多选按「件」不按「行」：分拆出来的子任务行也能 Ctrl/Shift 连选，选中的是它那件母任务，
  // 否则一旦任务都有子任务、母任务行全收起，多选就整个用不了了。
  // 独立成一个函数是给折叠热区用的：**每加一块新热区都得先问它一句**，
  // 不然行上多一块「Ctrl 点了没反应」的地方，连选就被啃掉一口。命中并处理掉了才返回 true
  function multiSelect(e: React.MouseEvent): boolean {
    if (e.ctrlKey || e.metaKey) {
      const next = selected ? selectedIds.filter((i) => i !== task.id) : [...selectedIds, task.id];
      anchor.current = task.id;
      setSelection(next);
      return true;
    }
    if (e.shiftKey && selectedIds.length) {
      const last = anchor.current ?? selectedIds[selectedIds.length - 1];
      const a = orderedIds.indexOf(last);
      const b = orderedIds.indexOf(task.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelection(orderedIds.slice(lo, hi + 1));
        return true;
      }
    }
    return false;
  }

  function onRowClick(e: React.MouseEvent) {
    // 长按刚弹过菜单：抬手带出来的这一下 click 不算「点开这件事」
    if (menuJustOpened.current) {
      menuJustOpened.current = false;
      return;
    }
    if (multiSelect(e)) return;
    anchor.current = task.id;
    expandTask(task.id);
  }

  // 收/摊子任务链的热区（小三角、「母任务 › 」前缀、行尾的 +N/−N 徽标）共用这一个。
  // 绝不能把「整行点击」改成折叠：那会顶掉打开任务卡的唯一鼠标入口，还会砸掉上面那套连选
  function onFoldHit(e: React.MouseEvent) {
    e.stopPropagation();
    if (multiSelect(e)) return;
    chain?.onToggle();
  }

  /** 在 (x, y) 打开这一行的菜单。右键和长按共用一份，菜单内容永远一致 */
  function openMenuAt(x: number, y: number) {
    if (sub) {
      // 子任务行：菜单作用于子任务本身，不能打到整个母任务上
      openCtxMenu(x, y, [task.id], { taskId: task.id, subId: sub.id });
      return;
    }
    // 右键落在多选集合上时保留多选，否则只对当前行
    const ids = selected && selectedIds.length > 1 ? selectedIds : [task.id];
    openCtxMenu(x, y, ids);
  }

  function onCtx(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    openMenuAt(e.clientX, e.clientY);
  }

  // 手机上没有右键。「放弃 / 移到清单 / 需求方 / 复制标题 / 推到明天」这些动作
  // 原来只有右键菜单一条路，安卓 WebView 的原生长按到底发不发 contextmenu 靠不住
  // （body 上还有一条 user-select: none 会影响它），所以自己接一份长按。
  // 时长与「按下就滑算滚动」的阈值跟侧栏排序共用 touchSort 那套常量，不另定一个数
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  // 长按弹出菜单之后，抬手那一下的 click 要吞掉，否则菜单一出来任务卡也跟着展开
  const menuJustOpened = useRef(false);

  function clearPress() {
    if (press.current) {
      clearTimeout(press.current.timer);
      press.current = null;
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    // 新的一次按下 = 上一次长按的残留作废。
    // 这一句是防「长按弹过菜单之后，这一行的下一次轻点被白白吞掉」——
    // 正常情况下 touchend 被 eatNextTouchEnd 取消了，那一下 click 压根不会来，
    // 标记就一直挂着；万一哪个 WebView 不认 preventDefault，也只影响紧跟着的那一下
    menuJustOpened.current = false;
    // 有鼠标的设备照旧走右键，不跟拖拽和框选抢
    if (e.pointerType === "mouse") return;
    const x = e.clientX;
    const y = e.clientY;
    const timer = window.setTimeout(() => {
      press.current = null;
      menuJustOpened.current = true;
      openMenuAt(x, y);
      eatNextTouchEnd();
    }, LONG_PRESS_MS);
    press.current = { timer, x, y };
  }

  function onPointerMove(e: React.PointerEvent) {
    const p = press.current;
    if (!p) return;
    // 按住之后手指挪起来了 = 在滚列表，整个手势作废
    if (Math.abs(e.clientX - p.x) > SLOP_PX || Math.abs(e.clientY - p.y) > SLOP_PX) clearPress();
  }

  const willDone = isDone || leaving;

  return (
    // 外面这层只管高度（见 app.css 的 .row-slot）：行让位、行收走都在它身上做，
    // 行本身一个属性都没改，hover / 拖拽 / 右键那些老规矩原样还在
    <div className={`row-slot${leaving ? " leaving" : ""}${collapsed ? " shut" : ""}`}>
    <div
      className={`task-row${willDone ? " done-row" : ""}${isDropped ? " dropped-row" : ""}${selected ? " selected" : ""}`}
      onClick={onRowClick}
      onContextMenu={onCtx}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onPointerLeave={clearPress}
      draggable
      onDragStart={(e) => {
        // 子任务行也能拖：额外带上子任务身份，拖到「今天/计划」时只挪这一条，
        // 拖到清单/需求方仍然是整件事换归属（归属本来就是任务级的）
        if (sub) {
          e.dataTransfer.setData("text/acorn-sub", `${task.id}:${sub.id}`);
          e.dataTransfer.setData("text/acorn-task", task.id);
          e.dataTransfer.effectAllowed = "move";
          return;
        }
        // 拖的是多选中的一行 → 整组一起走
        const ids = selected && selectedIds.length > 1 ? selectedIds : [task.id];
        e.dataTransfer.setData("text/acorn-task", ids.join(","));
        e.dataTransfer.effectAllowed = "move";
      }}
      data-task-id={task.id}
    >
      {chain ? (
        <button
          className={`chain-caret${chain.folded ? " folded" : ""}`}
          title={chain.folded ? "摊开这件事剩下的子任务（→）" : "只看下一步（←）"}
          aria-expanded={!chain.folded}
          onClick={onFoldHit}
        >
          ▾
        </button>
      ) : (
        <span className="chain-caret ghost" />
      )}
      <span className={`flag p${priority}`} title={prioInherited ? "重要性继承自母任务" : undefined} />
      <button
        className={`cb${willDone ? " done" : ""}`}
        onClick={onCheck}
        title={isDropped ? "放回未完成（取消放弃）" : isDone ? "标记未完成" : "完成"}
      />
      {sub ? (
        <span className="title">
          {/* 链头行上这句「母任务 › 」兼任第二个折叠热区：它够宽、天生代表母任务，
              跟「点子任务标题 = 打开这件事的卡片」不打架。不是链头的行上只是一段灰字。
              保持 <span> 而不是 <button>：标题那一行有 text-overflow: ellipsis，
              换成按钮会在里面开一个新的行内块，长标题就不省略号而是被硬裁。
              键盘那一路走 App.tsx 的 ←/→ 和上面那个真按钮（带 aria-expanded） */}
          <span
            className={`chain-parent${chain ? " hit" : ""}`}
            title={chain ? (chain.folded ? "摊开这件事剩下的子任务（→）" : "只看下一步（←）") : undefined}
            onClick={chain ? onFoldHit : undefined}
          >
            {task.title || "（未命名）"}
          </span>
          {/* 「›」单独一个 span，子任务名也包一层（v1.10.0）。
              原来「›」跟在母任务名里、子任务名是裸文本节点，后果有两条：
              ① 裸文本是匿名 flex 项，拿不到 text-overflow，窄屏下省略号全落在母任务名上，
                 三行子任务行长得一模一样（都是「把上个季度的渠道复盘材料…」）；
              ② 母任务名被省略时「›」跟着一起被吃掉，看不出这是一条子任务。
              两段各自省略的规则在 app.css 的窄屏块里（桌面照旧一行到底，一个像素没动） */}
          <span className="chain-sep"> › </span>
          <span className="chain-self">{sub.title || "（未命名）"}</span>
        </span>
      ) : (
        <span className="title">{task.title || "（未命名）"}</span>
      )}
      {isDropped && (
        <span className="drop-tag" title="这件事标记了放弃。右键可以取消放弃">
          已放弃
        </span>
      )}
      {/* .meta 整块吞掉点击（防止点日期/清单标签误开卡片）。这句是全块的规矩，
          绝不为了让下面那个徽标可点就把它拆掉——拆了整条右侧信息区都会变成「点了就开卡」。
          徽标自己带 onClick，本来就跑在这句之前 */}
      <span className="meta" onClick={(e) => e.stopPropagation()}>
        {chain && (chain.folded ? chain.more > 0 : chain.total > 0) && (
          // 收起时「+N」= 摊开，摊开时「−N」= 收起。两个方向都得有个可点物，
          // 否则只有 +N 一个入口，收回去只能回头去找行首那个小三角
          <button
            className={`chain-more${chain.folded ? "" : " plain"}`}
            title={
              chain.folded
                ? `这件事后面还有 ${chain.more} 条待办，点开摊开（→）`
                : `把这件事剩下的 ${chain.total} 条收起来，只看下一步（←）`
            }
            onClick={onFoldHit}
          >
            {chain.folded ? `+${chain.more}` : `−${chain.total}`}
          </button>
        )}
        {/* 归类（清单色点）、@（需求方徽标）、#标签：v1.9.1 起列表行上一律不画（tail="lean"）。
            用户原话「归类、@ 统一都隐藏」——这三样都是**这件事属于哪一堆**，
            点开卡片一眼就看得到，逐行重复只是把右边挤满。留 tail="full" 是退路，不是死代码 */}
        {!leanTail && !bundled && task.who.map((w) => <WhoBadge key={w} who={w} />)}
        {!leanTail && !sub && task.tags.map((t) => (
          <span key={t}># {t}</span>
        ))}
        {!leanTail && !hideList && !bundled && list && (
          <span className="list-tag">
            <span className="dot" style={{ width: 7, height: 7, borderRadius: 99, background: `var(--list-${list.color})`, display: "inline-block" }} />
            {list.name}
          </span>
        )}
        {!dateOnlyTail && !sub && counted.length > 0 && (
          <span title={counted.length === task.subtasks.length ? undefined : "放弃的那几步不算进这个进度"}>
            {subDone}/{counted.length}
          </span>
        )}
        {!dateOnlyTail && !sub && task.repeat && <span title={describeRepeat(task.repeat)}>↻</span>}
        {/* 判据是「还没了结」不是「还没做完」：放弃掉的那件事 done 一直是 false，
            按老写法「顺延×4」会跟着它一起出现在「已完成」视图里 */}
        {!dateOnlyTail && !sub && task.postponeCount >= 2 && !settled && (
          <span className="warn" title={`已顺延 ${task.postponeCount} 次`}>
            顺延×{task.postponeCount}
          </span>
        )}
        {doneDate ? (
          // 「已完成」视图里同一个位置写两种事：做完的写完成日，放弃的写放弃日。
          // 别把放弃的写成「完成」，那正是这个功能要避免的谎。
          // .when 是那条固定右列（88px 左对齐），所有行的「完成于」从同一个 x 起笔；
          // 超过一年的那一档要多写两位年，塞不下，单独给它 .wide 放开
          <span
            className={`when${doneShortIsWide(doneDate) ? " wide" : ""}`}
            title={`${isDropped ? "放弃于" : "完成于"} ${doneDate}`}
          >
            {isDropped ? "放弃于" : "完成于"} {formatDoneShort(doneDate)}
          </span>
        ) : (
          // tail="date" 时**连截止日期都不画**：用户点名「只留下完成日期，不是 ddl 日期」。
          // 走到这儿只剩一种情况——完成日是猜的（老子任务没有完成时刻），
          // 那就宁可空着，也不能拿截止日冒充完成日
          !dateOnlyTail && due && (
            <span
              className={overdue ? "overdue" : undefined}
              title={dueInherited ? "日期继承自母任务，改母任务会一起动" : undefined}
            >
              {formatShort(due)}
              {dueTime ? ` ${dueTime}` : ""}
            </span>
          )
        )}
      </span>
    </div>
    </div>
  );
}
