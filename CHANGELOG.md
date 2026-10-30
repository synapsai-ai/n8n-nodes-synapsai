# Changelog

## 0.2.3

- Docs: add nine English example workflows and README coverage for n8n Creator Portal verification.
- Docs: state that n8n Cloud verification is in progress and link the self-hosted quickstart.
- Fix: remove the leads count from the morning digest because `GET /v1/leads` has a fixed 30-day window and no date-range filter; a server API enhancement is a follow-up.

## 0.2.2

- Security: Tool node enforces read-only at runtime.
- Fix: Wait for Reply binding no longer depends on workflow static data.


## 0.2.1

- Security: F2 — split AI Agent access into a read-only tool node.
- Security: F3 — pin credential tests and API calls to the SynapsAI host.
- Security: F4 — derive default idempotency keys from canonical workflow, node, request, input and UTC day data.
- Security: F5 — reject replayed trigger deliveries and bind Ask replies to their waiting execution.
- Security: F6 — reject dot-segment and ASCII-control path identifiers.
- Security: F7 — pin publish actions and npm, use a protected environment, skip install scripts and add Dependabot.
- Security: F8 — verified no third-party npm scope references in package or docs.
- Security: F9 — exclude source maps and TypeScript build metadata from the tarball.
- Release bootstrap: the 0.0.1 placeholder already reserves the npm name. After merge, publish the functional 0.2.1 version from a clean checkout with npm 2FA; then configure Trusted Publisher, require 2FA and disallow tokens, retain the GitHub environment reviewer and `*.*.*` tag ruleset. Later versions (0.2.2+) publish with provenance through the tag workflow.
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
