// Wake adapter registry for the Senti Wake-Up & Notification Bus (L2).
//
// Decouples the `sentid` daemon from individual host adapters: the daemon
// depends only on the LOCKED adapter interface --
//   { hostName: string, wake(target[, deps]) -> Promise<{ok, hostName, ...}> }
//   (optionally installWakeHook(opts))
// -- and concrete adapters (wake/claude.js, wake/codex.js, ...) are registered
// at wiring time. This means the daemon can be built and unit-tested against a
// fake adapter with no dependency on which adapter PRs have merged.

function assertValidAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("wake registry: adapter must be an object");
  }
  if (typeof adapter.hostName !== "string" || adapter.hostName.trim() === "") {
    throw new TypeError("wake registry: adapter.hostName must be a non-empty string");
  }
  if (typeof adapter.wake !== "function") {
    throw new TypeError(`wake registry: adapter "${adapter.hostName}" must expose a wake() function`);
  }
  return adapter;
}

/**
 * Create a wake-adapter registry, optionally seeded with adapters.
 *
 * @param {Array<{hostName: string, wake: Function}>} [adapters]
 */
export function createWakeRegistry(adapters = []) {
  const map = new Map();

  function hosts() {
    return [...map.keys()];
  }

  function register(adapter) {
    assertValidAdapter(adapter);
    if (map.has(adapter.hostName)) {
      throw new Error(`wake registry: adapter for host "${adapter.hostName}" is already registered`);
    }
    map.set(adapter.hostName, adapter);
    return adapter;
  }

  function resolve(hostName) {
    const adapter = map.get(hostName);
    if (!adapter) {
      throw new Error(
        `wake registry: no adapter registered for host "${hostName}" (known: ${hosts().join(", ") || "none"})`
      );
    }
    return adapter;
  }

  function has(hostName) {
    return map.has(hostName);
  }

  if (!Array.isArray(adapters)) {
    throw new TypeError("wake registry: adapters must be an array");
  }
  adapters.forEach(register);

  return { register, resolve, has, hosts };
}

/**
 * Wake an agent through the registry in one call. Forwards `deps` (e.g. an
 * injected execFileImpl) to the resolved adapter's wake().
 *
 * @param {{resolve: Function}} registry
 * @param {{ host: string, sessionId: string, message: string }} target
 * @param {object} [deps]
 */
export async function wakeVia(registry, { host, sessionId, message } = {}, deps = {}) {
  const adapter = registry.resolve(host);
  return adapter.wake({ sessionId, message }, deps);
}

export default createWakeRegistry;
