import Anthropic from "@anthropic-ai/sdk"
import type { Json } from "@/lib/json-parse"
import { normalizeClaudeBaseUrl } from "@/lib/claude-client-config"

export function claudeModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6"
}

/** Log only the known region; custom URLs can contain credentials or private paths. */
export function claudeEndpointRegion(baseURL: string): string {
  try {
    const host = new URL(baseURL).hostname
    if (host === "api.anthropic.com") return "anthropic"
    return "custom"
  } catch {
    return "invalid"
  }
}

/** 生产默认禁止客户端传入 API Key；开发或显式 ALLOW_CLIENT_ANTHROPIC_KEY=1 时允许 */
export function isClientClaudeKeyAllowed(): boolean {
  if (process.env.ALLOW_CLIENT_ANTHROPIC_KEY === "1") return true
  if (process.env.ALLOW_CLIENT_ANTHROPIC_KEY === "0") return false
  return process.env.NODE_ENV === "development"
}

export function resolveClaudeClient(
  root: { readonly [k: string]: Json },
):
  | { client: Anthropic; keySource: "client" | "server" }
  | { status: number; error: string; code?: string } {
  const keyFromBody =
    typeof root.claudeApiKey === "string" ? root.claudeApiKey.trim() : ""

  if (keyFromBody.length > 0 && !isClientClaudeKeyAllowed()) {
    return {
      status: 403,
      error:
        "出于安全考虑，API Key 仅能通过服务端环境变量 ANTHROPIC_API_KEY 配置，请勿在浏览器中提交密钥。",
      code: "client_key_forbidden",
    }
  }

  const apiKey =
    keyFromBody.length > 0 ? keyFromBody : (process.env.ANTHROPIC_API_KEY ?? "").trim()
  if (apiKey.length === 0) {
    return {
      status: 400,
      error:
        "缺少 API Key：请在服务端配置环境变量 ANTHROPIC_API_KEY（生产环境不在浏览器中保存密钥）。",
      code: "missing_api_key",
    }
  }

  const urlFromBody =
    typeof root.claudeBaseUrl === "string" ? root.claudeBaseUrl.trim() : ""
  const configuredUrl = urlFromBody && isClientClaudeKeyAllowed()
    ? urlFromBody : process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com"
  const baseURL = normalizeClaudeBaseUrl(configuredUrl)
  if (!baseURL) {
    return {
      status: 400,
      code: "invalid_base_url",
      error: "Claude Base URL 须为 https 基础地址（例如 https://api.anthropic.com），不含 /v1、/messages、查询参数或凭据。",
    }
  }

  return {
    client: new Anthropic({ apiKey, baseURL, logLevel: "off" }),
    keySource: keyFromBody.length > 0 ? "client" : "server",
  }
}

export function claudeTimeoutMs(): number {
  const raw = process.env.ANTHROPIC_TIMEOUT_MS
  if (raw === undefined || raw.trim() === "") return 60_000
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 5_000 ? n : 60_000
}
