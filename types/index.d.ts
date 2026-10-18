export type TabRow = {
  id: string
  title: string | null
  first_prompt: string | null
  project_label: string
  last_ts: number
  ttl_seconds: number
  last_ttl: string
  last_ctx: number
  reread_warm: number
  reread_cold: number
  cost: number
  calls: number
  last_model: string | null
  subagents: number
  sub_cost: number
  sub_kept: number
}

export type Summary = {
  written: number
  today: number
  week: number
  today_tokens: number
  sessions: TabRow[]
}

export type Limit = { kind: string; percentUsed: number; resetsAt: string | null }

export type Usage = {
  tokens: number
  window: number
  percent: number
  limits: Limit[]
  costUsd: number | null
}

export type Prefs = {
  keepWarmHours: number
  pingMinutesBefore: number
  oversizedTokens: number
  language: string
}

declare module 'claude-code' {
  interface PluginState {
    'token-panel': {
      summary: Summary | null
      usage: Usage | null
      problem: string | null
      lastReply: number
      tick: number
      warm: { until: number; pings: number } | null
      prefs: Prefs
      lastCompact: { before: number; after: number } | null
    }
  }
}
