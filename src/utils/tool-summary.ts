/**
 * 工具调用参数摘要 —— 让终端日志能一眼看出"这个工具调用来干嘛的"。
 *
 * 针对常见工具名做特化展示（exec_command / bash 类显示命令，
 * read_file / write 类显示文件名等），其余工具做 JSON 截断。
 */

/** 常见 shell 执行类工具名（小写匹配） */
const SHELL_TOOLS = new Set([
  'exec_command', 'bash', 'shell', 'execute_command', 'run_command',
  'exec', 'cmd', 'command', 'terminal', 'subprocess',
]);

/** 常见文件读取类工具名 */
const FILE_READ_TOOLS = new Set([
  'read_file', 'view_file', 'cat', 'file_read', 'read',
]);

/** 常见文件写入类工具名 */
const FILE_WRITE_TOOLS = new Set([
  'write_file', 'create_file', 'edit_file', 'file_write', 'write',
]);

function tryParseArgs(args: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(args);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 从参数字符串中提取"命令"字段，支持多种常见命名
 */
function extractCommand(argsObj: Record<string, unknown>): string | null {
  for (const key of ['command', 'cmd', 'shell', 'script', 'code', 'bash']) {
    const v = argsObj[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  // { command: { value: '...' } } 这种
  const cmd = argsObj.command;
  if (cmd && typeof cmd === 'object') {
    for (const key of ['value', 'text', 'content']) {
      const v = (cmd as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return null;
}

function extractFilePath(argsObj: Record<string, unknown>): string | null {
  for (const key of ['path', 'file_path', 'file', 'filename', 'filepath', 'url']) {
    const v = argsObj[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/**
 * 生成工具调用的单行摘要,用于终端日志。
 *
 * 示例:
 *   exec_command(command="ls -la /tmp")
 *   read_file(path="/etc/hosts")
 *   my_custom_tool({"key":"value",...})
 */
export function summarizeToolArgs(name: string, args: string, maxLen = 160): string {
  const trimmed = args.trim();
  if (!trimmed) return '(no args)';

  const argsObj = tryParseArgs(trimmed);
  const lowerName = name.toLowerCase();

  // Shell 类工具 —— 突出显示命令
  if (SHELL_TOOLS.has(lowerName) || lowerName.includes('bash') || lowerName.includes('shell') || lowerName.includes('command')) {
    if (argsObj) {
      const cmd = extractCommand(argsObj);
      if (cmd) {
        const oneLine = cmd.replace(/\s+/g, ' ').trim();
        return `command="${oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine}"`;
      }
    }
    // 解析失败就直接展示
    const oneLine = trimmed.replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
  }

  // 文件读/写类工具 —— 突出显示路径
  if (FILE_READ_TOOLS.has(lowerName) || FILE_WRITE_TOOLS.has(lowerName)
    || lowerName.includes('file') || lowerName.includes('read') || lowerName.includes('write')) {
    if (argsObj) {
      const path = extractFilePath(argsObj);
      if (path) {
        const action = FILE_WRITE_TOOLS.has(lowerName) || lowerName.includes('write') ? 'write' : 'read';
        return `${action} path="${path}"`;
      }
    }
  }

  // 通用:如果是 JSON 对象,挑几个关键字段;否则截断显示
  if (argsObj) {
    const keys = Object.keys(argsObj);
    if (keys.length <= 3) {
      const parts: string[] = [];
      for (const k of keys) {
        const v = argsObj[k];
        const vStr = typeof v === 'string' ? `"${v.length > 60 ? v.slice(0, 60) + '…' : v}"`
          : typeof v === 'number' || typeof v === 'boolean' ? String(v)
          : Array.isArray(v) ? `[${v.length} items]`
          : v && typeof v === 'object' ? '{…}'
          : String(v);
        parts.push(`${k}=${vStr}`);
      }
      const result = parts.join(' ');
      return result.length > maxLen ? result.slice(0, maxLen) + '…' : result;
    }
    return `{${keys.length} fields}`;
  }

  // 非 JSON 纯文本
  const oneLine = trimmed.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
}

/**
 * 判断一个工具名是否是 shell/命令执行类（用于日志颜色或特别标记）
 */
export function isShellTool(name: string): boolean {
  const lower = name.toLowerCase();
  return SHELL_TOOLS.has(lower) || lower.includes('bash') || lower.includes('shell') || lower.includes('command');
}
