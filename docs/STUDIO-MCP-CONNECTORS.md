# Studio MCP connector install/auth (P2.3)

Grok AddMcpServer / AuthenticateMcpServer parity for Product Studio.

## Lead tools

| Tool | Purpose |
|------|---------|
| `studio_mcp_catalogue` | List curated connectors + install/auth status |
| `studio_mcp_install` | Install a catalogue entry (pinned URL; no arbitrary hosts) |
| `studio_mcp_status` | Status for installed servers (`ready` / `needs_auth` / …) |
| `studio_mcp_connect` | Start user-oauth; returns `authorizationUrl` for the human |

## HTTP (`/api/studio/mcp`)

- `GET /catalogue`
- `POST /install` `{ key, instanceHost? }`
- `GET /status?serverId=`
- `POST /connect` `{ serverId }` → `{ authorizationUrl }`

## Auth status

| Status | Meaning |
|--------|---------|
| `needs_install` | Not added to this deployment yet |
| `needs_auth` | Installed user-oauth; person must complete consent |
| `needs_public_url` | OAuth needs `OPENBOT_PUBLIC_URL` |
| `ready` | Builtin / none / deployment-bearer, or user-oauth connected |
| `error` | Last refresh failed (`lastError`) |

## Scope

Catalogue only (`routines`, `google-drive`, `notion`, …). Custom MCP URLs remain on admin `/api/plugins/servers/custom` (fail-closed host policy).
