// Vercel Serverless Function — POST /api/parse-pdf
// Uses Groq API with a text Llama model (free via Groq)
// This implementation extracts text from PDF locally using `pdf-parse`
// Set GROQ_API_KEY in Vercel Environment Variables
// Get free key at: https://console.groq.com

import pdfParse from 'pdf-parse';

const GROQ_MODEL = "llama-3.1-70b-versatile";

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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GROQ_API_KEY not configured" });
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

    // Convert base64 PDF to Buffer and extract text using pdf-parse
    let pdfText = "";
    try {
      const pdfBuffer = Buffer.from(base64Data, "base64");
      const pdfData = await pdfParse(pdfBuffer);
      pdfText = (pdfData && pdfData.text) ? String(pdfData.text) : "";
    } catch (pdfErr) {
      console.error("pdf-parse error:", pdfErr);
      return res.status(500).json({ error: "Failed to parse PDF on server" });
    }

    // Call Groq text model with extracted PDF text
    const url = `https://api.groq.com/openai/v1/chat/completions`;
    const groqRes = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Extract structured property project data from the following PDF text:\n\n${pdfText}` },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });

    if (!groqRes.ok) {
      const errBody = await groqRes.text();
      console.error("Groq API error:", groqRes.status, errBody);
      return res.status(502).json({ error: `Groq API error ${groqRes.status}` });
    }

    const data = await groqRes.json();
    const rawText = data?.choices?.[0]?.message?.content || "";

    // Parse the JSON from Groq's response
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
