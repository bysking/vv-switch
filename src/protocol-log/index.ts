/**
 * 协议日志模块入口
 *
 * 提供协议转换链路的三阶段日志：
 *   ingress  — 客户端原始请求协议（Claude/Codex/OpenAI 端点拿到的 body）
 *   standard — adapter 转换后的 StandardRequest（内部统一协议）
 *   upstream — provider 中转到上游供应商的 url/headers/body + 响应 status
 *
 * 每次链路调用一个 jsonl 文件，由 ProtocolLogger 写入。
 */

export { ProtocolLogger, createProtocolTrace } from './protocol-logger.js';
export type { ProtocolLoggerOptions, ProtocolTrace } from './protocol-logger.js';
export { upstreamFetch } from './upstream-fetch.js';
export { redactHeaders, safeParseBody } from './redact.js';
