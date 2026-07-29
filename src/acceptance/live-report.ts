import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalLiveReport, parseLiveReportText, type LiveAcceptanceReport } from "./live-contract.ts";

export class LiveReportPublicationError extends Error {
  readonly code = "REPORT_PUBLICATION_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "LiveReportPublicationError";
  }
}

/** Publish a validated canonical report as a no-clobber 0600 file. */
export const publishLiveReport = async (
  outputPath: string,
  report: unknown,
  canaries: readonly string[] = [],
): Promise<LiveAcceptanceReport> => {
  const text = canonicalLiveReport(report, canaries);
  const bytes = Buffer.byteLength(text, "utf8");
  const parsed = parseLiveReportText(text, canaries);
  const directory = dirname(outputPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(outputPath)}.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryPresent = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    temporaryPresent = true;
    await handle.writeFile(text, { encoding: "utf8" });
    await handle.sync();
    const temporaryStat = await handle.stat({ bigint: true });
    if (!temporaryStat.isFile() || temporaryStat.nlink !== 1n
      || (Number(temporaryStat.mode) & 0o7777) !== 0o600 || temporaryStat.size !== BigInt(bytes))
      throw new LiveReportPublicationError("temporary report metadata is invalid");
    await handle.close();
    handle = undefined;
    await link(temporary, outputPath);
    await unlink(temporary);
    temporaryPresent = false;
    const outputStat = await lstat(outputPath, { bigint: true });
    if (!outputStat.isFile() || outputStat.nlink !== 1n
      || (Number(outputStat.mode) & 0o7777) !== 0o600 || outputStat.size !== BigInt(bytes))
      throw new LiveReportPublicationError("published report metadata is invalid");
    const directoryHandle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return parsed;
  } catch (error) {
    try { await handle?.close(); } catch { /* publication failure remains primary */ }
    if (error instanceof LiveReportPublicationError) throw error;
    throw new LiveReportPublicationError("canonical report could not be published");
  } finally {
    if (temporaryPresent) {
      try { await unlink(temporary); } catch { /* best-effort private temporary cleanup */ }
    }
  }
};
