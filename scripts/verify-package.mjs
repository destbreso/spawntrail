/**
 * verify-package: check the artifact that ships, not the one under test.
 *
 * Every test in this repo imports from `src/`, a path that is never published.
 * That is how a violation hook got written, tested, documented and shipped dead:
 * it was not re-exported from the entry point, so the bundler proved the handler
 * was always undefined, removed the call, and left a warning telling users to
 * install a function the package does not export. A green suite said nothing
 * about it, because a green suite was never looking at the package.
 *
 * It is also why this compiles a consumer instead of grepping the declaration
 * files. An earlier version asserted `types.includes(name)`, a raw substring
 * test that passes for a name that is not declared at all, and it sat green over
 * a published `exports` map that made the package unimportable from any
 * CommonJS TypeScript project.
 *
 * Run after `npm run build`, or as `npm run verify:package`.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) return;
  failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

const REQUIRED_VALUES = [
  "SpawnTrail",
  "trail",
  "spawntrail",
  "getPath",
  "setPath",
  "delPath",
  "deepMerge",
  "deepMergeKeeping",
  "clone",
  "isForbiddenKey",
  "setViolationHandler",
  "resetViolationWarning",
  "CLONE_DEPTH_LIMIT",
  "CLONE_WORK_LIMIT",
  "TRUNCATED",
  "UNREADABLE",
  "jsonSafe",
  "ENVELOPE_KEY",
];

// Read the entry defensively. The shape of `exports` is one of the things under
// test, so this must be able to report a bad one rather than die on it.
const entry = pkg.exports?.["."] ?? {};
check("the otel subpath is published", pkg.exports?.["./otel"] !== undefined);
check("@opentelemetry/api is an OPTIONAL peer, so the main entry stays dependency-free",
  pkg.peerDependenciesMeta?.["@opentelemetry/api"]?.optional === true);
check("nothing is a hard runtime dependency", Object.keys(pkg.dependencies ?? {}).length === 0);
const target = (condition, fallback) => {
  const value = entry[condition];
  const file = typeof value === "string" ? value : value?.default;
  return resolve(root, file ?? fallback);
};
const esmPath = target("import", pkg.module);
const cjsPath = target("require", pkg.main);
check("exports declares types per condition, so a CommonJS consumer gets .d.cts", typeof entry.types !== "string");

const esm = await import(pathToFileURL(esmPath).href);
const cjs = createRequire(import.meta.url)(cjsPath);

for (const name of REQUIRED_VALUES) {
  check(`ESM export ${name}`, esm[name] !== undefined);
  check(`CJS export ${name}`, cjs[name] !== undefined);
}

// The hook must survive bundling in BOTH artifacts. If the setter is unreachable
// a bundler can prove the handler is always undefined and delete the call site,
// which is what happened the first time.
for (const [label, file] of [
  ["ESM", esmPath],
  ["CJS", cjsPath],
]) {
  const bundle = readFileSync(file, "utf8");
  check(`${label}: the violation call site survives bundling`, /onViolation\w*\s*\(/.test(bundle));
}

// The point of the hook: an installed handler observes real refusals, through
// each published entry point, and nothing leaks to Object.prototype.
for (const [label, mod] of [
  ["ESM", esm],
  ["CJS", cjs],
]) {
  if (typeof mod.setViolationHandler !== "function" || typeof mod.SpawnTrail !== "function") {
    check(`${label}: the refusal probe could run`, false, "setViolationHandler or SpawnTrail is missing");
    continue;
  }
  const seen = [];
  mod.setViolationHandler((event) => seen.push(event.reason));
  const probe = new mod.SpawnTrail();
  probe.run(() => {
    probe.put("__proto__.x", 1);
    probe.put("actor", "alice");
    probe.put("actor", "bob");
  });
  mod.setViolationHandler(undefined);
  check(`${label}: a handler sees a refused key`, seen.includes("forbidden-key"), `saw ${JSON.stringify(seen)}`);
  check(`${label}: a handler sees a refused change`, seen.includes("immutable"), `saw ${JSON.stringify(seen)}`);
  check(`${label}: no pollution through the published bundle`, {}.x === undefined);
}

// Compile a real consumer against the published types, under the resolution
// TypeScript tells everyone to use. A substring grep cannot see TS1479.
const sandbox = mkdtempSync(join(tmpdir(), "spawntrail-surface-"));
try {
  // Resolve by PACKAGE NAME, through node_modules, which is the only way the
  // `exports` map is consulted at all. Importing the directory by path resolves
  // through `main`/`types` instead and would quietly test something else.
  mkdirSync(join(sandbox, "node_modules"), { recursive: true });
  symlinkSync(root, join(sandbox, "node_modules", pkg.name), "dir");
  writeFileSync(
    join(sandbox, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "node16",
        moduleResolution: "node16",
        target: "es2022",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      files: ["esm.mts", "cjs.cts"],
    }),
  );
  const consumer = (name) => `
import { SpawnTrail, setViolationHandler, CLONE_WORK_LIMIT } from ${JSON.stringify(pkg.name)};
import { otel } from ${JSON.stringify(pkg.name + "/otel")};
void otel;
const ${name} = new SpawnTrail({ defaults: { service: "api" } });
setViolationHandler((event) => { const reason: string = event.reason; void reason; void event.current; });
${name}.use(() => ({ pid: 1 }));
const snap = ${name}.snapshot();
${name}.restore(snap, { kind: "queue", name: "q" }, () => { void ${name}.unstamp(${name}.stamp({ a: 1 })); });
${name}.run({ requestId: "r" }, () => { ${name}.put("a.b", 1); void ${name}.get("a.b"); });
void CLONE_WORK_LIMIT;
`;
  writeFileSync(join(sandbox, "esm.mts"), consumer("esm"));
  writeFileSync(join(sandbox, "cjs.cts"), consumer("cjs"));
  try {
    execFileSync(process.execPath, [resolve(root, "node_modules/typescript/lib/tsc.js"), "-p", sandbox], {
      stdio: "pipe",
    });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    check(
      "an ESM and a CommonJS TypeScript consumer both compile",
      false,
      output.split("\n").slice(0, 6).join(" | "),
    );
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`verify-package: ${failures.length} problem(s) with the published surface`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `verify-package: ${REQUIRED_VALUES.length} exports live in ESM and CJS, refusals observable from both, ` +
    "and an ESM and a CommonJS TypeScript consumer both compile against the published types",
);
