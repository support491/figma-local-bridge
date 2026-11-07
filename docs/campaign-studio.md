# Campaign Studio: a simple guide for your team

Campaign Studio helps you turn an existing Figma design into a campaign. You choose the brand, explain the brief, review three creative directions, and prepare the sizes you need.

**Use two apps:** Figma Desktop holds the designs. A regular Claude Desktop chat does the AI work. Clicking **Copy brief to Claude** prepares instructions; you still need to paste and send them in Claude.

## Before you start

1. Open your design file in Figma Desktop.
2. Run **Plugins → Development → Local MCP Bridge** and leave its panel open.
3. Open Claude Desktop and start a regular chat with Figma Local Bridge enabled.
4. Check the file and page shown in the plugin. If it is disconnected, open **Quick edits and connection help → Check connection**.
5. For automatic size adaptation, select **one editable frame directly on the page** as your starting design. Use an approved template that already has the correct logo, fonts, and imagery. You can select up to four artboards for concept creation and review, but automatic resizing requires a single-frame concept.

Your originals are kept. Campaign Studio prepares separate editable copies.

## 1. Choose a brand

Open **Campaign Studio → Choose your brand**.

- Click **Load saved kits** to choose a kit already saved in this file.
- If a colleague gave you a kit, expand **Create or import a brand kit**, then select its `.json` file under **Import a shared brand kit**.
- To make a kit, enter the brand name, kit version, approved colours, fonts, writing style, and design rules, then click **Save brand kit**.
- If you do not have a kit yet, leave **Use the selected design as a reference** selected.

Enter colours one per line, such as `Navy: #183C54`. Enter fonts like `Inter: Regular` or `Inter: Bold`. Use the font names installed on your machine and approved by your team.

Each campaign keeps a snapshot of its chosen kit. Editing the shared kit later does not silently change the rules for existing campaigns.

A kit is saved **with the Figma file**. It is not automatically copied to every staff member's files. Select a kit and click **Export kit** to download a shared file. If Figma blocks the download, copy the exported JSON from the editor and save it as a `.json` file. Send the kit through your usual team folder.

A kit can also contain approved templates and named parts such as headline, image, logo, and disclaimer. Your design lead can configure these. When a kit comes from another Figma file, Claude must find the corresponding assets in the current file; layer IDs are not portable by themselves.

## 2. Complete the brief

Fill in:

1. **Campaign name** — a short name you will recognise later.
2. **What are we promoting?** — the goal and product or service.
3. **Who is it for?** — the intended audience.
4. **Offer or key message** — use approved wording.
5. **What should people do?** — for example, “Book an appointment”.
6. **Where will it appear?** — choose square post, story, or banner.

Click **Prepare 3 concepts**. This creates three workspaces; it has not yet generated three finished designs.

Click **Copy brief to Claude**, switch to your regular Claude chat, paste, and send. Claude is instructed to develop three distinct directions: product-focused, bold promotional, and editorial. Text and design elements remain editable in Figma. For automatic sizes, Claude prepares named parts directly inside each frame before approval: Headline, Body, CTA, Image, Logo, and Disclaimer, using only the parts the design needs.

Keep the plugin open while Claude works. Wait for the current operation to finish before starting another.

## 3. Review the designs

When Claude finishes, return to the plugin and click **Refresh campaign**.

1. Select a concept card.
2. Click **Show in Figma** to inspect the design on the canvas.
3. Click **Compare previews** to see its first artboard beside the original. If your concept has several artboards, inspect all of them in Figma.
4. Click **Copy review request** and send those instructions to Claude.
5. Claude checks the actual rendered images, runs the available measurements, and can refine the draft up to twice. It must tell you about any unresolved issues.
6. Return to the plugin and click **Refresh campaign** to see the check results.

Measured checks and design opinions are different. For example, clipped text is a measurable error; whether the composition feels energetic is a design judgement. Complex image backgrounds may prevent a reliable contrast measurement. The panel reports these cases as unverified rather than claiming a pass.

When you are happy with a reviewed design, click **Approve selected concept**. The button becomes available only when the recorded checks match the current design and the required checks are complete. A later change requires a fresh review.

Approval does not publish or send anything.

## 4. Make the other sizes

Select your approved concept, choose the formats above, and click **Create selected sizes**.

The format presets are:

| Format | Size |
| --- | --- |
| Square post | 1080 × 1080 |
| Story | 1080 × 1920 |
| Banner | 1200 × 628 |

These are editable presets, not a claim that every advertising platform uses these dimensions. Ask Claude for a custom size when a channel has different requirements.

The layout engine uses named design parts to rearrange content. If it cannot identify the parts, use **Copy size request to Claude**. This includes the chosen concept and exact sizes, and asks Claude to verify the layer mappings. If an approved design needs structural changes, save a checkpoint and restore it as a new draft first. Review and approve the repaired draft before adapting it. Inspect every new format, especially text wrapping and image crops.

Under **Image placement and new imagery**, the image subject position helps preserve an important person or object during cropping. `50, 50` means the centre; `25, 50` means a subject left of centre.

Copy a review request for each new size, review the result, and approve it. Then click **Copy export request** and send it to Claude. Claude saves the approved PNGs on your Mac and reports their locations. Unapproved drafts should not be presented as final files.

To find the files, open **Finder**, press **Command Shift G**, paste `~/Pictures/Figma MCP Exports`, and press **Return**. If Arsenio configured a different folder, use the location Claude reports. You can drag the PNGs from Finder into your usual campaign folder or publishing app. Exporting does not publish them automatically.

## Save a version or return to an earlier one

Open **Saved versions and editing controls**.

- Enter a useful name such as “Before headline changes”, then click **Save this version**.
- Choose a saved version and click **Restore as a new draft** to continue from it. The earlier version stays in the file.
- Click **Finish campaign** when you are done. This releases the campaign editing restriction and keeps its saved history.
- To continue later, click **Refresh campaign**, choose it under **Saved campaigns on this page**, click **Open saved campaign**, then **Resume campaign**.

While a campaign is active, bridge edits are limited to its editable draft designs. This helps protect original artboards, approved concepts, and saved versions. Figma's own manual editing controls still work normally.

If something times out, refresh campaign status before repeating the action. Do not repeatedly click Prepare or ask Claude to recreate the same work without checking what already exists.

## Optional AI images

You can describe an image under **Image placement and new imagery**, then click **Copy image request to Claude**.

This feature needs an image provider configured separately by your administrator. It is disabled by default and may involve charges. Claude checks whether it is available and asks before sending a paid generation or image-edit request. Never paste a provider key into the Figma panel or your campaign brief.

Once an image has been generated, Claude can place it in a draft design. Review it before approval. Keep approved logos and editable text separate from generated imagery.

If the provider is not configured, use an existing approved image instead. The rest of Campaign Studio still works.

## What stays local

Figma canvas operations use the local bridge. Figma REST API and comment access stay disabled. Claude still processes the instructions and design information provided through its tools; “local bridge” does not mean the AI model runs entirely on your computer. Optional image generation sends its approved prompt and, for edits, the approved source image to the configured provider.

## Validation status

The package has automated workflow and interface checks. Its panel has also been previewed in an isolated browser. A full campaign through a real Claude Desktop chat, live Figma canvas, and paid image provider still needs a pilot before team-wide use.
