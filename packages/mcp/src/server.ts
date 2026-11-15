import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Api, ApiResult } from './api.js'
import { createToolContext, TOOLS, type ToolContext, type ToolDef } from './tools.js'

export const SERVER_VERSION = '0.1.0'

/** What an agent needs to know about this server before it picks a tool; clients show it as the server's instructions. */
export const INSTRUCTIONS = [
  'Hermesi sends product notifications (email, SMS, WhatsApp, push, in-app, chat). These tools act on ONE project and ONE environment, the ones the key belongs to: call whoami first.',
  'Docs for agents: https://docs.hermesi.app/llms.txt (an index of every page, each also as Markdown at its address plus .md).',
  "Providers (Resend, SES, Twilio, Africa's Talking...) have no tool, on purpose: connecting one means entering credentials, which must not pass through this conversation. The person does it in the dashboard, Providers page (docs: https://docs.hermesi.app/integrations.md and one page per provider). A workflow step that uses provider \"auto\" needs at least one provider of its channel to send for real; dry runs and simulated environments need none.",
  'Also not available: people, API keys, organisations, creating projects or environments, and the content people were sent.',
  'Before a destructive call (a delete, retry_dead_letter, resend_message, send_test_event), say what it will do and to what.',
].join('\n')

/** How many refused fields to list; the rest are counted, so a huge payload cannot flood the conversation. */
const MAX_DETAIL = 20

const HINTS: Record<string, string> = {
  insufficient_scope: 'The key lacks a scope the message names. Issue a management key with it (dashboard, API keys) and use that.',
  authentication_error: 'The key is invalid or revoked. Issue a new one in the dashboard, API keys.',
  management_key_required: 'This server needs a management key (hm_mk_...), not a signed-in session.',
}

export function toToolResult(result: ApiResult): CallToolResult {
  if (result.ok) {
    return { content: [{ type: 'text', text: result.data === null ? 'Done.' : JSON.stringify(result.data, null, 2) }] }
  }
  const { code, message, requestId, type, detail } = result.error
  const hint = HINTS[code] ?? HINTS[type]
  const shown = (detail ?? []).slice(0, MAX_DETAIL)
  const fields = shown.map((d) => `- ${d.field ? `${d.field}: ` : ''}${d.issue}`)
  if ((detail?.length ?? 0) > MAX_DETAIL) fields.push(`- and ${(detail?.length ?? 0) - MAX_DETAIL} more`)
  const lines = [`${code}: ${message}`, ...fields, hint, requestId ? `request_id: ${requestId}` : undefined].filter(Boolean)
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] }
}

function register(server: McpServer, def: ToolDef, ctx: ToolContext): void {
  server.registerTool(
    def.name,
    {
      description: def.description,
      inputSchema: def.input,
      annotations: {
        readOnlyHint: def.readOnly,
        destructiveHint: def.destructive,
        idempotentHint: def.readOnly,
        openWorldHint: false,
      },
    },
    async (args) => toToolResult(await def.run(args as Record<string, unknown>, ctx)),
  )
}

export function createHermesiServer(api: Api): McpServer {
  const server = new McpServer({ name: 'hermesi', version: SERVER_VERSION }, { instructions: INSTRUCTIONS })
  const ctx = createToolContext(api)
  for (const def of TOOLS) {
    if (def.name === 'send_test_event' && !api.hasSecretKey) continue
    register(server, def, ctx)
  }

  server.registerPrompt(
    'setup-project',
    { description: 'Guide: from an empty project to a published workflow that has sent a simulated event.' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Set up this Hermesi project step by step. Use the Hermesi tools, and read https://docs.hermesi.app/llms.txt for how things work.',
              '1. Call whoami. Say which project and environment this is and which scopes the key has; stop if content:write is missing.',
              '2. Ask me which event to notify on and through which channel. Create a category, then a template, save its draft, preview it, publish it.',
              '3. Create a workflow on that event, save its draft with one step that sends the template, publish it.',
              '4. Create a subscriber, dry-run the workflow for them, and show me what it would do.',
              '5. If a secret key is configured and the environment simulates sends, send a test event and look at the message with list_messages.',
              'Provider credentials are never entered here: if a channel needs a provider, tell me to connect it in the dashboard (Providers) and carry on afterwards.',
            ].join('\n'),
          },
        },
      ],
    }),
  )
  return server
}
