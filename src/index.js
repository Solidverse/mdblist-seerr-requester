// MDBList Seerr Requester
// Application entry point
import { createConfigWatcher } from "./config/watcher.js";

let configWatcher;
try {
  configWatcher = await createConfigWatcher();
  console.log("Configuration loaded successfully.");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

console.log("MDBList Seerr Requester");
console.log(`Node.js: ${process.version}`);
console.log(`Environment: ${process.env.NODE_ENV}`);

// Keep the application running
const timer = setInterval(() => {}, 60_000);

// Graceful shutdown
function shutdown() {
  console.log("Application shutting down...");
  configWatcher.close();
  clearInterval(timer);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("Application started successfully.");
