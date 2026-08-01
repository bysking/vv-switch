/**
 * Gateway 配置
 */

import type { ProviderConfig } from './provider.js';

export interface GatewayConfig extends ProviderConfig {
  /** 用于自定义中间件 */
  middlewares?: unknown[];
  /** 控制重试 */
  retryAttempts?: number;
  /** 控制超时（毫秒） */
  timeoutMs?: number;
  /** 调试日志 */
  debug?: boolean;
}
