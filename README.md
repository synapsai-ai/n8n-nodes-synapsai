# n8n-nodes-synapsai

Put a SynapsAI agent inside your n8n workflow: ask it a question, wait for the answer, and react when it replies, a
conversation ends or a lead is captured. Your workflow stays the orchestrator; SynapsAI is one step in it.

Works on n8n Cloud and self-hosted n8n (1.x). Zero runtime dependencies.

## Install

- **n8n Cloud** — Nodes panel → search “SynapsAI” (after verification).
- **Self-hosted** — Settings → Community nodes → Install → `n8n-nodes-synapsai`, or
  `npm install n8n-nodes-synapsai` in `~/.n8n/nodes`.

## Credentials

Create a **SynapsAI API** credential:

| Field | Value |
|---|---|
| API Key | an `sk_live_…` key from the console (Account → API keys). Scopes: `messages:write` for Ask, `conversations:read`, `contacts:read`/`contacts:write`, `leads:read`, `hooks:write` for the trigger, `agents:read` for the agent picker. |
| Agent Signing Secret | the agent’s signing secret: agent → **Extensions** → **Workflow API (n8n · Make)**. Needed only for **Wait for Reply**. |

Do not give an AI Agent a key with `campaigns:write` or `contacts:write`.

The credential test calls `GET /v1/me`. API access is part of the GROWTH, PRO and ENTERPRISE plans: below GROWTH
the test fails with **PLAN_FEATURE_UNAVAILABLE**.

## SynapsAI node

| Resource | Operation | API |
|---|---|---|
| Agent | Ask | `POST /v1/agents/{agentKey}/messages` |
| Conversation | Get many (filters incl. CSAT min/max; Return All or Limit) | `GET /v1/conversations` → `{items, page, size, total}` |
| Conversation | Get (by `chatId`; includes `csat` and messages) | `GET /v1/conversations/{id}` |
| Contact | Create or update | `POST /v1/contacts:upsert` |
| Lead | Get many (CRM outcome filter; Return All or Limit) | `GET /v1/leads` → `{items, nextCursor, total}` |
| Message | Get | `GET /v1/messages/{messageId}` |

### Ask → Wait for Reply

SynapsAI answers asynchronously. With **Wait for Reply** on, the node sends the message with this execution’s signed
resume URL as `callbackUrl` and puts the execution to wait. SynapsAI posts the signed `message.replied` (or
`message.failed`) to that URL; the node checks the `X-Synapsai-Signature` with the agent signing secret (±5 min) and
resumes with:

```json
{ "status": "REPLIED", "messageId": "msg_…", "conversationId": "…", "text": "…", "components": [], "metadata": {}, "errorCode": null, "event": { } }
```

A request with a wrong signature is answered 401 and the execution keeps waiting. After **Limit Wait Time** the
execution continues with the accepted message (`{messageId, status: "QUEUED"}`); read the reply later with
**Message → Get**.

Requirements: your n8n must be reachable over **HTTPS on port 443** (SynapsAI never calls http, private IPs or other
ports). On self-hosted n8n set `WEBHOOK_URL=https://your-host/`. One item per execution while waiting — use *Loop Over
Items* for batches.

**Fallback (any n8n version):** turn Wait for Reply off, put `{{ $execution.resumeUrl }}` in *Options → Callback URL*,
and add n8n’s **Wait** node set to *On Webhook Call* (POST) right after it.

### Errors and retries

Errors show SynapsAI's `CODE: message` (e.g. `SCOPE_MISSING: …`, `AGENT_FORBIDDEN: …`). A **503** means SynapsAI did
not complete the call. The node retries it twice (after 1 s and 3 s) for the idempotent calls only — reads, and Ask agent,
which always sends an idempotency key so a retry never starts a second turn. The default key changes at UTC midnight.
For multiple identical campaign sends in the same UTC day, set an explicit **Idempotency Key** expression that
changes for each intended send: campaign keys never expire server-side.
A **429** on those same calls waits its `Retry-After` (up to a minute) and retries. Create or update contact and the
trigger's subscribe/unsubscribe are never retried: the write may have been applied.

### SynapsAI Tool (read-only)

Use the separate **SynapsAI Tool (read-only)** node with an AI Agent. It exposes only read operations. The API key
connected to an AI Agent must not have `campaigns:write` or `contacts:write` scopes.

## SynapsAI Trigger

Events: **Agent replied** (`message.replied`), **Operator replied** (`message.operator`), **Conversation ended**,
**Human requested** (`handoff.requested`), **Lead captured** (`lead.captured`).

*Lead captured* needs `leads:read`; its `lead` (`score, interest, dealTitle, budget, timeframe, contactDeclined`)
holds no personal data — tick **Include → Contact** (`contacts:read`) to get the person. *Agent replied* also
receives `message.failed`; *Agent replied* and *Operator replied* need `conversations:read`.

Activating the workflow subscribes the trigger’s webhook URL at SynapsAI (`POST /v1/agents/{agentKey}/hooks`); it keeps
the subscription id and signing secret in the workflow’s static data, and deactivating unsubscribes
(`DELETE /v1/hooks/{id}`). Every request is verified; a bad signature gets 401. Up to 20 API subscriptions per agent.

## Develop

```bash
npm ci
npm run check:deps   # fails on any runtime dependency
npm run lint         # n8n-node lint
npm test             # n8n-node build + node:test
npm run dev          # n8n with this node loaded, at http://localhost:5678
```

## Release

The `n8n-nodes-synapsai@0.0.1` placeholder already reserves the npm name. After this PR merges, publish the first
functional version (`0.2.1`) manually from a clean checkout of its merge commit with npm 2FA:

```bash
npm ci && npm run verify && RELEASE_MODE=true npm publish --access public
```

This publishes the functional node package. Then configure npm Trusted Publisher for
owner `synapsai-ai`, repo `n8n-nodes-synapsai`, workflow `publish.yml`, environment `npm-publish`; set package publishing
to require 2FA and disallow tokens; create the GitHub `npm-publish` environment with a required reviewer and a tag
ruleset matching `*.*.*`. Every later release (0.2.2+) is published with provenance by pushing a tag equal to
`package.json` `version` through `.github/workflows/publish.yml`.

## License

MIT
