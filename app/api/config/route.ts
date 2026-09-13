import { isClientClaudeKeyAllowed } from "@/lib/safety/claude-server"

export async function GET() {
  return Response.json({
    allowClientClaudeKey: isClientClaudeKeyAllowed(),
  })
}
