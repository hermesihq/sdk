/**
 * The tools, as a table: each row is one Relay API call. The server holds no business rule; what a key may do is decided by the
 * API (its scopes), and what comes back is what the API chose to return (never the content people were sent).
 */

import { z } from 'zod'
import type { Api, ApiResult } from './api.js'

export interface KeyContext {
  organization_id: string
  project_id: string
  project_slug: string
  project_name: string
  environment_id: string
  environment: string
  simulate_sends: boolean
  key_id: string
  key_name: string
  scopes: string[]
}

export type Failure = Extract<ApiResult, { ok: false }>

export interface ToolContext {
  api: Api
  /** The key's own project and environment, asked once; `fresh` asks again (a setting may have changed since). */
  context(fresh?: boolean): Promise<{ ok: true; value: KeyContext } | { ok: false; error: Failure }>
}

export interface ToolDef {
  name: string
  description: string
  readOnly: boolean
  destructive: boolean
  input: z.ZodRawShape
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ApiResult>
}

export function createToolContext(api: Api): ToolContext {
  let cached: Promise<ApiResult> | undefined
  return {
    api,
    async context(fresh = false) {
      if (fresh) cached = undefined
      cached ??= api.request('GET', '/v1/manage/key-context')
      const result = await cached
      if (!result.ok) {
        cached = undefined // a transient failure must not stick
        return { ok: false, error: result }
      }
      return { ok: true, value: result.data as KeyContext }
    },
  }
}

const enc = encodeURIComponent
const json = z.record(z.string(), z.unknown())
const key = z.string().min(1).describe('The key (slug) of the item, for example "order-shipped".')
const limit = z.number().int().min(1).max(200).optional().describe('How many items to return (default 50).')
const channel = z.enum(['in_app', 'email', 'push', 'sms', 'whatsapp', 'telegram', 'slack', 'teams', 'discord'])
const cursor = z.string().optional().describe('The cursor from the previous page, to get the next one.')

type Shape = z.ZodRawShape
type Args<S extends Shape> = z.infer<z.ZodObject<S>>

/** Builds a tool whose handler receives the project or environment ids already resolved from the key. */
function tool<S extends Shape = Record<string, never>>(def: {
  name: string
  description: string
  readOnly?: boolean
  destructive?: boolean
  /** Read the key's context again for this call instead of using the one cached for the session. */
  fresh?: boolean
  input?: S
  run: (args: Args<S>, c: KeyContext, api: Api) => Promise<ApiResult>
}): ToolDef {
  return {
    name: def.name,
    description: def.description,
    readOnly: def.readOnly ?? false,
    destructive: def.destructive ?? false,
    input: def.input ?? {},
    async run(args, ctx) {
      const resolved = await ctx.context(def.fresh)
      if (!resolved.ok) return resolved.error
      return def.run(args as Args<S>, resolved.value, ctx.api)
    },
  }
}

const P = (c: KeyContext) => `/v1/manage/projects/${enc(c.project_id)}`
const E = (c: KeyContext) => `/v1/manage/environments/${enc(c.environment_id)}`
const page = (a: { limit?: number | undefined; cursor?: string | undefined }) => ({ limit: a.limit, cursor: a.cursor })
const idempotencyKey = () => ({ 'Idempotency-Key': crypto.randomUUID() })

export const TOOLS: ToolDef[] = [
  tool({
    name: 'whoami',
    description:
      'Which organisation, project and environment this key belongs to, whether the environment simulates sends, and the scopes the key holds. Call it first: it says what the other tools can do.',
    readOnly: true,
    run: async (_a, c) => ({ ok: true, status: 200, data: c }),
  }),

  // --- templates ---------------------------------------------------------------------------
  tool({
    name: 'list_templates',
    description: "List the project's templates.",
    readOnly: true,
    input: { limit, cursor },
    run: (a, c, api) => api.request('GET', `${P(c)}/templates`, { query: page(a) }),
  }),
  tool({
    name: 'get_template',
    description: 'One template with its published and draft versions.',
    readOnly: true,
    input: { key },
    run: (a, c, api) => api.request('GET', `${P(c)}/templates/${enc(a.key)}`),
  }),
  tool({
    name: 'create_template',
    description: 'Create an empty template. Then save a draft with its variants and publish it.',
    input: { key, name: z.string().min(1).describe('A human name.') },
    run: (a, c, api) => api.request('POST', `${P(c)}/templates`, { body: { key: a.key, name: a.name } }),
  }),
  tool({
    name: 'save_template_draft',
    description:
      "Replace a template's draft. `draft` is `{ \"variants\": [...] }`, one variant per channel and locale; each is `{ \"channel\", \"locale\", \"source\": {...} }` and what `source` holds depends on the channel. " +
      'Email: {"variants":[{"channel":"email","locale":"en","source":{"subject":"Your order {{ payload.order_id }} has shipped","mjml":"<mjml><mj-body><mj-section><mj-column><mj-text>Hello {{ subscriber.first_name }}</mj-text></mj-column></mj-section></mj-body></mjml>"}}]} (optional in source: preheader, text, reply_to). ' +
      'In-app: source {"title":"Shipped","body":"Order {{ payload.order_id }} is on its way","action_url":"https://..."} (optional: action_url, actions). ' +
      'SMS, Slack, Teams, Discord, Telegram: source {"text":"..."} (optional: actions). Any other field is refused. Placeholders are Jinja ({{ payload.x }}, {{ subscriber.first_name }}). Docs: https://docs.hermesi.app/concepts/templates.md',
    input: { key, draft: json.describe('`{ variants: [...] }`') },
    run: (a, c, api) => api.request('PUT', `${P(c)}/templates/${enc(a.key)}/draft`, { body: a.draft }),
  }),
  tool({
    name: 'preview_template',
    description: 'Render a variant with the code a real send uses, without sending anything. `request` is `{ channel, locale, payload?, subscriber? }`.',
    readOnly: true,
    input: { key, request: json.describe('`{ channel, locale, payload?, subscriber? }`') },
    run: (a, c, api) => api.request('POST', `${P(c)}/templates/${enc(a.key)}/preview`, { body: a.request }),
  }),
  tool({
    name: 'publish_template',
    description: "Publish the template's draft as its next version.",
    input: { key },
    run: (a, c, api) => api.request('POST', `${P(c)}/templates/${enc(a.key)}/publish`),
  }),
  tool({
    name: 'delete_template',
    description:
      'Delete a template. The API answers 409 template_in_use, naming the workflows, when an active workflow or a workflow draft has a step that names it, and when it has already been sent. Hermesi versions before that check let the delete through and the workflow then fails at that step: if you are unsure, call list_workflows and get_workflow first, and tell the person which workflows use it.',
    destructive: true,
    input: { key },
    run: (a, c, api) => api.request('DELETE', `${P(c)}/templates/${enc(a.key)}`),
  }),

  // --- workflows ---------------------------------------------------------------------------
  tool({
    name: 'list_workflows',
    description: "List the project's workflows.",
    readOnly: true,
    input: { limit, cursor },
    run: (a, c, api) => api.request('GET', `${P(c)}/workflows`, { query: page(a) }),
  }),
  tool({
    name: 'get_workflow',
    description: 'One workflow with its published and draft versions.',
    readOnly: true,
    input: { key },
    run: (a, c, api) => api.request('GET', `${P(c)}/workflows/${enc(a.key)}`),
  }),
  tool({
    name: 'create_workflow',
    description: 'Create a workflow that runs when `trigger_event` is published. Then save a draft with its steps and publish it.',
    input: {
      key,
      name: z.string().min(1),
      trigger_event: z.string().min(1).describe('The event name, for example "order.shipped".'),
      category_id: z.string().optional(),
      description: z.string().optional(),
    },
    run: (a, c, api) => api.request('POST', `${P(c)}/workflows`, { body: a }),
  }),
  tool({
    name: 'save_workflow_draft',
    description:
      "Replace a workflow's draft. `draft` is `{ \"definition\": {...}, \"notes\"?, \"payload_schema\"?, \"strict_payload\"? }`. The definition is " +
      '{"schema_version":1,"steps":[{"key":"email","type":"channel","channel":"email","template":"order-shipped"}]}: every step has a unique `key`; a "channel" step names a `channel` and a `template` (publish the template first: publishing the workflow pins its version); ' +
      'a "delay" step has a `duration` such as "PT1H"; a "condition" step has an `expression` such as "steps[\'inbox\'].read == false". Docs: https://docs.hermesi.app/concepts/workflows.md',
    input: { key, draft: json.describe('`{ definition, notes?, payload_schema?, strict_payload? }`') },
    run: (a, c, api) => api.request('PUT', `${P(c)}/workflows/${enc(a.key)}/draft`, { body: a.draft }),
  }),
  tool({
    name: 'publish_workflow',
    description: "Publish the workflow's draft: from then on events that match it run it.",
    input: { key },
    run: (a, c, api) => api.request('POST', `${P(c)}/workflows/${enc(a.key)}/publish`),
  }),
  tool({
    name: 'duplicate_workflow',
    description: 'Copy a workflow under a new key, name and trigger event.',
    input: {
      key,
      new_key: z.string().min(1),
      name: z.string().min(1),
      trigger_event: z.string().min(1).describe("The new workflow's event name."),
      category_id: z.string().optional(),
      description: z.string().optional(),
    },
    run: (a, c, api) =>
      api.request('POST', `${P(c)}/workflows/${enc(a.key)}/duplicate`, {
        body: { key: a.new_key, name: a.name, trigger_event: a.trigger_event, category_id: a.category_id, description: a.description },
      }),
  }),
  tool({
    name: 'delete_workflow',
    description: 'Delete a workflow. The API refuses a workflow that has already run.',
    destructive: true,
    input: { key },
    run: (a, c, api) => api.request('DELETE', `${P(c)}/workflows/${enc(a.key)}`),
  }),
  tool({
    name: 'export_workflow',
    description: 'A workflow as one JSON document, to keep in version control. Without `version`, the published one.',
    readOnly: true,
    input: { key, version: z.number().int().optional() },
    run: (a, c, api) => api.request('GET', `${P(c)}/workflows/${enc(a.key)}/export`, { query: { version: a.version } }),
  }),
  tool({
    name: 'import_workflow',
    description: "Import a workflow document (what export_workflow returned: `{ format, format_version, workflow, version }`) as a draft. It never changes an existing workflow's trigger, name or category.",
    input: { document: json.describe('The document export_workflow returned.') },
    run: (a, c, api) => api.request('POST', `${P(c)}/workflows/import`, { body: a.document }),
  }),
  tool({
    name: 'dry_run_workflow',
    description:
      'Run a workflow for a subscriber without sending anything, and say what it would do at each step. `subscriber_id` is the subscriber\'s external id (the one given to create_subscriber) or its internal id (sub_...); an external id is looked up first.',
    readOnly: true,
    input: { key, subscriber_id: z.string().min(1), payload: json.optional(), version: z.number().int().optional() },
    run: async (a, c, api) => {
      let subscriberId = a.subscriber_id
      if (!subscriberId.startsWith('sub_')) {
        // The test endpoint wants the internal id; the list is the one place a subscriber's external id is matched to it.
        const found = await api.request('GET', `${E(c)}/subscribers`, { query: { search: subscriberId, limit: 50 } })
        if (!found.ok) return found
        const rows = ((found.data as { data?: { id?: string; external_id?: string }[] } | null)?.data ?? []).filter((row) => row.external_id === subscriberId)
        const id = rows[0]?.id
        if (!id) {
          return {
            ok: false,
            error: {
              code: 'subscriber_not_found',
              type: 'not_found',
              message: `No subscriber with the external id "${subscriberId}" in the ${c.environment} environment. Create it with create_subscriber first.`,
            },
          }
        }
        subscriberId = id
      }
      return api.request('POST', `${P(c)}/workflows/${enc(a.key)}/test`, {
        body: { environment_id: c.environment_id, subscriber_id: subscriberId, payload: a.payload ?? {}, version: a.version },
      })
    },
  }),

  // --- categories --------------------------------------------------------------------------
  tool({
    name: 'list_categories',
    description: "List the project's notification categories.",
    readOnly: true,
    run: (_a, c, api) => api.request('GET', `${P(c)}/categories`),
  }),
  tool({
    name: 'create_category',
    description: 'Create a category. People turn categories on and off in their preferences; a critical one reaches them whatever they chose.',
    input: { key, name: z.string().min(1), is_critical: z.boolean().optional(), description: z.string().optional(), display_order: z.number().int().optional() },
    run: (a, c, api) => api.request('POST', `${P(c)}/categories`, { body: a }),
  }),
  tool({
    name: 'update_category',
    description: "Change a category's name, description or position. Whether it is critical cannot be changed afterwards. `category_id` comes from list_categories.",
    input: { category_id: z.string().min(1), name: z.string().min(1).optional(), description: z.string().optional(), display_order: z.number().int().optional() },
    run: ({ category_id, ...fields }, c, api) => api.request('PATCH', `${P(c)}/categories/${enc(category_id)}`, { body: fields }),
  }),
  tool({
    name: 'delete_category',
    description: 'Delete a category. Refused by the API while a workflow uses it. `category_id` comes from list_categories.',
    destructive: true,
    input: { category_id: z.string().min(1) },
    run: (a, c, api) => api.request('DELETE', `${P(c)}/categories/${enc(a.category_id)}`),
  }),

  // --- audience ----------------------------------------------------------------------------
  tool({
    name: 'list_subscribers',
    description: "List the environment's subscribers.",
    readOnly: true,
    input: { limit, cursor, search: z.string().optional() },
    run: (a, c, api) => api.request('GET', `${E(c)}/subscribers`, { query: { ...page(a), search: a.search } }),
  }),
  tool({
    name: 'get_subscriber',
    description: 'One subscriber with their channels and preferences.',
    readOnly: true,
    input: { external_id: z.string().min(1) },
    run: (a, c, api) => api.request('GET', `${E(c)}/subscribers/${enc(a.external_id)}`),
  }),
  tool({
    name: 'create_subscriber',
    description: 'Create a subscriber in this environment.',
    input: {
      external_id: z.string().min(1),
      email: z.string().optional(),
      phone_e164: z.string().optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      locale: z.string().optional(),
      timezone: z.string().optional(),
      data: json.optional(),
    },
    run: (a, c, api) => api.request('POST', `${E(c)}/subscribers`, { body: a }),
  }),
  tool({
    name: 'list_suppressions',
    description: 'List the addresses Hermesi will not send to.',
    readOnly: true,
    input: { limit, cursor },
    run: (a, c, api) => api.request('GET', `${E(c)}/suppressions`, { query: page(a) }),
  }),
  tool({
    name: 'create_suppression',
    description: 'Stop sending to an address on a channel.',
    input: { channel, identifier: z.string().min(1), details: json.optional() },
    run: (a, c, api) => api.request('POST', `${E(c)}/suppressions`, { body: a }),
  }),

  // --- activity ----------------------------------------------------------------------------
  tool({
    name: 'get_overview',
    description: 'Counts and rates for the environment: sent, delivered, failed. `days` is the window.',
    readOnly: true,
    input: { days: z.number().int().min(1).optional() },
    run: (a, c, api) => api.request('GET', `${E(c)}/overview`, { query: { days: a.days } }),
  }),
  tool({
    name: 'list_messages',
    description: 'Recent messages with their state. Content people were sent is never included.',
    readOnly: true,
    input: {
      limit,
      cursor,
      search: z.string().optional(),
      status: z.string().optional(),
      channel: channel.optional(),
      workflow: z.string().optional().describe('A workflow key.'),
      category: z.string().optional().describe('A category key.'),
      from: z.string().optional().describe('ISO date or time, inclusive.'),
      to: z.string().optional().describe('ISO date or time, exclusive.'),
    },
    run: (a, c, api) =>
      api.request('GET', `${E(c)}/messages`, {
        query: { ...page(a), search: a.search, status: a.status, channel: a.channel, workflow: a.workflow, category: a.category, from: a.from, to: a.to },
      }),
  }),
  tool({
    name: 'get_message',
    description: 'One message: its attempts and timeline, without its content.',
    readOnly: true,
    input: { message_id: z.string().min(1) },
    run: (a, c, api) => api.request('GET', `${E(c)}/messages/${enc(a.message_id)}`),
  }),
  tool({
    name: 'list_events',
    description: 'Recent events the environment received.',
    readOnly: true,
    input: { limit, cursor, search: z.string().optional(), status: z.string().optional(), name: z.string().optional().describe('An event name.'), from: z.string().optional(), to: z.string().optional() },
    run: (a, c, api) => api.request('GET', `${E(c)}/events`, { query: { ...page(a), search: a.search, status: a.status, name: a.name, from: a.from, to: a.to } }),
  }),
  tool({
    name: 'retry_dead_letter',
    description: 'Re-queue the messages that ran out of retries.',
    run: (_a, c, api) => api.request('POST', `${E(c)}/messages/retry-dead-letter`),
  }),
  tool({
    name: 'resend_message',
    description: 'Send a message again.',
    input: { message_id: z.string().min(1) },
    run: (a, c, api) => api.request('POST', `${E(c)}/messages/${enc(a.message_id)}/resend`, { headers: idempotencyKey() }),
  }),

  // --- a real test event: needs a secret key, so only registered when one is configured ----------
  tool({
    name: 'send_test_event',
    description:
      'Publish an event, as your backend would, with the configured secret key, which must belong to the same environment as the management key. Refused when that environment sends for real, unless the person who runs this server has set HERMESI_ALLOW_REAL_SEND=1 and the call passes `allow_real_send: true`: then real messages go to the real recipient.',
    destructive: true,
    fresh: true,
    input: {
      name: z.string().min(1).describe('The event name, for example "order.shipped".'),
      recipient: z.union([z.string().min(1), json]).describe("A subscriber's external id, or an inline recipient."),
      payload: json.optional(),
      allow_real_send: z.boolean().optional(),
    },
    run: async (a, c, api) => {
      if (api.secretKeyEnvironment !== c.environment) {
        const held = api.secretKeyEnvironment ? `for ${api.secretKeyEnvironment}` : 'not recognised (expected hm_sk_dev_, hm_sk_staging_ or hm_sk_prod_)'
        return {
          ok: false,
          error: {
            code: 'secret_key_environment_mismatch',
            type: 'validation_error',
            message: `The management key is for the ${c.environment} environment, but the secret key is ${held}. Use keys of the same environment.`,
          },
        }
      }
      if (!c.simulate_sends && !(a.allow_real_send === true && api.allowRealSend)) {
        return {
          ok: false,
          error: {
            code: 'real_send_not_allowed',
            type: 'validation_error',
            message: `The ${c.environment} environment sends for real. This server publishes to it only when its operator has set HERMESI_ALLOW_REAL_SEND=1 and the call passes allow_real_send: true. The agent cannot enable that: use a development environment, or turn Simulate sends on in the dashboard.`,
          },
        }
      }
      return api.request('POST', '/v1/events', {
        useSecretKey: true,
        headers: idempotencyKey(),
        body: { name: a.name, recipient: a.recipient, payload: a.payload ?? {} },
      })
    },
  }),
]
