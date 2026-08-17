// 快速添加条：边打字边解析（chips 实时预览 + #/@// 自动补全），回车落库。
// /清单 不存在时自动新建；# 只管标签。
import { useState } from "react";
import type { ParseResult } from "../core/parse";
import { LIST_COLORS } from "../core/model";
import { addList, addTask, allTags, allWho, useApp } from "../core/store";
import SyntaxInput from "./SyntaxInput";

export interface QuickAddBarProps {
  /** 视图上下文默认值：如清单视图里默认加进该清单 */
  defaults?: { listId?: string | null; who?: string | null; due?: string | null };
  placeholder?: string;
  autoFocus?: boolean;
  onAdded?: (id: string) => void;
}

export default function QuickAddBar({ defaults, placeholder, autoFocus, onAdded }: QuickAddBarProps) {
  const data = useApp((s) => s.data);
  const lists = data.lists;
  const [text, setText] = useState("");

  function submit(parsed: ParseResult) {
    if (!parsed.title.trim()) return;
    // defaults.listId 可能指向一张刚被删除的清单，落库前验一遍存在性
    const defaultListId =
      defaults?.listId && lists.some((l) => l.id === defaults.listId) ? defaults.listId : null;
    let listId = defaultListId;
    if (parsed.listName != null) {
      const hit = lists.find((l) => l.name === parsed.listName);
      listId = hit ? hit.id : addList(parsed.listName, LIST_COLORS[lists.length % LIST_COLORS.length]);
    }
    const id = addTask({
      title: parsed.title.trim(),
      listId,
      tags: parsed.tags,
      who: parsed.who ?? defaults?.who ?? null,
      priority: parsed.priority,
      due: parsed.due ?? defaults?.due ?? null,
      dueTime: parsed.dueTime,
      repeat: parsed.repeat,
    });
    setText("");
    onAdded?.(id);
  }

  return (
    <div className="quick-add">
      <span className="plus">＋</span>
      <SyntaxInput
        value={text}
        onChange={setText}
        onSubmit={submit}
        autoFocus={autoFocus}
        placeholder={placeholder ?? "记一条…「周五下午3点 提交周报 /工作 @李哥 #紧要 !高」"}
        lists={lists.map((l) => l.name)}
        tags={allTags(data).map((t) => t.tag)}
        whos={allWho(data).map((w) => w.who)}
        showChips
      />
    </div>
  );
}
