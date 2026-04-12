import { closeSync, openSync, readSync, readdirSync, statSync, type Dirent } from "fs";
import { homedir } from "os";
import { join } from "path";

const OMP_HEADER_READ_BYTES = 1024;

export function resolveOmpAgentRoot(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) return configured;
  return join(process.env.HOME || homedir(), ".omp", "agent");
}

export function resolveOmpSessionsRoot(): string {
  return join(resolveOmpAgentRoot(), "sessions");
}

export function encodeOmpSessionDir(cwd: string): string {
  return "--" + cwd.replace(/^\//, "").replace(/[\\/:]/g, "-") + "--";
}

function safeStatMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function listJsonlFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { encoding: "utf8" })
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function readOmpSessionHeaderCwd(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(OMP_HEADER_READ_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return null;
    const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0]?.trim();
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    if (parsed.type !== "session") return null;
    return typeof parsed.cwd === "string" ? parsed.cwd : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors on best-effort header reads.
      }
    }
  }
}

export function listOmpSessionFiles(cwd: string, maxResults = 500): string[] {
  const cleanCwd = cwd.trim();
  if (!cleanCwd) return [];

  const sessionsRoot = resolveOmpSessionsRoot();
  const exactFiles = listJsonlFiles(join(sessionsRoot, encodeOmpSessionDir(cleanCwd)));
  if (exactFiles.length > 0) {
    return exactFiles.sort((a, b) => safeStatMtime(b) - safeStatMtime(a));
  }

  let buckets: Array<Dirent<string>> = [];
  try {
    buckets = readdirSync(sessionsRoot, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const matches: string[] = [];
  const sortedBuckets = buckets.slice().sort((a, b) => b.name.localeCompare(a.name));
  for (const bucket of sortedBuckets) {
    if (!bucket.isDirectory()) continue;
    for (const filePath of listJsonlFiles(join(sessionsRoot, bucket.name))) {
      if (readOmpSessionHeaderCwd(filePath) !== cleanCwd) continue;
      matches.push(filePath);
      if (matches.length >= maxResults) {
        return matches.sort((a, b) => safeStatMtime(b) - safeStatMtime(a));
      }
    }
  }

  return matches.sort((a, b) => safeStatMtime(b) - safeStatMtime(a));
}
