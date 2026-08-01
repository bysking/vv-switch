/**
 * Server-Sent Events 工具
 *
 * 用于将 Adapter 输出的 SSE 字符串流写入 Express Response。
 */

import type { Response } from 'express';
import { ICON } from '../logging/icons.js';

export function setupSseHeaders(res: Response, requestId = ''): void {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Request-Id': requestId,
  });
}

/**
 * 格式化 OpenAI Responses API 风格的 SSE 事件（只有 data 行）
 */
export function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * 格式化 Anthropic Messages API 风格的 SSE 事件（带 event 行）
 */
export function sseEvent(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 将 Adapter 的 SSE 字符串流写入 Response
 * @returns 上游推断状态码（用于日志）
 */
export interface PipeSseOptions {
  errorPatterns?: string[];
  /** 同时把每个 chunk 收进这个数组（按写入顺序),用于落日志。 */
  collect?: string[];
  /** collect 数组所有字符串拼起来超过这个长度时停止再 push,避免日志过大。默认 1 MiB。 */
  collectMaxBytes?: number;
}

export async function pipeSseToResponse(
  chunks: AsyncIterable<string>,
  res: Response,
  options: PipeSseOptions = {},
): Promise<number> {
  const {
    errorPatterns = ['"type":"response.failed"', '"type":"error"'],
    collect,
    collectMaxBytes = 1024 * 1024,
  } = options;
  let upstreamStatus = 200;
  let chunkCount = 0;
  let totalBytes = 0;
  let collectedBytes = 0;
  let collectTruncated = false;
  let abortedByClient = false;
  const t0 = Date.now();
  console.log(`${ICON.streamStart} [vv-switch] [sse-pipe] open`);

  // 客户端(codex/claude/openai)中断或断开连接时:标记并唤醒阻塞中的 next(),让循环尽快退出,
  // 停止消费上游与刷日志——否则会出现“客户端已停、代理还在跑/一直刷调用”的现象。
  let notifyAbort: (() => void) | undefined;
  const abortSignal = new Promise<void>((resolve) => { notifyAbort = resolve; });
  const onClose = (): void => {
    if (!res.writableEnded) {
      abortedByClient = true;
      notifyAbort?.();
    }
  };
  res.on('close', onClose);

  type Iter = AsyncIterator<string> & { return?: (value?: unknown) => Promise<IteratorResult<string>> };
  const iterator = chunks[Symbol.asyncIterator]() as Iter;
  const abortedSentinel: IteratorResult<string> = { done: true, value: undefined };

  try {
    while (true) {
      if (abortedByClient || res.writableEnded || res.destroyed) break;
      // 与中断信号竞速:客户端断开时立即结束等待,而不必等上游下一个 chunk
      const result = await Promise.race([
        iterator.next(),
        abortSignal.then(() => abortedSentinel),
      ]);
      if (result.done) break;
      const chunk = result.value;
      chunkCount++;
      totalBytes += chunk.length;
      if (collect && !collectTruncated) {
        if (collectedBytes + chunk.length <= collectMaxBytes) {
          collect.push(chunk);
          collectedBytes += chunk.length;
        } else {
          collect.push(`...[truncated at ${collectedBytes} bytes]\n`);
          collectTruncated = true;
        }
      }
      if (chunkCount <= 3 || chunkCount % 50 === 0) {
        console.log(`${ICON.streamChunk} [vv-switch] [sse-pipe] chunk #${chunkCount} | bytes=${chunk.length} | total=${totalBytes}`);
      }
      if (res.writableEnded || res.destroyed) {
        console.warn(`${ICON.warn} [vv-switch] [sse-pipe] response already ended at chunk #${chunkCount}`);
        break;
      }
      res.write(chunk);
      for (const pattern of errorPatterns) {
        if (chunk.includes(pattern)) {
          upstreamStatus = 500;
          break;
        }
      }
    }
  } finally {
    res.off('close', onClose);
    // 通知上游迭代器收尾:async generator 的 finally 会执行 reader.cancel(),从而中止上游 SSE 拉取。
    // 用短超时兜底,避免上游空闲(暂无新 chunk)时 .return() 一直挂起。
    if (iterator.return) {
      try {
        await Promise.race([
          iterator.return(),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch { /* ignore */ }
    }
  }

  const doneIcon = upstreamStatus === 200 ? ICON.streamDone : ICON.error;
  console.log(`${doneIcon} [vv-switch] [sse-pipe] done | chunks=${chunkCount} | bytes=${totalBytes} | status=${upstreamStatus} | aborted=${abortedByClient} | duration=${Date.now() - t0}ms`);
  if (!res.writableEnded && !res.destroyed) {
    try { res.end(); } catch { /* 客户端可能已离开 */ }
  }
  return upstreamStatus;
}
