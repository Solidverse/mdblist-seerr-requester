// MDBList Seerr Requester
// Application entry point
import { createConfigWatcher } from "./config/watcher.js";
import { createScheduler } from "./scheduler.js";
import { createHistory } from "./db/database.js";

import { runRequestEngine } from "./engines/request.js";

let configWatcher;
let scheduler;
let history;
try {
  configWatcher = await createConfigWatcher();
  console.log("Configuration loaded successfully.");
  history = createHistory();
  console.log("[HISTORY] Database initialized successfully.");
  scheduler = createScheduler(configWatcher, {
    execute: (snapshot) => runRequestEngine(snapshot, { history }),
  });
} catch (error) {
  history?.close();
  configWatcher?.close();
  console.error(error.message);
  process.exit(1);
}

console.log("MDBList Seerr Requester");
console.log(`Node.js: ${process.version}`);
console.log(`Environment: ${process.env.NODE_ENV}`);

// Graceful shutdown
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Application shutting down...");
  const finished = scheduler.stop();
  configWatcher.close();
  await finished;
  history.close();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

scheduler.start();
console.log("Application started successfully.");
