/**
 * redact.ts: declared paths masked on the way onto a log line.
 *
 * Ambient context is convenient precisely because it flows everywhere without
 * anyone thinking about it, and that is also the risk. A field put in scope once
 * is stamped onto every line for the rest of the request, including lines
 * written by code that never intended to publish it, and the fields people
 * naturally put in context are the sensitive ones: an email, a phone number, an
 * authorization header, a session token, whatever a `bindings(req)` mapper
 * copied wholesale off a request. Logs then ship to a backend with a different
 * retention policy and a different access list than the database the same data
 * is so carefully protected in.
 *
 * Three things decide the shape of this file.
 *
 * **Redaction happens on the way out, never in the store.** Application code
 * keeps reading the value it put there through `get("user.email")`, and a bug in
 * a censor costs a masked log line rather than a lost value. The context is
 * still the record of the work; what changes is what gets published from it.
 *
 * **Declared paths only.** No detector, no heuristic, nothing that scans for
 * things that look like a card number. Guessing produces false negatives, which
 * give false comfort, and false positives, which quietly destroy the data
 * somebody is debugging with. A security feature that lies about its coverage is
 * worse than none.
 *
 * **It masks a copy, in place, and never copies anything itself.** The first
 * version of this file rebuilt the spine down to each matched value and carried
 * every unmatched branch across by reference, which looked like the cheap answer
 * and was wrong three separate ways. A back-reference in a plain-object graph (a
 * tree with parent pointers, a `.lean()` result with a populated back-reference)
 * survived the rebuild pointing at
 * the ORIGINAL node, so the raw value came out one level below its own mask, on
 * every surface including the wire, and declaring the derived path just moved the
 * leak a level down. A censor was handed the live store node, so the ordinary way
 * to write one (`v => { delete v.pan; return v }`) deleted from the context
 * itself. And those spine copies were not charged to the work budget, so one
 * declared path over a large context turned a bounded one-millisecond log call
 * into eighty milliseconds of blocked event loop.
 *
 * Masking the copy the caller already pays for removes all three at once. There
 * is nothing left to share, the censor cannot reach the store, and the input is
 * already bounded by `CLONE_WORK_LIMIT`. It is also cheaper than what it
 * replaces. The reason it is COMPLETE, and not just better, is a property of the
 * store rather than of this file: `put()` copies every value independently and
 * `clone()` gives two references to one object two independent copies, so the
 * only aliasing a context can hold is a back-edge to an ancestor, and a back-edge
 * is exactly what `clone()` resolves against the copy being built. Mask the copy
 * and every route to that node sees the mask, because there is only one node.
 */
import {
  type Bindings,
  CLONE_DEPTH_LIMIT,
  CLONE_WORK_LIMIT,
  TRUNCATED,
  hasOwn,
  isForbiddenKey,
  isPlainObject,
  ownKeys,
  readOwn,
  refuse,
  refuseImmutable,
} from "./mdc";

/** What a redacted value becomes when the policy does not say otherwise. */
export const REDACTED = "[redacted]";

/**
 * Turns a matched value into what gets published.
 *
 * Receives the value and the full dot-path it was found at, so one function can
 * serve several paths. Returning `undefined` drops the key, which is `remove`
 * decided per value rather than per path.
 *
 * The value comes out of the copy being published, never out of the store, so
 * `(value) => { delete value.pan; return value }` is a fine way to write one:
 * it changes that record and nothing else.
 */
export type Censor = (value: unknown, path: string) => unknown;

export interface RedactOptions {
  /**
   * Dot-paths that are never published.
   *
   * `*` matches exactly one segment, an object key or an array index, so
   * `"*.token"` covers `session.token` and `client.token` and `"items.*.card"`
   * covers every element of a list. There is no recursive wildcard: a policy you
   * can read off the page is a policy a reviewer can approve.
   */
  paths: string[];
  /** What a matched value becomes: a fixed value, or a {@link Censor}. Default {@link REDACTED}. */
  censor?: unknown | Censor;
  /** Drop the key instead of masking it. Default false. */
  remove?: boolean;
}

interface Rule {
  censor: unknown;
  remove: boolean;
}

interface Node {
  children: Map<string, Node>;
  wildcard?: Node;
  /** Set on the last segment of a declared path: everything at or under here is redacted. */
  rule?: Rule;
}

interface Budget {
  work: number;
}

const newNode = (): Node => ({ children: new Map<string, Node>() });

function sameRule(a: Rule, b: Rule): boolean {
  return a.remove === b.remove && Object.is(a.censor, b.censor);
}

/**
 * A compiled policy.
 *
 * Compiled once and only ever added to. Redaction runs on every log record, so
 * it cannot be a per-line parse of path strings, and a policy that could be
 * narrowed at runtime would be a policy any later line of code could quietly
 * turn off. Declaring the same path twice with a different rule keeps the first
 * and reports the second, the same answer `put()` gives.
 */
export class Redactor {
  private readonly root: Node = newNode();
  private declared = 0;

  /** Whether anything is declared, so the common no-policy case costs one comparison. */
  get empty(): boolean {
    return this.declared === 0;
  }

  add(options: RedactOptions): void {
    const rule: Rule = {
      censor: options.censor === undefined ? REDACTED : options.censor,
      remove: options.remove ?? false,
    };
    const paths = Array.isArray(options.paths) ? options.paths : [];
    for (const path of paths) this.declare(path, rule);
  }

  private declare(path: string, rule: Rule): void {
    if (typeof path !== "string" || path.length === 0) {
      // A policy entry that matches nothing is the worst kind of security
      // feature: it reads as coverage and provides none. An empty string is a
      // stray comma in a config, so say so instead of installing a rule for a
      // key nobody has.
      refuse("invalid-path", undefined, typeof path === "string" ? path : undefined);
      return;
    }
    const segments = path.split(".");
    if (segments.length > CLONE_DEPTH_LIMIT) {
      refuse("invalid-path", undefined, path);
      return;
    }
    for (const segment of segments) {
      if (segment.length === 0) {
        refuse("invalid-path", undefined, path);
        return;
      }
      if (isForbiddenKey(segment)) {
        // The store cannot hold this key, so the rule could never fire.
        refuse("forbidden-key", segment, path);
        return;
      }
    }

    let node = this.root;
    for (const segment of segments) {
      if (segment === "*") {
        node.wildcard ??= newNode();
        node = node.wildcard;
        continue;
      }
      let next = node.children.get(segment);
      if (next === undefined) {
        next = newNode();
        node.children.set(segment, next);
      }
      node = next;
    }

    if (node.rule !== undefined) {
      if (!sameRule(node.rule, rule)) refuseImmutable(path, node.rule, rule);
      return;
    }
    node.rule = rule;
    this.declared += 1;
  }

  /**
   * Mask the declared paths in `target`, IN PLACE, and return it.
   *
   * `target` must be a copy this package owns and is about to publish, never a
   * store. Every caller goes through `SpawnTrail.published()`, which is the one
   * place that decides what gets copied.
   */
  applyInPlace(target: Bindings): Bindings {
    if (this.declared === 0) return target;
    redactContainer(target, [this.root], "", { work: CLONE_WORK_LIMIT }, new Set<object>());
    return target;
  }
}

function isContainer(v: unknown): v is object {
  if (v === null || typeof v !== "object") return false;
  try {
    if (Array.isArray(v)) return true;
  } catch {
    // A revoked Proxy. Not something to walk into.
    return false;
  }
  return isPlainObject(v);
}

/**
 * The policy nodes that apply to one key.
 *
 * A specific child and a wildcard can both match, and both branches stay live,
 * because `["user.email", "*.token"]` has to redact both fields of one `user`.
 * The specific branch is listed first, which is what makes "the more specific
 * declaration wins" true when two rules land on the same path.
 */
const NO_MATCH: Node[] = [];

function childrenFor(nodes: Node[], key: string): Node[] {
  // One live branch is the overwhelmingly common case, and this runs per key per
  // record, so it does not get to allocate an array to say "nothing here".
  if (nodes.length === 1) {
    const only = nodes[0] as Node;
    const specific = only.children.get(key);
    if (only.wildcard === undefined) return specific === undefined ? NO_MATCH : [specific];
    return specific === undefined ? [only.wildcard] : [specific, only.wildcard];
  }
  const out: Node[] = [];
  for (const node of nodes) {
    const specific = node.children.get(key);
    if (specific !== undefined) out.push(specific);
    if (node.wildcard !== undefined) out.push(node.wildcard);
  }
  return out;
}

function ruleOf(nodes: Node[]): Rule | undefined {
  for (const node of nodes) if (node.rule !== undefined) return node.rule;
  return undefined;
}

/**
 * The keys worth looking at here: the declared ones, or all of them under a
 * wildcard.
 *
 * This is why a log line costs the size of the policy rather than the size of
 * the context. A three-path policy over a fifty-key context reads three keys.
 */
function keysToVisit(source: object, nodes: Node[]): string[] {
  for (const node of nodes) if (node.wildcard !== undefined) return ownKeys(source);
  if (nodes.length === 1) {
    const out: string[] = [];
    for (const key of (nodes[0] as Node).children.keys()) if (hasOwn(source, key)) out.push(key);
    return out;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    for (const key of node.children.keys()) {
      if (seen.has(key) || !hasOwn(source, key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function censorFor(rule: Rule, value: unknown, path: string): unknown {
  if (typeof rule.censor !== "function") return rule.censor;
  try {
    return (rule.censor as Censor)(value, path);
  } catch {
    // The one place in this package where the safe answer is to lose data. A
    // censor that throws must not fall through to publishing the value it was
    // installed to hide.
    refuse("redaction-failed", undefined, path);
    return REDACTED;
  }
}

/**
 * Whether a key names an element of an array, rather than something about the
 * array.
 *
 * `paths: ["items.length"]` is well typed, reads as a field name, and used to
 * reach `arr.length = "[redacted]"`, which throws `RangeError` out of the log
 * call, or `delete arr.length`, which throws `TypeError` under strict mode. The
 * same policy was harmless while the value was an object and fatal the first
 * time a request made it an array. An array has exactly one kind of field, and
 * anything else declared against it matches nothing.
 */
function isIndexKey(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && String(index) === key;
}

/** Write without letting a frozen or accessor-only target throw out of a log call. */
function put(target: Record<string, unknown>, key: string, value: unknown, path: string): void {
  try {
    target[key] = value;
  } catch {
    refuse("unreadable", key, path);
  }
}

function drop(target: Record<string, unknown>, key: string, path: string): void {
  try {
    delete target[key];
  } catch {
    refuse("unreadable", key, path);
  }
}

/**
 * @param open the containers on the current descent. A back-edge is not followed
 * a second time, which both terminates the walk and keeps a censor from running
 * twice over one node: it is the SAME node, so masking it once masked every
 * route to it.
 */
function redactContainer(
  target: object,
  nodes: Node[],
  path: string,
  budget: Budget,
  open: Set<object>,
): void {
  if (open.has(target)) return;
  const array = Array.isArray(target);
  const keys = keysToVisit(target, nodes);
  const into = target as Record<string, unknown>;

  open.add(target);
  try {
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i] as string;
      // Never an ordinary property on a plain object, so never redactable either.
      if (isForbiddenKey(key)) continue;
      if (array && !isIndexKey(key)) continue;

      if (budget.work <= 0) {
        // Fail closed. A value the policy could not be checked against does not
        // get published, so the rest of this node goes rather than passing
        // through unchecked.
        refuse("truncated", undefined, path === "" ? undefined : path);
        for (let j = i; j < keys.length; j += 1) drop(into, keys[j] as string, path);
        if (!array) put(into, TRUNCATED, TRUNCATED, path);
        break;
      }
      budget.work -= 1;

      const matched = childrenFor(nodes, key);
      if (matched.length === 0) continue;

      const childPath = path === "" ? key : `${path}.${key}`;
      const rule = ruleOf(matched);
      if (rule !== undefined) {
        // The value handed to a censor comes out of the copy being published, so
        // a censor that masks or deletes in place changes this record and
        // nothing else.
        const replacement = rule.remove ? undefined : censorFor(rule, readOwn(target, key), childPath);
        if (replacement === undefined) drop(into, key, childPath);
        else put(into, key, replacement, childPath);
        continue;
      }

      const value = readOwn(target, key);
      // A declared path that runs deeper than the value does matches nothing:
      // `user.email` says nothing about a `user` that is a string.
      if (!isContainer(value)) continue;
      redactContainer(value, matched, childPath, budget, open);
    }
  } finally {
    open.delete(target);
  }
}
