/** Pure routing and identity validation for /rlm host subcommands. */

import type { CoordinatorCancelResult, RunCoordinator } from "./run-coordinator.ts";

const RUN_NAME = /^run-[a-f0-9]{32}$/;
const LOCAL_ALIAS = /^[A-Za-z0-9_.:-]{1,128}$/;
const RESERVED_MANAGEMENT_PREFIX = /^(?:runs|inspect|resume|cleanup|cancel)(?:$|[^\p{L}\p{N}_])/u;
const FORBIDDEN_CONTROL = /[\p{Cc}\p{Cf}]/u;

export type RlmCommandRoute =
  | { readonly kind: "launch"; readonly args: string }
  | { readonly kind: "runs" }
  | { readonly kind: "inspect"; readonly target: string }
  | { readonly kind: "resume"; readonly target: string }
  | { readonly kind: "cleanup"; readonly mode: "apply" | "dry-run" | "force" }
  | { readonly kind: "cancel"; readonly target: string }
  | { readonly kind: "invalid-management" };

/** Management forms are recognized before any launch/source parser is invoked. */
export const routeRlmCommand = (args: string): RlmCommandRoute => {
  if (typeof args !== "string" || FORBIDDEN_CONTROL.test(args)) return { kind: "invalid-management" };
  const input = args.trim();
  if (input === "runs") return { kind: "runs" };
  if (input === "cleanup") return { kind: "cleanup", mode: "apply" };
  if (input === "cleanup --dry-run") return { kind: "cleanup", mode: "dry-run" };
  if (input === "cleanup --force") return { kind: "cleanup", mode: "force" };
  const matched = /^(inspect|resume|cancel) ([^\s]+)$/.exec(input);
  if (matched) {
    const kind = matched[1] as "inspect" | "resume" | "cancel";
    const target = matched[2]!;
    if (kind === "resume" && !RUN_NAME.test(target)) return { kind: "invalid-management" };
    return Object.freeze({ kind, target });
  }
  if (RESERVED_MANAGEMENT_PREFIX.test(input)) return { kind: "invalid-management" };
  return { kind: "launch", args };
};

export const isManagedRunName = (value: string): boolean => RUN_NAME.test(value);
export const isLocalRunAlias = (value: string): boolean => LOCAL_ALIAS.test(value);

/** Only an exact managed name or exact local alias bound to a managed name can inspect. */
export interface LocalRunAuthority {
  readonly sessionId: string;
  readonly authorizationGeneration: number;
}

export const resolveInspectionRunName = (
  target: string,
  coordinator: Pick<RunCoordinator, "resolve">,
  authority?: LocalRunAuthority,
): string | undefined => {
  if (RUN_NAME.test(target)) return target;
  if (!LOCAL_ALIAS.test(target)) return undefined;
  const local = coordinator.resolve(target);
  return local?.localId === target
    && (!authority || (local.sessionId === authority.sessionId
      && local.authorizationGeneration === authority.authorizationGeneration))
    && typeof local.runName === "string" && RUN_NAME.test(local.runName)
    ? local.runName
    : undefined;
};

/** Cancellation authority comes only from an exact, current coordinator local alias. */
export const cancelLocalRun = (
  target: string,
  coordinator: Pick<RunCoordinator, "cancelLocalAlias" | "resolve">,
  authority?: LocalRunAuthority,
): CoordinatorCancelResult => {
  if (!LOCAL_ALIAS.test(target)) return { ok: false, code: "RUN_NOT_FOUND" };
  if (authority) {
    const local = coordinator.resolve(target);
    if (!local || local.localId !== target || local.sessionId !== authority.sessionId
      || local.authorizationGeneration !== authority.authorizationGeneration)
      return { ok: false, code: "RUN_NOT_FOUND" };
  }
  return coordinator.cancelLocalAlias(target);
};
