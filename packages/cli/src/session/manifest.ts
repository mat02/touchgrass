import { readFileSync } from "fs";
import { chmod, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { ensureDirs, paths } from "../config/paths";

export interface SessionManifest {
  id: string;
  command: string;
  cwd: string;
  name?: string;
  pid: number;
  jsonlFile: string | null;
  startedAt: string;
}

function parseManifest(raw: string): SessionManifest | null {
  try {
    const parsed = JSON.parse(raw) as SessionManifest;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string" || typeof parsed.command !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readSessionManifestSync(sessionId: string): SessionManifest | null {
  try {
    const raw = readFileSync(join(paths.sessionsDir, `${sessionId}.json`), "utf-8");
    return parseManifest(raw);
  } catch {
    return null;
  }
}

export async function readSessionManifest(sessionId: string): Promise<SessionManifest | null> {
  try {
    const raw = await readFile(join(paths.sessionsDir, `${sessionId}.json`), "utf-8");
    return parseManifest(raw);
  } catch {
    return null;
  }
}

export async function writeSessionManifest(
  manifest: SessionManifest,
  options?: { preserveExistingName?: boolean }
): Promise<void> {
  await ensureDirs();

  if (options?.preserveExistingName) {
    const existing = readSessionManifestSync(manifest.id);
    if (existing && existing.startedAt === manifest.startedAt && existing.name !== manifest.name) {
      manifest.name = existing.name;
    }
  }

  const file = join(paths.sessionsDir, `${manifest.id}.json`);
  await writeFile(file, JSON.stringify(manifest, null, 2), { encoding: "utf-8", mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

export async function removeSessionManifest(sessionId: string): Promise<void> {
  try {
    await unlink(join(paths.sessionsDir, `${sessionId}.json`));
  } catch {}
}

export async function updateSessionManifestName(sessionId: string, name?: string): Promise<boolean> {
  const manifest = await readSessionManifest(sessionId);
  if (!manifest) return false;
  manifest.name = name;
  await writeSessionManifest(manifest);
  return true;
}
