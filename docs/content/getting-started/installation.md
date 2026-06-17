---
title: "Installation"
weight: 10
description: "Build and install the extension from source"
---

# Installation

## Run the Local Website

```bash
git clone https://github.com/microsoft/ai-engineering-coach.git
cd ai-engineering-coach
npm install
npm run site
```

Open `http://127.0.0.1:3987`.

To use a different workspace root or port:

```bash
npm run site:serve -- --port 3990 --workspace /path/to/repo
```

Summary exports are written to `~/.ai-engineer-coach/exports` by default. Set `AIEC_EXPORT_DIR` to choose another folder. GitHub SDLC data uses `GITHUB_TOKEN` or `GH_TOKEN` when available.

Coach chat, AI-assisted rule generation, quizzes, context reviews, skill drafting, and triage use an OpenAI-compatible provider in website mode:

```bash
AIEC_LLM_BASE_URL=http://127.0.0.1:11434/v1 AIEC_LLM_MODEL=llama3.1 npm run site
OPENAI_API_KEY=... OPENAI_MODEL=gpt-4.1-mini npm run site
```

Supported provider variables are `AIEC_LLM_BASE_URL`, `AIEC_LLM_API_KEY`, `AIEC_LLM_MODEL`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OLLAMA_BASE_URL`, and `OLLAMA_MODEL`.

The extension is not yet published on the VS Code Marketplace. Install it by building a `.vsix` package from source.

## Package from Source

```bash
git clone https://github.com/microsoft/ai-engineering-coach.git
cd ai-engineering-coach
npm install
npm run package
```

This produces a `.vsix` file in the project root.

## Install the .vsix

From the command line:

```bash
code --install-extension ai-engineer-coach-*.vsix
```

Or open the Extensions panel in VS Code, click the `...` menu, choose **Install from VSIX...**, and select the file.

## Development

To run the extension in development mode instead, use `npm run build` and press `F5` in VS Code to launch the Extension Development Host.

## Opening the Dashboard

After installation, open the Command Palette and run:

```
AI Engineer Coach: Open Dashboard
```

You can also click the AI Engineer Coach icon in the Activity Bar (sidebar) if it appears there.

## Configuration

AI Engineer Coach works out of the box with sensible defaults. Optional settings are available under `aiEngineerCoach.*` in VS Code settings to control cache behavior, date ranges, and workspace filtering.
