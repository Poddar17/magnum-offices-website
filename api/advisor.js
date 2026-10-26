// Vercel Serverless Function: POST /api/advisor
// Requires environment variable ANTHROPIC_API_KEY (set in Vercel > Project > Settings > Environment Variables).

const MODEL = process.env.ADVISOR_MODEL || "claude-haiku-4-5";

const SYSTEM_PROMPT =
  "You are the AI advisor embedded on the Magnum Offices website, a commercial real estate leasing and advisory company by Galaxy Magnum Group, developer-led, serving Gurugram/NCR. " +
  "Our services: (1) Commercial Leasing & Advisory - strategic leasing support for landlords, including asset positioning, tenant identification, rental benchmarking and transaction coordination; " +
  "(2) Occupier Solutions - advisory for businesses seeking commercial space, covering location evaluation, property selection and lease negotiation; " +
  "(3) Asset & Portfolio Services - strategic asset analysis and portfolio advisory to optimise positioning, strengthen leasing performance and maximise long-term value; " +
  "(4) Investment Advisory - advisory and transaction support for commercial real estate opportunities, including preliminary evaluation, sourcing and transaction coordination. " +
  "Contact: hello@magnumoffices.com, Magnum Global Park, Sector 58, Golf Course Extension Road, Gurugram. " +
  "Answer visitor questions about commercial real estate, leasing, or Magnum Offices' services in a professional, measured tone, in 2-4 sentences. " +
  "Avoid exaggerated claims or guarantees. If asked something unrelated to commercial real estate or the company, politely redirect to what you can help with. " +
  "If the person wants to talk to a person, point them to the contact section. Do not share any phone numbers.";

const ALLOWED_ORIGINS = [
  "https://www.magnumoffices.com",
  "https://magnumoffices.com",
];

// Basic per-IP rate limit (best effort; resets when the function instance recycles).
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REQUESTS = 20;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > MAX_REQUESTS;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  const isPreview = /\.vercel\.app$/.test(origin.replace(/^https?:\/\//, ""));
  if (origin && (ALLOWED_ORIGINS.includes(origin) || isPreview)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "not_configured" });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate_limited" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const raw = Array.isArray(body && body.messages) ? body.messages : [];

  // Sanitise: keep last 10 turns, valid roles only, cap length, must end with a user turn.
  const messages = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }))
    .slice(-10);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "bad_request" });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Anthropic API error", r.status, data);
      return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? "rate_limited" : "upstream_error" });
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return res.status(200).json({ text });
  } catch (err) {
    console.error("Advisor error", err);
    return res.status(500).json({ error: "server_error" });
  }
};
