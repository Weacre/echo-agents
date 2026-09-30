"use client"

import Link from "next/link"
import Image from "next/image"
import { DESIGN_ASSETS } from "@/lib/design-assets"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  LockKeyholeIcon,
  BookOpenIcon,
  SendIcon,
  SquareIcon,
} from "lucide-react"

import { CompanionLayout } from "@/components/companion-layout"
import { AuthControls } from "@/components/auth-controls"
import { ConversationSaveControl } from "@/components/conversation-save-control"
import { QuickReplies } from "@/components/quick-replies"
import { SelfHelpSidebar } from "@/components/self-help-sidebar"
import { AgentMarkdown } from "@/components/agent-markdown"
import {
  ClaudeConfigTrigger,
  useClaudeConfig,
} from "@/components/claude-config-provider"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { COMPANION_AGENT_LABEL, COMPANION_OPENING } from "@/lib/companion-agent"
import { COMPANION_QUICK_REPLIES } from "@/data/quick-replies"
import { SELF_HELP_CATALOG } from "@/data/self-help-catalog"
import {
  catalogEntryToPanelItem,
  deriveSelfHelpFromConversation,
  mergeSelfHelpDeduped,
  type SelfHelpPanelItem,
} from "@/lib/derive-self-help"
import { parseFetchErrorBody } from "@/lib/json-parse"
import { sseItemsToPanelItems } from "@/lib/sse-self-help"
import { applySseParseResult, parseSseDataLine } from "@/lib/sse-chat"
import { cn } from "@/lib/utils"
import {
  MAX_CHAT_INPUT_CHARS,
  toChatApiMessages,
} from "@/lib/chat-context"
import { useConversationPersistence } from "@/hooks/use-conversation-persistence"
import styles from "@/components/companion-refresh.module.css"

const DEFAULT_SELF_HELP_ITEMS = [
  "guide-nonconsensual",
  "guide-deepfake",
  "evidence-guide",
  "takedown-letter",
].flatMap((id) => {
  const entry = SELF_HELP_CATALOG.find((item) => item.id === id)
  return entry ? [catalogEntryToPanelItem(entry)] : []
})

type MessageRole = "agent" | "user"
type ConversationMessage = {
  id: string
  role: MessageRole
  content: string
  isFallback?: boolean
}

function conversationUserText(messages: ConversationMessage[]): string {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n")
}

function persistStoryDraft(messages: ConversationMessage[]) {
  const draft = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n\n")
  sessionStorage.setItem("companion-story-draft", draft)
}

export function CompanionConversationPage({
  initialConversationId,
}: {
  initialConversationId?: string
}) {
  const { allowClientClaudeKey, claudeRequestFields } = useClaudeConfig()
  const persistence = useConversationPersistence({
    mode: "companion",
  })
  const { isSignedIn, resumeConversation } = persistence
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<ConversationMessage[]>([
    { id: "opening", role: "agent", content: COMPANION_OPENING },
  ])
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const [selfHelpItems, setSelfHelpItems] = useState<SelfHelpPanelItem[]>([])
  const [isSending, setIsSending] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const hasConversation = messages.length > 1 || isSending

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "auto" })
  }, [messages, streamingContent])

  useEffect(() => {
    if (!initialConversationId || !isSignedIn) return
    let cancelled = false
    void fetch(`/api/conversations/${initialConversationId}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取这段对话")
        return (await response.json()) as {
          conversation: { mode: string }
          turns: Array<{
            id: string
            userContent: string
            assistantContent: string | null
            status: "pending" | "completed" | "stopped" | "failed"
          }>
        }
      })
      .then((body) => {
        if (cancelled || body.conversation.mode !== "companion") return
        resumeConversation(initialConversationId)
        const restored: ConversationMessage[] = [
          { id: "opening", role: "agent", content: COMPANION_OPENING },
        ]
        for (const turn of body.turns) {
          restored.push({
            id: `${turn.id}-user`,
            role: "user",
            content: turn.userContent,
          })
          if (turn.status === "completed" && turn.assistantContent) {
            restored.push({
              id: `${turn.id}-agent`,
              role: "agent",
              content: turn.assistantContent,
            })
          } else if (turn.status !== "pending") {
            restored.push({
              id: `${turn.id}-status`,
              role: "agent",
              content: "这次回复没有完整保存，你可以重新发送上一条消息。",
              isFallback: true,
            })
          }
        }
        setMessages(restored)
        setSelfHelpItems(deriveSelfHelpFromConversation(conversationUserText(restored)))
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "读取对话失败")
        }
      })
    return () => {
      cancelled = true
    }
  }, [initialConversationId, isSignedIn, resumeConversation])

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = rawText.trim()
      if (!text || isSending) return
      setError(null)
      const userMsg: ConversationMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: text,
      }
      const nextMessages = [...messages, userMsg]
      setMessages(nextMessages)
      setIsSending(true)
      setStreamingContent("")

      const derived = deriveSelfHelpFromConversation(
        conversationUserText(nextMessages),
      )
      setSelfHelpItems((prev) => mergeSelfHelpDeduped(prev, derived))

      abortRef.current = new AbortController()
      const signal = abortRef.current.signal
      let fullContent = ""

      try {
        const savedBody = await persistence.savedRequest(text)
        const requestBody = savedBody ?? {
          persistence: "ephemeral",
          mode: "companion",
          messages: toChatApiMessages(nextMessages),
        }
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...requestBody, ...claudeRequestFields }),
          signal,
        })

        if (!res.ok) {
          const errText = await res.text()
          const parsedErr = parseFetchErrorBody(errText)
          throw new Error(parsedErr ?? `请求失败 ${res.status}`)
        }

        const reader = res.body?.getReader()
        const decoder = new TextDecoder()
        if (!reader) throw new Error("No response body")

        let buffer = ""
        let sawDone = false

        outer: while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            const parsed = parseSseDataLine(line)
            if (parsed.kind === "done") {
              sawDone = true
              break outer
            }
            if (parsed.kind === "content" || parsed.kind === "content_replace") {
              fullContent = applySseParseResult(parsed, fullContent)
              setStreamingContent(fullContent)
            }
            if (parsed.kind === "self_help") {
              const panel = sseItemsToPanelItems(parsed.items)
              setSelfHelpItems((prev) => mergeSelfHelpDeduped(prev, panel))
            }
            if (parsed.kind === "persistence_error") {
              setError("回复已生成，但未能写入云端记录。请先复制内容后重试。")
            }
          }
        }

        if (!sawDone) {
          const tail = parseSseDataLine(buffer)
          if (tail.kind === "content" || tail.kind === "content_replace") {
            fullContent = applySseParseResult(tail, fullContent)
          }
          if (tail.kind === "self_help") {
            const panel = sseItemsToPanelItems(tail.items)
            setSelfHelpItems((prev) => mergeSelfHelpDeduped(prev, panel))
          }
        }

        setStreamingContent("")
        setMessages((prev) => [
          ...prev,
          {
            id: `agent-${Date.now()}`,
            role: "agent",
            content: fullContent || "（没有收到回复，请重试。）",
          },
        ])
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          setStreamingContent("")
          setMessages((prev) => [
            ...prev,
            {
              id: `agent-${Date.now()}`,
              role: "agent",
              content: fullContent.trim()
                ? `${fullContent.trim()}\n\n（已停止生成）`
                : "已停下。你可以换个方式继续，或者先休息一下。",
              isFallback: !fullContent.trim(),
            },
          ])
          return
        }
        setError(e instanceof Error ? e.message : "发送失败，请重试")
        setMessages((prev) => [
          ...prev,
          {
            id: `agent-${Date.now()}`,
            role: "agent",
            content: "抱歉，暂时无法回复。请检查网络或稍后再试。",
            isFallback: true,
          },
        ])
      } finally {
        setIsSending(false)
        abortRef.current = null
      }
    },
    [isSending, messages, claudeRequestFields, persistence],
  )

  const handleSend = useCallback(() => {
    const t = input.trim()
    if (!t || isSending) return
    setInput("")
    void sendMessage(t)
  }, [input, isSending, sendMessage])

  const handleQuickPick = useCallback(
    (text: string) => {
      void sendMessage(text)
    },
    [sendMessage],
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      e.nativeEvent.keyCode !== 229
    ) {
      e.preventDefault()
      handleSend()
    }
  }

  const sidebar = (
    <SelfHelpSidebar items={mergeSelfHelpDeduped(selfHelpItems, DEFAULT_SELF_HELP_ITEMS)} />
  )

  const chatColumn = (
    <div className={styles.chatColumn}>
      <header className={styles.chatHeader}>
        <div className={styles.brandRow}>
          <Link href="/" className={styles.brand} aria-label="如荧，返回首页">
            <span className={styles.brandTitle}>如荧 <span>· 反对影像性暴力</span></span>
            <span className={styles.brandSubtitle}>{COMPANION_AGENT_LABEL}小荧</span>
          </Link>
          <Button variant="ghost" size="icon" className={styles.backButton} asChild>
            <Link href="/" aria-label="返回首页">
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
        </div>
        <div className={styles.toolbar} aria-label="对话管理">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="lg:hidden" type="button">
                <BookOpenIcon className="size-4" />
                自助包
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full border-0 p-0 sm:max-w-md">
              <SheetHeader className="sr-only">
                <SheetTitle>智能自助包</SheetTitle>
                <SheetDescription>阅读或保存相关指南，也可以查看真人支持资源。</SheetDescription>
              </SheetHeader>
              {sidebar}
            </SheetContent>
          </Sheet>
          <ConversationSaveControl
            isSignedIn={persistence.isSignedIn}
            historyEnabled={persistence.historyEnabled}
            isLoading={persistence.isLoading}
            onEnable={persistence.enableHistory}
            onDisable={persistence.disableHistory}
          />
          {allowClientClaudeKey && <ClaudeConfigTrigger />}
          <AuthControls compact />
          <Button variant="ghost" size="sm" asChild>
            <Link
              href="/support/end"
              onClick={() => persistStoryDraft(messagesRef.current)}
            >
              结束对话
            </Link>
          </Button>
        </div>
      </header>

      {error && (
        <div
          className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}

      <div className={styles.conversationScroll}>
        <main
          className={cn(styles.conversationMain, !hasConversation && styles.initialMain)}
          aria-live="polite"
          aria-relevant="additions"
          aria-label="与小荧的对话"
        >
          {!hasConversation ? (
            <section className={styles.welcome} aria-labelledby="welcome-heading">
              <Image
                src={DESIGN_ASSETS.companion}
                alt="同伴支持者小荧"
                width={220}
                height={220}
                priority
                className={styles.welcomeAvatar}
              />
              <h1 id="welcome-heading">你不用独自面对黑夜，我会陪你走过</h1>
              <p>{COMPANION_OPENING}</p>
            </section>
          ) : (
            <div className={styles.messages}>
              {messages.map((msg) =>
                msg.role === "agent" ? (
                  <AgentBubble key={msg.id} content={msg.content} isFallback={msg.isFallback} />
                ) : (
                  <UserBubble key={msg.id} content={msg.content} />
                ),
              )}
              {isSending && (
                <AgentBubble
                  content={streamingContent || "正在整理回应…"}
                  streaming
                  className={cn(streamingContent && "opacity-90")}
                />
              )}
            </div>
          )}
          <div ref={scrollRef} />
        </main>
      </div>

      <div className={styles.composerArea}>
        {!hasConversation && (
          <section className={styles.quickStart} aria-label="选择一个常见问题开始">
            <QuickReplies replies={COMPANION_QUICK_REPLIES} onPick={handleQuickPick} disabled={isSending} />
          </section>
        )}
        <div className={styles.composer}>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="你可以从任何地方开始说起…"
            className={styles.messageInput}
            rows={1}
            disabled={isSending}
            maxLength={MAX_CHAT_INPUT_CHARS}
            aria-label="输入消息"
          />
          {isSending ? (
            <Button
              type="button"
              className={styles.sendButton}
              onClick={() => abortRef.current?.abort()}
              aria-label="停止生成"
              title="停止生成"
            >
              <SquareIcon className="size-4 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              className={styles.sendButton}
              onClick={handleSend}
              disabled={!input.trim()}
              aria-label="发送消息"
              title="发送消息"
            >
              <SendIcon className="size-5" />
            </Button>
          )}
        </div>
        <div className={styles.privacyNote}>
          <span className={styles.privacyStatus}>
            <LockKeyholeIcon className="size-3 shrink-0" aria-hidden="true" />
            {persistence.historyEnabled
              ? "对话已加密同步，可随时在记录页删除"
              : persistence.isSignedIn
                ? "云端同步已关闭，本次对话仅临时保留"
                : "未登录，对话仅临时保留"}
            <Link href="/privacy">隐私说明</Link>
          </span>
          {input.length >= MAX_CHAT_INPUT_CHARS * 0.8 ? (
            <span>{input.length}/{MAX_CHAT_INPUT_CHARS}</span>
          ) : (
            <span className={styles.keyboardHint}>Enter 发送 · Shift + Enter 换行</span>
          )}
        </div>
      </div>
    </div>
  )

  return <CompanionLayout sidebar={sidebar}>{chatColumn}</CompanionLayout>
}

function AgentBubble({
  content,
  isFallback,
  streaming,
  className,
}: {
  content: string
  isFallback?: boolean
  streaming?: boolean
  className?: string
}) {
  return (
    <div className={cn(styles.agentRow, className)}>
      <Image
        src={DESIGN_ASSETS.companion}
        alt=""
        width={40}
        height={40}
        className={styles.agentAvatar}
      />
      <div
        className={cn(
          styles.agentBubble,
          isFallback && styles.fallbackBubble,
        )}
      >
        <p className={styles.agentLabel}>
          {COMPANION_AGENT_LABEL}
        </p>
        {streaming ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <AgentMarkdown content={content} />
        )}
      </div>
    </div>
  )
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className={styles.userRow}>
      <div className={styles.userBubble}>
        <p className="whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  )
}
