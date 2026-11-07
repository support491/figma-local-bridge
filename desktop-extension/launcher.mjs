// Enforce the staff package's local-only policy before the bridge reads its environment.
// These values are process-local; no installed service or Claude settings are rewritten.
Object.assign(process.env, {
  FIGMA_BRIDGE_API_DISABLED: "1",
  FIGMA_ACCESS_TOKEN: "",
  FIGMA_FILE_KEY: "",
  FIGMA_API_BASE_URL: "http://127.0.0.1:9",
  FIGMA_CREDENTIAL_BACKEND: "memory",
});

// Image generation is separate from Figma API access and opt-in per extension.
// Do not inherit an enabled provider from an unrelated shell configuration.
process.env.FIGMA_IMAGE_PROVIDER = process.env.FIGMA_IMAGE_ENABLED === "true" ? "openai" : "";
if (!process.env.FIGMA_IMAGE_PROVIDER) process.env.FIGMA_IMAGE_API_KEY = "";

// Normal stdio mode starts an owner when needed or reuses an existing owner.
// Do not pass --proxy-only: a first-time Claude user has no separate service.
await import("./bridge.mjs");
