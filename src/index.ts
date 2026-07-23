/**
 * logscope: contextual logging for Node via AsyncLocalStorage + MDC.
 *
 * - `logscope`  a ready-to-use shared instance for simple apps.
 * - `LogScope`  the class, to create isolated instances.
 */
export { LogScope } from "./context";
export type {
  LogScopeOptions,
  Store,
  ExpressOptions,
  RequestLike,
  ResponseLike,
  NextLike,
  WinstonFormatLike,
  ChildLogger,
} from "./context";
export type { Bindings } from "./mdc";
export { getPath, setPath, delPath, deepMerge } from "./mdc";

import { LogScope } from "./context";

/** Default shared LogScope instance. Import this for single-instance apps. */
export const logscope = new LogScope();
