/**
 * mdc.ts: tiny, zero-dependency helpers for a Mapped Diagnostic Context.
 *
 * A context is a plain object. Values are addressed by dot-path ("user.id"),
 * so callers can enrich nested structure without pulling in object-path or
 * merge-deep the way the 2021 original did.
 *
 * Two properties matter more here than any feature, because this is a
 * dependency in every request path of its host: it must not endanger the host,
 * and it must not crash it. Both rest on one invariant, stated once and enforced
 * in one place:
 *
 *   EVERY object and array reachable from a context was created here.
 *   Nothing in a context is the same object as anything a caller holds.
 *
 * That single sentence is what makes scopes isolated (no two stores can share a
 * node), what makes an emitted record a real snapshot (a later mutation has
 * nothing to reach), and what makes a dot-path walk safe (it can only ever step
 * into objects this file built, so it can never arrive at a prototype). A
 * denylist of dangerous key names is the weaker version of the same idea: it
 * enumerates the ways in, and the list is only ever as complete as the last
 * person to think about it.
 *
 * Values that are NOT plain objects or arrays (an Error, a Date, a class
 * instance, a socket) are kept by reference, because dropping them would make
 * the library useless for the thing people actually log. They are also never
 * traversed, so they cannot be a way back out.
 */

/** A context object: arbitrary structured data attached to logs. */
export type Bindings = Record<string, unknown>;

/**
 * The one key name that is refused.
 *
 * `__proto__` is refused because it is not an ordinary property: assigning it
 * reassigns the target's prototype instead of storing a value, and `JSON.parse`
 * produces it as an OWN property, so a queue payload or a webhook body is
 * enough. `constructor` and `prototype` are NOT refused, though an earlier draft
 * of this file refused all three: on a plain object built here they are ordinary
 * shadowing assignments that endanger nothing, the walk cannot leave the store
 * whatever they are called, and refusing them silently deleted legitimate data
 * (a construction-industry payload has a `constructor` field) to prevent
 * nothing.
 */
const FORBIDDEN_KEY = "__proto__";

export function isForbiddenKey(key: string): boolean {
  return key === FORBIDDEN_KEY;
}

/**
 * How deep a copy descends before it substitutes a marker.
 *
 * This is a guard against pathological input, not a design ceiling: it exists so
 * a linked list a hundred thousand nodes long cannot overflow the stack inside a
 * log call. It is deliberately far above any real context, because a bound that
 * fires in ordinary use is a bound that silently changes behavior in ordinary
 * use.
 *
 * An earlier version of this file set it to 8 and, at the bound, kept the value
 * BY REFERENCE. Sharing is the one thing a copy may never do: it put the same
 * object in the parent scope, every child scope, the process defaults and the
 * caller's own variable at once.
 */
export const CLONE_DEPTH_LIMIT = 32;

/**
 * How many objects one copy may create before it substitutes a marker.
 *
 * Depth was never the thing worth bounding. What starves an event loop is total
 * work, and total work is a function of the whole shape: an object graph that is
 * only nine nodes wide can still cost more than a machine has if every node is
 * reachable by many routes, or if reading a property produces a fresh object
 * each time and defeats the memo. This bounds the work directly.
 */
export const CLONE_NODE_LIMIT = 10_000;

/** Substituted for a value the copy refused to descend into. */
export const TRUNCATED = "[spawntrail: truncated]";

/** Substituted for a value that could not be read without throwing. */
export const UNREADABLE = "[spawntrail: unreadable]";

export type ViolationReason = "forbidden-key" | "truncated" | "unreadable" | "invalid-path";

/**
 * Notified when an operation is refused or a value is substituted.
 *
 * The handler fires on EVERY occurrence, because a hook that reports once is of
 * no use to a counter or a test. The built-in warning is the part that fires
 * once, so a loop over attacker-controlled keys cannot turn a refusal into a log
 * flood.
 */
export type ViolationHandler = (event: { reason: ViolationReason; key?: string; path?: string }) => void;

let onViolation: ViolationHandler | undefined;
let warned = false;

/** Observe refused operations, for a dev-mode warning, a metric or a test. */
export function setViolationHandler(handler: ViolationHandler | undefined): void {
  onViolation = handler;
}

/** Re-arm the one-time built-in warning. Exists for tests. */
export function resetViolationWarning(): void {
  warned = false;
}

function refuse(reason: ViolationReason, key?: string, path?: string): void {
  if (onViolation) {
    onViolation({ reason, key, path });
    return;
  }
  if (warned || process.env.NODE_ENV === "production") return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    `spawntrail: ${reason}${key ? ` (${JSON.stringify(key)})` : ""}${path ? ` in path ${JSON.stringify(path)}` : ""}. ` +
      "Pass a handler to setViolationHandler() to observe these; further notices are silent.",
  );
}

/**
 * The set of containers this file created.
 *
 * A dot-path walk descends only into members of this set, which is what turns
 * "the walk cannot reach a prototype" from a claim about key names into a
 * property of the objects themselves. A `WeakSet` cannot be forged, and a Proxy
 * wrapping one of our objects is a different identity, so it is not in the set.
 */
const OWNED = new WeakSet<object>();

function own<T extends object>(v: T): T {
  OWNED.add(v);
  return v;
}

/** A fresh, empty context that the path helpers are allowed to descend into. */
export function emptyBindings(): Bindings {
  return own({});
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  let proto: unknown;
  try {
    proto = Object.getPrototypeOf(v) as unknown;
  } catch {
    return false;
  }
  return proto === Object.prototype || proto === null;
}

/**
 * Whether a dot-path walk may step into this value.
 *
 * Anything built here is safe by construction. A foreign plain object can only
 * appear when the exported path helpers are used directly on a caller's own
 * object, never inside a context, and there the best available answer is to
 * refuse the shapes that are somebody's prototype: `Object.prototype` passes an
 * ordinary plain-object guard, because its own prototype is null.
 */
function canDescend(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  if (OWNED.has(v)) return true;
  if (!isPlainObject(v)) return false;
  return !isPrototypeObject(v);
}

function isPrototypeObject(v: object): boolean {
  if (v === Object.prototype) return true;
  try {
    // Every `X.prototype` carries its own `constructor`; a data object does not.
    return Object.prototype.hasOwnProperty.call(v, "constructor");
  } catch {
    return true;
  }
}

function toKeys(path: unknown): string[] | undefined {
  if (typeof path !== "string") {
    refuse("invalid-path");
    return undefined;
  }
  return path.split(".");
}

function hasOwn(obj: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(obj, key);
  } catch {
    return false;
  }
}

/** Read one own property without letting an accessor take down the caller. */
function readOwn(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    refuse("unreadable", key);
    return UNREADABLE;
  }
}

function ownKeys(v: object): string[] {
  try {
    return Object.keys(v);
  } catch {
    refuse("unreadable");
    return [];
  }
}

/** Read a dot-path from a context, or `undefined` if any segment is missing. */
export function getPath(obj: Bindings, path: string): unknown {
  const keys = toKeys(path);
  if (keys === undefined) return undefined;

  let cur: unknown = obj;
  for (const key of keys) {
    if (isForbiddenKey(key)) {
      refuse("forbidden-key", key, path);
      return undefined;
    }
    if (!canDescend(cur)) return undefined;
    if (!hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Set a dot-path in a context, creating intermediate objects. Mutates `obj`.
 *
 * A path containing a forbidden segment is refused whole rather than truncated:
 * writing the safe prefix of a path the caller did not mean would leave a
 * half-applied context, which is harder to reason about than nothing happening.
 *
 * This does NOT copy `value`. It is the low-level helper; `SpawnTrail.put()` is
 * the store entry point and copies there, so the invariant at the top of this
 * file is enforced once, at the one place caller data enters a context.
 */
export function setPath(obj: Bindings, path: string, value: unknown): void {
  const keys = toKeys(path);
  if (keys === undefined) return;
  const last = keys.pop();
  if (last === undefined) return;

  for (const key of [...keys, last]) {
    if (isForbiddenKey(key)) {
      refuse("forbidden-key", key, path);
      return;
    }
  }

  let cur: Record<string, unknown> = obj;
  for (const key of keys) {
    const next = hasOwn(cur, key) ? cur[key] : undefined;
    if (canDescend(next)) {
      cur = next;
    } else {
      const created = emptyBindings();
      if (!assign(cur, key, created)) return;
      cur = created;
    }
  }
  assign(cur, last, value);
}

/** Assign without letting a frozen or accessor-only target throw out of a log call. */
function assign(target: Record<string, unknown>, key: string, value: unknown): boolean {
  try {
    target[key] = value;
    return true;
  } catch {
    refuse("unreadable", key);
    return false;
  }
}

/** Delete a dot-path from a context. Mutates `obj`. */
export function delPath(obj: Bindings, path: string): void {
  const keys = toKeys(path);
  if (keys === undefined) return;
  const last = keys.pop();
  if (last === undefined) return;

  for (const key of [...keys, last]) {
    if (isForbiddenKey(key)) {
      refuse("forbidden-key", key, path);
      return;
    }
  }

  let cur: unknown = obj;
  for (const key of keys) {
    if (!canDescend(cur)) return;
    // Own-property gated like the other two walks. Without this, a delete on a
    // missing key followed an inherited property and deleted somewhere else.
    if (!hasOwn(cur, key)) return;
    cur = cur[key];
  }
  if (!canDescend(cur)) return;
  try {
    delete cur[last];
  } catch {
    refuse("unreadable", last, path);
  }
}

interface CopyBudget {
  nodes: number;
}

/**
 * Structural copy: plain objects and arrays are rebuilt here, everything else is
 * kept by reference.
 *
 * Cycle-safe and sharing-safe through one memo, which is what makes the cost
 * linear in the number of distinct nodes rather than exponential in the number
 * of routes to them. The values people reach for while debugging are exactly the
 * ones with both properties: an axios error, an Express `req`, a mongoose
 * document and a pooled client all contain themselves somewhere, and the same
 * sub-object is usually reachable several ways.
 */
export function clone<T>(v: T): T {
  return cloneInner(v, new WeakMap<object, unknown>(), 0, { nodes: CLONE_NODE_LIMIT }) as T;
}

function cloneInner(v: unknown, seen: WeakMap<object, unknown>, depth: number, budget: CopyBudget): unknown {
  if (v === null || typeof v !== "object") return v;

  const already = seen.get(v);
  if (already !== undefined) return already;

  let array: boolean;
  try {
    // A revoked Proxy throws here, before any guard could look at it.
    array = Array.isArray(v);
  } catch {
    refuse("unreadable");
    return UNREADABLE;
  }

  // Not a container: an Error, a Date, a class instance, a socket. Kept as it
  // is, and never walked into, so it is not a route back out of the store.
  if (!array && !isPlainObject(v)) return v;

  if (depth >= CLONE_DEPTH_LIMIT || budget.nodes <= 0) {
    refuse("truncated");
    return TRUNCATED;
  }
  budget.nodes -= 1;

  if (array) {
    const out: unknown[] = own([]);
    seen.set(v, out);
    const source = v as unknown[];
    let length = 0;
    try {
      length = source.length;
    } catch {
      refuse("unreadable");
    }
    // By index rather than by key, so a sparse array keeps its length and its
    // holes stay where they were.
    for (let i = 0; i < length; i++) {
      out[i] = hasOwn(source, String(i))
        ? cloneInner(readOwn(source, String(i)), seen, depth + 1, budget)
        : undefined;
    }
    out.length = length;
    return out;
  }

  const out: Bindings = own({});
  seen.set(v, out);
  for (const key of ownKeys(v)) {
    if (isForbiddenKey(key)) {
      refuse("forbidden-key", key);
      continue;
    }
    out[key] = cloneInner(readOwn(v, key), seen, depth + 1, budget);
  }
  return out;
}

interface MergeContext {
  seen: WeakMap<object, unknown>;
  pairs: WeakMap<object, WeakMap<object, Bindings>>;
  budget: CopyBudget;
}

/**
 * Merge `patch` over `base`, returning a NEW object. Neither input is mutated,
 * and no part of either ends up inside the result by reference.
 *
 * Descending two objects at once needs its own memo, and for two reasons that
 * look alike and are not. A cycle needs the result registered BEFORE its
 * children are filled in, so a loop resolves to the object being built. Shared
 * references need the same table so a node reachable by many routes is merged
 * once: guarding cycles alone with an on-the-path set terminates, and then costs
 * width-to-the-power-of-depth, which on a nine-node graph is nearly a minute of
 * a starved event loop.
 */
export function deepMerge(base: Bindings, patch: Bindings): Bindings {
  return deepMergeInner(base, patch, {
    seen: new WeakMap<object, unknown>(),
    pairs: new WeakMap<object, WeakMap<object, Bindings>>(),
    budget: { nodes: CLONE_NODE_LIMIT },
  }, 0);
}

function deepMergeInner(base: Bindings, patch: Bindings, ctx: MergeContext, depth: number): Bindings {
  let pairsForBase = ctx.pairs.get(base);
  if (pairsForBase === undefined) {
    pairsForBase = new WeakMap<object, Bindings>();
    ctx.pairs.set(base, pairsForBase);
  }
  const already = pairsForBase.get(patch);
  if (already !== undefined) return already;

  const out: Bindings = emptyBindings();
  pairsForBase.set(patch, out);

  if (depth >= CLONE_DEPTH_LIMIT || ctx.budget.nodes <= 0) {
    refuse("truncated");
    return out;
  }
  ctx.budget.nodes -= 1;

  // Read `base` once. It is normally a store, but `deepMerge` is exported, and a
  // property read is allowed to be a getter with opinions.
  const fromBase = new Map<string, unknown>();
  for (const key of ownKeys(base)) {
    if (isForbiddenKey(key)) {
      refuse("forbidden-key", key);
      continue;
    }
    fromBase.set(key, readOwn(base, key));
  }

  for (const [key, val] of fromBase) {
    out[key] = cloneInner(val, ctx.seen, depth + 1, ctx.budget);
  }

  for (const key of ownKeys(patch)) {
    if (isForbiddenKey(key)) {
      refuse("forbidden-key", key);
      continue;
    }
    const val = readOwn(patch, key);
    const cur = fromBase.get(key);
    out[key] =
      isPlainObject(cur) && isPlainObject(val)
        ? deepMergeInner(cur, val, ctx, depth + 1)
        : cloneInner(val, ctx.seen, depth + 1, ctx.budget);
  }
  return out;
}

/**
 * Merge `patch` into `target` in place, but only where `target` does not already
 * have a value. Used to inject ambient context into a log record without
 * clobbering a field the call site set explicitly (the call site is more specific).
 *
 * `target` is the logger's record, not ours, so this is the one place that writes
 * into an object it did not build. Everything it writes is a fresh copy.
 */
export function mergeMissing(target: Record<string, unknown>, patch: Bindings): void {
  mergeMissingInner(
    target,
    patch,
    {
      seen: new WeakMap<object, unknown>(),
      pairs: new WeakMap<object, WeakMap<object, Bindings>>(),
      budget: { nodes: CLONE_NODE_LIMIT },
    },
    0,
  );
}

function mergeMissingInner(
  target: Record<string, unknown>,
  patch: Bindings,
  ctx: MergeContext,
  depth: number,
): void {
  let pairsForTarget = ctx.pairs.get(target);
  if (pairsForTarget === undefined) {
    pairsForTarget = new WeakMap<object, Bindings>();
    ctx.pairs.set(target, pairsForTarget);
  }
  if (pairsForTarget.get(patch) !== undefined) return;
  pairsForTarget.set(patch, target as Bindings);

  if (depth >= CLONE_DEPTH_LIMIT || ctx.budget.nodes <= 0) {
    refuse("truncated");
    return;
  }
  ctx.budget.nodes -= 1;

  for (const key of ownKeys(patch)) {
    if (isForbiddenKey(key)) {
      refuse("forbidden-key", key);
      continue;
    }
    const val = readOwn(patch, key);
    if (!hasOwn(target, key)) {
      assign(target, key, cloneInner(val, ctx.seen, depth + 1, ctx.budget));
      continue;
    }
    const cur = target[key];
    if (isPlainObject(cur) && isPlainObject(val)) {
      mergeMissingInner(cur, val, ctx, depth + 1);
    }
    // else: target already holds a value at `key`, so keep it (call-site wins)
  }
}
