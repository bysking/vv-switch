/**
 * HTTP Server 入口
 *
 * 创建 Express App，挂载所有路由（codex / claude / models / health）。
 */

import express from 'express';
import type { Application } from 'express';
import path from 'path';
import type { ModelCapabilities } from '../types/provider.js';
import { RequestRouter } from '../router/request-router.js';
import { createLogger, ICON } from '../logging/logger.js';
import { LogWriter } from '../log-writer.js';
import { registerCodexRoute } from './routes/codex.js';
import { registerClaudeRoute } from './routes/claude.js';
import { registerOpenAIRoute } from './routes/openai.js';
import { registerModelsRoute } from './routes/models.js';
import { registerHealthRoute } from './routes/health.js';
import { loggingMiddleware } from '../middleware/logging.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import { retryMiddleware } from '../middleware/retry.js';
import { metricsMiddleware } from '../middleware/metrics.js';

export interface CreateAppConfig {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  defaultModel: string;
  protocolType?: string;
  modelCapabilities?: ModelCapabilities;
  debug?: boolean;
  logWriter?: LogWriter | null;
  captureBody?: boolean;
  /** 协议日志目录（null=关闭）。每次链路一个 jsonl，记录 ingress/standard/upstream/egress */
  protocolLogDir?: string | null;
}

export function createApp(config: CreateAppConfig): Application {
  const {
    upstreamBaseUrl,
    upstreamApiKey,
    defaultModel,
    protocolType = 'chat',
    modelCapabilities,
    debug = false,
    logWriter = null,
    captureBody = true,
    protocolLogDir = null,
  } = config;

  const log = createLogger(debug);

  const router = new RequestRouter({
    baseUrl: upstreamBaseUrl,
    apiKey: upstreamApiKey,
    model: defaultModel,
    protocolType,
    defaultModel,
    modelCapabilities,
  });

  // Register middleware on Gateway
  router.gateway.use(loggingMiddleware);
  router.gateway.use(authMiddleware());
  router.gateway.use(rateLimitMiddleware({ maxRequests: 100, windowMs: 60_000 }));
  router.gateway.use(retryMiddleware({ maxAttempts: 2 }));
  router.gateway.use(metricsMiddleware());

  const app = express();
  app.use(express.json({ limit: '512mb' }));

  const routeOptions = {
    router,
    log,
    protocolType,
    defaultModel,
    logWriter,
    captureBody,
    protocolLogDir,
  };

  registerCodexRoute(app, routeOptions);
  registerClaudeRoute(app, routeOptions);
  registerOpenAIRoute(app, routeOptions);
  registerModelsRoute(app, router);
  registerHealthRoute(app);

  return app;
}

export interface StartServerConfig extends CreateAppConfig {
  host?: string;
  port?: number;
  logs?: boolean;
  logsDir?: string | null;
}

export function startServer(config: StartServerConfig) {
  const {
    upstreamBaseUrl,
    upstreamApiKey,
    host = 'localhost',
    port = 4321,
    debug = false,
    logs = false,
    logsDir = null,
    captureBody = true,
  } = config;

  const log = createLogger(debug);

  if (!upstreamBaseUrl) {
    log.error('UPSTREAM_BASE_URL is required');
    process.exit(1);
  }
  if (!upstreamApiKey) {
    log.error('UPSTREAM_API_KEY is required');
    process.exit(1);
  }

  let logWriter: LogWriter | null = null;
  if (logs) {
    const outputDir = logsDir || path.join(process.cwd(), '.vv-switch-logs');
    logWriter = new LogWriter(outputDir);
    log.info(`${ICON.log} Log viewer enabled: ${outputDir}`);
    log.info(`${ICON.log} Open file://${path.join(outputDir, 'index.html')} in your browser to view logs`);
  }

  const app = createApp({ ...config, logWriter, captureBody });

  log.info(`${ICON.reqStart} Starting vv-switch on ${host}:${port}`);
  log.info(`${ICON.proxy} Upstream: ${upstreamBaseUrl}`);

  const server = app.listen(port, host, () => {
    log.info(`${ICON.ok} Server running on http://${host}:${port}`);
  });

  let shuttingDown = false;
  function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${ICON.warn} ${signal} received, shutting down...`);
    server.close(async () => {
      if (logWriter) await logWriter.close();
      log.info(`${ICON.ok} Server closed`);
      process.exit(0);
    });
    // 兜底：3 秒后强制退出，避免连接迟迟不关闭
    setTimeout(() => {
      log.error('Forced shutdown after timeout');
      process.exit(1);
    }, 3000).unref();
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  return server;
}
