import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { configSchema } from "./schema.js";

export async function loadConfig(configPath = process.env.CONFIG_PATH ?? "config.yml") {
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(error.code === "ENOENT"
      ? "Configuration file not found. Create config.yml or set CONFIG_PATH."
      : "Configuration file could not be read. Check CONFIG_PATH and file permissions.");
  }

  let parsed;
  try {
    parsed = parse(source);
  } catch {
    // YAML errors may include source excerpts containing credentials.
    throw new Error("Invalid YAML syntax in configuration file.");
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const property = issue.path.join(".") || "configuration";
      // Unknown key names and raw validation errors may contain secrets.
      const message = issue.code === "unrecognized_keys"
        ? "Unknown properties are not allowed."
        : issue.code === "custom"
          ? issue.message
          : issue.code === "invalid_format"
            ? "Must be a valid HTTP/HTTPS URL."
            : issue.code === "too_small" && issue.path.at(-1) === "lists"
              ? "Must contain at least one list."
              : issue.code === "invalid_type"
                ? `Required; must be ${issue.expected === "array" ? "an array" : `a ${issue.expected}`}.`
                : "Invalid value.";
      return `${property}: ${message}`;
    });
    throw new Error(`Invalid configuration:\n${errors.join("\n")}`);
  }
  return result.data;
}
