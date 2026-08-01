/**
 * Logging middleware — records request metadata and duration
 */

import type { Logger } from '../../logging/logger.js';
import type { StandardRequest } from '../../protocol/standard-request.js';

export interface GatewayLogContext {
  log: Logger;
  request?: StandardRequest;
  startTime: number;
}

export async function loggingMiddleware(
  ctx: Record<string, unknown>,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const logCtx = ctx.log as Logger | undefined;
  const req = ctx.request as StandardRequest | undefined;

  if (logCtx && req) {
    logCtx.info(
      'Gateway request: agent=%s model=%s stream=%s tools=%d',
      req.agent ?? 'unknown',
      req.model ?? 'unknown',
      req.stream ?? false,
      req.tools.length ?? 0,
    );
  }

  const startTime = Date.now();
  const result = await next();

  if (logCtx) {
    const duration = Date.now() - startTime;
    logCtx.info('Gateway response: duration=%dms', duration);
  }

  return result;
}
