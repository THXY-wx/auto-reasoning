/**
 * Browser half of the auto-reasoning bundle.
 *
 * Two jobs:
 *
 * 1. An `Auto` entry in the shipped model picker's reasoning-effort list, below
 *    the model's own levels. The picker builds those rows from the per-session
 *    model directory (`ctx.modelDirectories`), so this plugin decorates that
 *    directory: it injects the extra level, reports `auto` as the selected
 *    effort while the switch is on, and intercepts choosing it so no `auto`
 *    value ever reaches `prepareCall`. The label carries the level Auto is
 *    currently using, e.g. `Auto (High)`.
 *
 * 2. One preference row in Settings → General for the default mode used when
 *    the question's difficulty cannot be determined. The value lives in the
 *    plugin's own settings file through the Host route, so changing it does
 *    not restart the plugin.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-auto-reasoning',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'auto-reasoning'
    const ENDPOINT = '/auto-reasoning/state'
    const CLIENT_ENDPOINT = '/auto-reasoning/client'
    const SETTINGS_ENDPOINT = '/auto-reasoning/settings'
    const AUTO_ID = 'auto'
    /** The synthetic row's fallback label; the snapshot usually supplies `Auto (Level)`. */
    const AUTO_EFFORT = Object.freeze({ id: AUTO_ID, name: 'Auto' })
    /** One stable wrapper per directory instance. */
    const wrappers = new WeakMap()

    function stateUrl(sessionId) {
      return `${ENDPOINT}?sessionId=${encodeURIComponent(String(sessionId))}`
    }

    function readJson(response) {
      if (!response.ok) return Promise.reject(new Error(`HTTP ${response.status}`))
      return response.json()
    }

    function postAuto(sessionId, auto) {
      if (typeof fetch !== 'function') return Promise.resolve()
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId, auto }),
      }).then(readJson)
    }

    /**
     * Add the synthetic `Auto` row after the model's own efforts.
     *
     * @param {object | undefined} model - one model catalog entry.
     * @param {string} [label] - row text, e.g. `Auto (High)`.
     * @returns {object} the same entry when it has no reasoning levels, else a copy carrying Auto last.
     */
    function withAutoEffort(model, label) {
      const reasoning = model?.reasoning
      if (reasoning === null || typeof reasoning !== 'object') return model
      if (!Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) return model
      if (reasoning.efforts.some((level) => level?.id === AUTO_ID)) return model
      const name = typeof label === 'string' && label.length > 0 ? label : 'Auto'
      return { ...model, reasoning: { ...reasoning, efforts: [...reasoning.efforts, { id: AUTO_ID, name }] } }
    }

    function modelOf(groups, provider, model) {
      for (const group of groups) {
        if (group?.id !== provider) continue
        return group.models?.find((candidate) => candidate?.id === model)
      }
      return undefined
    }

    /**
     * Decorate one directory snapshot: inject `Auto` into every reasoning model
     * (labelled with the level it is currently using), and while Auto is on
     * report it as the selected effort.
     *
     * @param {object | undefined} snapshot - the directory's current snapshot.
     * @param {boolean | undefined} auto - the session switch; `undefined` while loading.
     * @returns {object} the original snapshot when nothing changed, else a decorated copy.
     */
    function decorateSnapshot(snapshot, auto) {
      if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.groups)) return snapshot
      const baseCurrent = snapshot.current
      let changed = false
      const groups = snapshot.groups.map((group) => {
        if (group === null || typeof group !== 'object' || !Array.isArray(group.models)) return group
        let modelsChanged = false
        const models = group.models.map((model) => {
          let label = 'Auto'
          const reasoning = model?.reasoning
          if (auto === true && reasoning !== null && typeof reasoning === 'object' && Array.isArray(reasoning.efforts)) {
            const isCurrent =
              baseCurrent !== null && baseCurrent !== undefined && baseCurrent.provider === group.id && baseCurrent.model === model.id
            const levelId = (isCurrent ? baseCurrent.reasoningEffort : undefined) ?? reasoning.defaultEffort
            const level = levelId === undefined ? undefined : reasoning.efforts.find((effort) => effort?.id === levelId)
            if (level !== undefined && typeof level.name === 'string' && level.name.length > 0) label = `Auto (${level.name})`
          }
          const next = withAutoEffort(model, label)
          if (next !== model) modelsChanged = true
          return next
        })
        if (!modelsChanged) return group
        changed = true
        return { ...group, models }
      })
      let current = baseCurrent
      if (auto === true && current !== null && current !== undefined) {
        const selected = modelOf(groups, current.provider, current.model)
        if (selected?.reasoning !== undefined) {
          current = { ...current, reasoningEffort: AUTO_ID }
          changed = true
        }
      }
      return changed ? { ...snapshot, groups, current } : snapshot
    }

    /**
     * Wrap one session directory so the shipped picker sees Auto.
     *
     * @param {object} directory - the original `ModelDirectory`.
     * @param {string} sessionId - owning Session id.
     * @returns {object} a stable wrapper exposing `store`, `select`, and `load`.
     */
    function wrapDirectory(directory, sessionId) {
      if (directory === null || typeof directory !== 'object') return directory
      const existing = wrappers.get(directory)
      if (existing !== undefined) return existing
      const store = directory.store
      if (store === null || typeof store !== 'object' || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') {
        return directory
      }
      if (typeof directory.select !== 'function') return directory

      const listeners = new Set()
      let auto
      let sequence = 0
      let baseCache
      let autoCache = Symbol('unset')
      let valueCache
      let disposed = false

      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // A subscriber's failure must not stop the others.
          }
        }
      }

      const snapshot = () => {
        const base = store.getSnapshot()
        if (base === baseCache && auto === autoCache) return valueCache
        baseCache = base
        autoCache = auto
        valueCache = decorateSnapshot(base, auto)
        return valueCache
      }

      const setAuto = (value) => {
        if (auto === value) return
        const previous = auto
        auto = value
        const token = ++sequence
        notify()
        postAuto(sessionId, value).catch(() => {
          if (disposed || sequence !== token || auto !== value) return
          auto = previous
          notify()
        })
      }

      const unsubscribeStore = store.subscribe(notify)

      if (typeof fetch === 'function') {
        fetch(stateUrl(sessionId), { headers: { accept: 'application/json' } })
          .then(readJson)
          .then((value) => {
            if (disposed || auto !== undefined) return
            auto = value?.auto !== false
            notify()
          })
          .catch(() => {
            if (disposed || auto !== undefined) return
            auto = false
            notify()
          })
      }

      /** Select one model/effort; `auto` stays a client-side mode, never a stored effort. */
      function select(selection) {
        const base = store.getSnapshot()
        const current = base?.current ?? null
        const switchingModel =
          current !== null &&
          current !== undefined &&
          (current.provider !== selection.provider || current.model !== selection.model)
        const wantsAuto = selection.reasoningEffort === AUTO_ID || (switchingModel && auto === true)
        if (wantsAuto) {
          setAuto(true)
          return directory.select({ provider: selection.provider, model: selection.model })
        }
        setAuto(false)
        return directory.select(selection)
      }

      const decoratedStore = {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: snapshot,
      }

      const wrapper = {
        store: decoratedStore,
        subscribe: decoratedStore.subscribe,
        getSnapshot: snapshot,
        select,
        load: typeof directory.load === 'function' ? () => directory.load() : () => Promise.resolve(),
      }
      wrappers.set(directory, wrapper)
      return wrapper
    }

    /**
     * Patch the model-directory service so every directory the picker resolves
     * is decorated. The class prototype is preferred so every scoped reference
     * sees the same behavior; an own method is patched in place instead.
     *
     * @param {object} resolver - the `modelDirectories` service.
     * @returns {(() => void) | undefined} restoration, or undefined when patching was impossible.
     */
    function installDirectoryPatch(resolver) {
      if (resolver === null || typeof resolver !== 'object' || typeof resolver.directoryFor !== 'function') return undefined
      const own = Object.hasOwn(resolver, 'directoryFor') ? resolver.directoryFor : undefined
      const proto = Object.getPrototypeOf(resolver)
      const inherited = own === undefined && proto !== null && typeof proto.directoryFor === 'function' ? proto.directoryFor : undefined
      const base = own ?? inherited
      if (typeof base !== 'function') return undefined

      const patched = function (sessionId) {
        return wrapDirectory(base.call(this, sessionId), String(sessionId))
      }

      let target
      if (own !== undefined) {
        try {
          resolver.directoryFor = patched
          if (resolver.directoryFor === patched) target = resolver
        } catch {
          target = undefined
        }
      } else {
        try {
          proto.directoryFor = patched
          if (proto.directoryFor === patched) target = proto
        } catch {
          target = undefined
        }
      }
      if (target === undefined) return undefined

      return () => {
        try {
          if (target.directoryFor === patched) target.directoryFor = base
        } catch {
          // Restoring a frozen prototype is impossible; leaving the wrapper in
          // place is harmless because it delegates to the same directory.
        }
      }
    }

    /** Tell the Host whether the picker decoration could be installed. */
    function reportClient(patched) {
      if (typeof fetch !== 'function') return
      fetch(CLIENT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ patched }),
      }).catch(() => {})
    }

    // -----------------------------------------------------------------------
    // Settings → General row
    // -----------------------------------------------------------------------

    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      padding: '12px 0',
    }
    const TITLE_STYLE = { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' }
    const HINT_STYLE = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', marginTop: 2 }
    const SELECT_STYLE = {
      height: 28,
      minWidth: 160,
      padding: '0 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      cursor: 'pointer',
    }

    function registerDictionaries(ctx) {
      const locale = ctx.get('locale')
      if (locale === undefined || locale === null) return
      const dictionaries = {
        en: {
          settingsTitle: 'Default reasoning mode',
          settingsHint: 'Effort used for ordinary difficulty, including questions it cannot judge.',
          settingsAuto: 'Automatic (model ladder)',
          settingsError: 'Could not read this setting.',
        },
        zh: {
          settingsTitle: '默认推理模式',
          settingsHint: '普通难度（包括无法判断）时使用的推理等级。',
          settingsAuto: '自动（按模型阶梯）',
          settingsError: '读取设置失败。',
        },
      }
      for (const [tag, dictionary] of Object.entries(dictionaries)) {
        try {
          ctx.effect(() => locale.register(NS, tag, dictionary), `auto-reasoning: ${tag} dictionary`)
        } catch {
          // Another plugin owns the namespace; labels fall back to keys.
        }
      }
    }

    function registerSettingsRow(ctx) {
      const slots = ctx.get('slots')
      const locale = ctx.get('locale')
      if (slots === undefined || slots === null || locale === undefined || locale === null) return
      const t = locale.bind(NS)
      const subscribeLocale = (callback) => locale.subscribe(callback)
      const getLocaleRevision = () => locale.getSnapshot().revision

      function SettingsRow() {
        React.useSyncExternalStore(subscribeLocale, getLocaleRevision)
        const [state, setState] = React.useState({ status: 'loading', mode: '', efforts: [] })

        React.useEffect(() => {
          let cancelled = false
          if (typeof fetch !== 'function') {
            setState({ status: 'error', mode: '', efforts: [] })
            return undefined
          }
          fetch(SETTINGS_ENDPOINT, { headers: { accept: 'application/json' } })
            .then(readJson)
            .then((value) => {
              if (cancelled) return
              setState({
                status: 'ready',
                mode: typeof value?.defaultMode === 'string' ? value.defaultMode : '',
                efforts: Array.isArray(value?.efforts) ? value.efforts : [],
              })
            })
            .catch(() => {
              if (!cancelled) setState({ status: 'error', mode: '', efforts: [] })
            })
          return () => {
            cancelled = true
          }
        }, [])

        const change = (event) => {
          const next = event.target.value
          const previous = state.mode
          setState((current) => ({ ...current, mode: next, status: 'ready' }))
          fetch(SETTINGS_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ defaultMode: next }),
          })
            .then(readJson)
            .then((value) => {
              setState((current) => ({
                ...current,
                status: 'ready',
                mode: typeof value?.defaultMode === 'string' ? value.defaultMode : next,
              }))
            })
            .catch(() => {
              setState((current) => ({ ...current, mode: previous, status: 'error' }))
            })
        }

        const efforts = state.efforts
        const known = state.mode === '' || efforts.some((effort) => effort?.id === state.mode)
        const options = known ? efforts : [{ id: state.mode, name: state.mode }, ...efforts]

        return h(
          'div',
          { style: ROW_STYLE },
          h(
            'div',
            { style: { minWidth: 0, flex: '1 1 auto' } },
            h('div', { style: TITLE_STYLE }, t('settingsTitle')),
            h('div', { style: HINT_STYLE }, state.status === 'error' ? t('settingsError') : t('settingsHint')),
          ),
          h(
            'select',
            {
              style: SELECT_STYLE,
              value: state.mode,
              disabled: state.status !== 'ready',
              'aria-label': t('settingsTitle'),
              onChange: change,
            },
            h('option', { value: '' }, t('settingsAuto')),
            options.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name)),
          ),
        )
      }

      slots.inject('settings.general.item', () =>
        slots.register({ name: 'settings.general.item', id: 'auto-reasoning', order: 40 }, SettingsRow),
      )
    }

    // -----------------------------------------------------------------------
    // Plugin
    // -----------------------------------------------------------------------

    function installPicker(ctx) {
      const resolver = ctx.get('modelDirectories')
      if (resolver !== undefined && resolver !== null) {
        const restore = installDirectoryPatch(resolver)
        reportClient(restore !== undefined)
        if (restore !== undefined) ctx.effect(() => restore, 'auto-reasoning: model directory decoration')
        return
      }
      // A composition that mounts the picker after this plugin: wait for the
      // service, then decorate it. `dsh.client.inject` normally orders the two
      // packages, so this is the fallback path.
      ctx.inject(['modelDirectories'], (scope) => {
        const late = installDirectoryPatch(scope.modelDirectories)
        reportClient(late !== undefined)
        if (late !== undefined) ctx.effect(() => late, 'auto-reasoning: model directory decoration')
      })
    }

    function apply(ctx) {
      registerDictionaries(ctx)
      installPicker(ctx)
      registerSettingsRow(ctx)
    }

    return {
      apply,
      // Exposed for the package's own logic tests; the client loader ignores it.
      __test: { AUTO_EFFORT, decorateSnapshot, installDirectoryPatch, withAutoEffort, wrapDirectory },
    }
  },
})
