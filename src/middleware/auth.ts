/**
 * Auth middleware — validates API key in request metadata
 */

import { AuthenticationError } from '../core/errors.js';

export interface AuthConfig {
  requiredApiKey?: string;
}

export function authMiddleware(config: AuthConfig = {}) {
  return async (ctx: Record<string, unknown>, next: () => Promise<unknown>): Promise<unknown> => {
    if (config.requiredApiKey) {
      const headers = ctx.headers as Record<string, string> | undefined;
      const providedKey = headers?.['x-api-key'] ?? headers?.['authorization']?.replace(/^Bearer\s+/, '');
      if (!providedKey || providedKey !== config.requiredApiKey) {
        throw new AuthenticationError('Invalid or missing API key');
      }
    }
    return next();
  };
}
