export type TicketInfo =
  | { status: 'ok'; title: string; state: string }
  | { status: 'error'; reason: string }

declare module 'claude-code' {
  interface PluginState {
    glossary: { tickets: Record<string, TicketInfo> }
  }
}
