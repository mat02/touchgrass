import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { paths } from "../config/paths";
import {
  createDefaultConfig,
  DEFAULT_CHAT_OUTPUT_PREFERENCES,
  getChatOutputPreferences,
  type TgConfig,
} from "../config/schema";
import { invalidateCache, loadConfig, saveConfig } from "../config/store";

const CHAT_ID = "telegram:100";

function resetConfigStorage() {
  invalidateCache();
  rmSync(paths.dir, { recursive: true, force: true });
}

function writeRawConfig(config: TgConfig) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(config, null, 2));
}

describe("config store", () => {
  it("persists orderingNotices when explicitly enabled", async () => {
    resetConfigStorage();
    try {
      const config = createDefaultConfig();
      config.chatPreferences = {
        [CHAT_ID]: {
          output: {
            orderingNotices: true,
          },
        },
      };

      await saveConfig(config);
      invalidateCache();

      const loaded = await loadConfig();
      expect(getChatOutputPreferences(loaded, CHAT_ID).orderingNotices).toBe(true);

      const diskConfig = JSON.parse(readFileSync(paths.config, "utf-8")) as TgConfig;
      expect(diskConfig.chatPreferences?.[CHAT_ID]?.output?.orderingNotices).toBe(true);
    } finally {
      resetConfigStorage();
    }
  });

  it("keeps orderingNotices default-off when not persisted", async () => {
    resetConfigStorage();
    try {
      const config = createDefaultConfig();
      config.chatPreferences = {
        [CHAT_ID]: {
          output: {
            toolCallMode: "detailed",
          },
        },
      };
      writeRawConfig(config);

      const loaded = await loadConfig();
      const output = getChatOutputPreferences(loaded, CHAT_ID);
      expect(output.toolCallMode).toBe("detailed");
      expect(output.orderingNotices).toBe(DEFAULT_CHAT_OUTPUT_PREFERENCES.orderingNotices);
    } finally {
      resetConfigStorage();
    }
  });

  it("normalizes invalid orderingNotices while keeping other valid output fields", async () => {
    resetConfigStorage();
    try {
      const config = createDefaultConfig();
      config.chatPreferences = {
        [CHAT_ID]: {
          output: {
            toolResultMode: "full",
            orderingNotices: "yes" as unknown as boolean,
          },
        },
      };
      writeRawConfig(config);

      const loaded = await loadConfig();
      const output = getChatOutputPreferences(loaded, CHAT_ID);
      expect(output.toolResultMode).toBe("full");
      expect(output.orderingNotices).toBe(false);
    } finally {
      resetConfigStorage();
    }
  });
});
