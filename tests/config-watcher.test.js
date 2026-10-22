import assert from "node:assert/strict";
import fsPromises, { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { createConfigWatcher } from "../src/config/watcher.js";
import { createScheduler } from "../src/scheduler.js";

const example = parse(await readFile(new URL("../config.example.yml", import.meta.url), "utf8"));

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for configuration watcher");
    await delay(20);
  }
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "requester-watcher-"));
  const path = join(directory, "config.yml");
  let watcher;
  t.after(async () => {
    watcher?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path, stringify(example));
  const logs = [];
  const errors = [];
  watcher = await createConfigWatcher(path, {
    logger: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
  });
  return { directory, path, watcher, logs, errors };
}

test("watcher loads initial configuration before returning and replaces it on valid reload", async (t) => {
  const { path, watcher, logs } = await setup(t);
  const previous = watcher.getConfig();
  assert.deepEqual(previous, example);
  const next = { ...example, dryRun: !example.dryRun, lists: [...example.lists].reverse() };
  await writeFile(path, stringify(next));
  await waitFor(() => logs.length === 1);
  assert.deepEqual(watcher.getConfig(), next);
  assert.notEqual(watcher.getConfig(), previous);
  assert.deepEqual(previous, example);
  assert.equal(logs[0], "[CONFIG] Configuration reloaded successfully.");
});

test("invalid configuration keeps the same previous object without exposing secrets", async (t) => {
  const { path, watcher, errors, logs } = await setup(t);
  const previous = watcher.getConfig();
  await writeFile(path, stringify({ ...example, seerrApiKey: { TOP_SECRET: "TOP_SECRET" } }));
  await waitFor(() => errors.length === 1);
  assert.equal(watcher.getConfig(), previous);
  assert.equal(logs.length, 0);
  assert.match(errors[0], /keeping previous configuration.*seerrApiKey/s);
  assert.doesNotMatch(errors[0], /TOP_SECRET/);
});

test("watcher recovers after invalid YAML is fixed", async (t) => {
  const { path, watcher, errors, logs } = await setup(t);
  const previous = watcher.getConfig();
  await writeFile(path, "seerrApiKey: [TOP_SECRET\n");
  await waitFor(() => errors.length === 1);
  assert.equal(watcher.getConfig(), previous);
  assert.match(errors[0], /Invalid YAML/);
  assert.doesNotMatch(errors[0], /TOP_SECRET/);
  await writeFile(path, stringify({ ...example, dryRun: false }));
  await waitFor(() => logs.length === 1);
  assert.equal(watcher.getConfig().dryRun, false);
});

test("rapid filesystem events are debounced into one reload of the latest configuration", async (t) => {
  const { path, watcher, logs, errors } = await setup(t);
  for (let version = 1; version <= 5; version++) {
    const next = structuredClone(example);
    next.lists[0].requestUsername = `Trending${version}`;
    await writeFile(path, stringify(next));
    await delay(30);
  }
  await waitFor(() => logs.length > 0);
  await delay(400);
  assert.equal(logs.length, 1);
  assert.equal(errors.length, 0);
  assert.equal(watcher.getConfig().lists[0].requestUsername, "Trending5");
});

test("atomic file replacement and subsequent saves are detected", async (t) => {
  const { directory, path, watcher, logs } = await setup(t);
  const temporary = join(directory, "config.tmp");
  await writeFile(temporary, stringify({ ...example, dryRun: false }));
  await rename(temporary, path);
  await waitFor(() => logs.length === 1);
  assert.equal(watcher.getConfig().dryRun, false);
  await writeFile(path, stringify({ ...example, dryRun: true }));
  await waitFor(() => logs.length === 2);
  assert.equal(watcher.getConfig().dryRun, true);
});

test("unrelated directory changes do not trigger reloads", async (t) => {
  const { directory, logs, errors } = await setup(t);
  await writeFile(join(directory, "unrelated.yml"), "invalid: [\n");
  await delay(500);
  assert.deepEqual(logs, []);
  assert.deepEqual(errors, []);
});

test("close cancels pending reloads and stops subsequent changes", async (t) => {
  const { path, watcher, logs, errors } = await setup(t);
  const previous = watcher.getConfig();
  await writeFile(path, stringify({ ...example, dryRun: false }));
  await delay(80);
  watcher.close();
  watcher.close();
  await writeFile(path, "invalid: [\n");
  await delay(500);
  assert.equal(watcher.getConfig(), previous);
  assert.deepEqual(logs, []);
  assert.deepEqual(errors, []);
});

test("invalid initial configuration rejects watcher creation", async (t) => {
  const { path } = await setup(t);
  await writeFile(path, "dryRun: true\n");
  await assert.rejects(createConfigWatcher(path), /Invalid configuration/);
});

test("changes during a reload are queued without overlapping reads", async (t) => {
  const { path, watcher, logs } = await setup(t);
  const originalReadFile = fsPromises.readFile;
  let reads = 0;
  let activeReads = 0;
  let maximumActiveReads = 0;
  const gate = Promise.withResolvers();
  t.mock.method(fsPromises, "readFile", async (...args) => {
    reads++;
    activeReads++;
    maximumActiveReads = Math.max(maximumActiveReads, activeReads);
    try {
      const source = await originalReadFile(...args);
      if (reads === 1) await gate.promise;
      return source;
    } finally {
      activeReads--;
    }
  });
  syncBuiltinESMExports();
  t.after(() => {
    gate.resolve();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await writeFile(path, stringify({ ...example, dryRun: false }));
  await waitFor(() => activeReads === 1);
  await writeFile(path, stringify({ ...example, dryRun: true }));
  // Let the second debounce expire while the first read is still pending.
  await delay(450);
  assert.equal(reads, 1);
  gate.resolve();
  await waitFor(() => logs.length === 2);
  assert.equal(reads, 2);
  assert.equal(maximumActiveReads, 1);
  assert.equal(watcher.getConfig().dryRun, true);
});

test("subscribers and scheduler only react to validated reloads and can unsubscribe", async (t) => {
  const { path, watcher, errors } = await setup(t);
  const notifications = [];
  const unsubscribe = watcher.subscribe(() => notifications.push(watcher.getConfig()));
  const schedulerLogs = [];
  const scheduler = createScheduler(watcher, {
    logger: { log: (message) => schedulerLogs.push(message), error() {} },
  });
  t.after(() => scheduler.stop());
  scheduler.start();
  await writeFile(path, stringify({ ...example, scheduleCron: "invalid" }));
  await waitFor(() => errors.length === 1);
  assert.equal(notifications.length, 0);
  assert.equal(schedulerLogs.filter((message) => message.includes("Next execution")).length, 1);
  await writeFile(path, stringify({ ...example, scheduleCron: "*/2 * * * *" }));
  await waitFor(() => notifications.length === 1);
  assert.equal(notifications[0], watcher.getConfig());
  assert.ok(schedulerLogs.includes("[SCHEDULER] Schedule updated."));
  unsubscribe();
  await writeFile(path, stringify({ ...example, scheduleCron: "*/3 * * * *" }));
  await waitFor(() => schedulerLogs.filter((message) => message.includes("Schedule updated")).length === 2);
  assert.equal(notifications.length, 1);
});
