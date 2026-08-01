/**
 * /v1/chat/completions — OpenAI Chat Completions 端点
 *
 * 面向直连 chat/completions 的客户端（如 VS Code Copilot 自定义端点）。
 */

import type { Application, Request, Response } from 'express';
import { RequestRouter } from '../../router/request-router.js';
import { setupSseHeaders, pipeSseToResponse } from '../sse.js';
import { makeId } from '../../utils/id.js';
import { summarizeToolArgs, isShellTool } from '../../utils/tool-summary.js';
import { applyPromptRulesToChatBody } from '../../prompt-rules-manager.js';
import type { Logger } from '../../logging/logger.js';
import { formatTimestamp, ICON } from '../../logging/logger.js';
import { createProtocolTrace, type ProtocolTrace } from '../../protocol-log/index.js';
import { buildIdentityHeaders } from '../../utils/identity.js';

export interface OpenAIRouteOptions {
  router: RequestRouter;
  log: Logger;
  protocolType: string;
  defaultModel: string;
  logWriter?: { write: (entry: unknown) => Promise<void> | void; writeSummary: (entry: unknown) => void } | null;
  captureBody?: boolean;
  /** 协议日志目录（null=关闭）。每次链路一个 jsonl，记录 ingress/standard/upstream/egress */
  protocolLogDir?: string | null;
}

export function registerOpenAIRoute(app: Application, options: OpenAIRouteOptions): void {
  const { router, log, protocolType, defaultModel, logWriter = null, captureBody = true, protocolLogDir = null } = options;

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const body = applyPromptRulesToChatBody(req.body || {}) as Record<string, unknown>;
    const stream = Boolean(body.stream);
    const reqId = makeId('chatcmpl');
    const startTime = Date.now();

    // 协议日志 trace（与 --logs 会话日志独立）
    const trace: ProtocolTrace | null = protocolLogDir
      ? createProtocolTrace({
          outputDir: protocolLogDir,
          traceId: reqId,
          caller: 'openai',
          agent: 'openai',
          model: (body as { model?: string }).model || defaultModel || '',
          stream,
          captureBody,
        })
      : null;
    trace?.logger.ingress({ endpoint: '/v1/chat/completions', body, headers: req.headers });

    // 透传客户端 headers（如 authorization），但 provider 应使用 vv-switch 配置的 API key 覆盖
    const extraHeaders: Record<string, string> = {};
    for (const key of ['authorization']) {
      const val = req.headers[key];
      if (typeof val === 'string') extraHeaders[key] = val;
    }

    // 注入 AI 编码工具身份 headers，使上游供应商识别为 AI 终端请求
    Object.assign(extraHeaders, buildIdentityHeaders());

    const context = {
      id: reqId,
      defaultModel,
      headers: extraHeaders,
    };

    let stdReq;
    try {
      stdReq = router.parseRequest('openai', body, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`${ICON.error} Failed to parse OpenAI request: %s`, message);
      trace?.logger.error({ message: `parseRequest failed: ${message}`, phase: 'standard', durationMs: Date.now() - startTime });
      res.status(400).json({ error: { message } });
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
      `${ICON.request} OpenAI Request: model=%s stream=%s protocol=%s tools=%d`,
      model, stream, protocolType, stdReq.tools.length,
    );

    const logEntry = {
      timestamp: formatTimestamp(),
      method: 'POST',
      endpoint: '/v1/chat/completions',
      caller: 'openai',
      model,
      stream,
      protocolType,
      reasoningEffort: stdReq.parameters.reasoningEffort ?? null,
      requestBody: captureBody ? body : undefined,
    };

    if (stream) {
      setupSseHeaders(res, reqId);
      log.info(`${ICON.streamStart} openai-route | stream open | reqId=%s`, reqId);

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
        const sseStream = router.serializeStream('openai', eventStream, context);
        const status = await pipeSseToResponse(sseStream, res, {
          errorPatterns: ['"error"'],
          collect: captureBody ? collected : undefined,
        });
        log.info(
          `${ICON.streamDone} openai-route | stream done | status=%d duration=%dms`,
          status, Date.now() - startTime,
        );
        if (logWriter) {
          await logWriter.write({
            ...logEntry,
            responseStatus: status,
            durationMs: Date.now() - startTime,
            responseText: captureBody ? collected.join('') : undefined,
          });
          logWriter.writeSummary({ ...logEntry, responseStatus: status, durationMs: Date.now() - startTime });
        }
        trace?.logger.egress({ responseStatus: status, durationMs: Date.now() - startTime });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${ICON.error} OpenAI stream error: %s`, message);
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
      log.info(`${ICON.reqStart} openai-route | non-stream | reqId=%s`, reqId);
      const stdResp = await router.chat(stdReq);
      const apiResp = router.serializeResponse('openai', stdResp, context);
      if (stdResp.toolCalls.length > 0) {
        log.info(
          `${ICON.toolEnd} openai-route | ${stdResp.toolCalls.length} tool_call(s) in this turn:`,
        );
        for (const [i, tc] of stdResp.toolCalls.entries()) {
          const shellTag = isShellTool(tc.name) ? ' [💻 shell]' : '';
          log.info(
            `  ${ICON.toolEnd}  #${i + 1} ${tc.name}${shellTag} | ${summarizeToolArgs(tc.name, tc.arguments, 200)}`,
          );
        }
      }
      log.info(
        `${ICON.reqEnd} OpenAI response | duration=%dms in=%d out=%d`,
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
      log.error(`${ICON.error} OpenAI error: %s`, message);
      res.status(500).json({ error: { message } });
      if (logWriter) {
        await logWriter.write({ ...logEntry, responseStatus: 500, durationMs: Date.now() - startTime, error: message });
        logWriter.writeSummary({ ...logEntry, responseStatus: 500, durationMs: Date.now() - startTime });
      }
      trace?.logger.error({ message, phase: 'egress', durationMs: Date.now() - startTime });
    }
  });
}
