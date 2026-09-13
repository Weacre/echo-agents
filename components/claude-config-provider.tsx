"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import { Settings2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  clearClaudeClientConfig,
  ANTHROPIC_DEFAULT_BASE_URL,
  claudeFieldsForRequest,
  normalizeClaudeBaseUrl,
  readClaudeClientConfig,
  writeClaudeClientConfig,
} from "@/lib/claude-client-config"

type ClaudeConfigContextValue = {
  openConfig: () => void
  claudeRequestFields: { claudeApiKey?: string; claudeBaseUrl?: string }
  allowClientClaudeKey: boolean
}

const ClaudeConfigContext = createContext<ClaudeConfigContextValue | null>(null)

export function useClaudeConfig(): ClaudeConfigContextValue {
  const ctx = useContext(ClaudeConfigContext)
  if (!ctx) {
    throw new Error("useClaudeConfig must be used within ClaudeConfigProvider")
  }
  return ctx
}

export function ClaudeConfigProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [allowClientClaudeKey, setAllowClientClaudeKey] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [draftApiKey, setDraftApiKey] = useState("")
  const [draftBaseUrl, setDraftBaseUrl] = useState("")
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetch("/api/config")
      .then(async (r) => (await r.json()) as { allowClientClaudeKey?: boolean })
      .then((data) => {
        if (cancelled) return
        const allowed = data.allowClientClaudeKey === true
        setAllowClientClaudeKey(allowed)
        if (!allowed) {
          clearClaudeClientConfig()
          setApiKey("")
          setBaseUrl("")
        } else {
          const c = readClaudeClientConfig()
          setApiKey(c.apiKey)
          setBaseUrl(c.baseUrl)
        }
      })
      .catch(() => {
        if (!cancelled) setAllowClientClaudeKey(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const openConfig = useCallback(() => {
    if (allowClientClaudeKey) {
      const c = readClaudeClientConfig()
      setDraftApiKey(c.apiKey)
      setDraftBaseUrl(c.baseUrl)
      setFormError(null)
    }
    setOpen(true)
  }, [allowClientClaudeKey])

  const save = useCallback(() => {
    if (!allowClientClaudeKey) return
    setFormError(null)
    const k = draftApiKey.trim()
    const u = draftBaseUrl.trim()
    if (u.length > 0 && normalizeClaudeBaseUrl(u) === null) {
      setFormError(
        "Base URL 须为 https 基础地址，不含 /v1/messages（例如 " + ANTHROPIC_DEFAULT_BASE_URL + "）",
      )
      return
    }
    writeClaudeClientConfig({ apiKey: k, baseUrl: u })
    setApiKey(k)
    setBaseUrl(u)
    setOpen(false)
  }, [allowClientClaudeKey, draftApiKey, draftBaseUrl])

  const clear = useCallback(() => {
    clearClaudeClientConfig()
    setDraftApiKey("")
    setDraftBaseUrl("")
    setApiKey("")
    setBaseUrl("")
    setFormError(null)
    setOpen(false)
  }, [])

  const claudeRequestFields = useMemo(
    () =>
      allowClientClaudeKey ? claudeFieldsForRequest(apiKey, baseUrl) : {},
    [allowClientClaudeKey, apiKey, baseUrl],
  )

  const value = useMemo<ClaudeConfigContextValue>(
    () => ({
      openConfig,
      claudeRequestFields,
      allowClientClaudeKey,
    }),
    [openConfig, claudeRequestFields, allowClientClaudeKey],
  )

  return (
    <ClaudeConfigContext.Provider value={value}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Claude 接口配置</DialogTitle>
            <DialogDescription>
              {allowClientClaudeKey
                ? "仅本地开发可用：密钥保存在浏览器 localStorage。生产环境请配置服务端环境变量 ANTHROPIC_API_KEY。"
                : "生产环境不在浏览器中保存或传输 API Key。请在部署平台配置环境变量 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL。"}
            </DialogDescription>
          </DialogHeader>
          {allowClientClaudeKey ? (
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="claude-api-key">ANTHROPIC_API_KEY</Label>
                <Input
                  id="claude-api-key"
                  type="password"
                  autoComplete="off"
                  value={draftApiKey}
                  onChange={(e) => setDraftApiKey(e.target.value)}
                  placeholder="留空则使用服务端环境变量"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="claude-base-url">ANTHROPIC_BASE_URL</Label>
                <Input
                  id="claude-base-url"
                  type="url"
                  autoComplete="off"
                  value={draftBaseUrl}
                  onChange={(e) => setDraftBaseUrl(e.target.value)}
                  placeholder={ANTHROPIC_DEFAULT_BASE_URL}
                />
              </div>
              {formError && (
                <p className="text-sm text-destructive" role="alert">
                  {formError}
                </p>
              )}
            </div>
          ) : (
            <p className="py-2 text-sm text-muted-foreground">
              当前环境已禁用客户端 API Key，对话请求将仅使用服务端配置。
            </p>
          )}
          <Separator />
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
            {allowClientClaudeKey && (
              <>
                <Button type="button" variant="outline" onClick={clear}>
                  清除本地配置
                </Button>
                <Button type="button" onClick={save}>
                  保存
                </Button>
              </>
            )}
            {!allowClientClaudeKey && (
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                关闭
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ClaudeConfigContext.Provider>
  )
}

export function ClaudeConfigTrigger({
  className,
}: {
  className?: string
}) {
  const { allowClientClaudeKey, openConfig } = useClaudeConfig()
  if (!allowClientClaudeKey) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      onClick={openConfig}
      aria-label="Claude 接口配置"
    >
      <Settings2Icon className="size-5" />
      <span className="hidden md:inline">接口设置</span>
    </Button>
  )
}
