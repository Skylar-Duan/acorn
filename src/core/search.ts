// 全局搜索：纯逻辑，无 DOM 依赖。
// 打分规则：每个词在各命中域取最高分，多词（AND）求和；
// 域权重 标题子串(100, 前缀再+30) > 标题子序列(40) > 需求方/标签/清单名(30) > 备注(20)。

import type { List, Task } from "./model";

export interface SearchHit {
  task: Task;
  score: number;
}

const W_TITLE_SUB = 100;
const W_TITLE_PREFIX_BONUS = 30;
const W_TITLE_SUBSEQ = 40;
const W_META_SUB = 30;
const W_NOTES_SUB = 20;

const MAX_RESULTS = 50;

/** word 的字符是否按原顺序散布在 text 中（按 UTF-16 码元比较，中英文 BMP 字符均安全） */
function isSubsequence(word: string, text: string): boolean {
  let i = 0;
  for (let j = 0; j < text.length && i < word.length; j++) {
    if (text.charCodeAt(j) === word.charCodeAt(i)) i++;
  }
  return i === word.length;
}

/**
 * 单词在单个任务上的得分；0 表示未命中。
 * word 已小写；各域文本在此处小写后比较（中文不受影响）。
 */
function wordScore(task: Task, listName: string | null, word: string): number {
  const title = task.title.toLowerCase();
  const idx = title.indexOf(word);
  if (idx >= 0) return W_TITLE_SUB + (idx === 0 ? W_TITLE_PREFIX_BONUS : 0);
  if (isSubsequence(word, title)) return W_TITLE_SUBSEQ;
  const metaHit =
    (task.who !== null && task.who.toLowerCase().includes(word)) ||
    task.tags.some((t) => t.toLowerCase().includes(word)) ||
    (listName !== null && listName.toLowerCase().includes(word));
  if (metaHit) return W_META_SUB;
  if (task.notes.toLowerCase().includes(word)) return W_NOTES_SUB;
  return 0;
}

export function searchTasks(tasks: Task[], lists: List[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const words = q.split(/\s+/);

  const listNames = new Map<string, string>();
  for (const l of lists) listNames.set(l.id, l.name);

  const hits: SearchHit[] = [];
  for (const task of tasks) {
    if (task.deletedAt !== null) continue;
    const listName = task.listId !== null ? (listNames.get(task.listId) ?? null) : null;
    let score = 0;
    let allHit = true;
    for (const w of words) {
      const s = wordScore(task, listName, w);
      if (s === 0) {
        allHit = false;
        break;
      }
      score += s;
    }
    if (allHit) hits.push({ task, score });
  }

  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.task.done !== b.task.done) return a.task.done ? 1 : -1;
    // createdAt 是 ISO 字符串，字典序即时间序，无需转 Date
    return a.task.createdAt < b.task.createdAt ? 1 : a.task.createdAt > b.task.createdAt ? -1 : 0;
  });

  return hits.slice(0, MAX_RESULTS);
}
