#!/usr/bin/env node
// Simple test script to verify router fallback behavior
// Works against local router or deployed URL
// Usage: ROUTER_URL=http://localhost:3000 node src/test.js

const BASE = process.env.ROUTER_URL || "http://localhost:3000";
const ROUTER_KEY = process.env.ROUTER_API_KEY || "";

async function test(path, body, label) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🧪 ${label}`);
  console.log(`→ POST ${BASE}${path}`);
  const headers = { "Content-Type": "application/json" };
  if (ROUTER_KEY) headers["Authorization"] = `Bearer ${ROUTER_KEY}`;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const xProvider = res.headers.get("x-provider") || "-";
    const xModel = res.headers.get("x-provider-model") || "-";
    console.log(`← ${res.status} ${res.statusText} | X-Provider: ${xProvider} | X-Model: ${xModel}`);
    const data = await res.json().catch(async () => ({ raw: await res.text() }));
    console.log(JSON.stringify(data, null, 2).slice(0, 2000));
    if (data.error && data.error.message?.includes("All endpoints were tried and failed")) {
      console.log("✅ Correctly returned 'All endpoints were tried and failed' error");
    } else if (res.ok) {
      console.log(`✅ Success via ${xProvider}`);
    }
    return data;
  } catch (e) {
    console.error(`❌ Fetch error: ${e.message}`);
  }
}

async function testHealth() {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏥 Health Check`);
  try {
    const res = await fetch(`${BASE}/health`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Health failed: ${e.message}`);
  }
}

async function testModels() {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📦 Models`);
  try {
    const headers = {};
    if (ROUTER_KEY) headers["Authorization"] = `Bearer ${ROUTER_KEY}`;
    const res = await fetch(`${BASE}/v1/models`, { headers });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Models failed: ${e.message}`);
  }
}

(async () => {
  console.log(`🔀 Testing LLM Router at ${BASE}`);
  await testHealth();
  await testModels();
  await test(
    "/v1/chat/completions",
    {
      model: "router-auto",
      messages: [{ role: "user", content: "Say 'hello router' and nothing else." }],
      max_tokens: 50,
      temperature: 0,
    },
    "Chat Completion (non-stream)"
  );
  // Streaming test via raw fetch
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🌊 Streaming Test`);
  try {
    const headers = { "Content-Type": "application/json" };
    if (ROUTER_KEY) headers["Authorization"] = `Bearer ${ROUTER_KEY}`;
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "router-auto",
        messages: [{ role: "user", content: "Count to 3 slowly." }],
        stream: true,
        max_tokens: 50,
      }),
    });
    console.log(`← ${res.status} Streaming...`);
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let chunks = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        process.stdout.write(text.slice(0, 200));
        chunks++;
        if (chunks > 20) break;
      }
      console.log(`\n✅ Streaming chunks received: ${chunks}`);
    } else {
      const data = await res.json().catch(() => ({}));
      console.log(JSON.stringify(data, null, 2).slice(0, 1000));
    }
  } catch (e) {
    console.error(`Stream error: ${e.message}`);
  }

  console.log(`\n✨ Done`);
})();
