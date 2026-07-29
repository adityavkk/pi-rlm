import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const GIT_COMMIT = /^[a-f0-9]{40}$/;
const PINNED_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "pi-subagents",
  "typebox",
] as const;
const repository = resolve(import.meta.dir, "..", "..");
const LIVE_DEPENDENCY_TREE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "c4f80a4e1aba3ba5b4cb81ab52928f385b6983381e99bd914408fbb639bc560b",
});

export class LiveRevisionError extends Error {
  readonly code = "GIT_COMMIT_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "LiveRevisionError";
  }
}

export interface LiveRevisionDependencies {
  readonly git?: (args: readonly string[]) => string;
  readonly verifyDependencies?: () => void;
}

const git = (args: readonly string[]): string => execFileSync("git", ["-C", repository, ...args], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
}).trim();

const packageVersion = (path: string): string => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)
    || typeof (parsed as { readonly version?: unknown }).version !== "string")
    throw new LiveRevisionError("pinned dependency metadata is invalid");
  return (parsed as { readonly version: string }).version;
};

export const liveDependencyTreeSha256 = (root = resolve(repository, "node_modules")): string => {
  const hash = createHash("sha256");
  const visit = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name);
      const normalized = relative(root, absolute).split("\\").join("/");
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        hash.update(`d\0${normalized}\0`);
        visit(absolute);
      } else if (stat.isFile()) {
        hash.update(`f\0${normalized}\0${stat.size}\0`);
        hash.update(readFileSync(absolute));
      } else if (stat.isSymbolicLink()) {
        hash.update(`l\0${normalized}\0${readlinkSync(absolute)}\0`);
      } else throw new LiveRevisionError("installed dependency tree contains an unsupported entry");
    }
  };
  visit(root);
  return hash.digest("hex");
};

const verifyPinnedDependencies = (): void => {
  if (Bun.version !== "1.3.14") throw new LiveRevisionError("live acceptance requires Bun 1.3.14");
  const manifest = JSON.parse(readFileSync(resolve(repository, "package.json"), "utf8")) as {
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  for (const name of PINNED_PACKAGES) {
    const expected = manifest.devDependencies?.[name];
    if (!expected || !/^\d+\.\d+\.\d+$/.test(expected))
      throw new LiveRevisionError("live dependency is not exactly pinned");
    const actual = packageVersion(resolve(repository, "node_modules", name, "package.json"));
    if (actual !== expected) throw new LiveRevisionError("installed live dependency does not match its pin");
  }
  const expectedTree = LIVE_DEPENDENCY_TREE_SHA256[`${process.platform}-${process.arch}`];
  if (!expectedTree || liveDependencyTreeSha256() !== expectedTree)
    throw new LiveRevisionError("installed live dependency content does not match the release tree");
};

/** Verify tracked source plus exact installed public-Pi versions and dependency bytes. */
export const verifyLiveRepositoryRevision = (
  expected: string,
  dependencies: LiveRevisionDependencies = {},
): void => {
  if (!GIT_COMMIT.test(expected)) throw new LiveRevisionError("expected live revision is invalid");
  const runGit = dependencies.git ?? git;
  try {
    runGit(["diff", "--quiet", "HEAD", "--"]);
    if (runGit(["rev-parse", "--verify", "HEAD"]) !== expected)
      throw new LiveRevisionError("live suite revision changed");
    (dependencies.verifyDependencies ?? verifyPinnedDependencies)();
  } catch (error) {
    if (error instanceof LiveRevisionError) throw error;
    throw new LiveRevisionError("clean pinned live suite revision is unavailable");
  }
};

export const currentLiveRepositoryRevision = (): string => {
  let commit: string;
  try { commit = git(["rev-parse", "--verify", "HEAD"]); }
  catch { throw new LiveRevisionError("live suite revision is unavailable"); }
  verifyLiveRepositoryRevision(commit);
  return commit;
};
