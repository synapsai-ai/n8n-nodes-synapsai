# Changelog

## 0.2.1

- Security: F2 — split AI Agent access into a read-only tool node.
- Security: F3 — pin credential tests and API calls to the SynapsAI host.
- Security: F4 — derive default idempotency keys from canonical workflow, node, request and input data.
- Security: F5 — reject replayed trigger deliveries and bind Ask replies to their waiting execution.
- Security: F6 — reject dot-segment and ASCII-control path identifiers.
- Security: F7 — pin publish actions and npm, use a protected environment, skip install scripts and add Dependabot.
- Security: F8 — verified no third-party npm scope references in package or docs.
- Security: F9 — exclude source maps and TypeScript build metadata from the tarball.
- Release bootstrap: merge first, then from a clean checkout of the merge commit run `npm ci && npm run verify && RELEASE_MODE=true npm publish --access public` with 2FA; this creates the package and claims the name. After it exists, configure Trusted Publisher (owner `synapsai-ai`, repo `n8n-nodes-synapsai`, workflow `publish.yml`, environment `npm-publish`), require 2FA and disallow tokens, retain the GitHub environment reviewer and `*.*.*` tag ruleset; later versions (0.2.2+) publish with provenance through the tag workflow.
- Bug fix: preserve `itemIndex` when rethrowing `NodeApiError`.

## 0.2.0

- Campaign: Send (WhatsApp template, WhatsApp session, Messenger, Instagram; up to 1,000 contacts, per-recipient
  variables, scheduling, automatic Idempotency-Key), Get, Get Deliveries, Cancel. Needs the campaigns:read /
  campaigns:write scopes and the account's campaign-send permission.
- Template: Get Many (approved WhatsApp templates of an agent).
- Contact: Get Many, with the 24-hour window filter (WhatsApp, Messenger, Instagram).
- SynapsAI Trigger: Campaign Message Delivered / Read / Failed and Campaign Completed.

## 0.1.0

- SynapsAI node: Ask agent (with wait for reply), Get / Get many conversations (CSAT filters), Create or update contact,
  Get many leads, Get message.
- SynapsAI Trigger: Agent replied, Operator replied, Conversation ended, Human requested, Lead captured — subscribes and
  unsubscribes itself, verifies every signature.
