import { watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { loadConfig } from "./loader.js";

export async function createConfigWatcher(
  configPath = process.env.CONFIG_PATH ?? "config.yml",
  { logger = console } = {},
) {
  const path = resolve(configPath);
  let currentConfig = await loadConfig(path);
  let timer;
  let loading = false;
  let pending = false;
  let closed = false;

  async function reload() {
    if (closed || loading) return;
    loading = true;
    pending = false;
    try {
      const nextConfig = await loadConfig(path);
      if (!closed) {
        currentConfig = nextConfig;
        logger.log("[CONFIG] Configuration reloaded successfully.");
      }
    } catch (error) {
      if (!closed) {
        // loadConfig supplies sanitized messages without YAML source values.
        logger.error(`[CONFIG] Configuration reload failed; keeping previous configuration. ${error.message}`);
      }
    } finally {
      loading = false;
      // A debounce may have expired while the previous read was in progress.
      if (pending && !timer && !closed) void reload();
    }
  }

  const watcher = watch(dirname(path), (_event, filename) => {
    if (closed || (filename !== null && filename.toString() !== basename(path))) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reload();
    }, 300);
  });

  watcher.on("error", () => {
    // Native errors may contain paths or other sensitive details.
    logger.error("[CONFIG] Configuration watcher error; keeping previous configuration.");
  });

  return {
    getConfig: () => currentConfig,
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
    },
  };
}
