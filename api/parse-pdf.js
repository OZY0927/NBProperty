/**
 * /api/parse-pdf.js — Vercel Serverless Function
 *
 * Receives raw PDF text extracted client-side by PDF.js,
 * sends it to Claude Sonnet, and returns structured property JSON.
 *
 * Setup:
 *   1. In Vercel dashboard → Settings → Environment Variables
 *   2. Add:  ANTHROPIC_API_KEY = sk-ant-...
 *   3. Redeploy — done.
 *
 * The API key never reaches the browser. All Claude calls happen server-side.
 */

export default async function handler(req, res) {
  /* ── CORS preflight ── */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  /* ── Validate input ── */
  const { text } = req.body || {};
  if (!text || typeof text !== "string" || text.trim().length < 20) {
    return res.status(400).json({ error: "No usable text provided." });
  }

  /* ── Check API key ── */
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not set. Add it in Vercel → Settings → Environment Variables.",
    });
  }

  /* ── Build prompt ── */
  // Limit text to ~12 000 chars to stay within token budget
  const brochureText = text.substring(0, 12000);

  const prompt = `You are an expert property brochure data extractor for Malaysian real estate.
Extract all property information from the brochure text below and return ONLY a valid JSON object.
No markdown fences, no preamble, no explanation — just the raw JSON.

Return this exact schema (use null for any field you cannot confidently determine):

{
  "name": string,
  "developer": string,
  "location": string,
  "type": one of ["Condominium","Semi-Detached","Serviced Apartment","Shophouse","Terrace House","SoHo / Office","Bungalow","Duplex"] or null,
  "status": one of ["New Launch","Under Construction","Completed","Sold Out"] or null,
  "completion": string (e.g. "Q4 2026"),
  "tenure": one of ["Freehold","Leasehold"] or null,
  "landSize": string (e.g. "3.2 acres"),
  "constructionStage": string (e.g. "Piling & Foundation"),
  "totalBlocks": number or null,
  "floors": number or null,
  "totalUnits": number or null,
  "residentialStartLevel": string (e.g. "Level 5"),
  "unitsBreakdown": string (e.g. "280 Public / 40 Bumi"),
  "unitsPerTower": string (e.g. "Tower A: 168 units | Tower B: 152 units"),
  "bedrooms": string (comma-separated bedroom counts, e.g. "2, 3, 4"),
  "bathrooms": string (comma-separated bathroom counts, e.g. "2, 3"),
  "sizeSqft": string (min-max range e.g. "900-2200"),
  "carParkLevels": string (e.g. "Level 1-4"),
  "numberOfCarParks": string (e.g. "480 bays (1.5 per unit)"),
  "parkingNotes": string,
  "numberOfLifts": string (e.g. "4 lifts per tower (3 passenger + 1 service)"),
  "priceFrom": number or null (raw RM integer, e.g. 480000),
  "priceTo": number or null (raw RM integer),
  "maintenanceFee": string (e.g. "RM 0.35 / sf / month"),
  "sinkingFund": string (e.g. "RM 0.10 / sf / month"),
  "showroom": string (location + hours),
  "scaleModel": string (e.g. "Yes — displayed at showroom"),
  "description": string (2-4 sentence marketing summary in English),
  "highlights": string (comma-separated key selling points, max 8),
  "facilities": string (comma-separated facility names),
  "upgrades": string (premium finishes / inclusions description),
  "totalFloorsPerTower": array of strings (e.g. ["Tower A: 38 floors", "Tower B: 36 floors"]),
  "unitTypes": array of objects with this shape:
    {
      "label": string (e.g. "Type A"),
      "name": string (e.g. "2-Bedroom" or "Studio Suite"),
      "beds": number,
      "baths": number,
      "size": string (e.g. "900 sf"),
      "priceFrom": string (e.g. "From RM 480,000"),
      "image": "",
      "desc": string (1-2 sentence unit description)
    }
}

Rules:
- Return ONLY the JSON — no extra text before or after.
- For price fields (priceFrom, priceTo), use plain integers only (e.g. 480000, not "RM 480,000").
- If a field is not found in the text, use null — never guess or invent values.
- Extract as many unitTypes as possible from layout tables or unit-type sections.
- Write description and unit desc fields in fluent marketing English even if source is another language.
- For highlights and facilities, only include values actually mentioned in the brochure.

BROCHURE TEXT:
${brochureText}`;

  /* ── Call Claude ── */
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const msg = errBody?.error?.message || `Claude API returned ${response.status}`;
      return res.status(502).json({ error: msg });
    }

    const data = await response.json();
    const rawOutput = (data.content || []).map(b => b.text || "").join("");

    /* Strip markdown fences if Claude wrapped the JSON anyway */
    const clean = rawOutput
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      console.error("Claude JSON parse error. Raw output:", rawOutput.slice(0, 500));
      return res.status(502).json({
        error: "Claude returned malformed JSON. Please try again.",
      });
    }

    /* Remove null / empty values so the form patch is clean */
    for (const k of Object.keys(parsed)) {
      if (parsed[k] === null || parsed[k] === undefined || parsed[k] === "") {
        delete parsed[k];
      }
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("parse-pdf handler error:", err);
    return res.status(500).json({ error: err.message || "Internal server error." });
  }
}
