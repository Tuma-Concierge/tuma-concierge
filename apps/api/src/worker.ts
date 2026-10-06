import app from "./app.js";
import { setAiBinding, type AiBinding } from "./ai/binding.js";
import { setD1Binding, type D1Database } from "./db/client.js";
import { setR2Binding, type R2Bucket } from "./storage/r2.js";

/** Minimal local stand-in so we don't need @cloudflare/workers-types (which
 * conflicts with @types/node's DOM-lib globals) just for one field. */
type CfExecutionContext = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

type WorkerEnv = Record<string, unknown> & { DB?: D1Database; RIDER_DOCS?: R2Bucket; AI?: AiBinding };

/** Cloudflare Worker entry. `env` carries Worker vars/secrets/bindings —
 * nodejs_compat gives us a `process` global, so mirror the string vars onto
 * process.env once per request and every existing `process.env.X` read in
 * the app keeps working unchanged. The D1 binding (`env.DB`) is registered
 * separately since it isn't a string. */
export default {
  fetch(request: Request, env: WorkerEnv, ctx: CfExecutionContext): Response | Promise<Response> {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") process.env[key] = value;
    }
    setD1Binding(env.DB);
    setR2Binding(env.RIDER_DOCS);
    setAiBinding(env.AI);
    return app.fetch(request, env as never, ctx as never);
  },
};
