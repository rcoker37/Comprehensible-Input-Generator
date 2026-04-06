import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

    // Get profile (API key + model)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("openrouter_api_key, preferred_model")
      .eq("user_id", user.id)
      .single();

    if (profileError || !profile?.openrouter_api_key) {
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

    const apiKey = profile.openrouter_api_key;
    const model = profile.preferred_model || "deepseek/deepseek-r1";

    // Parse request — client sends the prompt directly
    const { prompt } = await req.json();

    if (!prompt) {
      return new Response(JSON.stringify({ error: "Missing prompt" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Call OpenRouter with streaming
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
          temperature: 0.7,
          max_tokens: 4096,
          stream: true,
        }),
      }
    );

    if (!openRouterRes.ok) {
      const body = await openRouterRes.text();
      return new Response(
        JSON.stringify({
          error: `OpenRouter error (${openRouterRes.status}): ${body}`,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Stream the SSE response through to the client
    return new Response(openRouterRes.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
