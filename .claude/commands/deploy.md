---
description: Validate and deploy the SPORDO Cloudflare Worker
argument-hint: [--dry-run to only validate]
allowed-tools: Bash(npm install:*), Bash(npm run:*), Bash(npx wrangler:*), Bash(git status:*), Bash(git log:*)
---

## Context

- Working tree: !`git status --short`
- Wrangler config present: !`ls wrangler.jsonc wrangler.toml 2>/dev/null`

## Your task

Deploy the Worker to Cloudflare. Arguments: **$ARGUMENTS**

1. Warn (but continue) if the working tree above is dirty — uncommitted changes won't be in the GitHub-driven deploy and can drift from production. Suggest running `/save` first.
2. Ensure dependencies are installed (`npm install` if `node_modules` is missing).
3. **Always validate first** with a dry run: `npx wrangler deploy --dry-run`. Read the output and confirm the assets directory and `ASSETS` binding resolve correctly.
4. If `$ARGUMENTS` contains `--dry-run`, stop here and report the validation result.
5. Otherwise deploy: `npm run deploy`. This requires Cloudflare auth (`npx wrangler login` locally, or `CLOUDFLARE_API_TOKEN` in CI). If auth fails, tell the user to run `wrangler login` or push to `main` to let the GitHub Action deploy.
6. Report the deployed URL (`https://spordo.<subdomain>.workers.dev`) or the failure.

Note: the canonical deploy path is pushing to `main` (the `.github/workflows/deploy.yml` Action). Use this command for local/manual deploys and pre-push validation.
