import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Prefs, Summary, TabRow, Usage } from '../types'

const PANE = 'tokens'
const TITLE = 'Tokens'
const SETTINGS_PANE = 'token-settings'
// Filled at session start. reader/server.py, shipped with the plugin, reads
// Claude Code's logs and writes summary.json into the person's own data folder
// (~/.claude/token-panel, every 5 s while it runs as a server, or once per
// `--once`). settings.json sits beside it, read every few seconds, so a hand
// edit applies without a restart and an update of the plugin keeps it.
const paths = { reader: '', readerDir: '', summary: '', settings: '', isWindows: false }

async function initPaths($: EngineInterface) {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = isWindows
    ? (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    : (await $.env.get('HOME')) || ''
  const config = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`).replace(/\\/g, '/')
  const root = $.plugin.root.replace(/\\/g, '/')
  paths.readerDir = `${root}/reader`
  paths.reader = `${root}/reader/server.py`
  paths.summary = `${config}/token-panel/summary.json`
  paths.settings = `${config}/token-panel/settings.json`
  paths.isWindows = isWindows
}

// How to start Python here; the first that works wins. On Windows `python`
// is often an app alias that only a shell can start.
const pythons = () =>
  paths.isWindows
    ? [['python'], ['cmd', '/c', 'python'], ['py', '-3']]
    : [['python3'], ['python']]

// Opens a file in the person's default app: `open` on macOS, `xdg-open` on Linux.
const openers = (file: string) =>
  paths.isWindows ? [['cmd', '/c', 'start', '', file.replace(/\//g, '\\')]] : [['open', file], ['xdg-open', file]]

// Runs the first command of `tries` that starts and exits 0; else throws the last failure.
async function runFirst($: EngineInterface, tries: string[][], init?: { cwd?: string; timeoutMs?: number }) {
  let failure = 'nothing to run'
  for (const argv of tries) {
    try {
      const ran = await $.process.run(argv, init)
      if (ran.exitCode === 0) return
      failure = ran.stderr.trim().split('\n').pop() || `${argv[0]}: exit ${ran.exitCode}`
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(failure)
}

const DEFAULTS: Prefs = { keepWarmHours: 3, pingMinutesBefore: 5, oversizedTokens: 200_000, language: 'en-US' }
// The weekday's language. The app keeps its own in a file beside its sign-in
// tokens, which the panel does not open; the person picks it here instead.
const LANGUAGES = [
  { value: 'en-US', label: 'English' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'system', label: "Computer's language" },
]
const CHOICES = {
  keepWarmHours: [1, 2, 3, 4, 8],
  pingMinutesBefore: [2, 5, 10],
  oversizedTokens: [100_000, 150_000, 200_000, 300_000, 500_000],
}
const STALE_MS = 20_000
const OTHER_TABS = 6

const summary = atom({ plugin: 'token-panel', key: 'summary' } as const, null)
const usage = atom({ plugin: 'token-panel', key: 'usage' } as const, null)
const problem = atom({ plugin: 'token-panel', key: 'problem' } as const, null)
const lastReply = atom({ plugin: 'token-panel', key: 'lastReply' } as const, 0)
const tick = atom({ plugin: 'token-panel', key: 'tick' } as const, 0)
const warm = atom({ plugin: 'token-panel', key: 'warm' } as const, null)
const prefs = atom({ plugin: 'token-panel', key: 'prefs' } as const, DEFAULTS)
const lastCompact = atom({ plugin: 'token-panel', key: 'lastCompact' } as const, null)
// The project's own list of what to update: free text, read at each use.
const DOCS_FILE = '.claude/handoff-docs.md'
const PING = "Keep-alive ping from the token panel, to keep this tab's prompt cache warm. Reply with only: ok"
const COMPACT_THEN =
  'Then reply with a three-line summary of what you recorded; the conversation is compacted right after.'
const HANDOFF_THEN = [
  'Then write the handoff note (handoff.md in the project root, overwritten, unless the list above names another place):',
  'the goal, what was decided, the open questions, the next steps and the files that matter, in under 60 lines.',
  'End by saying it is safe to start a new tab from that note.',
].join(' ')

const usd = (v: number) =>
  v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : v > 0 ? '<$0.01' : '$0'
const tok = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v)
const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s))
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`
}
const bar = (pct: number, width: number) => {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(n) + '░'.repeat(width - n)
}
const limitName = (kind: string) =>
  kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? 'Weekly' : kind.replace(/_/g, ' ')
const resets = (iso: string | null, language: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  const sameDay = d.toDateString() === new Date().toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? `resets ${hm}` : `resets ${d.toLocaleDateString(language === 'system' ? undefined : language, { weekday: 'short' })} ${hm}`
}
const hoursLabel = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : `${h}h`)
// The picker's options, with a hand-edited value kept in the list.
const choices = (list: number[], cur: number, label: (v: number) => string) =>
  [...new Set([...list, cur])].sort((a, b) => a - b).map(v => ({ value: String(v), label: label(v) }))
const DOCS_STARTER = [
  '- The documents this session should update before a handoff or a compaction, one per line',
  '- Handoff note: handoff.md in the project root',
  '',
].join('\n')
// Where a tab's cost went: rereading a live cache, rebuilding it, answering.
// Empty until the reader has the parts (a summary from an older reader has none).
const split = (t: TabRow | null) => {
  if (!t || typeof t.c_read !== 'number') return ''
  const all = t.c_read + t.c_write + t.c_out
  if (!(all > 0)) return ''
  const pct = (v: number) => `${Math.round((v / all) * 100)}%`
  return `read ${pct(t.c_read)} · rebuild ${pct(t.c_write)} · output ${pct(t.c_out)}`
}
const titleOf = (t: TabRow) => t.title || t.first_prompt || t.id.slice(0, 8)
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

// A value missing, mistyped or out of range falls back to its default.
function cleanPrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (k: 'keepWarmHours' | 'pingMinutesBefore' | 'oversizedTokens', lo: number, hi: number) => {
    const v = Number(r[k])
    return Number.isFinite(v) && v >= lo && v <= hi ? v : DEFAULTS[k]
  }
  return {
    keepWarmHours: num('keepWarmHours', 0.25, 24),
    pingMinutesBefore: num('pingMinutesBefore', 1, 30),
    oversizedTokens: num('oversizedTokens', 10_000, 1_000_000),
    language: LANGUAGES.some(l => l.value === r.language) ? String(r.language) : DEFAULTS.language,
  }
}

async function loadPrefs($: EngineInterface) {
  let next = DEFAULTS
  try {
    next = cleanPrefs(JSON.parse(await $.fs.read(paths.settings)))
  } catch {
    // No file yet, or not JSON: the defaults stand.
  }
  const cur = await read($, prefs)
  if (JSON.stringify(cur) !== JSON.stringify(next)) await update($, prefs, () => next)
}

async function savePrefs($: EngineInterface, patch: Partial<Prefs>) {
  if (!paths.reader) await initPaths($)
  const next = cleanPrefs({ ...(await read($, prefs)), ...patch })
  await update($, prefs, () => next)
  await $.fs.write(paths.settings, `${JSON.stringify(next, null, 2)}\n`)
}

let sessionId = ''
let isRefreshing = false
// The turn this plugin started and is waiting on, and what follows it.
let pending: 'ping' | 'docs' | 'handoff' | null = null
let compactAfter: string | null = null
// True once the docs were updated and nobody has said anything since.
let docsFresh = false

// The engine refuses a compaction while a turn runs, and the docs turn may not
// have let go yet when its end is heard: try again until the session is idle.
const COMPACT_RETRY_MS = 2000
const COMPACT_TRIES = 30

async function compactWhenIdle($: EngineInterface, instructions: string, tries = 1) {
  try {
    const done = await $.session.compact(instructions ? { instructions } : undefined)
    if ('skip' in done && done.skip) $.ui.log(`token-panel: the compaction was skipped: ${done.skip}`)
  } catch (err) {
    if (tries < COMPACT_TRIES) {
      $.clock.after(COMPACT_RETRY_MS, () => void compactWhenIdle($, instructions, tries + 1))
      return
    }
    const why = err instanceof Error ? err.message : String(err)
    $.ui.log(`token-panel: the compaction did not run (${why}). Type /compact skip-docs to compact now.`)
  }
}

async function docsPrompt($: EngineInterface, then: string) {
  let list = ''
  try {
    list = (await $.fs.read(DOCS_FILE)).trim()
  } catch {
    // No list for this project: fall back to its own conventions.
  }
  return [
    'Update the project records with what this session has settled since they were last updated.',
    '',
    'Documents to update:',
    list || 'The documents this project uses to record decisions, as its CLAUDE.md and memory describe them.',
    '',
    'Record only what was actually decided and keep open questions marked as open. Do not start new work.',
    then,
  ].join('\n')
}

// Asks Claude to update the docs and write the handoff note; answers what
// happened. Called directly by the Handoff button: running /handoff from the
// panel's own press would skip the panel's own command hook (the engine never
// runs a plugin's hook inside that plugin's call), and nothing would answer.
async function startHandoff($: EngineInterface) {
  try {
    const text = await docsPrompt($, HANDOFF_THEN)
    pending = 'handoff'
    // A command or a press may not start a turn itself; a timer may, once it returns.
    $.clock.after(10, () => {
      $.prompt.submit({ text }).catch(async err => {
        pending = null
        await update($, problem, () => `Handoff could not start: ${err instanceof Error ? err.message : String(err)}`)
      })
    })
    return 'Updating the docs and writing the handoff note.'
  } catch (err) {
    pending = null
    return `Handoff could not start: ${err instanceof Error ? err.message : String(err)}`
  }
}

// Sends one tiny message when this tab's cache is about to expire, while
// Keep warm is on. A tab already cold is left alone: a ping would pay the
// full rebuild it exists to avoid.
async function keepWarm($: EngineInterface) {
  const w = await read($, warm)
  if (!w || pending) return
  const now = (await $.clock.now()) / 1000
  if (now > w.until) {
    await update($, warm, () => null)
    return
  }
  const s = await read($, summary)
  const mine = s?.sessions.find(t => t.id === sessionId) ?? null
  const last = Math.max(mine?.last_ts ?? 0, await read($, lastReply))
  const ttl = mine?.ttl_seconds ?? 3600
  const left = last + ttl - now
  if (!last || left <= 0 || left > Math.min((await read($, prefs)).pingMinutesBefore * 60, ttl / 5)) return
  pending = 'ping'
  await update($, warm, v => (v ? { ...v, pings: v.pings + 1 } : v))
  await $.prompt.submit({ text: PING })
}

async function refresh($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    if (!paths.reader) await initPaths($)
    sessionId = await $.session.id()
    await loadPrefs($)
    const now = await $.clock.now()
    const stat = await $.fs.stat(paths.summary).catch(() => null)
    if (!stat || now - stat.mtimeMs > STALE_MS) {
      // No dashboard server running: read the new log lines ourselves.
      const tries = pythons().map(py => [...py, paths.reader, '--once'])
      await runFirst($, tries, { cwd: paths.readerDir, timeoutMs: 300_000 }).catch(err => {
        throw new Error(`Python could not run the reader (is Python 3 installed?): ${err.message}`)
      })
    }
    const parsed = JSON.parse(await $.fs.read(paths.summary)) as Summary
    await update($, summary, () => parsed)
    await update($, problem, () => null)
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    await update($, problem, () => text)
  } finally {
    isRefreshing = false
  }
  try {
    const u = await $.session.usage()
    const next: Usage = {
      tokens: u.context.tokens ?? 0,
      window: u.context.window,
      percent: u.context.percent ?? 0,
      limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt ?? null })),
      costUsd: u.cost?.usd ?? null,
    }
    await update($, usage, () => next)
  } catch {
    // Usage figures are a nicety; the summary still draws.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    await initPaths($)
    await $.command.register({ name: 'tokens', description: 'Open the token panel with every tab' })
    await $.command.register({ name: 'handoff', description: 'Update the project docs and write a handoff note' })
    void refresh($)
    $.clock.every(5000, () => void refresh($))
    $.clock.every(15_000, () => void keepWarm($))
    $.clock.every(1000, () => void update($, tick, n => n + 1))

    return next(e)
  })

  on('command.run', { command: 'tokens' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, columns: 40 })
    void refresh($)

    return { text: 'Token panel opened.' }
  })

  on('command.run', { command: 'handoff' }, async $ => ({ text: await startHandoff($) }))

  // /compact updates the docs first, then compacts when that turn ends.
  // `/compact skip-docs` compacts at once; so does a /compact right after an
  // update, and one a plugin runs (the person's own typing is never 'plugin').
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    const args = e.args.trim()
    const skip = /^skip-docs\b/.test(args)
    if (e.origin.kind === 'plugin' || docsFresh || skip) {
      return next({ ...e, args: args.replace(/^skip-docs\b\s*/, '') })
    }
    compactAfter = args
    pending = 'docs'
    const text = await docsPrompt($, COMPACT_THEN)
    $.clock.after(10, () => void $.prompt.submit({ text }))

    return {
      text: 'Updating the project docs first; the compaction runs when that turn ends. (/compact skip-docs compacts right away.)',
    }
  })

  // Remembers how much the last compaction took off, for the band.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.trigger !== 'precompute' && 'tokensBefore' in done && done.tokensBefore && done.tokensAfter !== undefined) {
      const before = done.tokensBefore
      const after = done.tokensAfter
      await update($, lastCompact, () => ({ before, after }))
    }

    return done
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') docsFresh = false

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    // A subagent's turn ends inside the main one: it is not the turn we wait on.
    if (e.agentId) return ran
    const now = await $.clock.now()
    await update($, lastReply, () => now / 1000)
    const kind = pending
    pending = null
    const answered = e.reason === 'answer'
    if (answered && (kind === 'docs' || kind === 'handoff')) docsFresh = true
    if (kind === 'docs' && compactAfter !== null) {
      const instructions = compactAfter
      compactAfter = null
      // An interrupted or failed docs turn leaves the conversation as it is.
      if (answered) $.clock.after(10, () => void compactWhenIdle($, instructions))
    }
    void refresh($)

    return ran
  })

  // One line above the message box; the full panel opens from its button or /tokens.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const p = await read($, prefs)
    await read($, tick)
    const s = await read($, summary)
    const u = await read($, usage)
    const err = await read($, problem)
    const replied = await read($, lastReply)
    const w = await read($, warm)
    const now = (await $.clock.now()) / 1000

    const mine = s?.sessions.find(t => t.id === sessionId) ?? null
    const last = Math.max(mine?.last_ts ?? 0, replied)
    const left = last ? last + (mine?.ttl_seconds ?? 3600) - now : -1
    const ctx = u?.tokens || mine?.last_ctx || 0
    const hm = (t: number) => {
      const d = new Date(t * 1000)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    const limits = (u?.limits ?? []).map(l => ({
      text: `${l.kind === 'five_hour' ? '5h' : l.kind === 'seven_day' ? 'week' : limitName(l.kind)} ${Math.round(l.percentUsed)}%`,
      color: l.percentUsed >= 90 ? 'error' : l.percentUsed >= 70 ? 'warning' : undefined,
      // Critical: close enough to the limit to plan around.
      bold: l.percentUsed >= 85,
    }))

    const big = ctx > p.oversizedTokens
    // Critical from 75% of the window: Claude Code compacts on its own near the end.
    const ctxPct = u?.window ? Math.round((ctx / u.window) * 100) : 0
    const lc = await read($, lastCompact)

    // The second row's figures, most useful first: a narrow band cuts from the end.
    const week = u?.limits.find(l => l.kind === 'seven_day')
    const extras = [
      week?.resetsAt ? `week ${resets(week.resetsAt, p.language)}` : '',
      mine && mine.calls ? `tab ${usd(mine.cost)} (${usd(mine.cost / mine.calls)}/msg)` : '',
      mine && mine.subagents
        ? `${mine.subagents} subagent${mine.subagents > 1 ? 's' : ''} ${usd(mine.sub_cost)}, kept ${tok(mine.sub_kept)} out`
        : '',
      lc ? `last compact −${tok(Math.max(0, lc.before - lc.after))}` : '',
      split(mine),
    ].filter(Boolean)

    // Two rows that never change shape: the figures on the first, the
    // controls on the second, every control always drawn. Each text sits in a
    // box that may shrink, so a long figure is cut at the row's end instead of
    // wrapping and making the band taller.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text size="caption" wrap="truncate-end">
              {limits.map((l, i) => (
                <Text color={l.color} dimColor={!l.color}>
                  {i ? ' · ' : ''}
                  <Text bold={l.bold}>{l.text}</Text>
                </Text>
              ))}
              {limits.length ? <Text dimColor>{'  │  '}</Text> : ''}
              <Text color={big ? 'warning' : undefined} dimColor={!big} bold={ctxPct >= 75}>
                {`context ${tok(ctx)}${u?.window ? ` (${ctxPct}%)` : ''}${big ? ' oversized' : ''}`}
              </Text>
              <Text dimColor>{' · '}</Text>
              {left > 0 ? (
                <Text color={left < 60 ? 'warning' : 'success'} tabular>{`cache ${clock(left)}`}</Text>
              ) : (
                <Text dimColor>{last ? 'cache expired' : 'cache –'}</Text>
              )}
              {mine ? <Text dimColor tabular>{` · reread ${usd(left > 0 ? mine.reread_warm : mine.reread_cold)}`}</Text> : ''}
              {s ? <Text dimColor tabular>{`  │  ${usd(s.today)} today`}</Text> : ''}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="row" gap="xs" alignItems="center">
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text size="caption" dimColor wrap="truncate-end">
              {err ? <Text color="warning">{'⚠ no tab data (see Tabs)'}</Text> : ''}
              {extras.map((x, i) => `${i || err ? ' · ' : ''}${x}`).join('')}
            </Text>
          </Box>
          <Box flexDirection="row" gap="xs" alignItems="center" flexShrink={0}>
            {w ? (
              <Button key="keepwarm" label="Stop keep warm" variant="primary" onPress={() => void update($, warm, () => null)}>
                {'Warm: '}
                <Text color="success" tabular>{hm(w.until)}</Text>
              </Button>
            ) : (
              <Button
                key="keepwarm"
                label="Keep warm"
                onPress={async () => {
                  const t = (await $.clock.now()) / 1000
                  await update($, warm, () => ({ until: t + p.keepWarmHours * 3600, pings: 0 }))
                }}
              />
            )}
            <Select
              key="warmhours"
              options={choices(CHOICES.keepWarmHours, p.keepWarmHours, hoursLabel)}
              value={String(p.keepWarmHours)}
              onSelect={async v => {
                await savePrefs($, { keepWarmHours: Number(v) })
                // A new length while warm counts from now.
                const t = (await $.clock.now()) / 1000
                await update($, warm, cur => (cur ? { ...cur, until: t + Number(v) * 3600 } : cur))
              }}
            />
            <Button
              key="handoff"
              label="Handoff"
              dimColor={!big}
              onPress={async () => $.ui.toast(await startHandoff($))}
            />
            <Button key="tabs" label="Tabs" onPress={() => void $.ui.open({ id: PANE, title: TITLE, columns: 40 })} />
            <Button
              key="settings"
              label="⚙"
              onPress={() => void $.ui.open({ id: SETTINGS_PANE, title: 'Token panel settings', columns: 44 })}
            />
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const p = await read($, prefs)
    const docs = `${await $.session.root()}/${DOCS_FILE}`.replace(/\\/g, '/')

    return (
      <Box flexDirection="column" gap="md">
        <Box flexDirection="column">
          <Text weight="semibold">Keep warm</Text>
          <Select
            key="set-hours"
            label="Runs for "
            options={choices(CHOICES.keepWarmHours, p.keepWarmHours, hoursLabel)}
            value={String(p.keepWarmHours)}
            onSelect={v => void savePrefs($, { keepWarmHours: Number(v) })}
          />
          <Select
            key="set-ping"
            label="Pings "
            options={choices(CHOICES.pingMinutesBefore, p.pingMinutesBefore, m => `${m} min before the cache expires`)}
            value={String(p.pingMinutesBefore)}
            onSelect={v => void savePrefs($, { pingMinutesBefore: Number(v) })}
          />
        </Box>
        <Box flexDirection="column">
          <Text weight="semibold">Handoff</Text>
          <Select
            key="set-oversized"
            label="Oversized above "
            options={choices(CHOICES.oversizedTokens, p.oversizedTokens, tok)}
            value={String(p.oversizedTokens)}
            onSelect={v => void savePrefs($, { oversizedTokens: Number(v) })}
          />
          <Text dimColor size="caption">The Handoff button shows past this size, and the context turns yellow.</Text>
        </Box>
        <Box flexDirection="column">
          <Text weight="semibold">Language</Text>
          <Select
            key="set-language"
            label="Weekdays in "
            options={LANGUAGES}
            value={p.language}
            onSelect={v => void savePrefs($, { language: v })}
          />
          <Text dimColor size="caption">Pick the one your Claude app uses.</Text>
        </Box>
        <Box flexDirection="column">
          <Text size="caption">{`Documents to update: ${DOCS_FILE} in this project`}</Text>
          <Button
            key="edit-docs"
            label="Edit the document list"
            onPress={async () => {
              if (!(await $.fs.exists(docs))) await $.fs.write(docs, DOCS_STARTER)
              await runFirst($, openers(docs))
            }}
          />
        </Box>
        <Text dimColor size="caption">{`Saved to ${paths.settings}; a hand edit there applies within seconds.`}</Text>
        <Button key="reset" label="Reset to defaults" onPress={() => void savePrefs($, DEFAULTS)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const p = await read($, prefs)
    await read($, tick)
    const s = await read($, summary)
    const u = await read($, usage)
    const err = await read($, problem)
    const replied = await read($, lastReply)
    const now = (await $.clock.now()) / 1000
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(8, Math.min(20, cols - 22))

    const mine = s?.sessions.find(t => t.id === sessionId) ?? null
    const ttl = mine?.ttl_seconds ?? 3600
    const last = Math.max(mine?.last_ts ?? 0, replied)
    const left = last ? last + ttl - now : -1
    const others = (s?.sessions ?? []).filter(t => t.id !== sessionId).slice(0, OTHER_TABS)
    const ctx = u?.tokens || mine?.last_ctx || 0

    return (
      <Box flexDirection="column" gap="sm">
        {u && u.limits.length > 0 && (
          <Box flexDirection="column">
            <Text weight="semibold">Plan usage</Text>
            {u.limits.map(l => (
              <Box flexDirection="column">
                <Text mono>
                  <Text color={l.percentUsed >= 90 ? 'error' : l.percentUsed >= 70 ? 'warning' : 'success'}>{bar(l.percentUsed, barW)}</Text>
                  {` ${Math.round(l.percentUsed)}% ${limitName(l.kind)}`}
                </Text>
                <Text dimColor size="caption">{resets(l.resetsAt, p.language)}</Text>
              </Box>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Text weight="semibold">This tab</Text>
          <Text>
            {'Context  '}
            <Text color={ctx > p.oversizedTokens ? 'warning' : 'text'} tabular>{tok(ctx)}</Text>
            {u ? <Text dimColor>{` of ${tok(u.window)} (${u.percent}%)`}</Text> : ''}
            {ctx > p.oversizedTokens ? <Text color="warning">{'  oversized'}</Text> : ''}
          </Text>
          <Text>
            {'Cache    '}
            {left > 0 ? (
              <Text color={left < 60 ? 'warning' : 'success'} tabular>{`● alive ${clock(left)}`}</Text>
            ) : (
              <Text dimColor>{last ? '○ expired' : '○ no reply yet'}</Text>
            )}
            <Text dimColor>{mine ? ` (${mine.last_ttl})` : ''}</Text>
          </Text>
          {mine && (
            <Text>
              {'Reread   '}
              <Text tabular>{usd(left > 0 ? mine.reread_warm : mine.reread_cold)}</Text>
              <Text dimColor>{left > 0 ? ` warm · ${usd(mine.reread_cold)} if it expires` : ' cold'}</Text>
            </Text>
          )}
          <Text>
            {'Cost     '}
            <Text tabular>{usd(mine?.cost ?? u?.costUsd ?? 0)}</Text>
            <Text dimColor>{mine ? ` · ${mine.calls} calls` : ''}</Text>
          </Text>
        </Box>

        {s && (
          <Text>
            <Text weight="semibold">{'All tabs  '}</Text>
            <Text tabular>{`${usd(s.today)} today · ${usd(s.week)} this week`}</Text>
          </Text>
        )}

        {others.length > 0 && (
          <Box flexDirection="column">
            <Text weight="semibold">Other tabs</Text>
            {others.map(t => {
              const l = t.last_ts + t.ttl_seconds - now
              const big = t.last_ctx > p.oversizedTokens
              return (
                <Box flexDirection="column">
                  <Text wrap="truncate-end">
                    <Text color={l > 0 ? (l < 60 ? 'warning' : 'success') : 'inactive'}>{l > 0 ? '● ' : '○ '}</Text>
                    {cut(titleOf(t), cols - 2)}
                  </Text>
                  <Text dimColor size="caption">
                    {`  ${t.project_label} · `}
                    <Text color={big ? 'warning' : undefined}>{tok(t.last_ctx)}</Text>
                    {` · ${l > 0 ? `alive ${clock(l)}` : `cold reread ${usd(t.reread_cold)}`}`}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}

        {err && <Text color="error" size="caption">{`Could not read usage: ${cut(err, 200)}`}</Text>}
        {!s && !err && <Text dimColor>Reading logs…</Text>}
        <Link href="http://localhost:8777" label="Full dashboard in the browser" />
        <Text dimColor size="caption">{`It needs the reader running as a server: ${paths.isWindows ? "python" : "python3"} "${paths.reader}"`}</Text>
      </Box>
    )
  })
}
