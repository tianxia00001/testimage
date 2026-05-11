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
