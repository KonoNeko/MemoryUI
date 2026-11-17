const EVENTS = ['sessionStart', 'userPromptSubmit', 'stop'];
const lifecycleStates = state => Object.fromEntries(EVENTS.map(event => [event, state]));

export function codexLifecycleHookStates(result) {
  const hooks = Array.isArray(result?.data) ? result.data.flatMap(entry => Array.isArray(entry?.hooks) ? entry.hooks : []) : [];
  return Object.fromEntries(EVENTS.map(event => {
    const matches = hooks.filter(hook => hook?.pluginId === 'memoryui@memoryui-local' && hook.eventName === event);
    let state = 'unavailable';
    if (matches.length) {
      if (matches.some(hook => hook.enabled === true && hook.trustStatus !== 'trusted')) state = 'needs_trust';
      else if (matches.some(hook => hook.enabled !== true)) state = 'disabled';
      else state = 'trusted';
    }
    return [event, state];
  }));
}

export function codexHookState(result) {
  return codexLifecycleHookStates(result).userPromptSubmit;
}

// Read-only host capability metadata. A local enqueue is never proof of trust.
// read() deliberately never waits for the host process or exposes hook details.
export function createCodexHookStatus({ transport, cwd, enabled = false, clock = () => Date.now(), ttlMs = 30000 }) {
  let states = lifecycleStates('not_checked'), checkedAt = null, pending = null, closed = false;
  function refresh() {
    if (!enabled || closed || pending || (checkedAt !== null && clock() - checkedAt < ttlMs)) return pending;
    pending = Promise.resolve().then(() => transport.request('hooks/list', { cwds: [cwd] }))
      .then(result => { if (!closed) states = codexLifecycleHookStates(result); }, () => { if (!closed) states = lifecycleStates('unavailable'); })
      .finally(() => { checkedAt = clock(); pending = null; });
    return pending;
  }
  return {
    read() { refresh(); return { hookState: states.userPromptSubmit, hookStates: { ...states } }; },
    refresh,
    close() { closed = true; },
  };
}
