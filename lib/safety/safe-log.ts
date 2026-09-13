import Anthropic from "@anthropic-ai/sdk"

// Provider fields are untrusted: use known diagnostic values, never error.message/body.
const ERROR_TYPES = new Set([
  "incorrect_api_key_error", "invalid_authentication_error", "invalid_request_error",
  "permission_denied_error", "resource_not_found_error", "content_filter",
  "engine_overloaded_error", "exceeded_current_quota_error", "rate_limit_reached_error",
  "server_error", "unexpected_output", "authentication_error", "rate_limit_error",
  "permission_error", "not_found_error", "overloaded_error", "api_error",
])
const ERROR_CODES = new Set([
  "invalid_api_key", "insufficient_quota", "rate_limit_exceeded", "model_not_found",
  "context_length_exceeded", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND",
  "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "incomplete_stream",
])

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

export function safeUpstreamRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) &&
    !value.toLowerCase().startsWith("sk-") ? value : undefined
}

export function safeErrorDetails(error: unknown) {
  const fields = record(error)
  const body = record(fields.error)
  const nested = record(body.error ?? body)
  const type = fields.type ?? nested.type
  const code = fields.code ?? nested.code
  let causeCode: string | undefined
  let cause = fields.cause
  for (let depth = 0; cause && depth < 4; depth++) {
    const next = record(cause)
    if (typeof next.code === "string" && ERROR_CODES.has(next.code)) causeCode = next.code
    cause = next.cause
  }
  // instanceof also works when production bundlers rename SDK constructors.
  const classes = [
    [Anthropic.APIConnectionTimeoutError, "APIConnectionTimeoutError"],
    [Anthropic.APIUserAbortError, "APIUserAbortError"],
    [Anthropic.APIConnectionError, "APIConnectionError"],
    [Anthropic.AuthenticationError, "AuthenticationError"],
    [Anthropic.BadRequestError, "BadRequestError"],
    [Anthropic.PermissionDeniedError, "PermissionDeniedError"],
    [Anthropic.NotFoundError, "NotFoundError"],
    [Anthropic.RateLimitError, "RateLimitError"],
    [Anthropic.InternalServerError, "InternalServerError"],
    [Anthropic.APIError, "APIError"],
    [TypeError, "TypeError"],
  ] as const
  return {
    errorName: classes.find(([kind]) => error instanceof kind)?.[1] ?? "Error",
    errorCode: typeof code === "string" && ERROR_CODES.has(code) ? code : "unknown",
    ...(typeof type === "string" && ERROR_TYPES.has(type) ? { errorType: type } : {}),
    ...(typeof fields.status === "number" && Number.isInteger(fields.status) &&
      fields.status >= 100 && fields.status <= 599 ? { status: fields.status } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...(safeUpstreamRequestId(fields.requestID) ? { upstreamRequestId: safeUpstreamRequestId(fields.requestID) } : {}),
    errorKind: sanitizeErrorMessage(error),
  }
}

/** 安全日志：meta 只能传入应用生成的诊断值，不记录用户正文或 API Key。 */
export function logSafeError(
  scope: string,
  error: unknown,
  meta?: Record<string, string | number | boolean>,
): void {
  const payload = {
    at: new Date().toISOString(),
    scope,
    ...meta,
    ...safeErrorDetails(error),
  }
  console.error(JSON.stringify(payload))
}

export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "upstream_timeout"
  if (error instanceof Anthropic.APIUserAbortError) return "upstream_cancelled"
  if (error instanceof Anthropic.APIConnectionError) return "upstream_connection"
  const fields = record(error)
  const body = record(fields.error)
  const type = fields.type ?? record(body.error ?? body).type
  if (fields.code === "incomplete_stream") return "upstream_incomplete"
  if (fields.status === 401 || type === "authentication_error" || type === "incorrect_api_key_error" || type === "invalid_authentication_error") return "upstream_auth"
  if (fields.status === 403 || type === "permission_error") return "upstream_permission"
  if (fields.status === 429 || type === "rate_limit_error") return "upstream_rate_limited"
  if (type === "overloaded_error" || type === "api_error") return "upstream_server_error"
  if (fields.status === 400 || fields.status === 422) return "upstream_bad_request"
  if (fields.status === 404) return "upstream_not_found"
  if (typeof fields.status === "number" && fields.status >= 500) return "upstream_server_error"
  if (error instanceof Error && (error.name === "TimeoutError" || /^(timeout|request timed out\.)$/i.test(error.message))) return "upstream_timeout"
  return "upstream_error"
}
