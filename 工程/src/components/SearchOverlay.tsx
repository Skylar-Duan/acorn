// 全局搜索：Ctrl+F 呼出。输入即搜，回车直达任务的「家」并展开它。
import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "../core/model";
import { cmpYMD, formatShort, todayYMD } from "../core/dates";
import { searchTasks } from "../core/search";
import { aliveTasks, expandTask, navigate, setSearchOpen, useApp } from "../core/store";
import "../styles/overlays.css";

const MAX_SHOWN = 20;

/** 这件事在「今天」页上占不占行。
 *  有未完成子任务的事，母任务行是收起的，占行的是子任务——子任务各自排到很远的话，
 *  母任务写着「今天到期」也不会出现在今天页上。只看 t.due 就 navigate('today')，
 *  用户会跳到一个什么都没有的页面 */
function showsToday(t: Task, today: string): boolean {
  const open = t.subtasks.filter((s) => !s.done);
  const dues = open.length ? open.map((s) => s.due ?? t.due) : [t.due];
  return dues.some((d) => !!d && cmpYMD(d, today) <= 0);
}

/** 跳到任务平时住的视图：做完的回「已完成」，逾期/今天回「今天」，再按清单/计划归位 */
function goHome(t: Task) {
  if (t.done) {
    navigate("done");
  } else if (t.due && cmpYMD(t.due, todayYMD()) <= 0 && showsToday(t, todayYMD())) {
    navigate("today");
  } else if (t.listId) {
    navigate("list", { listId: t.listId });
  } else {
    // 没日期也没清单的那些事，v1.11.2 起家就在「计划」——桌面上「随手记」这个视图
    // 已经撤了（记录那半边成了「＋ 记一条」弹窗），送过去只会落进一片空白
    navigate("plan");
  }
  expandTask(t.id);
  setSearchOpen(false);
}

export default function SearchOverlay() {
  const data = useApp((s) => s.data);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(
    () => searchTasks(aliveTasks(data), data.lists, q).slice(0, MAX_SHOWN),
    [data, q],
  );
  const idx = hits.length ? Math.min(active, hits.length - 1) : 0;

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".so-item.on")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setSearchOpen(false);
      return;
    }
    if (!hits.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(idx + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(idx - 1, 0));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      goHome(hits[idx].task);
    }
  }

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setSearchOpen(false);
      }}
    >
      <div className="modal so-modal">
        <div className="so-input">
          <span className="so-glyph">🔍</span>
          <input
            autoFocus
            value={q}
            placeholder="搜索任务…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
        <div className="so-list" ref={listRef}>
          {hits.map(({ task: t }, i) => {
            const list = t.listId ? data.lists.find((l) => l.id === t.listId) : null;
            return (
              <button
                key={t.id}
                className={`so-item${i === idx ? " on" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => goHome(t)}
              >
                <span className={`flag p${t.priority}`} />
                <span className={`so-title${t.done ? " done" : ""}`}>
                  {t.title || "（未命名）"}
                </span>
                <span className="so-meta">
                  {list && (
                    <span className="so-list-tag">
                      <span className="so-dot" style={{ background: `var(--list-${list.color})` }} />
                      {list.name}
                    </span>
                  )}
                  {t.who && <span>＠{t.who}</span>}
                  {t.due && (
                    <span>
                      {formatShort(t.due)}
                      {t.dueTime ? ` ${t.dueTime}` : ""}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {q.trim() === "" && (
            <div className="so-empty">输入以搜索标题、备注、标签、需求方</div>
          )}
          {q.trim() !== "" && hits.length === 0 && (
            <div className="so-empty">没有找到匹配的任务</div>
          )}
        </div>
      </div>
    </div>
  );
}
