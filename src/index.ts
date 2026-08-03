/**
 * spawntrail: contextual logging for Node via AsyncLocalStorage + MDC.
 *
 * - `trail` / `spawntrail`  a ready-to-use shared instance (same object; `trail` is the short call-site name).
 * - `SpawnTrail`  the class, to create isolated instances.
 */
export { SpawnTrail } from "./context";
export type {
  SpawnTrailOptions,
  Store,
  ExpressOptions,
  RequestLike,
  ResponseLike,
  NextLike,
  WinstonFormatLike,
  ChildLogger,
  Contributor,
  Snapshot,
  BoundaryDescriptor,
} from "./context";
export { ENVELOPE_KEY } from "./context";
export { REDACTED } from "./redact";
export type { RedactOptions, Censor } from "./redact";
export type { Bindings, ViolationHandler, ViolationReason } from "./mdc";
export {
  getPath,
  setPath,
  delPath,
  deepMerge,
  deepMergeKeeping,
  clone,
  jsonSafe,
  isForbiddenKey,
  setViolationHandler,
  resetViolationWarning,
  CLONE_DEPTH_LIMIT,
  CLONE_WORK_LIMIT,
  TRUNCATED,
  UNREADABLE,
} from "./mdc";

import { SpawnTrail } from "./context";

/** Default shared instance. `trail` is the short, ergonomic name for call sites. */
export const trail = new SpawnTrail();

/** Alias of `trail`, for those who prefer the full package name. */
export const spawntrail = trail;
