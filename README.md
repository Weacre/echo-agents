# 小荧（echo-agents）

面向 **AI 影像性暴力** 相关困扰的 Web 应用：同伴式对话（Kimi）、自助资源包、科普与匿名案例示意。技术栈为 **Next.js**（App Router）+ **React** + **TypeScript** + **Tailwind**。

## 文档约定

- 产品说明、研究报告与实现计划等**统一使用 Markdown**（`.md`），便于版本管理与评审。
- 仓库内主要文档示例：`plan.md`、`research.md`、`docs/safety-test-cases.md`（安全验收）、`docs/legal-manual-review-sop.md`（**法律顾问人工抽检 SOP**）；设计稿类说明可在 `docs/` 下维护。
- **对话中的 AI 回复**在界面上按 **Markdown（GFM）** 渲染（列表、加粗、代码块、表格等）；流式生成过程中仍显示为纯文本，完成后切换为渲染结果，避免半段语法闪烁。

## 包管理器：Bun

本项目以 **[Bun](https://bun.sh)** 安装依赖并执行脚本（锁文件为 `bun.lock`）。

```bash
bun install
bun run dev
bun run build
bun run lint
bun run test:safety
bun run test:safety:e2e   # 需另开终端 bun run dev
bun run test:legal-golden # 法律问句 golden 回归；live 需 KIMI_API_KEY
```

### 常用脚本

| 命令 | 说明 |
|------|------|
| `bun run dev` | 本地开发 |
| `bun run build` | 生产构建 |
| `bun run start` | 启动生产服务 |
| `bun run build:cloudflare` | OpenNext → Cloudflare 构建 |
| `bun run preview` / `bun run deploy` | Cloudflare 预览 / 部署（需已配置 Wrangler） |
| `bun run test:safety` | 安全护栏单元回归（见 `docs/safety-test-cases.md`） |
| `bun run test:kimi` | Kimi 诊断与流式接口回归；使用模拟上游，无需密钥 |
| `bun run diagnose:kimi` | 使用本地配置发送一条合成短消息，输出脱敏诊断；会调用真实 Kimi |
| `bun run test:safety:e2e` | 安全护栏 E2E（需先 `bun run dev`） |
| `bun run test:legal-golden` | 法律 Golden 自动回归（人工抽检 SOP：`docs/legal-manual-review-sop.md`） |

## 环境变量

复制 `.env.example` 为 `.env` 并填写：

- `KIMI_API_KEY`：Moonshot Kimi API Key（对话接口需要；也可仅在浏览器弹窗中配置）
- `KIMI_BASE_URL`：可选，默认 `https://api.moonshot.cn/v1`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`：Clerk frontend publishable key
- `CLERK_SECRET_KEY`：Clerk server secret
- `CLERK_WEBHOOK_SIGNING_SECRET`：Clerk `user.deleted` webhook verification secret
- `CONVERSATION_ENCRYPTION_KEY_V1`：32-byte Base64 key，用于对话正文 AES-GCM 加密

Cloudflare D1 使用 `DB` binding。仓库内的 `database_id` 是全零占位符；创建远端数据库并确认数据 location 后，必须替换为真实 ID。创建本地 schema：

```bash
bunx wrangler d1 migrations apply echo-agents-db --local
bun run cf-typegen
```

在 **同伴对话** 与 **嘉宾对话** 页顶栏点击 **齿轮按钮**，可打开 shadcn `Dialog`，将 `KIMI_API_KEY` / `KIMI_BASE_URL` 存入 **localStorage**；调用 `/api/chat` 时会随请求体带上，**优先于**服务端环境变量。点击「清除本地配置」后恢复为仅使用 `.env`。

### Kimi 请求排障

先执行 `bun run diagnose:kimi`。该命令按 Next.js 开发环境的优先级加载配置，不输出密钥或对话正文，失败时以非零状态退出。浏览器配置仅开发环境或显式允许时生效；若诊断命令成功而网页仍失败，请检查日志的 `keySource`，清除浏览器旧配置后重试。

- `status:401` / `errorKind:upstream_auth`：核对密钥是否有效，以及所属平台与地址是否匹配。中国开放平台使用 `https://api.moonshot.cn/v1`，国际平台使用 `https://api.moonshot.ai/v1`；两者密钥独立，见[官方错误说明](https://platform.kimi.com/docs/api/errors)。更新配置后重启开发服务。
- 错误日志为单行 JSON。`requestId` 对应流式响应的 `X-Request-Id` 和 `.local/usage-metrics.jsonl`；`phase` 区分请求拒绝与流中断；`status`、`errorType`、`causeCode`、`endpointRegion`、`keySource` 帮助定位原因。
- HTTP 200 仅表示已建立 SSE，需检查流中是否返回错误替换内容；客户端取消会记录 `cancelled:true`，不再误报为超时。
- 未识别的服务商错误码会降为 `unknown`，不记录任意上游 `message`、响应正文、请求头或密钥。测试计划及复现证据见 [Kimi 请求测试计划](docs/kimi-request-test-plan.md)。

## 主要路由

| 路径 | 说明 |
|------|------|
| `/` | 落地页（知情同意、支持资源） |
| `/support` | 同伴对话 |
| `/support/end` | 结束页与可选匿名分享 |
| `/guests` / `/guests/[id]` | 嘉宾叙事对话（保留） |
| `/learn` / `/stories` | 科普与案例 |
| `/privacy` | 隐私与对话存储说明 |
| `/sign-in` / `/sign-up` | Clerk 登录与注册 |
| `/conversations` | 登录用户的加密对话记录 |

Clerk 登录、注册和应用内账号管理组件统一使用简体中文。匿名聊天不会写入云端；登录用户默认开启加密云端同步，可在聊天页关闭，并可在记录页删除历史。

## 相关链接

- [Next.js 文档](https://nextjs.org/docs)
- [OpenNext Cloudflare](https://opennext.js.org/cloudflare)
