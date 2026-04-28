// Vercel Serverless Function — POST /api/parse-pdf
// Uses Google Gemini 2.0 Flash (free tier: 15 RPM / 1500 RPD)
// Set GEMINI_API_KEY in Vercel Environment Variables

const GEMINI_MODEL = "gemini-2.0-flash";

/**
 * Normalizes API response to extract values and mark low-confidence fields
 * @param {Object} data - Raw response from Gemini API with confidence scores
 * @returns {Object} Normalized data with extracted values and confidence metadata
 */
function normalizeResponse(data) {
  const normalized = {};
  const confidenceMetadata = {};

  for (const [key, field] of Object.entries(data)) {
    if (field && typeof field === "object" && "value" in field) {
      normalized[key] = field.value;
      confidenceMetadata[key] = field.confidence || 0;
    } else {
      normalized[key] = field;
      confidenceMetadata[key] = 100; // Assume high confidence for legacy fields
    }
  }

  return {
    ...normalized,
    _confidence: confidenceMetadata,
  };
}

const SYSTEM_PROMPT = `You are an expert data extraction engine for real estate project PDFs.

Your task is to extract structured property project information from raw PDF text and return ONLY valid JSON with confidence scores.

Rules:

1. Extract information into the exact JSON schema provided.
2. If a field is missing, return null.
3. If a numeric value contains formatting (e.g. "RM 374,680"), remove symbols and commas, return number only.
4. If a range exists (e.g. "RM 374,680 - RM 551,520"), split into min and max.
5. Ignore unrelated notes, booking instructions, sales admin notes, promotional text, and miscellaneous paragraphs unless they match schema fields.
6. If multiple values exist for a field, preserve them in arrays.
7. Preserve important text formatting for descriptive fields.
8. Infer values only when clearly indicated in the text. Otherwise use null.
9. Normalize field names exactly as defined in the schema.
10. For each field, provide a confidence score (0-100) indicating extraction certainty.

Important field mappings:
- "Freehold / Leasehold" → tenure
- "Total Blocks" → totalBlocks
- "Total Units" → totalUnits
- "Expected Completion Date" → completionDate
- "Gross Price Range" → priceRange
- "Maintenance Fee + Sinking Fund" → maintenanceFee
- "Panel Bank" → panelBanks
- "Layout Size" → layouts

Return ONLY JSON. No explanation, no markdown.

Return data in this schema (ALL fields must have confidence scores):
{
  "projectName": { "value": string | null, "confidence": number },
  "projectLocation": { "value": string | null, "confidence": number },
  "developer": { "value": string | null, "confidence": number },
  "titleType": { "value": string | null, "confidence": number },
  "landSize": { "value": string | null, "confidence": number },
  "constructionStage": { "value": string | null, "confidence": number },
  "completionDate": { "value": string | null, "confidence": number },
  "tenure": { "value": string | null, "confidence": number },
  "totalBlocks": { "value": string | null, "confidence": number },
  "totalFloors": { "value": string | null, "confidence": number },
  "totalUnits": { "value": number | null, "confidence": number },
  "carParks": { "value": string | null, "confidence": number },
  "liftsPerBlock": { "value": string | null, "confidence": number },
  "layouts": { "value": [{ "type": string, "sizeSqft": number }], "confidence": number },
  "ceilingHeight": { "value": string | null, "confidence": number },
  "maintenanceFee": { "value": string | null, "confidence": number },
  "securityTiers": { "value": string | null, "confidence": number },
  "priceRange": { "value": { "min": number | null, "max": number | null }, "confidence": number },
  "showroom": { "value": string | null, "confidence": number },
  "scaleModel": { "value": string | null, "confidence": number },
  "bumiDiscount": { "value": string | null, "confidence": number },
  "bookingFee": { "value": string | null, "confidence": number },
  "cancellationFee": { "value": string | null, "confidence": number },
  "spaLegalFee": { "value": string | null, "confidence": number },
  "loanLegalFee": { "value": string | null, "confidence": number },
  "spaDisbursementFee": { "value": string | null, "confidence": number },
  "loanDisbursementFee": { "value": string | null, "confidence": number },
  "spaStampDuty": { "value": string | null, "confidence": number },
  "loanStampDuty": { "value": string | null, "confidence": number },
  "motStampDuty": { "value": string | null, "confidence": number },
  "motLegalFee": { "value": string | null, "confidence": number },
  "panelBanks": { "value": [string], "confidence": number },
  "panelLawyer": { "value": string | null, "confidence": number },
  "salesGalleryLocation": { "value": string | null, "confidence": number },
  "operatingHours": { "value": string | null, "confidence": number },
  "additionalInformation": { "value": [string], "confidence": number }
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
                text: "Extract structured property project data from the following PDF text:",
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

    // Normalize response to extract values and attach confidence metadata
    const normalized = normalizeResponse(parsed);

    return res.status(200).json(normalized);
  } catch (err) {
    console.error("parse-pdf error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
