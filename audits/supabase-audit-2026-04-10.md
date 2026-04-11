# Supabase Audit: Non-Standard & Missing Practices

**Date:** 2026-04-10
**Scope:** Schema, RLS, Edge Functions, client code

---

## Findings (by severity)

### 1. SECURITY: `get_user_kanji` RPC leaks cross-user data
**File:** [supabase/migrations/20260405000000_initial_schema.sql:66-81](supabase/migrations/20260405000000_initial_schema.sql#L66-L81)

The RPC is `SECURITY DEFINER` and accepts an arbitrary `p_user_id` parameter. Any authenticated user can call it with another user's UUID to see their known kanji state. Standard practice: either validate `auth.uid() = p_user_id` inside the function, or remove the parameter entirely and use `auth.uid()` directly.

```sql
-- Current: trusts caller-supplied user_id
CREATE OR REPLACE FUNCTION get_user_kanji(p_user_id UUID)
...
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Fix: use auth.uid() directly, no parameter needed
CREATE OR REPLACE FUNCTION get_user_kanji()
RETURNS TABLE (...) AS $$
  SELECT k."character", k.grade, k.jlpt, k.meanings, k.readings_on, k.readings_kun,
         COALESCE(uk.known, false) AS known
  FROM kanji k
  LEFT JOIN user_kanji uk ON uk."character" = k."character" AND uk.user_id = auth.uid()
  ORDER BY k.grade, k."character";
$$ LANGUAGE sql STABLE SECURITY DEFINER;
```

The client call in [client/src/api/client.ts:14](client/src/api/client.ts#L14) would drop the parameter accordingly.

---

### 2. SECURITY: Edge Function `verify_jwt = false`
**File:** [supabase/config.toml:379](supabase/config.toml#L379)

Standard practice is `verify_jwt = true`. The function does manual JWT validation via `supabaseAdmin.auth.getUser(token)` ([generate-story/index.ts:38](supabase/functions/generate-story/index.ts#L38)), which works but is non-standard and has two downsides:
- Adds a round-trip to the auth service on every request
- Bypasses Supabase's built-in JWT verification at the gateway level, meaning malformed/expired tokens still reach your function code

**Fix:** Set `verify_jwt = true` and use the standard `supabase.auth.getUser()` pattern with the anon client rather than the admin client. The gateway rejects bad tokens before your code runs.

---

### 3. NON-STANDARD: Client passes `user_id` on inserts
**File:** [client/src/api/client.ts:262](client/src/api/client.ts#L262)

```ts
.insert({
  user_id: userId,  // passed from client state
  ...
})
```

Standard Supabase practice: use a column default of `auth.uid()` so the client never sends `user_id`. RLS `WITH CHECK` protects you either way, but the standard pattern is defense-in-depth and prevents the client from even attempting to set another user's ID.

```sql
-- In stories table definition:
user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
-- Same for user_kanji
```

Then omit `user_id` from all client `.insert()` and `.upsert()` calls.

---

### 4. NON-STANDARD: OpenRouter API key stored as plaintext column
**File:** [supabase/migrations/20260405000000_initial_schema.sql:46](supabase/migrations/20260405000000_initial_schema.sql#L46)

The standard Supabase approach for user secrets is Supabase Vault. Storing third-party API keys in a regular TEXT column means they're visible in database dumps, logs, and to anyone with database access.

For a personal project this is a pragmatic tradeoff, but it's worth noting as non-standard.

---

### 5. NON-STANDARD: `FOR ALL` RLS policies
**File:** [supabase/migrations/20260405000000_initial_schema.sql:89-104](supabase/migrations/20260405000000_initial_schema.sql#L89-L104)

All user-scoped tables use a single `FOR ALL` policy. Standard practice in Supabase docs (especially for tables with sensitive data like `profiles`) is to split into per-operation policies:

```sql
CREATE POLICY "select_own" ON profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "update_own" ON profiles FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
-- No INSERT policy needed if handle_new_user trigger creates the row
-- No DELETE policy if users shouldn't delete their profile
```

This makes the access model explicit and prevents accidental grants (e.g., users currently *can* delete their own profile row, which would break the app since `handle_new_user` only runs on signup).

---

### 6. MISSING: `updated_at` columns
**File:** [supabase/migrations/20260405000000_initial_schema.sql](supabase/migrations/20260405000000_initial_schema.sql)

No table has an `updated_at` column. Standard practice for mutable tables (`profiles`, `user_kanji`, `stories`):

```sql
updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

With a trigger to auto-set on update:

```sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

---

### 7. NON-STANDARD: CORS wildcard on Edge Function
**File:** [supabase/functions/generate-story/index.ts:4](supabase/functions/generate-story/index.ts#L4)

`Access-Control-Allow-Origin: "*"` is fine for local dev and matches Supabase example code, but for production the standard practice is to restrict to your actual domain. This is especially relevant since the endpoint handles authenticated requests with user API keys.

---

### 8. MINOR: No prompt length validation in Edge Function
**File:** [supabase/functions/generate-story/index.ts:68-75](supabase/functions/generate-story/index.ts#L68-L75)

The function validates presence of `prompt` and `model` but doesn't limit prompt length. A client could send an arbitrarily large prompt, burning OpenRouter credits. Standard practice: add a size check.

```ts
if (!prompt || typeof prompt !== 'string' || prompt.length > 50_000) {
  return new Response(JSON.stringify({ error: "Invalid prompt" }), { status: 400, ... });
}
```

---

### 9. MINOR: OAuth `signInWithOAuth` missing `redirectTo`
**File:** [client/src/contexts/AuthContext.tsx:94-98](client/src/contexts/AuthContext.tsx#L94-L98)

Standard practice is to specify `redirectTo` explicitly so OAuth works correctly across environments:

```ts
const { error } = await supabase.auth.signInWithOAuth({
  provider: "google",
  options: { redirectTo: `${window.location.origin}` },
});
```

---

## Things you're doing well (standard/better-than-standard)

- **RLS enabled on all tables** with correct `auth.uid()` checks
- **`SECURITY DEFINER` on trigger function** (`handle_new_user`) — correct for writing to a table the user can't directly insert into
- **`refreshSession()` on mount** instead of `getSession()` — actually better than the common pattern, avoids stale tokens after deploys
- **`onAuthStateChange` with cleanup** — correct subscription lifecycle
- **Composite index optimization** ([migration 20260410](supabase/migrations/20260410000000_add_stories_composite_index.sql)) — good query-aware indexing
- **`ON DELETE CASCADE` on all FK references** — correct cleanup behavior
- **Chunked bulk upserts** (500-row batches in `bulkUpdateKanji`) — avoids payload limits
- **Edge Function error mapping** (401/402/429 to user-friendly messages) — good UX practice
- **Model allowlist** (`ALLOWED_MODELS` set) — prevents arbitrary model usage
- **AbortSignal timeout** on OpenRouter fetch — prevents hanging requests

---

## Verification
After implementing fixes, verify:
1. `get_user_kanji` RPC — call without parameter, confirm it returns current user's data
2. Edge Function — confirm requests without valid JWT are rejected at the gateway (never reach function code)
3. Story insert — confirm omitting `user_id` from insert still works (column default fills it)
4. Profile delete — confirm it's blocked by RLS (no DELETE policy)
