/**
 * 协议日志脱敏与 body 安全解析
 *
 * - redactHeaders: 把 authorization / x-api-key 等敏感 header 值替换为 <redacted>
 * - safeParseBody: 把 fetch 的 body（string | object）解析为可序列化结构
 */

const REDACT_HEADER_KEYS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'proxy-authorization',
  'anthropic-auth-token',
]);

export function redactHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const result: Record<string, string> = {};
  const src = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(src)) {
    if (typeof value !== 'string') continue;
    result[key] = REDACT_HEADER_KEYS.has(key.toLowerCase()) ? '<redacted>' : value;
  }
  return result;
}

/**
 * 把 fetch init.body（通常是 JSON 字符串，也可能是对象/Buffer）解析为可记录结构。
 * - JSON 字符串 → 解析为对象
 * - 非 JSON 字符串 → 截断保留原文
 * - 对象 → 原样返回
 */
export function safeParseBody(body: unknown): unknown {
  if (body == null) return undefined;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body.length > 2000 ? body.slice(0, 2000) + '...<truncated>' : body;
    }
  }
  if (Buffer.isBuffer(body)) {
    const text = body.toString('utf8');
    return safeParseBody(text);
  }
  return body;
}
