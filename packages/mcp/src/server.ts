import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Api, ApiResult } from './api.js'
import { createToolContext, TOOLS, type ToolContext, type ToolDef } from './tools.js'

export const SERVER_VERSION = '0.1.0'

const HINTS: Record<string, string> = {
  insufficient_scope: 'The key lacks a scope the message names. Issue a management key with it (dashboard, API keys) and use that.',
  authentication_error: 'The key is invalid or revoked. Issue a new one in the dashboard, API keys.',
  management_key_required: 'This server needs a management key (hm_mk_...), not a signed-in session.',
}

export function toToolResult(result: ApiResult): CallToolResult {
  if (result.ok) {
    return { content: [{ type: 'text', text: result.data === null ? 'Done.' : JSON.stringify(result.data, null, 2) }] }
  }
  const { code, message, requestId, type } = result.error
  const hint = HINTS[code] ?? HINTS[type]
  const lines = [`${code}: ${message}`, hint, requestId ? `request_id: ${requestId}` : undefined].filter(Boolean)
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
  const server = new McpServer({ name: 'hermesi', version: SERVER_VERSION })
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
