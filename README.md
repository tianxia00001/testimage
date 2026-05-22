# testimage

Local infinite-canvas image generation tool.

## Features

- Multiple canvases with pan and zoom.
- Text-to-image and image-to-image generation.
- Draggable and resizable image nodes.
- Prompt history and common prompt extraction.
- DeepSeek prompt refinement.
- Qwen image evaluation.
- Configurable image providers, with Seedream as the default.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in the API keys you want to use.
3. Start the server:

```bash
npm start
```

4. Open the local app on port `8787`.

Runtime files in `data/` and generated images in `generated/` are intentionally ignored by git.

## Daily workflow

Double-click `run-workflow.vbs` to run the local workflow without opening a console window. It starts the local server if needed, runs the image workflow, archives outputs under `runs/YYYY-MM-DD/`, and shows a Windows tray notification.

To register the daily 09:45 Windows task, run PowerShell from the project folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-daily-task.ps1
```

After a run, open `http://localhost:8787/workflow/feedback?run=YYYY-MM-DD` to review images and save the next manual revision note. The next workflow run uses only the latest non-empty feedback.

The workflow also reads `workflow/project-goal.md`, `workflow/visual-anchor-pool.json`, and recent run prompts to generate a suggested next prompt. The suggestion is now framed as a visible-anchor experiment, showing the experiment direction and changed anchors on the feedback page. Click "使用建议" to copy that suggestion into the manual feedback box before saving.
