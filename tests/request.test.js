import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { createHistory } from "../src/db/database.js";
import { runRequestEngine } from "../src/engines/request.js";
import { createScheduler } from "../src/scheduler.js";
import { accountName } from "../src/integrations/seerr.js";
const item = (id, type = "movie") => ({ tmdbId: id, mediaType: type, title: `Title ${id}` });
test("account normalization is exported and never doubles the prefix", () => {
  assert.equal(accountName("Trending"), "mslr_Trending");
  assert.equal(accountName("mslr_Trending"), "mslr_Trending");
});
const list = (id, extra = {}) => ({ listId: id, enabled: true, requestUsername: "Trending", autoApproveMovies: false, autoApproveSeries: false, ...extra });
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "request-engine-"));
  const path = join(dir, "history.db");
  const history = createHistory(options.memory ? ":memory:" : path);
  t.after(async () => { history.close(); await rm(dir, { recursive: true, force: true }); });
  const config = { dryRun: false, lists: [list("first")], ...options.config };
  const calls = []; const logs = [];
  const deps = { history, logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    mdblistFactory: (snapshot) => ({ getListItems: async (id) => {
      calls.push(["retrieve", id]);
      if (options.retrieve) return options.retrieve(id, snapshot);
      return options.items ?? [item(1)];
    } }),
    seerrFactory: (snapshot) => ({
      getOrCreateUser: async (name, args) => {
        calls.push(["account", name, args]);
        if (options.account) return options.account(name, args);
        return snapshot.dryRun ? { userId: null, wouldCreate: true } : 2;
      },
      createRequest: async (args) => {
        calls.push(["submit", args]);
        if (options.submit) return options.submit(args);
        return snapshot.dryRun ? { submitted: false, dryRun: true, wouldSubmit: true } : {
          submitted: true, requestId: args.tmdbId + 100, status: 1,
          tmdbId: args.tmdbId, mediaType: args.mediaType, userId: args.userId,
        };
      },
      approveRequest: async (id, args) => {
        calls.push(["approve", id, args]);
        assert.equal(history.hasRequest(id - 100, options.tv ? "tv" : "movie"), true, "History must precede approval");
        if (options.approve) return options.approve(id);
        return { id, status: 2 };
      },
    }),
  };
  return { config, deps, history, path, calls, logs, run: () => runRequestEngine(config, deps) };
}

test("one list persists a confirmed pending request and skips it on the next run", async (t) => {
  const s = await setup(t); const summary = await s.run();
  assert.equal(summary.submitted, 1); assert.equal(summary.pending, 1);
  assert.equal((await s.run()).skippedHistory, 1);
  const db = new DatabaseSync(s.path); t.after(() => db.close());
  const row = db.prepare("SELECT * FROM requests").get();
  assert.equal(row.source_list, "first"); assert.equal(row.seerr_user, "mslr_Trending"); assert.equal(row.seerr_request_id, 101);
});
test("discovery completes before ownership; YAML order and approval win over overlaps", async (t) => {
  const s = await setup(t, { config: { lists: [list("first", { autoApproveMovies: true }), list("second", { requestUsername: "Other" })] }, items: [item(1), item(1)] });
  const result = await s.run();
  assert.equal(result.duplicates, 3); assert.equal(result.submitted, 1); assert.equal(result.approved, 1);
  assert.deepEqual(s.calls.slice(0, 2), [["retrieve", "first"], ["retrieve", "second"]]);
  assert.equal(s.calls.find(([kind]) => kind === "submit")[1].autoApprove, false);
});
test("failed retrieval/account lists do not claim ownership, disabled lists are not fetched", async (t) => {
  const s = await setup(t, { config: { lists: [list("bad"), list("account", { requestUsername: "Bad" }), list("good"), list("off", { enabled: false })] },
    retrieve: (id) => { if (id === "bad") throw new Error("SECRET"); return [item(1)]; },
    account: (name) => { if (name === "Bad") throw new Error("SECRET"); return 2; } });
  const r = await s.run(); assert.equal(r.listsFailed, 2); assert.equal(r.listsSkipped, 1); assert.equal(r.submitted, 1);
  assert.ok(!s.logs.join().includes("SECRET"));
  const db = new DatabaseSync(s.path); t.after(() => db.close());
  assert.equal(db.prepare("SELECT source_list FROM requests").get().source_list, "good");
});
test("empty lists do not create accounts", async (t) => {
  const s = await setup(t, { items: [] }); assert.equal((await s.run()).uniqueTitles, 0); assert.equal(s.calls.length, 1);
});
for (const tv of [false, true]) for (const approve of [false, true]) {
  test(`per-request approval tv=${tv} enabled=${approve}`, async (t) => {
    const s = await setup(t, { tv, items: [item(1, tv ? "tv" : "movie")], config: { lists: [list("first", { autoApproveMovies: approve, autoApproveSeries: approve })] } });
    const r = await s.run(); assert.equal(r.approved, Number(approve)); assert.equal(r.pending, Number(!approve));
  });
}
test("movie and TV with same numeric ID remain distinct, shared accounts resolve once", async (t) => {
  const s = await setup(t, { config: { lists: [list("a"), list("b")] }, items: [item(1), item(1, "tv")] });
  const r = await s.run(); assert.equal(r.submitted, 2); assert.equal(r.duplicates, 2);
  assert.equal(s.calls.filter(([kind]) => kind === "account").length, 1);
});
for (const outcome of ["existing", "failed", "uncertain", "invalid"]) {
  test(`${outcome} does not enter history or transfer ownership`, async (t) => {
    const s = await setup(t, { config: { lists: [list("a"), list("b")] }, submit: () => {
      if (outcome === "failed" || outcome === "uncertain") throw Object.assign(new Error("SECRET"), { uncertain: outcome === "uncertain" });
      return outcome === "existing" ? { submitted: false, existing: true } : { submitted: true };
    } });
    const r = await s.run(); assert.equal(s.history.hasRequest(1, "movie"), false);
    assert.equal(s.calls.filter(([kind]) => kind === "submit").length, 1);
    assert.equal(r.skippedSeerr + r.failed + r.uncertain, 1);
  });
}
test("approval failure retains durable history without resubmission", async (t) => {
  const s = await setup(t, { config: { lists: [list("a", { autoApproveMovies: true })] }, approve: () => { throw new Error(); } });
  const r = await s.run(); assert.equal(r.approvalFailures, 1); assert.equal(r.submitted, 1);
  assert.equal((await s.run()).skippedHistory, 1);
});
test("SQLite failure stops the run before approval or other submissions", async (t) => {
  const s = await setup(t, { items: [item(1), item(2)], config: { lists: [list("a", { autoApproveMovies: true })] } });
  s.deps.history = { hasRequest: s.history.hasRequest, recordSuccessfulRequest() { throw new Error("SECRET"); } };
  await assert.rejects(s.run(), (error) => { assert.equal(error.requestId, 101); assert.ok(!error.message.includes("SECRET")); return true; });
  assert.equal(s.calls.filter(([k]) => k === "submit").length, 1); assert.ok(!s.calls.some(([k]) => k === "approve"));
});
test("dry-run preserves history, plans missing account and approval with first-list priority", async (t) => {
  const s = await setup(t, { config: { dryRun: true, lists: [list("a", { autoApproveMovies: true }), list("b")] }, items: [item(1), item(2)] });
  s.history.recordSuccessfulRequest({ tmdbId: 1, mediaType: "movie", sourceList: "original", seerrUser: "mslr_Original" }, { dryRun: false });
  const r = await s.run(); assert.equal(r.dryRun, 1); assert.equal(r.skippedHistory, 1); assert.equal(r.duplicates, 2);
  assert.equal(s.history.hasRequest(2, "movie"), false);
  assert.ok(!s.calls.some(([k]) => k === "approve"));
  const args = s.calls.find(([k]) => k === "submit")[1]; assert.equal(args.dryRun, true); assert.equal(args.autoApprove, true); assert.equal(args.userId, null); assert.equal(args.requestUsername, "Trending");
});
test("all 1201 titles are considered without limits", async (t) => {
  const s = await setup(t, { memory: true, items: Array.from({ length: 1201 }, (_, i) => item(i + 1)) });
  assert.equal((await s.run()).submitted, 1201);
});
test("snapshot mutations during discovery cannot alter approval, credentials or list ownership", async (t) => {
  let s;
  s = await setup(t, { retrieve: (_id, snapshot) => {
    s.config.lists[0].autoApproveMovies = true; s.config.dryRun = true;
    assert.equal(snapshot.dryRun, false); return [item(1)];
  } });
  const r = await s.run(); assert.equal(r.submitted, 1); assert.equal(r.approved, 0);
});
test("scheduler passes snapshots, prevents overlap, recovers after failure and waits at shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-23T12:00:00Z") });
  const s = await setup(t);
  let config = { ...s.config, scheduleCron: "* * * * *", runOnStartup: true };
  const gate = Promise.withResolvers(); let calls = 0;
  const scheduler = createScheduler({ getConfig: () => config, subscribe: () => () => {} }, {
    logger: s.deps.logger, execute: async (snapshot) => { calls++; if (calls === 1) { await gate.promise; throw new Error(); } await runRequestEngine(snapshot, s.deps); },
  });
  t.after(() => { gate.resolve(); return scheduler.stop(); });
  scheduler.start(); await setImmediate();
  config = { ...config, dryRun: true };
  t.mock.timers.tick(60_000); await setImmediate(); assert.equal(calls, 1);
  gate.resolve(); await setImmediate(); t.mock.timers.tick(60_000); await setImmediate();
  await scheduler.stop(); assert.equal(calls, 2); assert.equal(s.history.hasRequest(1, "movie"), false);
  t.mock.timers.tick(120_000); await setImmediate(); assert.equal(calls, 2);
});

test("real client HTTP 403 during account lookup reaches engine logs with safe context", async (t) => {
  const { createSeerrClient } = await import("../src/integrations/seerr.js");
  const s = await setup(t, { config: { dryRun: true, seerrUrl: "http://seerr:5055", seerrApiKey: "SECRET_KEY", lists: [list("garycrawfordgc/top-movies-of-the-week", { requestUsername: "Test" })] } });
  let calls = 0;
  s.deps.seerrFactory = (config) => createSeerrClient(config, { fetchImpl: async (_url, args) => {
    calls++; assert.equal(args.method, "GET");
    return new Response('SECRET_KEY Authorization X-Api-Key private@example.com', { status: 403 });
  } });
  const result = await s.run();
  assert.equal(result.listsFailed, 1); assert.equal(calls, 1);
  const logs = s.logs.join("\n");
  assert.match(logs, /GET \/api\/v1\/user/); assert.match(logs, /HTTP 403 Forbidden/);
  assert.match(logs, /garycrawfordgc\/top-movies-of-the-week/); assert.match(logs, /mslr_Test/);
  assert.doesNotMatch(logs, /SECRET_KEY|Authorization|X-Api-Key|private@example/);
});

for (const stage of ["retrieve", "account", "submit", "approve", "history"]) {
  test(`diagnostics preserve safe metadata and actions for ${stage}`, async (t) => {
    const error = Object.assign(new Error("SECRET Authorization: token private@example.com https://user:pass@host/?apikey=SECRET"), {
      operation: stage === "retrieve" ? "GET /lists/{listid}/items" : "POST /api/v1/request",
      httpStatus: stage === "retrieve" ? 429 : 500, code: "ECONNREFUSED", uncertain: stage === "submit",
    });
    const options = { config: { lists: [list("a", { autoApproveMovies: true })] } };
    options[stage] = () => { throw error; };
    const s = await setup(t, options);
    if (stage === "history") s.deps.history = { hasRequest: () => { throw error; } };
    if (stage === "history") await assert.rejects(s.run(), /History lookup/); else await s.run();
    const logs = s.logs.join("\n");
    assert.match(logs, stage === "retrieve" ? /HTTP 429 Too Many Requests/ : /HTTP 500 Internal Server Error/);
    assert.match(logs, /ECONNREFUSED/);
    assert.doesNotMatch(logs, /SECRET|Authorization|private@example|user:pass/);
    if (stage === "submit") assert.match(logs, /UNCERTAIN.*manual verification/);
    if (stage === "history") assert.match(logs, /stopping run/);
  });
}

test("unsafe error metadata, cyclic causes and context secrets are never printed", async () => {
  const { formatError, safeContext } = await import("../src/utils/errors.js");
  const error = Object.assign(new Error("SECRET private@example.com"), {
    operation: "GET https://user:SECRET@host/?apikey=SECRET", code: "SECRET",
    httpStatus: "403 SECRET", candidateRequestId: "SECRET", headers: { Authorization: "SECRET" },
  });
  error.cause = error;
  assert.doesNotMatch(formatError(error), /SECRET|private@example|Authorization|https:/);
  assert.doesNotMatch(safeContext({ list: "SECRET", account: "private@example.com", url: "https://host/?apikey=SECRET" }, ["SECRET"]), /SECRET|private@example|https:/);
});

for (const mediaType of ["movie", "tv"]) {
  test(`IMDb filtering validates ratings and preserves order for ${mediaType}`, async (t) => {
    const ratings = [8, 6, 5.9, undefined, null, "8", NaN, Infinity, -1, 11];
    const s = await setup(t, { items: ratings.map((imdbRating, i) => ({ ...item(i + 1, mediaType), imdbRating })),
      config: { lists: [list("first", { minImdbRating: 6 })] } });
    await s.run();
    assert.deepEqual(s.calls.filter(([k]) => k === "submit").map(([, args]) => args.tmdbId), [1, 2]);
    assert.match(s.logs.join(), /IMDb filter rejected 8.*missing or invalid IMDb rating=7.*below minimum 6=1/);
  });
}

test("release age accepts both boundaries and rejects older, future and invalid years", async (t) => {
  const year = new Date().getFullYear();
  const years = [year, year - 2, year - 3, year + 1, undefined, null, "2026", 2026.5, 0, -1, Infinity, Number.MAX_SAFE_INTEGER + 1];
  const s = await setup(t, { items: years.map((releaseYear, i) => ({ ...item(i + 1, i % 2 ? "tv" : "movie"), releaseYear })),
    config: { lists: [list("first", { maxReleaseAge: 2 })] } });
  await s.run();
  assert.deepEqual(s.calls.filter(([k]) => k === "submit").map(([, args]) => args.tmdbId), [1, 2]);
  assert.match(s.logs.join(), /Release age filter rejected 10.*missing or invalid release year=8.*outside allowed range.*=2/);
});

test("zero thresholds are active and the current year updates between runs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-01T12:00:00Z") });
  const s = await setup(t, { config: { dryRun: true, lists: [list("first", { minImdbRating: 0, maxReleaseAge: 0 })] },
    items: [{ ...item(1), imdbRating: 0, releaseYear: 2026 }, { ...item(2), imdbRating: 8, releaseYear: 2027 },
      { ...item(3), releaseYear: 2026 }, { ...item(4), imdbRating: 8, releaseYear: 2025 }] });
  assert.equal((await s.run()).dryRun, 1);
  assert.equal(s.calls.find(([k]) => k === "submit")[1].tmdbId, 1);
  s.calls.length = 0;
  t.mock.timers.setTime(Date.parse("2027-06-01T12:00:00Z"));
  assert.equal((await s.run()).dryRun, 1);
  assert.equal(s.calls.find(([k]) => k === "submit")[1].tmdbId, 2);
  assert.equal(s.history.hasRequest(1, "movie"), false);
  assert.equal(s.history.hasRequest(2, "movie"), false);
});

test("rejected titles reach neither history nor Seerr and remain eligible on later runs", async (t) => {
  const s = await setup(t, { config: { lists: [list("first", { minImdbRating: 6, maxReleaseAge: 0 })] },
    items: [{ ...item(1), imdbRating: 5, releaseYear: new Date().getFullYear() }] });
  const reads = []; const writes = [];
  s.deps.history = { hasRequest: (...args) => { reads.push(args); return false; },
    recordSuccessfulRequest: (...args) => { writes.push(args); return true; } };
  assert.equal((await s.run()).submitted, 0);
  assert.deepEqual(reads, []); assert.deepEqual(writes, []);
  assert.deepEqual(s.calls, [["retrieve", "first"]]);
  s.config.lists[0].minImdbRating = 5;
  assert.equal((await s.run()).submitted, 1);
  assert.equal(reads.length, 1); assert.equal(writes.length, 1);
});

for (const filter of [{ minImdbRating: 9 }, { maxReleaseAge: 0 }]) {
  test(`higher-priority rejection permits lower-priority ownership: ${Object.keys(filter)[0]}`, async (t) => {
    const s = await setup(t, { config: { lists: [list("first", filter), list("second", { requestUsername: "Other" })] },
      items: [{ ...item(1), imdbRating: 7, releaseYear: new Date().getFullYear() - 1 }] });
    const r = await s.run();
    assert.equal(r.submitted, 1); assert.equal(r.duplicates, 0);
    assert.equal(s.calls.find(([k]) => k === "submit")[1].requestUsername, "Other");
    const db = new DatabaseSync(s.path); t.after(() => db.close());
    assert.equal(db.prepare("SELECT source_list FROM requests").get().source_list, "second");
  });
}
