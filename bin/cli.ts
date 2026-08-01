#!/usr/bin/env node

/**
 * vv-switch CLI
 *
 * vv-switch - OpenAI Responses API 转 Chat Completions 代理脚手架
 *
 * Usage:
 *   npx vv-switch              启动配置网页与代理服务（默认 localhost:4321）
 *   npx vv-switch --logs       启动并开启日志记录与可视化
 */

import { Command } from 'commander';
import { resolve } from 'path';

const VERSION = '0.5.3';

// ── config 命令 ────────────────────────────────────────────────────────────

async function configAction(options: { host?: string; port?: string; debug?: boolean; logs?: boolean; logsDir?: string; body?: boolean; protocolLog?: boolean; protocolLogDir?: string }) {
  const { createConfigApp } = await import('../src/config-server.js');

  const host = options.host || 'localhost';
  const port = parseInt(options.port || '4321', 10);
  const debug = options.debug === true;
  const logs = options.logs === true;
  const logsDir = options.logsDir ? resolve(options.logsDir) : null;
  const captureBody = options.body !== false;
  const protocolLog = options.protocolLog === true;
  const protocolLogDir = options.protocolLogDir ? resolve(options.protocolLogDir) : null;

  const app = await createConfigApp({
    host,
    port,
    debug,
    logs,
    logsDir,
    captureBody,
    protocolLog,
    protocolLogDir,
  });

  const server = app.listen(port, host, () => {
    const c = {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      cyan: '\x1b[36m',
      green: '\x1b[32m',
      blue: '\x1b[34m',
      yellow: '\x1b[33m',
    };
    console.log(`\n  ${c.bold}${c.cyan}vv-switch 配置服务已启动${c.reset}`);
    console.log(`  ${c.green}本地代理地址:${c.reset} ${c.blue}http://${host}:${port}/v1${c.reset} ${c.dim}（OpenAi的chat-completions协议）${c.reset}`);
    console.log(`  ${c.green}配置管理网页:${c.reset} ${c.blue}http://localhost:${port}${c.reset}`);
    console.log(`  ${c.dim}按 ${c.reset}${c.yellow}Ctrl+C${c.reset}${c.dim} 停止服务并自动还原 Claude/Codex 配置${c.reset}\n`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    const red = '\x1b[31m';
    const reset = '\x1b[0m';
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ${red}错误: 端口 ${port} 已被占用${reset}`);
      console.error(`  请尝试其他端口: npx vv-switch --port <端口>\n`);
    } else {
      console.error(`\n  ${red}启动失败: ${err.message}${reset}\n`);
    }
    process.exit(1);
  });
}

// ── CLI 定义 ──────────────────────────────────────────────────────────────

const cli = new Command();

cli
  .name('vv-switch')
  .description('OpenAI Responses API 转 Chat Completions 代理脚手架')
  .version(VERSION);

cli
  .option('-p, --port <port>', '监听端口（默认 4321）')
  .option('-h, --host <host>', '监听地址（默认 localhost）')
  .option('--debug', '开启调试日志')
  .option('--logs', '开启日志记录与可视化（保存到 .vv-switch-logs 目录）')
  .option('--logs-dir <dir>', '自定义日志目录路径')
  .option('--no-body', '不捕获请求体和响应体到日志（精简日志）')
  .option('--protocol-log', '开启协议转换链路日志（每次链路一个 jsonl，记录 ingress/standard/upstream/egress）')
  .option('--protocol-log-dir <dir>', '自定义协议日志目录路径（默认 ./log）')
  .action(configAction);

cli.parse();
