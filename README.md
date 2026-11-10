# Auto reasoning effort

Matches each model step's reasoning effort to the difficulty of the question
that starts it. Greetings, lookups and translations run cheap; debugging,
design and multi-part analysis questions run deep. The reasoning-effort list
gains an **Auto** entry below the model's own levels (`off / low / high / max /
Auto`), and Auto is the default mode.

## How it works

The agent loop captures a step's provider / model / reasoning effort just
before that step is prepared, and only `agent.model.select()` can change it
before the capture. The plugin therefore listens for `agent/inbox/claimed`,
whose dispatch is synchronous and happens immediately before that capture, and
records a new effort for the step that is starting.

- **Classification is local and free.** A deterministic heuristic scores the
  user's text. No extra model call, no added latency and no extra tokens.
- **Two vocabulary tiers.** Strong signals (为什么 / 设计 / 架构 / debug /
  trade-off …) score two points each, capped at four. Weak domain signals
  (代码 / 接口 / 报错 / 死锁 / 内存 / 性能 / troubleshoot / reproduce …) score
  one each, capped at three, so ordinary technical wording lifts a short
  debugging question without saturating the band.
- **Structure counts too.** Length, code fences, numbered or bulleted steps,
  several question marks, and technical artifacts (a call, a filename, a stack
  frame, a path, a 4xx/5xx code) add independent evidence.
- **Only real questions count.** Runtime-context snapshots, model-switch
  notices, tool results and other injected messages never change the effort.
- **Only supported efforts are recorded.** The plugin asks `llm` which effort
  ids the current model advertises and caches the answer per route. A model
  with no reasoning support is left untouched, and an unsupported configured id
  falls back to the model's own ladder (cheapest / upper middle / strongest).
- **The change is session-local.** It writes a `model/selection` event, so the
  next step uses the new effort while the deployment default model stays as the
  user set it. The Web model picker reflects the current effort.
- **Subagents are out of scope by default**, so an explicitly pinned
  delegation effort is never rewritten.

The effort stays put across tool-continuation steps of the same turn, because
those steps claim no new user message.

## The Auto option

The shipped picker builds its effort rows from the per-session model directory
(`ctx.modelDirectories`), and the row order is the model's own levels followed
by any extra level the directory supplies. This bundle decorates that
directory:

- every model with reasoning gains one extra level, rendered **below**
  `off / low / high / max`;
- while Auto is on, the row and the trigger caption read `Auto (High)`,
  `Auto (Low)`, … — the parenthetical is the concrete level Auto is currently
  using, and it follows each question's result;
- while Auto is on, the directory snapshot reports `reasoningEffort: 'auto'`,
  so the row is checked and the trigger keeps Auto selected;
- choosing Auto does **not** write `auto` into the Session. It turns the Host's
  per-session switch on and submits the route without an explicit effort, so
  the stored selection is always a value `prepareCall` accepts. The Host half
  then picks the concrete effort for each question;
- choosing any concrete level (`off / low / high / max`) turns Auto off and
  keeps that level.

This avoids the trap of a sentinel effort: an `auto` value sitting in the
session selection would eventually reach `prepareCall` (for example on a step
without a new user message) and fail with `UNSUPPORTED_REASONING_EFFORT`.

## Default mode (Settings → General)

The plugin adds one preference row under **Settings → General → Default
reasoning mode**. It chooses the level used for ordinary difficulty — the
`normal` band, which includes questions the classifier cannot place.

- The row lists the **default model's** advertised effort levels (on the
  DeepSeek account route: off / low / high / max), plus
  **Automatic (model ladder)**.
- Changing it writes `auto-reasoning.settings.json` and takes effect in the
  running plugin immediately: no restart and no profile patch edit. The Host
  writes the profile directory when it exposes one, otherwise it keeps the file
  beside the package (the local link's checkout); `DSH_AUTO_REASONING_SETTINGS`
  names an explicit path.
- The persisted choice overrides the row config's `efforts.normal`; deleting the
  file returns control to the config.
- The row is served by `GET/POST /auto-reasoning/settings` (same-origin, JSON
  writes), which also returns the available levels for the select.

the switch is per session and lives in Host memory: after a Host restart every
session returns to `defaultAuto`. It is served over the bundle's own local route
(`GET/POST /auto-reasoning/state`); same-origin requests only, and writes must
be `application/json`. The route is registered only when a `webServer` is
present, so headless hosts simply keep the default behavior.

The state routes are registered through the injected `webServer` service, not a
one-shot lookup. On a cold start the web server may still be activating when
this row mounts; waiting for the service is what keeps the picker's state
channel available after a restart.

The browser half reports whether it could decorate the picker at
`GET /auto-reasoning/client` (`{ patched: true }` once the page has loaded).
`patched: false` means the row cannot appear on this Harness build and the
plugin keeps its default behavior.

If the directory service is unavailable (a different Harness build), the
decoration is skipped and the plugin keeps its default behavior without a
picker row.

## Configuration

`cordis.patch.yml` in this package inserts one row. Edit that row (or override
it from the profile patch layer) to tune it:

```yaml
- insert:
    - id: auto-reasoning-effort
      name: '@local/dsh-auto-reasoning'
      config:
        enabled: true
        defaultAuto: true     # every session starts with Auto on
        scope: root           # root: top-level sessions only; all: subagents too
        efforts:
          easy: low           # optional; omit a tier to use its ladder position
          normal: high
          hard: max
        fallback: ladder      # ladder: use the model's own order; skip: leave it alone
        thresholds:
          easyMax: -1         # score <= easyMax is easy
          hardMin: 4          # score >= hardMin is hard
        extraHardTerms: []    # substrings worth two points each (case-insensitive)
        extraEasyTerms: []    # substrings worth minus two points each
```

`efforts` values are provider-owned ids. On the `deepseek-account` route every
model offers `off`, `low`, `high`, and `max`, so the shipped row pins the three
useful ones. A tier left empty follows the model's own ladder — easy takes the
cheapest level, hard the strongest, and normal the upper middle — so the plugin
keeps working on providers whose ids differ. `fallback: ladder` applies the
same positional choice when a pinned id is not advertised by the current model;
`fallback: skip` leaves the effort alone in that case.

`extraHardTerms` / `extraEasyTerms` extend the built-in vocabulary without
editing code; each entry is a plain substring. They join the same caps as the
built-in lists.

## Behavior notes

- The first question on a route the plugin has not seen yet is left unchanged
  while it learns the route's capability; later questions are adjusted. Routes
  of Sessions already open at activation, and of every newly created Agent, are
  warmed off the critical path, so in practice the very next question is
  adjusted.
- A cold start, a model switch, or an edited provider catalog clears the
  capability cache (it is refilled on the next `agent/created` or first
  question).
- When classification already matches the current effort, nothing is written.
- The heuristic is intentionally simple and tuned for Chinese and English. Use
  `thresholds` and the extra-term lists to make it fit one domain.

## Verification

`node test.mjs` runs the classifier (easy/normal/hard, weak vocabulary,
artifacts, custom terms), config normalization, capability fallback, the
toggle route (read/write, cross-origin, non-JSON, malformed), the client
directory decoration (Auto last, `Auto (Level)` label, checked only while on,
never stored as an effort), the client-status route, the settings route (read,
validate, persist, failure), and the runtime listener against a fake Host
surface: 27 checks.

After installation the live page reported `{"patched":true}`, so the shipped
picker's directory was decorated; the row itself is rendered by that picker, so
its on-screen placement still needs the connected Web page to be checked by eye.
