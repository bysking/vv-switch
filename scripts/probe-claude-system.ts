#!/usr/bin/env node
/**
 * Claude System Prompt 探测脚本
 *
 * 功能:
 *   1. 探测当前 Claude 活跃供应商
 *   2. 分析多种形态的 system prompt 结构(string / block[] / 真实 Claude Code 风格)
 *   3. 检测 prompt rules 改写命中情况 + diff 对比
 *   4. 全链路追踪 system 在各阶段的形态(ingress → standard → upstream)
 *
 * 用法:
 *   npx tsx scripts/probe-claude-system.ts           # 终端彩色输出
 *   npx tsx scripts/probe-claude-system.ts --json    # 结构化 JSON 输出
 */

import { getActiveForClaude } from '../src/providers-manager.js';
import {
  loadPromptRules,
  applyPromptRulesToAnthropicBody,
  extractSections,
  inspectPromptRuleMatch,
  diffPromptRule,
} from '../src/prompt-rules-manager.js';
import { parseClaudeRequest } from '../src/adapters/claude/parse.js';

// ── 参数 ──────────────────────────────────────────────────────────
const ARGS = {
  json: process.argv.includes('--json'),
};

// ── 颜色工具 ──────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

function colorize(text: string, color: string): string {
  if (ARGS.json) return text;
  return color + text + C.reset;
}

// ── 输出工具 ──────────────────────────────────────────────────────
function h1(title: string) {
  if (ARGS.json) return;
  const w = 78;
  console.log(`\n${C.bold}${C.cyan}╔${'═'.repeat(w)}╗${C.reset}`);
  const padded = title.padEnd(w - 2);
  console.log(`${C.bold}${C.cyan}║${C.reset} ${C.bold}${padded}${C.cyan}║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚${'═'.repeat(w)}╝${C.reset}`);
}

function h2(title: string) {
  if (ARGS.json) return;
  console.log(`\n${C.bold}${C.magenta}▸${C.reset} ${C.bold}${title}${C.reset}`);
  console.log(`${C.dim}${'─'.repeat(78)}${C.reset}`);
}

function h3(title: string) {
  if (ARGS.json) return;
  console.log(`\n  ${C.yellow}●${C.reset} ${C.bold}${title}${C.reset}`);
}

function box(title: string, lines: string[]) {
  if (ARGS.json) return;
  const w = 74;
  console.log(`  ${C.cyan}┌─${C.reset} ${C.bold}${title}${C.reset} ${C.cyan}${'─'.repeat(Math.max(0, w - title.length - 3))}┐${C.reset}`);
  for (const line of lines) {
    const wrapped = wrapText(line, w);
    for (const wl of wrapped) {
      console.log(`  ${C.cyan}│${C.reset} ${wl.padEnd(w)} ${C.cyan}│${C.reset}`);
    }
  }
  console.log(`  ${C.cyan}└${'─'.repeat(w + 2)}┘${C.reset}`);
}

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    lines.push(text.slice(i, i + width));
  }
  return lines;
}

function kv(key: string, value: string, indent = 2) {
  if (ARGS.json) return;
  const pad = ' '.repeat(indent);
  console.log(`${pad}${C.dim}${key}:${C.reset} ${value}`);
}

function divider(char = '─') {
  if (ARGS.json) return;
  console.log(`${C.dim}${char.repeat(78)}${C.reset}`);
}

// ── 样本数据 ──────────────────────────────────────────────────────

// 模拟 Claude Code 发送的真实风格 system prompt(精简版)
const REAL_CLAUDE_CODE_SYSTEM = `
# claudeMd
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

Contents of /Users/user/.claude/CLAUDE.md (user's private global instructions for all projects):
## CodeGraph
In repositories indexed by CodeGraph, reach for it BEFORE grep/find.
- **MCP tool**: \`codegraph_explore\` answers most code questions in one call
- **Shell**: \`codegraph explore "..."\` prints the same output.

# MCP Server Instructions
The following MCP servers have provided instructions:
## codegraph
Codegraph is a SQLite knowledge graph of every symbol in the workspace.

# Available agent types
- claude: Catch-all for any task
- Explore: Read-only search agent for broad fan-out searches

# Skills
The following skills are available for use with the Skill tool:
- code-review-skill: AI 驱动的代码评审技能
- fe-doc-skill: 梳理前端模块代码业务流程

`.trim();

interface Sample {
  name: string;
  description: string;
  body: Record<string, unknown>;
}

const SAMPLES: Sample[] = [
  {
    name: '纯字符串 system',
    description: 'system 字段为简单字符串',
    body: {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: 'You are a helpful assistant.\nPlease answer concisely.',
      messages: [{ role: 'user', content: 'Hi' }],
    },
  },
  {
    name: '单 text block 数组',
    description: 'system 字段为单元素 text block 数组',
    body: {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: [{ type: 'text', text: 'You are a helpful assistant.' }],
      messages: [{ role: 'user', content: 'Hi' }],
    },
  },
  {
    name: '多 text block + cache_control',
    description: 'system 字段为多 block 数组,带 cache_control 断点',
    body: {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: [
        { type: 'text', text: 'Preamble instructions for the model.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'More specific guidelines about behavior.' },
        { type: 'text', text: 'Final rules about output format.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'Hi' }],
    },
  },
  {
    name: '真实 Claude Code 风格',
    description: '带多个 # section 的富文本 system(单 block)',
    body: {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: REAL_CLAUDE_CODE_SYSTEM,
      messages: [{ role: 'user', content: 'Hello' }],
    },
  },
  {
    name: '多 block 真实风格(跨 block 场景)',
    description: 'Claude Code 将 system 拆分为多个 text block 发送',
    body: {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: [
        { type: 'text', text: '# claudeMd\nCodebase and user instructions are shown below.' },
        { type: 'text', text: '## CodeGraph\nIn repositories indexed by CodeGraph, reach for it BEFORE grep/find.' },
        { type: 'text', text: '# MCP Server Instructions\nThe following MCP servers have provided instructions:' },
        { type: 'text', text: '## codegraph\nCodegraph is a SQLite knowledge graph of every symbol.' },
      ],
      messages: [{ role: 'user', content: 'Hello' }],
    },
  },
];

// ── 分析函数 ──────────────────────────────────────────────────────

interface SystemAnalysis {
  sampleName: string;
  sampleDescription: string;
  location: string;
  type: 'string' | 'array' | 'null' | 'other';
  blockCount: number;
  totalChars: number;
  blockDetails: Array<{ index: number; type: string; chars: number; hasCacheControl: boolean; textPreview: string }>;
  sections: Array<{ title: string; level: number; chars: number }>;
  specialMarks: string[];
  flattenedText: string;
}

function analyzeSystem(body: Record<string, unknown>, sampleName: string, sampleDesc: string): SystemAnalysis {
  const sys = body.system;
  const analysis: SystemAnalysis = {
    sampleName: sampleName,
    sampleDescription: sampleDesc,
    location: 'body.system (顶层字段)',
    type: 'null',
    blockCount: 0,
    totalChars: 0,
    blockDetails: [],
    sections: [],
    specialMarks: [],
    flattenedText: '',
  };

  if (sys == null) {
    analysis.type = 'null';
    return analysis;
  }

  if (typeof sys === 'string') {
    analysis.type = 'string';
    analysis.blockCount = 1;
    analysis.totalChars = sys.length;
    analysis.flattenedText = sys;
    analysis.blockDetails = [{
      index: 0, type: 'string', chars: sys.length,
      hasCacheControl: false, textPreview: preview(sys, 120),
    }];
    analysis.sections = extractSections(sys).map(s => ({
      title: s.title || '(无标题)',
      level: s.level,
      chars: s.content.length,
    }));
    analysis.specialMarks = detectSpecialMarks(sys);
    return analysis;
  }

  if (Array.isArray(sys)) {
    analysis.type = 'array';
    analysis.blockCount = sys.length;
    const texts: string[] = [];
    for (let i = 0; i < sys.length; i++) {
      const block = sys[i] as Record<string, unknown>;
      const text = typeof block === 'string'
        ? block
        : typeof block.text === 'string' ? block.text : '';
      const blockType = typeof block === 'string' ? 'string' : String(block.type || 'unknown');
      const hasCC = typeof block === 'object' && block && 'cache_control' in block;
      texts.push(text);
      analysis.blockDetails.push({
        index: i, type: blockType, chars: text.length,
        hasCacheControl: hasCC as boolean, textPreview: preview(text, 80),
      });
    }
    const flat = texts.join('\n');
    analysis.flattenedText = flat;
    analysis.totalChars = flat.length;
    analysis.sections = extractSections(flat).map(s => ({
      title: s.title || '(无标题)',
      level: s.level,
      chars: s.content.length,
    }));
    analysis.specialMarks = detectSpecialMarks(flat);
    return analysis;
  }

  analysis.type = 'other';
  return analysis;
}

function preview(text: string, len: number): string {
  if (text.length <= len) return text;
  return text.slice(0, len) + '...';
}

function detectSpecialMarks(text: string): string[] {
  const marks: string[] = [];
  if (/<system-reminder>/i.test(text)) marks.push('<system-reminder> 标签');
  if (/<\/?code>/i.test(text)) marks.push('<code> 标签');
  if (/```/.test(text)) marks.push('代码块 (```)');
  if (/#{1,6}\s+\S/.test(text)) marks.push('Markdown 标题');
  if (/cache_control|ephemeral/.test(text)) marks.push('cache_control 文本');
  if (/MCP|mcp/.test(text)) marks.push('MCP 相关内容');
  if (/CodeGraph|codegraph/.test(text)) marks.push('CodeGraph 相关内容');
  return marks;
}

// ── Prompt Rules 探测 ─────────────────────────────────────────────

interface RuleProbeResult {
  rule: Record<string, unknown>;
  matchesInSystem: number;
  matchDetails: Array<{ sampleName: string; count: number; samples: string[] }>;
  hasDiff: boolean;
}

function probePromptRules(samples: Sample[], rules: unknown[]): RuleProbeResult[] {
  const results: RuleProbeResult[] = [];

  for (const rule of rules as Array<Record<string, unknown>>) {
    if (!rule.enabled) continue;

    const matchDetails: Array<{ sampleName: string; count: number; samples: string[] }> = [];
    let totalMatches = 0;
    let hasAnyDiff = false;

    for (const sample of samples) {
      const analysis = analyzeSystem(sample.body, sample.name, sample.description);
      const text = analysis.flattenedText;

      if (rule.target === 'user' || rule.target === 'assistant') {
        // 只探测 system 的话,跳过 user/assistant 限定规则
        continue;
      }

      const matches = inspectPromptRuleMatch(text, rule, 20);
      totalMatches += matches.length;

      if (matches.length > 0) {
        matchDetails.push({
          sampleName: sample.name,
          count: matches.length,
          samples: matches.slice(0, 3).map(m =>
            `${m.before}[${colorize(m.match, C.red)}]${m.after}`
          ),
        });
      }

      // 检查是否有实际改写效果
      const diff = diffPromptRule(text, rule, 2);
      const hasChange = diff.some(d => d.type === 'add' || d.type === 'remove');
      if (hasChange) hasAnyDiff = true;
    }

    results.push({
      rule,
      matchesInSystem: totalMatches,
      matchDetails,
      hasDiff: hasAnyDiff,
    });
  }

  return results;
}

// ── 全链路追踪 ────────────────────────────────────────────────────

interface TraceResult {
  sampleName: string;
  ingress: { systemType: string; systemChars: number };
  afterRewrite: { systemType: string; systemChars: number; changed: boolean };
  standard: { systemType: string; systemChars: number };
}

function tracePipeline(sample: Sample, rules: unknown[]): TraceResult {
  const body = sample.body;
  const ingressSys = body.system;
  const ingressType = typeof ingressSys === 'string' ? 'string'
    : Array.isArray(ingressSys) ? `${(ingressSys as unknown[]).length} blocks`
    : 'null';
  const ingressChars = typeof ingressSys === 'string' ? ingressSys.length
    : Array.isArray(ingressSys) ? (ingressSys as any[]).reduce((s, b) => s + (typeof b === 'string' ? b.length : b.text?.length || 0), 0)
    : 0;

  // 2. Prompt Rules 改写后
  const afterRewrite = applyPromptRulesToAnthropicBody(body, rules as any[]);
  const afterSys = afterRewrite.system;
  const afterType = typeof afterSys === 'string' ? 'string'
    : Array.isArray(afterSys) ? `${(afterSys as unknown[]).length} blocks`
    : 'null';
  const afterChars = typeof afterSys === 'string' ? afterSys.length
    : Array.isArray(afterSys) ? (afterSys as any[]).reduce((s, b) => s + (typeof b === 'string' ? b.length : b.text?.length || 0), 0)
    : 0;
  const changed = JSON.stringify(ingressSys) !== JSON.stringify(afterSys);

  // 3. StandardRequest
  const ctx = { id: 'probe-msg', defaultModel: sample.body.model as string || 'test-model', headers: {} };
  const stdReq = parseClaudeRequest(afterRewrite, ctx as any);
  const stdSys = stdReq.system;
  const stdType = typeof stdSys === 'string' ? 'string'
    : Array.isArray(stdSys) ? `${(stdSys as unknown[]).length} blocks`
    : 'null';
  const stdChars = typeof stdSys === 'string' ? stdSys.length
    : Array.isArray(stdSys) ? (stdSys as any[]).reduce((s, b) => s + (b.text?.length || 0), 0)
    : 0;

  return {
    sampleName: sample.name,
    ingress: { systemType: ingressType, systemChars: ingressChars },
    afterRewrite: { systemType: afterType, systemChars: afterChars, changed },
    standard: { systemType: stdType, systemChars: stdChars },
  };
}

// ── 主流程 ────────────────────────────────────────────────────────

function main() {
  const active = getActiveForClaude();
  const rules = loadPromptRules();
  const activeRules = rules.filter(r => r.enabled);

  if (ARGS.json) {
    // JSON 输出模式
    const analyses = SAMPLES.map(s => {
      const a = analyzeSystem(s.body, s.name, s.description);
      return {
        sampleName: a.sampleName,
        sampleDescription: a.sampleDescription,
        location: a.location,
        type: a.type,
        blockCount: a.blockCount,
        totalChars: a.totalChars,
        blockDetails: a.blockDetails,
        sections: a.sections,
        specialMarks: a.specialMarks,
      };
    });

    const ruleProbes = probePromptRules(SAMPLES, rules);
    const traces = SAMPLES.map(s => tracePipeline(s, rules));

    const output = {
      activeProvider: active ? {
        name: active.name,
        model: active.model,
        protocolType: active.protocolType,
        baseUrl: active.baseUrl,
        modelCapabilities: active.modelCapabilities,
      } : null,
      totalPromptRules: rules.length,
      activePromptRules: activeRules.length,
      systemAnalyses: analyses,
      ruleProbes: ruleProbes.map(r => ({
        name: r.rule.name,
        target: r.rule.target,
        pattern: r.rule.pattern,
        section: r.rule.section,
        acrossBlocks: r.rule.acrossBlocks,
        matchesInSystem: r.matchesInSystem,
        matchDetails: r.matchDetails.map(d => ({ sample: d.sampleName, count: d.count })),
        hasDiff: r.hasDiff,
      })),
      pipelineTraces: traces,
    };

    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  //  终端彩色输出
  // ═══════════════════════════════════════════════════════════════

  h1('🔍 Claude System Prompt 探测器');

  // ── 1. 活跃供应商 ─────────────────────────────────────────────
  h2('1. 当前 Claude 活跃供应商');

  if (active) {
    box('✅ 已配置', [
      `${C.bold}名称:${C.reset} ${active.name}`,
      `${C.bold}模型:${C.reset} ${active.model}`,
      `${C.bold}协议类型:${C.reset} ${active.protocolType}`,
      `${C.bold}Base URL:${C.reset} ${active.baseUrl}`,
    ]);

    const caps = active.modelCapabilities || {};
    const capItems = Object.entries(caps).map(([k, v]) => {
      const icon = v ? `${C.green}✔${C.reset}` : `${C.red}✘${C.reset}`;
      return `  ${icon} ${k}: ${v}`;
    });
    console.log(`  ${C.dim}能力配置:${C.reset}`);
    capItems.forEach(c => console.log(c));
  } else {
    box('⚠️  未配置', [
      '当前没有活跃的 Claude 供应商。',
      '请通过 vv-switch 配置页面选择一个供应商应用到 Claude。',
    ]);
  }

  // ── 2. Prompt Rules 概况 ─────────────────────────────────────
  h2(`2. Prompt Rules 概况 (${activeRules.length}/${rules.length} 条启用)`);

  if (rules.length === 0) {
    console.log(`  ${C.dim}(暂无规则,跳过改写探测)${C.reset}`);
  } else {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i] as any;
      const status = r.enabled ? `${C.green}●${C.reset}` : `${C.gray}○${C.reset}`;
      const targetTag = colorize(r.target, r.target === 'system' ? C.cyan : r.target === 'all' ? C.yellow : C.magenta);
      const extras = [];
      if (r.section) extras.push(`section=${colorize(r.section, C.blue)}`);
      if (r.acrossBlocks) extras.push(colorize('acrossBlocks', C.yellow));
      const extraStr = extras.length ? ` [${extras.join(', ')}]` : '';
      console.log(`  ${status} ${i + 1}. ${C.bold}${r.name}${C.reset} ${C.dim}(${targetTag})${C.reset}${extraStr}`);
      console.log(`     ${C.dim}pattern: ${r.pattern}${C.reset}`);
    }
  }

  // ── 3. System Prompt 结构分析 ────────────────────────────────
  h2('3. System Prompt 结构分析 (5 种典型形态)');

  for (const sample of SAMPLES) {
    const analysis = analyzeSystem(sample.body, sample.name, sample.description);
    h3(`${analysis.sampleName} ${C.dim}— ${analysis.sampleDescription}${C.reset}`);

    kv('位置', analysis.location);
    kv('类型', colorize(analysis.type, analysis.type === 'string' ? C.green : C.yellow));
    kv('block 数量', String(analysis.blockCount));
    kv('总字符数', `${analysis.totalChars.toLocaleString()} chars`);

    if (analysis.blockDetails.length > 1) {
      console.log(`  ${C.dim}各 block 详情:${C.reset}`);
      for (const bd of analysis.blockDetails) {
        const cc = bd.hasCacheControl ? ` ${colorize('[cache_control]', C.cyan)}` : '';
        console.log(`    [${bd.index}] type=${bd.type.padEnd(10)} chars=${String(bd.chars).padStart(6)}${cc}`);
        console.log(`        ${C.dim}${bd.textPreview}${C.reset}`);
      }
    }

    if (analysis.sections.length > 0) {
      const topSections = analysis.sections.slice(0, 10);
      console.log(`  ${C.dim}Section 分布 (${analysis.sections.length} 个,显示 Top ${topSections.length}):${C.reset}`);
      const maxChars = Math.max(...topSections.map(s => s.chars), 1);
      for (const sec of topSections) {
        const barLen = Math.round((sec.chars / maxChars) * 30);
        const bar = colorize('█'.repeat(barLen), C.blue);
        const title = sec.title.length > 25 ? sec.title.slice(0, 22) + '...' : sec.title;
        console.log(`    ${C.dim}H${sec.level}${C.reset} ${title.padEnd(28)} ${bar} ${sec.chars.toLocaleString()}`);
      }
    }

    if (analysis.specialMarks.length > 0) {
      console.log(`  ${C.dim}特殊标记:${C.reset} ${analysis.specialMarks.map(m => colorize(m, C.magenta)).join(', ')}`);
    }
  }

  // ── 4. Prompt Rules 改写探测 ─────────────────────────────────
  if (activeRules.length > 0) {
    h2('4. Prompt Rules 改写命中探测');

    const probeResults = probePromptRules(SAMPLES, rules);

    for (const result of probeResults) {
      const rule = result.rule as any;
      h3(`${rule.name} ${C.dim}(${rule.target})${C.reset}`);

      if (result.matchDetails.length === 0) {
        console.log(`  ${C.yellow}⚠️  在 system 中未匹配到任何内容${C.reset}`);
        console.log(`     ${C.dim}pattern: /${rule.pattern}/${rule.flags}${C.reset}`);
        console.log(`     ${C.dim}可能原因: 正则写错了 / 内容在 user/assistant 消息中 / 跨 block 匹配需开启 acrossBlocks${C.reset}`);
      } else {
        const total = result.matchesInSystem;
        console.log(`  ${C.green}✔  共匹配 ${total} 处,分布在 ${result.matchDetails.length} 个样本中${C.reset}`);
        for (const md of result.matchDetails) {
          console.log(`    ${C.cyan}●${C.reset} ${md.sampleName}: ${md.count} 处匹配`);
          for (const sample of md.samples) {
            console.log(`       ... ${sample} ...`);
          }
        }
      }

      // 跨 block 检测
      if (!rule.acrossBlocks && /\\n|\\s/.test(rule.pattern || '')) {
        console.log(`  ${C.yellow}💡 提示: 规则包含跨行匹配符,但未开启 acrossBlocks${C.reset}`);
        console.log(`     ${C.dim}如果 system 是多 block 数组,跨行匹配可能失效。建议设置 acrossBlocks: true${C.reset}`);
      }

      // Section 建议
      if (rule.section) {
        console.log(`  ${C.blue}📌 仅在 section "${rule.section}" 内改写${C.reset}`);
      }
    }
  }

  // ── 5. 全链路追踪 ────────────────────────────────────────────
  h2('5. 全链路 System 形态追踪');

  console.log(`  ${C.dim}${'样本'.padEnd(22)}  ${'Ingress'.padEnd(18)}  ${'→ Rewrite'.padEnd(20)}  ${'→ Standard'.padEnd(18)}${C.reset}`);

  for (const sample of SAMPLES) {
    const trace = tracePipeline(sample, rules);
    const name = trace.sampleName.length > 20 ? trace.sampleName.slice(0, 17) + '...' : trace.sampleName;

    const ingressStr = `${trace.ingress.systemChars} chars / ${trace.ingress.systemType}`;
    const changedIcon = trace.afterRewrite.changed ? colorize('≠', C.green) : '=';
    const rewriteStr = `${trace.afterRewrite.systemChars} / ${trace.afterRewrite.systemType} ${changedIcon}`;
    const stdStr = `${trace.standard.systemChars} / ${trace.standard.systemType}`;

    console.log(`  ${name.padEnd(22)}  ${ingressStr.padEnd(18)}  ${rewriteStr.padEnd(20)}  ${stdStr.padEnd(18)}`);
  }

  divider();
  console.log(`\n${C.dim}💡 提示: 使用 --json 参数获取结构化 JSON 输出${C.reset}`);
  console.log(`${C.dim}💡 提示: 在 ~/.vv-switch-prompt-rules.json 中配置规则,或通过 Web UI 管理${C.reset}\n`);
}

main();
