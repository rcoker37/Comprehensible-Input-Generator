import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_MODELS = new Set([
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.1-pro-preview",
]);

// Module-level admin client (reused across requests in per_worker mode)
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get API key from Vault via service-role RPC
    const { data: apiKey, error: keyError } = await supabaseAdmin.rpc(
      "get_openrouter_api_key_for_user",
      { p_user_id: user.id }
    );

    if (keyError || !apiKey) {
      return new Response(
        JSON.stringify({
          error: "Please configure your OpenRouter API key in Settings.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse request — client sends the prompt and model directly
    const { prompt, model, stream = true } = await req.json();

    if (!prompt || !model) {
      return new Response(JSON.stringify({ error: "Missing prompt or model" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!ALLOWED_MODELS.has(model)) {
      return new Response(JSON.stringify({ error: "Unsupported model" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Call OpenRouter
    const openRouterRes = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          stream,
        }),
        signal: AbortSignal.timeout(120_000),
      }
    );

    if (!openRouterRes.ok) {
      const status = openRouterRes.status;
      console.error("OpenRouter error:", status, await openRouterRes.text());

      const userMessage =
        status === 401 ? "Invalid OpenRouter API key. Please check your key in Settings." :
        status === 402 ? "Insufficient OpenRouter credits." :
        status === 429 ? "Rate limited by OpenRouter. Please wait and try again." :
        "Story generation failed. Please try again.";

      return new Response(
        JSON.stringify({ error: userMessage }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (stream) {
      // Stream the SSE response through to the client
      return new Response(openRouterRes.body, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    // Non-streaming: return the JSON response directly
    const result = await openRouterRes.json();
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return new Response(
        JSON.stringify({ error: "The model took too long to respond. Please try again." }),
        {
          status: 504,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    const message = err instanceof Error ? err.message : "Generation failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
