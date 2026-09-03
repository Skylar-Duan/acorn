// 「记一条」弹窗（v1.11.2）：桌面上侧栏那颗「＋ 记一条」点开的就是它。
//
// 为什么有这个：原来侧栏第一项是「随手记」——它既是记录入口、又是「没日期也没归清单
// 那堆事」的列表。用户 2026-09-03 的话：「电脑版都可以用加号＋弹窗输入替代掉随手记」。
// 记一条是个**动作**，不该占着一个常驻的地方；那些还没归置的事在「计划」里照样看得见。
//
// 输入体验一个字没改：里面就是原来那条 QuickAddBar（withPickers），
// 边打边解析、# @ / 自动补全、一排点选按钮、用法页，全是同一个件。
//
// 挂载点在 App.tsx，不在 Sidebar 里——手机上侧栏带 transform，会成为 fixed 的包含块，
// 弹窗会被关在抽屉里（ChangelogDialog 踩过同一个坑）。
import { useEffect, useRef } from "react";
import QuickAddBar from "./QuickAddBar";
import { useGuideEntry } from "./GuideSheet";
import { useCommitFlash } from "./commitFlash";
import { setQuickAddOpen } from "../core/store";
import "../styles/quickadd-dialog.css";

export default function QuickAddDialog() {
  const guide = useGuideEntry();
  /** 记下一条之后的回执（A2 那套）：不弹 toast——记一条不需要反悔，只需要被看见。
   *  这儿只管**整个框亮一下**；那个「✓」由 SyntaxInput 自己浮出来（它本来就带一份），
   *  两处各画一个勾就是同一件事说两遍 */
  const flash = useCommitFlash();
  const boxRef = useRef<HTMLDivElement>(null);

  // Esc 关。挂在 document 上而不是卡片上：焦点可能落在某个点选小菜单里，
  // 那时 React 的 onKeyDown 冒泡不到这张卡上来。
  //
  // **Esc 是分层吃掉的，这一层排在最后**：补全下拉开着就先收下拉、框里还有没记完的那句
  // 就先擦掉那句（两处都在 SyntaxInput 里，React 的监听挂在根容器上，先于 document 跑，
  // 吃掉了就不往下传）；点选那排的小菜单同理（QuickAddBar 自己那条 document 监听）。
  // 都没人认领，才轮到「关掉这个弹窗」。
  //
  // App.tsx 那条全局键里的 Esc 会清选中、收任务卡：弹窗开着时焦点在输入框里，
  // 它那句 inEditable() 会先行返回，撞不上。这里的 stopPropagation 是多一道保险
  useEffect(() => {
    function onQuickAddKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setQuickAddOpen(false);
    }
    document.addEventListener("keydown", onQuickAddKey);
    return () => document.removeEventListener("keydown", onQuickAddKey);
  }, []);

  // 打开就把光标送进输入框。QuickAddBar 的 autoFocus 已经做了这件事，
  // 这儿是补一手：弹窗是后挂上来的，autoFocus 偶尔会被外面刚失效的焦点抢回去
  useEffect(() => {
    boxRef.current?.querySelector<HTMLElement>(".quick-add input, .quick-add textarea")?.focus();
  }, []);

  return (
    <div
      className="overlay qad-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setQuickAddOpen(false);
      }}
    >
      <div className="modal qad-modal" role="dialog" aria-labelledby="qad-title" ref={boxRef}>
        <header className="qad-head">
          <h2 id="qad-title">记一条</h2>
          <button className="qad-help" title="怎么写一句话" onClick={guide.open}>?</button>
          <button className="qad-x" aria-label="关闭" title="关闭" onClick={() => setQuickAddOpen(false)}>
            ×
          </button>
        </header>
        {/* 记完不关窗：连着记好几条是这个框最常见的用法，
            记一条就得重新点开一次侧栏那颗按钮，是把人当机器使。
            .lit 那一下就是回执，QuickAddBar 自己会把输入清空、光标留在原地 */}
        <div className={`qad-body${flash.on ? " lit" : ""}`}>
          <QuickAddBar withPickers autoFocus onAdded={() => flash.flash()} />
        </div>
        <p className="qad-foot">回车记下；连着记几条不用重开；Esc 关</p>
        {guide.sheet}
      </div>
    </div>
  );
}
