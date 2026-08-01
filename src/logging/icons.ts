/**
 * 控制台日志使用的 emoji icon —— 集中在这里定义,关键事件成对出现,
 * 让 tail -f 时一眼能识别请求生命周期。
 *
 * 规则:
 *  - START / END 类事件成对(🚀 / 🏁, 🛠️▶ / 🛠️✅, 🌊 / ✅)
 *  - 错误类用 ❌ / ⚠️,与 success 颜色明显不同
 *  - tool-call 用工具图标突出,与普通 token 区分
 *
 * 用法:
 *   import { ICON } from '../logging/icons.js';
 *   log.info(`${ICON.streamStart} stream open | msgId=${id}`);
 *   log.info(`${ICON.toolStart} ${name} args...`);
 *   log.info(`${ICON.toolEnd}   ${name} done`);
 */
export const ICON = {
  // request lifecycle
  request: '📥',
  reqStart: '🚀',
  reqEnd: '🏁',
  // streaming
  streamStart: '🌊',
  streamChunk: '·',
  streamDone: '✅',
  // tool calls (paired)
  toolStart: '🛠️▶',
  toolDelta: '🛠️·',
  toolEnd: '🛠️✅',
  // network / upstream
  fetch: '🌐',
  fetchOk: '🟢',
  fetchErr: '🔴',
  // model thinking / tokens
  thinking: '🧠',
  token: '✍️',
  usage: '📊',
  // results
  ok: '✅',
  warn: '⚠️',
  error: '❌',
  // misc
  info: 'ℹ️',
  debug: '🔍',
  cancel: '🛑',
  proxy: '🔀',
  config: '⚙️',
  log: '📝',
} as const;

export type IconKey = keyof typeof ICON;
