import { z } from "zod";

const id = z.string().trim().min(1).max(200);
const short = z.string().trim().max(500);
const roleNames = ["headline", "body", "cta", "image", "logo", "disclaimer"];
const roles = z.object(Object.fromEntries(roleNames.map((name) => [name, id.optional()]))).strict();
const format = z.object({
  name: z.string().trim().min(1).max(80),
  width: z.number().int().min(240).max(4096),
  height: z.number().int().min(240).max(4096),
}).strict();
export const brandKitSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().trim().min(1).max(100),
  version: z.string().trim().min(1).max(40),
  colors: z.array(z.object({ name: short, hex: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict()).max(40).default([]),
  fonts: z.array(z.object({ family: z.string().trim().min(1).max(100), style: z.string().trim().min(1).max(100) }).strict()).max(20).default([]),
  voice: z.string().max(4000).default(""),
  rules: z.array(z.string().trim().min(1).max(500)).max(40).default([]),
  references: z.array(z.string().max(1000)).max(20).default([]),
  templates: z.array(z.object({ name: short, nodeId: id, roles: roles.default({}) }).strict()).max(20).default([]),
}).strict();

export const campaignInstructions = [
  "Campaign Studio: use figma_brand_kit_list/get to discover approved packs before starting. During a campaign its returned campaign.brandKit snapshot is authoritative; do not silently switch to a later saved kit version. Imported template/node references must be verified in this file before use.",
  "Use figma_campaign_start only for an explicit campaign brief and verified source artboards. It prepares three editable draft directions, not finished AI designs. Read the returned draft IDs and design distinct product, promotional and editorial compositions with the existing local canvas tools.",
  "Campaign scope is enforced by the plugin. Edit only returned draft roots/descendants. Never finish or resume a campaign merely to bypass an editing restriction.",
  "Automatic format adaptation needs one editable FRAME per concept and distinct direct-child role layers named Headline, Body, CTA, Image, Logo, or Disclaimer as applicable. Establish this structure in drafts before review/approval; figma_rename_node can name verified layers. For existing nonstandard names pass verified role IDs to adaptation. Nested mappings require a restored draft and new approval before restructuring.",
  "For each concept call figma_campaign_review. Inspect EVERY returned rendered image and its measurable checks. Distinguish subjective visual critique from measured errors and unknown checks. Refine at most twice per review request; if unresolved, report remaining issues instead of looping.",
  "After actually inspecting the images, call figma_campaign_record_review with that exact revision, concise notes and unresolved issues. Any subsequent edit invalidates the review. A text-only export path is not visual evidence.",
  "Present all three creative directions and wait for the user to choose. Only call figma_campaign_approve after explicit approval of that exact reviewed concept. Do not invent approval or promise campaign performance from a design score.",
  "Use figma_campaign_adapt to make editable format variants with verified semantic role IDs. Review and obtain approval for variants before figma_campaign_export. Preserve originals, approved versions and checkpoints.",
  "Optional image generation: check figma_image_provider_status first. A separately configured provider may charge for a request. Call figma_generate_campaign_image only after the user authorizes the specific image request; reuse requestId after interruption. Do not request a key in chat, auto-retry an uncertain paid request, or place generated imagery outside campaign drafts.",
].join("\n");

export function registerCampaignTools(server, { sendCommand, output, failure, imageOutput, writePngExport }) {
  // The explicit internal flag survives bundler renaming. The bridge consumes it
  // before registration and adds pinned targeting, leases, and operation recovery.
  function command(name, title, description, inputSchema, nativeCommand) {
    server.registerTool(name, { title, description, inputSchema, localCanvas: true }, async (input) => {
      try { return output(await sendCommand(nativeCommand, input, 120_000)); }
      catch (error) { return failure(error); }
    });
  }
  command("figma_brand_kit_save", "Save an approved brand kit", "Save/import an explicitly approved versioned brand kit in this Figma document. No automatic learning. Packs can be exported from the panel and imported by colleagues; node IDs must be relinked/verified per file. Never store secrets.", { kit: brandKitSchema }, "brandKitSave");
  command("figma_brand_kit_list", "List brand kits", "List the brand kits saved in the connected document.", {}, "brandKitList");
  command("figma_brand_kit_get", "Read a brand kit", "Read the exact approved brand kit, including typography, palette, voice, reference designs and template role mappings.", { id }, "brandKitGet");
  command("figma_campaign_start", "Prepare three campaign concepts", "Prepare protected working copies for three distinct creative directions from explicitly chosen page-root artboards. This creates starting drafts; Claude must design each direction using native tools, then visually review it. Originals remain protected while the campaign is active.", {
    name: z.string().trim().min(1).max(120), pageId: id, nodeIds: z.array(id).min(1).max(4), brandKitId: id.optional(),
    brief: z.object({ objective: z.string().trim().min(1).max(2000), audience: short, offer: short, callToAction: short, formats: z.array(format).max(8).default([]) }).strict(),
  }, "campaignStart");
  command("figma_campaign_status", "Read campaign progress", "Read persistent campaign concepts, review state, approvals, format variants and checkpoints. Inspect this after interruptions; never blindly start duplicate work.", { campaignId: id.optional() }, "campaignStatus");
  server.registerTool("figma_campaign_review", {
    localCanvas: true,
    title: "Visually review a campaign concept",
    description: "Run bounded measurable checks and return every concept artboard as an inline image for Claude to inspect. Screenshot failures or changed drafts prevent evidence registration. Inspect all images before recording subjective review. Unknown/partial checks must be reported; they are not a pass.",
    inputSchema: { campaignId: id, conceptId: id },
  }, async (input) => {
    try {
      const review = await sendCommand("campaignReview", input, 120_000);
      if (!Array.isArray(review.nodeIds) || !review.nodeIds.length || review.nodeIds.length > 4 || typeof review.revision !== "string") throw new Error("Campaign review returned invalid draft references; no review was recorded.");
      const images = [];
      for (const nodeId of review.nodeIds) {
        const screenshot = await sendCommand("screenshot", { target: "node", nodeId, maxDimension: 1600, scale: 1 }, 120_000);
        if (!screenshot.imageBase64 || screenshot.mimeType !== "image/png") throw new Error("A campaign preview could not be rendered. Review was not recorded; inspect the draft before retrying.");
        images.push(...imageOutput({ ...screenshot, nodeId }).content);
      }
      await sendCommand("campaignReviewEvidence", { ...input, revision: review.revision }, 120_000);
      return { content: [...output({ ...review, nextStep: "Inspect every image, compare against the brief/brand kit, and record subjective notes and unresolved issues with this exact revision. Refine at most twice, re-review after edits, and ask the user to choose/approve." }).content, ...images] };
    } catch (error) { return failure(error); }
  });
  command("figma_campaign_record_review", "Record a visual campaign review", "Only after inspecting every image from figma_campaign_review, record subjective notes and unresolved visual issues against its exact revision. This does not approve the design; changed or unrendered drafts are rejected.", {
    campaignId: id, conceptId: id, revision: id, reviewed: z.literal(true), notes: z.string().trim().min(1).max(4000), issues: z.array(z.string().trim().min(1).max(500)).max(40).default([]),
  }, "campaignRecordReview");
  command("figma_campaign_approve", "Approve a reviewed concept", "Only after the user explicitly approves this exact concept/revision. Measurable checks and visual review must be current. Approved artwork becomes protected; create a restored draft to edit it further.", { campaignId: id, conceptId: id, revision: id, userConfirmed: z.literal(true) }, "campaignApprove");
  command("figma_campaign_checkpoint", "Save a campaign checkpoint", "Preserve the chosen concept as a named checkpoint before a requested revision. Checkpoints retain native editable artwork and are protected from ordinary bridge mutations.", { campaignId: id, conceptId: id, label: z.string().trim().min(1).max(100) }, "campaignCheckpoint");
  command("figma_campaign_restore", "Restore a checkpoint as a new draft", "With explicit user confirmation, restore a saved checkpoint into a new editable draft. Preserve all existing versions. The restored draft needs a fresh review and approval.", { campaignId: id, checkpointId: id, userConfirmed: z.literal(true) }, "campaignRestore");
  command("figma_campaign_adapt", "Adapt a concept to campaign formats", "Create editable format variants from the chosen concept using verified semantic roles and bounded layout rules. Review all outputs; reflow is not guaranteed for arbitrary nested templates. Supply verified role node IDs and optional image focal point (0–1). Each output requires review and approval.", {
    campaignId: id, conceptId: id, formats: z.array(format).min(1).max(8), roles: roles.optional(),
    focalPoint: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().optional(),
  }, "campaignAdapt");
  command("figma_campaign_finish", "Finish a campaign editing session", "Only when the user explicitly finishes this campaign: release its draft-only editing restriction while preserving artwork, approvals and history. Never call this to bypass a failed scoped edit.", { campaignId: id, userConfirmed: z.literal(true) }, "campaignFinish");
  command("figma_campaign_resume", "Resume a saved campaign", "With explicit user confirmation, restore the campaign's draft-only editing boundary. Recheck file/page and status first; reviews remain subject to freshness checks.", { campaignId: id, userConfirmed: z.literal(true) }, "campaignResume");
  server.registerTool("figma_campaign_export", {
    localCanvas: true,
    title: "Export an approved campaign",
    description: "Export the selected approved concepts/format variants as local PNGs. Requires current approval for every selected item. Returns an explicit manifest of paths/dimensions. Stops on changed approval or export failure and reports partial output without claiming a complete kit.",
    inputSchema: { campaignId: id, conceptIds: z.array(id).min(1).max(12), scale: z.number().min(0.1).max(4).default(1) },
  }, async (input) => {
    const exports = [];
    try {
      const plan = await sendCommand("campaignExportPlan", input, 120_000);
      if (!Array.isArray(plan.nodeIds) || !plan.nodeIds.length || plan.nodeIds.length > 48) throw new Error("Campaign returned an invalid export plan.");
      for (const nodeId of plan.nodeIds) {
        exports.push(await writePngExport(await sendCommand("exportFramePng", { nodeId, maxDimension: 8192, scale: input.scale }, 120_000)));
      }
      // A person may change the canvas during an asynchronous image export.
      const fresh = await sendCommand("campaignExportPlan", input, 120_000);
      if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error("The approved campaign changed during export. Treat these files as unverified and export again after review.");
      return output({ campaignId: input.campaignId, complete: true, exports, note: "These PNGs are local files. Editable source artwork and approval history remain in the Figma document." });
    } catch (error) {
      return { ...failure(error), content: [...failure(error).content, ...output({ campaignId: input.campaignId, complete: false, partialExports: exports }).content] };
    }
  });
}
