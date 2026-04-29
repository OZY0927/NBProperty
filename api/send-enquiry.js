// Vercel Serverless Function — POST /api/send-enquiry
// Sends enquiry email from system sender to admin receiver using SMTP via nodemailer

import nodemailer from 'nodemailer';

const SYSTEM_SENDER = 'leehyeongjun0927@gmail.com';
const ADMIN_RECEIVER = 'ozhengyee@gmail.com';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Expect SMTP config in env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.error('SMTP config missing');
    return res.status(500).json({ error: 'SMTP configuration not set on server' });
  }

  try {
    const { project, name, phone, message } = req.body || {};

    if (!name || !phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465, // true for 465, false for other ports
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });

    const subject = `New enquiry — ${project || 'Website Enquiry'}`;
    const html = `
      <p>You have received a new enquiry via the website.</p>
      <p><strong>Project:</strong> ${project || '—'}</p>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Phone:</strong> ${phone}</p>
      <p><strong>Message:</strong><br/>${message ? message.replace(/\n/g, '<br/>') : '—'}</p>
      <p>Sent via NB Property (system sender).</p>
    `;

    const mailOptions = {
      from: SYSTEM_SENDER,
      to: ADMIN_RECEIVER,
      subject,
      html,
    };

    await transporter.sendMail(mailOptions);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-enquiry error:', err);
    return res.status(500).json({ error: err.message || 'Failed to send enquiry' });
  }
}
