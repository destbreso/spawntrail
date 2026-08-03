/**
 * bench.mjs: the numbers in the README, produced by something anyone can rerun.
 *
 * The README used to carry figures from a one-off script that no longer existed,
 * and they drifted into contradicting each other: the cost table said the pino
 * mixin cost ~1.1 µs per record on a nested context while the redaction section
 * quoted ~750 ns for the same measurement. Neither could be checked, because
 * there was nothing to run. A number in the documentation that nobody can
 * reproduce is not a measurement, it is a claim.
 *
 * So: every figure in "What it costs" comes from one invocation of this file,
 * against `dist/`, which is what people install rather than what the tests
 * import.
 *
 * Method. Anything that reads a scope is timed INSIDE one, with the loop itself
 * running in the callback, because a read taken after `run()` returns would be
 * measuring the empty process defaults instead. Each case is warmed up, timed
 * over N iterations, and that cycle repeats, with the median reported: a single
 * timed loop on a laptop is largely a measurement of what else the machine was
 * doing.
 *
 *   npm run bench
 */
import { SpawnTrail } from "../dist/index.js";

const N = 200_000;
const WARMUP = 20_000;
const REPEATS = 7;

/** Four flat identifiers: the context a service should actually keep. */
const flat = () => ({ requestId: "8f1c3a2e", userId: "u42", tenant: "acme", route: "/pay" });
/** A request object in context: the shape to plan around if you keep one. */
const shaped = () => ({
  req: {
    id: "8f1c3a2e",
    headers: { accept: "application/json", "user-agent": "curl/8.4.0", host: "api.example.com" },
    user: { id: "u42", org: "acme" },
  },
});

/** Median nanoseconds per call of `op`, over REPEATS warmed loops of N. */
function time(op) {
  const runs = [];
  for (let r = 0; r < REPEATS; r++) {
    for (let i = 0; i < WARMUP; i++) op(i);
    const started = process.hrtime.bigint();
    for (let i = 0; i < N; i++) op(i);
    runs.push(Number(process.hrtime.bigint() - started) / N);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

/** Time an operation that needs an open scope, with the loop inside it. */
function timeInScope(seed, build, policy) {
  const trail = new SpawnTrail();
  if (policy) trail.redact({ paths: [policy] });
  let result = 0;
  trail.run(seed(), () => {
    result = time(build(trail));
  });
  return result;
}

/** The README writes sub-microsecond figures in ns and the rest in µs. */
const format = (ns) => (ns < 1000 ? `~${Math.round(ns / 5) * 5} ns` : `~${(ns / 1000).toFixed(1)} µs`);
const line = (label, cells) => console.log(`| ${label} | ${cells[0]} | ${cells[1]} |`);

/** Per-context paths, since the two contexts hold different things. */
const path = (seed) => (seed === flat ? "requestId" : "req.user.id");

const surfaces = {
  "winston format, per record": (trail) => {
    const fmt = trail.winston();
    return () => fmt.transform({ level: "info", message: "m" });
  },
  "pino mixin, per record": (trail) => {
    const mixin = trail.pino();
    return () => mixin();
  },
  "`bindings()`": (trail) => () => trail.bindings(),
};

console.log(`node ${process.version}, ${process.platform}/${process.arch}`);
console.log(`median of ${REPEATS} runs of ${N.toLocaleString("en-US")} iterations each\n`);

console.log("| | flat | request-shaped |");
console.log("|---|---|---|");

// Scope entry is the one case measured from OUTSIDE a scope, since it IS the
// entry. The instance and the seed are built once: constructing a SpawnTrail
// allocates an AsyncLocalStorage, and allocating the seed object is the
// caller's cost, not the library's. Timing either of those here would have put
// roughly a microsecond of somebody else's work in this row.
line(
  "`run()`, scope entry",
  [flat, shaped].map((seed) => {
    const trail = new SpawnTrail();
    const bindings = seed();
    return format(time(() => trail.run(bindings, () => {})));
  }),
);

line("`get()`, one path", [flat, shaped].map((seed) =>
  format(timeInScope(seed, (trail) => { const p = path(seed); return () => trail.get(p); })),
));

// A new key each iteration, so the write-once rule never short-circuits it.
line("`put()`, new key", [flat, shaped].map((seed) =>
  format(timeInScope(seed, (trail) => (i) => trail.put(`k${i}`, i))),
));

// Every per-record figure is measured ONCE and reused by both tables below.
// Measuring "winston, no policy" a second time for the redaction section is how
// the README ended up quoting two different numbers for one measurement: at this
// scale the run-to-run spread is wider than the effect being reported, so the
// only way the two tables agree is if they are the same measurement.
const rules = [
  ["no policy", null],
  ["policy that matches", (seed) => path(seed)],
  ["policy that matches nothing", () => "nothing.here"],
];
const results = {};
for (const [label, build] of Object.entries(surfaces)) {
  results[label] = {};
  for (const [kind, rule] of rules) {
    results[label][kind] = [flat, shaped].map((seed) =>
      timeInScope(seed, build, rule ? rule(seed) : null),
    );
  }
}

for (const label of Object.keys(surfaces)) {
  line(label, results[label]["no policy"].map(format));
}

// ── the redaction delta ─────────────────────────────────────────────────────
// A policy that matches nothing isolates the cost of the copy from the cost of
// the walk: the walk visits declared paths only, so a policy can grow without
// moving the number.
console.log("\n| redaction | flat | request-shaped |");
console.log("|---|---|---|");
for (const [label] of Object.entries(surfaces)) {
  const name = label.replace(", per record", "");
  for (const [kind] of rules) {
    line(`${name}, ${kind}`, results[label][kind].map(format));
  }
}
