import './openai-compatible/index.js';
import './anthropic/index.js';
import './ollama/index.js';
import './openai/index.js';

export { registerProvider, getProviderPlugin, listProviderPlugins, clearProviderPlugins } from './registry.js';
