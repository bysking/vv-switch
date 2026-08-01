/**
 * 适配器入口：加载所有 Agent Adapter
 */

import './claude/index.js';
import './codex/index.js';
import './openai/index.js';

export { registerAdapter, getAdapter, listAdapters, clearAdapters } from '../core/adapter-manager.js';
