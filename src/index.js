// MDBList Seerr Requester
// Application entry point

console.log("MDBList Seerr Requester");
console.log(`Node.js: ${process.version}`);
console.log(`Environment: ${process.env.NODE_ENV}`);
console.log(`Config: ${process.env.CONFIG_PATH}`);

console.log("Application started successfully.");

// Keep the application running
const timer = setInterval(() => {}, 60_000);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Application shutting down...");
  clearInterval(timer);
});
