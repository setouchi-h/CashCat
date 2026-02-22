import { runLoop } from "./loop.js";

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

runLoop(controller.signal).catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
