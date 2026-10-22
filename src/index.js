// MDBList Seerr Requester
// Application entry point
import { createConfigWatcher } from "./config/watcher.js";
import { createScheduler } from "./scheduler.js";

let configWatcher;
let scheduler;
try {
  configWatcher = await createConfigWatcher();
  console.log("Configuration loaded successfully.");
  scheduler = createScheduler(configWatcher);
} catch (error) {
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
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

scheduler.start();
console.log("Application started successfully.");
