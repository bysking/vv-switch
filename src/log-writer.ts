/**
 * Log writer for vv-switch
 *
 * Saves request/response logs as JSONL files and generates an HTML viewer
 * (adapted from claude-trace pattern).
 */

import fs from 'fs';
import path from 'path';
import { generateAndWriteIndexHtml, writeDataJs } from './log-viewer-html.js';

export class LogWriter {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this._ensureOutputDirAndCreateStream();
  }

  /**
   * Ensure output directory exists and create a new log file stream.
   * Also regenerates index.html if needed.
   */
  _ensureOutputDirAndCreateStream() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    // Always regenerate index.html on startup so the viewer template stays
    // in sync with the current code (no stale UI after upgrades).
    generateAndWriteIndexHtml(this.outputDir);

    // Create new log file with current timestamp
    const d = new Date();
    const opts = { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    const parts = new Intl.DateTimeFormat('sv-SE', opts).formatToParts(d);
    const get = (type) => (parts.find(p => p.type === type) || {}).value || '00';
    const timestamp = get('year') + '-' + get('month') + '-' + get('day') + '-' + get('hour') + '-' + get('minute') + '-' + get('second') + '-' + String(d.getMilliseconds()).padStart(3, '0');
    this.logFile = path.join(this.outputDir, `vv-switch-${timestamp}.jsonl`);
    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
  }

  /**
   * Check if log file and directory still exist, recreate if needed.
   */
  _checkAndRecreateStreamIfNeeded() {
    // Check if output directory exists
    if (!fs.existsSync(this.outputDir)) {
      // Close old stream if it exists
      if (this.stream) {
        this.stream.end();
      }
      this._ensureOutputDirAndCreateStream();
      return;
    }

    // Check if log file still exists
    if (this.logFile && !fs.existsSync(this.logFile)) {
      // Log file was deleted, create a new one
      if (this.stream) {
        this.stream.end();
      }
      this._ensureOutputDirAndCreateStream();
    }
  }

  /**
   * Write a log entry.
   * @param {object} entry - Log entry object
   */
  write(entry) {
    // Check if log file/directory still exists before writing
    this._checkAndRecreateStreamIfNeeded();

    const line = JSON.stringify(entry) + '\n';

    return new Promise((resolve) => {
      this.stream.write(line, () => {
        // Update data.js after each entry (lightweight)
        setTimeout(() => {
          writeDataJs(this.outputDir);
        }, 200);
        resolve();
      });
    });
  }

  /**
   * Write a summary to stderr.
   */
  writeSummary(entry) {
    const method = entry.method || 'POST';
    const endpoint = this.shortenUrl(entry.endpoint || '');
    const status = entry.responseStatus || '';
    const duration = entry.durationMs || 0;
    const icon = typeof status === 'number' && status >= 400 ? '❌' : '✅';
    process.stderr.write(`${icon} [vv-switch] ${method} ${endpoint} -> ${status} (${duration}ms)\n`);
  }

  shortenUrl(url) {
    try {
      const u = new URL(url);
      return u.pathname;
    } catch {
      return url;
    }
  }

  getLogPath() {
    return this.logFile;
  }

  getOutputDir() {
    return this.outputDir;
  }

  close() {
    return new Promise((resolve) => {
      if (this.stream) {
        this.stream.end(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
