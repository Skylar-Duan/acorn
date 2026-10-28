import { quotedSpans } from "./quotedText";

export const syntaxTriggerKind = { "#": "tag", "@": "who", "/": "list" } as const;
export type SyntaxTrigger = keyof typeof syntaxTriggerKind;
export const sameName = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** 保留原来的拼写；前缀优先，再找包含，英文不区分大小写。 */
export function pickSyntaxCandidates(source: readonly string[], prefix: string): string[] {
  const query = prefix.toLocaleLowerCase();
  const unique = source.filter((name, index) => source.findIndex((other) => sameName(name, other)) === index);
  return [...unique.filter((name) => name.toLocaleLowerCase().startsWith(query)),
    ...unique.filter((name) => !name.toLocaleLowerCase().startsWith(query) && name.toLocaleLowerCase().includes(query))].slice(0, 6);
}

export function syntaxToken(value: string, caret: number) {
  // @和/可紧贴正文触发候选；#仍要求句首或空白边界。
  const match = /(?:^|\s|(?=[@/]))([#@\/])([^\s#@\/!！~～"“”＂]*)$/.exec(value.slice(0, caret));
  if (!match) return null;
  const start = caret - match[2].length - 1;
  const quotes = quotedSpans(value);
  if (quotes.some((span) => start < span.end && caret > span.start)) return null;
  if (match[1] === "/" && start > 0 && !/\s/.test(value[start - 1])) {
    // 引用正文是独立边界；不能因前一段引用里写过 /，把引号外新输入的 / 也当成路径。
    const quoteEnd = quotes.reduce((end, span) => span.end <= start ? span.end : end, 0);
    const before = /\S*$/.exec(value.slice(quoteEnd, start))![0];
    const after = /^[^\s"“”＂]*/.exec(value.slice(start + 1))![0];
    // URL、绝对/相对路径及8/20继续当正文。紧贴普通标题的/只有明确选候选时才补空格转成合法标记。
    if (/[\\/:]/.test(before) || /[\\/]/.test(after) || /^(?:\.{1,2}|~|\d+)$/.test(before)
      || /^www\./i.test(before) || /\.[a-z][a-z\d]{0,7}$/i.test(match[2])) return null;
  }
  // 完整邮件地址与解析器相同仍是正文，不能因@贴连支持而被候选改成人名。
  if (match[1] === "@" && [...value.matchAll(/[^\s"“”＂]+@[^\s@"“”＂]+\.[^\s@"“”＂]+/g)]
    .some((email) => start < email.index! + email[0].length && caret > email.index!)) return null;
  return { trigger: match[1] as SyntaxTrigger, prefix: match[2], start, end: caret };
}
