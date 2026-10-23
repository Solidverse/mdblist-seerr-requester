import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createScheduler } from "../src/scheduler.js";

function setup(t, { runOnStartup = false, scheduleCron = "* * * * *", execute = async () => {}, timezone = "UTC" } = {}) {
  const previousTZ = process.env.TZ;
  process.env.TZ = timezone;
  t.after(() => {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-22T12:00:00Z") });
  let config = { scheduleCron, runOnStartup };
  const subscribers = new Set();
  const logs = [];
  const errors = [];
  const executions = [];
  const scheduler = createScheduler({
    getConfig: () => config,
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  }, {
    logger: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    execute: async (snapshot) => { executions.push(snapshot); await execute(snapshot); },
  });
  t.after(() => scheduler.stop());
  return {
    scheduler, logs, errors, executions, subscribers,
    update(changes) {
      config = { ...config, ...changes };
      for (const callback of subscribers) callback();
    },
    async tick(ms) { t.mock.timers.tick(ms); await setImmediate(); },
  };
}

test("cron schedules executions at the next boundary without startup execution", async (t) => {
  const { scheduler, tick, executions, logs } = setup(t);
  scheduler.start();
  await tick(59_999);
  assert.equal(executions.length, 0);
  await tick(1);
  assert.equal(executions.length, 1);
  await tick(60_000);
  assert.equal(executions.length, 2);
  assert.ok(logs.includes("[SCHEDULER] Next execution: 2026-10-22T12:01:00.000Z"));
});

test("startup execution runs immediately and start is idempotent", async (t) => {
  const { scheduler, tick, executions } = setup(t, { runOnStartup: true });
  scheduler.start();
  scheduler.start();
  await tick(0);
  assert.equal(executions.length, 1);
  await tick(60_000);
  assert.equal(executions.length, 2);
});

test("overlapping executions are skipped without queuing", async (t) => {
  const gate = Promise.withResolvers();
  const { scheduler, tick, executions, logs } = setup(t, {
    runOnStartup: true, execute: () => gate.promise,
  });
  t.after(() => gate.resolve());
  scheduler.start();
  await tick(0);
  await tick(60_000);
  await tick(60_000);
  assert.equal(executions.length, 1);
  assert.equal(logs.filter((message) => message.includes("Execution skipped")).length, 2);
  gate.resolve();
  await tick(0);
  assert.equal(executions.length, 1);
  await tick(60_000);
  assert.equal(executions.length, 2);
});

test("execution failure is sanitized and the next execution still runs", async (t) => {
  let calls = 0;
  const { scheduler, tick, executions, errors } = setup(t, {
    runOnStartup: true,
    execute: () => { if (++calls === 1) throw new Error("TOP_SECRET"); },
  });
  scheduler.start();
  await tick(0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Execution failed.*Scheduling continues/);
  assert.doesNotMatch(errors[0], /TOP_SECRET/);
  await tick(60_000);
  assert.equal(executions.length, 2);
});

test("cron changes cancel the old timer; runOnStartup changes do not execute immediately", async (t) => {
  const { scheduler, tick, executions, update, logs } = setup(t);
  scheduler.start();
  await tick(30_000);
  update({ scheduleCron: "*/5 * * * *", runOnStartup: true });
  await tick(30_000);
  assert.equal(executions.length, 0);
  await tick(240_000);
  assert.equal(executions.length, 1);
  update({ runOnStartup: false });
  update({ runOnStartup: true });
  await tick(0);
  assert.equal(executions.length, 1);
  assert.equal(logs.filter((message) => message.includes("Schedule updated")).length, 1);
});

test("schedule changes preserve an active execution and its configuration snapshot", async (t) => {
  const gate = Promise.withResolvers();
  const { scheduler, tick, executions, update } = setup(t, {
    runOnStartup: true, execute: () => gate.promise,
  });
  t.after(() => gate.resolve());
  scheduler.start();
  await tick(0);
  update({ scheduleCron: "*/5 * * * *" });
  await tick(300_000);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].scheduleCron, "* * * * *");
  gate.resolve();
  await tick(0);
  await tick(300_000);
  assert.equal(executions.length, 2);
  assert.equal(executions[1].scheduleCron, "*/5 * * * *");
});

test("shutdown cancels timers, unsubscribes, and waits for active execution", async (t) => {
  const gate = Promise.withResolvers();
  const { scheduler, tick, executions, subscribers, update } = setup(t, {
    runOnStartup: true, execute: () => gate.promise,
  });
  t.after(() => gate.resolve());
  scheduler.start();
  await tick(0);
  let finished = false;
  const stopping = scheduler.stop().then(() => { finished = true; });
  await tick(300_000);
  assert.equal(finished, false);
  assert.equal(subscribers.size, 0);
  assert.equal(executions.length, 1);
  gate.resolve();
  await stopping;
  update({ scheduleCron: "*/2 * * * *" });
  scheduler.start();
  await tick(300_000);
  assert.equal(executions.length, 1);
  await scheduler.stop();
});

test("long delays are split safely without executing early", async (t) => {
  const { scheduler, tick, executions } = setup(t, { scheduleCron: "0 0 1 1 *" });
  scheduler.start();
  await tick(2 ** 31 - 1);
  assert.equal(executions.length, 0);
  const remaining = Date.parse("2027-01-01T00:00:00Z") - Date.now();
  await tick(remaining);
  assert.equal(executions.length, 1);
});

test("cron uses the container local timezone including DST", async (t) => {
  const { scheduler, tick, logs } = setup(t, {
    scheduleCron: "0 9 * * *", timezone: "Europe/Amsterdam",
  });
  scheduler.start();
  assert.ok(logs.includes("[SCHEDULER] Next execution: 2026-10-23T07:00:00.000Z"));
  await tick(Date.parse("2026-10-25T08:00:00Z") - Date.now());
  assert.ok(logs.includes("[SCHEDULER] Next execution: 2026-10-26T08:00:00.000Z"));
});
