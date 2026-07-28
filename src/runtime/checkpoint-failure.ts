/** Classification for optional checkpoint persistence versus run authority failures. */

import { OperationAbortedError } from "./abort.ts";

const writerCodes = new Set([
  "WRITER_MUTATION_PATH",
  "WRITER_IDENTITY_CHANGED",
]);

const optionalStorageCodes = new Set([
  "EDQUOT",
  "EFBIG",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "ENOSPC",
]);

const ownCode = (error: object): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
};

const ownCause = (error: object): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(error, "cause");
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const aggregateErrors = (error: object): readonly unknown[] | undefined => {
  if (!(error instanceof AggregateError)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "errors");
  return descriptor && "value" in descriptor && Array.isArray(descriptor.value)
    ? descriptor.value
    : undefined;
};

/** Find the original cancellation or writer-fencing failure without invoking accessors. */
export const checkpointControlFailure = (error: unknown): unknown | undefined => {
  if (error instanceof OperationAbortedError) return error;
  if (typeof error !== "object" || error === null) return undefined;
  const code = ownCode(error);
  if ((code?.startsWith("WRITER_") ?? false) || (code !== undefined && writerCodes.has(code))) return error;
  for (const nested of aggregateErrors(error) ?? []) {
    const found = checkpointControlFailure(nested);
    if (found !== undefined) return found;
  }
  const cause = ownCause(error);
  return cause === undefined ? undefined : checkpointControlFailure(cause);
};

/** Only explicit capacity errors and ordinary local storage exhaustion are optional. */
export const isOptionalCheckpointStorageFailure = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = ownCode(error);
  if (code === "CHECKPOINT_CAPACITY" || (code !== undefined && optionalStorageCodes.has(code))) return true;
  const nested = aggregateErrors(error);
  if (nested !== undefined && nested.length > 0) return nested.every(isOptionalCheckpointStorageFailure);
  const cause = ownCause(error);
  return cause !== undefined && isOptionalCheckpointStorageFailure(cause);
};
