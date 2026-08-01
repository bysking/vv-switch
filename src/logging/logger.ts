/**
 * 控制台日志器 — 每条日志带 level icon,关键事件用 ICON.* 增强可读性。
 */

import { ICON } from './icons.js';
export { ICON } from './icons.js';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

function getCurrentTime(): string {
  const now = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function createLogger(debug = false): Logger {
  return {
    debug: (message: string, ...args: unknown[]): void => {
      if (debug) console.log(`${ICON.debug} [${getCurrentTime()}] ${message}`, ...args);
    },
    info: (message: string, ...args: unknown[]): void => {
      console.log(`${ICON.info} [${getCurrentTime()}] ${message}`, ...args);
    },
    warn: (message: string, ...args: unknown[]): void => {
      console.warn(`${ICON.warn} [${getCurrentTime()}] ${message}`, ...args);
    },
    error: (message: string, ...args: unknown[]): void => {
      console.error(`${ICON.error} [${getCurrentTime()}] ${message}`, ...args);
    },
  };
}

export { getCurrentTime as formatTimestamp };
