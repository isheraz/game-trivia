// Minimal Deno globals for local type-checking in VS Code / tsserver.
// Supabase Edge Functions provide Deno at runtime; this shim avoids TS errors locally.
declare const Deno: {
  env: {
    get(name: string): string | undefined
  }
}
