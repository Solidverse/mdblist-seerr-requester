// Explicit container validation only: build both images first, then run
// node --test tests/docker-permissions.test.js (not included in npm test).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, cp, stat, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { createHistory } from "../src/db/database.js";

const image = "mdblist-seerr-requester:local";
function docker(args, success = true) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  if (success) assert.equal(result.status, 0, result.stderr);
  return result;
}

test("production permissions and isolated Compose live reload", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mslr-permissions-"));
  const config = parse(await readFile(new URL("../config.example.yml", import.meta.url), "utf8"));
  config.runOnStartup = false; config.dryRun = true; config.scheduleCron = "0 0 1 1 *";
  config.seerrApiKey = "TEST_ONLY"; config.mdblistApiKey = "TEST_ONLY";
  const yaml = stringify(config);
  t.after(async () => {
    // Only this test's newly created private directory is cleaned up.
    docker(["run", "--rm", "--network", "none", "--entrypoint", "sh", "--mount", `type=bind,src=${root},dst=/fixtures`, image, "-c", "find /fixtures -mindepth 1 -delete"]);
    await rm(root, { recursive: true, force: true });
  });
  async function fixture(name) {
    const path = join(root, name); await mkdir(path);
    await writeFile(join(path, "config.yml"), yaml, { mode: 0o600 });
    return path;
  }
  const run = (path, flags = [], code = 'console.log(process.getuid()+":"+process.getgid())') => docker([
    "run", "--rm", "--network", "none", "--security-opt", "no-new-privileges:true",
    "--mount", `type=bind,src=${path},dst=/config`, ...flags, image, "node", "--input-type=module", "-e", code,
  ], false);
  await t.test("defaults, restrictive modes, journals and persistent history", async () => {
    const path = await fixture("default");
    const history = createHistory(join(path, "history.db"));
    history.recordSuccessfulRequest({ tmdbId: 123, mediaType: "movie", sourceList: "test", seerrUser: "mslr_Test" }, { dryRun: false }); history.close();
    await writeFile(join(path, "unrelated"), "untouched");
    const before = await stat(join(path, "unrelated"));
    const result = run(path, [], `import assert from 'node:assert/strict'; import fs from 'node:fs'; import {DatabaseSync} from 'node:sqlite';
      assert.equal(process.getuid(),99); assert.equal(process.getgid(),100); assert.equal(process.pid,1);
      assert.equal(fs.statSync('/config/config.yml').mode & 511,384);
      const db=new DatabaseSync('/config/history.db'); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n,1);
      db.exec('PRAGMA journal_mode=WAL; BEGIN; UPDATE requests SET source_list=source_list; COMMIT;');
      assert.ok(fs.existsSync('/config/history.db-wal')); assert.ok(fs.existsSync('/config/history.db-shm')); db.close(); console.log('99:100');`);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /99:100/);
    assert.equal((await stat(join(path, "unrelated"))).uid, before.uid);
    assert.equal(run(path).status, 0); // recreated container reuses existing files
  });
  await t.test("custom IDs and invalid IDs", async () => {
    const path = await fixture("custom");
    const result = run(path, ["-e", "PUID=1000", "-e", "PGID=1000"]);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /1000:1000/);
    for (const env of ["PUID=0", "PUID=abc", "PUID=-1", "PGID=0", "PGID=bad", "PUID=", "PUID=4294967295"]) {
      const invalid = run(path, ["-e", env]); assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /\[INIT\] ERROR/);
    }
  });
  await t.test("read-only mount fails clearly", async () => {
    const path = await fixture("readonly");
    const result = docker(["run", "--rm", "--network", "none", "--mount", `type=bind,src=${path},dst=/config,readonly`, image, "node", "-e", "process.exit(0)"], false);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /\[INIT\] ERROR/);
  });
  await t.test("symlinks and hardlinks cannot chown external files", async () => {
    const outside = join(root, "outside"); await writeFile(outside, "untouched");
    const before = await stat(outside);
    const linked = await fixture("symlink"); await symlink("/outside", join(linked, "history.db"));
    const result = run(linked, ["--mount", `type=bind,src=${outside},dst=/outside`]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /unsafe/);
    const hard = await fixture("hardlink"); await link(outside, join(hard, "history.db"));
    assert.notEqual(run(hard).status, 0);
    const after = await stat(outside); assert.equal(after.uid, before.uid); assert.equal(after.mode, before.mode);
    assert.equal(await readFile(outside, "utf8"), "untouched");
  });
  await t.test("custom database outside config is never chowned", async () => {
    const path = await fixture("external");
    const outside = join(root, "external-data"); await mkdir(outside); await writeFile(join(outside, "history.db"), "sentinel");
    const before = await stat(join(outside, "history.db"));
    run(path, ["--mount", `type=bind,src=${outside},dst=/data`, "-e", "HISTORY_DB_PATH=/data/history.db"]);
    assert.equal((await stat(join(outside, "history.db"))).uid, before.uid);
    assert.equal(await readFile(join(outside, "history.db"), "utf8"), "sentinel");
  });
  await t.test("existing journal files keep contents and modes while ownership is corrected", async () => {
    const path = await fixture("journals");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) await writeFile(join(path, `history.db${suffix}`), "sentinel", { mode: 0o600 });
    const result = run(path, [], `import assert from 'node:assert/strict'; import fs from 'node:fs';
      for(const suffix of ['', '-wal', '-shm', '-journal']) { const path='/config/history.db'+suffix;
        assert.equal(fs.readFileSync(path,'utf8'),'sentinel'); assert.equal(fs.statSync(path).uid,99); assert.equal(fs.statSync(path).gid,100);
        assert.equal(fs.statSync(path).mode & 511,384); }`);
    assert.equal(result.status, 0, result.stderr);
  });
  await t.test("production Node is PID 1 as UID 99 and handles SIGTERM cleanly", async () => {
    const path = await fixture("shutdown");
    const name = `mslr-shutdown-${Date.now()}`;
    try {
      docker(["run", "-d", "--name", name, "--network", "none", "--mount", `type=bind,src=${path},dst=/config`, image]);
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (docker(["logs", name]).stdout.includes("Application started successfully.")) { ready = true; break; }
        await delay(100);
      }
      assert.ok(ready, "Production startup did not complete");
      const status = docker(["exec", name, "cat", "/proc/1/status"]).stdout;
      assert.match(docker(["exec", name, "cat", "/proc/1/cmdline"]).stdout, /^node\0src\/index\.js\0$/); assert.match(status, /^Uid:\s+99\s+99\s+99\s+99$/m);
      docker(["stop", "--timeout", "30", name]);
      assert.equal(docker(["inspect", name, "--format", "{{.State.ExitCode}}" ]).stdout.trim(), "0");
      assert.match(docker(["logs", name]).stdout, /\[SCHEDULER\] Stopped/);
    } finally { docker(["rm", "-f", name]); }
  });
  await t.test("Compose uses development stage, watches copied source and leaves ownership untouched", async () => {
    const path = await fixture("dev");
    const source = join(root, "src"); await cp(resolve("src"), source, { recursive: true });
    const initial = await stat(join(path, "config.yml"));
    const project = `mslrcheck${Date.now()}`;
    const override = join(root, "compose.yml");
    await writeFile(override, stringify({ services: { requester: {
      image: "mdblist-seerr-requester:dev-validation", network_mode: "none",
      volumes: [`${path}:/config`, `${source}:/app/src:ro`],
    } } }));
    const compose = ["compose", "-p", project, "-f", resolve("compose.yaml"), "-f", override];
    try {
      docker([...compose, "up", "-d", "--no-build"]);
      async function started(count) {
        for (let i = 0; i < 100; i++) {
          const logs = docker([...compose, "logs", "--no-color"]).stdout;
          if (logs.split("Application started successfully.").length - 1 >= count) return;
          await delay(100);
        }
        assert.fail("Development source reload did not complete.");
      }
      await started(1);
      await writeFile(join(source, "index.js"), `${await readFile(join(source, "index.js"), "utf8")}\n// reload validation\n`);
      await started(2);
      assert.equal((await stat(join(path, "config.yml"))).uid, initial.uid);
      const id = docker([...compose, "ps", "-q", "requester"]).stdout.trim();
      const logs = docker(["logs", id]).stdout;
      assert.ok(!logs.includes("[INIT]"));
    } finally { docker([...compose, "down", "--timeout", "30"]); }
  });
});
