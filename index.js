/**
 * Adaptive reasoning effort for the DeepSeek Harness.
 *
 * Every model step already carries a fixed provider/model/effort selection that
 * the agent loop captures just before the step is prepared. That selection is
 * writable only through `agent.model.select()`, and it must be written *before*
 * the capture: `agent/inbox/claimed` is dispatched synchronously inside
 * `agent-loop`'s claim, immediately before `model.current()` runs, so a
 * listener on it can adjust the effort for exactly the step that is starting.
 *
 * The classifier is a deterministic local heuristic (no extra model call), so
 * this listener never delays a step and never spends tokens. Its vocabulary is
 * split into strong signals (worth more) and weak domain signals (worth less but
 * never saturating the cap), and users can extend both from the row config.
 *
 * A per-session Auto switch is served over one local HTTP route so the Web
 * composer can turn the behavior off without editing the profile.
 *
 * @module @local/dsh-auto-reasoning
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'auto-reasoning'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS = Object.freeze({ easyMax: -1, hardMin: 4 })

/**
 * An empty tier maps to the model's own effort ladder by position, which keeps
 * the plugin useful on providers whose effort ids this package cannot name.
 */
const DEFAULT_EFFORTS = Object.freeze({
  easy: '',
  normal: '',
  hard: '',
})

const DEFAULT_AUTO = true
const TOGGLE_PATH = '/auto-reasoning/state'
const CLIENT_STATUS_PATH = '/auto-reasoning/client'
const SETTINGS_PATH = '/auto-reasoning/settings'
const SETTINGS_FILE_NAME = 'auto-reasoning.settings.json'
const MAX_TOGGLE_BODY_BYTES = 4096
const MAX_SESSION_ID_LENGTH = 200
const MAX_MODE_LENGTH = 50

/**
 * Signals that a message needs deeper reasoning. Each matching pattern adds
 * points; the sum is capped, so two distinct strong signals already saturate
 * the band.
 */
const STRONG_HARD_TERMS = [
  /为什么/,
  /为何/,
  /原理/,
  /证明/,
  /推导/,
  /设计/,
  /架构/,
  /重构/,
  /调试/,
  /排错/,
  /优化/,
  /分析/,
  /对比/,
  /权衡/,
  /算法/,
  /并发/,
  /分布式/,
  /一致性/,
  /复杂度/,
  /根因/,
  /瓶颈/,
  /边界情况/,
  /异常/,
  /\bwhy\b/i,
  /\bprove\b/i,
  /\bderive\b/i,
  /\bdesign\b/i,
  /\barchitect\w*/i,
  /\bdebug\w*/i,
  /\brefactor\w*/i,
  /\boptimi[sz]\w*/i,
  /\bbenchmark\w*/i,
  /\banaly[sz]\w*/i,
  /\bcompare\b/i,
  /\btrade-?offs?\b/i,
  /\balgorithm\w*/i,
  /\bconcurren\w*/i,
  /\bdistributed\b/i,
  /\bconsisten\w*/i,
  /\bcomplex\w*/i,
  /\broot cause\b/i,
  /\bbottleneck\w*/i,
  /\bedge cases?\b/i,
]

/**
 * Domain nouns and ordinary engineering verbs. They say "this is technical
 * work" without claiming it is hard, so each is worth one point and the band is
 * capped independently of the strong signals.
 */
const WEAK_HARD_TERMS = [
  /代码/,
  /函数/,
  /接口/,
  /报错/,
  /错误/,
  /失败/,
  /性能/,
  /排查/,
  /诊断/,
  /定位/,
  /复现/,
  /解释/,
  /原因/,
  /方案/,
  /实现/,
  /配置/,
  /依赖/,
  /版本/,
  /兼容/,
  /迁移/,
  /缓存/,
  /数据库/,
  /事务/,
  /索引/,
  /网络/,
  /协议/,
  /编译/,
  /线程/,
  /内存/,
  /死锁/,
  /竞态/,
  /泄漏/,
  /安全/,
  /测试/,
  /部署/,
  /日志/,
  /崩溃/,
  /插件/,
  /脚本/,
  /命令/,
  /参数/,
  /返回值/,
  /超时/,
  /重试/,
  /鉴权/,
  /加密/,
  /证书/,
  /容器/,
  /\bfix\b/i,
  /\bissue\b/i,
  /\berrors?\b/i,
  /\bfail(?:s|ed|ing)?\b/i,
  /\bbugs?\b/i,
  /\bcode\b/i,
  /\bfunction\b/i,
  /\bapi\b/i,
  /\bconfig\w*/i,
  /\bdependenc\w*/i,
  /\bversion\w*/i,
  /\bmigrat\w*/i,
  /\bcach\w*/i,
  /\bdatabase\b/i,
  /\btransactions?\b/i,
  /\bindex(?:es|ing)?\b/i,
  /\bnetwork\w*/i,
  /\bprotocol\w*/i,
  /\bcompil\w*/i,
  /\bthreads?\b/i,
  /\bmemory\b/i,
  /\bdeadlock\w*/i,
  /\brace\b/i,
  /\bleak\w*/i,
  /\bsecurity\b/i,
  /\btests?\b/i,
  /\bdeploy\w*/i,
  /\blogs?\b/i,
  /\bcrash\w*/i,
  /\bplugins?\b/i,
  /\bscript\w*/i,
  /\bcommand\w*/i,
  /\bparameters?\b/i,
  /\btimeouts?\b/i,
  /\bretry|retries\b/i,
  /\bauth\w*/i,
  /\bencrypt\w*/i,
  /\bcertificates?\b/i,
  /\bcontainers?\b/i,
  /\btroubleshoot\w*/i,
  /\bdiagnos\w*/i,
  /\breproduc\w*/i,
  /\bexplain\w*/i,
]

/** Signals that a message only wants a short, shallow answer. */
const EASY_TERMS = [
  /你好/,
  /您好/,
  /谢谢/,
  /多谢/,
  /列出/,
  /翻译/,
  /总结/,
  /概括/,
  /改名/,
  /格式化/,
  /是什么/,
  /什么是/,
  /有哪些/,
  /拼写/,
  /错别字/,
  /\bhi\b/i,
  /\bhello\b/i,
  /\bhey\b/i,
  /\bthanks?\b/i,
  /\bthank you\b/i,
  /\blist\b/i,
  /\btranslate\b/i,
  /\bsummari[sz]\w*/i,
  /\brename\b/i,
  /\bformat\b/i,
  /\bwhat is\b/i,
  /\bwhat's\b/i,
  /\bwho is\b/i,
  /\btypos?\b/i,
  /\bspelling\b/i,
]

/** Multi-part questions tend to need more planning. */
const STEP_MARKER = /(^|\n)\s*(?:\d+[.、)]|[-*])\s+/g

const STEP_WORDS = [
  /首先/,
  /其次/,
  /然后/,
  /接着/,
  /最后/,
  /第一步/,
  /第二步/,
  /同时/,
  /并且/,
  /\bfirst\b/i,
  /\bsecond\b/i,
  /\bthird\b/i,
  /\bthen\b/i,
  /\bfinally\b/i,
  /\bstep \d/i,
]

/** Code or debug artifacts: calls, filenames, stack frames, paths, status codes. */
const TECH_SIGNALS = [
  /[A-Za-z_$][\w$]*\s*\(/,
  /\b[\w-]+\.(?:js|ts|tsx|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|json|ya?ml|toml|ini|md|css|scss|html|sql|sh|ps1)\b/i,
  /\bat\s+[\w.$<>]+\([^)]*:\d+\)/,
  /[A-Za-z]:\\|\/[\w.-]+\/[\w.-]+/,
  /\b[45]\d{2}\b/,
]

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function countHits(text, patterns) {
  let hits = 0
  for (const pattern of patterns) {
    if (pattern.test(text)) hits += 1
  }
  return hits
}

function countSubstrings(text, terms) {
  if (terms.length === 0) return 0
  const haystack = text.toLowerCase()
  let hits = 0
  for (const term of terms) {
    if (haystack.includes(term)) hits += 1
  }
  return hits
}

/**
 * Score one question's difficulty.
 *
 * Strong signals score 2 each (capped at 4), weak domain signals score 1 each
 * (capped at 3), and easy vocabulary subtracts up to 3. Length, code fences,
 * multi-step markers, and technical artifacts add independent evidence. The
 * result is not normalized: tiers are read from `thresholds`.
 *
 * @param {unknown} value - the user's message text.
 * @param {{ hard?: readonly string[], easy?: readonly string[] }} [custom] - extra
 *   substrings from the row config, matched case-insensitively.
 * @returns {number} a signed difficulty score.
 */
export function classifyText(value, custom) {
  const text = typeof value === 'string' ? value : ''
  const customHard = Array.isArray(custom?.hard) ? custom.hard : []
  const customEasy = Array.isArray(custom?.easy) ? custom.easy : []
  const length = text.length
  let score = 0

  if (length >= 600) score += 3
  else if (length >= 250) score += 2
  else if (length >= 100) score += 1

  if (text.includes('```')) score += 2
  else if (/`[^`\n]+`/.test(text)) score += 1

  const strong = countHits(text, STRONG_HARD_TERMS) + countSubstrings(text, customHard)
  score += Math.min(4, strong * 2)

  const weak = countHits(text, WEAK_HARD_TERMS)
  score += Math.min(3, weak)

  const easy = countHits(text, EASY_TERMS) + countSubstrings(text, customEasy)
  if (easy > 0) score -= Math.min(3, easy * 2)
  if (length < 20) score -= 1

  const markers = (text.match(STEP_MARKER) ?? []).length
  if (markers >= 3) score += 2
  else if (markers >= 2) score += 1

  const stepWords = countHits(text, STEP_WORDS)
  if (stepWords >= 3) score += 2
  else if (stepWords >= 2) score += 1

  const questions = (text.match(/[?？]/g) ?? []).length
  if (questions >= 2) score += 1

  score += Math.min(2, countHits(text, TECH_SIGNALS))

  return score
}

/**
 * Map a score onto the three difficulty tiers.
 *
 * @param {number} score - output of {@link classifyText}.
 * @param {{ easyMax: number, hardMin: number }} thresholds - inclusive bounds.
 * @returns {'easy' | 'normal' | 'hard'} the tier for that score.
 */
export function tierForScore(score, thresholds = DEFAULT_THRESHOLDS) {
  if (score <= thresholds.easyMax) return 'easy'
  if (score >= thresholds.hardMin) return 'hard'
  return 'normal'
}

/**
 * Pick one effort actually supported by the model.
 *
 * A configured id is used verbatim when the model advertises it. Otherwise the
 * `ladder` fallback takes the tier's position in the model's own effort list,
 * which keeps the plugin useful across providers whose ids differ. `skip`
 * leaves the current selection untouched instead. An unset tier always uses
 * the ladder, so omitting configuration never disables the plugin.
 *
 * @param {'easy' | 'normal' | 'hard'} tier - chosen difficulty tier.
 * @param {readonly string[]} available - the model's advertised effort ids.
 * @param {Record<string, string>} configured - tier-to-effort-id configuration.
 * @param {'ladder' | 'skip'} fallback - behavior for unsupported ids.
 * @returns {string | undefined} the effort id to select, or undefined to skip.
 */
export function effortForTier(tier, available, configured, fallback) {
  if (!Array.isArray(available) || available.length === 0) return undefined
  const wanted = configured[tier]
  if (typeof wanted === 'string' && wanted.length > 0) {
    if (available.includes(wanted)) return wanted
    if (fallback === 'skip') return undefined
  }
  return ladderEffort(tier, available)
}

/**
 * Pick a tier's position in the model's own effort ladder.
 *
 * Easy takes the cheapest level, hard takes the strongest, and normal takes the
 * upper middle so a four-level ladder like `off/low/high/max` lands on `high`.
 *
 * @param {'easy' | 'normal' | 'hard'} tier - chosen difficulty tier.
 * @param {readonly string[]} available - non-empty advertised effort ids.
 * @returns {string} the effort id at that position.
 */
export function ladderEffort(tier, available) {
  if (tier === 'easy') return available[0]
  if (tier === 'hard') return available[available.length - 1]
  return available[Math.min(available.length - 1, Math.floor(available.length / 2))]
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function textOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function termList(value) {
  if (!Array.isArray(value)) return []
  const terms = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const term = item.trim().toLowerCase()
    if (term.length > 0 && !terms.includes(term)) terms.push(term)
  }
  return terms
}

/**
 * Normalize the row's `config` mapping. Unknown keys are ignored and invalid
 * values fall back to the documented defaults, so a hand-edited profile patch
 * cannot make the plugin refuse to mount.
 *
 * @param {unknown} raw - the Loader row config.
 * @returns {{ enabled: boolean, defaultAuto: boolean, scope: 'root' | 'all', efforts: Record<string, string>, fallback: 'ladder' | 'skip', thresholds: { easyMax: number, hardMin: number }, extraHardTerms: string[], extraEasyTerms: string[] }}
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const effortSource = source.efforts !== null && typeof source.efforts === 'object' ? source.efforts : {}
  const thresholdSource = source.thresholds !== null && typeof source.thresholds === 'object' ? source.thresholds : {}
  const easyMax = finiteOr(thresholdSource.easyMax, DEFAULT_THRESHOLDS.easyMax)
  const hardMin = Math.max(finiteOr(thresholdSource.hardMin, DEFAULT_THRESHOLDS.hardMin), easyMax + 1)
  return {
    enabled: source.enabled !== false,
    defaultAuto: source.defaultAuto !== false,
    scope: source.scope === 'all' ? 'all' : 'root',
    efforts: {
      easy: textOr(effortSource.easy, DEFAULT_EFFORTS.easy),
      normal: textOr(effortSource.normal, DEFAULT_EFFORTS.normal),
      hard: textOr(effortSource.hard, DEFAULT_EFFORTS.hard),
    },
    fallback: source.fallback === 'skip' ? 'skip' : 'ladder',
    thresholds: { easyMax, hardMin },
    extraHardTerms: termList(source.extraHardTerms),
    extraEasyTerms: termList(source.extraEasyTerms),
  }
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/**
 * Extract the visible text of one agent-inbox message, and only for
 * human-authored input: runtime-context snapshots, model-switch notices and
 * tool-role content never drive an effort change.
 *
 * @param {unknown} message - an inbox message.
 * @returns {string | undefined} trimmed text, or undefined when the message is not user text.
 */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return undefined
  if (message.source?.kind !== 'user') return undefined
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  return text.length === 0 ? undefined : text
}

function routeKey(selection) {
  if (selection === null || typeof selection !== 'object') return undefined
  const { provider, model } = selection
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) return undefined
  return `${provider}\u0000${model}`
}

function headerValue(req, name) {
  const value = req?.headers?.[name]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

function isSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH
}

function sendJson(res, status, body, options) {
  const head = options?.head === true
  const headers = options?.headers ?? {}
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(head ? undefined : text)
}

async function readBody(req, limit) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > limit) throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' })
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Whether a request comes from another origin. Browsers send `Sec-Fetch-Site`
 * on same-origin and cross-site requests alike, so it wins when present;
 * older clients are compared against the server origin instead.
 *
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {string | undefined} expected - this server's origin, when known.
 * @returns {boolean} true when the request must be rejected.
 */
function requestCrossesOrigin(req, expected) {
  const fetchSite = headerValue(req, 'sec-fetch-site')
  if (fetchSite !== undefined) return fetchSite !== 'same-origin'
  const origin = headerValue(req, 'origin')
  return origin !== undefined && expected !== undefined && origin !== expected
}

/**
 * Build the handler that records whether the browser half installed its
 * directory decoration. It is a diagnostic surface: `patched: false` means the
 * shipped picker cannot show the Auto row on this Harness build.
 *
 * @param {{ status: { patched: boolean, at: number }, getOrigin?: () => string | undefined, logger?: { warn?: (message: string) => void } }} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createClientStatusHandler(options) {
  const status = options.status
  const getOrigin = typeof options.getOrigin === 'function' ? options.getOrigin : () => undefined

  return async function clientStatusHandler(req, res) {
    try {
      const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
      let expected
      try {
        expected = getOrigin()
      } catch {
        expected = undefined
      }
      if (requestCrossesOrigin(req, expected)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }

      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, { patched: status.patched === true, at: status.at ?? 0 }, { head: method === 'HEAD' })
        return
      }

      if (method === 'POST') {
        if (!String(headerValue(req, 'content-type') ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { error: 'application/json required' })
          return
        }
        const raw = await readBody(req, MAX_TOGGLE_BODY_BYTES)
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        status.patched = parsed?.patched === true
        status.at = Date.now()
        options.logger?.debug?.(`auto-reasoning: browser decoration ${status.patched ? 'installed' : 'unavailable'}`)
        sendJson(res, 200, { patched: status.patched, at: status.at })
        return
      }

      sendJson(res, 405, { error: 'method not allowed' }, { headers: { allow: 'GET, HEAD, POST' } })
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { error: 'body too large' })
        return
      }
      options.logger?.warn?.(`auto-reasoning: client status request failed: ${String(error)}`)
      sendJson(res, 500, { error: 'internal error' })
    }
  }
}

/**
 * Build the local HTTP handler behind the composer's Auto switch.
 *
 * - `GET  /auto-reasoning/state?sessionId=...` reads one session's switch.
 * - `POST /auto-reasoning/state` with `{ sessionId, auto }` writes it.
 *
 * Only same-origin requests are admitted, and a write must be JSON so a
 * cross-origin form post cannot toggle a session. The store is in memory: a
 * Host restart returns every session to `defaultAuto`.
 *
 * @param {{ state: Map<string, boolean>, defaultAuto?: boolean, getOrigin?: () => string | undefined, logger?: { warn?: (message: string) => void } }} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createToggleHandler(options) {
  const state = options.state
  const defaultAuto = options.defaultAuto !== false
  const getOrigin = typeof options.getOrigin === 'function' ? options.getOrigin : () => undefined

  return async function toggleHandler(req, res) {
    try {
      const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
      const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://localhost')
      let expected
      try {
        expected = getOrigin()
      } catch {
        expected = undefined
      }
      if (requestCrossesOrigin(req, expected)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }

      if (method === 'GET' || method === 'HEAD') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!isSessionId(sessionId)) {
          sendJson(res, 400, { error: 'invalid sessionId' })
          return
        }
        sendJson(res, 200, { auto: state.get(sessionId) ?? defaultAuto }, { head: method === 'HEAD' })
        return
      }

      if (method === 'POST') {
        if (!String(headerValue(req, 'content-type') ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { error: 'application/json required' })
          return
        }
        const raw = await readBody(req, MAX_TOGGLE_BODY_BYTES)
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : ''
        if (!isSessionId(sessionId)) {
          sendJson(res, 400, { error: 'invalid sessionId' })
          return
        }
        if (typeof parsed.auto !== 'boolean') {
          sendJson(res, 400, { error: 'auto must be boolean' })
          return
        }
        state.set(sessionId, parsed.auto)
        options.logger?.debug?.(`auto-reasoning: session ${sessionId} auto ${parsed.auto ? 'on' : 'off'}`)
        sendJson(res, 200, { auto: parsed.auto })
        return
      }

      sendJson(res, 405, { error: 'method not allowed' }, { headers: { allow: 'GET, HEAD, POST' } })
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { error: 'body too large' })
        return
      }
      options.logger?.warn?.(`auto-reasoning: toggle request failed: ${String(error)}`)
      sendJson(res, 500, { error: 'internal error' })
    }
  }
}

// ---------------------------------------------------------------------------
// Persisted default mode
// ---------------------------------------------------------------------------

function settingsFileCandidates() {
  const override = process.env.DSH_AUTO_REASONING_SETTINGS
  if (typeof override === 'string' && override.length > 0) return [override]
  const files = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.length > 0) files.push(path.join(profileDir, SETTINGS_FILE_NAME))
  const profile = process.env.DSH_PROFILE
  if (typeof profile === 'string' && profile.length > 0) {
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    files.push(path.join(home, 'profiles', profile, SETTINGS_FILE_NAME))
  }
  // Last resort: beside the package. The package directory always exists and
  // stays writable for a linked local checkout.
  files.push(path.join(path.dirname(fileURLToPath(import.meta.url)), SETTINGS_FILE_NAME))
  return files
}

/**
 * Read the persisted default mode. A missing or unreadable file means "no
 * override"; the row config stays in charge.
 *
 * @returns {string | undefined} the stored effort id, `''` for the ladder, or undefined when absent.
 */
export function loadStoredMode() {
  for (const file of settingsFileCandidates()) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed?.defaultMode === 'string') return parsed.defaultMode
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/**
 * Persist the default mode atomically so a crash cannot leave a half-written
 * settings file. The first candidate that accepts the write wins.
 *
 * @param {string} mode - effort id, or `''` to follow the model's ladder.
 * @returns {string} the file that was written.
 */
export function saveStoredMode(mode) {
  let lastError
  for (const file of settingsFileCandidates()) {
    try {
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ defaultMode: mode }, null, 2), 'utf8')
      renameSync(temporary, file)
      return file
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('no writable location for the settings file')
}

/**
 * Build the handler behind the Settings row. `GET` returns the current default
 * and the default model's effort levels; `POST` validates one level, persists
 * it, and applies it to the running plugin immediately.
 *
 * @param {{ settings: { efforts: Record<string, string> }, getEfforts?: () => Promise<Array<{ id: string, name: string }>>, persist?: (mode: string) => Promise<void> | void, getOrigin?: () => string | undefined, logger?: { warn?: (message: string) => void } }} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createSettingsHandler(options) {
  const settings = options.settings
  const getOrigin = typeof options.getOrigin === 'function' ? options.getOrigin : () => undefined

  async function effortsOf() {
    if (typeof options.getEfforts !== 'function') return []
    try {
      const list = await options.getEfforts()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  return async function settingsHandler(req, res) {
    try {
      const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
      let expected
      try {
        expected = getOrigin()
      } catch {
        expected = undefined
      }
      if (requestCrossesOrigin(req, expected)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }

      if (method === 'GET' || method === 'HEAD') {
        const efforts = await effortsOf()
        const defaultMode = typeof settings.efforts?.normal === 'string' ? settings.efforts.normal : ''
        sendJson(res, 200, { defaultMode, efforts }, { head: method === 'HEAD' })
        return
      }

      if (method === 'POST') {
        if (!String(headerValue(req, 'content-type') ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { error: 'application/json required' })
          return
        }
        const raw = await readBody(req, MAX_TOGGLE_BODY_BYTES)
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        if (typeof parsed?.defaultMode !== 'string') {
          sendJson(res, 400, { error: 'defaultMode must be a string' })
          return
        }
        const mode = parsed.defaultMode.trim()
        if (mode.length > MAX_MODE_LENGTH) {
          sendJson(res, 400, { error: 'defaultMode is too long' })
          return
        }
        if (mode.length > 0) {
          const efforts = await effortsOf()
          if (efforts.length > 0 && !efforts.some((effort) => effort?.id === mode)) {
            sendJson(res, 400, { error: 'defaultMode is not supported by the default model' })
            return
          }
        }
        try {
          await options.persist?.(mode)
        } catch (error) {
          options.logger?.warn?.(`auto-reasoning: could not persist the default mode: ${String(error)}`)
          sendJson(res, 500, { error: 'could not persist the default mode', detail: String(error) })
          return
        }
        if (settings.efforts !== null && typeof settings.efforts === 'object') settings.efforts.normal = mode
        options.logger?.debug?.(`auto-reasoning: default mode ${mode === '' ? 'ladder' : mode}`)
        sendJson(res, 200, { defaultMode: mode })
        return
      }

      sendJson(res, 405, { error: 'method not allowed' }, { headers: { allow: 'GET, HEAD, POST' } })
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { error: 'body too large' })
        return
      }
      options.logger?.warn?.(`auto-reasoning: settings request failed: ${String(error)}`)
      sendJson(res, 500, { error: 'internal error' })
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Adjust each new question's reasoning effort before its step is prepared.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's owning context.
 * @param {unknown} config - the Loader row config; see {@link normalizeConfig}.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) return

  // The Settings row outranks the row config's `efforts.normal`; an absent
  // settings file leaves the config in charge.
  const storedMode = loadStoredMode()
  if (storedMode !== undefined) settings.efforts.normal = storedMode

  /** route key -> advertised effort ids (possibly empty when the model has none). */
  const capabilities = new Map()
  /** route key -> in-flight capability lookup. */
  const warming = new Map()
  /** session id -> Auto switch; absent means `settings.defaultAuto`. */
  const autoState = new Map()
  /** Browser half's directory-decoration status, reported by the page. */
  const clientStatus = { patched: false, at: 0 }
  let disposed = false

  const logger = ctx.logger

  function service(name) {
    try {
      return ctx.get?.(name)
    } catch {
      return undefined
    }
  }

  function autoFor(sessionId) {
    return autoState.get(sessionId) ?? settings.defaultAuto
  }

  /** The default model's advertised effort levels, for the Settings row. */
  async function currentEfforts() {
    const llm = service('llm')
    const selection = service('agentDefaultModel')?.currentSelection?.()
    if (llm === undefined || llm === null || selection === undefined || selection === null) return []
    const info = await llm.resolveModelInfo(selection.provider, selection.model)
    const efforts = info?.reasoning?.efforts
    return Array.isArray(efforts)
      ? efforts.map((effort) => ({ id: effort.id, name: effort.name })).filter((effort) => typeof effort.id === 'string')
      : []
  }

  /** Resolve and cache one route's reasoning capability without blocking a step. */
  function warm(selection) {
    const key = routeKey(selection)
    if (key === undefined || capabilities.has(key) || warming.has(key) || disposed) return
    const llm = service('llm')
    if (llm === undefined || llm === null) return Promise.resolve()
    const job = Promise.resolve()
      .then(() => llm.resolveModelInfo(selection.provider, selection.model))
      .then((info) => {
        const efforts = info?.reasoning?.efforts
        const ids = Array.isArray(efforts)
          ? efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string' && id.length > 0)
          : []
        if (!disposed) capabilities.set(key, ids)
      })
      .catch((error) => {
        if (disposed) return
        capabilities.set(key, [])
        logger?.debug?.(`auto-reasoning: cannot resolve reasoning efforts for "${key.replace('\u0000', '/')}": ${String(error)}`)
      })
      .finally(() => {
        warming.delete(key)
      })
    warming.set(key, job)
    return job
  }

  /** Whether this agent's steps are in scope. */
  function inScope(agent) {
    if (settings.scope === 'all') return true
    const agents = service('agents')
    if (agents === undefined || agents === null || typeof agents.roots !== 'function') return true
    try {
      return agents.roots().includes(agent)
    } catch {
      return true
    }
  }

  /** Observe one claimed message and, when it is a user question, select its effort. */
  function onClaimed(payload) {
    if (disposed) return
    const agent = payload?.agent
    const message = payload?.message
    if (agent === undefined || agent === null || !inScope(agent)) return
    if (!autoFor(agent.id)) return
    const text = messageText(message)
    if (text === undefined) return

    const model = agent.model
    if (model === undefined || model === null) return
    if (typeof model.current !== 'function' || typeof model.select !== 'function') return

    let selection
    try {
      selection = model.current()
    } catch {
      return
    }
    const key = routeKey(selection)
    if (key === undefined) return

    // A cold cache would make the step's effort guess unsafe: warm it, skip this
    // step, and adjust from the next question onward.
    if (!capabilities.has(key)) {
      void warm(selection)
      return
    }
    const available = capabilities.get(key)
    const score = classifyText(text, { hard: settings.extraHardTerms, easy: settings.extraEasyTerms })
    const tier = tierForScore(score, settings.thresholds)
    const effort = effortForTier(tier, available, settings.efforts, settings.fallback)
    if (effort === undefined || selection.reasoningEffort === effort) return

    try {
      model.select({ provider: selection.provider, model: selection.model, reasoningEffort: effort })
      logger?.debug?.(
        `auto-reasoning: turn ${String(payload.turn)} score ${String(score)} → ${tier} effort "${effort}" (${selection.provider}/${selection.model})`,
      )
    } catch (error) {
      logger?.warn?.(`auto-reasoning: could not record reasoning effort: ${String(error)}`)
    }
  }

  ctx.on('agent/inbox/claimed', onClaimed)

  // Warm the routes that already exist when this plugin loads, so the very next
  // question — including in a Session that was open before installation — can be
  // adjusted instead of waiting one question for the cache.
  function warmLiveRoutes() {
    try {
      const agents = service('agents')
      for (const agent of agents?.list?.() ?? []) {
        const selection = agent?.model?.current?.()
        if (selection !== undefined && selection !== null) void warm(selection)
      }
    } catch {
      // Optional service; an ordinary Host always provides it.
    }
    try {
      const selection = service('agentDefaultModel')?.currentSelection?.()
      if (selection !== undefined && selection !== null) void warm(selection)
    } catch {
      // Optional service; a Host without a configured default simply has no route to warm.
    }
  }
  warmLiveRoutes()

  // Warm the capability of the route an agent starts on, so the first question
  // can already be adjusted. Creation is serial, so the lookup stays detached.
  ctx.on('agent/created', (payload) => {
    try {
      const selection = payload?.agent?.model?.current?.()
      if (selection !== undefined && selection !== null) void warm(selection)
    } catch {
      // A driver without the model surface is simply out of scope.
    }
  })

  // Provider routes or advertised models changed: every cached answer is stale.
  ctx.on('llm/models-updated', () => capabilities.clear())
  ctx.on('llm/adapters-updated', () => capabilities.clear())

  // One local route backs the picker's per-session Auto state; a second one
  // records whether the browser half could decorate the shipped picker.
  // The web server may activate after this row on a cold start (it owns the
  // HTTP listener), so wait for the service instead of probing once: a probe
  // that runs too early silently leaves the picker without a state channel.
  // Headless or SDK hosts without a web server simply never run this.
  ctx.inject(['webServer'], (scope) => {
    const web = scope.webServer
    if (web === undefined || web === null || typeof web.register !== 'function') return
    const routes = [
      {
        path: TOGGLE_PATH,
        label: 'auto-reasoning: toggle route',
        handler: createToggleHandler({
          state: autoState,
          defaultAuto: settings.defaultAuto,
          getOrigin: () => web.getOrigin(),
          logger,
        }),
      },
      {
        path: CLIENT_STATUS_PATH,
        label: 'auto-reasoning: client status route',
        handler: createClientStatusHandler({
          status: clientStatus,
          getOrigin: () => web.getOrigin(),
          logger,
        }),
      },
      {
        path: SETTINGS_PATH,
        label: 'auto-reasoning: settings route',
        handler: createSettingsHandler({
          settings,
          getEfforts: currentEfforts,
          persist: saveStoredMode,
          getOrigin: () => web.getOrigin(),
          logger,
        }),
      },
    ]
    for (const route of routes) {
      try {
        scope.effect(
          () => web.register({ kind: 'exact', path: route.path, handler: route.handler }),
          route.label,
        )
      } catch (error) {
        logger?.warn?.(`auto-reasoning: could not register ${route.path}: ${String(error)}`)
      }
    }
  })

  ctx.effect(() => () => {
    disposed = true
    capabilities.clear()
    warming.clear()
    autoState.clear()
  })
}
