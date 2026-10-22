import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createHistory } from "../src/db/database.js";

const record = {
  tmdbId: 123, mediaType: "movie", sourceList: "trending",
  seerrUser: "mslr_Trending", seerrRequestId: 456,
};
const live = { dryRun: false };

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "requester-history-"));
  const path = join(directory, "history.db");
  let history;
  t.after(async () => {
    history?.close();
    await rm(directory, { recursive: true, force: true });
  });
  history = createHistory(path);
  return { directory, path, history };
}

test("initialization creates only the requests table with the required constraints", async (t) => {
  const { path } = await setup(t);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name), ["requests"]);
  const columns = db.prepare("PRAGMA table_info(requests)").all();
  assert.deepEqual(columns.map((column) => column.name), [
    "tmdb_id", "media_type", "source_list", "seerr_user", "requested_at", "seerr_request_id",
  ]);
  assert.deepEqual(columns.filter((column) => column.pk).map((column) => column.name), ["tmdb_id", "media_type"]);
  assert.throws(() => db.prepare("INSERT INTO requests (tmdb_id, media_type, source_list, seerr_user) VALUES (1, 'invalid', 'list', 'mslr_user')").run(), /CHECK/);
});

test("successful insertion stores attribution, nullable request ID, and UTC submission timestamp", async (t) => {
  const { path, history } = await setup(t);
  const before = Date.now();
  assert.equal(history.recordSuccessfulRequest(record, live), true);
  assert.equal(history.recordSuccessfulRequest({ ...record, tmdbId: 124, seerrRequestId: undefined }, live), true);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const stored = db.prepare("SELECT * FROM requests WHERE tmdb_id = ?").get(123);
  assert.equal(stored.source_list, record.sourceList);
  assert.equal(stored.seerr_user, record.seerrUser);
  assert.equal(stored.seerr_request_id, 456);
  const timestamp = Date.parse(`${stored.requested_at.replace(" ", "T")}Z`);
  assert.ok(timestamp >= Math.floor(before / 1000) * 1000 && timestamp <= Date.now());
  assert.equal(db.prepare("SELECT seerr_request_id FROM requests WHERE tmdb_id = 124").get().seerr_request_id, null);
});

test("duplicate insertion never overwrites the original record", async (t) => {
  const { path, history } = await setup(t);
  history.recordSuccessfulRequest(record, live);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const original = db.prepare("SELECT * FROM requests").get();
  assert.equal(history.recordSuccessfulRequest({ ...record, sourceList: "other", seerrUser: "mslr_Other", seerrRequestId: 999 }, live), false);
  assert.deepEqual(db.prepare("SELECT * FROM requests").get(), original);
});

test("lookups and uniqueness use both TMDB ID and media type", async (t) => {
  const { history } = await setup(t);
  assert.equal(history.hasRequest(123, "movie"), false);
  history.recordSuccessfulRequest(record, live);
  assert.equal(history.hasRequest(123, "movie"), true);
  assert.equal(history.hasRequest(123, "tv"), false);
  assert.equal(history.recordSuccessfulRequest({ ...record, mediaType: "tv" }, live), true);
  assert.equal(history.hasRequest(123, "tv"), true);
  assert.equal(history.hasRequest(999, "movie"), false);
});

test("history persists across closing and repeated initialization", async (t) => {
  const { history, path } = await setup(t);
  history.recordSuccessfulRequest(record, live);
  history.close();
  for (let restart = 0; restart < 2; restart++) {
    const reopened = createHistory(path);
    try {
      assert.equal(reopened.hasRequest(123, "movie"), true);
      assert.equal(reopened.recordSuccessfulRequest(record, live), false);
    } finally {
      reopened.close();
    }
  }
});

test("explicit removal deletes only the identified title and allows manual re-request", async (t) => {
  const { history } = await setup(t);
  history.recordSuccessfulRequest(record, live);
  history.recordSuccessfulRequest({ ...record, mediaType: "tv" }, live);
  assert.equal(history.removeRequest(123, "movie", live), true);
  assert.equal(history.removeRequest(123, "movie", live), false);
  assert.equal(history.hasRequest(123, "movie"), false);
  assert.equal(history.hasRequest(123, "tv"), true);
  assert.equal(history.recordSuccessfulRequest(record, live), true);
});

test("dry-run never inserts or removes history and missing dryRun is rejected", async (t) => {
  const { history } = await setup(t);
  assert.equal(history.recordSuccessfulRequest(record, { dryRun: true }), false);
  assert.equal(history.hasRequest(123, "movie"), false);
  history.recordSuccessfulRequest(record, live);
  assert.equal(history.removeRequest(123, "movie", { dryRun: true }), false);
  assert.equal(history.hasRequest(123, "movie"), true);
  for (const options of [undefined, {}, { dryRun: "false" }, { dryRun: 0 }]) {
    assert.throws(() => history.recordSuccessfulRequest({ ...record, tmdbId: 999 }, options), /dryRun/);
    assert.throws(() => history.removeRequest(123, "movie", options), /dryRun/);
  }
  assert.equal(history.hasRequest(999, "movie"), false);
  assert.equal(history.hasRequest(123, "movie"), true);
});

test("invalid input is rejected without inserting history", async (t) => {
  const { history } = await setup(t);
  for (const tmdbId of [0, -1, 1.5, "123", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => history.hasRequest(tmdbId, "movie"), /tmdbId/);
    assert.throws(() => history.removeRequest(tmdbId, "movie", live), /tmdbId/);
    assert.throws(() => history.recordSuccessfulRequest({ ...record, tmdbId }, live), /tmdbId/);
  }
  for (const mediaType of ["series", "MOVIE", null, "movie'; DROP TABLE requests; --"]) {
    assert.throws(() => history.hasRequest(123, mediaType), /mediaType/);
    assert.throws(() => history.removeRequest(123, mediaType, live), /mediaType/);
    assert.throws(() => history.recordSuccessfulRequest({ ...record, mediaType }, live), /mediaType/);
  }
  for (const invalid of [null, undefined, {}, { ...record, sourceList: " " }, { ...record, seerrUser: "Trending" }, { ...record, seerrUser: "mslr_ " }, { ...record, seerrRequestId: -1 }]) {
    assert.throws(() => history.recordSuccessfulRequest(invalid, live), TypeError);
  }
  assert.equal(history.hasRequest(123, "movie"), false);
});

test("parameter binding stores text literally", async (t) => {
  const { history } = await setup(t);
  assert.equal(history.recordSuccessfulRequest({ ...record, sourceList: "'; DROP TABLE requests; --" }, live), true);
  assert.equal(history.hasRequest(123, "movie"), true);
});

test("database open and initialization errors are clear and sanitized", async (t) => {
  const { directory } = await setup(t);
  assert.throws(() => createHistory(join(directory, "TOP_SECRET", "history.db")), (error) => {
    assert.match(error.message, /could not be opened or initialized/);
    assert.doesNotMatch(error.message, /TOP_SECRET/);
    return true;
  });
  const corrupt = join(directory, "corrupt.db");
  await writeFile(corrupt, "not a SQLite database");
  assert.throws(() => createHistory(corrupt), /could not be opened or initialized/);
});

test("database operation errors propagate and do not create false history", async (t) => {
  const { history, path } = await setup(t);
  const other = new DatabaseSync(path);
  try {
    other.exec("BEGIN EXCLUSIVE");
    assert.throws(() => history.recordSuccessfulRequest(record, live), /locked/);
  } finally {
    other.exec("ROLLBACK");
    other.close();
  }
  assert.equal(history.hasRequest(123, "movie"), false);
  assert.equal(history.recordSuccessfulRequest(record, live), true);
});

test("close is idempotent and prevents all subsequent operations", async (t) => {
  const { history } = await setup(t);
  history.close();
  history.close();
  assert.throws(() => history.hasRequest(123, "movie"), /closed/);
  assert.throws(() => history.recordSuccessfulRequest(record, live), /closed/);
  assert.throws(() => history.removeRequest(123, "movie", live), /closed/);
});

test("HISTORY_DB_PATH selects the database location", async (t) => {
  const { directory } = await setup(t);
  const previous = process.env.HISTORY_DB_PATH;
  const path = join(directory, "environment.db");
  process.env.HISTORY_DB_PATH = path;
  try {
    const history = createHistory();
    history.recordSuccessfulRequest(record, live);
    history.close();
    const reopened = createHistory(path);
    assert.equal(reopened.hasRequest(123, "movie"), true);
    reopened.close();
  } finally {
    if (previous === undefined) delete process.env.HISTORY_DB_PATH;
    else process.env.HISTORY_DB_PATH = previous;
  }
});

test("database initialization failure prevents scheduler startup", async (t) => {
  const { directory } = await setup(t);
  const configPath = join(directory, "config.yml");
  await writeFile(configPath, await readFile(new URL("../config.example.yml", import.meta.url)));
  const result = spawnSync(process.execPath, ["src/index.js"], {
    env: { ...process.env, CONFIG_PATH: configPath, HISTORY_DB_PATH: join(directory, "missing", "history.db") },
    encoding: "utf8", timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /History database could not be opened or initialized/);
  assert.doesNotMatch(result.stdout, /\[SCHEDULER\] Started|Application started successfully/);
});
