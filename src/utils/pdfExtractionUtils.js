/**
 * Utility functions for handling AI-extracted PDF data with confidence scores
 */

/**
 * Gets confidence level for a field
 * @param {Object} data - Response from parse-pdf API (includes _confidence metadata)
 * @param {string} fieldName - Field name to check confidence for
 * @returns {number} Confidence score 0-100, or 100 if not available
 */
export function getFieldConfidence(data, fieldName) {
  return data?._confidence?.[fieldName] ?? 100;
}

/**
 * Gets confidence indicator color
 * @param {number} confidence - Confidence score 0-100
 * @returns {string} Color code: 'green' (high), 'yellow' (medium), 'red' (low)
 */
export function getConfidenceColor(confidence) {
  if (confidence >= 85) return "green";
  if (confidence >= 65) return "yellow";
  return "red";
}

/**
 * Highlights fields with low confidence (< 80%)
 * Useful for review before saving to database
 * @param {Object} data - Response from parse-pdf API
 * @param {number} threshold - Confidence threshold (default 80)
 * @returns {Array<string>} Array of field names with low confidence
 */
export function getLowConfidenceFields(data, threshold = 80) {
  const confidence = data?._confidence || {};
  return Object.entries(confidence)
    .filter(([_, score]) => score < threshold)
    .map(([field, _]) => field);
}

/**
 * Creates a review summary showing confidence breakdown
 * @param {Object} data - Response from parse-pdf API
 * @returns {Object} Summary with counts of high/medium/low confidence fields
 */
export function getConfidenceSummary(data) {
  const confidence = data?._confidence || {};
  const scores = Object.values(confidence);

  return {
    highConfidence: scores.filter(s => s >= 85).length,
    mediumConfidence: scores.filter(s => s >= 65 && s < 85).length,
    lowConfidence: scores.filter(s => s < 65).length,
    averageConfidence: (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1),
  };
}

/**
 * Normalizes extracted data for form autofill
 * Removes confidence metadata and cleans values
 * @param {Object} data - Response from parse-pdf API
 * @returns {Object} Cleaned data ready for form submission
 */
export function normalizeForSubmit(data) {
  const { _confidence, ...normalized } = data;
  return normalized;
}

/**
 * Maps new schema fields to legacy app schema (if needed for backward compatibility)
 * @param {Object} extractedData - Data from new parse-pdf API
 * @returns {Object} Data in legacy format
 */
export function mapToLegacySchema(extractedData) {
  return {
    name: extractedData.projectName,
    developer: extractedData.developer,
    location: extractedData.projectLocation,
    tenure: extractedData.tenure,
    landSize: extractedData.landSize,
    constructionStage: extractedData.constructionStage,
    completion: extractedData.completionDate,
    totalBlocks: extractedData.totalBlocks,
    totalFloors: extractedData.totalFloors,
    totalUnits: extractedData.totalUnits,
    numberOfCarParks: extractedData.carParks,
    numberOfLifts: extractedData.liftsPerBlock,
    unitTypes: (extractedData.layouts || []).map(layout => ({
      type: layout.type,
      size: `${layout.sizeSqft} sf`,
    })),
    maintenanceFee: extractedData.maintenanceFee,
    priceFrom: extractedData.priceRange?.min,
    priceTo: extractedData.priceRange?.max,
    showroom: extractedData.showroom,
    scaleModel: extractedData.scaleModel,
    _confidence: extractedData._confidence,
  };
}

/**
 * Validates extracted data completeness
 * @param {Object} data - Response from parse-pdf API
 * @param {Array<string>} requiredFields - Fields that must be present and non-null
 * @returns {Object} Validation result with errors array
 */
export function validateExtractedData(data, requiredFields = []) {
  const errors = [];

  const required = requiredFields.length > 0
    ? requiredFields
    : [
        "projectName",
        "projectLocation",
        "developer",
        "priceRange",
        "totalUnits",
        "completionDate",
      ];

  for (const field of required) {
    if (!data[field] || (typeof data[field] === "object" && Object.keys(data[field]).length === 0)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
