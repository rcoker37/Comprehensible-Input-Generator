import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

    // Fetch API key from Vault
    const { data: apiKey, error: keyError } = await supabaseAdmin.rpc(
      "get_openrouter_api_key_for_user",
      { p_user_id: user.id }
    );
    if (keyError || !apiKey) {
      return jsonResponse({ error: "No API key configured" }, 400);
    }

    // Proxy OpenRouter usage lookup
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return jsonResponse({ error: "OpenRouter error" }, 502);
    }

    const data = await res.json();
    return jsonResponse(data);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return jsonResponse({ error: "OpenRouter timed out" }, 504);
    }
    const message = err instanceof Error ? err.message : "Failed";
    return jsonResponse({ error: message }, 500);
  }
});
