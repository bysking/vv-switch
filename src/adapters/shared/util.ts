/**
 * 适配器共享工具
 */

/**
 * 安全 JSON 解析:失败时原样返回字符串(用于 tool arguments 等可能非 JSON 的透传)。
 * 之前 claude/openai/codex 三个适配器各抄一份,此处统一。
 */
export function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
