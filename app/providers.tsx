"use client"

import { ClaudeConfigProvider } from "@/components/claude-config-provider"

export function Providers({ children }: { children: React.ReactNode }) {
  return <ClaudeConfigProvider>{children}</ClaudeConfigProvider>
}
