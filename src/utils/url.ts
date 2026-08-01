/**
 * URL 构造工具
 *
 * - 处理上游 base URL 的归一化、版本号兼容（/v1、/v2…）
 * - 为不同协议拼接对应端点
 */

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function hasVersionSuffix(url: string): boolean {
  return /\/v\d+$/.test(normalizeBaseUrl(url));
}

/**
 * 拼接带版本前缀的上游端点。
 * 用户已配置 /v1、/v2、/v3 时保留用户版本号；否则使用 /v1 兜底。
 */
export function appendVersionedPath(baseUrl: string, subpath: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const cleanPath = String(subpath || '').replace(/^\/+/, '');
  if (hasVersionSuffix(normalized)) {
    return `${normalized}/${cleanPath}`;
  }
  return `${normalized}/v1/${cleanPath}`;
}

/**
 * 规范化 Ollama base URL（去除 /v1 后缀和末尾斜杠）
 */
export function normalizeBaseUrlForOllama(url: string): string {
  const cleaned = normalizeBaseUrl(url);
  if (hasVersionSuffix(cleaned)) {
    return cleaned.replace(/\/v\d+$/, '');
  }
  return cleaned;
}

export function buildChatUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

export function buildOllamaChatUrl(baseUrl: string): string {
  return `${normalizeBaseUrlForOllama(baseUrl)}/api/chat`;
}

export function buildOllamaModelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrlForOllama(baseUrl)}/api/tags`;
}

export function buildMessagesUrl(baseUrl: string): string {
  return appendVersionedPath(baseUrl, 'messages');
}

export function buildResponsesUrl(baseUrl: string): string {
  return appendVersionedPath(baseUrl, 'responses');
}

export function buildModelsUrl(baseUrl: string): string {
  return appendVersionedPath(baseUrl, 'models');
}
