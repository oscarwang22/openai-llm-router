# OpenAI-Compatible LLM Router with Fallback

An OpenAI-compatible proxy that automatically routes requests through multiple inference providers with **fallback**:

1. **Kilo Gateway** → `particle-ai/particle-1:free` *(Particle AI Particle-1 Free, 1M context)*
2. **OpenCode Zen** → `tidepool-alpha-free` *(Tidepool Alpha Free, 1M context)*
3. **NVIDIA NIM Build API** → `minimaxai/minimax-m3.1-flash` *(MiniMax M3.1 Flash, 262K context, 40 RPM free tier)*
4. **→ Error** → `All endpoints were tried and failed` (with per-provider diagnostics)

Drop-in compatible with any OpenAI SDK, CLI, or agent — just change `base_url` / `base_url` to your router.

---

## 🚀 Quick Start

```bash
git clone <this-repo>
cd openai-llm-router
npm install
cp .env.example .env
# Edit .env and set your 3 API keys:
#   KILO_API_KEY, OPENCODE_API_KEY, NVIDIA_API_KEY
npm start
# Router listening on http://localhost:3000
```

### Get API keys (all have free tiers)

| Provider | Where to get key | Base URL | Model |
|---|---|---|---|
| **Kilo Gateway** | https://kilo.ai → Dashboard → API Keys | `https://api.kilo.ai/api/gateway` | `particle-ai/particle-1:free` |
| **OpenCode Zen** | https://opencode.ai → Console → Zen | `https://opencode.ai/zen/v1` | `tidepool-alpha-free` |
| **NVIDIA NIM** | https://build.nvidia.com/minimaxai/minimax-m3.1-flash → Generate Key | `https://integrate.api.nvidia.com/v1` | `minimaxai/minimax-m3.1-flash` |

All three are free for evaluation (Kilo & OpenCode: limited free quota, NVIDIA: 40 RPM).

---

## 🔌 Usage

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="not-needed"  # or your ROUTER_API_KEY if set
)

# Non-streaming
resp = client.chat.completions.create(
    model="router-auto",  # model is ignored — routing is automatic
    messages=[{"role": "user", "content": "Explain KV caching in two sentences"}],
    temperature=0.7,
)
print(resp.choices[0].message.content)
print(f"Provider: {resp.headers.get('x-provider')}")  # kilo-gateway / opencode-zen / nvidia-nim

# Streaming
stream = client.chat.completions.create(
    model="router-auto",
    messages=[{"role": "user", "content": "Write a haiku about fallback routing"}],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### Node.js / TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: process.env.ROUTER_API_KEY || "sk-router-dummy",
});

const res = await client.chat.completions.create({
  model: "router-auto",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(res.choices[0].message.content);
```

### cURL

```bash
# Health check
curl http://localhost:3000/health | jq .

# Chat completion (non-stream)
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "router-auto",
    "messages": [{"role": "user", "content": "Hello!"}]
  }' | jq .

# Streaming
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "router-auto",
    "messages": [{"role": "user", "content": "Count to 5"}],
    "stream": true
  }'

# With router auth (if ROUTER_API_KEY set)
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -d '{"model":"router-auto","messages":[{"role":"user","content":"Hi"}]}'
```

### Use with Agents / CLIs

Point any OpenAI-compatible tool at the router:

```bash
# Claude Code, Codex, Cursor, Continue, Cline, etc.
# Set in their config:
# baseUrl: http://localhost:3000/v1
# apiKey: your ROUTER_API_KEY
# model: router-auto
```

---

## 📡 Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/chat/completions` | POST | **Main** — Chat completions with full fallback + streaming support |
| `/v1/completions` | POST | Legacy completions (same fallback) |
| `/v1/responses` | POST | Responses API passthrough |
| `/v1/embeddings` | POST | Embeddings passthrough |
| `/v1/models` | GET | List `router-auto` + per-provider model IDs |
| `/health` & `/v1/health` | GET | Health + provider key status + config |
| `/` | GET | Human-readable status page |
| `/docs` | GET | JSON API docs |

All endpoints return OpenAI-compatible JSON. Successful responses include headers:
- `X-Provider: kilo-gateway | opencode-zen | nvidia-nim`
- `X-Provider-Model: <model-id>`
- `X-Provider-Name: <human name>`

### Error when all providers fail

```json
{
  "error": {
    "message": "All endpoints were tried and failed. Attempted 3 provider(s) in order: kilo-gateway → opencode-zen → nvidia-nim. No successful response from any provider.",
    "type": "all_endpoints_failed",
    "code": "all_endpoints_failed",
    "attempted_providers": ["kilo-gateway", "opencode-zen", "nvidia-nim"],
    "details": [
      { "provider": "kilo-gateway", "status": 429, "error": "Rate limit exceeded..." },
      { "provider": "opencode-zen", "status": 503, "error": "..." },
      { "provider": "nvidia-nim", "status": 401, "error": "..." }
    ],
    "hint": "Check your API keys in .env, provider rate limits, and network connectivity. See /health for provider config status.",
    "human_readable": "Fallback chain exhausted:\n- kilo-gateway ...\n- opencode-zen ...\n- nvidia-nim ..."
  }
}
```
HTTP status: `502 Bad Gateway`

---

## ⚙️ Configuration

All via environment variables (`.env`):

```bash
# Router
PORT=3000
HOST=0.0.0.0
ROUTER_API_KEY=               # optional: protect router with Bearer auth
REQUEST_TIMEOUT_MS=60000      # per-provider timeout

# Kilo Gateway
KILO_API_KEY=...
KILO_BASE_URL=https://api.kilo.ai/api/gateway
KILO_MODEL=particle-ai/particle-1:free

# OpenCode Zen
OPENCODE_API_KEY=...
OPENCODE_BASE_URL=https://opencode.ai/zen/v1
OPENCODE_MODEL=tidepool-alpha-free

# NVIDIA NIM
NVIDIA_API_KEY=...
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=minimaxai/minimax-m3.1-flash
```

**Note on Kilo model IDs:** Depending on your Kilo account, you may need:
- `particle-ai/particle-1:free` (recommended)
- `kilo/particle-ai/particle-1:free`
Check https://kilo.ai dashboard for the exact ID.

---

## 🔄 How Fallback Works

```
Incoming request → Try Kilo Gateway
                    ├─ 2xx → return immediately ✓
                    └─ fail (429, 5xx, 401, timeout, network) → Try OpenCode Zen
                                                             ├─ 2xx → return ✓
                                                             └─ fail → Try NVIDIA NIM
                                                                       ├─ 2xx → return ✓
                                                                       └─ fail → 502 Error: All endpoints were tried and failed
```

- **Non-streaming:** Each provider is tried sequentially with full request body (model overridden to provider's model). Timeout per provider: `REQUEST_TIMEOUT_MS`.
- **Streaming:** Same sequential try, but only *before* streaming starts. Once a provider returns a valid SSE stream, it is piped directly. If mid-stream fails, headers are already sent so error is logged.
- **Fallback triggers:** `429 Rate Limit`, `5xx Server Error`, `401/403 Auth`, `400/404 Model Not Found`, network errors, timeouts.
- **Rate-limit backoff:** 500ms pause before next provider on 429.

---

## ☁️ Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

Or via CLI:

```bash
npm i -g vercel
vercel --prod
# Set env vars in Vercel dashboard:
# KILO_API_KEY, OPENCODE_API_KEY, NVIDIA_API_KEY
# (KILO_BASE_URL etc. have defaults, no need to set)
```

`vercel.json` is already included. The router works as a serverless function (cold starts ~100ms).

### Deploy to other platforms

- **Docker:** `docker build -t llm-router . && docker run -p 3000:3000 --env-file .env llm-router`
- **Fly.io / Render / Railway:** `npm start` with `PORT` env var

---

## 🧪 Testing Locally Without Real Keys

The router will log `✗ missing` for providers without valid keys and skip them. To test the fallback logic without real keys, set dummy keys and watch logs:

```bash
# Simulate all failing
KILO_API_KEY=invalid-test-key
OPENCODE_API_KEY=invalid-test-key
NVIDIA_API_KEY=invalid-test-key

curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"router-auto","messages":[{"role":"user","content":"Hi"}]}'
# → 502 { error: { message: "All endpoints were tried and failed..." } }
```

---

## 📂 Project Structure

```
openai-llm-router/
├── src/
│   └── server.js          # Express router with fallback logic
├── .env.example           # Template for required env vars
├── .env                   # Your local config (gitignored)
├── package.json
├── vercel.json            # Vercel deployment config
└── README.md
```

---

## 🔒 Security Notes

- Never commit `.env` with real keys. `.env` is gitignored by default.
- Set `ROUTER_API_KEY` to protect your deployed router — clients must send `Authorization: Bearer <ROUTER_API_KEY>`.
- Provider keys are never exposed to clients; only `X-Provider` headers are.
- For production, set keys via platform env vars (Vercel Dashboard, etc.), not files.

---

## 📝 License

MIT — Use freely. Provider terms apply to each upstream (Kilo, OpenCode, NVIDIA).

---

## 🙏 Acknowledgments

- [Kilo Gateway](https://kilo.ai) — unified API for Particle AI Particle-1
- [OpenCode Zen](https://opencode.ai) — Tidepool Alpha free
- [NVIDIA NIM Build](https://build.nvidia.com) — MiniMax M3.1 Flash hosting
