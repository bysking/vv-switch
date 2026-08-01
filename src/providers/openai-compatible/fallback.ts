/**
 * openai-compatible provider 运行时降级工具
 *
 * 当上游因 thinking/reasoning 或 image/vision 参数返回 4xx 时,
 * 识别错误类型并给出剥离选项,供 chat()/stream() 降级重试一次。
 *
 * 设计原则:纯函数,无副作用,便于测试。
 */

export interface FallbackOptions {
  stripThinking: boolean;
  stripImages: boolean;
}

export interface RejectionClassification {
  thinking: boolean;
  image: boolean;
}

const THINKING_KEYWORDS = ['thinking', 'reasoning', 'reasoning_effort', 'budget_tokens'];
const IMAGE_KEYWORDS = ['image', 'vision', 'multimodal', 'image_url'];

const REJECTION_STATUSES = new Set([400, 422]);

/**
 * 判断上游错误是否因 thinking/image 能力缺失,返回命中的能力组。
 * 仅 400/422 且 body 命中关键词才判定,避免误伤 5xx 等临时错误。
 */
export function classifyRejection(status: number, body: string): RejectionClassification {
  if (!REJECTION_STATUSES.has(status)) {
    return { thinking: false, image: false };
  }
  const lower = body.toLowerCase();
  return {
    thinking: THINKING_KEYWORDS.some((k) => lower.includes(k)),
    image: IMAGE_KEYWORDS.some((k) => lower.includes(k)),
  };
}

export function shouldFallback(status: number, body: string): boolean {
  const c = classifyRejection(status, body);
  return c.thinking || c.image;
}

export function buildFallbackOptions(classification: RejectionClassification): FallbackOptions {
  return {
    stripThinking: classification.thinking,
    stripImages: classification.image,
  };
}
