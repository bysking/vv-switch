/**
 * 协议日志写入器
 *
 * 每次链路调用创建一个实例 → 一个 jsonl 文件。
 * 每个 phase（ingress/standard/upstream/egress/error）立即 append 一行，
 * 流式长请求中途崩溃也能保留已记录的阶段。
 *
 * 文件名：<outputDir>/<YYYYMMDD-HHMMSS-mmm>-<caller>-<shortTraceId>.jsonl
 */

import fs from 'fs';
import path from 'path';
import type { StandardRequest } from '../protocol/standard-request.js';
import { redactHeaders, safeParseBody } from './redact.js';

export interface ProtocolLoggerOptions {
  outputDir: string;
  traceId: string;
  caller: string;
  agent: string;
  /** 初始 model（通常为客户端 body.model 或默认模型）；parseRequest 后用 setModel 更新为实际模型 */
  model: string;
  stream: boolean;
  captureBody: boolean;
}

export interface ProtocolTrace {
  traceId: string;
  caller: string;
  agent: string;
  model: string;
  stream: boolean;
  logger: ProtocolLogger;
}

function nowTimestamp(): string {
  const d = new Date();
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  };
  const parts = new Intl.DateTimeFormat('sv-SE', opts).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function fileTimestamp(): string {
  const d = new Date();
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  };
  const parts = new Intl.DateTimeFormat('sv-SE', opts).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}-${get('fractionalSecond')}`;
}

export class ProtocolLogger {
  readonly traceId: string;
  readonly caller: string;
  readonly agent: string;
  /** 实际模型，parseRequest 后可能更新（客户端 body.model 与上游 model 常不同） */
  model: string;
  readonly stream: boolean;
  private readonly outputDir: string;
  private readonly captureBody: boolean;
  private readonly logFile: string;

  constructor(opts: ProtocolLoggerOptions) {
    this.traceId = opts.traceId;
    this.caller = opts.caller;
    this.agent = opts.agent;
    this.model = opts.model;
    this.stream = opts.stream;
    this.outputDir = opts.outputDir;
    this.captureBody = opts.captureBody;

    const shortId = opts.traceId.length > 8 ? opts.traceId.slice(-8) : opts.traceId;
    this.logFile = path.join(this.outputDir, `${fileTimestamp()}-${opts.caller}-${shortId}.jsonl`);
  }

  getLogFile(): string {
    return this.logFile;
  }

  /** parseRequest 后更新为 StandardRequest.model（供应商实际模型） */
  setModel(model: string): void {
    this.model = model;
  }

  private write(phase: string, data: Record<string, unknown>): void {
    const line =
      JSON.stringify({
        traceId: this.traceId,
        phase,
        ts: nowTimestamp(),
        caller: this.caller,
        agent: this.agent,
        model: this.model,
        stream: this.stream,
        ...data,
      }) + '\n';
    try {
      fs.appendFileSync(this.logFile, line);
    } catch {
      // 写盘失败不影响主链路
    }
  }

  ingress(data: { endpoint: string; body: unknown; headers?: unknown }): void {
    this.write('ingress', {
      endpoint: data.endpoint,
      headers: data.headers ? redactHeaders(data.headers) : undefined,
      body: this.captureBody ? safeParseBody(data.body) : this.summarizeBody(data.body),
    });
  }

  standard(request: StandardRequest): void {
    // 剔除 raw（ingress 已记原始 body）和 metadata.protocolTrace（内部引用，含 logger/logFile，不可序列化）
    // 对 metadata.rawHeaders 脱敏（codex/openai route 会把 authorization 放进 rawHeaders）
    const { raw: _raw, metadata, ...rest } = request;
    const { protocolTrace: _trace, rawHeaders, ...cleanMeta } = metadata || {};
    const metaClean = rawHeaders
      ? { ...cleanMeta, rawHeaders: redactHeaders(rawHeaders) }
      : cleanMeta;
    const requestClean = { ...rest, metadata: metaClean };
    this.write('standard', {
      request: this.captureBody ? requestClean : this.summarizeStandard(rest as Record<string, unknown>),
    });
  }

  upstream(data: {
    url: string;
    method: string;
    headers?: unknown;
    body: unknown;
    responseStatus: number;
    durationMs?: number;
    note?: string;
  }): void {
    this.write('upstream', {
      url: data.url,
      method: data.method,
      headers: data.headers ? redactHeaders(data.headers) : undefined,
      body: this.captureBody ? safeParseBody(data.body) : this.summarizeBody(data.body),
      responseStatus: data.responseStatus,
      durationMs: data.durationMs,
      note: data.note,
    });
  }

  egress(data: { responseStatus: number; durationMs: number; summary?: unknown; error?: string }): void {
    this.write('egress', {
      responseStatus: data.responseStatus,
      durationMs: data.durationMs,
      summary: data.summary,
      error: data.error,
    });
  }

  error(data: { message: string; phase?: string; durationMs?: number }): void {
    this.write('error', {
      message: data.message,
      phase: data.phase,
      durationMs: data.durationMs,
    });
  }

  close(): void {
    // appendFileSync 无需 close
  }

  private summarizeBody(body: unknown): unknown {
    if (body == null) return undefined;
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const summary: Record<string, unknown> = {};
        if ('model' in obj) summary.model = obj.model;
        if ('messages' in obj && Array.isArray(obj.messages)) summary.messagesCount = obj.messages.length;
        if ('tools' in obj && Array.isArray(obj.tools)) summary.toolsCount = obj.tools.length;
        if ('stream' in obj) summary.stream = obj.stream;
        summary._note = 'body capture disabled (--no-body)';
        return summary;
      }
    } catch {
      /* fall through */
    }
    return '<capture disabled>';
  }

  private summarizeStandard(req: Record<string, unknown>): unknown {
    return {
      model: req.model,
      agent: req.agent,
      stream: req.stream,
      messagesCount: Array.isArray(req.messages) ? (req.messages as unknown[]).length : 0,
      toolsCount: Array.isArray(req.tools) ? (req.tools as unknown[]).length : 0,
      capabilitiesRequired: req.capabilitiesRequired,
      _note: 'body capture disabled (--no-body)',
    };
  }
}

/** 协议日志保留的最大文件数(滑动窗口,默认 5) */
const MAX_PROTOCOL_LOGS = 5;

/**
 * 日志轮转:扫描 outputDir 下所有 .jsonl 协议日志文件,按文件名(时间戳前缀)排序,
 * 只保留最近 MAX_PROTOCOL_LOGS - 1 个旧文件,为即将创建的新文件留出位置。
 * 每次创建新 trace 时触发一次,保证窗口内始终不超过 MAX 条。
 */
function rotateProtocolLogs(outputDir: string): void {
  try {
    if (!fs.existsSync(outputDir)) return;
    const files = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.jsonl'))
      // 按文件名排序(文件名以时间戳开头,字典序即时间序)
      .sort();

    // 为即将创建的新文件预留一个位置,所以旧文件保留 MAX-1 条
    const keepOldCount = MAX_PROTOCOL_LOGS - 1;
    if (files.length <= keepOldCount) return;

    const toDelete = files.slice(0, files.length - keepOldCount);
    for (const f of toDelete) {
      try {
        fs.unlinkSync(path.join(outputDir, f));
      } catch {
        // 单个文件删除失败不影响整体
      }
    }
  } catch {
    // 轮转失败不影响主链路,静默忽略
  }
}

export function createProtocolTrace(opts: ProtocolLoggerOptions): ProtocolTrace {
  // 先清理旧日志,再创建新的,保证窗口内始终不超过 MAX 条
  rotateProtocolLogs(opts.outputDir);
  const logger = new ProtocolLogger(opts);
  return {
    traceId: opts.traceId,
    caller: opts.caller,
    agent: opts.agent,
    model: opts.model,
    stream: opts.stream,
    logger,
  };
}
