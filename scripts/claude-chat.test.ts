import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { NextRequest } from "next/server"
import { POST } from "../app/api/chat/route"
import { UPSTREAM_ERROR_MESSAGE, UPSTREAM_TIMEOUT_MESSAGE } from "../lib/safety/constants"

const event = (data: { type: string; [key: string]: unknown }) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`
const textEvent = (text: string) => event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
const answer = "你好，我在这里陪你。"
type Transport = (...args: Parameters<typeof fetch>) => Promise<Response>

// Real route and SDK, isolated transport: this suite never contacts Anthropic or D1.
async function run(
  transport: Transport,
  options: { mode?: "companion" | "guest"; signal?: AbortSignal; timeout?: boolean; cancelBody?: boolean } = {},
) {
  const previousFetch = globalThis.fetch
  const previousLog = console.error
  const env = { ...process.env }
  const logs: Record<string, unknown>[] = []
  let calls = 0
  process.env.ANTHROPIC_API_KEY = "sk-synthetic-test-only"
  process.env.ANTHROPIC_BASE_URL = "https://claude.test"
  process.env.ANTHROPIC_MODEL = "claude-sonnet-4-6"
  process.env.DISABLE_USAGE_METRICS = "1"
  process.env.CHAT_RATE_LIMIT_PER_MIN = "1000"
  if (options.timeout) process.env.ANTHROPIC_TIMEOUT_MS = "5000"
  console.error = (...args: unknown[]) => { logs.push(JSON.parse(String(args[0]))) }
  globalThis.fetch = (async (input, init) => {
    calls++
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, "claude-sonnet-4-6")
    assert.equal(body.stream, true)
    assert.equal(String(input), "https://claude.test/v1/messages")
    assert.ok(typeof body.system === "string" && body.system.length > 0)
    assert.equal(body.messages[0].role, "user")
    assert.equal(body.max_tokens, 2048)
    assert.equal(body.messages.at(-1).content, "<user_message>\n你好\n</user_message>")
    assert.equal(new Headers(init?.headers).get("x-api-key"), "sk-synthetic-test-only")
    assert.equal(new Headers(init?.headers).get("anthropic-version"), "2023-06-01")
    return transport(input, init)
  }) as typeof fetch
  try {
    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      signal: options.signal,
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.20" },
      body: JSON.stringify({ mode: options.mode ?? "companion", guestId: "1", messages: [{ role: "user", content: "你好" }] }),
    })
    const response = await POST(req)
    if (options.cancelBody) {
      await response.body!.cancel()
      // Let the rejected upstream operation reach the route's catch/finally.
      await new Promise(resolve => setTimeout(resolve, 0))
      return { response, text: "", logs, calls }
    }
    const text = await response.text()
    return { response, text, logs, calls }
  } finally {
    globalThis.fetch = previousFetch
    console.error = previousLog
    for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name]
    Object.assign(process.env, env)
  }
}

describe("Claude route and SDK integration", () => {
  for (const mode of ["companion", "guest"] as const) {
    it(`streams a complete ${mode} response`, async () => {
      const result = await run(async () => new Response(
        textEvent(answer) + event({ type: "message_stop" }),
        { headers: { "content-type": "text/event-stream", "request-id": "mock-success" } },
      ), { mode })
      assert.equal(result.response.status, 200)
      assert.match(result.text, /data: \[DONE\]/)
      assert.ok(result.text.includes(answer))
      assert.equal(result.logs.length, 0)
      assert.equal(result.calls, 1)
      assert.ok(result.response.headers.get("x-request-id"))
    })
  }

  for (const status of [400, 401, 403, 404, 429, 500]) {
    it(`handles HTTP ${status} with correlated, private diagnostics`, async () => {
      const result = await run(async () => Response.json({ error: {
        type: status === 401 ? "authentication_error" : "invalid_request_error",
        message: "private prompt sk-do-not-log",
      } }, { status, headers: { "request-id": "mock-failure", "x-should-retry": "false" } }))
      const log = result.logs.find(log => log.scope === "chat/claude")!
      assert.equal(log.status, status)
      assert.equal(log.requestId, result.response.headers.get("x-request-id"))
      assert.equal(log.upstreamRequestId, "mock-failure")
      assert.equal(log.phase, "request")
      assert.equal(log.keySource, "server")
      assert.equal(log.timeout, false)
      assert.equal(result.calls, 1)
      assert.ok(result.text.includes(UPSTREAM_ERROR_MESSAGE))
      assert.match(result.text, /data: \[DONE\]/)
      assert.ok(!JSON.stringify(result.logs).includes("private prompt"))
      assert.ok(!JSON.stringify(result.logs).includes("sk-do-not-log"))
      assert.ok(!result.text.includes("authentication_error"))
    })
  }

  it("records transport failure cause", async () => {
    const result = await run(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("private"), { code: "ECONNREFUSED" }) })
    })
    assert.equal(result.logs[0].causeCode, "ECONNREFUSED")
    assert.equal(result.logs[0].errorKind, "upstream_connection")
  })

  it("distinguishes an in-stream error from a rejected request", async () => {
    const result = await run(async () => new Response(
      textEvent("partial") + event({ type: "error", error: { type: "overloaded_error", message: "private" } }),
      { headers: { "content-type": "text/event-stream", "request-id": "mock-stream" } },
    ))
    assert.equal(result.logs[0].phase, "stream")
    assert.equal(result.logs[0].chunksReceived, 1)
    assert.equal(result.logs[0].contentChars, 7)
    assert.equal(result.logs[0].upstreamStatus, 200)
    assert.equal(result.logs[0].upstreamRequestId, "mock-stream")
    assert.equal(result.logs[0].errorType, "overloaded_error")
    assert.equal(result.logs[0].errorKind, "upstream_server_error")
    assert.ok(result.text.includes('"type":"content_replace"'))
  })

  it("rejects a truncated stream instead of treating partial content as success", async () => {
    const result = await run(async () => new Response(textEvent("partial"), {
      headers: { "content-type": "text/event-stream" },
    }))
    assert.equal(result.logs[0].errorKind, "upstream_incomplete")
    assert.ok(result.text.includes(UPSTREAM_ERROR_MESSAGE))
  })

  it("does not expose hidden thinking or malformed upstream payloads", async () => {
    const result = await run(async () => new Response(
      event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private thinking" } }) +
      textEvent(answer) + event({ type: "message_stop" }),
      { headers: { "content-type": "text/event-stream" } },
    ))
    assert.ok(result.text.includes(answer))
    assert.ok(!result.text.includes("private thinking"))
    const malformed = await run(async () => new Response("event: content_block_delta\ndata: sk-private-payload\n\n", {
      headers: { "content-type": "text/event-stream" },
    }))
    assert.ok(!JSON.stringify(malformed.logs).includes("sk-private-payload"))
    assert.ok(malformed.text.includes(UPSTREAM_ERROR_MESSAGE))
  })

  const waitingFetch: Transport = async (_input, init) => new Promise((_resolve, reject) => {
    const fail = () => reject(new DOMException("Aborted", "AbortError"))
    if (init?.signal?.aborted) fail()
    else init?.signal?.addEventListener("abort", fail, { once: true })
  })

  it("marks user cancellation separately from timeout", async () => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 30)
    try {
      const result = await run(waitingFetch, { signal: abort.signal })
      assert.equal(result.logs[0].errorKind, "upstream_cancelled")
      assert.equal(result.logs[0].cancelled, true)
      assert.equal(result.logs[0].timeout, false)
      assert.ok(!result.text.includes(UPSTREAM_TIMEOUT_MESSAGE))
    } finally { clearTimeout(timer) }
  })

  it("applies the configured deadline and closes the SSE response", async () => {
    const result = await run(waitingFetch, { timeout: true })
    assert.equal(result.logs[0].errorKind, "upstream_timeout")
    assert.equal(result.logs[0].timeout, true)
    assert.ok(result.text.includes(UPSTREAM_TIMEOUT_MESSAGE))
    assert.match(result.text, /data: \[DONE\]/)
  })

  it("cancels the upstream operation when the response reader closes", async () => {
    const result = await run(waitingFetch, { cancelBody: true })
    assert.equal(result.logs[0].cancelled, true)
    assert.equal(result.logs[0].timeout, false)
    assert.equal(result.logs[0].errorKind, "upstream_cancelled")
  })

  it("does not send an already cancelled request to the provider", async () => {
    const abort = new AbortController()
    abort.abort()
    const result = await run(waitingFetch, { signal: abort.signal })
    assert.equal(result.calls, 0)
    assert.equal(result.logs[0].errorKind, "upstream_cancelled")
  })
})
