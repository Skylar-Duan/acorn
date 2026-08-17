// 快速添加条：边打字边解析，识别出的要素以 chip 实时预览，回车落库。
import { useMemo, useState } from "react";
import { parseQuickAdd } from "../core/parse";
import { addTask, useApp } from "../core/store";

const CHIP_ICON: Record<string, string> = {
  date: "📅", time: "🕒", repeat: "↻", list: "▤", tag: "#", who: "＠", priority: "⚑",
};

export interface QuickAddBarProps {
  /** 视图上下文默认值：如清单视图里默认加进该清单 */
  defaults?: { listId?: string | null; who?: string | null; due?: string | null; someday?: boolean };
  placeholder?: string;
  autoFocus?: boolean;
  onAdded?: (id: string) => void;
}

export default function QuickAddBar({ defaults, placeholder, autoFocus, onAdded }: QuickAddBarProps) {
  const lists = useApp((s) => s.data.lists);
  const [text, setText] = useState("");

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    return parseQuickAdd(text, { now: new Date(), listNames: lists.map((l) => l.name) });
  }, [text, lists]);

  function submit() {
    if (!parsed || !parsed.title.trim()) return;
    // defaults.listId 可能指向一张刚被删除的清单，落库前验一遍存在性
    const defaultListId =
      defaults?.listId && lists.some((l) => l.id === defaults.listId) ? defaults.listId : null;
    const listId =
      parsed.listName != null
        ? lists.find((l) => l.name === parsed.listName)?.id ?? null
        : defaultListId;
    const id = addTask({
      title: parsed.title.trim(),
      listId,
      tags: parsed.tags,
      who: parsed.who ?? defaults?.who ?? null,
      priority: parsed.priority,
      due: parsed.due ?? defaults?.due ?? null,
      dueTime: parsed.dueTime,
      repeat: parsed.repeat,
      someday: parsed.due == null && (defaults?.someday ?? false),
    });
    setText("");
    onAdded?.(id);
  }

  return (
    <div className="quick-add">
      <span className="plus">＋</span>
      <input
        value={text}
        autoFocus={autoFocus}
        placeholder={placeholder ?? "记一条…试试「周五下午3点 提交周报 #工作 @李哥 !高」"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
          if (e.key === "Escape") setText("");
        }}
      />
      {parsed && parsed.chips.length > 0 && (
        <span className="chips">
          {parsed.chips.map((c, i) => (
            <span key={`${c.kind}-${i}`} className="chip">
              {CHIP_ICON[c.kind] ?? ""} {c.text}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
