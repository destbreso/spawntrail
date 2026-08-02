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
 * Run after `npm run build`. Loads both the ESM and the CJS bundle, from the
 * paths `package.json` actually points at.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

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
  "clone",
  "isForbiddenKey",
  "setViolationHandler",
  "resetViolationWarning",
  "CLONE_DEPTH_LIMIT",
  "CLONE_NODE_LIMIT",
  "TRUNCATED",
  "UNREADABLE",
];

const esm = await import(pathToFileURL(resolve(root, pkg.exports["."].import)).href);
const cjs = createRequire(import.meta.url)(resolve(root, pkg.exports["."].require));

for (const name of REQUIRED_VALUES) {
  check(`ESM export ${name}`, esm[name] !== undefined);
  check(`CJS export ${name}`, cjs[name] !== undefined);
}

const types = readFileSync(resolve(root, pkg.exports["."].types), "utf8");
for (const name of REQUIRED_VALUES) {
  check(`declared in .d.ts: ${name}`, types.includes(name));
}

// The hook must survive bundling. If the setter is unreachable a bundler can
// prove the handler is always undefined and delete the call site, which is
// exactly what happened once.
const bundle = readFileSync(resolve(root, pkg.exports["."].import), "utf8");
check("the violation call site survives bundling", /onViolation\w*\s*\(/.test(bundle), "the hook was tree-shaken away");

// And the whole point of it: an installed handler observes a real refusal,
// through the published entry point.
if (typeof esm.setViolationHandler === "function" && typeof esm.SpawnTrail === "function") {
  const seen = [];
  esm.setViolationHandler((event) => seen.push(event.reason));
  const probe = new esm.SpawnTrail();
  probe.run(() => probe.put("__proto__.x", 1));
  esm.setViolationHandler(undefined);
  check("an installed handler sees a refusal", seen.includes("forbidden-key"), `saw ${JSON.stringify(seen)}`);
  check("no pollution through the published bundle", {}.x === undefined);
} else {
  check("the refusal probe could run", false, "setViolationHandler or SpawnTrail is missing from the bundle");
}

if (failures.length > 0) {
  console.error(`verify-package: ${failures.length} problem(s) with the published surface`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`verify-package: ${REQUIRED_VALUES.length} exports present in ESM, CJS and .d.ts; hook live in the bundle`);
