import assert from "node:assert/strict";
import test from "node:test";
import { assertMatchingVersions, checkRelease } from "../scripts/check-release.mjs";

test("a coordinated release refuses missing, mismatched, and incorrectly tagged components", () => {
  const versions = { package: "1.2.3-local.4", desktop: "1.2.3-local.4", plugin: "1.2.3-local.4" };
  assert.equal(assertMatchingVersions(versions, "v1.2.3-local.4"), "1.2.3-local.4");
  assert.throws(() => assertMatchingVersions({ ...versions, plugin: "1.2.3-local.3" }), /plugin.*does not match/);
  assert.throws(() => assertMatchingVersions({ ...versions, desktop: undefined }), /desktop.*missing/);
  assert.throws(() => assertMatchingVersions(versions, "v1.2.2"), /Release tag must be/);
  assert.throws(() => assertMatchingVersions({ package: "latest" }), /release version/);
});

test("release validation reads every shipped component's current version", async () => {
  assert.match(await checkRelease(), /^\d+\.\d+\.\d+/);
});
