import { parse } from "yaml";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../docs/", import.meta.url));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

async function update({ source, filename, format, name }) {
  const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Download returned HTTP ${response.status}.`);

  const text = await response.text();
  let specification;
  try {
    specification = format === "JSON" ? JSON.parse(text) : parse(text);
  } catch {
    throw new Error(`Downloaded content is not valid ${format}.`);
  }
  if (!isObject(specification)
    || typeof specification.openapi !== "string"
    || !/^3\.\d+\.\d+(?:[-+].*)?$/.test(specification.openapi)
    || !isObject(specification.info)
    || typeof specification.info.title !== "string" || !specification.info.title.trim()
    || typeof specification.info.version !== "string" || !specification.info.version.trim()
    || !isObject(specification.paths)) {
    throw new Error(`Downloaded ${format} does not contain an OpenAPI specification (openapi, info, paths).`);
  }

  await mkdir(directory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(directory, `.${filename}-`));
  try {
    const temporaryFile = join(temporaryDirectory, "openapi.json");
    await writeFile(temporaryFile, format === "JSON" ? `${JSON.stringify(specification, null, 2)}\n` : text, "utf8");
    // Rename on the same filesystem only after the complete file is written.
    await rename(temporaryFile, join(directory, filename));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(`[${name}] OpenAPI specification updated: docs/${filename}`);
}

export async function updateOpenApi(options) {
  try {
    await update(options);
  } catch (error) {
    console.error(`[${options.name}] OpenAPI update failed: ${error.message}`);
    process.exitCode = 1;
  }
}
