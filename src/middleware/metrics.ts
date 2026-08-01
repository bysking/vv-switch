/**
 * Metrics middleware — tracks request duration and error counts
 */

export interface MetricsStore {
  totalRequests: number;
  totalDurationMs: number;
  errors: number;
  byModel: Map<string, { count: number; avgDurationMs: number }>;
}

const globalMetrics: MetricsStore = {
  totalRequests: 0,
  totalDurationMs: 0,
  errors: 0,
  byModel: new Map(),
};

export function metricsMiddleware() {
  return async (ctx: Record<string, unknown>, next: () => Promise<unknown>): Promise<unknown> => {
    const start = Date.now();
    globalMetrics.totalRequests += 1;

    try {
      const result = await next();
      const duration = Date.now() - start;
      globalMetrics.totalDurationMs += duration;

      // Update per-model stats
      const req = ctx.request as { model?: string } | undefined;
      const model = req?.model ?? 'unknown';
      const existing = globalMetrics.byModel.get(model);
      if (existing) {
        const newCount = existing.count + 1;
        const newAvg = ((existing.avgDurationMs * existing.count) + duration) / newCount;
        globalMetrics.byModel.set(model, { count: newCount, avgDurationMs: newAvg });
      } else {
        globalMetrics.byModel.set(model, { count: 1, avgDurationMs: duration });
      }

      return result;
    } catch (err) {
      globalMetrics.errors += 1;
      throw err;
    }
  };
}

export function getMetrics(): MetricsStore {
  return globalMetrics;
}
