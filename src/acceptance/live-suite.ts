import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import {
  LIVE_FIXTURE_DIGEST, LIVE_SUITE_DIGEST, MAX_LIVE_REPORT_BYTES,
  parseLiveReport, parseLiveWorkerRouteReportText,
  type LiveAcceptanceReport, type LiveConsent, type LiveReportAccounting, type LiveRouteReport,
} from "./live-contract.ts";
import { assertLivePlanWithinConsent, expandLiveRoutePlan, routeWorkerBounds } from "./live-plan.ts";
import {
  canonicalLiveWorkerRequest, liveRouteDigest, type LiveWorkerRequest,
} from "./live-worker-contract.ts";

export interface LiveSuiteInput {
  readonly consent: LiveConsent;
  readonly canaries: readonly string[];
  readonly verifyRevision?: () => void;
}
export interface LiveChildOutcome {
  readonly exitCode: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly timedOut: boolean;
}
export interface LiveChildInput {
  readonly requestPath: string;
  readonly resultPath: string;
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly bunConfigPath: string;
}
export interface LiveSuiteDependencies {
  readonly now?: () => number;
  readonly makeRoot?: () => Promise<string>;
  readonly runChild?: (input: LiveChildInput) => Promise<LiveChildOutcome>;
  /** Test-only contained worker replacement and tighter timeout. */
  readonly workerPath?: string;
  readonly childTimeoutMs?: number;
  /** Test-only source environment replacement. */
  readonly sourceEnvironment?: Readonly<Record<string, string | undefined>>;
}

export class LiveSuiteError extends Error {
  readonly code:
    | "LIVE_PLAN_OUTSIDE_AUTHORITY"
    | "CHILD_FAILED"
    | "CHILD_TIMEOUT"
    | "CHILD_OUTPUT"
    | "CHILD_REPORT_INVALID"
    | "CHILD_CONTAINMENT_FAILED";
  constructor(code: LiveSuiteError["code"], message: string) {
    super(message);
    this.name = "LiveSuiteError";
    this.code = code;
  }
}

const boundedDrain = async (stream: ReadableStream<Uint8Array> | null, bound = 4_096): Promise<number> => {
  if (!stream) return 0;
  const reader = stream.getReader();
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes = Math.min(bound + 1, bytes + item.value.byteLength);
    }
  } finally { reader.releaseLock(); }
  return bytes;
};

const defaultRunChild = async (input: LiveChildInput, workerPath?: string): Promise<LiveChildOutcome> => {
  const worker = workerPath ?? new URL("../../scripts/live-provider-worker.ts", import.meta.url).pathname;
  const child = Bun.spawn([
    process.execPath, "--no-env-file", `--config=${input.bunConfigPath}`,
    worker, "--request", input.requestPath, "--result", input.resultPath,
  ], {
    cwd: input.cwd,
    env: input.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = boundedDrain(child.stdout);
  const stderr = boundedDrain(child.stderr);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), input.timeoutMs);
  });
  const outcome = await Promise.race([child.exited.then(() => "exit" as const), timeout]);
  if (outcome === "timeout") {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
  const exitCode = await child.exited;
  if (timer) clearTimeout(timer);
  return { exitCode, stdoutBytes: await stdout, stderrBytes: await stderr, timedOut };
};

const PROVIDER_ENVIRONMENT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: ["ANTHROPIC_API_KEY"],
  "ant-ling": ["ANT_LING_API_KEY"],
  "azure-openai-responses": [
    "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  ],
  openai: ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
  "amazon-bedrock": [
    "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_BEDROCK_SKIP_AUTH", "AWS_BEDROCK_FORCE_HTTP1",
  ],
  mistral: ["MISTRAL_API_KEY"], groq: ["GROQ_API_KEY"], cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
  xai: ["XAI_API_KEY"], openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"], zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"], opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"], radius: ["RADIUS_API_KEY"],
  huggingface: ["HF_TOKEN"], fireworks: ["FIREWORKS_API_KEY"], together: ["TOGETHER_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"], minimax: ["MINIMAX_API_KEY"], "minimax-cn": ["MINIMAX_CN_API_KEY"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"], "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"], "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
});
const BASE_WORKER_ENVIRONMENT = [
  "PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "PI_CACHE_RETENTION",
] as const;
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FORBIDDEN_ENVIRONMENT_NAME = /^(?:HOME|TMPDIR|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_PACKAGE_DIR|PI_TELEMETRY|PI_SKIP_VERSION_CHECK|NODE_OPTIONS|BUN_OPTIONS|BUN_CONFIG_.*|BUN_RUNTIME_TRANSPILER_CACHE_PATH|LD_PRELOAD|DYLD_.*)$/;

const credentialEnvironmentNames = (value: unknown): readonly string[] => {
  const names = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/g)) {
        const name = match[1] ?? match[2];
        if (name && SAFE_ENVIRONMENT_NAME.test(name) && !FORBIDDEN_ENVIRONMENT_NAME.test(name)) names.add(name);
      }
      return;
    }
    if (Array.isArray(item)) { for (const entry of item) visit(entry); return; }
    if (typeof item === "object" && item !== null)
      for (const entry of Object.values(item as Readonly<Record<string, unknown>>)) visit(entry);
  };
  visit(value);
  if (names.size > 32) throw new LiveSuiteError("CHILD_CONTAINMENT_FAILED", "route credential references too many variables");
  return [...names].sort();
};

const readRouteCredential = async (
  provider: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<unknown | undefined> => {
  const agentDir = environment["PI_CODING_AGENT_DIR"]
    ? resolve(environment["PI_CODING_AGENT_DIR"]!)
    : environment["HOME"] ? join(resolve(environment["HOME"]!), ".pi", "agent") : undefined;
  if (!agentDir) return undefined;
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new LiveSuiteError("CHILD_CONTAINMENT_FAILED", "no-follow auth reads are unavailable");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(join(agentDir, "auth.json"), constants.O_RDONLY | noFollow);
    const stat = await handle.stat({ bigint: true });
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1n || (Number(stat.mode) & 0o7777) !== 0o600
      || uid === undefined || stat.uid !== BigInt(uid) || stat.size > 1024n * 1024n)
      throw new LiveSuiteError("CHILD_CONTAINMENT_FAILED", "source auth metadata is invalid");
    const bytes = new Uint8Array(Number(stat.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== Number(stat.size) || after.dev !== stat.dev || after.ino !== stat.ino
      || after.size !== stat.size || after.mode !== stat.mode || after.uid !== stat.uid || after.nlink !== stat.nlink
      || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs)
      throw new LiveSuiteError("CHILD_CONTAINMENT_FAILED", "source auth changed while read");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new LiveSuiteError("CHILD_CONTAINMENT_FAILED", "source auth data is invalid");
    return Object.prototype.hasOwnProperty.call(parsed, provider)
      ? (parsed as Readonly<Record<string, unknown>>)[provider] : undefined;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { readonly code?: unknown }).code : undefined;
    if (code === "ENOENT") return undefined;
    if (error instanceof LiveSuiteError) throw error;
    throw new LiveSuiteError("CHILD_CONTAINMENT_FAILED", "source auth could not be filtered");
  } finally { await handle?.close().catch(() => {}); }
};

const routeWorkerEnvironment = async (
  root: string,
  index: number,
  provider: string,
  source: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<Record<string, string>>> => {
  const home = join(root, `route-${index + 1}.home`);
  const agentDir = join(home, ".pi", "agent");
  const temporary = join(home, "tmp");
  for (const path of [home, join(home, ".pi"), agentDir, temporary]) await mkdir(path, { mode: 0o700 });
  await secureWrite(join(home, "bunfig.toml"), "");
  const credential = await readRouteCredential(provider, source);
  if (credential !== undefined)
    await secureWrite(join(agentDir, "auth.json"), canonicalStringify({ [provider]: credential } as JsonValue));
  const allowed = new Set<string>([
    ...BASE_WORKER_ENVIRONMENT, ...(PROVIDER_ENVIRONMENT[provider] ?? []),
    ...credentialEnvironmentNames(credential),
  ]);
  const environment: Record<string, string> = {
    HOME: home, TMPDIR: temporary, PI_CODING_AGENT_DIR: agentDir,
    PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
  };
  for (const name of allowed) {
    const value = source[name];
    if (typeof value === "string") environment[name] = value;
  }
  return Object.freeze(environment);
};

const secureWrite = async (path: string, text: string): Promise<void> => {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
};

const secureRead = async (path: string): Promise<string> => {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new LiveSuiteError("CHILD_CONTAINMENT_FAILED", "no-follow reads are unavailable");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    const stat = await handle.stat({ bigint: true });
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1n || (Number(stat.mode) & 0o7777) !== 0o600
      || uid === undefined || stat.uid !== BigInt(uid) || stat.size > BigInt(MAX_LIVE_REPORT_BYTES))
      throw new LiveSuiteError("CHILD_REPORT_INVALID", "child report metadata is invalid");
    const bytes = new Uint8Array(Number(stat.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== Number(stat.size)) throw new LiveSuiteError("CHILD_REPORT_INVALID", "child report changed while read");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } catch (error) {
    if (error instanceof LiveSuiteError) throw error;
    throw new LiveSuiteError("CHILD_REPORT_INVALID", "child report could not be read");
  } finally { await handle?.close().catch(() => {}); }
};

const totalAccounting = (routes: readonly LiveRouteReport[]): LiveReportAccounting => ({
  invocations: routes.reduce((sum, item) => sum + item.invocations, 0),
  intents: routes.reduce((sum, item) => sum + item.intents, 0),
  settlements: routes.reduce((sum, item) => sum + item.settlements, 0),
  attempts: routes.reduce((sum, item) => sum + item.attempts, 0),
  inputTokens: routes.reduce((sum, item) => sum + item.inputTokens, 0),
  outputTokens: routes.reduce((sum, item) => sum + item.outputTokens, 0),
  aggregateTokens: routes.reduce((sum, item) => sum + item.aggregateTokens, 0),
  piCatalogEstimateUsd: routes.reduce((sum, item) => sum + item.piCatalogEstimateUsd, 0),
  providerDurationMs: routes.reduce((sum, item) => sum + item.providerDurationMs, 0),
  wallDurationMs: routes.reduce((sum, item) => sum + item.wallDurationMs, 0),
  outputBytes: routes.reduce((sum, item) => sum + item.outputBytes, 0),
  maxConcurrency: Math.max(...routes.map((item) => item.maxConcurrency)),
  sourceSentinelHits: routes.reduce((sum, item) => sum + item.sourceSentinelHits, 0),
  cancellationUsage: routes.some((item) => item.cancellationUsage.status === "unknown_after_cancel")
    ? { status: "unknown_after_cancel" }
    : { status: "not_cancelled" },
});

export const runLiveProviderAcceptanceSuite = async (
  input: LiveSuiteInput,
  dependencies: LiveSuiteDependencies = {},
): Promise<LiveAcceptanceReport> => {
  const now = dependencies.now ?? Date.now;
  input.verifyRevision?.();
  const startedAtMs = now();
  let plan;
  try { plan = assertLivePlanWithinConsent(input.consent); }
  catch { throw new LiveSuiteError("LIVE_PLAN_OUTSIDE_AUTHORITY", "fixed suite exceeds consent bounds"); }
  const root = await (dependencies.makeRoot ?? (() => mkdtemp(join(tmpdir(), "pi-rlm-live-suite-"))))();
  const runChild = dependencies.runChild
    ?? ((childInput: LiveChildInput) => defaultRunChild(childInput, dependencies.workerPath));
  const sourceEnvironment = dependencies.sourceEnvironment ?? process.env;
  try {
    await chmod(root, 0o700);
    const rootStat = await lstat(root, { bigint: true });
    if (!rootStat.isDirectory() || (Number(rootStat.mode) & 0o7777) !== 0o700 || rootStat.nlink < 1n)
      throw new LiveSuiteError("CHILD_CONTAINMENT_FAILED", "suite root is not private");
    const routes: LiveRouteReport[] = [];
    let usedInvocations = 0;
    let usedTokens = 0;
    let usedEstimate = 0;
    for (let index = 0; index < 2; index++) {
      const reserveTokens = index === 0 ? plan.estimatedAggregateTokens : 0;
      const elapsed = Math.max(0, now() - startedAtMs);
      const bounds = {
        ...routeWorkerBounds(
          input.consent.bounds,
          input.consent.bounds.maxInvocations - usedInvocations,
          input.consent.bounds.maxAggregateTokens - usedTokens - reserveTokens,
          input.consent.bounds.maxWallTimeMs - elapsed,
        ),
        // Preserve a positive share of the post-reported estimate ceiling for
        // every remaining route. This is not a billed-cost guarantee.
        maxPiCatalogEstimateUsd: (input.consent.bounds.maxPiCatalogEstimateUsd - usedEstimate) / (2 - index),
      };
      const route = input.consent.routes[index]!;
      const request: LiveWorkerRequest = {
        version: 1, gitCommit: input.consent.gitCommit,
        suiteDigest: LIVE_SUITE_DIGEST, fixtureDigest: LIVE_FIXTURE_DIGEST,
        route, routeDigestNonce: input.consent.nonce,
        routeDigest: liveRouteDigest(route, input.consent.nonce), bounds,
      };
      const requestPath = join(root, `route-${index + 1}.request.json`);
      const resultPath = join(root, `route-${index + 1}.report.json`);
      await secureWrite(requestPath, canonicalLiveWorkerRequest(request));
      const environment = await routeWorkerEnvironment(root, index, route.provider, sourceEnvironment);
      input.verifyRevision?.();
      const child = await runChild({
        requestPath, resultPath, environment,
        cwd: environment["HOME"]!, bunConfigPath: join(environment["HOME"]!, "bunfig.toml"),
        timeoutMs: Math.min(bounds.maxWallTimeMs, dependencies.childTimeoutMs ?? bounds.maxWallTimeMs),
      });
      if (child.timedOut) throw new LiveSuiteError("CHILD_TIMEOUT", "route child exceeded its wall bound");
      if (child.stdoutBytes !== 0 || child.stderrBytes !== 0) throw new LiveSuiteError("CHILD_OUTPUT", "route child emitted process output");
      if (child.exitCode !== 0) throw new LiveSuiteError("CHILD_FAILED", "route child failed");
      input.verifyRevision?.();
      const parsed = parseLiveWorkerRouteReportText(await secureRead(resultPath), input.canaries);
      if (parsed.routeDigest !== request.routeDigest) throw new LiveSuiteError("CHILD_REPORT_INVALID", "route child identity mismatch");
      if (parsed.invocations > bounds.maxInvocations || parsed.aggregateTokens > bounds.maxAggregateTokens
        || parsed.piCatalogEstimateUsd > bounds.maxPiCatalogEstimateUsd || parsed.wallDurationMs > bounds.maxWallTimeMs
        || parsed.outputTokens > parsed.invocations * bounds.maxOutputTokensPerInvocation)
        throw new LiveSuiteError("CHILD_REPORT_INVALID", "route child exceeded its delegated bounds");
      const aliased = { alias: index === 0 ? "route-1" : "route-2", ...parsed } as LiveRouteReport;
      routes.push(aliased);
      usedInvocations += parsed.invocations;
      usedTokens += parsed.aggregateTokens;
      usedEstimate += parsed.piCatalogEstimateUsd;
      if (usedInvocations > input.consent.bounds.maxInvocations || usedTokens > input.consent.bounds.maxAggregateTokens
        || usedEstimate > input.consent.bounds.maxPiCatalogEstimateUsd)
        throw new LiveSuiteError("CHILD_REPORT_INVALID", "route child exceeded aggregate authority");
    }
    const tuple = routes as [LiveRouteReport, LiveRouteReport];
    const durationMs = Math.max(0, Math.floor(now() - startedAtMs));
    input.verifyRevision?.();
    const report: LiveAcceptanceReport = {
      version: 1, gitCommit: input.consent.gitCommit, suiteDigest: LIVE_SUITE_DIGEST,
      fixtureDigest: LIVE_FIXTURE_DIGEST,
      code: tuple.every((item) => item.code === "PASS") ? "PASS" : "ACCEPTANCE_FAILED",
      startedAtMs, durationMs, routes: tuple, totals: totalAccounting(tuple),
    };
    return parseLiveReport(report);
  } finally {
    try {
      await rm(root, { recursive: true, force: true });
      await lstat(root);
      throw new LiveSuiteError("CHILD_CONTAINMENT_FAILED", "suite root survived cleanup");
    } catch (error) {
      if (error instanceof LiveSuiteError) throw error;
      const code = error && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code : undefined;
      if (code !== "ENOENT")
        throw new LiveSuiteError("CHILD_CONTAINMENT_FAILED", "suite root cleanup failed");
    }
  }
};

export const canonicalLiveSuitePlan = (): string =>
  canonicalStringify(expandLiveRoutePlan() as unknown as JsonValue);
