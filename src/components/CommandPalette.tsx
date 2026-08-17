// 命令面板：Ctrl+K 呼出。一个输入框直达跳转、主题与常用动作。
import { useEffect, useMemo, useRef, useState } from "react";
import type { ThemeName } from "../core/model";
import type { ViewId } from "../core/store";
import { navigate, setPaletteOpen, undo, updateSettings } from "../core/store";
import "../styles/overlays.css";

interface Command {
  id: string;
  icon: string;
  label: string;
  hint: string;
  run: () => void;
}

// [视图, 图标, 名称, 说明]
const NAV: [ViewId, string, string, string][] = [
  ["inbox", "✍️", "随手记", "记一条 · 还没安排的都在这"],
  ["today", "🌞", "今天", "今日安排与逾期"],
  ["upcoming", "🗓", "计划", "未来的日程"],
  ["all", "🗂", "全部", "所有未完成一览"],
  ["logbook", "📖", "日志", "已完成的记录"],
  ["calendar", "📅", "日历", "按月查看"],
  ["quadrant", "⊞", "四象限", "轻重缓急一目了然"],
  ["focus", "🍅", "专注", "番茄钟"],
  ["stats", "📊", "统计", "效率回顾"],
  ["settings", "⚙", "设置", "偏好与数据"],
  ["trash", "🗑", "回收站", "已删除的任务"],
];

// [主题, 图标, 名称, 说明]（说明沿用 themes.css 里的意象）
const THEMES: [ThemeName, string, string, string][] = [
  ["forest", "🌲", "森林", "晨雾里的针叶林"],
  ["ocean", "🌊", "海洋", "退潮后的浅滩"],
  ["night", "✨", "星空", "暮色与远光"],
  ["desert", "🏜", "沙漠", "落日下的沙丘"],
  ["snow", "🏔", "雪山", "清晨的冰川"],
  ["polar", "🧊", "南极", "极昼的冰面"],
];

const MODES: ["light" | "dark" | "system", string, string][] = [
  ["light", "🌤", "浅色"],
  ["dark", "🌙", "深色"],
  ["system", "🖥", "跟随系统"],
];

const COMMANDS: Command[] = [
  ...NAV.map(([view, icon, label, hint]): Command => ({
    id: `nav-${view}`, icon, label, hint, run: () => navigate(view),
  })),
  ...THEMES.map(([theme, icon, name, hint]): Command => ({
    id: `theme-${theme}`, icon, label: `主题 · ${name}`, hint,
    run: () => updateSettings({ theme }),
  })),
  ...MODES.map(([mode, icon, name]): Command => ({
    id: `mode-${mode}`, icon, label: name, hint: "深浅模式",
    run: () => updateSettings({ mode }),
  })),
  { id: "undo", icon: "↩", label: "撤销上一步", hint: "撤回刚才的更改", run: () => undo() },
];

export default function CommandPalette() {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const w = q.trim().toLowerCase();
    if (!w) return COMMANDS;
    return COMMANDS.filter(
      (c) => c.label.toLowerCase().includes(w) || c.hint.toLowerCase().includes(w),
    );
  }, [q]);

  // 过滤结果变化后把高亮夹回范围内
  const idx = filtered.length ? Math.min(active, filtered.length - 1) : 0;

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".cp-item.on")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  function runAt(i: number) {
    const cmd = filtered[i];
    if (!cmd) return;
    cmd.run();
    setPaletteOpen(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setPaletteOpen(false);
      return;
    }
    if (!filtered.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(idx + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(idx - 1, 0));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      runAt(idx);
    }
  }

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setPaletteOpen(false);
      }}
    >
      <div className="modal cp-modal">
        <div className="cp-input">
          <span className="cp-glyph">❯</span>
          <input
            autoFocus
            value={q}
            placeholder="输入命令：视图名 / 主题 / 撤销…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
        <div className="cp-list" ref={listRef}>
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={`cp-item${i === idx ? " on" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => runAt(i)}
            >
              <span className="cp-ico">{c.icon}</span>
              <span className="cp-label">{c.label}</span>
              <span className="cp-hint">{c.hint}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="cp-empty">没有匹配的命令</div>}
        </div>
      </div>
    </div>
  );
}
