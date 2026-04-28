// Vercel Serverless Function — POST /api/parse-pdf
// Uses Google Gemini 2.0 Flash (free tier: 15 RPM / 1500 RPD)
// Set GEMINI_API_KEY in Vercel Environment Variables

const GEMINI_MODEL = "gemini-2.0-flash";

const SYSTEM_PROMPT = `You are a property data extraction specialist. Extract all available property details from the uploaded PDF brochure and return ONLY a valid JSON object — no markdown, no explanation, no extra text.

Return this exact JSON structure (use null for fields not found):
{
  "name": "Full project name",
  "developer": "Developer company name",
  "location": "Full address or area, state",
  "type": "One of: Condominium, Semi-Detached, Serviced Apartment, Shophouse, Terrace House, SoHo / Office, Bungalow, Duplex",
  "status": "One of: New Launch, Under Construction, Completed, Sold Out",
  "completion": "e.g. Q4 2026",
  "tenure": "Freehold or Leasehold",
  "landSize": "e.g. 3.2 acres",
  "constructionStage": "Current construction stage description",
  "totalBlocks": 2,
  "totalFloorsPerTower": ["Tower A: 38 floors", "Tower B: 36 floors"],
  "residentialStartLevel": "e.g. Level 5",
  "totalUnits": 320,
  "floors": 38,
  "unitsBreakdown": "e.g. 280 Public / 40 Bumi",
  "unitsPerTower": "e.g. Tower A: 168 units",
  "bedrooms": "e.g. 2, 3, 4",
  "bathrooms": "e.g. 2, 3",
  "sizeSqft": "e.g. 900-2200",
  "carParkLevels": "e.g. Level 1-4",
  "numberOfCarParks": "e.g. 480 bays",
  "parkingNotes": "Notes about parking",
  "numberOfLifts": "e.g. 4 per tower",
  "priceFrom": 480000,
  "priceTo": 1200000,
  "maintenanceFee": "e.g. RM 0.35 / sf / month",
  "sinkingFund": "e.g. RM 0.10 / sf / month",
  "showroom": "Showroom location and hours",
  "scaleModel": "Yes or No",
  "description": "2-3 sentence project description",
  "highlights": "comma-separated list of key highlights",
  "facilities": "comma-separated list of facilities",
  "upgrades": "Description of premium finishes and upgrade specs",
  "unitTypes": [
    {
      "label": "Type A",
      "name": "2-Bedroom",
      "beds": 2,
      "baths": 2,
      "size": "900 sf",
      "priceFrom": "From RM 480,000",
      "image": "",
      "desc": "Brief layout description"
    }
  ]
}`;

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  }

  try {
    const { base64Data } = req.body;
    if (!base64Data || typeof base64Data !== "string") {
      return res.status(400).json({ error: "Missing base64Data in request body" });
    }

    // Limit payload size (~20 MB base64)
    if (base64Data.length > 28 * 1024 * 1024) {
      return res.status(413).json({ error: "File too large" });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: "application/pdf",
                  data: base64Data,
                },
              },
              {
                text: "Extract all property information from this brochure/document and return the JSON object as instructed. If a field is not found, use null. Extract as many unit types as you can find.",
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errBody);
      return res.status(502).json({ error: `Gemini API error ${geminiRes.status}` });
    }

    const data = await geminiRes.json();
    const rawText =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

    // Parse the JSON from Gemini's response
    const clean = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("parse-pdf error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
