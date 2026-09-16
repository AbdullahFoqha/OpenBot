# Studio bot-scoped secrets (P2.4)

Grok `secret-request` parity: store secrets per Bot without putting plaintext in chat transcripts.

## Lead tools

| Tool | Purpose |
|------|---------|
| `studio_secret_set` | Encrypt and store `{ botId, name, value }` |
| `studio_secret_list` | List names for a bot (**never values**) |
| `studio_secret_delete` | Remove by bot + name |

## HTTP

- `GET /api/studio/bots/:id/secrets` — metadata only
- `PUT /api/studio/bots/:id/secrets/:name` `{ value }` — create/rotate
- `DELETE /api/studio/bots/:id/secrets/:name`

## Storage

Table `studio_bot_secrets`: AES envelope via the deployment `keyEncryptionKey` (same helper as the credential vault). Unique `(bot_id, name)`. Cascade-delete with the agent row.

## Security

- List/status responses never include plaintext.
- Names must be env-style identifiers (`^[A-Za-z_][A-Za-z0-9_]*$`).
- Runtime may call `readPlaintext` internally; Lead tools do not expose it.
