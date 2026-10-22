import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { loadConfig } from "../src/config/loader.js";
import { configSchema } from "../src/config/schema.js";
import { createHistory } from "../src/db/database.js";

const examplePath = new URL("../config.example.yml", import.meta.url);
const example = parse(await readFile(examplePath, "utf8"));

async function withConfig(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "requester-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.yml");
  if (source !== undefined) await writeFile(path, source);
  return path;
}

test("example configuration loads successfully and preserves list order", async () => {
  const config = await loadConfig(examplePath);
  assert.deepEqual(config, example);
  assert.deepEqual(config.lists.map((list) => list.listId), example.lists.map((list) => list.listId));
});

test("missing configuration does not fall back to the example", async (t) => {
  await assert.rejects(loadConfig(await withConfig(t)), /file not found/);
});

test("invalid YAML does not expose source values", async (t) => {
  await assert.rejects(loadConfig(await withConfig(t, 'seerrApiKey: [TOP_SECRET\n')), (error) => {
    assert.match(error.message, /Invalid YAML/);
    assert.doesNotMatch(error.message, /TOP_SECRET/);
    return true;
  });
});

const invalidCases = [
  ["missing required field", (config) => { delete config.seerrApiKey; }, /seerrApiKey/],
  ["incorrect boolean type", (config) => { config.dryRun = "true"; }, /dryRun/],
  ["incorrect list type", (config) => { config.lists = {}; }, /lists/],
  ["empty API key", (config) => { config.mdblistApiKey = "  "; }, /mdblistApiKey/],
  ["unknown global property", (config) => { config.extra = true; }, /configuration: Unknown/],
  ["unknown list property", (config) => { config.lists[0].extra = true; }, /lists.0: Unknown/],
  ["empty lists", (config) => { config.lists = []; }, /lists/],
  ["missing list field", (config) => { delete config.lists[0].enabled; }, /lists.0.enabled/],
  ["empty list ID", (config) => { config.lists[0].listId = ""; }, /lists.0.listId/],
  ["empty username", (config) => { config.lists[0].requestUsername = " "; }, /lists.0.requestUsername/],
];
for (const cron of ["bad", "60 * * * *", "* * * *", "0 * * * * *", "@daily", "0 0 L * *", "0 0 * * MON#2", "*/0 * * * *"]) {
  invalidCases.push([`invalid cron ${cron}`, (config) => { config.scheduleCron = cron; }, /scheduleCron/]);
}
for (const url of ["invalid", "ftp://seerr:5055", "https://"]) {
  invalidCases.push([`invalid URL ${url}`, (config) => { config.seerrUrl = url; }, /seerrUrl/]);
}
for (const limit of [0, -1, 1.5, "10"]) {
  invalidCases.push([`invalid limit ${JSON.stringify(limit)}`, (config) => { config.lists[0].limit = limit; }, /lists.0.limit/]);
}
for (const [name, mutate, expected] of invalidCases) {
  test(name, async (t) => {
    const config = structuredClone(example);
    mutate(config);
    await assert.rejects(loadConfig(await withConfig(t, stringify(config))), expected);
  });
}

test("standard cron ranges, names, and simultaneous day fields are accepted", () => {
  for (const cron of ["*/5 0-23 * * 1-5", "0 0 1 JAN MON", "0 0 * * SUN"]) {
    assert.equal(configSchema.safeParse({ ...example, scheduleCron: cron }).success, true);
  }
});

test("validation messages do not expose credentials or unknown key names", async (t) => {
  const config = { ...example, seerrApiKey: { TOP_SECRET: "TOP_SECRET" }, TOP_SECRET: true };
  await assert.rejects(loadConfig(await withConfig(t, stringify(config))), (error) => {
    assert.match(error.message, /seerrApiKey/);
    assert.doesNotMatch(error.message, /TOP_SECRET/);
    return true;
  });
});

test("invalid configuration prevents startup and exits non-zero", async (t) => {
  const path = await withConfig(t, "dryRun: true\n");
  const result = spawnSync(process.execPath, ["src/index.js"], {
    env: { ...process.env, CONFIG_PATH: path }, encoding: "utf8", timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid configuration/);
  assert.doesNotMatch(result.stdout, /Application started successfully/);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
test(`valid configuration allows normal startup and clean ${signal} shutdown`, { timeout: 5000 }, async (t) => {
  const path = await withConfig(t, stringify(example));
  const historyPath = join(dirname(path), "history.db");
  const history = createHistory(historyPath);
  history.recordSuccessfulRequest({
    tmdbId: 123, mediaType: "movie", sourceList: "original", seerrUser: "mslr_Original",
  }, { dryRun: false });
  history.close();
  const child = spawn(process.execPath, ["src/index.js"], {
    env: { ...process.env, CONFIG_PATH: path, HISTORY_DB_PATH: historyPath },
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  let errors = "";
  let stopping = false;
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!stopping && output.includes("Application started successfully.")) {
      stopping = true;
      child.kill(signal);
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, errors);
  assert.match(output, /Configuration loaded successfully/);
  assert.match(output, /Application started successfully/);
  const reopened = createHistory(historyPath);
  try {
    assert.equal(reopened.hasRequest(123, "movie"), true);
  } finally {
    reopened.close();
  }
});
}
