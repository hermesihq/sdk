# @hermesihq/mcp

An [MCP](https://modelcontextprotocol.io) server for Hermesi. It lets an AI agent (Claude Code, Cursor, any MCP client) set up and
operate a project: create templates and workflows, preview and publish them, add subscribers, dry-run a workflow, read what became
of a message. It runs on your machine over stdio, or as a hosted HTTP endpoint you deploy.

It does with a **management key** what you would otherwise click through in the dashboard. It holds no rules of its own: every tool is
one call to Hermesi's API, so what the agent may do is exactly what the key's scopes allow.

## Use it from your editor

Issue a management key in the dashboard (**API keys**, type **Management**) with the scopes you want the agent to have, for one project and
one environment. Start with `development`.

**Claude Code**

```sh
claude mcp add hermesi --env HERMESI_API_KEY=hm_mk_dev_... -- npx -y @hermesihq/mcp
```

**Cursor** (`.cursor/mcp.json`) and most other clients:

```json
{
  "mcpServers": {
    "hermesi": {
      "command": "npx",
      "args": ["-y", "@hermesihq/mcp"],
      "env": { "HERMESI_API_KEY": "hm_mk_dev_..." }
    }
  }
}
```

| Variable | |
|---|---|
| `HERMESI_API_KEY` | Required. A management key (`hm_mk_...`). |
| `HERMESI_BASE_URL` | Where Hermesi runs. Default `https://go.hermesi.app`; set it for a self-hosted instance. |
| `HERMESI_SECRET_KEY` | Optional. A secret key (`hm_sk_...`) of the same environment. Only then is `send_test_event` available. |

Then ask your agent to run the `setup-project` prompt, or just say what you want: "create an email template and a workflow for
`order.shipped`, and dry-run it for user_1".

## What it can do

`whoami` first: it says which project and environment the key belongs to and which scopes it holds.

| Area | Tools |
|---|---|
| Templates | `list_templates`, `get_template`, `create_template`, `save_template_draft`, `preview_template`, `publish_template`, `delete_template` |
| Workflows | `list_workflows`, `get_workflow`, `create_workflow`, `save_workflow_draft`, `publish_workflow`, `duplicate_workflow`, `delete_workflow`, `export_workflow`, `import_workflow`, `dry_run_workflow` |
| Categories | `list_categories`, `create_category` |
| Audience | `list_subscribers`, `get_subscriber`, `create_subscriber`, `list_suppressions`, `create_suppression` |
| Activity | `get_overview`, `list_messages`, `get_message`, `list_events`, `retry_dead_letter`, `resend_message` |
| Test | `send_test_event` (needs `HERMESI_SECRET_KEY`) |

Reads are marked read-only and deletes destructive, so an editor can ask before running them. A key without a scope gets Hermesi's
`insufficient_scope` back, naming the scope it needs.

## What it will not do

- **Provider credentials.** They would pass through the conversation. The agent tells you to connect the provider in the dashboard.
- **People, keys and organisations.** A management key cannot reach them, so neither can this server.
- **Read what people were sent.** Message detail comes back without its content, as for a `viewer`.
- **Send for real by accident.** `send_test_event` refuses an environment that does not simulate sends unless the call says
  `allow_real_send: true`.

## Hosted

`dist/worker.js` is the same server as one stateless HTTP endpoint (`POST /mcp`, Streamable HTTP) for Cloudflare Workers. The caller's
`Authorization: Bearer hm_mk_...` is forwarded to Hermesi for that request and kept nowhere; there is no secret-key path. Deploy it
with `npm run build && npx wrangler deploy` (see `wrangler.toml`), then point your client at it:

```sh
claude mcp add --transport http hermesi https://your-worker.example.com/mcp --header "Authorization: Bearer hm_mk_dev_..."
```

## For agents that read documentation

The documentation is available as plain text: <https://docs.hermesi.app/llms.txt> (index) and <https://docs.hermesi.app/llms-full.txt>.

## Requirements

Node 20 or later for the command; any runtime with `fetch` for the hosted entry. The server needs a Hermesi version that has
`GET /v1/manage/key-context`.
