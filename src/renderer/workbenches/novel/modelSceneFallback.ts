// 模型场景失效时只用于识别并阻断请求；严禁在这里生成后备模型候选。
export function modelUnavailableErrorMessage(cause: unknown): string | null {
  const message = cause instanceof Error ? cause.message : String(cause);
  const normalized = message.toLowerCase();
  const indicators = [
    "selected model",
    "may not exist",
    "may not have access",
    "model_not_found",
    "model_not_available",
    "model does not exist",
    "model not found",
    "model unavailable",
    "场景绑定的模型当前不可用",
    "模型不存在",
    "模型不可用",
    "无权访问模型",
    "没有权限访问模型",
  ];
  return indicators.some((indicator) => normalized.includes(indicator))
    ? message
    : null;
}
