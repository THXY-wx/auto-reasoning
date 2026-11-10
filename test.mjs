import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  apply,
  classifyText,
  createClientStatusHandler,
  createSettingsHandler,
  createToggleHandler,
  effortForTier,
  messageText,
  normalizeConfig,
  tierForScore,
} from './index.js'

// Keep the Host half away from the real profile's settings file.
process.env.DSH_AUTO_REASONING_SETTINGS = path.join(os.tmpdir(), `dsh-auto-reasoning-test-${process.pid}.json`)

// Load the browser half the way the client module loader does, so its pure
// directory logic can be tested without a browser.
let clientDefinition
const ReactStub = {
  createElement: () => undefined,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useSyncExternalStore: () => undefined,
}
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      clientDefinition = definition
    },
  },
}
await import('./client.js')
const client = clientDefinition.factory((name) => (name === 'react' ? ReactStub : undefined)).__test

let passed = 0
const cases = []
function test(name, run) {
  cases.push([name, run])
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
// Fake HTTP surface
// ---------------------------------------------------------------------------

function fakeRequest({ method = 'GET', url = '/auto-reasoning/state', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(value) {
      this.body = typeof value === 'string' ? value : ''
    },
  }
}

async function call(handler, request) {
  const res = fakeResponse()
  await handler(request, res)
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('classifier ranks greetings below deep design questions', () => {
  const easy = classifyText('你好，请把这句话翻译成英文。')
  const hard = classifyText(
    '为什么这个分布式任务调度系统在高并发下会出现一致性问题？请分析根因，并设计一个能权衡吞吐与延迟的方案。',
  )
  assert.ok(easy < hard, `expected ${easy} < ${hard}`)
  assert.equal(tierForScore(easy), 'easy')
  assert.equal(tierForScore(hard), 'hard')
})

test('weak domain vocabulary lifts short technical questions out of easy', () => {
  const cases = [
    '帮我诊断一下这个死锁',
    '这个接口返回 500，帮我定位一下',
    '解释一下 CAP 定理',
    '复现一下这个 bug',
    '帮我看看这个内存泄漏',
  ]
  for (const text of cases) {
    const score = classifyText(text)
    assert.ok(tierForScore(score) !== 'easy', `${JSON.stringify(text)} scored ${score}`)
  }
})

test('technical artifacts count as context', () => {
  const plain = classifyText('看看这个配置')
  const withPath = classifyText('看看这个配置 C:\\work\\app\\config.json')
  const withCall = classifyText('看看这个配置 load(name)')
  assert.ok(withPath > plain, `expected ${withPath} > ${plain}`)
  assert.ok(withCall > plain, `expected ${withCall} > ${plain}`)
})

test('custom terms extend both directions', () => {
  const plain = classifyText('帮我检查 gemfield 的实现')
  const hard = classifyText('帮我检查 gemfield 的实现', { hard: ['gemfield'] })
  assert.ok(hard > plain, `expected ${hard} > ${plain}`)
  const easy = classifyText('帮我检查 gemfield 的实现', { easy: ['gemfield'] })
  assert.ok(easy < plain, `expected ${easy} < ${plain}`)
})

test('classifier treats code and multi-step asks as harder', () => {
  const plain = classifyText('帮我看看这个函数')
  const withCode = classifyText('帮我看看这个函数\n```js\nfunction f(a) { return a }\n```')
  assert.ok(withCode > plain, `expected ${withCode} > ${plain}`)
  const steps = classifyText('1. 读取文件\n2. 解析内容\n3. 写出结果\n4. 校验输出')
  assert.ok(steps >= 2, `expected ${steps} >= 2`)
})

test('tier thresholds are inclusive', () => {
  assert.equal(tierForScore(-1), 'easy')
  assert.equal(tierForScore(0), 'normal')
  assert.equal(tierForScore(4), 'hard')
})

test('effort picks a configured id then falls back to the model ladder', () => {
  const efforts = { easy: 'low', normal: 'high', hard: 'max' }
  assert.equal(effortForTier('easy', ['low', 'medium', 'high'], efforts, 'ladder'), 'low')
  assert.equal(effortForTier('hard', ['low', 'medium', 'high'], efforts, 'ladder'), 'high')
  assert.equal(effortForTier('easy', ['minimal', 'high'], efforts, 'ladder'), 'minimal')
  assert.equal(effortForTier('hard', ['minimal', 'high'], efforts, 'ladder'), 'high')
  assert.equal(effortForTier('easy', ['minimal', 'high'], efforts, 'skip'), undefined)
  assert.equal(effortForTier('easy', [], efforts, 'ladder'), undefined)
})

test('an unset tier uses the ladder even when the fallback is skip', () => {
  const none = { easy: '', normal: '', hard: '' }
  assert.equal(effortForTier('easy', ['off', 'low', 'high', 'max'], none, 'skip'), 'off')
  assert.equal(effortForTier('normal', ['off', 'low', 'high', 'max'], none, 'skip'), 'high')
  assert.equal(effortForTier('hard', ['off', 'low', 'high', 'max'], none, 'skip'), 'max')
})

test('config normalization is defensive', () => {
  const fallback = normalizeConfig(undefined)
  assert.deepEqual(fallback, {
    enabled: true,
    defaultAuto: true,
    scope: 'root',
    efforts: { easy: '', normal: '', hard: '' },
    fallback: 'ladder',
    thresholds: { easyMax: -1, hardMin: 4 },
    extraHardTerms: [],
    extraEasyTerms: [],
  })
  const custom = normalizeConfig({
    enabled: false,
    defaultAuto: false,
    scope: 'all',
    efforts: { hard: 'max' },
    fallback: 'skip',
    thresholds: { easyMax: 2, hardMin: 1 },
    extraHardTerms: [' GemField ', 7, ''],
    extraEasyTerms: ['Typo'],
  })
  assert.equal(custom.enabled, false)
  assert.equal(custom.defaultAuto, false)
  assert.equal(custom.scope, 'all')
  assert.equal(custom.efforts.hard, 'max')
  assert.equal(custom.efforts.easy, '')
  assert.equal(custom.fallback, 'skip')
  assert.equal(custom.thresholds.hardMin, 3)
  assert.deepEqual(custom.extraHardTerms, ['gemfield'])
  assert.deepEqual(custom.extraEasyTerms, ['typo'])
})

test('only user-authored text is classified', () => {
  assert.equal(messageText({ source: { kind: 'user' }, content: [{ type: 'text', text: ' hi ' }] }), 'hi')
  assert.equal(messageText({ source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'x' }] }), undefined)
  assert.equal(messageText({ source: { kind: 'user' }, content: [{ type: 'image' }] }), undefined)
})

// ---------------------------------------------------------------------------
// Toggle route
// ---------------------------------------------------------------------------

test('toggle route reads the default and admits same-origin writes', async () => {
  const state = new Map()
  const handler = createToggleHandler({
    state,
    defaultAuto: true,
    getOrigin: () => 'http://127.0.0.1:7053',
  })

  const initial = await call(handler, fakeRequest({ url: '/auto-reasoning/state?sessionId=s1' }))
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.body, { auto: true })

  const written = await call(
    handler,
    fakeRequest({
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:7053', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', auto: false }),
    }),
  )
  assert.equal(written.status, 200)
  assert.deepEqual(written.body, { auto: false })

  const readBack = await call(handler, fakeRequest({ url: '/auto-reasoning/state?sessionId=s1' }))
  assert.deepEqual(readBack.body, { auto: false })
})

test('toggle route rejects cross-origin, non-JSON, and malformed writes', async () => {
  const handler = createToggleHandler({ state: new Map(), defaultAuto: true, getOrigin: () => 'http://127.0.0.1:7053' })

  const crossOrigin = await call(
    handler,
    fakeRequest({
      method: 'POST',
      headers: {
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 's1', auto: false }),
    }),
  )
  assert.equal(crossOrigin.status, 403)

  // A same-origin page served as `localhost` must work even though the server
  // binds `127.0.0.1`.
  const localhost = await call(
    handler,
    fakeRequest({
      method: 'POST',
      headers: {
        origin: 'http://localhost:7053',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 's1', auto: false }),
    }),
  )
  assert.equal(localhost.status, 200)

  const notJson = await call(
    handler,
    fakeRequest({
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:7053', 'content-type': 'text/plain' },
      body: JSON.stringify({ sessionId: 's1', auto: false }),
    }),
  )
  assert.equal(notJson.status, 415)

  const missingSession = await call(
    handler,
    fakeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auto: false }),
    }),
  )
  assert.equal(missingSession.status, 400)

  const badMethod = await call(handler, fakeRequest({ method: 'PUT' }))
  assert.equal(badMethod.status, 405)

  const readWithoutSession = await call(handler, fakeRequest({ url: '/auto-reasoning/state' }))
  assert.equal(readWithoutSession.status, 400)
})

test('client status route records whether the picker decoration installed', async () => {
  const status = { patched: false, at: 0 }
  const handler = createClientStatusHandler({ status, getOrigin: () => 'http://127.0.0.1:7053' })

  const initial = await call(handler, fakeRequest({ url: '/auto-reasoning/client' }))
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.body, { patched: false, at: 0 })

  const written = await call(
    handler,
    fakeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patched: true }),
    }),
  )
  assert.equal(written.status, 200)
  assert.equal(written.body.patched, true)

  const readBack = await call(handler, fakeRequest({ url: '/auto-reasoning/client' }))
  assert.equal(readBack.body.patched, true)

  const crossOrigin = await call(
    handler,
    fakeRequest({
      method: 'POST',
      headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ patched: false }),
    }),
  )
  assert.equal(crossOrigin.status, 403)
})

test('the settings route reads, validates, and persists the default mode', async () => {
  const settings = { efforts: { easy: 'low', normal: 'high', hard: 'max' } }
  const saved = []
  const efforts = [
    { id: 'off', name: 'Off' },
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ]
  const handler = createSettingsHandler({
    settings,
    getEfforts: async () => efforts,
    persist: async (mode) => {
      saved.push(mode)
    },
    getOrigin: () => 'http://127.0.0.1:1398',
  })

  const initial = await call(handler, fakeRequest({ url: '/auto-reasoning/settings' }))
  assert.equal(initial.status, 200)
  assert.equal(initial.body.defaultMode, 'high')
  assert.deepEqual(initial.body.efforts, efforts)

  const written = await call(
    handler,
    fakeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultMode: 'low' }),
    }),
  )
  assert.equal(written.status, 200)
  assert.deepEqual(saved, ['low'])
  assert.equal(settings.efforts.normal, 'low')

  const cleared = await call(
    handler,
    fakeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultMode: '' }),
    }),
  )
  assert.equal(cleared.status, 200)
  assert.deepEqual(saved, ['low', ''])
  assert.equal(settings.efforts.normal, '')

  const unknown = await call(
    handler,
    fakeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultMode: 'nope' }),
    }),
  )
  assert.equal(unknown.status, 400)
  assert.deepEqual(saved, ['low', ''])

  const notJson = await call(
    handler,
    fakeRequest({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }),
  )
  assert.equal(notJson.status, 415)

  const failing = createSettingsHandler({
    settings: { efforts: { normal: '' } },
    getEfforts: async () => [],
    persist: async () => {
      throw new Error('disk full')
    },
  })
  const failed = await call(
    failing,
    fakeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultMode: 'low' }),
    }),
  )
  assert.equal(failed.status, 500)
})

// ---------------------------------------------------------------------------
// Client half: Auto row in the shipped picker's directory
// ---------------------------------------------------------------------------

function fakeDirectory() {
  let snapshot = {
    groups: [
      {
        id: 'p',
        name: 'P',
        models: [
          {
            id: 'm',
            name: 'M',
            reasoning: {
              efforts: [
                { id: 'off', name: 'Off' },
                { id: 'low', name: 'Low' },
                { id: 'high', name: 'High' },
                { id: 'max', name: 'Max' },
              ],
              defaultEffort: 'high',
            },
          },
        ],
      },
    ],
    current: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    pending: null,
    failures: [],
    status: 'ready',
    routable: true,
  }
  const listeners = new Set()
  const selections = []
  return {
    store: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    select(selection) {
      selections.push(selection)
      return Promise.resolve({ ok: true })
    },
    load: () => Promise.resolve(snapshot),
    selections,
    setSnapshot(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

class FakeResolver {
  constructor() {
    this.directories = new Map()
  }

  directoryFor(sessionId) {
    let directory = this.directories.get(sessionId)
    if (directory === undefined) {
      directory = fakeDirectory()
      this.directories.set(sessionId, directory)
    }
    return directory
  }
}

test('the Auto row lands after the model levels and is idempotent', () => {
  const model = {
    id: 'm',
    name: 'M',
    reasoning: {
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'low', name: 'Low' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'off',
    },
  }
  const next = client.withAutoEffort(model)
  assert.deepEqual(next.reasoning.efforts.map((level) => level.id), ['off', 'low', 'max', 'auto'])
  assert.equal(next.reasoning.efforts.at(-1).name, 'Auto')
  assert.equal(client.withAutoEffort(next), next)
  const plain = { id: 'plain', name: 'Plain' }
  assert.equal(client.withAutoEffort(plain), plain)
  const noLevels = { id: 'none', name: 'None', reasoning: { efforts: [] } }
  assert.equal(client.withAutoEffort(noLevels), noLevels)
})

test('the directory reports Auto as selected only while the switch is on', () => {
  const snapshot = {
    groups: [
      {
        id: 'p',
        models: [
          {
            id: 'm',
            reasoning: {
              efforts: [
                { id: 'off', name: 'Off' },
                { id: 'low', name: 'Low' },
                { id: 'max', name: 'Max' },
              ],
              defaultEffort: 'off',
            },
          },
        ],
      },
    ],
    current: { provider: 'p', model: 'm', reasoningEffort: 'low' },
    pending: null,
  }
  const on = client.decorateSnapshot(snapshot, true)
  assert.equal(on.current.reasoningEffort, 'auto')
  assert.equal(on.groups[0].models[0].reasoning.efforts.at(-1).name, 'Auto (Low)')

  const off = client.decorateSnapshot(snapshot, false)
  assert.equal(off.current.reasoningEffort, 'low')
  assert.equal(off.groups[0].models[0].reasoning.efforts.at(-1).name, 'Auto')
  assert.ok(off.groups[0].models[0].reasoning.efforts.some((level) => level.id === 'auto'))
  assert.equal(client.decorateSnapshot(snapshot, undefined).current.reasoningEffort, 'low')
})

test('selecting Auto posts the switch and stores no auto effort', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
    if (init?.method === 'POST') {
      return { ok: true, json: async () => ({ auto: JSON.parse(init.body).auto }) }
    }
    return { ok: true, json: async () => ({ auto: true }) }
  }
  try {
    const resolver = new FakeResolver()
    const restore = client.installDirectoryPatch(resolver)
    assert.equal(typeof restore, 'function')
    assert.equal(client.installDirectoryPatch({}), undefined)

    const wrapper = resolver.directoryFor('s1')
    const directory = resolver.directories.get('s1')
    await flush()

    const first = wrapper.store.getSnapshot()
    assert.equal(first.current.reasoningEffort, 'auto')
    assert.equal(wrapper.store.getSnapshot(), first, 'snapshot identity must stay stable between changes')

    // Auto is already on, so choosing it again needs no write.
    await wrapper.select({ provider: 'p', model: 'm', reasoningEffort: 'auto' })
    assert.deepEqual(directory.selections.at(-1), { provider: 'p', model: 'm' })
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0)

    await wrapper.select({ provider: 'p', model: 'm', reasoningEffort: 'low' })
    assert.deepEqual(directory.selections.at(-1), { provider: 'p', model: 'm', reasoningEffort: 'low' })
    assert.deepEqual(JSON.parse(calls.at(-1).body), { sessionId: 's1', auto: false })
    assert.notEqual(wrapper.store.getSnapshot().current.reasoningEffort, 'auto')

    await wrapper.select({ provider: 'p', model: 'm', reasoningEffort: 'auto' })
    assert.deepEqual(directory.selections.at(-1), { provider: 'p', model: 'm' })
    assert.deepEqual(JSON.parse(calls.at(-1).body), { sessionId: 's1', auto: true })
    assert.equal(wrapper.store.getSnapshot().current.reasoningEffort, 'auto')

    restore()
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// Plugin behavior against a fake Host surface
// ---------------------------------------------------------------------------

function harness(options = {}) {
  const listeners = new Map()
  const efforts = options.efforts ?? [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ]
  const logs = []
  const roots = []
  const selections = []
  const routes = []
  const agents = {
    roots: () => roots,
    list: () => roots,
  }
  const llm = {
    async resolveModelInfo(provider, model) {
      if (options.failResolution === true) throw new Error('no adapter')
      return { provider, model, name: model, reasoning: { efforts } }
    },
  }
  const webServer = {
    getOrigin: () => 'http://127.0.0.1:7053',
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agents') return agents
      if (name === 'webServer') return webServer
      return undefined
    },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    inject(names, callback) {
      if (!names.includes('webServer')) return () => {}
      callback({ webServer, effect: (cb) => cb() })
      return () => {}
    },
    logger: {
      debug: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
    effect(callback) {
      return callback()
    },
  }
  function emit(name, payload) {
    for (const handler of listeners.get(name) ?? []) handler(payload)
  }
  function agentFor(route) {
    return {
      id: `${route.provider}/${route.model}`,
      model: {
        current: () => ({ ...route }),
        select: (selection) => {
          selections.push(selection)
          Object.assign(route, selection)
        },
      },
    }
  }
  const preloaded = options.preload === true ? agentFor({ provider: 'p', model: 'already-open' }) : undefined
  if (preloaded !== undefined) roots.push(preloaded)
  apply(ctx, options.config)
  return { emit, agentFor, roots, selections, logs, listeners, routes, preloaded, webServer }
}

function userMessage(text) {
  return { source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

test('a claimed user question selects the tier effort for that step', async () => {
  const h = harness()
  const agent = h.agentFor({ provider: 'p', model: 'm' })
  h.roots.push(agent)
  h.emit('agent/created', { agent, source: 'startup' })
  await flush()
  assert.equal(h.listeners.get('agent/inbox/claimed').length, 1)

  h.emit('agent/inbox/claimed', { agent, turn: 1, message: userMessage('你好，谢谢') })
  assert.deepEqual(h.selections.at(-1), { provider: 'p', model: 'm', reasoningEffort: 'low' })

  h.emit('agent/inbox/claimed', {
    agent,
    turn: 2,
    message: userMessage('为什么这个分布式系统在高并发下会出现一致性问题？请分析根因并设计优化方案。'),
  })
  assert.deepEqual(h.selections.at(-1), { provider: 'p', model: 'm', reasoningEffort: 'high' })
})

test('the Auto switch suppresses and restores adjustments for one session', async () => {
  const h = harness()
  const agent = h.agentFor({ provider: 'p', model: 'm' })
  h.roots.push(agent)
  h.emit('agent/created', { agent })
  await flush()

  const route = h.routes.find((candidate) => candidate.path === '/auto-reasoning/state')
  assert.ok(route !== undefined, 'toggle route must be registered')

  const off = await call(
    route.handler,
    fakeRequest({
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:7053', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: agent.id, auto: false }),
    }),
  )
  assert.equal(off.status, 200)

  h.emit('agent/inbox/claimed', { agent, turn: 1, message: userMessage('你好') })
  assert.equal(h.selections.length, 0, 'Auto off must not touch the selection')

  const on = await call(
    route.handler,
    fakeRequest({
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:7053', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: agent.id, auto: true }),
    }),
  )
  assert.equal(on.status, 200)

  h.emit('agent/inbox/claimed', { agent, turn: 2, message: userMessage('你好') })
  assert.deepEqual(h.selections.at(-1), { provider: 'p', model: 'm', reasoningEffort: 'low' })
})

test('activation warms routes of agents that were already open', async () => {
  const h = harness({ preload: true })
  const agent = h.preloaded
  await flush()
  h.emit('agent/inbox/claimed', { agent, turn: 1, message: userMessage('你好') })
  assert.deepEqual(h.selections.at(-1), { provider: 'p', model: 'already-open', reasoningEffort: 'low' })
})

test('a cold capability cache skips the step, then adjusts the next question', async () => {
  const h = harness()
  const agent = h.agentFor({ provider: 'p', model: 'cold' })
  h.roots.push(agent)
  h.emit('agent/inbox/claimed', { agent, turn: 1, message: userMessage('你好') })
  assert.equal(h.selections.length, 0, 'must not guess an unsupported effort')
  await flush()
  h.emit('agent/inbox/claimed', { agent, turn: 2, message: userMessage('你好') })
  assert.deepEqual(h.selections.at(-1), { provider: 'p', model: 'cold', reasoningEffort: 'low' })
})

test('an unchanged effort records nothing', async () => {
  const h = harness()
  const agent = h.agentFor({ provider: 'p', model: 'm', reasoningEffort: 'low' })
  h.roots.push(agent)
  h.emit('agent/created', { agent })
  await flush()
  h.emit('agent/inbox/claimed', { agent, turn: 1, message: userMessage('你好') })
  assert.equal(h.selections.length, 0)
})

test('scope root ignores subagent sessions', async () => {
  const h = harness()
  const root = h.agentFor({ provider: 'p', model: 'm' })
  const child = h.agentFor({ provider: 'p', model: 'child' })
  h.roots.push(root)
  h.emit('agent/created', { agent: child })
  await flush()
  h.emit('agent/inbox/claimed', { agent: child, turn: 1, message: userMessage('你好') })
  assert.equal(h.selections.length, 0)
})

test('scope all includes subagent sessions', async () => {
  const h = harness({ config: { scope: 'all' } })
  const root = h.agentFor({ provider: 'p', model: 'm' })
  const child = h.agentFor({ provider: 'p', model: 'child' })
  h.roots.push(root)
  h.emit('agent/created', { agent: child })
  await flush()
  h.emit('agent/inbox/claimed', { agent: child, turn: 1, message: userMessage('你好') })
  assert.deepEqual(h.selections.at(-1), { provider: 'p', model: 'child', reasoningEffort: 'low' })
})

test('non-user and empty claimed messages are ignored', async () => {
  const h = harness()
  const agent = h.agentFor({ provider: 'p', model: 'm' })
  h.roots.push(agent)
  h.emit('agent/created', { agent })
  await flush()
  h.emit('agent/inbox/claimed', {
    agent,
    turn: 1,
    message: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'current time' }] },
  })
  h.emit('agent/inbox/claimed', { agent, turn: 1, message: { source: { kind: 'user' }, content: [] } })
  assert.equal(h.selections.length, 0)
})

test('a model without reasoning support is left alone', async () => {
  const h = harness({ efforts: [] })
  const agent = h.agentFor({ provider: 'p', model: 'm' })
  h.roots.push(agent)
  h.emit('agent/created', { agent })
  await flush()
  h.emit('agent/inbox/claimed', { agent, turn: 1, message: userMessage('你好') })
  assert.equal(h.selections.length, 0)
})

test('a disabled row registers nothing', () => {
  const h = harness({ config: { enabled: false } })
  assert.equal(h.listeners.size, 0)
  assert.equal(h.routes.length, 0)
})

for (const [name, run] of cases) {
  try {
    await run()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

console.log(`\n${passed}/${cases.length} checks passed`)
