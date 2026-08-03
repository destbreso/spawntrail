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
 *   EVERY plain object and array reachable from a context was created here.
 *   No CONTAINER in a context is the same object as one a caller holds.
 *
 * That sentence is what makes scopes isolated (no two stores can share a node),
 * what makes an emitted record a real snapshot, and what makes a dot-path walk
 * safe (it can only ever step into objects this file built, so it can never
 * arrive at a prototype). A denylist of dangerous key names is the weaker
 * version of the same idea: it enumerates the ways in, and the list is only ever
 * as complete as the last person to think about it.
 *
 * The word CONTAINER is doing real work there, and the carve-out has to be said
 * out loud rather than left in the small print. Values that are not plain
 * objects or arrays (an Error, a Date, a Map, a class instance, a socket) are
 * kept BY REFERENCE, because copying them would either fail or hand back
 * something that is not the thing that was logged. So `put("err", err)` does
 * store the caller's Error, and mutating `err.details` afterwards is visible
 * through the context. What the guarantee buys is that this is the only way it
 * can happen, that it cannot happen accidentally through a plain object, and
 * that nothing reachable this way is ever WALKED INTO, so it is not a route back
 * out of the store.
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
 * How many properties and array elements one copy may visit before it
 * substitutes a marker.
 *
 * Depth was never the thing worth bounding, and neither is the number of
 * objects. What starves an event loop is total work: a two-object context whose
 * second object is a three-million-element array is two objects and a third of
 * a second, and it is paid again on every nested scope and every log record.
 * Counting each property and each element is the only count that tracks the
 * time actually spent.
 *
 * A context is for the handful of values that identify a unit of work. This
 * bound is what makes "a value nobody meant to log cannot take down the process"
 * true rather than aspirational, and reaching it is reported, not silent.
 */
export const CLONE_WORK_LIMIT = 10_000;

/** Substituted for a value the copy refused to descend into. */
export const TRUNCATED = "[spawntrail: truncated]";

/** Substituted for a value that could not be read without throwing. */
export const UNREADABLE = "[spawntrail: unreadable]";

export type ViolationReason =
  | "forbidden-key"
  | "truncated"
  | "unreadable"
  | "invalid-path"
  /** A key that already held a value was written again with a different one. */
  | "immutable"
  /** A value was left out of a snapshot because it cannot cross a serialization boundary. */
  | "not-serializable"
  /** A censor function threw, so the value was replaced with the default censor rather than published. */
  | "redaction-failed";

/**
 * Notified when an operation is refused or a value is substituted.
 *
 * The handler fires on EVERY occurrence, because a hook that reports once is of
 * no use to a counter or a test. The built-in warning is the part that fires
 * once, so a loop over attacker-controlled keys cannot turn a refusal into a log
 * flood.
 */
export type ViolationHandler = (event: {
  reason: ViolationReason;
  key?: string | undefined;
  path?: string | undefined;
  /** For `"immutable"`: the value that stays, and the one that was refused. */
  current?: unknown;
  rejected?: unknown;
}) => void;

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

/** Internal to this package: not re-exported from the entry point. */
export function refuse(
  reason: ViolationReason,
  key?: string,
  path?: string,
  detail?: { current: unknown; rejected: unknown },
): void {
  if (onViolation) {
    try {
      onViolation({ reason, key, path, current: detail?.current, rejected: detail?.rejected });
    } catch {
      // A handler that throws would undo the very property the refusal exists to
      // provide, and the README suggests exactly the shape ("fail a test on
      // them") that throws.
    }
    return;
  }
  if (warned || process.env.NODE_ENV === "production") return;
  warned = true;
  // Clipped, because the thing being reported is sometimes the reason it is too
  // long: an "invalid-path" notice for a key built from data is a notice whose
  // own payload can be megabytes.
  const clip = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}... (${text.length} chars)` : text);
  // eslint-disable-next-line no-console
  console.warn(
    `spawntrail: ${reason}${key ? ` (${JSON.stringify(clip(key))})` : ""}` +
      `${path ? ` in path ${JSON.stringify(clip(path))}` : ""}. ` +
      "Pass a handler to setViolationHandler() to observe these; further notices are silent.",
  );
}

/**
 * Report a refused change to a key that already holds a value.
 *
 * A context is meant to be readable as a record of one unit of work, so a value
 * in it does not change once it is there. Refusing quietly would be its own kind
 * of lie: the code believes it wrote the real actor and the line says otherwise,
 * with nothing anywhere to say so. The attempt is therefore always reported,
 * with both values, even though it is never fatal.
 */
export function refuseImmutable(path: string, current: unknown, rejected: unknown): void {
  refuse("immutable", undefined, path, { current, rejected });
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

/** Internal to this package: not re-exported from the entry point. */
export function own<T extends object>(v: T): T {
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

export function hasOwn(obj: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(obj, key);
  } catch {
    return false;
  }
}

/** Read one own property without letting an accessor take down the caller. */
export function readOwn(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    refuse("unreadable", key);
    return UNREADABLE;
  }
}

export function ownKeys(v: object): string[] {
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
    // Not reported: a read of a key that can never be stored is simply a miss,
    // and reporting it here would fire a second event for every refused write,
    // since a write checks what is there first.
    if (isForbiddenKey(key)) return undefined;
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
  if (keys.length > CLONE_DEPTH_LIMIT) {
    // The threat model for this file is a generic mapper writing keys it did not
    // choose. Without a bound, one such key of a few million segments builds a
    // store that deep and takes the process down with it, which the copy bound
    // never sees because nothing was copied.
    refuse("invalid-path", undefined, path);
    return;
  }
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
  /**
   * How many properties and array elements are left to visit.
   *
   * The unit is WORK, not containers. Counting containers looks equivalent and
   * is not: a context of two objects, one of which holds a three-million-element
   * array, is two containers and several hundred milliseconds of a blocked event
   * loop. A budget that never fires on that input is not a budget.
   */
  work: number;
}

function budgetSpent(budget: CopyBudget): boolean {
  if (budget.work > 0) return false;
  refuse("truncated");
  return true;
}

/**
 * Structural copy: plain objects and arrays are rebuilt here, everything else is
 * kept by reference.
 *
 * Cycles are resolved against the copy being built, so a self-referential value
 * keeps its shape. Two references to the same object become two independent
 * copies, which is the opposite of what a memo would do and is deliberate: a
 * store's paths have to be independent, or `put("user.role", x)` also rewrites
 * whatever else happened to be seeded from the same object. What keeps that
 * honesty affordable is the budget, not sharing.
 */
export function clone<T>(v: T): T {
  return cloneInner(v, new Map<object, unknown>(), 0, { work: CLONE_WORK_LIMIT }) as T;
}

/**
 * @param open the containers on the current descent, mapped to the copy being
 * built for each. Present so a cycle resolves; removed on the way back up so a
 * sibling reference is copied again rather than shared.
 */
function cloneInner(v: unknown, open: Map<object, unknown>, depth: number, budget: CopyBudget): unknown {
  if (v === null || typeof v !== "object") return v;

  const inProgress = open.get(v);
  if (inProgress !== undefined) return inProgress;

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

  if (depth >= CLONE_DEPTH_LIMIT) {
    refuse("truncated");
    return TRUNCATED;
  }
  if (budgetSpent(budget)) return TRUNCATED;

  if (array) {
    const out: unknown[] = own([]);
    open.set(v, out);
    try {
      copyArray(v as unknown[], out, open, depth, budget);
    } finally {
      open.delete(v);
    }
    return out;
  }

  const out: Bindings = own({});
  open.set(v, out);
  try {
    for (const key of ownKeys(v)) {
      if (isForbiddenKey(key)) {
        refuse("forbidden-key", key);
        continue;
      }
      if (budgetSpent(budget)) {
        out[TRUNCATED] = TRUNCATED;
        break;
      }
      budget.work -= 1;
      out[key] = cloneInner(readOwn(v, key), open, depth + 1, budget);
    }
  } finally {
    open.delete(v);
  }
  return out;
}

/**
 * Copy an array by its own index keys, so a hole stays a hole.
 *
 * Walking 0..length and writing `undefined` for the gaps keeps the length and
 * destroys the shape: assigning `undefined` creates an own property, so a
 * one-element array indexed at five million comes out the other side with five
 * million own properties and the heap to match. `byId[rowId] = row` is all it
 * takes to build one.
 */
function copyArray(
  source: unknown[],
  out: unknown[],
  open: Map<object, unknown>,
  depth: number,
  budget: CopyBudget,
): void {
  let length = 0;
  try {
    length = source.length;
  } catch {
    refuse("unreadable");
    return;
  }

  for (const key of ownKeys(source)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    if (budgetSpent(budget)) {
      // Stop where the budget ran out rather than marking every remaining slot:
      // filling a two-hundred-thousand-element array with markers is the cost
      // the budget exists to avoid, paid anyway.
      out.push(TRUNCATED);
      return;
    }
    budget.work -= 1;
    out[index] = cloneInner(readOwn(source, key), open, depth + 1, budget);
  }

  try {
    if (out.length < length) out.length = length;
  } catch {
    refuse("truncated");
  }
}

interface MergeContext {
  /** Pairs on the current descent, so a cycle through both sides terminates. */
  open: Map<object, Map<object, Bindings>>;
  /** When set, a key that already holds a value keeps it. */
  immutable: boolean;
  openValues: Map<object, unknown>;
  budget: CopyBudget;
}

function openPair(ctx: MergeContext, base: object, patch: object): Bindings | undefined {
  return ctx.open.get(base)?.get(patch);
}

function markPair(ctx: MergeContext, base: object, patch: object, out: Bindings): void {
  let inner = ctx.open.get(base);
  if (inner === undefined) {
    inner = new Map<object, Bindings>();
    ctx.open.set(base, inner);
  }
  inner.set(patch, out);
}

function unmarkPair(ctx: MergeContext, base: object, patch: object): void {
  ctx.open.get(base)?.delete(patch);
}

/**
 * Merge `patch` over `base`, returning a NEW object. Neither input is mutated,
 * and no part of either ends up inside the result by reference.
 */
export function deepMerge(base: Bindings, patch: Bindings): Bindings {
  return deepMergeInner(
    base,
    patch,
    { open: new Map(), openValues: new Map(), budget: { work: CLONE_WORK_LIMIT }, immutable: false },
    0,
  );
}

/**
 * Merge `patch` over `base`, keeping any value `base` already has.
 *
 * The same merge with the write-once rule applied at each leaf: a key that holds
 * a value keeps it, and the refusal is reported with both values. Writing the
 * identical value again is not a change and passes silently.
 */
export function deepMergeKeeping(base: Bindings, patch: Bindings): Bindings {
  return deepMergeInner(
    base,
    patch,
    { open: new Map(), openValues: new Map(), budget: { work: CLONE_WORK_LIMIT }, immutable: true },
    0,
  );
}

function deepMergeInner(base: Bindings, patch: Bindings, ctx: MergeContext, depth: number): Bindings {
  const inProgress = openPair(ctx, base, patch);
  if (inProgress !== undefined) return inProgress;

  const out: Bindings = emptyBindings();
  if (depth >= CLONE_DEPTH_LIMIT || budgetSpent(ctx.budget)) {
    refuse("truncated");
    return out;
  }
  markPair(ctx, base, patch, out);

  try {
    // Read `base` once. It is normally a store, but `deepMerge` is exported, and
    // a property read is allowed to be a getter with opinions.
    const fromBase = new Map<string, unknown>();
    for (const key of ownKeys(base)) {
      if (isForbiddenKey(key)) {
        refuse("forbidden-key", key);
        continue;
      }
      fromBase.set(key, readOwn(base, key));
    }

    for (const [key, val] of fromBase) {
      if (budgetSpent(ctx.budget)) break;
      ctx.budget.work -= 1;
      out[key] = cloneInner(val, ctx.openValues, depth + 1, ctx.budget);
    }

    for (const key of ownKeys(patch)) {
      if (isForbiddenKey(key)) {
        refuse("forbidden-key", key);
        continue;
      }
      if (budgetSpent(ctx.budget)) break;
      ctx.budget.work -= 1;
      const val = readOwn(patch, key);
      const cur = fromBase.get(key);
      if (isPlainObject(cur) && isPlainObject(val)) {
        out[key] = deepMergeInner(cur, val, ctx, depth + 1);
        continue;
      }
      if (ctx.immutable && cur !== undefined && !Object.is(cur, val)) {
        refuseImmutable(key, cur, val);
        continue;
      }
      out[key] = cloneInner(val, ctx.openValues, depth + 1, ctx.budget);
    }
  } finally {
    unmarkPair(ctx, base, patch);
  }
  return out;
}

/**
 * Merge `patch` into `target` in place, but only where `target` does not already
 * have a value. Used to inject ambient context into a log record without
 * clobbering a field the call site set explicitly (the call site is more specific).
 *
 * `target` is the logger's record, which means the objects hanging off it belong
 * to whoever wrote the log call. winston shallow-copies its metadata, so
 * `logger.info("m", { product })` puts the application's own `product` on the
 * record. Descending into that and adding context keys to it writes into the
 * application's data: if the object is reused, the first request's context is
 * stamped on it and every later line carries it. So a node this library did not
 * build is replaced by a copy before anything is merged into it.
 */
export function mergeMissing(target: Record<string, unknown>, patch: Bindings): void {
  mergeMissingInner(
    target,
    patch,
    { open: new Map(), openValues: new Map(), budget: { work: CLONE_WORK_LIMIT }, immutable: false },
    0,
  );
}

function mergeMissingInner(
  target: Record<string, unknown>,
  patch: Bindings,
  ctx: MergeContext,
  depth: number,
): void {
  if (openPair(ctx, target, patch) !== undefined) return;
  if (depth >= CLONE_DEPTH_LIMIT || budgetSpent(ctx.budget)) return;
  markPair(ctx, target, patch, target as Bindings);

  try {
    for (const key of ownKeys(patch)) {
      if (isForbiddenKey(key)) {
        refuse("forbidden-key", key);
        continue;
      }
      if (budgetSpent(ctx.budget)) return;
      ctx.budget.work -= 1;

      const val = readOwn(patch, key);
      if (!hasOwn(target, key)) {
        assign(target, key, cloneInner(val, ctx.openValues, depth + 1, ctx.budget));
        continue;
      }

      const cur = readOwn(target, key);
      if (!isPlainObject(cur) || !isPlainObject(val)) continue;

      // The call site's own object. Merge into a copy of it, never into it.
      const into = OWNED.has(cur) ? cur : (cloneInner(cur, ctx.openValues, depth + 1, ctx.budget) as Bindings);
      if (into !== cur && !assign(target, key, into)) continue;
      if (!isPlainObject(into)) continue;
      mergeMissingInner(into, val, ctx, depth + 1);
    }
  } finally {
    unmarkPair(ctx, target, patch);
  }
}

/**
 * The JSON-safe projection of a context: what can cross a serialization boundary.
 *
 * A context may legitimately hold an Error, a Date, a class instance or a pooled
 * client, because those are the things people log and copying them would hand
 * back something that is not what they logged. None of them survives a round
 * trip through a queue: an Error serializes to `{}`, a function disappears, a
 * BigInt throws inside the serializer, and a cycle takes the whole publish call
 * with it. A snapshot that explodes in someone's queue driver is worse than no
 * snapshot at all.
 *
 * So the projection keeps exactly what comes back as the same thing: strings,
 * finite numbers, booleans, null, and plain objects and arrays of those.
 * Everything else is dropped and reported, because a field that quietly stopped
 * crossing the boundary is a debugging session nobody enjoys.
 */
export function jsonSafe(value: Bindings): Bindings {
  const out = projectObject(value, new Set<object>(), 0, { work: CLONE_WORK_LIMIT });
  return out ?? emptyBindings();
}

/**
 * @returns the projection, or `undefined` when the whole node has to be dropped.
 *
 * A node that STARTED empty survives as `{}`, and one that BECAME empty because
 * everything in it was dropped does not. The difference matters on the far side:
 * `socket: {}` on every line of a worker is noise that says a key existed and
 * carried nothing, and the drop is already on the record through the handler.
 */
function projectObject(
  source: Bindings,
  open: Set<object>,
  depth: number,
  budget: CopyBudget,
): Bindings | undefined {
  if (open.has(source)) {
    // A cycle cannot be written down. Dropping the back-reference keeps the rest.
    refuse("not-serializable");
    return undefined;
  }
  if (depth >= CLONE_DEPTH_LIMIT || budgetSpent(budget)) return undefined;

  open.add(source);
  try {
    const out: Bindings = emptyBindings();
    let seen = 0;
    let kept = 0;
    for (const key of ownKeys(source)) {
      if (isForbiddenKey(key)) continue;
      if (budgetSpent(budget)) break;
      budget.work -= 1;
      seen += 1;
      const projected = projectValue(readOwn(source, key), open, depth + 1, budget);
      if (projected === undefined) continue;
      out[key] = projected;
      kept += 1;
    }
    return seen > 0 && kept === 0 ? undefined : out;
  } finally {
    open.delete(source);
  }
}

function projectValue(value: unknown, open: Set<object>, depth: number, budget: CopyBudget): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    // NaN and the infinities serialize to null, which reads as a value that was
    // there and was empty rather than one that never made the trip.
    if (Number.isFinite(value)) return value;
    refuse("not-serializable");
    return undefined;
  }
  if (type !== "object") {
    // undefined, bigint, symbol, function.
    refuse("not-serializable");
    return undefined;
  }

  const asObject = value as object;
  if (Array.isArray(asObject)) {
    if (open.has(asObject)) {
      refuse("not-serializable");
      return undefined;
    }
    if (depth >= CLONE_DEPTH_LIMIT || budgetSpent(budget)) return undefined;
    open.add(asObject);
    try {
      const out: unknown[] = [];
      for (const item of asObject as unknown[]) {
        if (budgetSpent(budget)) break;
        budget.work -= 1;
        const projected = projectValue(item, open, depth + 1, budget);
        // A hole in an array cannot be expressed in JSON, so a dropped element
        // becomes null rather than shifting everything after it.
        out.push(projected === undefined ? null : projected);
      }
      return out;
    } finally {
      open.delete(asObject);
    }
  }

  if (isPlainObject(asObject)) return projectObject(asObject as Bindings, open, depth, budget);

  // An Error, a Date, a Map, a class instance, a socket.
  refuse("not-serializable");
  return undefined;
}
