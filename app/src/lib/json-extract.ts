// 从 LLM 输出中提取首个完整 JSON 值（常带 Markdown 代码栅栏），交由调用方 schema 校验。
// 实现：括号深度扫描（感知字符串与转义），不依赖正则截取，能正确处理嵌套结构。
export class JsonExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonExtractionError';
  }
}

export function extractJsonBlock(content: string): unknown {
  const objectStart = content.indexOf('{');
  const arrayStart = content.indexOf('[');
  let start = objectStart;
  if (objectStart === -1 || (arrayStart !== -1 && arrayStart < objectStart)) start = arrayStart;
  if (start === -1) throw new JsonExtractionError('输出中没有 JSON。');

  const open = content[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        const slice = content.slice(start, index + 1);
        try {
          return JSON.parse(slice) as unknown;
        } catch {
          throw new JsonExtractionError('输出不是有效 JSON。');
        }
      }
    }
  }
  throw new JsonExtractionError('输出中的 JSON 未闭合。');
}
