# PDF Extraction Refactor – Quick Reference

## 🎯 What You Need to Know

Your PDF extraction has been upgraded from a basic system to a **production-ready AI pipeline with confidence scoring**.

---

## 📊 Old vs New

| Feature | Old | New |
|---------|-----|-----|
| **Schema** | 20 fields | 34+ fields |
| **Confidence** | ❌ No | ✅ Yes (0-100) |
| **Data Quality** | ⚠️ Basic | ✅ Robust |
| **Number Handling** | Simple | ✅ Ranges, cleanup |
| **Unit Types** | Single | ✅ Array of types |
| **Noise Filtering** | None | ✅ Smart (ignores junk) |

---

## 🚀 Getting Started (5 minutes)

### 1. Test the API
```bash
curl -X POST http://localhost:5173/api/parse-pdf \
  -H "Content-Type: application/json" \
  -d '{"base64Data": "..your base64 pdf.."}'
```

Expected response:
```json
{
  "projectName": "value",
  "projectLocation": "value",
  "_confidence": {
    "projectName": 95,
    "projectLocation": 88
  }
}
```

### 2. Use in Your App
```jsx
import { getConfidenceSummary, normalizeForSubmit } from './utils/pdfExtractionUtils.js';

const data = await extractPdF(file); // Your API call
const summary = getConfidenceSummary(data);
console.log(`Quality: ${summary.averageConfidence}%`);
const clean = normalizeForSubmit(data); // Remove _confidence
```

### 3. Display to User
```jsx
<div>
  Quality Score: {summary.averageConfidence}%
  High: {summary.highConfidence} | Medium: {summary.mediumConfidence} | Low: {summary.lowConfidence}
</div>
```

---

## 📁 New Files

| File | Purpose |
|------|---------|
| `src/utils/pdfExtractionUtils.js` | 7 utility functions for handling confidence |
| `src/components/PdfProjectExtractorExample.jsx` | Complete working example |
| `PDF_EXTRACTION_GUIDE.md` | Full documentation |

---

## 🔧 API Changes

### Old Endpoint Response
```json
{
  "name": "Project Name",
  "developer": "Developer CO",
  "unitTypes": [...]
}
```

### New Endpoint Response
```json
{
  "projectName": "Project Name",
  "developer": "Developer CO",
  "layouts": [...],
  "_confidence": {
    "projectName": 95,
    "developer": 92,
    "layouts": 85
  }
}
```

**Note:** Old field names (`name`, `location`) → New (`projectName`, `projectLocation`)

---

## 🛠️ Migration Checklist

- [ ] Test API with sample PDF
- [ ] Import `pdfExtractionUtils.js` in your component
- [ ] Update form to handle new schema
- [ ] Display confidence indicators
- [ ] Add validation before saving
- [ ] Test with multiple property brochures

---

## 💡 7 Key Utility Functions

```jsx
import {
  getFieldConfidence,        // Get score for a field (0-100)
  getConfidenceColor,        // Get color based on score
  getLowConfidenceFields,    // Get array of fields < threshold
  getConfidenceSummary,      // Get overall quality breakdown
  normalizeForSubmit,        // Extract values, remove metadata
  mapToLegacySchema,         // Convert to old schema if needed
  validateExtractedData,     // Check if required fields exist
} from './utils/pdfExtractionUtils.js';
```

---

## 📋 Field Mapping Reference

### Old → New
| Old | New |
|-----|-----|
| `name` | `projectName` |
| `location` | `projectLocation` |
| `completion` | `completionDate` |
| `priceFrom` / `priceTo` | `priceRange.min` / `.max` |
| `numberOfCarParks` | `carParks` |
| `numberOfLifts` | `liftsPerBlock` |
| `unitTypes` (simple) | `layouts` (array of objects) |

---

## ✅ Example: Add New Project Flow

```jsx
async function handleAddProject(pdfFile) {
  // 1. Extract
  const extracted = await fetch('/api/parse-pdf', {
    method: 'POST',
    body: formData
  }).then(r => r.json());

  // 2. Review confidence
  const summary = getConfidenceSummary(extracted);
  if (summary.averageConfidence < 70) {
    showWarning("Confidence too low. Please review.");
    return;
  }

  // 3. Validate
  const valid = validateExtractedData(extracted);
  if (!valid.isValid) {
    showErrors(valid.errors);
    return;
  }

  // 4. Normalize
  const clean = normalizeForSubmit(extracted);

  // 5. Save 
  await setProjectById('new', {
    ...clean,
    id: generateId(),
    createdAt: new Date()
  });
}
```

---

## 🎨 Confidence Color Codes

```jsx
// Add this to your CSS or use inline styles:
.confidence-high { color: #2d6a4f; }   // Green (85+)
.confidence-medium { color: #e8a600; } // Yellow (65-85)
.confidence-low { color: #d62828; }    // Red (<65)

// Or use the utility:
const color = getConfidenceColor(95);  // "green"
```

---

## 🐛 Troubleshooting Quick Tips

| Problem | Solution |
|---------|----------|
| Low scores on all fields | PDF quality might be poor; try different brochure |
| Fields returning `null` | Information might not exist in PDF; check manually |
| Price range not splitting | Ensure format: "RM X,XXX - RM X,XXX" |
| API timeout | PDF too large; try smaller file |
| JSON parse error | Check if GEMINI_API_KEY is set in env |

---

## 📊 Expected Confidence Ranges

| Field Type | Typical Confidence |
|------------|-------------------|
| Project Name | 95-100% |
| Location | 85-95% |
| Developer | 80-90% |
| Unit Count | 70-85% |
| Prices | 60-80% |
| Complex fields | 45-65% |

*Note: Varies based on PDF quality and clarity*

---

## 🔐 Security Notes

- ✅ Base64 PDF sent to Gemini API (encrypted HTTPS)
- ✅ No files stored on server
- ✅ API key in environment variables only
- ⚠️ Sensitive PDFs → test in staging first
- ⚠️ Rate limits: 15 req/min (free tier)

---

## 📞 Need Help?

1. Check `PDF_EXTRACTION_GUIDE.md` for full docs
2. Review `PdfProjectExtractorExample.jsx` for working implementation
3. Test utilities with `pdfExtractionUtils.js`
4. Check confidence scores first (not all fields extracted = normal)

---

## 🎓 Schema Deep Dive

### Confidence Score Interpretation
- **90-100**: Direct match in PDF (safe to use)
- **75-89**: High confidence inference (review advised)
- **60-74**: Uncertain but extracted (user review required)
- **0-59**: Very low match (likely wrong, validate manually)

### When to Trust Confidence
✅ Trust 85+ for automated workflows
✅ Trust 70+ for review-before-save
❌ Don't trust <60 without verification

---

## 🚀 Next Level: Performance Optimization

For high-volume extraction:
1. Batch multiple PDFs
2. Cache responses
3. Monitor confidence trends
4. Retrain prompts based on patterns

---

## 📌 Version Info

- **Refactored**: April 28, 2026
- **API Model**: Gemini 2.0 Flash
- **Schema Version**: 2.0
- **Confidence Feature**: v1.0

---
