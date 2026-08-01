/**
 * URL utils tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBaseUrl,
  hasVersionSuffix,
  appendVersionedPath,
  normalizeBaseUrlForOllama,
  buildChatUrl,
  buildOllamaChatUrl,
  buildMessagesUrl,
  buildResponsesUrl,
} from '../src/utils/url.js';

describe('utils/url', () => {
  it('normalizeBaseUrl removes trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://api.example.com/'), 'https://api.example.com');
    assert.equal(normalizeBaseUrl('https://api.example.com//'), 'https://api.example.com');
    assert.equal(normalizeBaseUrl('https://api.example.com'), 'https://api.example.com');
  });

  it('hasVersionSuffix detects /vN suffix', () => {
    assert.equal(hasVersionSuffix('https://api.example.com/v1'), true);
    assert.equal(hasVersionSuffix('https://api.example.com/v3/'), true);
    assert.equal(hasVersionSuffix('https://api.example.com'), false);
    assert.equal(hasVersionSuffix('https://api.example.com/foo'), false);
  });

  it('appendVersionedPath preserves user version', () => {
    assert.equal(appendVersionedPath('https://api.example.com', 'messages'), 'https://api.example.com/v1/messages');
    assert.equal(appendVersionedPath('https://api.example.com/v2', 'messages'), 'https://api.example.com/v2/messages');
    assert.equal(appendVersionedPath('https://api.example.com/v3/', 'messages'), 'https://api.example.com/v3/messages');
  });

  it('normalizeBaseUrlForOllama strips /vN', () => {
    assert.equal(normalizeBaseUrlForOllama('http://localhost:11434/v1'), 'http://localhost:11434');
    assert.equal(normalizeBaseUrlForOllama('http://localhost:11434'), 'http://localhost:11434');
  });

  it('buildChatUrl appends /chat/completions', () => {
    assert.equal(buildChatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  });

  it('buildOllamaChatUrl appends /api/chat', () => {
    assert.equal(buildOllamaChatUrl('http://localhost:11434/v1'), 'http://localhost:11434/api/chat');
  });

  it('buildMessagesUrl is version-aware', () => {
    assert.equal(buildMessagesUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
    assert.equal(buildMessagesUrl('https://api.x.com/v3'), 'https://api.x.com/v3/messages');
  });

  it('buildResponsesUrl is version-aware', () => {
    assert.equal(buildResponsesUrl('https://api.openai.com'), 'https://api.openai.com/v1/responses');
    assert.equal(buildResponsesUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/responses');
  });
});
