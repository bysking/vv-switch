/**
 * vv-switch 配置服务器
 *
 * 整合 Web 配置 UI + 供应商管理 API。
 * 代理转发逻辑全部复用 server.js 的 createApp()，不重复编写。
 * 通过 `vv-switch config` 启动，在同一端口同时提供：
 *   - 配置网页（/）
 *   - 供应商管理 API（/api/providers/*）
 *   - 代理 API（/v1/*, /health）— 复用 server.js
 *
 * Ctrl+C 时自动还原已应用的 Claude / Codex 配置。
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { createApp } from './http/server.js';
import { loadProviders, upsertProvider, deleteProvider, reorderProviders, getProvider, markActiveFor, clearActiveFor, getActiveForClaude, getActiveForCodex, getActiveForOpenai } from './providers-manager.js';
import { loadPromptRules, upsertPromptRule, deletePromptRule, validatePromptRule, previewPromptRule } from './prompt-rules-manager.js';
import { appendVersionedPath, buildChatUrl, buildMessagesUrl, buildOllamaChatUrl as buildOllamaUrl } from './utils/url.js';
import { clearDiscoveryCache } from './capability/cache.js';
import { parse, stringify } from 'smol-toml';


// esbuild auto-defines __dirname in CJS bundles. In ESM source, derive it from import.meta.url.
// import.meta.url is undefined in CJS bundles, so we catch the error and fall back.
function getDirname() {
  if (typeof __dirname === 'string') return __dirname; // esbuild CJS bundle
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return '.';
  }
}
const _dirname = getDirname();

// ── Claude / Codex 配置路径 ──────────────────────────────────

const CLAUDE_SETTINGS = path.join(homedir(), '.claude', 'settings.json');
const CLAUDE_PROFILE = path.join(homedir(), '.claude.json');
const CODEX_CONFIG = path.join(homedir(), '.codex', 'config.toml');

// 完整备份文件路径（用户顶层目录）
const CLAUDE_BACKUP = path.join(homedir(), '.claude.settings.json.vv-backup');
const CLAUDE_PROFILE_BACKUP = path.join(homedir(), '.claude.json.vv-backup');
const CODEX_BACKUP = path.join(homedir(), '.codex.config.toml.vv-backup');

// vv-switch 写入 Claude 配置的 env key 列表
const VV_CLAUDE_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',

  // claude只需要维护一个api端点地址就行，这样动态改vv-switch代理，claude不需要重启 位置(claude)： 1/2
  // 'ANTHROPIC_MODEL',
  // 'ANTHROPIC_AUTH_TOKEN',
  // 'ANTHROPIC_SMALL_FAST_MODEL',
  // 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  // 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  // 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  // 'CLAUDE_CODE_SUBAGENT_MODEL',
];

// ── 备份状态（内存）────────────────────────────────────────

let backup = { claude: null, codex: null };

// ── 代理路由缓存 ─────────────────────────────────────────────
// 按 active provider 的签名缓存 createApp() 结果，避免每次请求重建

let cachedProxy = { signature: null, app: null };

function getOrCreateProxyApp(provider, logWriter = null, debug = false, captureBody = true, protocolLogDir = null) {
  const sig = `${provider.id}:${provider.baseUrl}:${provider.apiKey}:${provider.model}:${provider.protocolType || 'chat'}:${debug}:${captureBody}:${protocolLogDir || 'off'}:${JSON.stringify(provider.modelCapabilities || {})}`;
  if (cachedProxy.signature === sig && cachedProxy.app) {
    return cachedProxy.app;
  }
  cachedProxy.app = createApp({
    upstreamBaseUrl: provider.baseUrl,
    upstreamApiKey: provider.apiKey,
    defaultModel: provider.model,
    protocolType: provider.protocolType || 'chat',
    modelCapabilities: provider.modelCapabilities,
    debug,
    logs: false,
    captureBody,
    logWriter,
    protocolLogDir,
  });
  cachedProxy.signature = sig;
  return cachedProxy.app;
}

/**
 * 启动时根据持久化的 activeForClaude/activeForCodex 标记，重新应用配置到实际配置文件。
 * 先备份当前原始配置文件到 backup 对象，再写入 vv-switch 配置。
 * 后续 Ctrl+C 关闭或用户手动点击还原时，使用此备份进行还原。
 */
function restoreActiveProvidersOnStartup(proxyBaseUrl) {
  const claudeActive = getActiveForClaude();
  const codexActive = getActiveForCodex();

  if (claudeActive) {
    // 先备份 Claude 原始配置
    backup.claude = backupClaudeConfig();
    applyClaudeConfig(claudeActive, proxyBaseUrl);
    console.log(`[vv-switch] 启动时恢复 Claude 配置: ${claudeActive.name} (${claudeActive.model})`);
  }

  if (codexActive) {
    // 先备份 Codex 原始配置
    backup.codex = backupCodexConfig();
    applyCodexConfig(codexActive, proxyBaseUrl);
    console.log(`[vv-switch] 启动时恢复 Codex 配置: ${codexActive.name} (${codexActive.model})`);
  }
}

// ── 创建配置应用 ──────────────────────────────────────────────

export async function createConfigApp(options = {}) {
  const { host = 'localhost', port = 4321, debug = false, logs = false, logsDir = null, captureBody = true, protocolLog = false, protocolLogDir = null } = options;
  const proxyUrl = `http://localhost:${port}`;

  // ── 启动时清空 capability 缓存（内存 + 文件）──────────────────
  // 避免 provider 代码更新能力声明后，旧文件缓存导致 ensureCapabilities 误判
  clearDiscoveryCache();

  // ── 启动时恢复上次活跃的供应商配置 ────────────────────────────
  restoreActiveProvidersOnStartup(proxyUrl);

  // ── 日志 ──────────────────────────────────────────────────
  let logWriter = null;
  let logOutputDir = null;
  if (logs) {
    const { LogWriter } = await import('./log-writer.js');
    logOutputDir = logsDir || path.join(process.cwd(), '.vv-switch-logs');
    logWriter = new LogWriter(logOutputDir);
    console.log(`  \x1b[35m日志已开启:\x1b[0m \x1b[34m${logOutputDir}\x1b[0m`);
    console.log(`  \x1b[35m日志查看:\x1b[0m \x1b[34mfile://${path.join(logOutputDir, 'index.html')}\x1b[0m`);
  }

  // ── 协议日志（与 --logs 会话日志独立）──────────────────────
  // 每次链路一个 jsonl，记录 ingress/standard/upstream/egress 四阶段，方便排查协议转换问题
  let protocolLogOutputDir: string | null = null;
  if (protocolLog) {
    protocolLogOutputDir = protocolLogDir || path.join(process.cwd(), 'log');
    if (!existsSync(protocolLogOutputDir)) {
      mkdirSync(protocolLogOutputDir, { recursive: true });
    }
    console.log(`  \x1b[35m协议日志已开启:\x1b[0m \x1b[34m${protocolLogOutputDir}\x1b[0m`);
    console.log(`  \x1b[35m说明:\x1b[0m 每次链路一个 jsonl，含 ingress/standard/upstream/egress`);
  }

  // 默认代理应用（无活跃供应商时使用）
  const defaultProxyApp = createApp({
    upstreamBaseUrl: 'https://api.deepseek.com/v1',
    upstreamApiKey: '',
    defaultModel: 'deepseek-chat',
    protocolType: 'anthropic',
    modelCapabilities: { thinking: true, vision: false, audio: false, video: false, functionCalling: true, contextWindow: 1048576, maxOutputTokens: 0, promptCache: false },
    host,
    port,
    debug,
    logs: false, // 日志由 config-server 统一管理，createApp 内不再重复
    captureBody,
    logWriter,
    protocolLogDir: protocolLogOutputDir,
  });

  const app = express();
  app.use(express.json({ limit: '512mb' }));

  // ── 静态 UI ──────────────────────────────────────────────

  app.get('/', (_req, res) => {
    res.sendFile(path.join(_dirname, 'config-ui.html'));
  });

  // ── 日志查看（仅 --logs 启动时可用）────────────────────────

  if (logOutputDir) {
    app.use('/logs', express.static(logOutputDir, { index: 'index.html' }));
  }

  // ── 供应商管理 API ────────────────────────────────────────

  // GET /api/providers — 返回所有供应商 + 活跃状态
  app.get('/api/providers', (_req, res) => {
    const providers = loadProviders();
    const claudeActive = getActiveForClaude();
    const codexActive = getActiveForCodex();
    const openaiActive = getActiveForOpenai();
    res.json({
      providers,
      activeForClaude: claudeActive ? { id: claudeActive.id, name: claudeActive.name, model: claudeActive.model } : null,
      activeForCodex: codexActive ? { id: codexActive.id, name: codexActive.name, model: codexActive.model } : null,
      activeForOpenai: openaiActive ? { id: openaiActive.id, name: openaiActive.name, model: openaiActive.model } : null,
      proxyUrl,
      logsEnabled: !!logOutputDir,
    });
  });

  // POST /api/providers — 添加/更新供应商
  app.post('/api/providers', (req, res) => {
    try {
      const provider = upsertProvider(req.body);
      res.json({ success: true, provider });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/providers/:id — 删除供应商
  app.delete('/api/providers/:id', (req, res) => {
    const ok = deleteProvider(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: '供应商不存在' });
    }
    res.json({ success: true });
  });

  // PUT /api/providers/order — 拖拽排序持久化
  app.put('/api/providers/order', (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
      return res.status(400).json({ success: false, error: 'ids 必须是字符串数组' });
    }
    const providers = reorderProviders(ids);
    res.json({ success: true, providers });
  });

  // ── 提示词规则 API ───────────────────────────────────────

  // GET /api/prompt-rules — 返回所有提示词改写规则
  app.get('/api/prompt-rules', (_req, res) => {
    res.json({ rules: loadPromptRules() });
  });

  // POST /api/prompt-rules — 添加/更新规则
  app.post('/api/prompt-rules', (req, res) => {
    try {
      validatePromptRule(req.body);
      const rule = upsertPromptRule(req.body);
      res.json({ success: true, rule });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/prompt-rules/:id — 删除规则
  app.delete('/api/prompt-rules/:id', (req, res) => {
    const ok = deletePromptRule(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: '规则不存在' });
    }
    res.json({ success: true });
  });

  // POST /api/prompt-rules/preview — 预览单条规则替换效果
  app.post('/api/prompt-rules/preview', (req, res) => {
    try {
      const { text = '', ...rule } = req.body || {};
      res.json({ success: true, result: previewPromptRule(text, rule) });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // POST /api/providers/test — 测试连接（使用实际对话接口）
  app.post('/api/providers/test', async (req, res) => {
    const { baseUrl, apiKey, model, protocolType } = req.body || {};
    if (!baseUrl) {
      return res.status(400).json({ success: false, error: 'baseUrl 为必填' });
    }

    const protocol = protocolType || 'chat';
    const modelName = model || (protocol === 'anthropic' ? 'claude-sonnet-4-20250514' : protocol === 'ollama' ? 'llama3.2' : 'gpt-4o');
    let url;
    if (protocol === 'ollama') {
      url = buildOllamaUrl(baseUrl);
    } else if (protocol === 'anthropic') {
      url = buildMessagesUrl(baseUrl);
    } else if (protocol === 'responses') {
      url = appendVersionedPath(baseUrl, 'responses');
    } else {
      url = buildChatUrl(baseUrl);
    }

    try {
      let response;
      if (protocol === 'anthropic') {
        // Anthropic Messages API
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: modelName,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
      } else if (protocol === 'ollama') {
        // Ollama /api/chat
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            stream: false,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
      } else if (protocol === 'responses') {
        // OpenAI Responses API
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            max_output_tokens: 1,
            input: 'Hi',
          }),
        });
      } else {
        // OpenAI Chat Completions API
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
      }

      if (!response.ok) {
        const text = await response.text();
        return res.json({ success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, url });
      }

      const data = await response.json();

      // 从响应中提取有用信息
      let info = '';
      if (protocol === 'anthropic' && data.model) {
        info = `模型: ${data.model}`;
        if (data.usage) {
          info += ` | 输入: ${data.usage.input_tokens || 0} tokens, 输出: ${data.usage.output_tokens || 0} tokens`;
        }
      } else if (protocol === 'ollama' && data.message) {
        info = `模型: ${data.model || modelName}`;
        if (data.prompt_eval_count != null) {
          info += ` | 输入: ${data.prompt_eval_count} tokens, 输出: ${data.eval_count || 0} tokens`;
        }
      } else if (data.model) {
        info = `模型: ${data.model}`;
        if (data.usage) {
          const inputTokens = data.usage.input_tokens ?? data.usage.prompt_tokens ?? 0;
          const outputTokens = data.usage.output_tokens ?? data.usage.completion_tokens ?? 0;
          info += ` | 输入: ${inputTokens} tokens, 输出: ${outputTokens} tokens`;
        }
      }

      res.json({ success: true, info, url });
    } catch (e) {
      console.error('测试连接异常: %s, url=%s', e.message, url);
      res.json({ success: false, error: e.message, url });
    }
  });

  // POST /api/providers/apply — 应用配置
  app.post('/api/providers/apply', async (req, res) => {
    const { providerId, targets, port: appPort } = req.body || {};
    if (!providerId) {
      return res.status(400).json({ success: false, error: 'providerId 为必填' });
    }
    if (!targets || !Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ success: false, error: 'targets 为必填数组（["claude"] / ["codex"] / ["claude","codex"]）' });
    }

    const validTargets = targets.filter(t => t === 'claude' || t === 'codex' || t === 'openai');
    if (validTargets.length === 0) {
      return res.status(400).json({ success: false, error: 'targets 只能包含 "claude" / "codex" / "openai"' });
    }

    const provider = getProvider(providerId);
    if (!provider) {
      return res.status(404).json({ success: false, error: '供应商不存在' });
    }

    if ((provider.protocolType || 'chat') === 'responses' && validTargets.includes('claude')) {
      return res.status(400).json({ success: false, error: 'responses 协议仅支持应用到 Codex，不能应用到 Claude' });
    }

    const actualPort = appPort || port;
    const proxyBaseUrl = `http://localhost:${actualPort}`;
    const appliedTargets = [];

    try {
      for (const target of validTargets) {
        if (target === 'claude') {
          // 备份 Claude 配置（仅在首次备份时）
          if (!backup.claude) {
            backup.claude = backupClaudeConfig();
          }
          applyClaudeConfig(provider, proxyBaseUrl);
          appliedTargets.push('claude');
        } else if (target === 'codex') {
          // 备份 Codex 配置（仅在首次备份时）
          if (!backup.codex) {
            backup.codex = backupCodexConfig();
          }
          applyCodexConfig(provider, proxyBaseUrl);
          appliedTargets.push('codex');
        } else if (target === 'openai') {
          // OpenAI Chat Completions 端点（如 VS Code Copilot）由用户自行指向 vv-switch，
          // vv-switch 不写任何外部配置文件，只需标记活跃供应商即可。
          appliedTargets.push('openai');
        }
      }

      // 标记活跃状态
      markActiveFor(providerId, validTargets);

      const targetNameMap = { claude: 'Claude', codex: 'Codex', openai: 'OpenAI端点' };
      const targetNames = validTargets.map(t => targetNameMap[t] || t).join(' + ');
      console.log(`[vv-switch] 配置已应用到 ${targetNames}: ${provider.name} (${provider.model})`);
      res.json({ success: true, targets: validTargets });
    } catch (e) {
      console.error(`[vv-switch] 应用配置失败: ${e.message}`);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/providers/restore — 还原配置
  app.post('/api/providers/restore', (req, res) => {
    const { targets } = req.body || {};
    const restoreTargets = targets
      ? targets.filter(t => t === 'claude' || t === 'codex' || t === 'openai')
      : ['claude', 'codex', 'openai'];

    // openai 目标不写外部配置文件，无需备份即可"还原"（仅清除活跃标记）
    const hasOpenai = restoreTargets.includes('openai');
    const hasBackup = restoreTargets.some(t => {
      return t === 'claude' ? backup.claude : t === 'codex' ? backup.codex : false;
    });

    if (!hasBackup && !hasOpenai) {
      return res.json({ success: false, error: '没有可还原的备份（尚未应用配置）' });
    }

    try {
      for (const target of restoreTargets) {
        if (target === 'claude' && backup.claude) {
          restoreClaudeConfig(backup.claude);
          backup.claude = null;
        } else if (target === 'codex' && backup.codex) {
          restoreCodexConfig(backup.codex);
          backup.codex = null;
        }
        // target === 'openai': 无外部文件可还原，仅在下方 clearActiveFor 清除标记
      }
      clearActiveFor(restoreTargets);
      const targetNameMap = { claude: 'Claude', codex: 'Codex', openai: 'OpenAI端点' };
      console.log(`[vv-switch] 配置已还原: ${restoreTargets.map(t => targetNameMap[t] || t).join(', ')}`);
      res.json({ success: true });
    } catch (e) {
      console.error(`[vv-switch] 还原配置失败: ${e.message}`);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/backups — 查看备份文件及原始字段
  app.get('/api/backups', (req, res) => {
    const result = { claude: null, codex: null };

    if (backup.claude && existsSync(CLAUDE_BACKUP)) {
      try {
        const stat = statSync(CLAUDE_BACKUP);
        result.claude = {
          exists: true,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          content: readFileSync(CLAUDE_BACKUP, 'utf-8'),
          originalFields: backup.claude.originalFields,
        };
      } catch (e) {
        result.claude = { exists: false, error: e.message };
      }
    }

    if (backup.codex && existsSync(CODEX_BACKUP)) {
      try {
        const stat = statSync(CODEX_BACKUP);
        result.codex = {
          exists: true,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          content: readFileSync(CODEX_BACKUP, 'utf-8'),
          originalFields: backup.codex.originalFields,
        };
      } catch (e) {
        result.codex = { exists: false, error: e.message };
      }
    }

    res.json(result);
  });

  // DELETE /api/backups/:target — 删除备份文件并清除内存备份
  app.delete('/api/backups/:target', (req, res) => {
    const { target } = req.params;
    if (target !== 'claude' && target !== 'codex') {
      return res.status(400).json({ success: false, error: 'target 只能是 "claude" 或 "codex"' });
    }

    const backupPath = target === 'claude' ? CLAUDE_BACKUP : CODEX_BACKUP;

    try {
      // 删除本地备份文件
      if (existsSync(backupPath)) {
        unlinkSync(backupPath);
      }
      // 清除内存备份
      if (target === 'claude') {
        backup.claude = null;
      } else if (target === 'codex') {
        backup.codex = null;
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── 日志删除 API（仅 --logs 启动时可用）────────────────────

  if (logOutputDir) {
    // DELETE /api/logs/:filename — 删除日志文件
    app.delete('/api/logs/:filename', async (req, res) => {
      const { filename } = req.params;
      // 安全校验：只允许 .jsonl 文件，禁止路径穿越
      if (!filename.endsWith('.jsonl') || filename.includes('/') || filename.includes('..')) {
        return res.status(400).json({ success: false, error: '无效的文件名' });
      }
      const filePath = path.join(logOutputDir, filename);
      if (!existsSync(filePath)) {
        return res.json({ success: false, error: '日志文件不存在' });
      }
      try {
        unlinkSync(filePath);
        // 同步更新 data.js
        const { writeDataJs } = await import('./log-viewer-html.js');
        writeDataJs(logOutputDir);
        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
  }

  // ── 代理路由（全部复用 server.js 的 createApp()）────────────
  // 当有活跃供应商时，使用其配置创建代理；否则使用默认配置。

  // POST /v1/responses（Codex / OpenAI Responses API）
  app.post('/v1/responses', async (req, res) => {
    const active = getActiveForCodex();
    const proxy = active ? getOrCreateProxyApp(active, logWriter, debug, captureBody, protocolLogOutputDir) : defaultProxyApp;
    proxy(req, res);
  });

  // POST /v1/chat/completions（OpenAI Chat Completions，如 VS Code Copilot 自定义端点）
  // 优先使用 openai 专属活跃供应商；未设置时回退到 Codex，再回退到 Claude。
  app.post('/v1/chat/completions', async (req, res) => {
    const active = getActiveForOpenai() || getActiveForCodex() || getActiveForClaude();
    console.log(`[vv-switch] [DEBUG] /v1/chat/completions | activeProvider=${active?.name ?? 'NONE'} | model=${active?.model ?? 'N/A'} | baseUrl=${active?.baseUrl ?? 'N/A'} | protocolType=${active?.protocolType ?? 'N/A'} | stream=${Boolean(req.body?.stream)}`);
    if (!active) {
      console.warn('[vv-switch] [WARN] /v1/chat/completions | 没有活跃的供应商，使用默认代理');
    }
    const proxy = active ? getOrCreateProxyApp(active, logWriter, debug, captureBody, protocolLogOutputDir) : defaultProxyApp;
    proxy(req, res);
  });

  // POST /v1/messages（Claude / Anthropic Messages API）
  app.post('/v1/messages', async (req, res) => {
    const active = getActiveForClaude();
    console.log(`[vv-switch] [DEBUG] /v1/messages | activeProvider=${active?.name ?? 'NONE'} | model=${active?.model ?? 'N/A'} | baseUrl=${active?.baseUrl ?? 'N/A'} | protocolType=${active?.protocolType ?? 'N/A'} | stream=${Boolean(req.body?.stream)}`);
    if (!active) {
      console.warn('[vv-switch] [WARN] /v1/messages | 没有活跃的 Claude 供应商，使用默认代理');
    }
    const proxy = active ? getOrCreateProxyApp(active, logWriter, debug, captureBody, protocolLogOutputDir) : defaultProxyApp;
    const t0 = Date.now();
    // 监听响应完成，记录耗时
    res.on('finish', () => {
      console.log(`[vv-switch] [DEBUG] /v1/messages | 响应完成 | status=${res.statusCode} | duration=${Date.now() - t0}ms`);
    });
    res.on('error', (err) => {
      console.error(`[vv-switch] [DEBUG] /v1/messages | 响应错误: ${err.message} | duration=${Date.now() - t0}ms`);
    });
    proxy(req, res);
  });

  // GET /v1/models
  app.get('/v1/models', async (req, res) => {
    const active = getActiveForCodex() || getActiveForClaude();
    const proxy = active ? getOrCreateProxyApp(active, logWriter, debug, captureBody, protocolLogOutputDir) : defaultProxyApp;
    proxy(req, res);
  });

  // GET /health
  app.get('/health', (req, res) => {
    const active = getActiveForCodex() || getActiveForClaude();
    const proxy = active ? getOrCreateProxyApp(active, logWriter, debug, captureBody, protocolLogOutputDir) : defaultProxyApp;
    proxy(req, res);
  });

  // ── 其他未匹配路由交给默认代理应用 ────────────────────────

  app.use(defaultProxyApp);

  // ── 优雅退出 ──────────────────────────────────────────────

  function gracefulShutdown() {
    const targetsToRestore = [];
    if (backup.claude) targetsToRestore.push('Claude');
    if (backup.codex) targetsToRestore.push('Codex');

    if (targetsToRestore.length > 0) {
      console.log(`\n[vv-switch] 停止服务，正在还原 ${targetsToRestore.join(' + ')} 配置...`);
      try {
        if (backup.claude) { restoreClaudeConfig(backup.claude); backup.claude = null; }
        if (backup.codex) { restoreCodexConfig(backup.codex); backup.codex = null; }
        // 不清除 activeForClaude/activeForCodex，保留标记以便下次启动时设置默认生效模型
        console.log('[vv-switch] 配置已还原（活跃状态标记已保留）');
      } catch (e) {
        console.error(`[vv-switch] 还原配置失败: ${e.message}`);
      }
    }
    process.exit(0);
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  return app;
}

// ── Claude 配置备份 ───────────────────────────────────────────
// 备份 vv-switch 管理的字段的原始值，并写入本地备份文件

function backupClaudeConfig() {
  let originalFields = {};

  if (existsSync(CLAUDE_SETTINGS)) {
    try {
      const content = readFileSync(CLAUDE_SETTINGS, 'utf-8');
      const data = JSON.parse(content);
      // 只备份 vv-switch 管理的字段的原始值
      if (data.env) {
        for (const key of VV_CLAUDE_KEYS) {
          if (key in data.env) {
            originalFields[key] = data.env[key];
          }
        }
      }
      // 写入本地备份文件（完整配置快照）
      const dir = path.dirname(CLAUDE_BACKUP);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(CLAUDE_BACKUP, content, 'utf-8');
    } catch {
      // 解析失败，返回空备份
    }
  }

  // 备份 ~/.claude.json 中的 hasCompletedOnboarding 字段
  if (existsSync(CLAUDE_PROFILE)) {
    try {
      const profileContent = readFileSync(CLAUDE_PROFILE, 'utf-8');
      const profileData = JSON.parse(profileContent);
      originalFields._hasCompletedOnboarding = profileData.hasCompletedOnboarding;
      // 写入独立备份文件
      writeFileSync(CLAUDE_PROFILE_BACKUP, profileContent, 'utf-8');
    } catch {
      // 解析失败，忽略
    }
  }

  return { existed: Object.keys(originalFields).length > 0, originalFields };
}

// ── Claude 配置应用 ───────────────────────────────────────────

function applyClaudeConfig(provider, proxyBaseUrl) {
  let data = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    try {
      data = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf-8'));
    } catch {
      data = {};
    }
  }

  data.env = data.env || {};
  data.env.ANTHROPIC_BASE_URL = proxyBaseUrl;

  // 窗口上下文大小：供应商配置了 contextWindow 则写入 CLAUDE_CODE_MAX_CONTEXT_TOKENS，否则清除旧值
  const contextWindow = provider.modelCapabilities?.contextWindow;
  if (contextWindow && contextWindow > 0) {
    data.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindow);
  } else {
    delete data.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  }

    // claude只需要维护一个api端点地址就行，这样动态改vv-switch代理，claude不需要重启 位置(claude)： 2/2
  // data.env.ANTHROPIC_MODEL = provider.model;
  // data.env.ANTHROPIC_AUTH_TOKEN = 'vv-switch';
  // data.env.ANTHROPIC_SMALL_FAST_MODEL = provider.model;
  // data.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.model;
  // data.env.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.model;
  // data.env.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.model;
  // data.env.CLAUDE_CODE_SUBAGENT_MODEL = provider.model;

  // 确保目录存在
  const dir = path.dirname(CLAUDE_SETTINGS);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(data, null, 2) + '\n', 'utf-8');

  // 检查 ~/.claude.json 中是否有 hasCompletedOnboarding，没有则写入跳过登录验证
  let profileData = {};
  if (existsSync(CLAUDE_PROFILE)) {
    try {
      profileData = JSON.parse(readFileSync(CLAUDE_PROFILE, 'utf-8'));
    } catch {
      profileData = {};
    }
  }
  if (!profileData.hasCompletedOnboarding) {
    profileData.hasCompletedOnboarding = true;
    writeFileSync(CLAUDE_PROFILE, JSON.stringify(profileData, null, 2) + '\n', 'utf-8');
    console.log(`[vv-switch] 已写入 ~/.claude.json hasCompletedOnboarding=true，跳过登录验证`);
  }
}

// ── Claude 配置还原 ───────────────────────────────────────────
// 只还原 vv-switch 修改的字段，保留其他字段不变

function restoreClaudeConfig(bak) {
  let data = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    try {
      data = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf-8'));
    } catch {
      data = {};
    }
  }

  // 删除 vv-switch 写入的 env keys
  if (data.env) {
    for (const key of VV_CLAUDE_KEYS) {
      delete data.env[key];
    }
    if (Object.keys(data.env).length === 0) delete data.env;
  }

  // 恢复原始值（如果备份中有）
  if (bak.originalFields && Object.keys(bak.originalFields).length > 0) {
    if (!data.env) data.env = {};
    for (const [key, value] of Object.entries(bak.originalFields)) {
      // 跳过用于 ~/.claude.json 恢复的元字段
      if (key === '_hasCompletedOnboarding') continue;
      data.env[key] = value;
    }
    // 如果恢复后 env 为空，删除它
    if (Object.keys(data.env).length === 0) delete data.env;
  }

  const dir = path.dirname(CLAUDE_SETTINGS);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(data, null, 2) + '\n', 'utf-8');

  // 还原 ~/.claude.json 中的 hasCompletedOnboarding
  const originalProfileBackup = CLAUDE_PROFILE_BACKUP;
  if (existsSync(originalProfileBackup)) {
    try {
      // 从备份文件还原
      const backupContent = readFileSync(originalProfileBackup, 'utf-8');
      writeFileSync(CLAUDE_PROFILE, backupContent, 'utf-8');
      unlinkSync(originalProfileBackup);
      console.log(`[vv-switch] 已还原 ~/.claude.json hasCompletedOnboarding`);
    } catch {
      // 备份文件读取失败，不做处理
    }
  } else if (bak.originalFields && '_hasCompletedOnboarding' in bak.originalFields) {
    // 原来不存在 hasCompletedOnboarding（备份中为 undefined），删除它
    let profileData = {};
    if (existsSync(CLAUDE_PROFILE)) {
      try {
        profileData = JSON.parse(readFileSync(CLAUDE_PROFILE, 'utf-8'));
      } catch {
        profileData = {};
      }
    }
    delete profileData.hasCompletedOnboarding;
    writeFileSync(CLAUDE_PROFILE, JSON.stringify(profileData, null, 2) + '\n', 'utf-8');
  }
}

// ── Codex 配置备份 ────────────────────────────────────────────
// 备份 vv-switch 管理的字段的原始值，并写入本地备份文件

function backupCodexConfig() {
  let originalFields = {};

  if (existsSync(CODEX_CONFIG)) {
    try {
      const content = readFileSync(CODEX_CONFIG, 'utf-8');
      const data = parse(content);
      // 只备份 vv-switch 管理的字段的原始值
      if ('model' in data) originalFields.model = data.model;
      if ('model_provider' in data) originalFields.model_provider = data.model_provider;
      if (data.model_providers && data.model_providers['vv-switch']) {
        originalFields.vvSwitchProvider = data.model_providers['vv-switch'];
      }
      // 写入本地备份文件（完整配置快照）
      const dir = path.dirname(CODEX_BACKUP);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(CODEX_BACKUP, content, 'utf-8');
    } catch {
      // 解析失败，返回空备份
    }
  }

  return { existed: Object.keys(originalFields).length > 0, originalFields };
}

// ── Codex 配置应用 ────────────────────────────────────────────

function applyCodexConfig(provider, proxyBaseUrl) {
  let data = {};
  if (existsSync(CODEX_CONFIG)) {
    try {
      const content = readFileSync(CODEX_CONFIG, 'utf-8');
      data = parse(content);
    } catch {
      data = {};
    }
  }

  // 设置 vv-switch 为当前 provider
  data.model = provider.model;
  data.model_provider = 'vv-switch';

  // 添加 vv-switch provider
  if (!data.model_providers) data.model_providers = {};
  data.model_providers['vv-switch'] = {
    name: provider.model,
    base_url: `${proxyBaseUrl}/v1`,
    wire_api: 'responses',
  };

  // 确保目录存在
  const dir = path.dirname(CODEX_CONFIG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(CODEX_CONFIG, stringify(data), 'utf-8');
}

// ── Codex 配置还原 ────────────────────────────────────────────
// 只还原 vv-switch 修改的字段，保留其他字段不变

function restoreCodexConfig(bak) {
  let data = {};
  if (existsSync(CODEX_CONFIG)) {
    try {
      const content = readFileSync(CODEX_CONFIG, 'utf-8');
      data = parse(content);
    } catch {
      data = {};
    }
  }

  // 删除 vv-switch 写入的字段
  delete data.model;
  delete data.model_provider;
  if (data.model_providers) {
    delete data.model_providers['vv-switch'];
    // 如果 model_providers 为空对象，删除它
    if (Object.keys(data.model_providers).length === 0) delete data.model_providers;
  }

  // 恢复原始值（如果备份中有）
  if (bak.originalFields) {
    if ('model' in bak.originalFields) data.model = bak.originalFields.model;
    if ('model_provider' in bak.originalFields) data.model_provider = bak.originalFields.model_provider;
    if (bak.originalFields.vvSwitchProvider) {
      if (!data.model_providers) data.model_providers = {};
      data.model_providers['vv-switch'] = bak.originalFields.vvSwitchProvider;
    }
  }

  const dir = path.dirname(CODEX_CONFIG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // 如果 data 为空对象，删除文件
  if (Object.keys(data).length === 0) {
    if (existsSync(CODEX_CONFIG)) unlinkSync(CODEX_CONFIG);
  } else {
    writeFileSync(CODEX_CONFIG, stringify(data), 'utf-8');
  }
}
