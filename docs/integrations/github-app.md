# FORGE GitHub App

## Website installation flow

1. Open the [FORGE website](https://forge-ecc.vercel.app/) and select **Get App**.
2. GitHub opens the FORGE App installation page. Choose your personal account or organization.
3. Choose **All repositories** or **Only select repositories**, then confirm **Install**.
4. GitHub returns to the FORGE setup page. The installation webhook records the installation metadata.
5. The current website presents **Get App** as the installation entry point. The hosted repository analysis workflow is not yet implemented.

## What works after installation

The current release establishes the GitHub App installation and webhook verification foundation. The App installation can be completed from the **Get App** link.

The App does **not yet** scan repository files, create pull requests, or run repository automation from the hosted website. For now, use the local FORGE CLI/dashboard for project inspection and engineering workflows:

```bash
npm install --global https://github.com/ansh44233/FORGE-ECC/releases/download/v3.0.0/forge-engineering-workbench-3.0.0.tgz
forge init ./my-project
forge inspect ./my-project
forge dashboard ./my-project
```

Open the local URL printed by `forge dashboard`. The dashboard operates on the workspace path you provide. GitHub App installation is a separate connection step and does not automatically upload or scan that local workspace.

## FORGE v2: commands, PR checks and setup pull requests (preview on `forge-v2`)

After installation, comment on any issue or pull request (collaborators with write access only):

| Command | Result |
|---|---|
| `/forge analyze [--targets claude,cursor,codex,opencode,gemini] [--profile minimal\|standard\|full]` | Analyzes files, manifests and the last 100 commits, then opens a `forge/setup` PR with FORGE agents, skills, commands, rules, a repository-specific `forge-project` skill, managed `AGENTS.md`/`GEMINI.md` blocks and `.forge/install-state.json`. Existing files you wrote are never overwritten. |
| `/forge repair` | Opens a `forge/repair` PR with catalog updates; files you edited are kept |
| `/forge audit` | Comments a FORGE Shield report for the default branch (or the PR head) |
| `/forge doctor` | Reports missing, outdated and new FORGE files on the default branch |
| `/forge risk` | On a PR: explainable 0–100 change-risk score and suggested reviewers |
| `/forge help` | Lists commands |

On every pull request (opened, synchronize, reopened, ready for review) FORGE posts a **FORGE** check run with change risk and Shield results. It fails only when the PR itself adds a critical/high Shield finding (for example `bypassPermissions` or a plain-HTTP MCP server); high-risk changes are reported as neutral.

### Required App settings for v2

In GitHub → Settings → Developer settings → GitHub Apps → FORGE → **Permissions & events**:

- Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Issues: Read and write**, **Checks: Read and write**, **Metadata: Read-only**
- Subscribe to events: **Installation**, **Installation repositories**, **Issue comment**, **Pull request**

Existing installations must accept the new permissions (GitHub sends the owner a request). Installation tokens are minted per event and scoped to the single repository in the event.

### Operational notes

- Webhook deliveries are de-duplicated in Redis by `X-GitHub-Delivery` for 24 hours.
- Only agent-configuration files (at most 120, each ≤256 KiB) are fetched for Shield; source code is not downloaded. Analysis reads the file tree, root manifests and commit subjects.
- The webhook function needs `GITHUB_APP_PRIVATE_KEY` (PEM; `\n` escapes are accepted) and includes `catalog/**` in its bundle (`vercel.json`).

## Server endpoints

- `GET /api/github/health` reports whether required server environment variables are present.
- `GET /api/github/install` redirects to the configured GitHub App installation page.
- `GET /api/github/login` starts GitHub App user authorization using one-time state and PKCE.
- `GET /api/github/callback` exchanges the authorization code, verifies the GitHub user, and records only installations that GitHub confirms the user can access.
- `GET /api/github/setup?installation_id=...` checks the signed-in user's installation access before completing setup.
- `GET /api/github/me` returns the signed-in user's public login and verified installation metadata only.
- `POST /api/github/logout` revokes the local server-side session.
- `POST /api/github/webhook` verifies GitHub's `X-Hub-Signature-256` header and persists installation metadata.

## Vercel environment variables

Configure these in Vercel Project Settings → Environment Variables. Never commit or share their values:

- `GITHUB_APP_SLUG`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_CALLBACK_URL` (optional; if set, it must be exactly `https://forge-ecc.vercel.app/api/github/callback`)
- `KV_REST_API_URL` (or `UPSTASH_REDIS_REST_URL`)
- `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_TOKEN`)

The Redis token must have write access. The read-only token is not sufficient.

## GitHub App settings

- Homepage: `https://forge-ecc.vercel.app/`
- Webhook: `https://forge-ecc.vercel.app/api/github/webhook`
- User authorization callback URL: `https://forge-ecc.vercel.app/api/github/callback`
- Setup URL (when "Request user authorization (OAuth) during installation" is disabled): `https://forge-ecc.vercel.app/api/github/setup`
- Subscribe to `installation` and `installation_repositories` webhook events.
- Keep permissions least-privilege: repository Metadata read-only and Contents read-only.

## Security model

- OAuth uses random one-time state stored in Redis, PKCE S256, and an exact production callback URL.
- OAuth access tokens are used server-side to verify the GitHub user and list their accessible installations. Tokens are not returned to the browser or persisted.
- Sessions use random opaque IDs in Secure, HttpOnly, SameSite=Lax cookies; session data is stored server-side in Redis with an eight-hour expiry.
- Installation IDs from query parameters are never treated as proof of authorization. The authenticated user's `GET /user/installations` result is the source of truth.
- The `/api/github/me` endpoint only returns installation records whose IDs are in that verified session and whose App ID matches the configured app.
- Webhook signatures are checked against the raw request body before JSON parsing.
- Installation records contain metadata only, not private keys, access tokens, or repository contents.

This is the authentication and installation-association foundation. It does not yet expose repository contents, mint installation tokens, scan repositories, or create pull requests.
