/**
 * JSON Schema 规范化
 *
 * 部分上游（DeepSeek 等）要求 tool parameters 必须是合法的 JSON Schema：
 * - type 不能是 null 或 "null"
 * - properties 必须是对象
 * - required 必须是数组
 */

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export function normalizeToolSchema(schema: unknown): JsonSchema {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, required: [] };
  }
  const s: JsonSchema = { ...(schema as JsonSchema) };
  if (s.type == null || s.type === 'null') {
    s.type = 'object';
  }
  if (!s.properties || typeof s.properties !== 'object') {
    s.properties = {};
  }
  if (!Array.isArray(s.required)) {
    s.required = [];
  }
  return s;
}
