# AI PDF Extraction Refactor – Implementation Guide

## Overview

Your PDF extraction pipeline has been refactored to use a **production-ready AI prompt** with confidence scoring. This enables better data extraction accuracy and gives you visibility into extraction reliability.

---

## What Changed

### 1. **New System Prompt** (`api/parse-pdf.js`)
- More comprehensive rules for handling property data
- Better guidance on normalizing numbers, ranges, and arrays
- Explicit field mappings for Malaysian real estate terms
- **Confidence scoring** on every extracted field

### 2. **New Response Schema**
Each field now includes:
```json
{
  "value": "extracted data or null",
  "confidence": 95
}
```

All fields are wrapped with confidence metadata (0-100).

### 3. **Response Normalization**
The API automatically normalizes the response:
- Extracts values from confidence wrapper
- Attaches metadata under `_confidence` key
- Ready for form autofill

---

## Key Features

### ✅ Confidence Scoring
Every field has a confidence score (0-100):
- **85+** = Green (high confidence, safe to save)
- **65-85** = Yellow (medium confidence, review recommended)
- **0-65** = Red (low confidence, user verification needed)

### ✅ Robust Data Handling
- Numbers: `"RM 374,680"` → `374680`
- Ranges: `"RM 374,680 - RM 551,520"` → `{ min: 374680, max: 551520 }`
- Arrays: Multiple unit types automatically extracted
- Missing fields: Returns `null` instead of errors

### ✅ Smart Filtering
Ignores noise:
- Irrelevant notes
- Booking instructions
- Sales admin text
- Promotional fluff

---

## New JSON Schema

```json
{
  "projectName": "string | null",
  "projectLocation": "string | null",
  "developer": "string | null",
  "titleType": "string | null",
  "landSize": "string | null",
  "constructionStage": "string | null",
  "completionDate": "string | null",
  "tenure": "Freehold or Leasehold",
  "totalBlocks": "string | null",
  "totalFloors": "string | null",
  "totalUnits": "number | null",
  "carParks": "string | null",
  "liftsPerBlock": "string | null",
  "layouts": [
    { "type": "Type A", "sizeSqft": 897 },
    { "type": "Type B", "sizeSqft": 1008 }
  ],
  "ceilingHeight": "string | null",
  "maintenanceFee": "string | null",
  "securityTiers": "string | null",
  "priceRange": { "min": 374680, "max": 551520 },
  "showroom": "string | null",
  "scaleModel": "string | null",
  "bumiDiscount": "string | null",
  "bookingFee": "string | null",
  "cancellationFee": "string | null",
  "spaLegalFee": "string | null",
  "loanLegalFee": "string | null",
  "spaDisbursementFee": "string | null",
  "loanDisbursementFee": "string | null",
  "spaStampDuty": "string | null",
  "loanStampDuty": "string | null",
  "motStampDuty": "string | null",
  "motLegalFee": "string | null",
  "panelBanks": ["Bank 1", "Bank 2"],
  "panelLawyer": "string | null",
  "salesGalleryLocation": "string | null",
  "operatingHours": "string | null",
  "additionalInformation": ["note 1", "note 2"],
  "_confidence": {
    "projectName": 95,
    "totalUnits": 88,
    ...
  }
}
```

---

## Frontend Integration

### 1. **Import the utility functions**

```jsx
import {
  getFieldConfidence,
  getConfidenceColor,
  getLowConfidenceFields,
  getConfidenceSummary,
  normalizeForSubmit,
  mapToLegacySchema,
  validateExtractedData,
} from './utils/pdfExtractionUtils.js';
```

### 2. **Display Confidence Indicators**

```jsx
function ProjectForm({ extractedData }) {
  const projectNameConfidence = getFieldConfidence(extractedData, 'projectName');
  const color = getConfidenceColor(projectNameConfidence);

  return (
    <div>
      <input value={extractedData.projectName} />
      <span style={{ color: color === 'green' ? '#2d6a4f' : color === 'yellow' ? '#e8a600' : '#d62828' }}>
        {projectNameConfidence}% confident
      </span>
    </div>
  );
}
```

### 3. **Review Before Save**

```jsx
function ReviewExtractedData({ extractedData, onSave }) {
  const lowConfidenceFields = getLowConfidenceFields(extractedData, 80);
  const summary = getConfidenceSummary(extractedData);

  return (
    <div>
      <h3>Extraction Summary</h3>
      <p>High: {summary.highConfidence} | Medium: {summary.mediumConfidence} | Low: {summary.lowConfidence}</p>
      <p>Average Confidence: {summary.averageConfidence}%</p>

      {lowConfidenceFields.length > 0 && (
        <div style={{ backgroundColor: '#fff3cd', padding: '8px' }}>
          ⚠️ Review these fields:
          <ul>
            {lowConfidenceFields.map(field => (
              <li key={field}>{field}</li>
            ))}
          </ul>
        </div>
      )}

      <button onClick={() => onSave(normalizeForSubmit(extractedData))}>
        Save to Database
      </button>
    </div>
  );
}
```

### 4. **Validate Data Completeness**

```jsx
function handleExtractedData(data) {
  const validation = validateExtractedData(data, [
    'projectName',
    'projectLocation',
    'developer',
    'totalUnits',
  ]);

  if (!validation.isValid) {
    validation.errors.forEach(error => console.error(error));
    return;
  }

  // Save to database
  saveProject(normalizeForSubmit(data));
}
```

### 5. **Backward Compatibility (if needed)**

If your app still uses the old schema:

```jsx
const legacyData = mapToLegacySchema(extractedData);
// Now compatible with your existing App.jsx data structure
```

---

## API Usage Example

### Request
```js
const formData = new FormData();
formData.append('pdf', pdfFile);

const response = await fetch('/api/parse-pdf', {
  method: 'POST',
  body: JSON.stringify({
    base64Data: base64EncodedPdf
  }),
  headers: { 'Content-Type': 'application/json' }
});

const extracted = await response.json();
```

### Response
```json
{
  "projectName": "The Pinnacle Residences",
  "projectLocation": "Bukit Mertajam, Penang",
  "developer": "Mah Sing Group",
  "totalUnits": 320,
  "priceRange": { "min": 374680, "max": 551520 },
  "layouts": [
    { "type": "Type A", "sizeSqft": 897 },
    { "type": "Type B", "sizeSqft": 1008 }
  ],
  "_confidence": {
    "projectName": 98,
    "projectLocation": 95,
    "developer": 92,
    "totalUnits": 88,
    "layouts": 85,
    "priceRange": 78
  }
}
```

---

## Best Practices

### ✅ Do's
- ✅ Review fields with confidence < 80% before saving
- ✅ Use `getConfidenceSummary()` to show extraction quality
- ✅ Validate extracted data with `validateExtractedData()`
- ✅ Use confidence colors to guide user review
- ✅ Keep PDF quality high (clear text, standard format)

### ❌ Don'ts
- ❌ Don't rely on 100% accuracy from AI (always review)
- ❌ Don't save low-confidence fields without user confirmation
- ❌ Don't send blurry or handwritten PDFs
- ❌ Don't ignore the confidence metadata

---

## For Specific Use Cases

### 🏠 Adding New Project
```jsx
import { validateExtractedData, normalizeForSubmit } from './utils/pdfExtractionUtils.js';

async function addNewProjectFromPdf(pdfFile) {
  const extracted = await extractPdfData(pdfFile); // Your existing extraction
  const validation = validateExtractedData(extracted);

  if (!validation.isValid) {
    alert(`Please fix: ${validation.errors.join(', ')}`);
    return;
  }

  const cleanData = normalizeForSubmit(extracted);
  await setProjectById(cleanData.id || 'new', cleanData);
}
```

### 🔍 Quality Assurance
```jsx
function showExtractionQualityReport(data) {
  const summary = getConfidenceSummary(data);
  const lowFields = getLowConfidenceFields(data, 75);

  console.log(`✅ High confidence: ${summary.highConfidence} fields`);
  console.log(`⚠️  Medium confidence: ${summary.mediumConfidence} fields`);
  console.log(`❌ Low confidence: ${summary.lowConfidence} fields`);
  console.log(`📊 Average: ${summary.averageConfidence}%`);

  if (lowFields.length > 0) {
    console.warn('Fields requiring review:', lowFields);
  }
}
```

---

## Troubleshooting

### Issue: Low confidence scores across the board
**Solution:**
- Check PDF quality (ensure text is clear and readable)
- Verify PDF follows standard property brochure format
- Try a different property PDF to compare

### Issue: Missing fields returning null
**Solution:**
- Verify the information exists in your PDF
- Check if field is in the schema (not all extractions support all fields)
- Use `getLowConfidenceFields()` to identify uncertain extractions

### Issue: Price range not splitting correctly
**Solution:**
- Ensure price is formatted as: "RM XXX,XXX - RM XXX,XXX"
- The AI expects currency symbol + numbers + separator

---

## Next Steps

1. ✅ Update your PDF upload component to use new utilities
2. ✅ Add confidence indicators to your form UI
3. ✅ Implement validation before saving to Firestore
4. ✅ Test with sample property brochures
5. ✅ Monitor confidence trends to improve prompts

---

## Environment Setup

Ensure `GEMINI_API_KEY` is set in your Vercel environment:

```bash
vercel env add GEMINI_API_KEY
```

API limits:
- Free tier: 15 requests/minute, 1500 requests/day
- For production: Consider upgrade or rate limiting

---

## Files Changed

- ✏️ `api/parse-pdf.js` – Updated with new system prompt and confidence normalization
- ✨ `src/utils/pdfExtractionUtils.js` – NEW utility functions for handling confidence scores
