import { loadEnvConfig } from "@next/env"
import Anthropic from "@anthropic-ai/sdk"
import { claudeEndpointRegion, claudeModel, resolveClaudeClient } from "../lib/safety/claude-server"
import { logSafeError, safeUpstreamRequestId } from "../lib/safety/safe-log"

// Match next dev's precedence: process env > .env.development.local > .env.local > .env.
loadEnvConfig(process.cwd(), true)

async function main() {
  const resolved = resolveClaudeClient({})
  if ("error" in resolved) {
    console.error(JSON.stringify({ scope: "diagnose/claude", code: resolved.code ?? "invalid_configuration", message: resolved.error }))
    process.exitCode = 1
    return
  }
  const client = resolved.client.withOptions({ maxRetries: 0, timeout: 15_000 })
  const requestId = crypto.randomUUID()
  const started = Date.now()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 20_000)
  let phase = "request"
  let chunksReceived = 0
  let contentChars = 0
  let messageStopped = false
  try {
    // Only a synthetic prompt; never read or replay private conversations.
    const { data: stream, response, request_id } = await client.messages.create({
      model: claudeModel(),
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "Reply with OK only." }],
    }, { signal: abort.signal }).withResponse()
    phase = "stream"
    for await (const chunk of stream) {
      chunksReceived++
      if (chunk.type === "message_stop") messageStopped = true
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") contentChars += chunk.delta.text.length
    }
    const ok = contentChars > 0 && messageStopped
    console.log(JSON.stringify({
      scope: "diagnose/claude", requestId, ok, status: response.status,
      upstreamRequestId: safeUpstreamRequestId(request_id),
      chunksReceived, contentChars, durationMs: Date.now() - started,
    }))
    if (!ok) process.exitCode = 1
  } catch (error) {
    logSafeError("diagnose/claude", abort.signal.aborted ? new Anthropic.APIConnectionTimeoutError() : error, {
      requestId, phase, model: claudeModel(), keySource: resolved.keySource,
      endpointRegion: claudeEndpointRegion(client.baseURL),
      chunksReceived, contentChars, durationMs: Date.now() - started,
    })
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

void main()
