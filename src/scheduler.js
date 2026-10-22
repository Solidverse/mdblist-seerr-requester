import { CronExpressionParser } from "cron-parser";

// execute receives a snapshot of the validated configuration for this run.
export function createScheduler(configWatcher, { execute = async () => {}, logger = console } = {}) {
  let started = false;
  let stopped = false;
  let timer;
  let unsubscribe;
  let cron;
  let activeExecution;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function run() {
    if (stopped) return;
    if (activeExecution) {
      logger.log("[SCHEDULER] Execution skipped: previous execution still running.");
      return;
    }
    const config = configWatcher.getConfig();
    activeExecution = Promise.resolve().then(async () => {
      logger.log("[SCHEDULER] Execution started.");
      try {
        await execute(config);
        logger.log("[SCHEDULER] Execution completed.");
      } catch {
        // Execution errors may contain credentials or request details.
        logger.error("[SCHEDULER] Execution failed.");
      }
    }).finally(() => { activeExecution = undefined; });
  }

  function scheduleNext() {
    const next = CronExpressionParser.parse(cron, {
      currentDate: new Date(), tz: timezone,
    }).next().toDate();
    logger.log(`[SCHEDULER] Next execution: ${next.toISOString()}`);

    function armTimer() {
      // Node clamps delays larger than a signed 32-bit integer to 1 ms.
      const remaining = next.getTime() - Date.now();
      timer = setTimeout(() => {
        if (stopped) return;
        if (Date.now() < next.getTime()) {
          armTimer();
          return;
        }
        scheduleNext();
        run();
      }, Math.min(Math.max(remaining, 0), 2 ** 31 - 1));
    }
    armTimer();
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      cron = configWatcher.getConfig().scheduleCron;
      unsubscribe = configWatcher.subscribe(() => {
        const nextCron = configWatcher.getConfig().scheduleCron;
        if (stopped || nextCron === cron) return;
        clearTimeout(timer);
        cron = nextCron;
        logger.log("[SCHEDULER] Schedule updated.");
        scheduleNext();
      });
      logger.log("[SCHEDULER] Started.");
      scheduleNext();
      if (configWatcher.getConfig().runOnStartup) run();
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        clearTimeout(timer);
        unsubscribe?.();
        logger.log("[SCHEDULER] Stopped.");
      }
      await activeExecution;
    },
  };
}
