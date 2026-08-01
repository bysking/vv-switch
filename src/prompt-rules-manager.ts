import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const PROMPT_RULES_FILE = join(homedir(), '.vv-switch-prompt-rules.json');
const VALID_TARGETS = new Set(['all', 'system', 'user', 'assistant']);

function normalizeTarget(target) {
  return VALID_TARGETS.has(target) ? target : 'all';
}

function normalizeRule(data = {}, existing = {}) {
  const now = new Date().toISOString();
  return {
    ...existing,
    id: data.id || existing.id || randomUUID(),
    name: data.name ?? existing.name ?? '',
    enabled: data.enabled ?? existing.enabled ?? true,
    target: normalizeTarget(data.target ?? existing.target),
    pattern: data.pattern ?? existing.pattern ?? '',
    replacement: data.replacement ?? existing.replacement ?? '',
    flags: data.flags ?? existing.flags ?? 'g',
    section: data.section ?? existing.section ?? '',
    acrossBlocks: data.acrossBlocks ?? existing.acrossBlocks ?? false,
    createdAt: existing.createdAt || now,
    updatedAt: data.updatedAt || now,
  };
}

function safeFlags(flags) {
  const value = String(flags || 'g');
  let result = '';
  for (const flag of value) {
    if ('dgimsuvy'.includes(flag) && !result.includes(flag)) {
      result += flag;
    }
  }
  return result || 'g';
}

function makeRegex(rule) {
  if (!rule || !rule.pattern) return null;
  try {
    return new RegExp(rule.pattern, safeFlags(rule.flags));
  } catch {
    return null;
  }
}

function roleMatches(rule, role) {
  return rule.target === 'all' || rule.target === role;
}

// ── Section 粒度支持 ──────────────────────────────────────────────

/**
 * 从 Markdown 文本中提取 section 列表
 * section 边界: 从 # 标题行开始, 到下一个同级或更高级标题前结束
 * 返回: [{ title, level, start, end, content }]
 */
export function extractSections(text: string): Array<{
  title: string;
  level: number;
  start: number;
  end: number;
  content: string;
}> {
  if (typeof text !== 'string' || text.length === 0) return [];

  const sections: Array<{ title: string; level: number; start: number; end: number; content: string }> = [];
  const headingRegex = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;

  let match: RegExpExecArray | null;
  const headings: Array<{ title: string; level: number; index: number }> = [];

  while ((match = headingRegex.exec(text)) !== null) {
    headings.push({
      title: match[2].trim(),
      level: match[1].length,
      index: match.index,
    });
  }

  if (headings.length === 0) {
    // 无标题,整段视为一个无名 section
    return [{ title: '', level: 0, start: 0, end: text.length, content: text }];
  }

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    // 找到下一个同级或更高级标题的位置
    let end = text.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        end = headings[j].index;
        break;
      }
    }
    const content = text.slice(h.index, end);
    sections.push({
      title: h.title,
      level: h.level,
      start: h.index,
      end,
      content,
    });
  }

  // 标题之前的文本也算一个前置 section
  if (headings[0].index > 0) {
    sections.unshift({
      title: '__preamble__',
      level: 0,
      start: 0,
      end: headings[0].index,
      content: text.slice(0, headings[0].index),
    });
  }

  return sections;
}

/**
 * 判断 section 名是否匹配(不区分大小写,支持前缀匹配)
 */
function sectionMatches(sectionTitle: string, target: string): boolean {
  if (!target) return true; // 没有 section 限制,匹配全部
  const a = sectionTitle.toLowerCase().trim();
  const b = target.toLowerCase().trim();
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return false;
}

/**
 * 仅在指定 section 内改写文本
 */
function rewriteTextInSection(text: string, rule, regex: RegExp): string {
  if (!rule.section) return text.replace(regex, rule.replacement || '');

  const sections = extractSections(text);
  let result = text;
  let offset = 0; // 因为前面的改写导致的位置偏移

  for (const sec of sections) {
    if (!sectionMatches(sec.title, rule.section)) continue;

    const originalSecContent = sec.content;
    const newSecContent = originalSecContent.replace(regex, rule.replacement || '');
    if (newSecContent === originalSecContent) continue;

    const absStart = sec.start + offset;
    const absEnd = sec.end + offset;
    result = result.slice(0, absStart) + newSecContent + result.slice(absEnd);
    offset += newSecContent.length - originalSecContent.length;
  }

  return result;
}

function rewriteText(text, role, rules) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let result = text;
  for (const rule of rules) {
    if (!rule.enabled || !roleMatches(rule, role)) continue;
    const regex = makeRegex(rule);
    if (!regex) continue;
    result = rewriteTextInSection(result, rule, regex);
  }
  return result;
}

// ── 跨 block 改写 (acrossBlocks) ────────────────────────────────

/**
 * 将 content 数组扁平化为纯文本(只包含 text block)
 * 返回 { text, blockMap } — blockMap 记录原每个 text block 在扁平文本中的位置
 */
function flattenTextBlocks(content) {
  const parts: string[] = [];
  const blockMap: Array<{ index: number; start: number; end: number; block: any }> = [];
  let pos = 0;

  content.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    if (typeof item.text !== 'string') return;
    // 跳过非文本类型
    const NON_TEXT_TYPES = new Set([
      'image', 'input_image',
      'tool_use', 'tool_result', 'function_call', 'function_call_output',
      'thinking', 'redacted_thinking',
    ]);
    if (NON_TEXT_TYPES.has(item.type)) return;

    const text = item.text;
    if (parts.length > 0) {
      parts.push('\n');
      pos += 1;
    }
    const start = pos;
    parts.push(text);
    pos += text.length;
    blockMap.push({ index: idx, start, end: pos, block: item });
  });

  return { text: parts.join(''), blockMap };
}

/**
 * 跨 block 改写:先合并所有 text block 为单文本,改写后按原长度比例重新分割
 * 注意: 分割回多 block 时只保证总文本正确,不保证每个 block 的内容精确对应
 * cache_control 等元数据保留在原位置的 block 上
 */
function rewriteContentAcrossBlocks(content, role, rules) {
  if (!Array.isArray(content)) return content;

  const { text: flat, blockMap } = flattenTextBlocks(content);
  if (blockMap.length === 0) return content;

  const rewritten = rewriteText(flat, role, rules);
  if (rewritten === flat) return content; // 无变化,直接返回

  // 按比例重新分割到各 block
  const totalOriginalLen = blockMap[blockMap.length - 1].end;
  const totalNewLen = rewritten.length;
  const scale = totalOriginalLen > 0 ? totalNewLen / totalOriginalLen : 1;

  const result = [...content];
  let newPos = 0;

  blockMap.forEach((mapping, i) => {
    const isLast = i === blockMap.length - 1;
    let newEnd: number;
    if (isLast) {
      newEnd = totalNewLen;
    } else {
      // 按原始位置比例计算新的分割点
      const originalEnd = mapping.end; // 不含 block 间的 \n,所以 blockMap 的 end 不准
      // 用简化方式: 按各 block 原文本长度比例分配
      const originalBlockLen = mapping.block.text.length;
      const scaledLen = Math.round(originalBlockLen * scale);
      newEnd = Math.min(newPos + scaledLen, totalNewLen);
    }

    const newText = rewritten.slice(newPos, newEnd);
    newPos = newEnd;

    const block = { ...mapping.block, text: newText };
    result[mapping.index] = block;
  });

  // 过滤空文本块
  const NON_TEXT_TYPES = new Set([
    'image', 'input_image',
    'tool_use', 'tool_result', 'function_call', 'function_call_output',
    'thinking', 'redacted_thinking',
  ]);
  return result.filter(item => {
    if (!item || typeof item !== 'object') return true;
    if (NON_TEXT_TYPES.has(item.type)) return true;
    if (typeof item.text === 'string' && item.text === '') return false;
    return true;
  });
}

function rewriteContent(content, role, rules) {
  if (typeof content === 'string') {
    return rewriteText(content, role, rules);
  }

  if (!Array.isArray(content)) {
    return content;
  }

  // 非文本类 block 类型 — 这些 block 不含用户可读文本,不应被改写
  const NON_TEXT_TYPES = new Set([
    'image', 'input_image',
    'tool_use', 'tool_result', 'function_call', 'function_call_output',
    'thinking', 'redacted_thinking',
  ]);

  // 分离 acrossBlocks 规则和普通规则
  const acrossRules = rules.filter(r => r.enabled && r.acrossBlocks && roleMatches(r, role));
  const normalRules = rules.filter(r => r.enabled && !r.acrossBlocks && roleMatches(r, role));

  let result = content;

  // 先应用普通规则(逐 block 改写)
  if (normalRules.length > 0) {
    result = result
      .map(item => {
        if (!item || typeof item !== 'object') return item;
        if (NON_TEXT_TYPES.has(item.type)) return item;
        if (typeof item.text !== 'string') return item;
        return { ...item, text: rewriteText(item.text, role, normalRules) };
      })
      .filter(item => {
        // 过滤掉改写后变为空文本的 text block
        if (!item || typeof item !== 'object') return true;
        if (NON_TEXT_TYPES.has(item.type)) return true;
        if (typeof item.text === 'string' && item.text === '') return false;
        return true;
      });
  }

  // 再应用跨 block 规则(合并改写后重新分割)
  if (acrossRules.length > 0) {
    result = rewriteContentAcrossBlocks(result, role, acrossRules);
  }

  return result;
}

function rewriteMessages(messages, rules) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(message => {
    if (!message || typeof message !== 'object') return message;
    const role = message.role === 'developer' ? 'system' : (message.role || 'user');
    if (!['system', 'user', 'assistant'].includes(role)) return message;
    return { ...message, content: rewriteContent(message.content, role, rules) };
  });
}

function rewriteResponsesInput(input, rules) {
  if (typeof input === 'string') {
    return rewriteText(input, 'user', rules);
  }

  if (!Array.isArray(input)) {
    return input;
  }

  return input.map(item => {
    if (typeof item === 'string') {
      return rewriteText(item, 'user', rules);
    }
    if (!item || typeof item !== 'object') return item;

    const role = item.role === 'developer' ? 'system' : (item.role || 'user');
    const patch = { ...item };
    if (typeof patch.content !== 'undefined') {
      patch.content = rewriteContent(patch.content, role, rules);
    }
    return patch;
  });
}

function activeRules(rules) {
  return rules.filter(rule => rule.enabled && rule.pattern);
}

export function loadPromptRules() {
  if (!existsSync(PROMPT_RULES_FILE)) return [];
  try {
    const content = readFileSync(PROMPT_RULES_FILE, 'utf-8');
    const rules = JSON.parse(content);
    return Array.isArray(rules) ? rules.map(rule => normalizeRule(rule, rule)) : [];
  } catch {
    return [];
  }
}

export function savePromptRules(rules) {
  const dir = homedir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PROMPT_RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8');
}

export function upsertPromptRule(data) {
  const rules = loadPromptRules();
  let savedRule;

  if (data.id) {
    const index = rules.findIndex(rule => rule.id === data.id);
    if (index >= 0) {
      savedRule = normalizeRule(data, rules[index]);
      rules[index] = savedRule;
    } else {
      savedRule = normalizeRule(data);
      rules.push(savedRule);
    }
  } else {
    savedRule = normalizeRule(data);
    rules.push(savedRule);
  }

  savePromptRules(rules);
  return savedRule;
}

export function deletePromptRule(id) {
  const rules = loadPromptRules();
  const filtered = rules.filter(rule => rule.id !== id);
  if (filtered.length === rules.length) return false;
  savePromptRules(filtered);
  return true;
}

export function validatePromptRule(data = {}) {
  if (!String(data.name || '').trim()) {
    throw new Error('规则名称为必填');
  }
  if (!String(data.pattern || '').trim()) {
    throw new Error('正则表达式为必填');
  }
  try {
    new RegExp(data.pattern, safeFlags(data.flags));
  } catch (error) {
    throw new Error(`正则表达式无效: ${error.message}`);
  }
}

export function applyPromptRulesToResponsesBody(body, rules = loadPromptRules()) {
  const active = activeRules(rules);
  if (active.length === 0 || !body || typeof body !== 'object') return body;

  const next = { ...body };
  if (typeof next.instructions === 'string') {
    next.instructions = rewriteText(next.instructions, 'system', active);
  }
  if (typeof next.input !== 'undefined') {
    next.input = rewriteResponsesInput(next.input, active);
  }
  return next;
}

export function applyPromptRulesToAnthropicBody(body, rules = loadPromptRules()) {
  const active = activeRules(rules);
  if (active.length === 0 || !body || typeof body !== 'object') return body;

  const next = { ...body };
  if (typeof next.system !== 'undefined') {
    next.system = rewriteContent(next.system, 'system', active);
  }
  if (Array.isArray(next.messages)) {
    next.messages = rewriteMessages(next.messages, active);
  }
  return next;
}

export function applyPromptRulesToChatBody(body, rules = loadPromptRules()) {
  const active = activeRules(rules);
  if (active.length === 0 || !body || typeof body !== 'object') return body;

  const next = { ...body };
  // Chat Completions 的 system 提示词也在 messages 数组中(role: 'system')
  if (Array.isArray(next.messages)) {
    next.messages = rewriteMessages(next.messages, active);
  }
  return next;
}

export function previewPromptRule(text, rule) {
  const normalized = normalizeRule(rule, rule);
  validatePromptRule(normalized);
  return rewriteText(String(text || ''), normalizeTarget(normalized.target), [normalized]);
}

// ── 调试工具: inspect / diff ────────────────────────────────────

export interface PromptRuleMatch {
  index: number;
  length: number;
  match: string;
  groups?: Record<string, string>;
  before: string;
  after: string;
}

/**
 * 检查单条规则在文本中的所有命中位置
 * 返回命中列表,包含匹配文本、位置、前后上下文
 */
export function inspectPromptRuleMatch(text: string, rule, contextLen = 30): PromptRuleMatch[] {
  const normalized = normalizeRule(rule, rule);
  const regex = makeRegex(normalized);
  if (!regex || typeof text !== 'string') return [];

  const matches: PromptRuleMatch[] = [];

  // 确保带 g flag 才能迭代
  const flags = safeFlags(normalized.flags);
  const globalRegex = flags.includes('g') ? regex : new RegExp(normalized.pattern, flags + 'g');

  let m: RegExpExecArray | null;
  while ((m = globalRegex.exec(text)) !== null) {
    matches.push({
      index: m.index,
      length: m[0].length,
      match: m[0],
      groups: m.groups ? { ...m.groups } : undefined,
      before: text.slice(Math.max(0, m.index - contextLen), m.index),
      after: text.slice(m.index + m[0].length, m.index + m[0].length + contextLen),
    });
    // 防止零宽匹配导致死循环
    if (m[0].length === 0) globalRegex.lastIndex++;
  }

  return matches;
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  content: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * 生成统一 diff 风格的改写对比
 * 返回行级别的 diff 列表,适合终端打印
 */
export function diffPromptRule(text: string, rule, contextLines = 3): DiffLine[] {
  const normalized = normalizeRule(rule, rule);
  const newText = rewriteText(String(text || ''), normalizeTarget(normalized.target), [normalized]);

  const oldLines = String(text || '').split('\n');
  const newLines = newText.split('\n');

  // 简化版 LCS diff — 基于行的最长公共子序列
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯 LCS,标记差异
  const ops: Array<{ type: 'equal' | 'remove' | 'add'; line: string; oldIdx: number; newIdx: number }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: 'equal', line: oldLines[i - 1], oldIdx: i - 1, newIdx: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'add', line: newLines[j - 1], oldIdx: -1, newIdx: j - 1 });
      j--;
    } else {
      ops.unshift({ type: 'remove', line: oldLines[i - 1], oldIdx: i - 1, newIdx: -1 });
      i--;
    }
  }

  // 转换为带上下文的 diff 块
  const result: DiffLine[] = [];
  let lastChange = -Infinity;

  ops.forEach((op, idx) => {
    if (op.type === 'equal') {
      // 上下文行:只保留变更附近的 contextLines 行
      const nextChangeIdx = findNextChange(ops, idx);
      const distFromLast = idx - lastChange - 1;
      const distToNext = nextChangeIdx - idx - 1;

      if (distFromLast < contextLines || distToNext < contextLines) {
        result.push({
          type: 'context',
          content: op.line,
          oldLine: op.oldIdx + 1,
          newLine: op.newIdx + 1,
        });
      } else if (result.length > 0 && result[result.length - 1].type !== 'context') {
        // 省略号
        result.push({ type: 'context', content: '...' });
      }
    } else {
      lastChange = idx;
      result.push({
        type: op.type === 'add' ? 'add' : 'remove',
        content: op.line,
        oldLine: op.type === 'remove' ? op.oldIdx + 1 : undefined,
        newLine: op.type === 'add' ? op.newIdx + 1 : undefined,
      });
    }
  });

  return result;
}

function findNextChange(ops, fromIdx: number): number {
  for (let i = fromIdx + 1; i < ops.length; i++) {
    if (ops[i].type !== 'equal') return i;
  }
  return ops.length;
}
