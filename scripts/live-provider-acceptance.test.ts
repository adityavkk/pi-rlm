import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalStringify, type JsonValue } from "../src/core/json.ts";
import {
  LIVE_ACCEPTANCE_PURPOSE,
  LIVE_FIXTURE_DIGEST,
  LIVE_SUITE_DIGEST,
} from "../src/acceptance/live-contract.ts";
import { runLiveProviderAcceptance, type LiveRunnerDependencies } from "./live-provider-acceptance.ts";

const COMMIT = "1".repeat(40);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "pi-rlm-live-runner-"));
  directories.push(path);
  return path;
};

const consent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  purpose: LIVE_ACCEPTANCE_PURPOSE,
  version: 1,
  gitCommit: COMMIT,
  suiteDigest: LIVE_SUITE_DIGEST,
  fixtureDigest: LIVE_FIXTURE_DIGEST,
  issuedAtMs: 1_000,
  expiresAtMs: 2_000,
  nonce: "n".repeat(32),
  routes: [
    { provider: "provider-one", model: "model-one", apiFamily: "family-one" },
    { provider: "provider-two", model: "model-two", apiFamily: "family-two" },
  ],
  bounds: {
    maxInvocations: 4,
    maxOutputTokensPerInvocation: 100,
    maxAggregateTokens: 1_000,
    maxWallTimeMs: 10_000,
    maxPiCatalogEstimateUsd: 2,
  },
  ...overrides,
});

const writeConsent = async (path: string, value: unknown = consent()): Promise<void> => {
  await writeFile(path, canonicalStringify(value as JsonValue), { mode: 0o600 });
  await chmod(path, 0o600);
};

const refusalHarness = async (
  prepare: (consentPath: string, root: string) => Promise<void>,
  dependencyOverrides: Partial<LiveRunnerDependencies> = {},
): Promise<void> => {
  const root = await directory();
  const consentPath = join(root, "consent.json");
  const outputPath = join(root, "report.json");
  await prepare(consentPath, root);
  let providerCallbacks = 0;
  const dependencies: LiveRunnerDependencies = {
    gitCommit: () => COMMIT,
    nowMs: 1_500,
    loadSuite: async () => {
      providerCallbacks += 1;
      throw new Error("provider-capable callback must not run");
    },
    ...dependencyOverrides,
  };
  await expect(runLiveProviderAcceptance(["--consent", consentPath, "--output", outputPath], dependencies)).rejects.toBeDefined();
  expect(providerCallbacks).toBe(0);
  expect(await Bun.file(outputPath).exists()).toBe(false);
};

describe("live provider parent runner refusal boundary", () => {
  test("no consent and malformed consent invoke no provider-capable callback and create no output", async () => {
    await refusalHarness(async () => {});
    await refusalHarness(async (path) => { await writeFile(path, "{malformed", { mode: 0o600 }); });
  });

  test("expired, wrong commit, wrong suite digest, and wrong fixture digest fail before callback", async () => {
    await refusalHarness(async (path) => { await writeConsent(path, consent({ expiresAtMs: 1_500 })); });
    await refusalHarness(async (path) => { await writeConsent(path, consent({ gitCommit: "2".repeat(40) })); });
    await refusalHarness(async (path) => { await writeConsent(path, consent({ suiteDigest: "2".repeat(64) })); });
    await refusalHarness(async (path) => { await writeConsent(path, consent({ fixtureDigest: "3".repeat(64) })); });
  });

  test("symlink, wrong mode, and simulated wrong owner fail before callback", async () => {
    await refusalHarness(async (path, root) => {
      const target = join(root, "target.json");
      await writeConsent(target);
      await symlink(target, path);
    });
    await refusalHarness(async (path) => {
      await writeConsent(path);
      await chmod(path, 0o644);
    });
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("owner test requires POSIX getuid");
    await refusalHarness(async (path) => { await writeConsent(path); }, { consent: { currentUid: () => uid + 1 } });
  });

  test("consumption is one-shot and precedes the provider-capable callback", async () => {
    const root = await directory();
    const consentPath = join(root, "consent.json");
    const outputPath = join(root, "report.json");
    await writeConsent(consentPath);
    let callbacks = 0;
    const dependencies: LiveRunnerDependencies = {
      gitCommit: () => COMMIT,
      nowMs: 1_500,
      loadSuite: async () => {
        callbacks += 1;
        expect(await Bun.file(consentPath).exists()).toBe(false);
        throw Object.assign(new Error("phase 1"), { code: "SUITE_NOT_IMPLEMENTED" });
      },
    };
    await expect(runLiveProviderAcceptance(["--consent", consentPath, "--output", outputPath], dependencies))
      .rejects.toMatchObject({ code: "SUITE_NOT_IMPLEMENTED" });
    expect(callbacks).toBe(1);
    expect(await Bun.file(outputPath).exists()).toBe(false);

    callbacks = 0;
    await expect(runLiveProviderAcceptance(["--consent", consentPath, "--output", outputPath], dependencies)).rejects.toBeDefined();
    expect(callbacks).toBe(0);
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });

  test("valid authority reaches only the typed phase-1 placeholder and creates no output", async () => {
    const root = await directory();
    const consentPath = join(root, "consent.json");
    const outputPath = join(root, "report.json");
    await writeConsent(consentPath);
    await expect(runLiveProviderAcceptance(["--consent", consentPath, "--output", outputPath], {
      gitCommit: () => COMMIT,
      nowMs: 1_500,
    })).rejects.toMatchObject({ code: "SUITE_NOT_IMPLEMENTED" });
    expect(await Bun.file(consentPath).exists()).toBe(false);
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });

  test("argument shape hard-refuses before git or provider code", async () => {
    let gitCalls = 0;
    let providerCallbacks = 0;
    await expect(runLiveProviderAcceptance([], {
      gitCommit: () => { gitCalls += 1; return COMMIT; },
      loadSuite: async () => { providerCallbacks += 1; throw new Error("must not run"); },
    })).rejects.toMatchObject({ code: "ARGUMENTS_INVALID" });
    expect(gitCalls).toBe(0);
    expect(providerCallbacks).toBe(0);
  });
});
