export type TicketInfo =
  | { status: 'ok'; title: string; state: string }
  | { status: 'error'; reason: string }

export type CommitInfo = { full: string; date: string; author: string; subject: string; url?: string }

declare module 'claude-code' {
  interface PluginState {
    glossary: {
      tickets: Record<string, TicketInfo>
      // null: no repo the session knows holds a commit by that hash.
      commits: Record<string, CommitInfo | null>
    }
  }
}
