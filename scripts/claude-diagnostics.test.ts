import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Anthropic from "@anthropic-ai/sdk"
import { logSafeError, sanitizeErrorMessage } from "../lib/safety/safe-log"
import { resolveClaudeClient } from "../lib/safety/claude-server"

function capture(error: unknown) {
  const previous = console.error
  const output: unknown[][] = []
  console.error = (...args: unknown[]) => { output.push(args) }
  try { logSafeError("chat/claude", error, { requestId: "local-request-1" }) }
  finally { console.error = previous }
  const value = output[0][output[0].length - 1]
  return typeof value === "string" ? JSON.parse(value) : value
}

describe("Claude diagnostics", () => {
  it("retains HTTP 401 and Anthropic type when SDK code is absent", () => {
    const error = Anthropic.APIError.generate(401, { error: {
      type: "authentication_error", message: "Invalid API key",
    } }, undefined, new Headers({ "request-id": "upstream-request-1" }))
    assert.equal(error.name, "Error") // SDK subclasses inherit this generic name.
    const log = capture(error)
    assert.equal(log.errorName, "AuthenticationError")
    assert.equal(log.errorCode, "unknown")
    assert.equal(log.errorType, "authentication_error")
    assert.equal(log.status, 401)
    assert.equal(log.upstreamRequestId, "upstream-request-1")
    assert.equal(log.errorKind, "upstream_auth")
    assert.equal(log.requestId, "local-request-1")
  })

  it("does not classify arbitrary words in provider messages as rate limiting", () => {
    assert.equal(sanitizeErrorMessage(new Error("Unable to generate response")), "upstream_error")
    assert.equal(sanitizeErrorMessage(new Anthropic.BadRequestError(400, {}, undefined, new Headers())), "upstream_bad_request")
    assert.equal(sanitizeErrorMessage(new Anthropic.RateLimitError(429, {}, undefined, new Headers())), "upstream_rate_limited")
    assert.equal(sanitizeErrorMessage(new Anthropic.APIConnectionTimeoutError()), "upstream_timeout")
    assert.equal(sanitizeErrorMessage(new Anthropic.APIUserAbortError()), "upstream_cancelled")
  })

  it("records a nested network cause without its message", () => {
    const error = new Anthropic.APIConnectionError({ cause: new TypeError("fetch failed", {
      cause: Object.assign(new Error("private network details"), { code: "ENOTFOUND" }),
    }) })
    const log = capture(error)
    assert.equal(log.causeCode, "ENOTFOUND")
    assert.equal(log.errorKind, "upstream_connection")
    assert.ok(!JSON.stringify(log).includes("private network details"))
  })

  it("never logs provider messages, bodies, credentials, or arbitrary code/type fields", () => {
    const secret = "sk-private-secret"
    const error = new Anthropic.BadRequestError(400, {
      code: secret, type: "private user content", param: secret,
      message: `Authorization: Bearer ${secret}; private user content`,
    }, undefined, new Headers({ "request-id": secret, authorization: secret }))
    const output = JSON.stringify(capture(error))
    for (const forbidden of [secret, "private user content", "Authorization", "headers", "message", "param"]) {
      assert.ok(!output.includes(forbidden), forbidden)
    }
  })

  it("trims the server key and rejects whitespace-only configuration", () => {
    const previous = process.env.ANTHROPIC_API_KEY
    const previousUrl = process.env.ANTHROPIC_BASE_URL
    try {
      process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com"
      process.env.ANTHROPIC_API_KEY = "  sk-synthetic  "
      const resolved = resolveClaudeClient({})
      assert.ok("client" in resolved)
      if ("client" in resolved) assert.equal(resolved.client.apiKey, "sk-synthetic")
      process.env.ANTHROPIC_API_KEY = "   "
      const empty = resolveClaudeClient({})
      assert.ok("error" in empty)
      if ("error" in empty) assert.equal(empty.code, "missing_api_key")
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY")
      else process.env.ANTHROPIC_API_KEY = previous
      if (previousUrl === undefined) Reflect.deleteProperty(process.env, "ANTHROPIC_BASE_URL")
      else process.env.ANTHROPIC_BASE_URL = previousUrl
    }
  })

  it("rejects full operation URLs before constructing an upstream client", () => {
    const previous = { ...process.env }
    try {
      process.env.ANTHROPIC_API_KEY = "sk-synthetic"
      process.env.ALLOW_CLIENT_ANTHROPIC_KEY = "1"
      for (const url of ["https://api.anthropic.com/v1/messages", "https://api.anthropic.com/chat/completions/"]) {
        process.env.ANTHROPIC_BASE_URL = url
        const roots: Record<string, string>[] = [{}, { claudeBaseUrl: url }]
        for (const root of roots) {
          const resolved = resolveClaudeClient(root)
          assert.ok("error" in resolved)
          if ("error" in resolved) assert.equal(resolved.code, "invalid_base_url")
        }
      }
    } finally {
      for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ALLOW_CLIENT_ANTHROPIC_KEY"]) {
        if (previous[name] === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = previous[name]
      }
    }
  })
})
