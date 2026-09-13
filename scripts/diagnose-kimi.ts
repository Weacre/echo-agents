import { loadEnvConfig } from "@next/env"
import OpenAI from "openai"
import { kimiEndpointRegion, resolveKimiClient } from "../lib/safety/kimi-server"
import { logSafeError, safeUpstreamRequestId } from "../lib/safety/safe-log"

// Match next dev's precedence: process env > .env.development.local > .env.local > .env.
loadEnvConfig(process.cwd(), true)

async function main() {
  const resolved = resolveKimiClient({})
  if ("error" in resolved) {
    console.error(JSON.stringify({ scope: "diagnose/kimi", code: resolved.code ?? "invalid_configuration" }))
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
  try {
    // Only a synthetic prompt; never read or replay private conversations.
    const { data: stream, response, request_id } = await client.chat.completions.create({
      model: "kimi-k2.5",
      stream: true,
      messages: [{ role: "user", content: "Reply with OK only." }],
    }, { signal: abort.signal }).withResponse()
    phase = "stream"
    for await (const chunk of stream) {
      chunksReceived++
      contentChars += chunk.choices[0]?.delta?.content?.length ?? 0
    }
    const ok = contentChars > 0
    console.log(JSON.stringify({
      scope: "diagnose/kimi", requestId, ok, status: response.status,
      upstreamRequestId: safeUpstreamRequestId(request_id),
      chunksReceived, contentChars, durationMs: Date.now() - started,
    }))
    if (!ok) process.exitCode = 1
  } catch (error) {
    logSafeError("diagnose/kimi", abort.signal.aborted ? new OpenAI.APIConnectionTimeoutError() : error, {
      requestId, phase, model: "kimi-k2.5", keySource: resolved.keySource,
      endpointRegion: kimiEndpointRegion(client.baseURL),
      chunksReceived, contentChars, durationMs: Date.now() - started,
    })
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

void main()
