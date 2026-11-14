import { handleMcpRequest, type HostedEnv } from './http.js'

/** Cloudflare Workers entry for the hosted server (`wrangler.toml`). */
export default {
  fetch: (request: Request, env: HostedEnv): Promise<Response> => handleMcpRequest(request, env),
}
