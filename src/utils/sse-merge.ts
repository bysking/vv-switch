/**
 * Merge a raw SSE byte stream (collected via pipeSseToResponse `collect`)
 * back into a structured summary, so the log entry stores the assistant's
 * answer the same way the non-stream branch does:
 *
 *   { responseText, toolCalls, usage, stopReason }
 *
 * Supports both Claude (Anthropic Messages) and Codex (OpenAI Responses)
 * SSE shapes. Falls back to an empty summary on parse failure.
 */

export interface SseSummary {
  responseText: string;
  /** Tool calls reconstructed from the stream (id, name, arguments string). */
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  /** Reasoning / thinking text aggregated, if present. */
  thinkingText?: string;
  usage?: { inputTokens: number; outputTokens: number };
  stopReason?: string;
  /** Number of SSE events we walked through, for diagnostics. */
  eventCount: number;
}

interface SseEvent {
  event?: string;
  data: unknown;
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Split a concatenated SSE byte buffer back into events.
 * Each event is separated by a blank line ('\n\n'). Within an event,
 * 'event: <name>' and 'data: <json>' lines may appear in any order.
 */
function parseEvents(sse: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of sse.split(/\n\n+/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    const dataStr = dataLines.join('\n');
    if (dataStr === '[DONE]') continue;
    events.push({ event: eventName, data: safeJsonParse(dataStr) ?? dataStr });
  }
  return events;
}

function mergeClaudeEvents(events: SseEvent[]): SseSummary {
  // Anthropic Messages SSE shape:
  //   message_start          -> { message: { id, model, usage } }
  //   content_block_start    -> { index, content_block: { type, ... } }
  //   content_block_delta    -> { index, delta: { type, text?, partial_json?, thinking? } }
  //   content_block_stop     -> { index }
  //   message_delta          -> { delta: { stop_reason }, usage: { output_tokens } }
  //   message_stop
  type Block =
    | { type: 'text'; text: string }
    | { type: 'thinking'; text: string }
    | { type: 'tool_use'; id: string; name: string; args: string };
  const blocks = new Map<number, Block>();
  let stopReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const type = (e.event || (d as { type?: string }).type || '') as string;
    switch (type) {
      case 'message_start': {
        const msg = (d.message ?? {}) as { usage?: { input_tokens?: number; output_tokens?: number } };
        if (msg.usage) {
          inputTokens = msg.usage.input_tokens ?? inputTokens;
          outputTokens = msg.usage.output_tokens ?? outputTokens;
        }
        break;
      }
      case 'content_block_start': {
        const idx = Number(d.index ?? 0);
        const cb = (d.content_block ?? {}) as Record<string, unknown>;
        if (cb.type === 'text') blocks.set(idx, { type: 'text', text: '' });
        else if (cb.type === 'thinking') blocks.set(idx, { type: 'thinking', text: '' });
        else if (cb.type === 'tool_use') {
          blocks.set(idx, { type: 'tool_use', id: String(cb.id ?? ''), name: String(cb.name ?? ''), args: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const idx = Number(d.index ?? 0);
        const delta = (d.delta ?? {}) as Record<string, unknown>;
        const block = blocks.get(idx);
        if (!block) break;
        if (delta.type === 'text_delta' && block.type === 'text') {
          block.text += String(delta.text ?? '');
        } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
          block.text += String(delta.thinking ?? delta.text ?? '');
        } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
          block.args += String(delta.partial_json ?? '');
        }
        break;
      }
      case 'message_delta': {
        const delta = (d.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
        const usage = (d.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
        if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
        if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
        break;
      }
      default:
        // ignore ping / message_stop / unknown
        break;
    }
  }

  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const text = ordered.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('');
  const thinking = ordered.filter((b): b is { type: 'thinking'; text: string } => b.type === 'thinking').map((b) => b.text).join('');
  const toolCalls = ordered
    .filter((b): b is { type: 'tool_use'; id: string; name: string; args: string } => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, arguments: b.args }));

  return {
    responseText: text,
    toolCalls,
    thinkingText: thinking || undefined,
    usage: inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined,
    stopReason,
    eventCount: events.length,
  };
}

function mergeCodexEvents(events: SseEvent[]): SseSummary {
  // OpenAI Responses SSE shape (excerpt):
  //   response.created / response.in_progress
  //   response.output_item.added                -> { item: {type:'message'|'function_call', id, name?} }
  //   response.content_part.added               -> { part: {type:'output_text'} }
  //   response.output_text.delta                -> { delta: '...' }
  //   response.reasoning_summary_text.delta     -> { delta: '...' }
  //   response.function_call_arguments.delta    -> { item_id, delta }
  //   response.output_item.done                 -> { item: full } (preferred source of truth)
  //   response.completed                        -> { response: { usage, status } }
  let textParts = '';
  let thinkingParts = '';
  const toolCallsById = new Map<string, { id: string; name: string; arguments: string }>();
  let stopReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const type = String((d as { type?: string }).type ?? e.event ?? '');
    if (type === 'response.output_text.delta') {
      textParts += String((d as { delta?: unknown }).delta ?? '');
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning.delta') {
      thinkingParts += String((d as { delta?: unknown }).delta ?? '');
    } else if (type === 'response.function_call_arguments.delta') {
      const id = String((d as { item_id?: unknown }).item_id ?? '');
      const cur = toolCallsById.get(id) ?? { id, name: '', arguments: '' };
      cur.arguments += String((d as { delta?: unknown }).delta ?? '');
      toolCallsById.set(id, cur);
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = ((d as { item?: unknown }).item ?? {}) as Record<string, unknown>;
      if (item.type === 'function_call') {
        const id = String(item.id ?? '');
        const cur = toolCallsById.get(id) ?? { id, name: '', arguments: '' };
        if (typeof item.name === 'string') cur.name = item.name;
        if (typeof item.arguments === 'string' && item.arguments) cur.arguments = item.arguments;
        toolCallsById.set(id, cur);
      }
    } else if (type === 'response.completed') {
      const resp = ((d as { response?: unknown }).response ?? {}) as Record<string, unknown>;
      const usage = (resp.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
      if (typeof resp.status === 'string') stopReason = resp.status;
    }
  }

  return {
    responseText: textParts,
    toolCalls: [...toolCallsById.values()],
    thinkingText: thinkingParts || undefined,
    usage: inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined,
    stopReason,
    eventCount: events.length,
  };
}

export function mergeSseToSummary(sse: string, kind: 'claude' | 'codex'): SseSummary {
  if (!sse) {
    return { responseText: '', toolCalls: [], eventCount: 0 };
  }
  const events = parseEvents(sse);
  return kind === 'claude' ? mergeClaudeEvents(events) : mergeCodexEvents(events);
}
