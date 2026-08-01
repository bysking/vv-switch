/**
 * /v1/models — 模型列表端点
 */

import type { Application, Request, Response } from 'express';
import type { RequestRouter } from '../../router/request-router.js';

export function registerModelsRoute(app: Application, router: RequestRouter): void {
  app.get('/v1/models', async (_req: Request, res: Response) => {
    try {
      const models = await router.models();
      res.json(models);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { message } });
    }
  });
}
