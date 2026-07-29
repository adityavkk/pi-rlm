import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const requestIndex = process.argv.indexOf("--request");
const requestPath = requestIndex >= 0 ? process.argv[requestIndex + 1] : undefined;
if (!requestPath) process.exit(2);

// Prove the process entered the parent-owned tree without emitting output.
await readFile(requestPath);
await mkdir(join(dirname(requestPath), ".orphaned-worker-state"), { mode: 0o700 });
await new Promise(() => {});
