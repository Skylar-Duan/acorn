// 双引号引用的是正文：解析与补全共用同一份范围，不能让补全改掉引用内容。
export interface QuotedSpan {
  start: number;
  end: number;
}

const CLOSE: Record<string, string | undefined> = { '"': '"', '“': '”', '＂': '＂' };

function escaped(text: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** 包括引号本身；未闭合时先保护到行尾，下一行仍可正常输入语法。
 *  成对引用允许换行，也允许在另一种引号中原样引用文字。 */
export function quotedSpans(text: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  for (let i = 0; i < text.length; i++) {
    const close = CLOSE[text[i]];
    if (!close || escaped(text, i)) continue;
    let end = i + 1;
    while (end < text.length && (text[end] !== close || escaped(text, end))) end++;
    if (end < text.length) end++;
    else {
      const lineEnd = text.slice(i + 1).search(/[\r\n]/);
      end = lineEnd < 0 ? text.length : i + 1 + lineEnd;
    }
    spans.push({ start: i, end });
    i = end - 1;
  }
  return spans;
}

export function overlapsQuotedText(text: string, start: number, end: number): boolean {
  return quotedSpans(text).some((span) => start < span.end && end > span.start);
}
