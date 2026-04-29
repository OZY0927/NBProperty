// Vercel Serverless Function — POST /api/send-enquiry
// Sends enquiry emails using SendGrid
// Set SENDGRID_API_KEY and optionally SENDGRID_SENDER in environment variables

import sendgrid from '@sendgrid/mail';

sendgrid.setApiKey(process.env.SENDGRID_API_KEY || '');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'SENDGRID_API_KEY not configured' });
  }

  const { projectName, name, email, phone } = req.body || {};
  if (!name || !projectName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sender = process.env.SENDGRID_SENDER || 'leehyeongjun0927@gmail.com';
  const recipient = process.env.ENQUIRY_RECIPIENT || 'ozhengyee@gmail.com';

  const subject = `Register Interest — ${projectName}`;
  const text = `New enquiry received from NB Property website.

Project: ${projectName}
Name: ${name}
Email: ${email || 'N/A'}
Phone: ${phone || 'N/A'}

Sent via NB Property website.
`;

  const msg = {
    to: recipient,
    from: sender,
    subject,
    text,
  };

  try {
    await sendgrid.send(msg);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-enquiry error:', err?.response?.body || err.message || err);
    return res.status(502).json({ error: 'Failed to send email' });
  }
}
