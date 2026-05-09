# HYHub

Cloudflare Worker API Hub for OpenAI-compatible upstream APIs.

HYHub separates three things:

- `AUTH_TOKEN`: administrator login secret for `/admin`
- upstream accounts: user-provided API keys and base URLs
- projects: grouped upstream accounts with their own client-facing API keys

The client calls HYHub like a normal OpenAI-compatible endpoint. HYHub verifies the project API key, finds that project's selected upstream account group, then round-robins within that group.

## Pages

After deploy, open:

- `/` for the public aggregate monitor
- `/admin` for the HYHub management console

The public monitor only shows aggregate availability, usage, and health-check status. It does not expose account details, project keys, or management actions.

## Required secrets

Set these in Cloudflare:

- `AUTH_TOKEN`: admin-only secret for `/admin`

Optional:

- `ACCOUNT_COOLDOWN_MS`: how long a failed upstream account is skipped after a 5xx/network error. Default `30000`
- `MAX_RETRY_ACCOUNTS`: max upstream accounts to retry per proxy request. Default `3`

## Admin flow

1. Log in to `/admin` with `AUTH_TOKEN`.
2. Add upstream accounts with their own `baseUrl` and `apiKey`.
3. Create one or more projects.
4. Select a project, tick the upstream accounts that belong to it, then save the project.
5. Create a project API key and give that key to the client.

`AUTH_TOKEN` is not used for proxy requests and is not used as a fallback upstream account key.

## Admin API

All admin endpoints require:

`Authorization: Bearer <AUTH_TOKEN>`

### Accounts

- `GET /admin/accounts`
- `POST /admin/accounts`
- `GET /admin/accounts/:id`
- `PATCH /admin/accounts/:id`
- `DELETE /admin/accounts/:id`
- `POST /admin/accounts/:id/test`

Example account:

```json
{
  "id": "acc-1",
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
  "enabled": true,
  "accountIds": ["acc-1", "acc-2"]
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
