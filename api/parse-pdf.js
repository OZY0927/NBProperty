// ✅ Free Google Gemini API — native PDF support, no pdf-parse needed
// Get your free API key at: https://aistudio.google.com/app/apikey

export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
};

const GEMINI_MODEL = "gemini-3-flash-preview";

function normalizeResponse(data) {
  // Unwrap { value, confidence } wrappers — keep confidence in _confidence map
  const normalized = {};
  const confidenceMetadata = {};
  for (const [key, field] of Object.entries(data)) {
    if (field && typeof field === "object" && "value" in field) {
      normalized[key] = field.value;
      confidenceMetadata[key] = field.confidence ?? 0;
    } else {
      normalized[key] = field;
      confidenceMetadata[key] = 100;
    }
  }
  return { ...normalized, _confidence: confidenceMetadata };
}

function safeJSONParse(text) {
  try {
    return JSON.parse(text.replace(/```json\s*|```\s*/g, "").trim());
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch {} }
    return null;
  }
}

// ⚠️  Field keys MUST match the PropertyForm's EMPTY_FORM keys exactly
// so applyResult() can map them without translation.
const PROMPT = `You are an expert AI data extraction engine for Malaysian real estate project brochures and factsheets.

Carefully read the ENTIRE PDF document and extract every piece of property information you can find.

Return ONLY a single valid JSON object — no markdown fences, no preamble, no explanation.

IMPORTANT: Use EXACTLY these field names (they must match the property listing form):

{
  "name":                  { "value": "Full project name", "confidence": 90 },
  "developer":             { "value": "Developer / Pemaju name", "confidence": 90 },
  "location":              { "value": "Full address or area, city, state", "confidence": 88 },
  "type":                  { "value": "One of: Condominium | Serviced Apartment | Semi-Detached | Terrace House | Bungalow | Shophouse | SoHo / Office | Duplex", "confidence": 88 },
  "status":                { "value": "One of: New Launch | Under Construction | Completed | Sold Out", "confidence": 85 },
  "completion":            { "value": "e.g. Q4 2027 or December 2026", "confidence": 80 },
  "tenure":                { "value": "One of: Freehold | Leasehold | 999-year Leasehold", "confidence": 88 },
  "tag":                   { "value": "Short badge e.g. HOT | NEW LAUNCH | EXCLUSIVE | SELLING FAST", "confidence": 70 },
  "landSize":              { "value": "e.g. 3.2 acres or 1.8 hectares", "confidence": 78 },
  "constructionStage":     { "value": "e.g. Piling & Foundation | Level 15 Structural | Superstructure", "confidence": 75 },
  "totalBlocks":           { "value": "numeric string e.g. 2", "confidence": 80 },
  "floors":                { "value": "numeric string e.g. 38", "confidence": 80 },
  "totalFloorsPerTower":   { "value": ["Tower A: 38 floors", "Tower B: 36 floors"], "confidence": 78 },
  "totalUnits":            { "value": "numeric string e.g. 320", "confidence": 85 },
  "residentialStartLevel": { "value": "e.g. Level 5", "confidence": 72 },
  "unitsBreakdown":        { "value": "e.g. 280 Public / 40 Bumi", "confidence": 72 },
  "unitsPerTower":         { "value": "e.g. Tower A: 168 units | Tower B: 152 units", "confidence": 70 },
  "bedrooms":              { "value": "comma-separated numbers e.g. 2, 3, 4", "confidence": 85 },
  "bathrooms":             { "value": "comma-separated numbers e.g. 2, 3", "confidence": 82 },
  "sizeSqft":              { "value": "range as two numbers e.g. 900-2200", "confidence": 82 },
  "carParkLevels":         { "value": "e.g. Level 1–4 (Podium)", "confidence": 75 },
  "numberOfCarParks":      { "value": "e.g. 480 bays (1.5 per unit)", "confidence": 78 },
  "parkingNotes":          { "value": "Any parking-related notes", "confidence": 68 },
  "numberOfLifts":         { "value": "e.g. 4 lifts per tower (3 passenger + 1 service)", "confidence": 75 },
  "priceFrom":             { "value": "numeric only, no RM symbol e.g. 480000", "confidence": 85 },
  "priceTo":               { "value": "numeric only, no RM symbol e.g. 1200000", "confidence": 85 },
  "maintenanceFee":        { "value": "e.g. RM 0.35 / sf / month", "confidence": 75 },
  "sinkingFund":           { "value": "e.g. RM 0.10 / sf / month", "confidence": 72 },
  "showroom":              { "value": "Full showroom address and hours", "confidence": 70 },
  "scaleModel":            { "value": "Yes / No and any notes", "confidence": 65 },
  "image":                 { "value": "Main project image URL if found", "confidence": 50 },
  "description":           { "value": "2–4 sentence project overview", "confidence": 85 },
  "highlights":            { "value": "comma-separated list e.g. Smart Home System, Sky Pool, 24-Hour Security", "confidence": 80 },
  "facilities":            { "value": "comma-separated list e.g. Olympic Pool, Gymnasium, Sky Lounge", "confidence": 80 },
  "upgrades":              { "value": "Interior finishes, appliance brands, premium inclusions", "confidence": 72 },
  "nearbyAmenities":       { "value": [{"category":"Education","items":["School A (500m)"]},{"category":"Healthcare","items":["Hospital B (2km)"]}], "confidence": 70 },
  "unitTypes":             { "value": [
    { "label": "Type A", "name": "2-Bedroom", "beds": 2, "baths": 2, "size": "900 sf", "priceFrom": "From RM 480,000", "desc": "Brief unit description", "image": "" }
  ], "confidence": 78 },
  "coordinateLat":         { "value": "decimal latitude if found e.g. 5.3636", "confidence": 40 },
  "coordinateLng":         { "value": "decimal longitude if found e.g. 100.4565", "confidence": 40 }
}

Critical rules:
- Field keys MUST match exactly as shown above (camelCase, no changes).
- Use null for value if a field cannot be found — never invent data.
- priceFrom and priceTo must be plain numbers (no RM, no commas) — convert RM 480,000 → 480000.
- bedrooms and bathrooms: comma-separated bedroom count options e.g. "2, 3, 4".
- sizeSqft: two numbers joined by a dash e.g. "900-2200" (no "sq ft" text).
- highlights and facilities: comma-separated strings (not arrays).
- totalFloorsPerTower: array of strings.
- nearbyAmenities: array of {category, items[]} objects.
- unitTypes value must be an array of unit objects with label, name, beds, baths, size, priceFrom, desc, image.
- Confidence 0–100: 90+ = explicitly stated, 70–89 = clearly visible, 50–69 = inferred, <50 = guessed.`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

  try {
    const { base64Data } = req.body;
    if (!base64Data || typeof base64Data !== "string")
      return res.status(400).json({ error: "Missing base64Data" });
    if (base64Data.length > 9 * 1024 * 1024)
      return res.status(413).json({ error: "File too large (max ~9MB base64)" });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let geminiRes;
    try {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: "application/pdf", data: base64Data } },
                { text: PROMPT },
              ],
            }],
            generationConfig: { temperature: 0.05, maxOutputTokens: 4096 },
          }),
          signal: controller.signal,
        }
      );
    } catch (err) {
      if (err.name === "AbortError") return res.status(504).json({ error: "Timed out after 30s" });
      return res.status(502).json({ error: "Failed to reach Gemini API", message: err.message });
    } finally {
      clearTimeout(timeout);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => "");
      return res.status(502).json({ error: "Gemini API returned an error", status: geminiRes.status, details: errText });
    }

    const result = await geminiRes.json();
    const rawText = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!rawText) return res.status(500).json({ error: "Gemini returned empty response" });

    const parsed = safeJSONParse(rawText);
    if (!parsed) return res.status(500).json({ error: "Gemini returned invalid JSON", preview: rawText.slice(0, 500) });

    return res.status(200).json(normalizeResponse(parsed));
  } catch (err) {
    console.error("Unhandled error:", err);
    return res.status(500).json({ error: "Internal server error", message: err.message });
  }
}