---
name: figma-local-workflow
description: Use the local figma_local MCP bridge to inspect, analyse, edit, copy-sync, re-layout, compose, archive, style, use design-system components and confirmed user preferences, read or write review comments, add approved images to, or export the Figma Design file currently open in Figma Desktop. Trigger for requests to review artboards, spreads or comments, sync copy with an external source, read or revise copy, inspect or replace layouts, use linked components/styles/tokens, audit text overflow, export frame PNGs, or make controlled canvas changes through the Local MCP Bridge plugin.
---

# Local Figma workflow

Use an inspect-first sequence. Do not begin by querying arbitrary page nodes or editing the current selection.

## Required sequence

1. Call `figma_bridge_status`, then `figma_list_connections`. Confirm the intended connection and page. Pass its runtime ID, stable `file:<key>` or unique exact `name:<saved label>` as `targetId` to every canvas call; never infer the target from the focused Desktop tab. A configured proxy default can pin a known file, but explicit targets remain preferable when working across files. Re-list after a plugin restart or unavailable-target error; never fall back silently to another file.
2. Call `figma_get_user_preferences` before choosing components, styles, tokens, typography, layout conventions, or copy patterns. Treat only returned confirmed preferences as durable user guidance.
3. This local installation disables Figma REST/comment access. Use user-provided review feedback and continue token-free canvas work. Do not enable API access or ask for a personal access token. In deployments where optional comment access was separately authorized and enabled, list relevant comments before editing.
4. Call `figma_list_design_system_assets`, then `figma_list_artboards`. Discover verified component/style/token candidates and stable artboard IDs; never guess IDs or recreate an appropriate available component. If the relevant artboard is absent, call `figma_list_pages`, navigate with `figma_navigate_to_page`, then repeat discovery. When new work needs a page that does not exist yet, create it with `figma_create_page` (idempotent by exact name, switches to it).
5. Identify the relevant artboard or page pair:
   - Call `figma_read_frame_content` with `detail: summary` for one artboard.
   - Call `figma_read_spread_content` with `detail: summary` for a spread, passing `nodeIds` in the order returned by `figma_list_artboards`.
   - Request `detail: full` only when hierarchy or hidden variants are needed.
6. For routine copy-only work, use the structured read and `figma_audit_text_overflow`; do not export or screenshot by default. Export or screenshot only when layout, imagery, geometry or uncertain wrapping needs visual judgement.
7. Analyse copy and layout before proposing or making changes. Call `figma_audit_text_overflow` when text fit, truncation, clipping, or typography may matter.
8. Only then edit identified nodes. Prefer the narrowest appropriate mutation tool and preserve unrelated content.
9. Verify after editing:
   - Re-read affected frame or spread content.
   - Re-run the overflow audit when text or dimensions changed.
   - Capture a screenshot only for uncertain wraps, adjacency or visual hierarchy; export a PNG only for a full-page/layout review, imagery or retained comparison.

## Fast review path

Routine reads skip expensive layout diagnostics and native-paint scans. Request those explicitly only when needed; narrow large reads and audits to relevant frames. Keep an operation attached to the same target throughout read, edit, and verification. The server pins composite operations and serializes work per target; separate plugin instances can progress independently.

For an interrupted operation, check `figma_operation_status` using its recovery ID before retrying. A lost reply does not establish that an edit failed. Reuse an ID only for the identical target and inputs. Operation history survives assistant-client restarts while the persistent owner lives; after an owner restart or unknown outcome, inspect the document before deciding what remains.

After artboard discovery, use `figma_prepare_review` only for a visual page/spread review. It reads the copy and optionally audits overflow in one plugin operation, then writes the PNG exports locally without leaving document edits. For copy reconciliation, prefer `figma_read_copy` and overflow auditing so routine work does not consume image tokens.

### Bounded overflow audits

Treat `complete: false` as incomplete evidence even when `warningCount` is zero. Retain each batch’s findings and continue `nextCursor` with the same explicit target, root `nodeId`, and `includeHidden` until complete. `totals` and top-level counts are cumulative; `text` and `batch` describe only the returned batch. Do not repeat copy edits or compositions to continue an audit. Cursors are single-use, expire after five minutes/plugin restart, and are not a frozen document snapshot: start fresh after edits or context changes. Stop by not requesting another batch. Packaged operations with incomplete audits keep `verificationComplete` false and preserve predecessors.

## Review comments

Comments use Figma's REST API rather than the live plugin connection. Canvas tools remain token-free; `figma_comment_status` reports whether the optional token and file key are configured without revealing the token.

- The user's local setup keeps this feature disabled. Do not change the loopback API endpoint or configure credentials. In other deployments where comment access was explicitly authorized, credentials belong in the plugin's secure setup flow, never in chat or tool calls.

- List comments before editing when the user refers to review feedback. Preserve returned comment IDs, parent IDs, author, resolved state, node/canvas position and timestamps as source data.
- Post a root comment only at a verified frame ID or explicit canvas coordinates. Reply using the identified root comment ID; do not invent a thread relationship.
- The API does not offer edit or resolve operations through this bridge. Never claim a comment was edited or resolved. Post a correction/reply or ask the user to resolve it in Figma.
- Delete only a comment the user explicitly identifies, and pass the deletion confirmation guard. Deletion is permanent.
- Re-list comments after a write when verification matters. Treat a successful REST response as comment verification; it does not prove a canvas edit.

## Layout responsibility and evidence cost

Use the bridge for deterministic mechanics: frame geometry, hierarchy, components, named styles, text bounds, overflow, alignment and mutations. Use this skill for editorial hierarchy, page purpose, content density, print-reading judgement and deciding when an image review is worth its cost.

Use Figma sections to organise a working board, exploration or reference area. Reserve frames for actual design surfaces, reusable layout containers, clipping regions or content that needs its own coordinate system; do not wrap a board in an otherwise empty frame just for organisation.

Reference boards and new canvas areas must use native Figma structure: create a `SECTION` with `figma_create_section`, then place native frames, components and editable text inside it. Never use an imported SVG group as a board, panel system, UI layout, or editable label. Reserve `figma_import_svg` for approved logos, icons and isolated vector artwork.

Do not ask image output to prove routine text updates. Treat text bounds, re-read copy and overflow results as sufficient unless a change may alter adjacent elements, column balance, image relationship or hierarchy. Prefer one targeted screenshot over a PNG export when a visual check is necessary.

## Design-system preferences and tie-breaks

Treat the bridge preference store as explicit per-user memory, not automatic learning.

- Query it with `figma_get_user_preferences`. The user may ask in natural language what is known, why a choice is preferred, or which scope it applies to; answer from the returned records.
- Prefer assets in this order: a confirmed scoped user choice; an appropriate linked-system component already used in the file; another verified component instance; a named style or bound variable; a verified source-node style; raw construction only when none applies.
- Use `figma_create_component_instance` for a verified component ID/key and `figma_apply_design_style` for a verified style ID/key. Preserve component linkage and variables instead of detaching or copying raw values.
- When two or more systems or assets remain equally plausible, call `figma_resolve_design_choice`. If it returns `needsClarification: true`, make no edit and ask the returned question with a concise candidate list. Never settle the tie from visual similarity, current selection, or library order.
- After the user answers a tie, use that choice for the current task. Offer to save it with an appropriate project, document-type, or context scope; do not save unless the user explicitly confirms.
- Create or update a record with `figma_set_user_preference` only from explicit user guidance. Read first and pass `expectedRevision`. Use the same revision guard for delete or revert operations.
- Do not convert a one-off canvas choice into an ongoing preference. Do not silently infer taste from existing documents, generated layouts, or repeated tool calls.
- A linked library must already be enabled by the user in the Figma file. If an expected library is unavailable, explain that boundary rather than approximating its assets.

## Delegated copy preparation

Use a capable, cost-efficient subagent for copy analysis or source-to-Figma diffing when it will reduce context cost, especially across several pages. Prepare and review the diff before mutations; the lead may capture read-only Figma snapshots first.

- The lead defines the authoritative direction, page scope, source-of-truth order, and any claims or internal notes that must remain unchanged.
- Give the subagent that task packet, the latest source copy, and a compact Figma copy snapshot with frame IDs and text-node IDs. Escalate ambiguous hierarchy, compliance claims, brand judgement or source conflicts to a stronger model or the lead.
- Ask it to return a narrow diff packet: frame ID, node ID, exact current text, replacement text and a one-line rationale. Omit unchanged nodes.
- Keep the subagent read-only. It must not call the local bridge, edit the Figma file, or perform visual verification.
- The lead reviews the proposed wording, owns the live bridge connection, makes all mutations serially, and verifies the result. Never apply a subagent's text blindly.

The bridge supports separate connected files. Mutations stay serial within each target; delegated preparation does not authorize concurrent writers to the same physical Figma file.

## External copy-sync recipe

Use this flow only after the user identifies which source is authoritative and the intended sync direction:

1. Confirm the bridge/page and list artboards. Identify the exact target frame IDs.
2. Call `figma_read_copy` with those frame IDs and `includeHidden: false`. Use its text IDs and copy as the Figma side of the diff; do not request full hierarchy unless the compact result is ambiguous.
3. Fetch the latest external source, then diff it against the visible Figma text IDs in the user-requested direction. Omit unchanged nodes and preserve source-specific metadata that the user did not ask to replace.
4. Re-fetch or stop on a source conflict. Never overwrite a newer external or Figma change blindly.
5. Preserve `expectedText` from the compact Figma read for every proposed Figma update. Keep hidden text excluded unless the source explicitly targets a hidden variant.
6. For a small, known-safe Figma batch, call `figma_apply_copy_updates`. For longer copy, several frames or a bridge that has been slow, use serial `figma_update_text` calls instead.
7. Audit and inspect after layout-affecting Figma edits. Use a re-read and overflow audit for routine copy-only edits; use a screenshot for uncertain wraps and a PNG export for layout, imagery, full-page review or retained comparison.
8. Re-read compact copy when an `expectedText` guard fails or verification is incomplete. Never overwrite a concurrent edit from stale source data.

### Timeout recovery

For a tracked composition, keep its operation ID and call `figma_operation_status` after interruption or caller timeout. If it is queued or running, wait; if it succeeded, use the returned result; if it failed, diagnose that error. Reuse the same operation ID to resume the request and never start a duplicate while its outcome remains available or unknown.

Recovery IDs are also included in composition error responses. If status reports no operation for that ID, inspect the affected document before starting again; a restarted bridge may have lost its in-memory history. An unknown outcome always requires inspection, not a new blind composition.

For an untracked mutation batch, do not retry immediately. Reconnect the plugin if needed, then re-read the affected visible text and determine which updates landed. Apply only the remaining changes with fresh `expectedText` guards. Do not create an alternate frame, hide the old one or issue a second blind batch to recover.

## Re-layout a page recipe

Use this deterministic flow when replacing an existing brochure page or artboard layout:

1. Confirm the bridge/page, list artboards, read the exact target with `detail: summary`, and export its current PNG before changing anything.
2. Use `figma_list_design_system_assets` and `figma_list_page_tokens` to discover verified components, variables, styles, colours, and fonts. Prefer an appropriate component instance or named style; use `figma_copy_style_from_node` when a known source node is the clearest brand reference. Never approximate a value already present in the file.
3. Define one clearly named replacement frame. Use `figma_start_composition` for a potentially slow board, then poll `figma_operation_status`; use `figma_compose_frame` directly only when a blocking call is appropriate. Keep keys unique and declare parent elements before their children.
4. Build ordered native frame/rectangle/text elements and use styled spans for mixed emphasis. For an approved image already in Figma, set `imageSourceNodeId` on its composed frame or rectangle instead of duplicating and reparenting nodes. Set `imageRequired: true` wherever an image is necessary to call the board complete.
5. Prefer supplying explicit previous sibling IDs in `archiveNodeIds`. The composer archives them only after text/export/image verification succeeds. If verification is incomplete, inspect `imageAudit`, preserve the previous layout, and fix the replacement before retrying or archiving separately.
6. Inspect the compact audits and local PNG returned by the composer. Use a full read only when the summary lacks necessary hierarchy.
7. Re-read the replacement in summary mode and confirm the archive name/replacement relationship. Do not delete the archived group unless the user later identifies it for permanent removal.

## Font swap recipe

1. Call `figma_font_inventory` per page, or per section on large pages. It counts text ranges by font and by what sets each font: library style, local style, main component, or the layer itself.
2. Library styles change only in the library file: update them there with `figma_set_text_style_fonts`, then the user publishes the library and accepts the update in each consuming file.
3. In each file, run `figma_retype_font` with `dryRun: true`, read the counts, then repeat with `dryRun: false`. Use `exceptCharacters` to keep wordmarks in their brand face. Text inside instances follows its main component and is skipped.
4. Re-run the inventory to confirm what remains.

## Reference-board recipe

1. Call `figma_inspect_canvas_layout` without a target to read native sections and the occupied top-level canvas envelope. Figma pages are unbounded; do not mistake that envelope for a page boundary.
2. Collision-check the proposed section rectangle. Create it with `figma_create_section` only when the result is clear, or when the user explicitly accepts an intentional overlap.
3. Compose with the new section ID as `frame.parentId`; use `figma_start_composition` plus status polling when the board may be slow. Build panels from native frames/components and labels from editable natural-case Figma text with `textCase` styling.
4. Treat a blank response, `COMPOSITION_EMPTY_OR_INCOMPLETE`, or any other composition failure as a hard stop. Inspect and retry the native path; never switch to an SVG layout workaround.
5. Call `figma_inspect_canvas_layout` with the created node ID to verify sibling collisions. Use a targeted screenshot when adjacency or visual overlap still requires judgement.

## Working rules

- Treat artboard IDs and text-node IDs returned by read tools as the source of truth.
- Read a whole frame or spread before changing individual text nodes; surrounding copy determines meaning and fit.
- Keep spread order explicit. Do not infer left/right order from node names.
- Treat `copy` as effectively visible text. Check `allCopy`, `hiddenTextCount`, and each text item's `effectiveVisible` value when hidden variants or conditional content matter.
- Before every text creation or replacement, distinguish stored content from visual casing. Author generated headings, labels, buttons and navigation copy in natural sentence/title case, then apply `textCase` during creation or call `figma_set_text_case` for an existing layer. Never send all-caps characters merely to make text look uppercase.
- Never put UI-label copy into SVG paths or SVG text. Keep it as native, editable Figma text in natural case and use `textCase` for presentation.
- Preserve exact all-caps characters only when they are semantically meaningful, supplied by an authoritative source, or explicitly requested as character-level copy. If an existing source is ambiguous, preserve it rather than guessing the natural capitalization.
- Treat emphasis, case, decoration, line height, letter spacing, font family/style, and size as typography—not copy. Prefer verified Figma text styles, `figma_copy_style_from_node`, or styled-span options over manually altering characters or splitting text into extra layers.
- Preserve design-system linkage. Prefer `figma_create_component_instance`, `figma_apply_design_style`, and bound variables over detached copies or hand-built imitations.
- Use `figma_update_text` only for an identified text node. If the intended change is presentation-only casing, do not call it; call `figma_set_text_case` and verify that the stored characters remain unchanged. Use structural tools only after inspecting hierarchy and bounds.
- Make small, reversible batches and verify each batch before continuing.
- For frame or layer renaming, use a dedicated rename tool when available. Otherwise, when native Figma UI control is available, select verified IDs with `figma_set_selection` and use the native rename UI (`Cmd+R` on macOS). Inspect the full multi-layer rename preview and verify every ID-to-name mapping; rename individually when the preview is ambiguous. Re-read `figma_list_artboards` after each batch. If neither path is available, report the missing capability.
- For copy-only work, overwrite the existing visible text layers. Do not create duplicate layouts, hide existing layers, or reduce old nodes to zero opacity. Use replacement/archival only for an explicitly requested layout change, and state the result clearly.
- Prefer `figma_archive_nodes` or `figma_supersede_layout` over opacity-zero superseded layers. Archive only explicit siblings and always record the replacement when one exists.
- Use `figma_start_composition` plus `figma_operation_status` for a potentially slow board. Use `figma_compose_frame` for a bounded composition that is expected to finish within the blocking call. Treat text, export, and required-image audits as completion evidence.
- Reuse an existing approved Figma image with a composed element's `imageSourceNodeId`. Mark visually necessary image areas with `imageRequired: true`; never call a board finished or archive its predecessor while `imageAudit.warningCount` is non-zero.
- Before placing a new section or top-level frame, inspect canvas bounds and collision-check the proposed rectangle. After placement, collision-check the actual node and visually inspect any uncertain adjacency; coordinate assumptions alone are not verification.
- Use `figma_place_local_image` only for an absolute local image path the user explicitly placed in scope or an HTTPS image URL the user explicitly approved. URL fetches are limited to public IP destinations, revalidated across at most five redirects, capped at 25 MB, and checked by image signature. Prefer `figma_copy_image_fill` when an approved image already exists in Figma.
- Place images at their intended final dimensions before applying custom crops. Resizing a CROP-filled node to a different aspect ratio switches it to centered FILL. Composition and image-copy tools also normalise an inherited CROP when source and target proportions differ, unless an explicit crop mode or transform was supplied. Review reported adjustments and the focal point afterwards; do not assume the old custom crop survives.
- A required image must be visible: hidden or transparent image paints, elements and ancestors fail the image audit and preserve the previous layout. Inspect warnings before calling a replacement complete.
- Delete only a clearly stray element that the user identified. Otherwise preserve it, including superseded or hidden elements.
- Use `figma_screenshot` for a targeted, one-off visual check. Use `figma_export_frame_png` only for a full-page/layout review, imagery, comparison or an artefact that needs to be retained; do not export routine copy-only changes.
- Keep calls serial within each logical edit workflow and pin every call to the chosen target. A transport reconnect replaces only that plugin runtime's old session. Other connected files remain attached. Coordinate multiple writers to the same document; never infer file identity from matching page or node IDs.
- If the `figma_local` tools are absent from the task, stop and report that Codex has not loaded the configured MCP server. Do not substitute the hosted Figma MCP without the user's permission.
