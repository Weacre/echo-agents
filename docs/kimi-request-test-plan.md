# Kimi 请求故障测试计划

## 初始证据（2026-09-13）

- 分支：`fix/kimi-request-diagnostics`，从本地 `main` 创建；起始工作区干净。
- `.local/dev.stderr.log` 有 6 次 `chat/kimi` 失败，只有 `Error / undefined / timeout:false`。
- `.local/usage-metrics.jsonl` 对应耗时 250–410ms，全部 `upstreamError:true`。
- SSE 已返回 HTTP 200，因此访问日志的 200 不能证明生成成功。
- 另有一次 `chat/unhandled` 500；启动提示缺失对话加密配置，需与 Kimi 故障区分。

## 执行顺序

1. 读取配置元数据（不输出密钥），用合成短消息、无自动重试、有限超时复现；核对服务商官方接口规范。
2. 为错误日志追加结构化诊断：状态、错误类别、网络 cause、请求关联 ID、处理阶段与耗时；禁止输出密钥、正文、完整请求/响应或任意上游错误消息。
3. 根据复现结果写失败回归测试，再修复根因；通过可控 fetch 模拟上游验证实际 SDK 请求和 SSE 成败行为。
4. 覆盖鉴权/参数错误、网络失败、超时、中途流错误、成功流、日志脱敏与取消分类，验证同伴及嘉宾请求。
5. 使用相同本地配置复测真实 Kimi，再执行安全、检索、法律离线、持久化回归及类型/代码检查。真实调用仅使用合成测试消息，不发送历史用户日志。
6. 在本文记录结果、证据、剩余环境限制和复跑命令。

## 定位结果

同一份 Next.js 开发环境配置、同一条合成短消息，关闭 SDK 自动重试后：

| 目标 | HTTP 状态 | 服务商错误类型 | 耗时 |
| --- | --- | --- | --- |
| 当前 `.env` 配置的 `api.moonshot.cn/v1` | 401 | `incorrect_api_key_error` | 553ms |
| 官方国际接口 `api.moonshot.ai/v1` | 401 | `invalid_authentication_error` | 420ms |

**当前配置的密钥无法通过两个官方接口的鉴权**。可排除这两次复现中的 DNS 不通、连接超时或尚未到达服务器；仍无法仅凭 401 区分失效、撤销、复制错误或其他平台的密钥。测试国际接口未改写 `.env`，也未增加自动跨平台回退。

[Kimi 官方错误说明](https://platform.kimi.com/docs/api/errors) 将这两个类型归为鉴权失败，并说明中国与国际平台密钥不能混用。

历史日志没有状态或关联 ID，无法逐条证明过去的 6 次失败也是 401；本次使用现存配置稳定复现的症状与快速失败一致。用户尚未确认密钥来源或更新配置，因此**真实对话恢复尚未验收**。

## 已实现的修复

- `safe-log.ts` 原先只记录 `error.name` 和 `code`。OpenAI SDK 的 `AuthenticationError.name` 仍是 `Error`，Moonshot 只返回 `type` 不返回 `code`，所以日志变成 `Error / undefined`。现在保留 SDK 类别、HTTP 状态、白名单错误类型、底层网络原因和可用的上游请求 ID。
- 消除 `message.includes("rate")` 的误判（如 `generate` 被错误归为限流），改按 SDK 错误类型和状态分类。
- 日志输出为带时间戳的单行 JSON，补充本地 `requestId`、模型、平台区域、密钥来源、请求阶段、超时配置、耗时、流片段/内容字符数量。响应 `X-Request-Id` 与使用指标可关联。
- 日志不保存密钥、用户正文、完整 URL、任意上游 message/body/header；未知错误码为 `unknown`。保留通用用户提示，诊断数据留在服务器。
- 服务端密钥去除首尾空白并拒绝空白值；本次原始密钥没有首尾空白，因此这不是此次 401 的根因。
- 区分客户端取消和超时，响应读取取消时终止上游；预先取消的请求不会发送至上游。
- 新增 `bun run diagnose:kimi`：按 Next.js 开发环境配置优先级读取密钥，使用合成短消息，禁用重试，限制耗时，失败以非零状态退出。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| 新增诊断回归测试（修复前） | 5 项失败，复现日志缺字段、分类误判、任意 code 泄漏和密钥空白处理问题 |
| `bun run test:kimi`（修复后） | 19 项通过：5 项诊断测试 + 14 项真实 route/SDK、模拟 fetch 集成测试 |
| `bun run test:safety` | 46 项通过 |
| `bun run test:legal-golden` | 检索及法律离线测试通过，11 项真实法律生成按现有开关跳过 |
| `bun run test:persistence` | 7 项通过 |
| `tsc --noEmit` | 通过 |
| `bun run lint` | 无错误；仅已有 `components/ui/combobox.tsx` 未使用 children 警告 |
| 本次修改文件的 ESLint | 通过，无警告 |
| `git diff --check` | 通过 |
| `bun run diagnose:kimi` | 正确以非零状态退出，日志完整呈现 401 / incorrect_api_key_error / upstream_auth |
| `bun run test:safety:e2e`（localhost 启动并预热后） | 9 项通过，1 项真实生成审核按现有开关跳过 |
| 实际 Next.js `/api/chat` + 真实 Kimi | 同伴、嘉宾均复现 401；响应 X-Request-Id、服务器错误日志和使用指标关联一致，错误替换及 DONE 正常结束 |

集成测试覆盖同伴和有效嘉宾、400/401/403/404/429/500、网络 cause、收到部分内容后上游报错、请求取消、读取取消、预先取消、5 秒超时和 SSE 结束标记。所有集成测试使用假密钥和模拟网络，不接触真实对话、D1 或 Kimi。

## 尚待环境验证

- 需要在本地 `.env` 更新有效 `KIMI_API_KEY` 和匹配的 `KIMI_BASE_URL` 后，执行 `bun run diagnose:kimi` 并验证同伴/嘉宾真实回复。无需在聊天或版本库中提供密钥。
- 网页安全 E2E 的先前超时限制已解除：按原始运行日志使用 `bun run dev --hostname localhost`，等待服务器就绪并请求首页完成首次编译后，`bun run test:safety:e2e` 为 9 项通过、1 项可选真实生成审核跳过。先前绑定 `127.0.0.1` 的两种编译模式均有探活超时，这不足以单独证明主机绑定是根因；无需为此改动产品代码。后续日志见 `.local/kimi-localhost.*.log`，临时测试服务器已停止。
- 启动日志仍提示未配置 `CONVERSATION_ENCRYPTION_KEY_V1`、`CLERK_WEBHOOK_SIGNING_SECRET`。历史单独一条 `chat/unhandled` 500 无充分证据确认原因；保存对话模式需要补齐原有加密配置，不属于 Kimi 鉴权修复。

### 完整 HTTP 链路复验（2026-09-13）

使用未更改的服务端 `.env` 密钥，无客户端覆盖，以合成消息“你好”分别请求同伴和嘉宾 1：

| 模式 | 本地关联 ID | 错误日志 | 指标 | SSE |
| --- | --- | --- | --- | --- |
| companion | `3d400e2c-e390-41ec-bd4a-cbb6e6129e1a` | `401 / incorrect_api_key_error / keySource:server` | `upstreamStatus:401 / upstream_auth` | 错误替换后 DONE |
| guest | `8eb842ec-f996-41cf-b1d2-020569062aae` | `401 / incorrect_api_key_error / keySource:server` | `upstreamStatus:401 / upstream_auth` | 错误替换后 DONE |

这证明诊断字段在真实 Next.js 编译及 HTTP/SSE 环境中可用；当前鉴权故障不是仅在独立诊断脚本中出现。配置文件修改时间仍为 2026-09-08，没有收到有效密钥更新，成功生成验收继续等待该外部输入。
