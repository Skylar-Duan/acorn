// 说明的应用内弹层：手机上没有第二个窗口，openGuide() 返回 false 时用这个顶上。
// 只在主窗里用（它要读 store 拿补全候选），独立窗口走 windows/guide.tsx。
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import GuideContent from "./GuideContent";
import { openGuide } from "../core/guideCtl";
import { allTags, allWho, useApp } from "../core/store";

/** 弹层本体。母组件负责决定它出不出现 */
export function GuideSheet({ onClose }: { onClose: () => void }) {
  const data = useApp((s) => s.data);
  const [nowMs] = useState(() => Date.now());

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="gd-sheet" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gd-sheet-panel">
        <div className="gd-win-head">
          <h1>一句话记事</h1>
          <span className="sub">日期、清单、需求方、重要性、循环，都能写在同一句里</span>
          <button className="gd-sheet-close" title="关闭" onClick={onClose}>×</button>
        </div>
        <div className="gd-win-body">
          <GuideContent
            listNames={data.lists.map((l) => l.name)}
            tagNames={allTags(data).map((t) => t.tag)}
            whoNames={allWho(data).map((w) => w.who)}
            nowMs={nowMs}
          />
        </div>
      </div>
    </div>
  );
}

/** 给「打开用法」的按钮用：open() 优先开独立窗口，开不了就地弹层。
 *  把返回的 sheet 挂在按钮旁边即可 */
export function useGuideEntry(): { open: () => void; sheet: ReactElement | null } {
  const [inline, setInline] = useState(false);
  const open = useCallback(() => {
    void openGuide().then((ok) => {
      if (!ok) setInline(true);
    });
  }, []);
  return {
    open,
    sheet: inline ? <GuideSheet onClose={() => setInline(false)} /> : null,
  };
}
