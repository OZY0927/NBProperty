import React, { useState } from 'react';
import {
  getFieldConfidence,
  getConfidenceColor,
  getLowConfidenceFields,
  getConfidenceSummary,
  normalizeForSubmit,
  validateExtractedData,
} from '../utils/pdfExtractionUtils.js';

/**
 * Example component for PDF extraction with confidence scoring
 * Demonstrates the new refactored PDF extraction pipeline
 */
export function PdfProjectExtractorExample() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [extracted, setExtracted] = useState(null);
  const [error, setError] = useState(null);

  // Step 1: Handle PDF upload
  const handleFileSelect = async (e) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (!selectedFile.type.includes('pdf')) {
      setError('Please select a PDF file');
      return;
    }

    setFile(selectedFile);
    setError(null);
  };

  // Step 2: Extract data from PDF
  const handleExtract = async () => {
    if (!file) {
      setError('Please select a PDF file');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Convert PDF to base64
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64Data = event.target?.result?.split(',')[1];

        if (!base64Data) {
          throw new Error('Failed to encode PDF');
        }

        // Send to API
        const response = await fetch('/api/parse-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64Data }),
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.statusText}`);
        }

        const data = await response.json();
        setExtracted(data);
        setLoading(false);
      };

      reader.readAsDataURL(file);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  // Step 3: Save extracted data
  const handleSave = () => {
    if (!extracted) return;

    // Validate data
    const validation = validateExtractedData(extracted);
    if (!validation.isValid) {
      setError(`Validation failed: ${validation.errors.join(', ')}`);
      return;
    }

    // Normalize and save
    const cleanData = normalizeForSubmit(extracted);
    console.log('Saving project:', cleanData);

    // TODO: Call your setProjectById() or database function here
    alert('Project saved successfully!');
    setExtracted(null);
    setFile(null);
  };

  return (
    <div style={{ padding: '20px', maxWidth: '900px', margin: '0 auto' }}>
      <h1>📄 PDF Project Extraction with Confidence Scoring</h1>

      {/* Error Display */}
      {error && (
        <div style={{
          backgroundColor: '#f8d7da',
          border: '1px solid #f5c6cb',
          color: '#721c24',
          padding: '12px',
          borderRadius: '4px',
          marginBottom: '16px',
        }}>
          {error}
        </div>
      )}

      {/* Step 1: File Upload */}
      {!extracted && (
        <div style={{
          border: '2px dashed #007bff',
          padding: '20px',
          borderRadius: '8px',
          marginBottom: '20px',
          textAlign: 'center',
        }}>
          <h3>Step 1: Upload PDF Brochure</h3>
          <input
            type="file"
            accept=".pdf"
            onChange={handleFileSelect}
            style={{ marginBottom: '12px' }}
          />
          {file && <p>Selected: {file.name}</p>}
          <button
            onClick={handleExtract}
            disabled={!file || loading}
            style={{
              padding: '10px 20px',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? 'Extracting...' : 'Extract Data'}
          </button>
        </div>
      )}

      {/* Step 2: Review Extracted Data with Confidence */}
      {extracted && (
        <div>
          <h2>Step 2: Review & Confirm Extraction</h2>

          {/* Confidence Summary */}
          <ConfidenceSummaryCard extracted={extracted} />

          {/* Low Confidence Warning */}
          <LowConfidenceWarning extracted={extracted} />

          {/* Extraction Preview */}
          <ExtractionPreview extracted={extracted} />

          {/* Actions */}
          <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
            <button
              onClick={handleSave}
              style={{
                padding: '10px 20px',
                backgroundColor: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              ✅ Save Project
            </button>
            <button
              onClick={() => setExtracted(null)}
              style={{
                padding: '10px 20px',
                backgroundColor: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              ❌ Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Shows extraction quality summary
 */
function ConfidenceSummaryCard({ extracted }) {
  const summary = getConfidenceSummary(extracted);

  return (
    <div style={{
      backgroundColor: '#f8f9fa',
      border: '1px solid #dee2e6',
      borderRadius: '8px',
      padding: '16px',
      marginBottom: '16px',
    }}>
      <h3>📊 Extraction Quality Summary</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '12px' }}>
        <div>
          <div style={{ color: '#2d6a4f', fontWeight: 'bold' }}>
            {summary.highConfidence}
          </div>
          <div style={{ color: '#666', fontSize: '12px' }}>High Confidence (85+)</div>
        </div>
        <div>
          <div style={{ color: '#e8a600', fontWeight: 'bold' }}>
            {summary.mediumConfidence}
          </div>
          <div style={{ color: '#666', fontSize: '12px' }}>Medium (65-85)</div>
        </div>
        <div>
          <div style={{ color: '#d62828', fontWeight: 'bold' }}>
            {summary.lowConfidence}
          </div>
          <div style={{ color: '#666', fontSize: '12px' }}>Low (< 65)</div>
        </div>
        <div>
          <div style={{ color: '#007bff', fontWeight: 'bold' }}>
            {summary.averageConfidence}%
          </div>
          <div style={{ color: '#666', fontSize: '12px' }}>Average</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Shows warning for fields with low confidence
 */
function LowConfidenceWarning({ extracted }) {
  const lowFields = getLowConfidenceFields(extracted, 80);

  if (lowFields.length === 0) {
    return (
      <div style={{
        backgroundColor: '#d4edda',
        border: '1px solid #c3e6cb',
        color: '#155724',
        padding: '12px',
        borderRadius: '4px',
        marginBottom: '16px',
      }}>
        ✅ All fields extracted with good confidence!
      </div>
    );
  }

  return (
    <div style={{
      backgroundColor: '#fff3cd',
      border: '1px solid #ffeeba',
      color: '#856404',
      padding: '12px',
      borderRadius: '4px',
      marginBottom: '16px',
    }}>
      <strong>⚠️ Review These Fields:</strong>
      <ul style={{ marginTop: '8px', marginBottom: '0' }}>
        {lowFields.map(field => {
          const confidence = getFieldConfidence(extracted, field);
          return (
            <li key={field}>
              {field}: {confidence}% confident
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Shows key extracted fields with confidence indicators
 */
function ExtractionPreview({ extracted }) {
  const keyFields = [
    'projectName',
    'projectLocation',
    'developer',
    'totalUnits',
    'priceRange',
    'completionDate',
    'tenure',
    'maintenanceFee',
  ];

  return (
    <div style={{
      backgroundColor: '#f8f9fa',
      border: '1px solid #dee2e6',
      borderRadius: '8px',
      padding: '16px',
    }}>
      <h3>📋 Extracted Data Preview</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {keyFields.map(field => {
          const value = extracted[field];
          const confidence = getFieldConfidence(extracted, field);
          const color = getConfidenceColor(confidence);

          if (value === null || value === undefined) return null;

          const displayValue = typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);

          return (
            <div key={field}>
              <label style={{ fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>
                {field}
              </label>
              <input
                type="text"
                value={displayValue}
                readOnly
                style={{
                  width: '100%',
                  padding: '8px',
                  border: `2px solid ${color === 'green' ? '#2d6a4f' : color === 'yellow' ? '#e8a600' : '#d62828'}`,
                  borderRadius: '4px',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                }}
              />
              <small style={{ color: '#666', marginTop: '4px', display: 'block' }}>
                {confidence}% confident
              </small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default PdfProjectExtractorExample;
