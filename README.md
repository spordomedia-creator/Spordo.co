# SPORDO

NYC sports field & court permit availability tracker — _Know Before You Go_.

This repo is a single-page web app (`public/TrueSpordo.html`) served as a
[Cloudflare Worker](https://developers.cloudflare.com/workers/) with
[static assets](https://developers.cloudflare.com/workers/static-assets/).

## Project layout

```
.
├── public/                 # Static assets served by the Worker
│   ├── TrueSpordo.html     # The main app (served at "/")
│   └── sp-live-test.html   # sp-live widget test harness (served at "/sp-live-test.html")
├── src/
│   └── index.js            # Worker entrypoint — routes "/" to the app, else serves assets
├── wrangler.jsonc          # Cloudflare Worker configuration
├── package.json
├── .github/workflows/
│   └── deploy.yml          # CI: deploys to Cloudflare on push to main
└── .gitignore
```

## Local development

```bash
npm install
npm run dev        # starts wrangler dev at http://localhost:8787
```

## Deploy from your machine

```bash
npx wrangler login   # one-time browser auth
npm run deploy
```

## Deploy from GitHub (CI)

`.github/workflows/deploy.yml` deploys automatically on every push to `main`
(and can be run manually via **Actions → Deploy to Cloudflare Workers → Run
workflow**).

Add these two repository secrets first — **Settings → Secrets and variables →
Actions → New repository secret**:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Account ID (right sidebar) |

Once the secrets are set, push to `main` and the app deploys to
`https://spordo.<your-subdomain>.workers.dev`.

## Notes

- The `compatibility_date` in `wrangler.jsonc` pins the Workers runtime
  behavior; bump it intentionally when you want newer runtime features.
- Static files in `public/` are served directly by Cloudflare's asset runtime;
  the Worker in `src/index.js` only runs for paths that don't match a file
  (e.g. `/`, which it rewrites to `TrueSpordo.html`).
