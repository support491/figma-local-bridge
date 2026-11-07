# Staff pilot: two first-time users

Arsenio: run this checklist with two marketing team members using Macs. Give them the same staff-kit ZIP and START-HERE.html that the rest of the team will receive. Let each person follow the guide first, and record where help is needed.

Automated package tests simulate the Figma connection. This checklist verifies installation and work in the actual Claude Desktop and Figma Desktop apps. Blank results mean **not tested**.

## Record the setup

| Detail | Staff member 1 | Staff member 2 |
| --- | --- | --- |
| Name | | |
| Date | | |
| Staff-kit version | | |
| macOS version | | |
| Claude Desktop version | | |
| Figma Desktop version | | |
| Minutes to first successful task | | |

Use a practice Figma file that the staff member can edit. Include a simple artboard with a headline. Do not use live campaign originals for the first exercise.

## Follow these steps

Record **Pass**, **Needs help**, or **Fail** for each person, plus the message or step where they got stuck.

| Exercise and expected result | Staff member 1 | Staff member 2 |
| --- | --- | --- |
| Download the ZIP, unzip it, and open START-HERE.html without terminal commands. | | |
| Install the Claude `.mcpb`; find and enable Figma Local Bridge in a regular chat. | | |
| Import the Figma manifest from a permanent folder; run the plugin in the practice file. | | |
| Read the correct file and page on the welcome screen. | | |
| Use Check connection; confirm the plugin and bridge versions match. | | |
| Copy check-file instructions into Claude; Claude identifies the same file/page without edits. | | |
| Select the artboard and use Work on a copy; a duplicate appears and the original remains unchanged. | | |
| Choose the headline task, enter replacement wording, and paste the copied instructions into Claude. Verify only the copied artboard changed and the headline fits. | | |
| Click the Figma canvas and press Command Z; inspect each undo step. | | |
| Choose a campaign variation task; give one clear change and verify the named copy. | | |
| Choose export selected graphics; confirm Claude returns the expected PNG output. | | |
| Change pages, copy fresh instructions, and verify Claude uses the newly displayed page. | | |
| Open another Figma file with its plugin; confirm the instructions still identify the intended file. | | |
| Quit Claude and reopen it, then recheck the file connection. If an independent owner runs, record that connection stays available as expected. | | |
| Close and rerun the Figma plugin; copy new instructions and confirm reconnection. | | |
| Use Copy support details, inspect what was copied, and verify it contains no design text, file links, or local file paths. | | |

Arsenio should separately test the update path on the practice machine: install both parts of the new approved kit over an older approved kit, check versions, and run the first task. If testing a mismatch, use only the practice file, follow the displayed update guidance, and restore the matching pair before editing.

## Campaign Studio exercise

Repeat the following on a practice design before distributing this version. Automated and simulated tests do not substitute for this live exercise.

| Exercise and expected result | Staff member 1 | Staff member 2 |
| --- | --- | --- |
| Import the same approved brand kit; confirm its version, fonts and colours. | | |
| Complete the brief and prepare three concepts; originals remain unchanged. | | |
| Paste the brief in Claude; receive three visibly different editable directions. | | |
| Review rendered drafts; distinguish measured problems from design suggestions. | | |
| Modify a reviewed draft and verify its previous approval/review is rejected as stale. | | |
| Approve a chosen concept; save a checkpoint and restore it as a new draft. | | |
| Create square, portrait and banner variants; verify readable text and image crops. | | |
| Review/approve each variant and export the selected campaign files. | | |
| Close and rerun the plugin; confirm campaign state and checkpoints remain. | | |
| Finish the campaign explicitly; confirm ordinary file editing is available again. | | |

Record time to an accepted design, manual fixes, and the reason for rejecting any concept across several real briefs. Optional paid image generation should be tested separately only after its provider is configured and a specific request is approved.

## Finish the pilot

| Decision | Result |
| --- | --- |
| Both staff members completed the first task without Terminal or dependency installation. | |
| Both correctly identified the target file/page and preserved the original design. | |
| Update and reconnect checks completed. | |
| Open issues and required changes | |
| Approved version and approval date | |
| Approved by | |

Do not mark the pilot complete from unit tests alone. Keep this filled record with the release, fix blocking problems, and rerun the affected steps before wider rollout.
