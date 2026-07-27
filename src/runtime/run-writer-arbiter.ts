/**
 * Internal-only writer/retention arbitration core. Not exported from the runtime surface.
 * Ownership is restricted to the main thread/default Node realm. The process-attached registry
 * coordinates cooperating module copies; the filesystem protocol is not a same-user sandbox.
 */

import { randomBytes } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import {
  MAX_ARBITRATION_ORDINAL,
  MAX_ARBITRATION_ORPHANS,
  encodeGenerationRecord,
  encodeReleaseRecord,
  generationIntentFilename,
  releaseIntentFilename,
  scanArbitrationDirectory,
  type ArbitrationChain,
  type ArbitrationRole,
  type GenerationRecord,
  type ReleaseRecord,
} from "./run-writer-protocol.ts";
import {
  publishImmutableArbitrationRecord,
  type ArbitrationPublicationInput,
  type ArbitrationPublicationOptions,
  type ArbitrationPublicationResult,
  type ImmutablePublicationGuard,
  type ImmutablePublisherFileSystem,
} from "./run-writer-publisher.ts";
import { RunWriterScheduler } from "./run-writer-scheduler.ts";
import {
  PinnedRunWriterIdentity,
  RunWriterIdentityError,
  type ArbitrationDirectoryIdentity,
} from "./run-writer-identity.ts";
import {
  isRunWriterLivenessResult,
  nodeRunWriterLivenessProbe,
  type RunWriterLivenessProbe,
  type RunWriterLivenessResult,
} from "./run-writer-liveness.ts";

const TOKEN = /^[a-f0-9]{64}$/;
const OS_IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;
export type RunWriterAcquisitionRole = Exclude<ArbitrationRole, "retirement">;

export type RunWriterArbiterErrorCode =
  | "WRITER_ARBITER_INPUT"
  | "WRITER_ARBITER_UNSUPPORTED_REALM"
  | "WRITER_ARBITER_NO_AUTHORITY"
  | "WRITER_ARBITER_ALREADY_OWNED"
  | "WRITER_ARBITER_BUSY"
  | "WRITER_ARBITER_AMBIGUOUS"
  | "WRITER_ARBITER_ORDINAL_EXHAUSTED"
  | "WRITER_ARBITER_ELECTION_LOST"
  | "WRITER_ARBITER_PENDING_CONFLICT"
  | "WRITER_ARBITER_FENCED"
  | "WRITER_ARBITER_RELEASE_CONFLICT";

export class RunWriterArbiterError extends Error {
  override readonly name = "RunWriterArbiterError";
  constructor(
    readonly code: RunWriterArbiterErrorCode,
    message: string,
    override readonly cause?: unknown,
    readonly liveness?: RunWriterLivenessResult,
  ) { super(message); }
}

export interface AcquireRunWriterLeaseInput {
  readonly managedRoot: string;
  readonly runName: string;
  readonly role: RunWriterAcquisitionRole;
}

export interface RunWriterArbiterOptions {
  readonly now?: () => number;
  readonly createToken?: () => string;
  readonly osProcessIdentity?: string | null;
  readonly livenessProbe?: RunWriterLivenessProbe;
  readonly scan?: (directory: string) => Promise<ArbitrationChain>;
  readonly publish?: (
    input: ArbitrationPublicationInput,
    options?: ArbitrationPublicationOptions,
  ) => Promise<ArbitrationPublicationResult>;
  readonly publisherFileSystem?: ImmutablePublisherFileSystem;
  readonly publicationGuard?: ImmutablePublicationGuard;
}

interface ResolvedOptions {
  readonly now: () => number;
  readonly createToken: () => string;
  readonly osProcessIdentity: string | null;
  readonly livenessProbe: RunWriterLivenessProbe;
  readonly scan: (directory: string) => Promise<ArbitrationChain>;
  readonly publish: NonNullable<RunWriterArbiterOptions["publish"]>;
  readonly publisherFileSystem?: ImmutablePublisherFileSystem;
  readonly publicationGuard?: ImmutablePublicationGuard;
}

interface ActiveEntry { readonly record: GenerationRecord; readonly lease: RunWriterLease; }
interface PendingAcquisition {
  readonly role: RunWriterAcquisitionRole;
  readonly record: GenerationRecord;
  readonly retired: readonly GenerationRecord[];
  readonly arbitration: ArbitrationDirectoryIdentity;
}
interface PendingRelease {
  readonly record: ReleaseRecord;
  readonly retired: readonly ReleaseRecord[];
  readonly arbitration: ArbitrationDirectoryIdentity;
}
interface RegistryState {
  readonly processNonce: string;
  readonly active: Map<string, ActiveEntry>;
  readonly pendingAcquisitions: Map<string, PendingAcquisition>;
  readonly pendingReleases: Map<string, PendingRelease>;
  readonly locks: Map<string, Promise<void>>;
}

const registrySymbol = Symbol.for("pi-rlm.run-writer-arbiter.registry.v2");
const registryHost = process as unknown as Record<symbol, unknown>;
const existingRegistry = registryHost[registrySymbol] as RegistryState | undefined;
const registry: RegistryState = existingRegistry ?? {
  processNonce: randomBytes(32).toString("hex"), active: new Map(), pendingAcquisitions: new Map(),
  pendingReleases: new Map(), locks: new Map(),
};
registryHost[registrySymbol] = registry;

type Attempt<T> =
  | { readonly status: "succeeded"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown };
const attempt = async <T>(effect: () => Promise<T>): Promise<Attempt<T>> => {
  try { return { status: "succeeded", value: await effect() }; }
  catch (error) { return { status: "failed", error }; }
};
const withRunLock = async <T>(key: string, effect: () => Promise<T>): Promise<T> => {
  const predecessor = registry.locks.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const own = new Promise<void>((resolve) => { unlock = resolve; });
  const tail = predecessor.then(() => own);
  registry.locks.set(key, tail);
  await predecessor;
  try { return await effect(); }
  finally {
    unlock();
    if (registry.locks.get(key) === tail) registry.locks.delete(key);
  }
};
const token = (create: () => string): string => {
  const value = create();
  if (!TOKEN.test(value)) throw new RunWriterArbiterError("WRITER_ARBITER_INPUT", "arbiter token must be 64 lowercase hex characters");
  return value;
};
const timestamp = (now: () => number): number => {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RunWriterArbiterError("WRITER_ARBITER_INPUT", "arbiter timestamp must be a nonnegative safe integer");
  return value;
};
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => Buffer.from(left).equals(Buffer.from(right));
const sameGeneration = (left: GenerationRecord, right: GenerationRecord): boolean =>
  sameBytes(encodeGenerationRecord(left), encodeGenerationRecord(right));
const sameRelease = (left: ReleaseRecord, right: ReleaseRecord): boolean =>
  sameBytes(encodeReleaseRecord(left), encodeReleaseRecord(right));
const identityMatches = (pinned: PinnedRunWriterIdentity, record: GenerationRecord | ReleaseRecord): boolean =>
  record.rootDev === pinned.identity.rootDev && record.rootIno === pinned.identity.rootIno
  && record.runDev === pinned.identity.runDev && record.runIno === pinned.identity.runIno;
const arbitrationMatches = (
  pinned: PinnedRunWriterIdentity,
  expected: ArbitrationDirectoryIdentity,
): boolean => pinned.arbitrationIdentity.dev === expected.dev && pinned.arbitrationIdentity.ino === expected.ino;
const assertPendingArbitration = (
  pinned: PinnedRunWriterIdentity,
  expected: ArbitrationDirectoryIdentity,
): void => {
  if (!arbitrationMatches(pinned, expected))
    throw new RunWriterIdentityError("WRITER_IDENTITY_CHANGED", "pending transition belongs to a different arbitration directory inode");
};

const resolvedOptions = (options: RunWriterArbiterOptions): ResolvedOptions => {
  const osIdentity = options.osProcessIdentity ?? null;
  if (osIdentity !== null && !OS_IDENTITY.test(osIdentity))
    throw new RunWriterArbiterError("WRITER_ARBITER_INPUT", "OS process identity is invalid");
  return {
    now: options.now ?? Date.now,
    createToken: options.createToken ?? (() => randomBytes(32).toString("hex")),
    osProcessIdentity: osIdentity,
    livenessProbe: options.livenessProbe ?? nodeRunWriterLivenessProbe,
    scan: options.scan ?? ((directory) => scanArbitrationDirectory(directory)),
    publish: options.publish ?? publishImmutableArbitrationRecord,
    ...(options.publisherFileSystem ? { publisherFileSystem: options.publisherFileSystem } : {}),
    ...(options.publicationGuard ? { publicationGuard: options.publicationGuard } : {}),
  };
};

const assertPinnedChain = (pinned: PinnedRunWriterIdentity, chain: ArbitrationChain): void => {
  for (const generation of chain.generations) {
    if (!identityMatches(pinned, generation) || generation.runName !== pinned.runName)
      throw new RunWriterIdentityError("WRITER_IDENTITY_CHANGED", "arbitration chain does not name the pinned managed run");
  }
  for (const release of chain.releases.values()) {
    if (!identityMatches(pinned, release))
      throw new RunWriterIdentityError("WRITER_IDENTITY_CHANGED", "arbitration release does not name the pinned managed run");
  }
};
const scanPinned = async (pinned: PinnedRunWriterIdentity, options: ResolvedOptions): Promise<ArbitrationChain> => {
  const chain = await pinned.scan(options.scan);
  assertPinnedChain(pinned, chain);
  return chain;
};
const publishPinned = async (
  pinned: PinnedRunWriterIdentity,
  record: GenerationRecord | ReleaseRecord,
  options: ResolvedOptions,
): Promise<ArbitrationPublicationResult> => {
  await pinned.assertValid();
  const input: ArbitrationPublicationInput = record.type === "generation"
    ? { directory: pinned.arbitrationPath, record }
    : { directory: pinned.arbitrationPath, record };
  const publication = await attempt(() => options.publish(input, {
    ...(options.publisherFileSystem ? { fileSystem: options.publisherFileSystem } : {}),
    guard: pinned.publicationGuard(options.publicationGuard),
  }));
  const revalidation = await attempt(() => pinned.assertValid());
  if (publication.status === "failed" && revalidation.status === "failed")
    throw new AggregateError([publication.error, revalidation.error], "publication and identity revalidation failed");
  if (revalidation.status === "failed") throw revalidation.error;
  if (publication.status === "failed") throw publication.error;
  return publication.value;
};

const assertSuccessorAllowed = async (
  pinned: PinnedRunWriterIdentity,
  chain: ArbitrationChain,
  owner: GenerationRecord,
  options: ResolvedOptions,
): Promise<void> => {
  if (chain.releases.has(owner.token)) return;
  const active = registry.active.get(pinned.key);
  if (active && sameGeneration(active.record, owner))
    throw new RunWriterArbiterError("WRITER_ARBITER_BUSY", "the authoritative writer is active", undefined, "live_or_reused");
  if (owner.pid === process.pid)
    throw new RunWriterArbiterError("WRITER_ARBITER_AMBIGUOUS", "same-PID owner has no exact active registry entry", undefined, "unsupported");
  const result = await options.livenessProbe(owner);
  const liveness: RunWriterLivenessResult = isRunWriterLivenessResult(result) ? result : "unsupported";
  if (liveness === "absent") return;
  throw new RunWriterArbiterError(
    liveness === "live_or_reused" ? "WRITER_ARBITER_BUSY" : "WRITER_ARBITER_AMBIGUOUS",
    "authoritative owner is not definitely absent", undefined, liveness,
  );
};

const exactOwnedTip = (chain: ArbitrationChain, owner: GenerationRecord): boolean =>
  chain.tip !== null && sameGeneration(chain.tip, owner) && !chain.releases.has(owner.token);
const reserveAcquisition = (
  pinned: PinnedRunWriterIdentity,
  role: RunWriterAcquisitionRole,
  owner: GenerationRecord,
  options: ResolvedOptions,
): PendingAcquisition => {
  const ordinal = owner.ordinal + 1;
  if (ordinal >= MAX_ARBITRATION_ORDINAL)
    throw new RunWriterArbiterError("WRITER_ARBITER_ORDINAL_EXHAUSTED", "ordinary acquisition cannot consume retirement ordinal");
  return {
    role,
    retired: [],
    arbitration: pinned.arbitrationIdentity,
    record: {
      schemaVersion: 1, type: "generation", token: token(options.createToken), predecessor: owner.token,
      ordinal, role, ...pinned.identity, runName: pinned.runName, pid: process.pid,
      processNonce: registry.processNonce, osProcessIdentity: options.osProcessIdentity, createdAtMs: timestamp(options.now),
    },
  };
};
const authoritativePendingGeneration = (
  chain: ArbitrationChain,
  pending: PendingAcquisition,
): GenerationRecord | undefined => {
  for (const candidate of [pending.record, ...pending.retired]) {
    const authoritative = chain.generations.find(({ token: candidateToken }) => candidateToken === candidate.token);
    if (!authoritative) continue;
    if (!sameGeneration(authoritative, candidate))
      throw new RunWriterArbiterError("WRITER_ARBITER_PENDING_CONFLICT", "pending token names a different generation");
    return candidate;
  }
  return undefined;
};
const selectAuthoritativePendingGeneration = (
  pinned: PinnedRunWriterIdentity,
  pending: PendingAcquisition,
  chain: ArbitrationChain,
): PendingAcquisition | undefined => {
  const authoritative = authoritativePendingGeneration(chain, pending);
  if (!authoritative) return undefined;
  if (!exactOwnedTip(chain, authoritative)) {
    registry.pendingAcquisitions.delete(pinned.key);
    throw new RunWriterArbiterError("WRITER_ARBITER_FENCED", "pending generation is durably released or superseded");
  }
  if (sameGeneration(authoritative, pending.record)) return pending;
  const recovered = { ...pending, record: authoritative, retired: [] };
  registry.pendingAcquisitions.set(pinned.key, recovered);
  return recovered;
};
const retirePendingAcquisition = (
  pinned: PinnedRunWriterIdentity,
  pending: PendingAcquisition,
  owner: GenerationRecord,
  options: ResolvedOptions,
): PendingAcquisition => {
  if (pending.retired.length >= MAX_ARBITRATION_ORPHANS)
    throw new RunWriterArbiterError("WRITER_ARBITER_PENDING_CONFLICT", "retired pending generation budget exceeded");
  const reserved = reserveAcquisition(pinned, pending.role, owner, options);
  const replacement = { ...reserved, retired: [...pending.retired, pending.record] };
  registry.pendingAcquisitions.set(pinned.key, replacement);
  return replacement;
};
const reconcilePendingAcquisition = async (
  pinned: PinnedRunWriterIdentity,
  pending: PendingAcquisition,
  chain: ArbitrationChain,
  options: ResolvedOptions,
): Promise<PendingAcquisition> => {
  const authoritative = selectAuthoritativePendingGeneration(pinned, pending, chain);
  if (authoritative) return authoritative;
  if (chain.tip?.token !== pending.record.predecessor) {
    registry.pendingAcquisitions.delete(pinned.key);
    throw new RunWriterArbiterError("WRITER_ARBITER_ELECTION_LOST", "pending generation slot has another durable successor");
  }
  await assertSuccessorAllowed(pinned, chain, chain.tip, options);
  const orphan = chain.orphans.find(({ name }) => name === generationIntentFilename(pending.record.token));
  return orphan?.validity === "malformed"
    ? retirePendingAcquisition(pinned, pending, chain.tip, options)
    : pending;
};
const authoritativePendingRelease = (
  chain: ArbitrationChain,
  pending: PendingRelease,
): ReleaseRecord | undefined => {
  const authoritative = chain.releases.get(pending.record.generation);
  if (!authoritative) return undefined;
  for (const candidate of [pending.record, ...pending.retired]) {
    if (sameRelease(authoritative, candidate)) return candidate;
  }
  throw new RunWriterArbiterError("WRITER_ARBITER_RELEASE_CONFLICT", "generation has a different durable release");
};
const retirePendingRelease = (
  pending: PendingRelease,
  replacement: PendingRelease,
): PendingRelease => {
  if (pending.retired.length >= MAX_ARBITRATION_ORPHANS)
    throw new RunWriterArbiterError("WRITER_ARBITER_RELEASE_CONFLICT", "retired pending release budget exceeded");
  return { ...replacement, retired: [...pending.retired, pending.record] };
};

export class RunWriterLease {
  readonly role: RunWriterAcquisitionRole;
  readonly runName: string;
  private readonly scheduler: RunWriterScheduler;
  private durablyReleased = false;

  constructor(
    readonly generation: GenerationRecord,
    private readonly pinned: PinnedRunWriterIdentity,
    private readonly options: ResolvedOptions,
  ) {
    this.role = generation.role as RunWriterAcquisitionRole;
    this.runName = generation.runName;
    this.scheduler = new RunWriterScheduler({
      preFence: () => this.assertOwnedTip(),
      postFence: () => this.assertOwnedTip(),
      releaseTransition: () => this.releaseTransition(),
    });
  }

  run<T>(effect: () => T | PromiseLike<T>): Promise<T> { return this.scheduler.run(effect); }
  release(): Promise<void> { return this.scheduler.release(); }

  private async assertOwnedTip(): Promise<void> {
    const activeBefore = registry.active.get(this.pinned.key);
    if (activeBefore?.lease !== this || !sameGeneration(activeBefore.record, this.generation))
      throw new RunWriterArbiterError("WRITER_ARBITER_FENCED", "lease is not the exact active process owner");
    const chain = await scanPinned(this.pinned, this.options);
    const activeAfter = registry.active.get(this.pinned.key);
    if (activeAfter?.lease !== this || !sameGeneration(activeAfter.record, this.generation)
      || !exactOwnedTip(chain, this.generation))
      throw new RunWriterArbiterError("WRITER_ARBITER_FENCED", "lease generation is released, superseded, or changed");
  }

  private createPendingRelease(): PendingRelease {
    return {
      retired: [],
      arbitration: this.pinned.arbitrationIdentity,
      record: {
        schemaVersion: 1, type: "release", token: token(this.options.createToken), generation: this.generation.token,
        processNonce: this.generation.processNonce, ...this.pinned.identity, releasedAtMs: timestamp(this.options.now),
      },
    };
  }

  private async releaseTransition(): Promise<void> {
    if (this.durablyReleased) { await this.pinned.close(); return; }
    await withRunLock(this.pinned.key, async () => {
      const active = registry.active.get(this.pinned.key);
      if (active?.lease !== this || !sameGeneration(active.record, this.generation))
        throw new RunWriterArbiterError("WRITER_ARBITER_FENCED", "cannot release a non-active lease");
      let pending = registry.pendingReleases.get(this.pinned.key);
      if (pending) assertPendingArbitration(this.pinned, pending.arbitration);
      const before = await scanPinned(this.pinned, this.options);
      const wasPending = pending !== undefined;
      if (!pending) {
        pending = this.createPendingRelease();
        registry.pendingReleases.set(this.pinned.key, pending);
      }
      if (authoritativePendingRelease(before, pending)) {
        await this.completeRelease();
        return;
      }
      if (!exactOwnedTip(before, this.generation) && !wasPending)
        throw new RunWriterArbiterError("WRITER_ARBITER_FENCED", "unreleased generation is no longer the exact tip");
      const orphan = before.orphans.find(({ name }) => name === releaseIntentFilename(pending!.record.token));
      if (orphan?.validity === "malformed") {
        pending = retirePendingRelease(pending, this.createPendingRelease());
        registry.pendingReleases.set(this.pinned.key, pending);
      }
      const result = await publishPinned(this.pinned, pending.record, this.options);
      const after = await scanPinned(this.pinned, this.options);
      if (!authoritativePendingRelease(after, pending)) {
        if (result.status !== "published" || result.record.type !== "release" || !sameRelease(result.record, pending.record))
          throw new RunWriterArbiterError("WRITER_ARBITER_RELEASE_CONFLICT", "exact release token lost its slot");
        throw new RunWriterArbiterError("WRITER_ARBITER_RELEASE_CONFLICT", "exact release is not durably observable");
      }
      await this.completeRelease();
    });
  }

  private async completeRelease(): Promise<void> {
    registry.pendingReleases.delete(this.pinned.key);
    if (registry.active.get(this.pinned.key)?.lease === this) registry.active.delete(this.pinned.key);
    this.durablyReleased = true;
    await this.pinned.close();
  }
}

export const acquireRunWriterLease = async (
  input: AcquireRunWriterLeaseInput,
  suppliedOptions: RunWriterArbiterOptions = {},
): Promise<RunWriterLease> => {
  if (!isMainThread)
    throw new RunWriterArbiterError("WRITER_ARBITER_UNSUPPORTED_REALM", "writer ownership is restricted to the main thread");
  if (input.role !== "writer" && input.role !== "retention")
    throw new RunWriterArbiterError("WRITER_ARBITER_INPUT", "only writer or retention acquisition is permitted");
  const options = resolvedOptions(suppliedOptions);
  const pinned = await PinnedRunWriterIdentity.openExisting(input.managedRoot, input.runName);
  try {
    return await withRunLock(pinned.key, async () => {
      if (registry.active.has(pinned.key))
        throw new RunWriterArbiterError("WRITER_ARBITER_ALREADY_OWNED", "current process already owns this pinned run");
      let pending = registry.pendingAcquisitions.get(pinned.key);
      if (pending) assertPendingArbitration(pinned, pending.arbitration);
      let chain = await scanPinned(pinned, options);
      if (!chain.tip)
        throw new RunWriterArbiterError("WRITER_ARBITER_NO_AUTHORITY", "existing run has no authoritative arbitration predecessor");
      if (pending && pending.role !== input.role)
        throw new RunWriterArbiterError("WRITER_ARBITER_PENDING_CONFLICT", "pending acquisition has a different role");
      if (pending) pending = await reconcilePendingAcquisition(pinned, pending, chain, options);
      else {
        await assertSuccessorAllowed(pinned, chain, chain.tip, options);
        pending = reserveAcquisition(pinned, input.role, chain.tip, options);
        registry.pendingAcquisitions.set(pinned.key, pending);
      }
      const result = await publishPinned(pinned, pending.record, options);
      chain = await scanPinned(pinned, options);
      const authoritative = selectAuthoritativePendingGeneration(pinned, pending, chain);
      if (!authoritative) {
        if (result.status !== "published" || result.record.type !== "generation" || !sameGeneration(result.record, pending.record)) {
          registry.pendingAcquisitions.delete(pinned.key);
          throw new RunWriterArbiterError("WRITER_ARBITER_ELECTION_LOST", "another contender won the exact successor generation");
        }
        throw new RunWriterArbiterError("WRITER_ARBITER_FENCED", "published generation is not the exact unreleased tip");
      }
      pending = authoritative;
      const lease = new RunWriterLease(pending.record, pinned, options);
      registry.pendingAcquisitions.delete(pinned.key);
      registry.active.set(pinned.key, { record: pending.record, lease });
      return lease;
    });
  } catch (error) {
    const closed = await attempt(() => pinned.close());
    if (closed.status === "failed") throw new AggregateError([error, closed.error], "acquisition and pinned-handle close failed");
    throw error;
  }
};
