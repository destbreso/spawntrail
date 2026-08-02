/**
 * mdc.ts: tiny, zero-dependency helpers for a Mapped Diagnostic Context.
 *
 * A context is a plain object. Values are addressed by dot-path ("user.id"),
 * so callers can enrich nested structure without pulling in object-path or
 * merge-deep the way the 2021 original did.
 */

/** A context object: arbitrary structured data attached to logs. */
export type Bindings = Record<string, unknown>;

/**
 * The one key name that may never be written, as a path segment or as a key in
 * any value.
 *
 * `__proto__` is not an ordinary property: assigning it reassigns the target's
 * prototype instead of storing a value. Two consequences, both reachable from a
 * dot-path built out of data, which is the ordinary shape of a middleware
 * copying request fields into context:
 *
 *   put("__proto__.isAdmin", true)   pollutes Object.prototype process-wide
 *   run(JSON.parse(payload), fn)     with a `__proto__` key silently replaces
 *                                    the store's prototype, after which every
 *                                    read returns nothing for the rest of the
 *                                    scope, with no error
 *
 * `JSON.parse` produces `__proto__` as an OWN property, so a queue payload or a
 * webhook body is enough for the second one. No attacker required.
 */
const FORBIDDEN_KEY = "__proto__";

function isForbiddenKey(key: string): boolean {
  return key === FORBIDDEN_KEY;
}

function hasForbiddenSegment(keys: string[]): boolean {
  return keys.some(isForbiddenKey);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function toKeys(path: string): string[] {
  return path.split(".");
}

/** Read a dot-path from a context, or `undefined` if any segment is missing. */
export function getPath(obj: Bindings, path: string): unknown {
  const keys = toKeys(path);
  if (hasForbiddenSegment(keys)) return undefined;
  let cur: unknown = obj;
  for (const key of keys) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Set a dot-path in a context, creating intermediate objects. Mutates `obj`. */
export function setPath(obj: Bindings, path: string, value: unknown): void {
  const keys = toKeys(path);
  // Refused whole rather than truncated: writing the safe prefix of a path the
  // caller did not mean leaves a half-applied context, which is harder to reason
  // about than nothing happening.
  if (hasForbiddenSegment(keys)) return;
  const last = keys.pop();
  if (last === undefined) return;
  let cur: Record<string, unknown> = obj;
  for (const key of keys) {
    const next = cur[key];
    if (isPlainObject(next)) {
      cur = next;
    } else {
      const created: Record<string, unknown> = {};
      cur[key] = created;
      cur = created;
    }
  }
  cur[last] = value;
}

/** Delete a dot-path from a context. Mutates `obj`. */
export function delPath(obj: Bindings, path: string): void {
  const keys = toKeys(path);
  if (hasForbiddenSegment(keys)) return;
  const last = keys.pop();
  if (last === undefined) return;
  let cur: unknown = obj;
  for (const key of keys) {
    if (!isPlainObject(cur)) return;
    cur = cur[key];
  }
  if (isPlainObject(cur)) delete cur[last];
}

/** Structural clone: plain objects and arrays are copied, everything else kept by reference. */
export function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as unknown as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    // `out[k] = ...` with k of "__proto__" reassigns this object's prototype
    // instead of storing a value, and `JSON.parse` produces exactly that key as
    // an own property.
    for (const [k, val] of Object.entries(v)) {
      if (isForbiddenKey(k)) continue;
      out[k] = clone(val);
    }
    return out as unknown as T;
  }
  return v;
}

/** Merge `patch` over `base`, returning a NEW object. `base` is never mutated. */
export function deepMerge(base: Bindings, patch: Bindings): Bindings {
  const out = clone(base);
  for (const [key, val] of Object.entries(patch)) {
    if (isForbiddenKey(key)) continue;
    const cur = out[key];
    out[key] = isPlainObject(cur) && isPlainObject(val) ? deepMerge(cur, val) : clone(val);
  }
  return out;
}

/**
 * Merge `patch` into `target` in place, but only where `target` does not already
 * have a value. Used to inject ambient context into a log record without
 * clobbering a field the call site set explicitly (the call site is more specific).
 */
export function mergeMissing(target: Record<string, unknown>, patch: Bindings): void {
  for (const [key, val] of Object.entries(patch)) {
    if (isForbiddenKey(key)) continue;
    const cur = target[key];
    if (!(key in target)) {
      target[key] = clone(val);
    } else if (isPlainObject(cur) && isPlainObject(val)) {
      mergeMissing(cur, val);
    }
    // else: target already holds a value at `key` — keep it (call-site wins)
  }
}
