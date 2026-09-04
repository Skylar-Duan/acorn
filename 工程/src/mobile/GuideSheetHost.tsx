// 举例卡片那张纸（手机）：「怎么记一句话」。
//
// 用户 2026-09-03：「手机版，便捷输入还是加回去，便捷卡片也加上」——便捷卡片就是电脑上那页
// 举例（components/GuideContent），手机没有第二个窗口，就抽一张全高的纸把同一份内容装进来，
// 例子一个字不另写。入口两个：记一条那张纸标题行的「?」、设置里的「打开用法」——
// 都走 useGuideEntry()，它在手机上改成 openSheet({ kind: "guide" })（components/GuideSheet.tsx）。
//
// 这张纸可以叠在「记一条」上面：从那张纸的「?」进来，看完收掉，底下打了一半的那句话还在
// （QuickAddSheetHost 看的是「栈里有没有」，不是「栈顶是不是」）。
import { useState } from "react";
import GuideContent from "../components/GuideContent";
import { allTags, allWho, useApp } from "../core/store";
import Sheet from "./Sheet";
import { closeSheet, topSheet, useSheet } from "./sheetStore";
import "../styles/mobile-shell.css";
import "../styles/mobile-sheet.css";

export function GuideSheetHost() {
  const top = useSheet((s) => topSheet(s.stack));
  const open = top?.kind === "guide";
  return (
    <Sheet open={open} onClose={closeSheet} size="full" label="怎么记一句话" className="msh-sheet msh-guide-sheet">
      {/* 纸不在树上时 Sheet 根本不渲染 children，所以这儿不用再判 open：退场那一拍内容还在，纸不会白着滑下去 */}
      <GuideBody />
    </Sheet>
  );
}

function GuideBody() {
  const lists = useApp((s) => s.data.lists);
  const tasks = useApp((s) => s.data.tasks);
  const settings = useApp((s) => s.data.settings);
  // 卡片按打开那一刻解析。纸一收就整个卸载，下次打开重算——「明天」不会停在昨天
  const [nowMs] = useState(() => Date.now());

  return (
    <div className="msh-guide">
      <div className="msh-guide-head">
        <div className="msh-guide-t">
          <span className="msheet-label">怎么记一句话</span>
          <span className="msh-guide-sub">日期、清单、需求方、重要性、循环，都能写在同一句里</span>
        </div>
        <button className="msh-collapse" aria-label="关闭" onClick={closeSheet}>×</button>
      </div>
      <div className="msh-scroll msh-guide-body">
        <GuideContent
          listNames={lists.map((l) => l.name)}
          tagNames={allTags({ tasks }).map((t) => t.tag)}
          whoNames={allWho({ tasks, settings }).map((w) => w.who)}
          nowMs={nowMs}
          weekendDay={settings.weekendDay}
        />
      </div>
    </div>
  );
}
