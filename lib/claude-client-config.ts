export const ANTHROPIC_CONFIG_STORAGE_API_KEY = "echo-agents.claudeApiKey"
export const ANTHROPIC_CONFIG_STORAGE_BASE_URL = "echo-agents.claudeBaseUrl"

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"

export type ClaudeClientStoredConfig = {
  apiKey: string
  baseUrl: string
}

export function readClaudeClientConfig(): ClaudeClientStoredConfig {
  if (typeof window === "undefined") {
    return { apiKey: "", baseUrl: "" }
  }
  return {
    apiKey: localStorage.getItem(ANTHROPIC_CONFIG_STORAGE_API_KEY) ?? "",
    baseUrl: localStorage.getItem(ANTHROPIC_CONFIG_STORAGE_BASE_URL) ?? "",
  }
}

export function writeClaudeClientConfig(c: ClaudeClientStoredConfig): void {
  localStorage.setItem(ANTHROPIC_CONFIG_STORAGE_API_KEY, c.apiKey)
  localStorage.setItem(ANTHROPIC_CONFIG_STORAGE_BASE_URL, c.baseUrl)
}

export function clearClaudeClientConfig(): void {
  localStorage.removeItem(ANTHROPIC_CONFIG_STORAGE_API_KEY)
  localStorage.removeItem(ANTHROPIC_CONFIG_STORAGE_BASE_URL)
}

export function normalizeClaudeBaseUrl(input: string): string | null {
  const t = input.trim()
  if (t.length === 0) return null
  if (!t.startsWith("https://")) return null
  try {
    const u = new URL(t)
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null
    // The native SDK appends /v1/messages; a complete endpoint duplicates the path.
    if (/\/(?:v1(?:\/messages)?|messages|chat\/completions)\/?$/.test(u.pathname)) return null
    let s = u.toString()
    if (s.endsWith("/")) s = s.slice(0, -1)
    return s
  } catch {
    return null
  }
}

export function claudeFieldsForRequest(
  apiKey: string,
  baseUrl: string,
): { claudeApiKey?: string; claudeBaseUrl?: string } {
  const out: { claudeApiKey?: string; claudeBaseUrl?: string } = {}
  const k = apiKey.trim()
  if (k.length > 0) out.claudeApiKey = k
  const n = normalizeClaudeBaseUrl(baseUrl)
  if (n !== null) out.claudeBaseUrl = n
  return out
}
