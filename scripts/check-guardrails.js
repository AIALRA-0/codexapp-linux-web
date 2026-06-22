#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const webServer = fs.readFileSync(path.join(root, "web-server.js"), "utf8");
const failures = [];

function reject(pattern, message) {
  if (pattern.test(webServer)) failures.push(message);
}

function requirePattern(pattern, message) {
  if (!pattern.test(webServer)) failures.push(message);
}

reject(/truncated earlier large thread item/, "user-visible large-thread truncation marker must not exist");
reject(/url\.pathname === "\/codexapp-thread-fast"/, "legacy /codexapp-thread-fast route must not be exposed");
reject(/url\.pathname === "\/codexapp-thread-turns"/, "legacy /codexapp-thread-turns route must not be exposed");
reject(/url\.pathname === "\/codexapp-thread-status"/, "legacy /codexapp-thread-status route must not be exposed");
reject(/function makeLargeThreadUserItem[\s\S]*?if \(!text\.trim\(\)\) return null;[\s\S]*?function makeLargeThreadAgentItem/, "user messages must not be dropped solely because text is empty");

requirePattern(/if \(!window\.__codexappSingleSurface\) scheduleCodexappFastThreadShell\(\);/, "single surface must disable legacy fast shell");
requirePattern(/if \(!window\.__codexappSingleSurface\) \{\s*installSubmitDeduper\(\);\s*installUiShim\(\);\s*\}/, "single surface must disable legacy submit/UI DOM shims");
requirePattern(/const singleSurfaceEnabled = parseBoolean\(process\.env\.CODEXAPP_SINGLE_SURFACE, true\);/, "single surface must default on");
requirePattern(/apiWindowMatch = url\.pathname\.match\(\^?\/?\^\\\/api\\\/threads\\\/\(\[\^\/\]\+\)\\\/window/, "canonical thread window API route is missing");
requirePattern(/apiSubmitMatch = url\.pathname\.match\(\^?\/?\^\\\/api\\\/threads\\\/\(\[\^\/\]\+\)\\\/submit/, "canonical submit API route is missing");

if (failures.length > 0) {
  console.error("CodexApp guardrail failures:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("CodexApp guardrails passed");
