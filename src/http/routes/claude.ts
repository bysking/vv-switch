/**
 * /v1/messages — Claude 端点
 */

import express from 'express';
import type { Application, Request, Response, Router } from 'express';
import { RequestRouter } from '../../router/request-router.js';
import { applyPromptRulesToAnthropicBody } from '../../prompt-rules-manager.js';
import { setupSseHeaders, pipeSseToResponse } from '../sse.js';
import { mergeSseToSummary } from '../../utils/sse-merge.js';
import { makeId } from '../../utils/id.js';
import { summarizeToolArgs, isShellTool } from '../../utils/tool-summary.js';
import type { Logger } from '../../logging/logger.js';
import { formatTimestamp, ICON } from '../../logging/logger.js';
import { createProtocolTrace, type ProtocolTrace } from '../../protocol-log/index.js';

export interface ClaudeRouteOptions {
  router: RequestRouter;
  log: Logger;
  protocolType: string;
  defaultModel: string;
  logWriter?: { write: (entry: unknown) => Promise<void> | void; writeSummary: (entry: unknown) => void } | null;
  captureBody?: boolean;
  /** 协议日志目录（null=关闭）。每次链路一个 jsonl，记录 ingress/standard/upstream/egress */
  protocolLogDir?: string | null;
}

export function createClaudeRouter(options: ClaudeRouteOptions): Router {
  const { router, log, protocolType, defaultModel, logWriter = null, captureBody = true, protocolLogDir = null } = options;
  const r = express.Router();

  r.post('/v1/messages', async (req: Request, res: Response) => {
    const body = applyPromptRulesToAnthropicBody(req.body) as Record<string, unknown>;
    const stream = Boolean(body.stream);
    const msgId = makeId('msg');
    const startTime = Date.now();

    // 协议日志 trace（与 --logs 会话日志独立）
    const trace: ProtocolTrace | null = protocolLogDir
      ? createProtocolTrace({
          outputDir: protocolLogDir,
          traceId: msgId,
          caller: 'claude',
          agent: 'claude',
          model: (body as { model?: string }).model || defaultModel || '',
          stream,
          captureBody,
        })
      : null;
    trace?.logger.ingress({ endpoint: '/v1/messages', body, headers: req.headers });

    const extraHeaders: Record<string, string> = {};
    const beta = req.headers['anthropic-beta'];
    if (typeof beta === 'string') extraHeaders['anthropic-beta'] = beta;

    const context = {
      id: msgId,
      defaultModel,
      headers: extraHeaders,
    };

    let stdReq;
    try {
      stdReq = router.parseRequest('claude', body, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to parse Claude request: %s', message);
      trace?.logger.error({ message: `parseRequest failed: ${message}`, phase: 'standard', durationMs: Date.now() - startTime });
      res.status(400).json({ type: 'error', error: { type: 'api_error', message } });
      return;
    }

    // 挂载 trace，供 provider 的 upstreamFetch 读取；更新 model 为实际供应商模型
    if (trace) {
      stdReq.metadata.protocolTrace = trace;
      trace.logger.setModel(stdReq.model);
      trace.logger.standard(stdReq);
    }

    const model = stdReq.model;
    log.info(
      `${ICON.request} Claude Request: model=%s stream=%s protocol=%s messages=%d tools=%d`,
      model, stream, protocolType, stdReq.messages.length, stdReq.tools.length,
    );

    const logEntry = {
      timestamp: formatTimestamp(),
      method: 'POST',
      endpoint: '/v1/messages',
      caller: 'claude',
      model,
      stream,
      protocolType,
      inputType: typeof body.messages,
      requestBody: captureBody ? body : undefined,
    };

    if (stream) {
      setupSseHeaders(res, msgId);
      log.info(`${ICON.streamStart} claude-route | stream open | msgId=%s`, msgId);

      // 客户端断开连接时,通过 AbortController 取消上游 fetch 请求,
      // 避免"客户端已经停了,后台还一直在收响应"的资源浪费。
      const abortController = new AbortController();
      const onAbort = (): void => {
        if (!abortController.signal.aborted) abortController.abort();
      };
      res.on('close', onAbort);
      (stdReq.metadata as Record<string, unknown>).abortSignal = abortController.signal;

      const collected: string[] = [];
      try {
        const eventStream = router.stream(stdReq);
        const sseStream = router.serializeStream('claude', eventStream, context);
        const status = await pipeSseToResponse(sseStream, res, {
          collect: captureBody ? collected : undefined,
        });
        log.info(
          `${ICON.streamDone} claude-route | stream done | status=%d duration=%dms`,
          status, Date.now() - startTime,
        );
        const summary = captureBody ? mergeSseToSummary(collected.join(''), 'claude') : null;
        if (summary && summary.toolCalls.length > 0) {
          log.info(
            `${ICON.toolEnd} claude-route | ${summary.toolCalls.length} tool_call(s) in this turn:`,
          );
          for (const [i, tc] of summary.toolCalls.entries()) {
            const shellTag = isShellTool(tc.name) ? ' [💻 shell]' : '';
            log.info(
              `  ${ICON.toolEnd}  #${i + 1} ${tc.name}${shellTag} | ${summarizeToolArgs(tc.name, tc.arguments, 200)}`,
            );
          }
        }
        if (logWriter) {
          await logWriter.write({
            ...logEntry,
            responseStatus: status,
            durationMs: Date.now() - startTime,
            responseText: summary?.responseText,
            toolCalls: summary?.toolCalls,
            thinkingText: summary?.thinkingText,
            inputTokens: summary?.usage?.inputTokens,
            outputTokens: summary?.usage?.outputTokens,
            stopReason: summary?.stopReason,
            sseEventCount: summary?.eventCount,
          });
          logWriter.writeSummary({ ...logEntry, responseStatus: status, durationMs: Date.now() - startTime });
        }
        trace?.logger.egress({
          responseStatus: status,
          durationMs: Date.now() - startTime,
          summary: summary
            ? {
                stopReason: summary.stopReason,
                toolCalls: summary.toolCalls,
                inputTokens: summary.usage?.inputTokens,
                outputTokens: summary.usage?.outputTokens,
              }
            : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${ICON.error} claude-route | STREAM ERROR: %s`, message);
        if (!res.writableEnded) res.end();
        if (logWriter) {
          await logWriter.write({ ...logEntry, responseStatus: 500, durationMs: Date.now() - startTime, error: message });
          logWriter.writeSummary({ ...logEntry, responseStatus: 500, durationMs: Date.now() - startTime });
        }
        trace?.logger.error({ message, phase: 'egress', durationMs: Date.now() - startTime });
      }
      return;
    }

    try {
      log.info(`${ICON.reqStart} claude-route | non-stream | msgId=%s`, msgId);
      const stdResp = await router.chat(stdReq);
      const apiResp = router.serializeResponse('claude', stdResp, context);
      if (stdResp.toolCalls.length > 0) {
        log.info(
          `${ICON.toolEnd} claude-route | ${stdResp.toolCalls.length} tool_call(s) in this turn:`,
        );
        for (const [i, tc] of stdResp.toolCalls.entries()) {
          const shellTag = isShellTool(tc.name) ? ' [💻 shell]' : '';
          log.info(
            `  ${ICON.toolEnd}  #${i + 1} ${tc.name}${shellTag} | ${summarizeToolArgs(tc.name, tc.arguments, 200)}`,
          );
        }
      }
      log.info(
        `${ICON.reqEnd} Claude response | duration=%dms in=%d out=%d`,
        Date.now() - startTime, stdResp.usage.inputTokens, stdResp.usage.outputTokens,
      );
      res.json(apiResp);
      if (logWriter) {
        await logWriter.write({
          ...logEntry,
          responseStatus: 200,
          durationMs: Date.now() - startTime,
          inputTokens: stdResp.usage.inputTokens,
          outputTokens: stdResp.usage.outputTokens,
          responseText: stdResp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
          toolCalls: stdResp.toolCalls,
          stopReason: stdResp.stopReason,
        });
        logWriter.writeSummary({ ...logEntry, responseStatus: 200, durationMs: Date.now() - startTime });
      }
      trace?.logger.egress({
        responseStatus: 200,
        durationMs: Date.now() - startTime,
        summary: {
          stopReason: stdResp.stopReason,
          toolCalls: stdResp.toolCalls,
          inputTokens: stdResp.usage.inputTokens,
          outputTokens: stdResp.usage.outputTokens,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`${ICON.error} Claude error: %s`, message);
      res.status(500).json({ type: 'error', error: { type: 'api_error', message } });
      if (logWriter) {
        await logWriter.write({ ...logEntry, responseStatus: 500, durationMs: Date.now() - startTime, error: message });
        logWriter.writeSummary({ ...logEntry, responseStatus: 500, durationMs: Date.now() - startTime });
      }
      trace?.logger.error({ message, phase: 'egress', durationMs: Date.now() - startTime });
    }
  });

  // GET /v1/messages — mock 健康检查
  r.get('/v1/messages', (_req: Request, res: Response) => {
    res.json({ type: 'list', data: [{ id: defaultModel, type: 'model', display_name: defaultModel }] });
  });

  // POST /v1/messages/count_tokens — 简单估算
  r.post('/v1/messages/count_tokens', (req: Request, res: Response) => {
    const body = req.body || {};
    const text = typeof body.messages === 'string' ? body.messages : JSON.stringify(body.messages || '');
    const estimatedTokens = Math.ceil(text.length * 0.25);
    res.json({ input_tokens: estimatedTokens });
  });

  return r;
}

export function registerClaudeRoute(app: Application, options: ClaudeRouteOptions): void {
  app.use(createClaudeRouter(options));
}
