// 「顺延 ▾」：桌面上所有「往后推」的入口共用这一个按钮 + 小菜单（v1.15.x）。
//   · 今天页逾期组标题栏的「全部顺延 ▾」
//   · 多选浮条上的「顺延 ▾」
//   · 每一行已经过期的事，行尾常驻的「顺延 ▾」
// 菜单内容只有一套：明天 / 本周末 / 下周末 / 本月末（core/dates.postponePresets），再加一个「选日期…」。
// 落库只走 store.postponeRowsTo：一次选择 = 一次写入 = 一张撤销快照，顺延次数最多数一次。
//
// 弹层**不画在行里**：行外面那层 .row-slot 要做收起动画，overflow 是裁掉的（app.css 的 .row-slot），
// 画在里面会被切成半截。所以走 portal 挂到 body 上，fixed 定位跟着按钮坐标，靠边往反方向弹。
// portal 里的 React 事件照样会冒泡回行上（React 按组件树冒泡，不按 DOM），
// 所以弹层根上把 click / 右键 / 按下 / 拖拽全吞掉：点菜单不能误开任务卡、不能误触长按和拖拽。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DateRow } from "../core/store";
import { postponeRowsTo, useApp } from "../core/store";
import { fromYMD, postponePresets, todayYMD } from "../core/dates";
import DateField from "./DateField";
import type { DateFieldHandle } from "./DateField";
import "../styles/contextmenu.css";
import "../styles/postpone.css";

const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** 菜单项右边那行小字：「9月27日 周日」——选之前就知道落在哪天 */
function shortDay(ymd: string): string {
  const d = fromYMD(ymd);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK_CN[d.getDay()]}`;
}

export interface PostponeButtonProps {
  /** 点菜单项那一刻才取：要顺延的是哪几行。现取不预取——菜单开着时别处改了数据，以落库那一刻为准 */
  getRows: () => DateRow[];
  /** 按钮上的字（「顺延」「全部顺延」），后面自动跟一个 ▾ */
  label: string;
  className?: string;
  title?: string;
  /** 点按钮时先问一句：返回 true = 这一下被别人处理了（比如 Ctrl/Shift 连选），菜单不开 */
  intercept?: (e: React.MouseEvent) => boolean;
}

export default function PostponeButton({ getRows, label, className, title, intercept }: PostponeButtonProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        className={className}
        title={title}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(e) => {
          // 不许冒泡成「点开这件事」
          e.stopPropagation();
          if (intercept?.(e)) return;
          setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect());
        }}
        // 触屏上按住按钮不该起行上的长按计时（那会弹右键菜单）
        onPointerDown={(e) => e.stopPropagation()}
      >
        {label} ▾
      </button>
      {anchor && (
        <PostponePopover anchor={anchor} btnRef={btnRef} getRows={getRows} onClose={() => setAnchor(null)} />
      )}
    </>
  );
}

function PostponePopover({
  anchor, btnRef, getRows, onClose,
}: {
  anchor: DOMRect;
  btnRef: React.RefObject<HTMLButtonElement>;
  getRows: () => DateRow[];
  onClose: () => void;
}) {
  const weekendDay = useApp((s) => s.data.settings.weekendDay);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [picking, setPicking] = useState(false);
  /** 日期框里停手落定的那一天。**只记在这儿，不落库**：确定那一下才落一次 */
  const [picked, setPicked] = useState("");
  const pickedRef = useRef("");
  const fieldRef = useRef<DateFieldHandle | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const today = todayYMD();
  const presets = postponePresets(today, weekendDay);

  // 定位：默认贴在按钮下方、右缘对齐按钮右缘（按钮多半在行尾）；
  // 下面放不下往上弹，左边放不下贴左缘。「选日期…」摊开后尺寸变了要重算
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchor.right - w;
    if (left < 8) left = anchor.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = anchor.bottom + 4;
    if (top + h > window.innerHeight - 8) top = anchor.top - h - 4;
    top = Math.max(8, top);
    setPos({ left, top });
  }, [anchor, picking]);

  // 点弹层外（按钮本身除外：它自己管开关）/ Esc / 滚动 / 窗口变尺寸 → 收起
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || btnRef.current?.contains(t)) return;
      closeRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        fieldRef.current?.cancel();
        closeRef.current();
      }
    }
    function onScroll(e: Event) {
      // 弹层里面自己滚（不太会有）不算
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      closeRef.current();
    }
    function onResize() {
      closeRef.current();
    }
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [btnRef]);

  function apply(ymd: string) {
    const rows = getRows();
    if (rows.length) postponeRowsTo(rows, ymd);
    onClose();
  }

  /** 「选日期…」的确定：先把日期框里还欠着的那一下收进来，再落**一次**库 */
  function confirmPicked() {
    fieldRef.current?.flush();
    const v = pickedRef.current;
    if (!v) return;
    fieldRef.current?.cancel();
    apply(v);
  }

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return createPortal(
    <div
      className="ctx-menu pp-menu"
      ref={ref}
      role="menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999, visibility: "hidden" }}
      onClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="ctx-count">顺延到</div>
      {presets.map((p) => (
        <button key={p.key} className="ctx-item" role="menuitem" onClick={() => apply(p.ymd)}>
          {p.label}
          <span className="pp-when">{shortDay(p.ymd)}</span>
        </button>
      ))}
      <div className="ctx-sep" />
      {picking ? (
        <div
          className="pp-pick"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              confirmPicked();
            }
          }}
        >
          <DateField
            ref={fieldRef}
            value={picked}
            onCommit={(v) => {
              pickedRef.current = v;
              setPicked(v);
            }}
          />
          {/* 不设 disabled：日期框停手 350ms 才落定，敲完马上点「确定」时按钮还没亮，
              一个禁用的按钮连 mousedown 都不发，那一下就白点了。没选日子时 confirmPicked 自己什么都不做 */}
          <button className="btn" onClick={confirmPicked}>
            确定
          </button>
        </div>
      ) : (
        <button className="ctx-item" role="menuitem" onClick={() => setPicking(true)}>
          选日期…
        </button>
      )}
    </div>,
    document.body,
  );
}
