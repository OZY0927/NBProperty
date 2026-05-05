/**
 * Vercel Serverless Function — /api/send-telegram
 *
 * Accepts POST { botToken, chatId, text }
 * Forwards the message to the Telegram Bot API server-side so that
 * the bot token is never exposed in browser network requests.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { botToken, chatId, text } = req.body || {};

  if (!botToken || !chatId || !text) {
    return res.status(400).json({ error: "Missing botToken, chatId, or text" });
  }

  // Basic sanity check — bot tokens are alphanumeric + colon + dash only
  if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(botToken)) {
    return res.status(400).json({ error: "Invalid bot token format" });
  }

  const TELEGRAM_API = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const tgRes = await fetch(TELEGRAM_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });

    const tgData = await tgRes.json();

    if (!tgRes.ok) {
      console.error("Telegram API error:", tgData);
      return res.status(502).json({ error: "Telegram API error", detail: tgData });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-telegram error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
