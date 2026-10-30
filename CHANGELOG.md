# Changelog

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
