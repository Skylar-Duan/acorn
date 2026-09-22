// 菜单末尾「选日期…」那一项（09-21 统一口径里的最后一项）：点开在原地摊成一个日期框 + 「确定」。
// 给**没有常驻日期框**的菜单用：顺延菜单（PostponeMenu）、右键「调整日期 ▸」。
// 任务卡、快速添加条、侧栏「安排到哪天？」弹层里本来就常驻一个日期框，那个框就是它们的「选日期…」。
//
// 日期框停手才落定（DateField 的去抖），这儿**只记不落库**：点「确定」或回车那一下才交给调用方，
// 一次选择 = 一次写入。
import { useRef, useState } from "react";
import { PICK_DATE_LABEL } from "../core/options";
import DateField from "./DateField";
import type { DateFieldHandle } from "./DateField";
import "../styles/postpone.css";

export interface DatePickRowProps {
  /** 选定了哪天 */
  onPick: (ymd: string) => void;
  /** 摊开 / 收起时告诉调用方（右键子菜单摊开后别因为鼠标移出就收掉、弹层要重算位置） */
  onOpenChange?: (open: boolean) => void;
  /** 按钮的样式类：右键菜单一族是 ctx-item，弹层一族是 item */
  itemClass?: string;
  /** 外面要在 Esc 时把欠着的那一下作废，拿这个手 */
  fieldRef?: React.MutableRefObject<DateFieldHandle | null>;
}

export default function DatePickRow({ onPick, onOpenChange, itemClass = "ctx-item", fieldRef }: DatePickRowProps) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const pickedRef = useRef("");
  const ownRef = useRef<DateFieldHandle | null>(null);
  const ref = fieldRef ?? ownRef;

  function confirm() {
    ref.current?.flush();
    const v = pickedRef.current;
    if (!v) return;
    ref.current?.cancel();
    onPick(v);
  }

  if (!open) {
    return (
      <button className={itemClass} role="menuitem" onClick={() => { setOpen(true); onOpenChange?.(true); }}>
        {PICK_DATE_LABEL}
      </button>
    );
  }
  return (
    <div
      className="pp-pick"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          // 拦住冒泡：这一下回车之后弹层就卸了，document 上的全局快捷键会以为焦点不在输入框里，
          // 把之前单选中的那件事展开
          e.stopPropagation();
          confirm();
        }
      }}
    >
      <DateField
        ref={ref}
        value={picked}
        onCommit={(v) => {
          pickedRef.current = v;
          setPicked(v);
        }}
      />
      {/* 不设 disabled：日期框停手 350ms 才落定，敲完马上点「确定」时按钮还没亮，
          一个禁用的按钮连 mousedown 都不发，那一下就白点了。没选日子时 confirm 自己什么都不做 */}
      <button className="btn" onClick={confirm}>确定</button>
    </div>
  );
}
