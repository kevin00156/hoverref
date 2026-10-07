import type { TicketInfo } from '../types'
import type { PlaneTracker } from './refs'

export function workItemUrl(tracker: PlaneTracker, id: string): string {
  return `${tracker.baseUrl}/api/v1/workspaces/${tracker.workspace}/work-items/${id}/?expand=state`
}

export function parseWorkItem(status: number, text: string): TicketInfo {
  if (status === 404) return { status: 'error', reason: 'no such ticket' }
  if (status < 200 || status >= 300) return { status: 'error', reason: `Plane answered HTTP ${status}` }
  const item = JSON.parse(text) as { name?: unknown; state?: { name?: unknown } | string }
  const state = typeof item.state === 'object' && typeof item.state?.name === 'string' ? item.state.name : 'unknown state'
  return { status: 'ok', title: typeof item.name === 'string' ? item.name : '(untitled)', state }
}
