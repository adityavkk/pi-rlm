import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const verifyPinnedDependencies = (): void => {
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
};

/** Verify tracked source and exact installed public-Pi package versions. */
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
