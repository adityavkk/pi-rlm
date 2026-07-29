import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLiveReportText } from "../src/acceptance/live-contract.ts";

const root = resolve(import.meta.dir, "..");
class ReleaseCheckError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ReleaseCheckError"; }
}
const fail = (code: string): never => { throw new ReleaseCheckError(code); };
const run = (command: readonly string[]): string => {
  const result = Bun.spawnSync(command, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail("RELEASE_COMMAND_FAILED");
  return result.stdout.toString("utf8");
};

const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  readonly name?: unknown; readonly version?: unknown; readonly private?: unknown;
  readonly packageManager?: unknown; readonly engines?: { readonly bun?: unknown };
};
if (manifest.name !== "pi-rlm" || manifest.version !== "0.1.0" || manifest.private !== true)
  fail("RELEASE_IDENTITY_INVALID");
if (manifest.packageManager !== "bun@1.3.14" || manifest.engines?.bun !== ">=1.3.14 <2")
  fail("RELEASE_TOOLCHAIN_INVALID");
if (process.env["GITHUB_REF_TYPE"] === "tag") {
  const tag = process.env["GITHUB_REF_NAME"];
  if (tag !== `v${manifest.version}`) fail("RELEASE_TAG_INVALID");
  if (run(["git", "cat-file", "-t", `refs/tags/${tag}`]).trim() !== "tag") fail("RELEASE_TAG_INVALID");
  if (run(["git", "rev-parse", `refs/tags/${tag}^{}`]).trim()
    !== run(["git", "rev-parse", "HEAD"]).trim()) fail("RELEASE_TAG_INVALID");
}

const tracked = run(["git", "ls-files", "-z"]).split("\0").filter(Boolean);
const forbiddenPath = /(^|\/)(?:\.env(?:\.|$)|credentials\.json$|auth\.json$|\.tmp(?:\/|$)|\.rlm-runs(?:\/|$)|node_modules(?:\/|$))|\.(?:pem|key|p12|pfx|log)$/i;
const secretPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}/;
for (const path of tracked) {
  if (forbiddenPath.test(path)) fail("RELEASE_FORBIDDEN_PATH");
  const bytes = readFileSync(resolve(root, path));
  if (bytes.includes(0)) continue;
  if (secretPattern.test(bytes.toString("utf8"))) fail("RELEASE_SECRET_PATTERN");
}

for (const path of tracked.filter((item) => /^docs\/evidence\/live-provider-acceptance-[a-f0-9]+\.json$/.test(item))) {
  const report = parseLiveReportText(readFileSync(resolve(root, path), "utf8"));
  const suffix = path.match(/-([a-f0-9]+)\.json$/)?.[1];
  if (!suffix || !report.gitCommit.startsWith(suffix)) fail("RELEASE_EVIDENCE_IDENTITY");
}

const packed = JSON.parse(run(["npm", "pack", "--dry-run", "--json"])) as Array<{
  readonly size?: unknown; readonly unpackedSize?: unknown; readonly entryCount?: unknown;
  readonly files?: ReadonlyArray<{ readonly path?: unknown }>;
}>;
if (packed.length !== 1) fail("RELEASE_PACK_INVALID");
const artifact = packed[0]!;
if (typeof artifact.size !== "number" || artifact.size > 1_500_000
  || typeof artifact.unpackedSize !== "number" || artifact.unpackedSize > 6_000_000
  || typeof artifact.entryCount !== "number" || artifact.entryCount > 350
  || !Array.isArray(artifact.files)) fail("RELEASE_PACK_BOUNDS");
const paths = new Set(artifact.files.map((item) => item.path).filter((path): path is string => typeof path === "string"));
for (const required of [
  "index.ts", "src/core/index.ts", "src/runtime/index.ts", "src/shell/delegation/index.ts",
  "scripts/smoke-packed-install.sh", "scripts/live-provider-acceptance.ts", "scripts/run-live-provider-acceptance.sh",
  "tsconfig.json", "bun.lock",
  "docs/evidence/live-provider-acceptance-5594641.json", "LICENSE", "README.md",
]) if (!paths.has(required)) fail("RELEASE_PACK_MISSING");
for (const path of paths) if (forbiddenPath.test(path)) fail("RELEASE_PACK_FORBIDDEN");

console.log(JSON.stringify({
  code: "RELEASE_CHECK_PASS",
  trackedFiles: tracked.length,
  packedFiles: artifact.entryCount,
  packedBytes: artifact.size,
  unpackedBytes: artifact.unpackedSize,
}));
