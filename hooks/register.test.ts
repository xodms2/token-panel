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

test('a typed /compact sends the doc update first and compacts nothing yet', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  let compacted = false
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('command.run', { command: 'compact' }, () => {
    compacted = true
    return { text: 'compacted' }
  })
  on('fs.read', () => ({ value: '- docs/11_journal.md' }) as never)
  const out = await $.command.run({ command: 'compact', args: '', origin: { kind: 'human' } } as never)
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
