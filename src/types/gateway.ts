/**
 * Capability 类型与 Gateway 通用类型
 */

export const CAPABILITY_STATUS = Object.freeze({
  NATIVE: 'native',
  PROXY: 'proxy',
  EMULATE: 'emulate',
  UNSUPPORTED: 'unsupported',
} as const);

export type CapabilityStatus = typeof CAPABILITY_STATUS[keyof typeof CAPABILITY_STATUS];

export interface CapabilityMap {
  chat: CapabilityStatus;
  responses: CapabilityStatus;
  vision: CapabilityStatus;
  image: CapabilityStatus;
  audio: CapabilityStatus;
  tool_call: CapabilityStatus;
  parallel_tool: CapabilityStatus;
  reasoning: CapabilityStatus;
  thinking: CapabilityStatus;
  json_schema: CapabilityStatus;
  stream: CapabilityStatus;
  mcp: CapabilityStatus;
  computer_use: CapabilityStatus;
  batch: CapabilityStatus;
  cache: CapabilityStatus;
  prompt_cache: CapabilityStatus;
}
