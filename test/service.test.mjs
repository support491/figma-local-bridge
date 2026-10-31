import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderServicePlist, serviceConfiguration } from "../scripts/service.mjs";

test("background service isolates its local-only endpoint and disabled API settings", () => {
  const config = serviceConfiguration({ home: "/Users/example", repository: "/Users/example/Developer/bridge", node: "/opt/homebrew/bin/node", preferences: "/Users/example/Developer/bridge-state" });
  assert.deepEqual(config.command, ["/opt/homebrew/bin/node", "/Users/example/Developer/bridge/dist/server.mjs", "--http-owner"]);
  assert.equal(config.environment.FIGMA_BRIDGE_HOST, "127.0.0.1");
  assert.equal(config.environment.FIGMA_BRIDGE_API_DISABLED, "1");
  assert.equal(config.environment.FIGMA_API_BASE_URL, "http://127.0.0.1:9");
  assert.equal(config.environment.FIGMA_CREDENTIAL_BACKEND, "memory");
  assert.equal(config.environment.FIGMA_ACCESS_TOKEN, "");
  assert.equal(config.environment.FIGMA_PREFERENCES_DIR, "/Users/example/Developer/bridge-state");
  assert.throws(() => serviceConfiguration({ repository: "relative/path" }), /absolute/);
});

test("launch agent preserves paths containing XML metacharacters", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "figma-service-plist-"));
  try {
    const config = serviceConfiguration({ home: "/Users/A & B", repository: "/Users/A & B/Developer/<bridge>", node: "/opt/bin/node", preferences: "/Users/A & B/preferences" });
    const file = join(directory, "service.plist");
    await writeFile(file, renderServicePlist(config));
    const parsed = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
    assert.deepEqual(parsed.ProgramArguments, config.command);
    assert.deepEqual(parsed.EnvironmentVariables, config.environment);
    assert.equal(parsed.WorkingDirectory, "/Users/A & B/Developer/<bridge>");
    assert.equal(parsed.KeepAlive, true);
    assert.equal(parsed.RunAtLoad, true);
    assert.equal(parsed.Umask, 63);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
