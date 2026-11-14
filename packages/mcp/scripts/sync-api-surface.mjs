// Regenerates src/api-surface.json (what surface.test.ts compares every tool's request against) from Hermesi's openapi.json.
// node scripts/sync-api-surface.mjs path/to/openapi.json
import { readFileSync, writeFileSync } from 'node:fs'

const source = process.argv[2]
if (!source) {
  console.error('usage: node scripts/sync-api-surface.mjs path/to/openapi.json')
  process.exit(1)
}
const spec = JSON.parse(readFileSync(source, 'utf8'))
const schemas = spec.components.schemas
const resolve = (schema) => (schema.$ref ? schemas[schema.$ref.split('/').pop()] : schema)

const out = {}
for (const [path, operations] of Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path.startsWith('/v1/manage/') && path !== '/v1/events') continue
  for (const [method, op] of Object.entries(operations)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue
    const params = op.parameters ?? []
    const body = op.requestBody ? resolve(op.requestBody.content['application/json'].schema) : null
    out[`${method.toUpperCase()} ${path}`] = {
      body: body ? Object.keys(body.properties ?? {}).sort() : null,
      headers: params.filter((p) => p.in === 'header' && p.name.toLowerCase() !== 'authorization').map((p) => p.name).sort(),
      query: params.filter((p) => p.in === 'query').map((p) => p.name).sort(),
      required: body ? [...(body.required ?? [])].sort() : [],
    }
  }
}
writeFileSync(new URL('../src/api-surface.json', import.meta.url), JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${Object.keys(out).length} operations`)
