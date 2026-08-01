/**
 * Gateway 统一错误类型
 */

export interface GatewayErrorOptions {
  type?: string;
  status?: number;
  cause?: unknown;
}

export class GatewayError extends Error {
  public readonly type: string;
  public readonly status: number;
  public readonly cause?: unknown;

  constructor(message: string, options: GatewayErrorOptions = {}) {
    super(message);
    this.name = this.constructor.name;
    this.type = options.type ?? this.constructor.name;
    this.status = options.status ?? 500;
    this.cause = options.cause;
  }
}

export class ProviderUnavailable extends GatewayError {
  constructor(message = 'Provider unavailable', options: GatewayErrorOptions = {}) {
    super(message, { status: 503, ...options, type: 'ProviderUnavailable' });
  }
}

export class AuthenticationError extends GatewayError {
  constructor(message = 'Authentication failed', options: GatewayErrorOptions = {}) {
    super(message, { status: 401, ...options, type: 'AuthenticationError' });
  }
}

export class RateLimitError extends GatewayError {
  constructor(message = 'Rate limited', options: GatewayErrorOptions = {}) {
    super(message, { status: 429, ...options, type: 'RateLimit' });
  }
}

export class TimeoutError extends GatewayError {
  constructor(message = 'Request timed out', options: GatewayErrorOptions = {}) {
    super(message, { status: 504, ...options, type: 'Timeout' });
  }
}

export class ToolError extends GatewayError {
  constructor(message = 'Tool error', options: GatewayErrorOptions = {}) {
    super(message, { status: 400, ...options, type: 'ToolError' });
  }
}

export class UnsupportedCapabilityError extends GatewayError {
  constructor(message = 'Unsupported capability', options: GatewayErrorOptions = {}) {
    super(message, { status: 400, ...options, type: 'UnsupportedCapability' });
  }
}

export class ProtocolError extends GatewayError {
  constructor(message = 'Protocol error', options: GatewayErrorOptions = {}) {
    super(message, { status: 400, ...options, type: 'ProtocolError' });
  }
}

export function normalizeGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const message = error instanceof Error ? error.message : String(error || 'Provider error');
  return new ProviderUnavailable(message, { cause: error });
}
