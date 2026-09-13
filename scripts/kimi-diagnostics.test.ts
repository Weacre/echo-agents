import assert from "node:assert/strict"
import { describe, it } from "node:test"
import OpenAI from "openai"
import { logSafeError, sanitizeErrorMessage } from "../lib/safety/safe-log"
import { resolveKimiClient } from "../lib/safety/kimi-server"

function capture(error: unknown) {
  const previous = console.error
  const output: unknown[][] = []
  console.error = (...args: unknown[]) => { output.push(args) }
  try { logSafeError("chat/kimi", error, { requestId: "local-request-1" }) }
  finally { console.error = previous }
  const value = output[0][output[0].length - 1]
  return typeof value === "string" ? JSON.parse(value) : value
}

describe("Kimi diagnostics", () => {
  it("retains HTTP 401 and Moonshot type when SDK code is absent", () => {
    const error = new OpenAI.AuthenticationError(401, {
      type: "incorrect_api_key_error", message: "Incorrect API key provided",
    }, undefined, new Headers({ "x-request-id": "upstream-request-1" }))
    assert.equal(error.name, "Error") // SDK subclasses inherit this generic name.
    const log = capture(error)
    assert.equal(log.errorName, "AuthenticationError")
    assert.equal(log.errorCode, "unknown")
    assert.equal(log.errorType, "incorrect_api_key_error")
    assert.equal(log.status, 401)
    assert.equal(log.upstreamRequestId, "upstream-request-1")
    assert.equal(log.errorKind, "upstream_auth")
    assert.equal(log.requestId, "local-request-1")
  })

  it("does not classify arbitrary words in provider messages as rate limiting", () => {
    assert.equal(sanitizeErrorMessage(new Error("Unable to generate response")), "upstream_error")
    assert.equal(sanitizeErrorMessage(new OpenAI.BadRequestError(400, {}, undefined, new Headers())), "upstream_bad_request")
    assert.equal(sanitizeErrorMessage(new OpenAI.RateLimitError(429, {}, undefined, new Headers())), "upstream_rate_limited")
    assert.equal(sanitizeErrorMessage(new OpenAI.APIConnectionTimeoutError()), "upstream_timeout")
    assert.equal(sanitizeErrorMessage(new OpenAI.APIUserAbortError()), "upstream_cancelled")
  })

  it("records a nested network cause without its message", () => {
    const error = new OpenAI.APIConnectionError({ cause: new TypeError("fetch failed", {
      cause: Object.assign(new Error("private network details"), { code: "ENOTFOUND" }),
    }) })
    const log = capture(error)
    assert.equal(log.causeCode, "ENOTFOUND")
    assert.equal(log.errorKind, "upstream_connection")
    assert.ok(!JSON.stringify(log).includes("private network details"))
  })

  it("never logs provider messages, bodies, credentials, or arbitrary code/type fields", () => {
    const secret = "sk-private-secret"
    const error = new OpenAI.BadRequestError(400, {
      code: secret, type: "private user content", param: secret,
      message: `Authorization: Bearer ${secret}; private user content`,
    }, undefined, new Headers({ "x-request-id": secret, authorization: secret }))
    const output = JSON.stringify(capture(error))
    for (const forbidden of [secret, "private user content", "Authorization", "headers", "message", "param"]) {
      assert.ok(!output.includes(forbidden), forbidden)
    }
  })

  it("trims the server key and rejects whitespace-only configuration", () => {
    const previous = process.env.KIMI_API_KEY
    try {
      process.env.KIMI_API_KEY = "  sk-synthetic  "
      const resolved = resolveKimiClient({})
      assert.ok("client" in resolved)
      if ("client" in resolved) assert.equal(resolved.client.apiKey, "sk-synthetic")
      process.env.KIMI_API_KEY = "   "
      const empty = resolveKimiClient({})
      assert.ok("error" in empty)
      if ("error" in empty) assert.equal(empty.code, "missing_api_key")
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "KIMI_API_KEY")
      else process.env.KIMI_API_KEY = previous
    }
  })
})
