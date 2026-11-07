import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { brandKitSchema, registerCampaignTools } from "../campaign-tools.mjs";

function harness(sendCommand) {
  const tools = new Map();
  const output = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
  registerCampaignTools({ registerTool(name, config, callback) { tools.set(name, { config, callback }); } }, {
    sendCommand, output, failure: (error) => ({ isError: true, ...output({ error: error.message }) }),
    imageOutput: ({ imageBase64, mimeType, ...data }) => ({ content: [...output(data).content, { type: "image", data: imageBase64, mimeType }] }),
    writePngExport: async (data) => ({ path: `/exports/${data.nodeId}.png`, width: 1080, height: 1080 }),
  });
  return { tools, call(name, input) { const tool = tools.get(name); return tool.callback(z.object(tool.config.inputSchema).parse(input)); } };
}
const input = { campaignId: "campaign-1", conceptId: "concept-1" };

test("campaign review returns each rendered artboard and registers evidence only after all images", async () => {
  const calls = [];
  const h = harness(async (command, data) => {
    calls.push([command, data]);
    if (command === "campaignReview") return { revision: "rev-1", nodeIds: ["1:2", "1:3"], checks: { complete: true } };
    if (command === "screenshot") return { imageBase64: "png", mimeType: "image/png" };
    if (command === "campaignReviewEvidence") return { recorded: true };
    throw new Error(command);
  });
  const result = await h.call("figma_campaign_review", input);
  assert.equal(result.isError, undefined);
  assert.equal(result.content.filter((block) => block.type === "image").length, 2);
  assert.deepEqual(calls.map(([command]) => command), ["campaignReview", "screenshot", "screenshot", "campaignReviewEvidence"]);
  assert.equal(calls[3][1].revision, "rev-1");
});

test("partial screenshots cannot mark a visual review complete", async () => {
  let evidence = false;
  const h = harness(async (command, data) => {
    if (command === "campaignReview") return { revision: "rev-1", nodeIds: ["1:2", "1:3"] };
    if (command === "screenshot") {
      if (data.nodeId === "1:3") throw new Error("Image failed");
      return { imageBase64: "png", mimeType: "image/png" };
    }
    evidence = true;
  });
  const result = await h.call("figma_campaign_review", input);
  assert.equal(result.isError, true);
  assert.equal(evidence, false);
});

test("manual changes during render reject evidence instead of returning a completed review", async () => {
  const h = harness(async (command) => {
    if (command === "campaignReview") return { revision: "rev-1", nodeIds: ["1:2"] };
    if (command === "screenshot") return { imageBase64: "png", mimeType: "image/png" };
    throw new Error("Draft changed during render");
  });
  const result = await h.call("figma_campaign_review", input);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /changed/);
});

test("export rechecks approval freshness and reports partial files on a changed draft", async () => {
  let plans = 0;
  const h = harness(async (command, data) => {
    if (command === "campaignExportPlan") return { nodeIds: ["1:2"], variants: [{ id: "concept-1", revision: `rev-${++plans}` }] };
    return { nodeId: data.nodeId };
  });
  const result = await h.call("figma_campaign_export", { campaignId: "campaign-1", conceptIds: ["concept-1"] });
  assert.equal(result.isError, true);
  const details = JSON.parse(result.content[1].text);
  assert.equal(details.complete, false);
  assert.equal(details.partialExports.length, 1);
});

test("export refuses unapproved plans without writing any files", async () => {
  const calls = [];
  const h = harness(async (command) => { calls.push(command); throw new Error("Approve first"); });
  const result = await h.call("figma_campaign_export", { campaignId: "campaign-1", conceptIds: ["concept-1"] });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, ["campaignExportPlan"]);
  assert.deepEqual(JSON.parse(result.content[1].text).partialExports, []);
});

test("brand packs reject secret fields, malformed colours and unsupported role maps", () => {
  const kit = { id: "brand", name: "Brand", version: "1" };
  assert.equal(brandKitSchema.parse(kit).schemaVersion, 1);
  assert.equal(brandKitSchema.safeParse({ ...kit, apiKey: "never-store-this" }).success, false);
  assert.equal(brandKitSchema.safeParse({ ...kit, colors: [{ name: "Blue", hex: "url(x)" }] }).success, false);
  assert.equal(brandKitSchema.safeParse({ ...kit, templates: [{ name: "Post", nodeId: "1:2", roles: { anything: "1:3" } }] }).success, false);
});

test("campaign approvals, restoration and scope release require explicit confirmation", () => {
  const h = harness(async () => ({}));
  for (const name of ["figma_campaign_approve", "figma_campaign_restore", "figma_campaign_finish", "figma_campaign_resume"]) {
    const schema = z.object(h.tools.get(name).config.inputSchema);
    assert.equal(schema.safeParse({ ...input, revision: "r", checkpointId: "c" }).success, false, name);
    assert.equal(schema.safeParse({ ...input, revision: "r", checkpointId: "c", userConfirmed: true }).success, true, name);
  }
  for (const { config } of h.tools.values()) assert.equal(config.localCanvas, true, "canvas tools must explicitly request the pinned target/lease wrapper through bundling");
});
