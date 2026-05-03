// ✅ Free Google Gemini API — native PDF support, no pdf-parse needed
// Get your free API key at: https://aistudio.google.com/app/apikey

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "6mb",
    },
  },
};

const GEMINI_MODEL = "gemini-3-flash-preview"; // Free tier model

function normalizeResponse(data) {
  const normalized = {};
  const confidenceMetadata = {};

  for (const [key, field] of Object.entries(data)) {
    if (field && typeof field === "object" && "value" in field) {
      normalized[key] = field.value;
      confidenceMetadata[key] = field.confidence || 0;
    } else {
      normalized[key] = field;
      confidenceMetadata[key] = 100;
    }
  }

  return {
    ...normalized,
    _confidence: confidenceMetadata,
  };
}

function safeJSONParse(text) {
  try {
    const cleaned = text.replace(/```json\s*|```\s*/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

const PROMPT = `You are an expert data extraction engine for real estate project PDFs.
Analyze the provided PDF and extract all relevant property data.

Return ONLY a valid JSON object — no markdown, no explanation, no preamble.

The JSON should include fields like:
{
  "projectName":    { "value": "...", "confidence": 95 },
  "developerName":  { "value": "...", "confidence": 90 },
  "location":       { "value": "...", "confidence": 88 },
  "propertyType":   { "value": "...", "confidence": 92 },
  "totalUnits":     { "value": "...", "confidence": 85 },
  "priceRange":     { "value": "...", "confidence": 80 },
  "builtUpArea":    { "value": "...", "confidence": 78 },
  "completionDate": { "value": "...", "confidence": 70 },
  "amenities":      { "value": ["...", "..."], "confidence": 75 },
  "contactInfo":    { "value": "...", "confidence": 65 }
}

Only include fields actually found in the document.
Use null for value if a field cannot be found.
Confidence is 0-100 based on how clearly the data appears.`;

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY in environment" });
  }

  try {
    const { base64Data } = req.body;

    if (!base64Data || typeof base64Data !== "string") {
      return res.status(400).json({ error: "Missing base64Data in request body" });
    }

    if (base64Data.length > 5 * 1024 * 1024) {
      return res.status(413).json({ error: "File too large (max ~5MB base64)" });
    }

    // Timeout protection
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    let geminiRes;
    try {
      geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  // Native PDF support via inline base64
                  inline_data: {
                    mime_type: "application/pdf",
                    data: base64Data,
                  },
                },
                {
                  text: PROMPT,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        return res.status(504).json({ error: "Request timed out after 20s" });
      }
      console.error("Gemini fetch error:", err);
      return res.status(502).json({ error: "Failed to reach Gemini API", message: err.message });
    } finally {
      clearTimeout(timeout);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => "");
      console.error("Gemini API error:", geminiRes.status, errText);
      return res.status(502).json({
        error: "Gemini API returned an error",
        status: geminiRes.status,
        details: errText,
      });
    }

    const result = await geminiRes.json();

    // Extract text from Gemini response
    const rawText = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!rawText) {
      return res.status(500).json({ error: "Gemini returned an empty response" });
    }

    const parsed = safeJSONParse(rawText);

    if (!parsed) {
      console.error("Gemini returned non-JSON:", rawText.slice(0, 500));
      return res.status(500).json({
        error: "Gemini returned invalid JSON",
        preview: rawText.slice(0, 500),
      });
    }

    const normalized = normalizeResponse(parsed);
    return res.status(200).json(normalized);

  } catch (err) {
    console.error("Unhandled error:", err);
    return res.status(500).json({
      error: "Internal server error",
      message: err.message,
    });
  }
}