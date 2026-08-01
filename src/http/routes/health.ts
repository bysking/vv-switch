/**
 * /health — 健康检查端点
 */

import type { Application, Request, Response } from 'express';

export function registerHealthRoute(app: Application, version = '0.5.0'): void {
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version });
  });
}
