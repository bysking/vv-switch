/**
 * AI 编码工具身份标识
 *
 * 为上游请求注入 AI 编码工具特征 headers，
 * 使供应商正确识别请求来源为 AI 编码终端。
 */

import { randomUUID } from 'crypto';

export interface IdentityProfile {
  userAgent: string;
  stainless: Record<string, string>;
  extra: Record<string, string>;
}

const PROFILES: Record<string, IdentityProfile> = {
  codex: {
    userAgent: 'codex_cli/0.144.0 (darwin; arm64) node/v22.16.0',
    stainless: {
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.8.0',
      'x-stainless-os': 'MacOS',
      'x-stainless-arch': 'arm64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.16.0',
      'x-stainless-async': 'false',
      'x-stainless-retry-count': '0',
    },
    extra: {
      'x-codex-session-id': '',
      'openai-organization': '',
      'openai-project': '',
    },
  },
  'claude-code': {
    userAgent: 'claude-code/1.0.33 (darwin; arm64) node/v22.16.0',
    stainless: {
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.39.0',
      'x-stainless-os': 'MacOS',
      'x-stainless-arch': 'arm64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.16.0',
      'x-stainless-async': 'false',
      'x-stainless-retry-count': '0',
    },
    extra: {
      'anthropic-beta': 'interleaved-thinking-2025-05-14,prompt-caching-2024-07-31,code-execution-2025-01-15',
      'x-app': 'claude-code',
    },
  },
  cursor: {
    userAgent: 'cursor/0.51.0 (darwin; arm64)',
    stainless: {
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.8.0',
      'x-stainless-os': 'MacOS',
      'x-stainless-arch': 'arm64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.16.0',
      'x-stainless-async': 'false',
      'x-stainless-retry-count': '0',
    },
    extra: {
      'x-cursor-session-id': '',
      'x-cursor-client-version': '0.51.0',
    },
  },
};

let cachedSessionId: string | null = null;

function getSessionId(): string {
  if (!cachedSessionId) {
    cachedSessionId = randomUUID().replace(/-/g, '').slice(0, 24);
  }
  return cachedSessionId;
}

/**
 * 构建 AI 编码工具身份 headers
 * @param profile 工具标识，默认 "codex"
 */
export function buildIdentityHeaders(profile = 'codex'): Record<string, string> {
  const config = PROFILES[profile] ?? PROFILES.codex;
  const sessionId = getSessionId();
  const headers: Record<string, string> = {
    'User-Agent': config.userAgent,
    ...config.stainless,
  };

  for (const [key, value] of Object.entries(config.extra)) {
    if (value === '') {
      if (key.includes('session')) {
        headers[key] = sessionId;
      }
    } else {
      headers[key] = value;
    }
  }

  return headers;
}

const IDENTITY_HEADER_PATTERN = /^(user-agent|x-stainless-|x-codex-|x-cursor-|x-app$|openai-organization|openai-project|anthropic-beta)/i;

/**
 * 从 StandardRequest.metadata.rawHeaders 中提取身份相关 headers
 */
export function extractIdentityHeaders(request: { metadata?: { rawHeaders?: unknown } }): Record<string, string> {
  const raw = request.metadata?.rawHeaders;
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, string>)) {
    if (typeof value === 'string' && IDENTITY_HEADER_PATTERN.test(key)) {
      result[key] = value;
    }
  }
  return result;
}
