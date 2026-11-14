import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createApi } from './api.js'
import { createHermesiServer } from './server.js'

const apiKey = process.env.HERMESI_API_KEY
if (!apiKey) {
  console.error(
    'hermesi-mcp: set HERMESI_API_KEY to a management key (hm_mk_...). Optional: HERMESI_BASE_URL (default https://go.hermesi.app), HERMESI_SECRET_KEY (hm_sk_..., for send_test_event).',
  )
  process.exit(1)
}

const api = createApi({
  baseUrl: process.env.HERMESI_BASE_URL || 'https://go.hermesi.app',
  apiKey,
  secretKey: process.env.HERMESI_SECRET_KEY || undefined,
})
await createHermesiServer(api).connect(new StdioServerTransport())
