import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  MAX_LIVE_WORKER_REQUEST_BYTES, canonicalLiveWorkerRouteReport, parseLiveWorkerRequestText,
  type LiveWorkerRequest,
} from "../src/acceptance/live-worker-contract.ts";

const exactArgs = (args: readonly string[]): { requestPath: string; resultPath: string } => {
  if (args.length !== 4 || args[0] !== "--request" || args[2] !== "--result" || !args[1] || !args[3]
    || resolve(args[1]) === resolve(args[3])) throw new Error("invalid worker arguments");
  return { requestPath: args[1], resultPath: args[3] };
};

const readPrivateRequest = async (path: string): Promise<LiveWorkerRequest> => {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("no-follow unavailable");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1n || (Number(stat.mode) & 0o7777) !== 0o600
      || uid === undefined || stat.uid !== BigInt(uid) || stat.size > BigInt(MAX_LIVE_WORKER_REQUEST_BYTES))
      throw new Error("invalid request metadata");
    const bytes = new Uint8Array(Number(stat.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== Number(stat.size)) throw new Error("request changed while read");
    return parseLiveWorkerRequestText(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)));
  } finally { await handle.close(); }
};

const writePrivateReport = async (path: string, text: string): Promise<void> => {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
};

export const runLiveProviderWorker = async (args: readonly string[]): Promise<void> => {
  const paths = exactArgs(args);
  const request = await readPrivateRequest(paths.requestPath);
  const root = await mkdtemp(join(tmpdir(), "pi-rlm-live-route-"));
  try {
    await chmod(root, 0o700);
    const stat = await lstat(root, { bigint: true });
    if (!stat.isDirectory() || (Number(stat.mode) & 0o7777) !== 0o700) throw new Error("private root invalid");
    const scenarios = await import("../src/acceptance/live-scenarios.ts");
    const report = await scenarios.runLiveRouteScenarios({ request, root });
    await writePrivateReport(paths.resultPath, canonicalLiveWorkerRouteReport(report));
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
};

if (import.meta.main) {
  try { await runLiveProviderWorker(process.argv.slice(2)); }
  catch { process.exitCode = 1; }
}
