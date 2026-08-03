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
 * **The walk is driven by the policy, not by the record.** A log line pays for
 * the paths that were declared, not for the size of the context, and a node with
 * nothing matched underneath it is passed through by reference rather than
 * copied. The result therefore shares structure with its input, which is safe
 * for exactly one reason: it is no more shared than the store it came from, and
 * every caller of it already copies before handing anything out.
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
   * The publishable view of `source`.
   *
   * Returns `source` itself when nothing matched, and otherwise a copy along the
   * matched paths only. Either way the result is exactly as shared as its input,
   * so it is safe to hand to something that copies and to nothing else.
   */
  apply(source: Bindings): Bindings {
    if (this.declared === 0) return source;
    return redactContainer(source, [this.root], "", { work: CLONE_WORK_LIMIT }) as Bindings;
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

function redactContainer(source: object, nodes: Node[], path: string, budget: Budget): object {
  const array = Array.isArray(source);
  const keys = keysToVisit(source, nodes);

  let out = source;
  const writable = (): Record<string, unknown> => {
    if (out === source) {
      out = array ? shallowCopyArray(source as unknown[]) : shallowCopyObject(source as Bindings);
    }
    return out as Record<string, unknown>;
  };

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i] as string;
    // Never assignable on a plain object, so never redactable either. The store
    // filters it on the way in; a contributor's own object may still carry it,
    // and it is dropped by the copy below or refused by the merge downstream.
    if (isForbiddenKey(key)) continue;

    if (budget.work <= 0) {
      // Fail closed. A value the policy could not be checked against is not
      // published, so the rest of this node is dropped rather than passed
      // through. It fires only on a context node with more than ten thousand
      // keys, which the copy downstream was going to truncate anyway.
      refuse("truncated", undefined, path === "" ? undefined : path);
      const target = writable();
      for (let j = i; j < keys.length; j += 1) delete target[keys[j] as string];
      if (!array) target[TRUNCATED] = TRUNCATED;
      break;
    }
    budget.work -= 1;

    const matched = childrenFor(nodes, key);
    if (matched.length === 0) continue;

    const childPath = path === "" ? key : `${path}.${key}`;
    const rule = ruleOf(matched);
    if (rule !== undefined) {
      const replacement = rule.remove ? undefined : censorFor(rule, readOwn(source, key), childPath);
      const target = writable();
      if (replacement === undefined) delete target[key];
      else target[key] = replacement;
      continue;
    }

    const value = readOwn(source, key);
    // A declared path that runs deeper than the value does matches nothing:
    // `user.email` says nothing about a `user` that is a string.
    if (!isContainer(value)) continue;
    const replaced = redactContainer(value, matched, childPath, budget);
    if (replaced !== value) writable()[key] = replaced;
  }

  return out;
}

/**
 * A one-level copy whose values are still the originals.
 *
 * That sharing is the point: only the spine down to a redacted value is rebuilt.
 * `Object.assign` cannot be used here because it assigns through setters, and
 * this runs over objects a contributor returned, where `__proto__` can be an own
 * property straight out of `JSON.parse`.
 *
 * Deliberately NOT branded into the owned set, unlike every other copy in this
 * package. The brand is what licenses a dot-path walk to descend into an object,
 * and nothing walks this: the view is only ever a source for a merge or a copy,
 * never a store and never a merge target. Not branding it is the conservative
 * direction, and the brand is a `WeakSet` write on every level of every matched
 * path on every log record, which is most of what redaction costs.
 */
function shallowCopyObject(source: Bindings): Bindings {
  const out: Bindings = {};
  for (const key of ownKeys(source)) {
    if (isForbiddenKey(key)) continue;
    out[key] = readOwn(source, key);
  }
  return out;
}

/** The same, by own index keys, so a hole stays a hole rather than becoming an own slot. */
function shallowCopyArray(source: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const key of ownKeys(source)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    out[index] = readOwn(source, key);
  }
  let length = 0;
  try {
    length = source.length;
  } catch {
    // A length that throws leaves the copy as long as what was actually read.
    return out;
  }
  try {
    if (out.length < length) out.length = length;
  } catch {
    refuse("truncated");
  }
  return out;
}
