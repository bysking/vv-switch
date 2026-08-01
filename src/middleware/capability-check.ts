/**
 * Capability check middleware — ensures provider supports required capabilities
 */

import { Gateway } from '../core/gateway.js';
import { UnsupportedCapabilityError } from '../core/errors.js';
import type { StandardRequest } from '../protocol/standard-request.js';
import type { CapabilityMap } from '../types/gateway.js';

export async function capabilityCheckMiddleware(
  ctx: Record<string, unknown>,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const gateway = ctx.gateway as Gateway | undefined;
  const request = ctx.request as StandardRequest | undefined;

  if (!gateway || !request) {
    return next();
  }

  // Check each required capability
  for (const cap of request.capabilitiesRequired) {
    const capKey = cap as keyof CapabilityMap;
    const discovery = await gateway.discover();
    const status = discovery.capabilities[capKey];

    if (status === 'unsupported' || status == null) {
      throw new UnsupportedCapabilityError(
        `Provider ${discovery.provider} does not support ${cap}`,
      );
    }
  }

  return next();
}
