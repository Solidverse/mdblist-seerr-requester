// MDBList Seerr Requester
// Application entry point
import { loadConfig } from "./config/loader.js";

try {
  await loadConfig();
  console.log("Configuration loaded successfully.");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

console.log("MDBList Seerr Requester");
console.log(`Node.js: ${process.version}`);
console.log(`Environment: ${process.env.NODE_ENV}`);

console.log("Application started successfully.");

// Keep the application running
const timer = setInterval(() => {}, 60_000);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Application shutting down...");
  clearInterval(timer);
});
