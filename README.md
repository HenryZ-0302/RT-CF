# RT Account Router

Standalone Cloudflare Worker for multi-account round-robin.

It only does:

- account storage
- round-robin selection
- retry on network error / 5xx
- plain `/v1/*` passthrough

It does **not** do provider/model translation.

## Built-in public monitor and admin UI

After deploy, open:

- `/` for the public health monitor
- `/admin` for the management console

The public monitor only shows aggregate availability, usage, and health-check status. It does not expose account details or management actions.

The admin page lets you:

- verify `AUTH_TOKEN` before entering the console
- add/update accounts
- enable/disable accounts
- test a single account
- view account availability separately from real proxy/API usage
- filter and sort a compact account dashboard when the pool grows
- delete accounts
- inspect current router state

## Required secrets

Set these in Cloudflare:

- `AUTH_TOKEN`: bearer token required for both admin and proxy calls

Optional:

- `ACCOUNT_COOLDOWN_MS`: how long a failed account is skipped after a 5xx/network error. Default `30000`

## Admin endpoints

All admin endpoints require:

`Authorization: Bearer <AUTH_TOKEN>`

### Public aggregate status

`GET /public/status`

This endpoint is intentionally unauthenticated and only returns aggregate health statistics for the public monitor.

### List accounts

`GET /admin/accounts`

### Add or replace account

`POST /admin/accounts`

```json
{
  "id": "acc-1",
  "label": "Account 1",
  "baseUrl": "https://api.openai.com",
  "apiKey": "sk-xxx",
  "enabled": true,
  "extraHeaders": {
    "OpenAI-Organization": "org_xxx"
  }
}
```

### Update account

`PATCH /admin/accounts/:id`

### Delete account

`DELETE /admin/accounts/:id`

## Proxy usage

Send the same bearer token:

`Authorization: Bearer <AUTH_TOKEN>`

Then call the worker like a normal OpenAI-compatible endpoint:

- `GET /v1/models`
- `POST /v1/chat/completions`
- any other `/v1/*` route

## Deploy

```bash
npm install
npx wrangler deploy
```
