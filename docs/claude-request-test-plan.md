# Claude 接入与故障验收

## 目标与决策

原任务在 `fix/kimi-request-diagnostics` 分支定位到 Kimi 401 鉴权失败，见 [原始测试记录](kimi-request-test-plan.md)。用户更新配置后，地址变成 `https://api.anthropic.com/v1/messages`；旧代码仍向该地址追加 `/chat/completions` 并请求 `kimi-k2.5`，复现 404。

2026-09-13 用户明确要求“改接 claude，如果地址有误替我修改就好”。本次采用 [Anthropic 原生 TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)及 [Messages 流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)，无需 OpenAI 兼容层。

## 变更

- 本地 `.env` 密钥变量迁移为 `ANTHROPIC_API_KEY`，基础地址修正为 `https://api.anthropic.com`。密钥未输出、未进入版本库。
- 默认模型 `claude-sonnet-4-6`；已通过该账户的模型列表确认可访问，也可设置 `ANTHROPIC_MODEL`。每条回复最多 2048 输出 token，总超时默认 60 秒，可用 `ANTHROPIC_TIMEOUT_MS` 调整。
- 原生请求使用顶层 `system`、`messages`、`max_tokens`，通过 `content_block_delta/text_delta` 输出正文，必须收到 `message_stop` 才作为完整生成。保留前端原有 SSE、审核、危机短路与保存接口。
- 只向用户发送正文，不发送 thinking 内容。空流、缺少结束事件、流中错误均进入失败路径；取消与超时区分。
- 保留本地请求 ID、上游 request-id、HTTP 状态、SDK 错误类型、网络 cause、阶段与耗时。关闭 SDK 自带的原始日志，以免解析损坏的流时输出正文；统一使用脱敏日志。
- 开发配置弹窗、请求字段、浏览器存储改为 Claude；生产默认禁止客户端密钥。旧 Kimi 浏览器配置不会被读取或发送。
- 非法基础地址在请求前被拒绝，涵盖误填 `/v1/messages`、`/v1`、完整 Chat Completions URL、带凭据或查询参数的 URL。
- Cloudflare secret 声明及生成类型改为 `ANTHROPIC_API_KEY`。本次没有部署或修改远端 secret；部署时需另行配置。

## 验收计划与结果

| 检查 | 证据/结果 |
| --- | --- |
| 新密钥鉴权与模型存在性 | 官方 Models API 成功，包含 `claude-sonnet-4-6` |
| 独立真实流 | `bun run diagnose:claude` 返回 200，6 个事件、2 个正文字符，正常结束 |
| 同伴及嘉宾真实多轮 | 各两轮共 4 条，全部 HTTP 200、非空正文、DONE，无错误替换；见下表 |
| `bun run test:claude` | 22 项通过（6 诊断 + 16 route/SDK 集成） |
| `bun run test:safety` | 48 项通过 |
| `bun run test:persistence` | 7 项通过 |
| `bun run test:legal-golden` | 检索与法律离线断言通过，真实调用默认不启用 |
| 真实法律问句 | 首轮 10/11 通过；余下一项为“六个月”未匹配仅接受“6个月”的断言，修正等价数字写法后定向重测通过 |
| 真实安全 E2E | 新启动服务的 9 项接口用例通过；真实生成的否定/反驳“100%胜诉”曾被旧测试误判，补充正反例并修正测试断言后，真实生成用例定向重测通过（无跳过） |
| 类型/代码检查 | TypeScript 通过；ESLint 无错误，仅已有 combobox 未使用 children 警告 |
| 生产构建 | `bun run build` 通过，18 个静态页面及 API 路由编译完成 |

模拟集成测试检查实际请求 URL `/v1/messages`、`x-api-key`、版本头、独立 system、模型与输出上限；覆盖 400/401/403/404/429/500、网络失败、服务端流错误、缺少结束事件、隐藏思考、损坏 JSON 的日志脱敏、超时、取消和预先取消。

法律断言修改只接受等价数字写法，新增断言仍拒绝“五个月”；安全 E2E 测试断言新增否定、反驳引述、肯定承诺与先否定后承诺的正反例。产品审核规则和法律提示词未因此放宽。这些自动化测试不是法律内容的专业审查。

## 真实 HTTP 证据

合成输入为简单问候与请求鼓励；不发送历史用户日志，不保存对话正文。完整测试元数据在 `.local/claude-http-evidence.json`。

| 模式 | 轮次 | 本地请求 ID | 正文字符数 | 耗时 |
| --- | --- | --- | --- | --- |
| companion | 1 | `d766ef46-fb32-4a21-bb23-53dbf1a55763` | 108 | 5089ms |
| companion | 2 | `41407a66-5671-4c9f-8471-5cf8d6d53b79` | 13 | 1356ms |
| guest | 1 | `7f39d46b-6164-4572-befc-b659a282a7c1` | 139 | 4467ms |
| guest | 2 | `c2e720ec-7f1a-4a46-ba36-ee03952eff25` | 34 | 1985ms |

## 复跑与边界

1. `bun run dev --hostname localhost`，等待就绪及首页首次编译完成。
2. `bun run diagnose:claude`、`bun run test:claude`、`bun run test:safety:e2e`。
3. 如显式运行真实审核测试，在 PowerShell 设置 `$env:E2E_LIVE_LLM='1'`，执行 `node --env-file=.env --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/safety-guardrails.e2e.test.ts`。法律真实测试使用 `LEGAL_GOLDEN_LIVE=1` 和对应脚本。这里的 env-file 仅让测试进程确认本地配置存在，密钥不打印。
4. 重复 E2E 前使用新启动的测试服务，避免同一进程的故事提交限流（5 次/小时）导致无效测试；本次重复测试曾触发 429，未修改产品限流配置。

原有 `CONVERSATION_ENCRYPTION_KEY_V1` 与 `CLERK_WEBHOOK_SIGNING_SECRET` 未在本地配置。真实 HTTP 验收使用 ephemeral 模式；加密存储有独立 7 项回归，登录保存及 webhook 尚不属于本次真实 LLM 连通性验收。上线前仍需配置这些原有服务。

## 最终结论

当前分支已按用户选择改接 Claude，旧配置导致的 401/404 已消除：独立真实调用、两种聊天模式各两轮均收到正常完整回复，使用指标对应 `upstreamError:false`。故障诊断、地址检查、流式解析、浏览器配置及回归测试已同步。临时开发服务已停止；日常启动使用 `bun run dev --hostname localhost`。本次没有推送、部署或更换对话加密密钥。
