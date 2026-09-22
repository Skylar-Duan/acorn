// 「顺延到哪天」那张小纸（手机，09-21 统一口径）。
// 入口三个，都是「往后推」：左滑一行的「顺延」、长按动作单的「顺延」、今天页逾期组的「全部顺延」。
// 原来这三处都是「推到明天」一下就推，只能推一天；现在跟桌面「顺延 ▾」同一套选项：
//   今天 / 明天 / 本周末 / 下周末 / 本月末 / 选日期…
// 只是**不晚于这件事现有日期的那几项藏掉**（顺延不往前拉、不原地不动；好几行时按最早的那个算）。
// 今天到期的事点开，第一项就是「明天」——原来那个一键推明天的快捷还在，只是多了几个去处。
//
// 落库只走 store.postponeRowsTo（跟桌面同一条）：一次选择 = 一次写入 = 一张撤销快照，顺延次数最多数一次。
import { useEffect, useRef, useState } from "react";
import type { DateRow } from "../core/store";
import { appStore, postponeRowsTo, rowDue, useApp } from "../core/store";
import type { Task } from "../core/model";
import { cmpYMD, fromYMD, todayYMD } from "../core/dates";
import { PICK_DATE_LABEL, dateOptions } from "../core/options";
import DateField from "../components/DateField";
import type { DateFieldHandle } from "../components/DateField";
import Sheet from "./Sheet";
import { closeSheet, topSheet, useSheet } from "./sheetStore";
import type { SheetKind } from "./sheetStore";
import "../styles/mobile-shell.css";
import "../styles/mobile-sheet.css";

type RowRef = Extract<SheetKind, { kind: "postpone" }>["rows"][number];

const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** 每一项右边那行小字：「9月27日 周日」——点之前就知道落在哪天（跟桌面顺延菜单同一个写法） */
function shortDay(ymd: string): string {
  const d = fromYMD(ymd);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK_CN[d.getDay()]}`;
}

/** 按 id 把行找回来：删掉的、做完的、放弃了的不算（纸开着的时候可能在别处被了结了） */
export function resolvePostponeRows(refs: RowRef[], tasks: Task[]): DateRow[] {
  const out: DateRow[] = [];
  for (const r of refs) {
    const task = tasks.find((t) => t.id === r.taskId && !t.deletedAt);
    if (!task) continue;
    if (!r.subId) {
      if (!task.done && !task.droppedAt) out.push({ task, sub: null });
      continue;
    }
    const sub = task.subtasks.find((s) => s.id === r.subId && !s.deletedAt);
    if (sub && !sub.done && !sub.droppedAt) out.push({ task, sub });
  }
  return out;
}

/** 这几行里最早的那个日期（子任务行按它实际生效的日期算）；都没日期就是 null */
function earliestDue(rows: DateRow[]): string | null {
  let min: string | null = null;
  for (const r of rows) {
    const d = rowDue(r);
    if (d && (!min || cmpYMD(d, min) < 0)) min = d;
  }
  return min;
}

export function PostponeSheetHost() {
  const top = useSheet((s) => topSheet(s.stack));
  const entry = top?.kind === "postpone" ? top : null;
  // 退场那一拍栈已经空了，留住最后那一份，纸别在滑下去的路上变白
  const lastRef = useRef<RowRef[] | null>(null);
  if (entry) lastRef.current = entry.rows;
  const refs = entry?.rows ?? lastRef.current;
  return (
    <Sheet open={!!entry} onClose={closeSheet} label="顺延到">
      {refs && <PostponeBody key={JSON.stringify(refs)} refs={refs} live={!!entry} />}
    </Sheet>
  );
}

function PostponeBody({ refs, live }: { refs: RowRef[]; live: boolean }) {
  const tasks = useApp((s) => s.data.tasks);
  const weekendDay = useApp((s) => s.data.settings.weekendDay);
  const rows = resolvePostponeRows(refs, tasks);
  // 「这件事现有的日期」：打开那一刻取一次（好几行取最早的那个）。没日期的行不设下限
  const [floor] = useState(() => earliestDue(rows));
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState("");
  const pickedRef = useRef("");
  const fieldRef = useRef<DateFieldHandle | null>(null);
  const today = todayYMD();
  const presets = dateOptions(today, { weekendDay, after: floor });

  // 要推的那几行全没了（撤销、云同步、别处做完了）：收掉，别对着空气选日子
  const empty = rows.length === 0;
  useEffect(() => {
    if (empty && live) closeSheet();
  }, [empty, live]);

  function apply(ymd: string) {
    fieldRef.current?.cancel();
    // 点下去那一刻重新取：纸开着时别处改了数据，以现在为准
    const cur = resolvePostponeRows(refs, appStore.getState().data.tasks);
    if (cur.length) postponeRowsTo(cur, ymd);
    closeSheet();
  }

  /** 选日期…的「确定」：日期框停手才落定，先把欠着的那一下接过来 */
  function confirmPicked() {
    fieldRef.current?.flush();
    const v = pickedRef.current;
    if (v) apply(v);
  }

  const title = rows.length === 1
    ? (rows[0].sub ? rows[0].sub.title : rows[0].task.title) || "（未命名）"
    : `${rows.length} 件`;

  return (
    <div className="mpp">
      <div className="msheet-title">{title}</div>
      <div className="msheet-label">顺延到</div>
      <div className="mpp-list">
        {presets.map((p) => (
          <button key={p.key} className="mpp-item" onClick={() => apply(p.ymd)}>
            <span>{p.label}</span>
            <span className="mpp-when">{shortDay(p.ymd)}</span>
          </button>
        ))}
        {!picking ? (
          <button className="mpp-item" onClick={() => setPicking(true)}>
            <span>{PICK_DATE_LABEL}</span>
          </button>
        ) : (
          <div className="msh-row mpp-pick">
            {/* 全仓唯一那个日期框：草稿 / 合理性闸 / 去抖三件套都在它里面。
                这儿**只记不落库**，点「确定」那一下才顺延（一次选择 = 一次写入） */}
            <DateField
              ref={fieldRef}
              className="msh-field date"
              value={picked}
              onCommit={(v) => {
                pickedRef.current = v;
                setPicked(v);
              }}
            />
            {/* 不设 disabled：日期框停手 350ms 才落定，敲完马上点「确定」时按钮还没亮就白点了 */}
            <button className="msh-opt narrow" onClick={confirmPicked}>
              确定
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
