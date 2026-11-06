// Enforce the staff package's local-only policy before the bridge reads its environment.
// These values are process-local; no installed service or Claude settings are rewritten.
Object.assign(process.env, {
  FIGMA_BRIDGE_API_DISABLED: "1",
  FIGMA_ACCESS_TOKEN: "",
  FIGMA_FILE_KEY: "",
  FIGMA_API_BASE_URL: "http://127.0.0.1:9",
  FIGMA_CREDENTIAL_BACKEND: "memory",
});

// Normal stdio mode starts an owner when needed or reuses an existing owner.
// Do not pass --proxy-only: a first-time Claude user has no separate service.
await import("./bridge.mjs");
