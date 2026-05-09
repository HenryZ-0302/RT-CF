# HYHub

Cloudflare Worker API Hub for OpenAI-compatible upstream APIs.

HYHub separates three things:

- `AUTH_TOKEN`: administrator login secret for `/admin`
- upstream accounts: user-provided API keys and base URLs
- projects: grouped upstream accounts with their own client-facing API keys

The client calls HYHub like a normal OpenAI-compatible endpoint. HYHub verifies the project API key, finds that project's own upstream account pool, then round-robins within that pool.

## Pages

After deploy, open:

- `/` for the public aggregate monitor
- `/admin` for the HYHub management console

The public monitor only shows aggregate availability, usage, and health-check status. It does not expose account details, project keys, or management actions.

The admin console has three pages:

- Dashboard: global project, account, availability, usage, and 24-hour model health overview
- Projects: switch projects and manage that project's upstream accounts
- Settings: manage project API keys, Base URL, routing policy, open models, import/export, and stats reset

## Required secrets

Set these in Cloudflare:

- `AUTH_TOKEN`: admin-only secret for `/admin`

Optional:

- `ACCOUNT_COOLDOWN_MS`: how long a failed upstream account is skipped after a 5xx/network error. Default `30000`
- `MAX_RETRY_ACCOUNTS`: max upstream accounts to retry per proxy request. Default `3`

## Admin flow

1. Log in to `/admin` with `AUTH_TOKEN`.
2. Use the default `RT 默认项目` or create another project.
3. Add upstream accounts inside that project with their own `baseUrl` and `apiKey`.
4. Create a project API key in Settings and give that key to the client.

`AUTH_TOKEN` is not used for proxy requests and is not used as a fallback upstream account key.

## Admin API

All admin endpoints require:

`Authorization: Bearer <AUTH_TOKEN>`

### Default project account compatibility

- `GET /admin/accounts`
- `POST /admin/accounts`
- `GET /admin/accounts/:id`
- `PATCH /admin/accounts/:id`
- `DELETE /admin/accounts/:id`
- `POST /admin/accounts/:id/test`

These legacy routes operate on the default `default-rt` project.

### Project accounts

- `GET /admin/projects/:projectId/accounts`
- `POST /admin/projects/:projectId/accounts`
- `GET /admin/projects/:projectId/accounts/:accountId`
- `PATCH /admin/projects/:projectId/accounts/:accountId`
- `DELETE /admin/projects/:projectId/accounts/:accountId`
- `POST /admin/projects/:projectId/accounts/:accountId/test`
- `PATCH /admin/projects/:projectId/accounts/batch`
- `POST /admin/projects/:projectId/accounts/test-all`
- `GET /admin/projects/:projectId/accounts/export`
- `POST /admin/projects/:projectId/accounts/import`

Example account:

```json
{
  "id": "acc-1",
  "projectId": "default-rt",
  "label": "OpenAI account",
  "baseUrl": "https://api.openai.com",
  "apiKey": "sk-xxx",
  "enabled": true,
  "extraHeaders": {
    "OpenAI-Organization": "org_xxx"
  }
}
```

### Projects

- `GET /admin/projects`
- `POST /admin/projects`
- `GET /admin/projects/:id`
- `PATCH /admin/projects/:id`
- `DELETE /admin/projects/:id`
- `POST /admin/projects/:id/keys`
- `DELETE /admin/projects/:id/keys/:key`

Example project:

```json
{
  "id": "proj-main",
  "name": "Main API",
  "enabled": true
}
```

## Proxy usage

Use a project API key created in `/admin`, not `AUTH_TOKEN`:

`Authorization: Bearer <PROJECT_API_KEY>`

Then call the worker like a normal OpenAI-compatible endpoint:

- `GET /v1/models`
- `POST /v1/chat/completions`
- any other `/v1/*` route

## Deploy

```bash
npm install
npx wrangler deploy
```
