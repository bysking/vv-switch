/**
 * 字符串工具
 */

/**
 * 安全转换为字符串，避免 object 隐式 toString 为 "[object Object]"。
 */
export function toSafeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

/**
 * 将 tool_use 的 input 字段转换为合法的 JSON 字符串。
 * 部分上游严格要求 arguments 为有效 JSON。
 */
export function toolInputToJsonString(input: unknown): string {
  const raw = input ?? {};
  if (typeof raw === 'string') {
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      return JSON.stringify({ value: raw });
    }
  }
  return JSON.stringify(raw);
}

/**
 * 截断字符串用于日志显示
 */
export function truncate(text: string, maxLength = 500): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}
