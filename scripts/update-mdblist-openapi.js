import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = "https://raw.githubusercontent.com/linaspurinis/api.mdblist.com/main/openapi.json";
const directory = fileURLToPath(new URL("../docs/", import.meta.url));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

async function update() {
  const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Download returned HTTP ${response.status}.`);

  let specification;
  try {
    specification = await response.json();
  } catch {
    throw new Error("Downloaded content is not valid JSON.");
  }
  if (!isObject(specification)
    || typeof specification.openapi !== "string"
    || !/^3\.\d+\.\d+(?:[-+].*)?$/.test(specification.openapi)
    || !isObject(specification.info)
    || typeof specification.info.title !== "string" || !specification.info.title.trim()
    || typeof specification.info.version !== "string" || !specification.info.version.trim()
    || !isObject(specification.paths)) {
    throw new Error("Downloaded JSON does not contain an OpenAPI specification (openapi, info, paths).");
  }

  await mkdir(directory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(directory, ".mdblist-openapi-"));
  try {
    const temporaryFile = join(temporaryDirectory, "openapi.json");
    await writeFile(temporaryFile, `${JSON.stringify(specification, null, 2)}\n`, "utf8");
    // Rename on the same filesystem only after the complete file is written.
    await rename(temporaryFile, join(directory, "mdblist-openapi.json"));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  console.log("[MDBLIST] OpenAPI specification updated: docs/mdblist-openapi.json");
}

try {
  await update();
} catch (error) {
  console.error(`[MDBLIST] OpenAPI update failed: ${error.message}`);
  process.exitCode = 1;
}
