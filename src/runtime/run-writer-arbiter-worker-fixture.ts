import { acquireRunWriterLease, type AcquireRunWriterLeaseInput } from "./run-writer-arbiter.ts";

const scope = globalThis as unknown as {
  onmessage: ((event: { readonly data: AcquireRunWriterLeaseInput }) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = async ({ data: input }) => {
  try {
    await acquireRunWriterLease(input);
    scope.postMessage("unexpected-success");
  } catch (error) {
    scope.postMessage(
      typeof error === "object" && error !== null && "code" in error ? error.code : "unknown",
    );
  }
};
