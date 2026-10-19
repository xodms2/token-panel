import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'tokens',
  viewport: { columns: 48, rows: 40 },
  props: {
    title: 'Tokens',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 36 },
    view: {},
  },
} as const

test('before any data, the panel draws this tab and the dashboard link', async ($, on) => {
  on('clock.now', () => ({ value: 1_760_000_000_000 }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'token-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /This tab/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band draws the same controls whatever its state', async ($, on) => {
  on('clock.now', () => ({ value: 1_760_000_000_000 }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'token-panel',
      surface,
      component: 'AbovePrompt',
      viewport: { columns: 100, rows: 40 },
      props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 95, scroll: { offset: 0, bodyRows: 10 } },
    })
    expect(await ui.find({ type: 'Text', text: /context/ })).toBeDefined()
    expect(await ui.find({ key: 'tabs' })).toBeDefined()
    expect(await ui.find({ key: 'settings' })).toBeDefined()
    expect(await ui.find({ key: 'warmhours' })).toBeDefined()
    await ui.unmount()
  }
})

test('Keep warm switches on from the band and Stop switches it off', async ($, on) => {
  on('clock.now', () => ({ value: 1_760_000_000_000 }))
  const ui = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'desktop',
    component: 'AbovePrompt',
    viewport: { columns: 100, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 95, scroll: { offset: 0, bodyRows: 10 } },
  })
  await ui.press({ key: 'keepwarm' })
  expect(await ui.find({ type: 'Text', text: /\d{2}:\d{2}/ })).toBeDefined()
  await ui.press({ key: 'keepwarm' })
  expect(await ui.find({ type: 'Text', text: /\d{2}:\d{2}/ })).toBeUndefined()
  await ui.unmount()
})

test('/compact-docs sends the doc update first and compacts nothing yet', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  let compacted = false
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('session.compact', () => {
    compacted = true
    return { skip: 'test' } as never
  })
  on('fs.read', () => ({ value: '- docs/11_journal.md' }) as never)
  const out = await $.command.run({ command: 'compact-docs', args: '', origin: { kind: 'composer' } } as never)
  expect(compacted).toBe(false)
  await clock.advance(20)
  expect(out.text).toContain('docs first')
  expect(sent[0]).toContain('docs/11_journal.md')
})

test('a pick in the settings panel is saved to settings.json', async ($, on) => {
  on('clock.now', () => ({ value: 1_760_000_000_000 }))
  on('session.root', () => ({ value: 'C:/project' }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  const writes: string[] = []
  on('fs.write', (_$, e) => {
    writes.push(String((e as { text: string }).text))
    return { value: undefined } as never
  })
  const ui = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'token-settings',
    viewport: { columns: 48, rows: 40 },
    props: { ...PANE.props, title: 'Token panel settings' },
  })
  await ui.select({ key: 'set-hours', value: '8' })
  expect(writes.at(-1)).toContain('"keepWarmHours": 8')
  await ui.unmount()
})

test('/handoff answers and then sends the doc update with the handoff note', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('fs.read', () => ({ value: '- docs/11_journal.md' }) as never)
  const out = await $.command.run({ command: 'handoff', args: '', origin: { kind: 'composer' } } as never)
  expect(out.text).toContain('handoff')
  await clock.advance(20)
  expect(sent[0]).toContain('handoff.md')
})

test('the Handoff button starts the handoff itself, not through /handoff', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('fs.read', () => ({ value: '- docs/11_journal.md' }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  const ui = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'desktop',
    component: 'AbovePrompt',
    viewport: { columns: 100, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 95, scroll: { offset: 0, bodyRows: 10 } },
  })
  await ui.press({ key: 'handoff' })
  await clock.advance(20)
  expect(sent[0]).toContain('handoff.md')
  await ui.unmount()
})

const turnEnd = (extra: Record<string, unknown> = {}) =>
  ({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as never

function compactKit(on: Parameters<Parameters<typeof test>[1]>[1], failures = 0) {
  const calls = { compact: 0, logs: [] as string[] }
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: 'done' }))
  on('fs.read', () => ({ value: '- docs/11_journal.md' }) as never)
  on('ui.log', (_$, e) => {
    calls.logs.push(String((e as { text: string }).text))
    return { value: undefined } as never
  })
  on('session.compact', () => {
    calls.compact++
    if (calls.compact <= failures) throw new Error('a turn is running')
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 500_000, tokensAfter: 40_000 } as never
  })
  return calls
}

test('/compact-docs compacts when the docs turn ends, not when a subagent turn does', async ($, on) => {
  const clock = mock.clock(on)
  const calls = compactKit(on)
  await $.command.run({ command: 'compact-docs', args: '', origin: { kind: 'composer' } } as never)
  await clock.advance(20)
  await $.turn.complete(turnEnd({ agentId: 'sub-1' }))
  await clock.advance(20)
  expect(calls.compact).toBe(0)
  await $.turn.complete(turnEnd())
  await clock.advance(20)
  expect(calls.compact).toBe(1)
})

test('a compaction refused while the session is busy is tried again', async ($, on) => {
  const clock = mock.clock(on)
  const calls = compactKit(on, 2)
  await $.command.run({ command: 'compact-docs', args: '', origin: { kind: 'composer' } } as never)
  await clock.advance(20)
  await $.turn.complete(turnEnd())
  await clock.advance(20)
  expect(calls.compact).toBe(1)
  await clock.advance(5000)
  expect(calls.compact).toBe(3)
  expect(calls.logs).toEqual([])
})

test('a compaction that never runs says so in the transcript', async ($, on) => {
  const clock = mock.clock(on)
  const calls = compactKit(on, 1000)
  await $.command.run({ command: 'compact-docs', args: '', origin: { kind: 'composer' } } as never)
  await clock.advance(20)
  await $.turn.complete(turnEnd())
  await clock.advance(120_000)
  expect(calls.compact).toBe(30)
  expect(calls.logs.at(-1)).toContain('Type /compact')
})

test('an interrupted docs turn compacts nothing', async ($, on) => {
  const clock = mock.clock(on)
  const calls = compactKit(on)
  await $.command.run({ command: 'compact-docs', args: '', origin: { kind: 'composer' } } as never)
  await clock.advance(20)
  await $.turn.complete(turnEnd({ reason: 'aborted', isAborted: true }))
  await clock.advance(5000)
  expect(calls.compact).toBe(0)
})

test('/compact is left to Claude Code', async ($, on) => {
  let core = false
  on('command.run', { command: 'compact' }, () => {
    core = true
    return { text: 'compacted' }
  })
  await $.command.run({ command: 'compact', args: '', origin: { kind: 'composer' } } as never)
  expect(core).toBe(true)
})
