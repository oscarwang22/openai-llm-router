import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/console", express.static(path.join(__dirname, "..", "public")));

// Config
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const ROUTER_API_KEY = process.env.ROUTER_API_KEY || "";
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "240000", 10);

// Provider configs in fallback order
const PROVIDERS = [
  {
    id: "kilo-gateway",
    name: "Kilo Gateway",
    baseUrl: (process.env.KILO_BASE_URL || "https://api.kilo.ai/api/gateway").replace(/\/$/, ""),
    apiKey: process.env.KILO_API_KEY || "",
    model: process.env.KILO_MODEL || "particle-ai/particle-1:free",
    displayModel: "particle-ai/particle-1:free",
    timeoutMs: parseInt(process.env.KILO_TIMEOUT_MS || "30000", 10),
    docs: "https://docs.particle.ai",
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    baseUrl: (process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1").replace(/\/$/, ""),
    apiKey: process.env.OPENCODE_API_KEY || "",
    model: process.env.OPENCODE_MODEL || "tidepool-alpha-free",
    displayModel: "tidepool-alpha-free",
    timeoutMs: parseInt(process.env.OPENCODE_TIMEOUT_MS || "30000", 10),
    docs: "https://opencode.ai/docs/console/models/",
  },
  {
    id: "nvidia-nim",
    name: "NVIDIA NIM Build API",
    baseUrl: (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, ""),
    apiKey: process.env.NVIDIA_API_KEY || "",
    model: process.env.NVIDIA_MODEL || "minimaxai/minimax-m3.1-flash",
    displayModel: "minimaxai/minimax-m3.1-flash",
    timeoutMs: parseInt(process.env.NVIDIA_TIMEOUT_MS || process.env.REQUEST_TIMEOUT_MS || "240000", 10),
    docs: "https://build.nvidia.com/minimaxai/minimax-m3.1-flash",
  },
];

// Logging helper
function log(level, ...args) {
  const ts = new Date().toISOString();
  if (level === "error") console.error(`[${ts}] [${level.toUpperCase()}]`, ...args);
  else console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

// Optional router auth
function checkRouterAuth(req, res, next) {
  if (!ROUTER_API_KEY) return next();
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const alt = req.headers["x-api-key"];
  if (token === ROUTER_API_KEY || alt === ROUTER_API_KEY) return next();
  return res.status(401).json({
    error: {
      message: "Unauthorized: invalid router API key. Provide Authorization: Bearer <ROUTER_API_KEY>",
      type: "authentication_error",
      code: "invalid_api_key",
    },
  });
}

// Build provider request body - override model to provider's model
function buildProviderBody(originalBody, provider) {
  const body = { ...originalBody };
  // Always override model to the provider's expected model
  body.model = provider.model;
  return body;
}

// Check if error is retryable / should fallback
function shouldFallback(statusCode, errorBody) {
  // Fallback on: 401, 403, 429, 5xx, network errors, timeouts
  // Also fallback on 400 if it's model-related (e.g., model not found)
  // We are conservative: fallback on everything except:
  // - 400 with explicit invalid_request_error that is not model-related
  // For simplicity, fallback on all 4xx/5xx except we log it.
  if (!statusCode) return true; // network error
  if (statusCode === 429) return true;
  if (statusCode >= 500) return true;
  if (statusCode === 401 || statusCode === 403) return true; // auth failure -> try next provider
  if (statusCode === 400 || statusCode === 404 || statusCode === 422) {
    // Many gateways return 400 for model not found, so we fallback
    return true;
  }
  return true;
}

// Core proxy logic for non-streaming
async function proxyWithFallback(originalBody, reqPath, isStream = false) {
  const errors = [];
  const attempted = [];

  for (let i = 0; i < PROVIDERS.length; i++) {
    const provider = PROVIDERS[i];
    attempted.push(provider.id);

    if (!provider.apiKey || provider.apiKey.includes("replace-me") || provider.apiKey.startsWith("demo-")) {
      const msg = `Missing or placeholder API key for ${provider.name} (${provider.id}) - skipping`;
      log("warn", msg);
      errors.push({
        provider: provider.id,
        name: provider.name,
        model: provider.model,
        status: null,
        error: "Missing API key (set " + provider.id.toUpperCase().replace(/-/g, "_") + "_API_KEY in .env)",
        skipped: true,
      });
      continue;
    }

    const providerBody = buildProviderBody(originalBody, provider);
    // Ensure stream flag matches
    if (isStream) providerBody.stream = true;

    const url = `${provider.baseUrl}${reqPath}`;
    log("info", `Attempt ${i + 1}/${PROVIDERS.length}: ${provider.name} (${provider.id}) -> ${url} model=${provider.model} stream=${isStream}`);

    const controller = new AbortController();
    const perProviderTimeout = provider.timeoutMs || REQUEST_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), perProviderTimeout);

    try {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      };

      // Some providers expect slightly different headers; NVIDIA uses same
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(providerBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (resp.ok) {
        log("info", `✓ Success with ${provider.name} (${provider.id}) - status ${resp.status}`);
        return { success: true, provider, response: resp, errors, attempted };
      }

      // Not OK - read error body
      let errorText = "";
      let errorJson = null;
      try {
        errorText = await resp.text();
        try {
          errorJson = JSON.parse(errorText);
        } catch {}
      } catch (e) {
        errorText = `Failed to read error body: ${e.message}`;
      }

      log("warn", `✗ Failed with ${provider.name} (${provider.id}) - status ${resp.status}: ${errorText.slice(0, 500)}`);

      errors.push({
        provider: provider.id,
        name: provider.name,
        model: provider.model,
        status: resp.status,
        error: errorJson || errorText || `HTTP ${resp.status}`,
        url,
      });

      if (!shouldFallback(resp.status, errorJson)) {
        log("warn", `Not falling back after ${provider.id} error ${resp.status}`);
        break;
      }

      // Continue to next provider
      // For rate limits, add tiny backoff
      if (resp.status === 429 && i < PROVIDERS.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
      continue;
    } catch (err) {
      clearTimeout(timeout);
      const isAbort = err.name === "AbortError";
      const msg = isAbort ? `Timeout after ${provider.timeoutMs || REQUEST_TIMEOUT_MS}ms` : err.message;
      log("warn", `✗ Network/timeout error with ${provider.name} (${provider.id}): ${msg}`);
      errors.push({
        provider: provider.id,
        name: provider.name,
        model: provider.model,
        status: null,
        error: msg,
        networkError: true,
        url,
      });
      // network errors always fallback
      continue;
    }
  }

  // All failed
  return { success: false, errors, attempted };
}

// Streaming proxy with fallback (fallback only before streaming starts)
async function proxyStreamWithFallback(originalBody, reqPath, res) {
  const errors = [];

  for (let i = 0; i < PROVIDERS.length; i++) {
    const provider = PROVIDERS[i];

    if (!provider.apiKey || provider.apiKey.includes("replace-me") || provider.apiKey.startsWith("demo-")) {
      errors.push({
        provider: provider.id,
        name: provider.name,
        status: null,
        error: "Missing API key",
        skipped: true,
      });
      continue;
    }

    const providerBody = buildProviderBody(originalBody, provider);
    providerBody.stream = true;
    const url = `${provider.baseUrl}${reqPath}`;

    log("info", `Stream attempt ${i + 1}/${PROVIDERS.length}: ${provider.name} -> ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(providerBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        let errorText = "";
        try {
          errorText = await resp.text();
        } catch {}
        log("warn", `Stream failed ${provider.name}: ${resp.status} ${errorText.slice(0, 300)}`);
        errors.push({
          provider: provider.id,
          name: provider.name,
          model: provider.model,
          status: resp.status,
          error: errorText || `HTTP ${resp.status}`,
        });
        if (!shouldFallback(resp.status)) break;
        continue;
      }

      // Success - pipe the stream with idle timeout protection
      log("info", `✓ Streaming from ${provider.name} (${provider.id})`);

      // Set SSE headers - include model for tracking
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Provider": provider.id,
        "X-Provider-Model": provider.model,
        "X-Provider-Name": provider.name,
        "X-Router-Model": provider.model,
        "Access-Control-Expose-Headers": "X-Provider, X-Provider-Model, X-Provider-Name, X-Router-Model",
      });

      if (!resp.body) {
        throw new Error("No response body for streaming");
      }

      const reader = resp.body.getReader();
      let idleTimeout;
      const resetIdle = () => {
        if (idleTimeout) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => {
          log("warn", `Stream idle timeout (${perProviderTimeout}ms) for ${provider.name} - aborting stream`);
          try { reader.cancel("idle timeout"); } catch {}
          try { if (!res.writableEnded) res.end(); } catch {}
        }, perProviderTimeout);
      };
      resetIdle();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdle();
          if (value) {
            res.write(value);
            if (res.writableEnded) break;
          }
        }
      } finally {
        if (idleTimeout) clearTimeout(idleTimeout);
        try { reader.releaseLock(); } catch {}
      }

      res.end();
      return { success: true, provider };
    } catch (err) {
      clearTimeout(timeout);
      const msg = err.name === "AbortError" ? `Timeout after ${REQUEST_TIMEOUT_MS}ms` : err.message;
      log("warn", `Stream network error ${provider.name}: ${msg}`);
      errors.push({
        provider: provider.id,
        name: provider.name,
        model: provider.model,
        status: null,
        error: msg,
        networkError: true,
      });
      // If we already started sending headers, we can't fallback - send SSE error then close
      if (res.headersSent) {
        log("error", "Headers already sent, cannot fallback mid-stream - sending SSE error");
        try {
          if (!res.writableEnded) {
            // Send OpenAI-compatible SSE error so clients like OpenCode can display it
            const errPayload = JSON.stringify({ error: { message: `Provider ${provider.name} failed mid-stream: ${msg}`, type: "provider_error", code: "stream_failed" } });
            res.write(`data: ${errPayload}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();
          }
        } catch {}
        return { success: false, errors, midStream: true };
      }
      continue;
    }
  }

  return { success: false, errors };
}

// ============ Routes ============

// Health check
app.get("/health", (req, res) => {
  const providerStatus = PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    hasKey: !!(p.apiKey && !p.apiKey.includes("replace-me") && !p.apiKey.startsWith("demo-")),
  }));
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    router: "openai-compatible-llm-router",
    fallbackOrder: PROVIDERS.map((p) => p.id),
    providers: providerStatus,
    config: {
      timeoutMs: REQUEST_TIMEOUT_MS,
      authRequired: !!ROUTER_API_KEY,
    },
  });
});

app.get("/v1/health", (req, res) => res.redirect("/health"));

// Root info
app.get("/", (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenAI-Compatible LLM Router</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color:#1a1a1a; background:#fafafa; }
      h1 { font-size: 28px; margin-bottom: 6px; }
      .badge { display:inline-block; background:#111; color:#fff; padding:4px 10px; border-radius:20px; font-size:12px; letter-spacing:0.5px; }
      .card { background:#fff; border:1px solid #e5e5e5; border-radius:12px; padding:20px; margin:16px 0; }
      .providers { display:grid; gap:12px; }
      .provider { display:flex; align-items:center; gap:12px; padding:12px; border:1px solid #eee; border-radius:10px; background:#fff; }
      .num { width:32px; height:32px; border-radius:50%; background:#111; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; }
      code { background:#f1f1f1; padding:2px 6px; border-radius:4px; font-size:13px; }
      pre { background:#111; color:#f5f5f5; padding:16px; border-radius:10px; overflow:auto; font-size:13px; }
      a { color:#0066cc; text-decoration:none; }
      a:hover { text-decoration:underline; }
      .status { display:inline-block; padding:4px 8px; border-radius:6px; font-size:12px; font-weight:600; }
      .ok { background:#d1fae5; color:#065f46; }
      .err { background:#fee2e2; color:#991b1b; }
    </style>
  </head>
  <body>
    <span class="badge">OPENAI COMPATIBLE &bull; FALLBACK ROUTER</span>
    <h1>🔀 LLM Router is running</h1>
    <p>OpenAI-compatible fallback router. Tries providers in order and auto-routes on failure.</p>

    <div class="card">
      <h3 style="margin-top:0">Fallback Order</h3>
      <div class="providers">
        <div class="provider">
          <div class="num">1</div>
          <div>
            <strong>Kilo Gateway</strong> &mdash; Particle AI: <code>particle-ai/particle-1:free</code><br>
            <small>Base: <code>https://api.kilo.ai/api/gateway</code> &bull; 1M context</small>
          </div>
        </div>
        <div class="provider">
          <div class="num">2</div>
          <div>
            <strong>OpenCode Zen</strong> &mdash; Tidepool Alpha: <code>tidepool-alpha-free</code><br>
            <small>Base: <code>https://opencode.ai/zen/v1</code> &bull; 1M context</small>
          </div>
        </div>
        <div class="provider">
          <div class="num">3</div>
          <div>
            <strong>NVIDIA NIM Build API</strong> &mdash; MiniMax: <code>minimaxai/minimax-m3.1-flash</code><br>
            <small>Base: <code>https://integrate.api.nvidia.com/v1</code> &bull; 40 RPM free tier</small>
          </div>
        </div>
        <div class="provider" style="border-style:dashed; background:#fff7ed; border-color:#fed7aa;">
          <div class="num" style="background:#9a3412;">!</div>
          <div>
            <strong>All failed → Error</strong><br>
            <small>Returns <code>All endpoints were tried and failed</code> with details</small>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Try it</h3>
      <pre>curl http://localhost:${PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $ROUTER_API_KEY" \\
  -d '{
    "model": "router-auto",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</pre>
      <p>
        <a href="/health">→ Health check</a> &nbsp;|&nbsp;
        <a href="/v1/models">→ Models</a> &nbsp;|&nbsp;
        <a href="/docs">→ Docs</a>
      </p>
    </div>

    <div class="card" style="background:#f9fafb;">
      <h3>OpenAI SDK Usage</h3>
      <pre>from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:${PORT}/v1",
    api_key="your-router-key"  # or empty if no ROUTER_API_KEY set
)

resp = client.chat.completions.create(
    model="router-auto",  # model is ignored, routing is automatic
    messages=[{"role": "user", "content": "Write a haiku about routers"}]
)
print(resp.choices[0].message.content)</pre>
    </div>

    <p style="text-align:center; color:#888; font-size:13px; margin-top:30px;">
      Built for Vercel &bull; <a href="https://github.com">GitHub</a> &bull; OpenAI compatible
    </p>
  </body>
  </html>
  `);
});

// Docs page
app.get("/docs", (req, res) => {
  res.json({
    openai_compatible: true,
    base_url: `${req.protocol}://${req.get("host")}/v1`,
    endpoints: {
      "POST /v1/chat/completions": "Main chat completions with fallback (streaming & non-streaming)",
      "POST /v1/completions": "Legacy completions (proxied similarly)",
      "POST /v1/responses": "Responses API passthrough (proxied)",
      "GET /v1/models": "List router models + provider models",
      "GET /health": "Health + provider config status",
      "GET /": "Human-readable status page",
    },
    fallback_order: PROVIDERS.map((p) => ({
      priority: PROVIDERS.indexOf(p) + 1,
      id: p.id,
      name: p.name,
      model: p.model,
      baseUrl: p.baseUrl,
    })),
    error_behavior: "If all 3 providers fail, returns 502 with message 'All endpoints were tried and failed' and per-provider error details",
    sdk_example: {
      python: `from openai import OpenAI\nclient = OpenAI(base_url="http://localhost:${PORT}/v1", api_key="...")\nclient.chat.completions.create(model="router-auto", messages=[{"role":"user","content":"Hi"}])`,
      js: `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "http://localhost:${PORT}/v1", apiKey: "..." });\nawait client.chat.completions.create({ model: "router-auto", messages: [{role:"user", content:"Hi"}] })`,
      curl: `curl http://localhost:${PORT}/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"router-auto","messages":[{"role":"user","content":"Hi"}]}'`,
    },
  });
});

// Models endpoint - OpenAI compatible
app.get("/v1/models", (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    object: "list",
    data: [
      {
        id: "router-auto",
        object: "model",
        created: now,
        owned_by: "router",
        description: "Auto-fallback router (tries all 3 providers in order)",
      },
      ...PROVIDERS.map((p) => ({
        id: p.model,
        object: "model",
        created: now,
        owned_by: p.id,
        provider: p.name,
        baseUrl: p.baseUrl,
      })),
      // Aliases for convenience
      {
        id: "particle-ai/particle-1:free",
        object: "model",
        created: now,
        owned_by: "kilo-gateway",
      },
      {
        id: "tidepool-alpha-free",
        object: "model",
        created: now,
        owned_by: "opencode-zen",
      },
      {
        id: "minimaxai/minimax-m3.1-flash",
        object: "model",
        created: now,
        owned_by: "nvidia-nim",
      },
    ],
  });
});

// Helper to build final error when all failed
function allFailedError(errors, attempted) {
  const details = errors
    .map((e) => {
      if (e.skipped) return `- ${e.provider} (${e.name}): SKIPPED - ${e.error}`;
      return `- ${e.provider} (${e.name} / ${e.model}): ${e.status ? `HTTP ${e.status}` : "NETWORK"} - ${typeof e.error === "string" ? e.error.slice(0, 300) : JSON.stringify(e.error).slice(0, 300)}`;
    })
    .join("\n");

  return {
    error: {
      message: `All endpoints were tried and failed. Attempted ${attempted.length} provider(s) in order: ${attempted.join(" → ")}. No successful response from any provider.`,
      type: "all_endpoints_failed",
      code: "all_endpoints_failed",
      attempted_providers: attempted,
      details: errors,
      hint: "Check your API keys in .env, provider rate limits, and network connectivity. See /health for provider config status.",
      human_readable: `Fallback chain exhausted:\n${details}`,
    },
  };
}

// Main chat completions endpoint
app.post("/v1/chat/completions", checkRouterAuth, async (req, res) => {
  const body = req.body;

  if (!body || !body.messages) {
    return res.status(400).json({
      error: {
        message: "Invalid request: 'messages' is required",
        type: "invalid_request_error",
        param: "messages",
        code: "missing_messages",
      },
    });
  }

  const isStream = body.stream === true;

  if (isStream) {
    // Streaming path - handle fallback before streaming starts
    const result = await proxyStreamWithFallback(body, "/chat/completions", res);
    if (!result.success) {
      if (res.headersSent) {
        log("error", "Stream failed mid-way, headers already sent");
        return; // can't send JSON error now
      }
      log("error", "All stream providers failed");
      return res.status(502).json(allFailedError(result.errors, PROVIDERS.map((p) => p.id)));
    }
    // response already piped and ended inside proxyStreamWithFallback
    return;
  }

  // Non-streaming path
  const result = await proxyWithFallback(body, "/chat/completions", false);

  if (result.success) {
    // Forward successful response
    try {
      const data = await result.response.json();
      // Annotate response with exact model used for tracking (preserves OpenAI compat)
      // - 'model' is overridden to the real provider model that answered
      // - 'router_model' / 'router_provider' are explicit tracking fields
      data.model = result.provider.model;
      data.router_model = result.provider.model;
      data.router_provider = result.provider.id;
      data.router_provider_name = result.provider.name;
      // Add router metadata headers
      res.set({
        "X-Provider": result.provider.id,
        "X-Provider-Model": result.provider.model,
        "X-Provider-Name": result.provider.name,
        "Access-Control-Expose-Headers": "X-Provider, X-Provider-Model, X-Provider-Name, X-Router-Model",
      });
      return res.status(result.response.status).json(data);
    } catch (e) {
      // If JSON parse fails, try text
      const text = await result.response.text().catch(() => "");
      res.set({
        "X-Provider": result.provider.id,
        "X-Provider-Model": result.provider.model,
        "X-Provider-Name": result.provider.name,
      });
      return res.status(result.response.status).send(text);
    }
  } else {
    log("error", "All providers failed for /v1/chat/completions");
    return res.status(502).json(allFailedError(result.errors, result.attempted));
  }
});

// Legacy completions endpoint (similar fallback)
app.post("/v1/completions", checkRouterAuth, async (req, res) => {
  const body = req.body;
  const isStream = body.stream === true;

  if (isStream) {
    const result = await proxyStreamWithFallback(body, "/completions", res);
    if (!result.success) {
      if (res.headersSent) return;
      return res.status(502).json(allFailedError(result.errors, PROVIDERS.map((p) => p.id)));
    }
    return;
  }

  const result = await proxyWithFallback(body, "/completions", false);
  if (result.success) {
    try {
      const data = await result.response.json();
      data.model = result.provider.model;
      data.router_model = result.provider.model;
      data.router_provider = result.provider.id;
      res.set({
        "X-Provider": result.provider.id,
        "X-Provider-Model": result.provider.model,
        "X-Provider-Name": result.provider.name,
      });
      return res.status(result.response.status).json(data);
    } catch {
      const text = await result.response.text().catch(() => "");
      return res.status(result.response.status).send(text);
    }
  } else {
    return res.status(502).json(allFailedError(result.errors, result.attempted));
  }
});

// Responses API passthrough (for newer OpenAI clients)
app.post("/v1/responses", checkRouterAuth, async (req, res) => {
  const body = req.body;
  const isStream = body.stream === true;
  if (isStream) {
    const result = await proxyStreamWithFallback(body, "/responses", res);
    if (!result.success) {
      if (res.headersSent) return;
      return res.status(502).json(allFailedError(result.errors, PROVIDERS.map((p) => p.id)));
    }
    return;
  }
  const result = await proxyWithFallback(body, "/responses", false);
  if (result.success) {
    try {
      const data = await result.response.json();
      if (data.model) data.model = result.provider.model;
      data.router_model = result.provider.model;
      data.router_provider = result.provider.id;
      res.set({
        "X-Provider": result.provider.id,
        "X-Provider-Model": result.provider.model,
        "X-Provider-Name": result.provider.name,
      });
      return res.status(result.response.status).json(data);
    } catch {
      const text = await result.response.text().catch(() => "");
      return res.status(result.response.status).send(text);
    }
  } else {
    return res.status(502).json(allFailedError(result.errors, result.attempted));
  }
});

// Embeddings passthrough (if any provider supports it, otherwise will fallback and error)
app.post("/v1/embeddings", checkRouterAuth, async (req, res) => {
  const result = await proxyWithFallback(req.body, "/embeddings", false);
  if (result.success) {
    const data = await result.response.json().catch(async () => ({ text: await result.response.text() }));
    data.model = result.provider.model;
    data.router_model = result.provider.model;
    data.router_provider = result.provider.id;
    res.set({
      "X-Provider": result.provider.id,
      "X-Provider-Model": result.provider.model,
      "X-Provider-Name": result.provider.name,
    });
    return res.status(result.response.status).json(data);
  } else {
    return res.status(502).json(allFailedError(result.errors, result.attempted));
  }
});

// Catch-all for unknown /v1 routes
app.all("/v1/:splat*", (req, res) => {
  res.status(404).json({
    error: {
      message: `Unknown endpoint: ${req.method} ${req.path}. Available: POST /v1/chat/completions, POST /v1/completions, GET /v1/models, GET /health`,
      type: "invalid_request_error",
      code: "unknown_endpoint",
    },
  });
});

// Global error handler
app.use((err, req, res, next) => {
  log("error", "Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    error: {
      message: err.message || "Internal router error",
      type: "internal_error",
      code: "router_internal_error",
    },
  });
});

// Export for Vercel serverless
export default app;

// Start server only when run directly (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  🔀 OpenAI-Compatible LLM Router                          ║
║  Listening on http://${HOST}:${PORT}                          ║
╠════════════════════════════════════════════════════════════╣
║  Fallback order:                                         ║
║   1. Kilo Gateway      → ${PROVIDERS[0].model.padEnd(30)} ║
║   2. OpenCode Zen      → ${PROVIDERS[1].model.padEnd(30)} ║
║   3. NVIDIA NIM        → ${PROVIDERS[2].model.padEnd(30)} ║
║   4. → Error: All endpoints were tried and failed        ║
╠════════════════════════════════════════════════════════════╣
║  Endpoints:                                              ║
║   POST /v1/chat/completions  (stream + non-stream)        ║
║   POST /v1/completions                                    ║
║   POST /v1/responses                                     ║
║   GET  /v1/models                                         ║
║   GET  /health  &  GET  /                                   ║
╠════════════════════════════════════════════════════════════╣
║  Config:                                                 ║
║   Timeout: ${String(REQUEST_TIMEOUT_MS).padEnd(6)}ms  Auth: ${ROUTER_API_KEY ? "enabled (ROUTER_API_KEY set)" : "disabled (open)"}        ║
║   Kilo key:    ${PROVIDERS[0].apiKey && !PROVIDERS[0].apiKey.includes("replace-me") ? "✓ set" : "✗ missing - set KILO_API_KEY"}          ║
║   OpenCode key:${PROVIDERS[1].apiKey && !PROVIDERS[1].apiKey.includes("replace-me") ? "✓ set" : "✗ missing - set OPENCODE_API_KEY"}          ║
║   NVIDIA key:  ${PROVIDERS[2].apiKey && !PROVIDERS[2].apiKey.includes("replace-me") ? "✓ set" : "✗ missing - set NVIDIA_API_KEY"}          ║
╚════════════════════════════════════════════════════════════╝
  `);
  PROVIDERS.forEach((p) => {
    console.log(`  [${p.id}] ${p.baseUrl}  model=${p.model}  key=${p.apiKey ? p.apiKey.slice(0, 8) + "..." : "MISSING"}`);
  });
  console.log("");
  });
}
