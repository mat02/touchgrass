import { readFile, writeFile, chmod } from "fs/promises";
import { paths, ensureDirs } from "./paths";
import {
  type TgConfig,
  type ChannelConfig,
  createDefaultConfig,
  validateConfig,
  defaultSettings,
  setChatOutputPreferences,
  getChatOutputPreferences,
} from "./schema";

let cached: TgConfig | null = null;

// Old config format for migration
interface OldConfig {
  botToken: string;
  pairedUsers: Array<{ telegramId: number; username?: string; pairedAt: string }>;
  settings: Record<string, unknown>;
}

function isOldFormat(config: Record<string, unknown>): boolean {
  return typeof config.botToken === "string" && Array.isArray(config.pairedUsers);
}

function migrateConfig(old: OldConfig): TgConfig {
  const channels: Record<string, ChannelConfig> = {};

  if (old.botToken) {
    channels.telegram = {
      type: "telegram",
      credentials: { botToken: old.botToken },
      pairedUsers: old.pairedUsers.map((u) => ({
        userId: `telegram:${u.telegramId}`,
        username: u.username,
        pairedAt: u.pairedAt,
      })),
      linkedGroups: [],
    };
  }

  return {
    channels,
    settings: { ...defaultSettings, ...(old.settings || {}) } as TgConfig["settings"],
  };
}

export async function loadConfig(): Promise<TgConfig> {
  if (cached) return cached;
  try {
    const raw = await readFile(paths.config, "utf-8");
    await chmod(paths.config, 0o600).catch(() => {});
    const parsed = JSON.parse(raw);

    // Auto-migrate old format
    if (isOldFormat(parsed)) {
      const migrated = migrateConfig(parsed as unknown as OldConfig);
      await saveConfig(migrated);
      cached = migrated;
      return migrated;
    }

    if (!validateConfig(parsed)) {
      throw new Error("Invalid config format");
    }

    // Drop unsupported channel types at runtime.
    const supportedTypes = new Set(["telegram", "slack"]);
    for (const [name, ch] of Object.entries(parsed.channels)) {
      if (!supportedTypes.has(ch.type)) {
        delete parsed.channels[name];
      }
    }

    // Merge with defaults in case new settings were added
    parsed.settings = { ...defaultSettings, ...parsed.settings };
    if (!parsed.chatPreferences || typeof parsed.chatPreferences !== "object") {
      parsed.chatPreferences = {};
    } else {
      for (const [chatId, pref] of Object.entries(parsed.chatPreferences)) {
        if (!pref || typeof pref !== "object") {
          delete parsed.chatPreferences[chatId];
          continue;
        }
        const rawPref = pref as {
          outputMode?: unknown;
          thinking?: unknown;
          muted?: unknown;
          output?: {
            thinkingMode?: unknown;
            toolCallMode?: unknown;
            toolResultMode?: unknown;
            toolErrors?: unknown;
            backgroundJobs?: unknown;
            typingIndicator?: unknown;
            orderingNotices?: unknown;
          } | unknown;
        };
        const muted = rawPref.muted;
        if (muted !== undefined && typeof muted !== "boolean") {
          delete parsed.chatPreferences[chatId];
          continue;
        }

        const hasNewOutput = rawPref.output && typeof rawPref.output === "object";
        if (hasNewOutput) {
          const output = rawPref.output as Record<string, unknown>;
          const normalizedOutput: Record<string, unknown> = {};
          if (output.thinkingMode === "off" || output.thinkingMode === "preview" || output.thinkingMode === "full") normalizedOutput.thinkingMode = output.thinkingMode;
          if (output.toolCallMode === "off" || output.toolCallMode === "compact" || output.toolCallMode === "detailed") normalizedOutput.toolCallMode = output.toolCallMode;
          if (output.toolResultMode === "off" || output.toolResultMode === "compact" || output.toolResultMode === "full") normalizedOutput.toolResultMode = output.toolResultMode;
          if (typeof output.toolErrors === "boolean") normalizedOutput.toolErrors = output.toolErrors;
          if (typeof output.backgroundJobs === "boolean") normalizedOutput.backgroundJobs = output.backgroundJobs;
          if (typeof output.typingIndicator === "boolean") normalizedOutput.typingIndicator = output.typingIndicator;
          if (typeof output.orderingNotices === "boolean") normalizedOutput.orderingNotices = output.orderingNotices;
          rawPref.output = Object.keys(normalizedOutput).length > 0 ? normalizedOutput : undefined;
        } else {
          let migrated = getChatOutputPreferences(parsed as TgConfig, chatId);
          let shouldMigrateLegacy = false;
          if (rawPref.thinking === true) {
            migrated = {
              ...migrated,
              thinkingMode: "full",
            };
            shouldMigrateLegacy = true;
          }
          const mode = rawPref.outputMode;
          if (mode === "compact") {
            migrated = getChatOutputPreferences(parsed as TgConfig, chatId);
            shouldMigrateLegacy = true;
          } else if (mode === "thinking") {
            migrated = {
              ...migrated,
              thinkingMode: "full",
            };
            shouldMigrateLegacy = true;
          } else if (mode === "verbose") {
            migrated = {
              ...migrated,
              thinkingMode: "full",
              toolCallMode: "detailed",
              toolResultMode: "full",
              toolErrors: true,
            };
            shouldMigrateLegacy = true;
          } else if (mode !== undefined) {
            delete parsed.chatPreferences[chatId];
            continue;
          }
          delete rawPref.thinking;
          delete rawPref.outputMode;
          if (shouldMigrateLegacy) {
            setChatOutputPreferences(parsed as TgConfig, chatId, migrated);
          }
        }

        if (parsed.chatPreferences[chatId] && parsed.chatPreferences[chatId].muted !== true && parsed.chatPreferences[chatId].output === undefined) {
          delete parsed.chatPreferences[chatId];
        }
      }
    }
    // Ensure linkedGroups exists on all channels
    for (const ch of Object.values(parsed.channels)) {
      if (!ch.linkedGroups) ch.linkedGroups = [];
    }
    cached = parsed;
    return parsed;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return createDefaultConfig();
    }
    throw e;
  }
}

export async function saveConfig(config: TgConfig): Promise<void> {
  await ensureDirs();
  await writeFile(paths.config, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await chmod(paths.config, 0o600).catch(() => {});
  cached = config;
}

export function invalidateCache(): void {
  cached = null;
}
