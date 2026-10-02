// The build writes two configs into one `dist/` at the same time, so neither may clean it: the
// second would delete what the first just wrote. It is emptied here, once, before either starts.
import { rmSync } from 'node:fs'

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true })
