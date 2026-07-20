// ─── IMPORTS ──────────────────────────────────────────────────────────────────
const config = require("./config");
const { handleBotMessage } = require("./bot");

const WHATSAPP_TOKEN       = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID      = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
async function sendWhatsApp(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error("⚠️ WHATSAPP_TOKEN or PHONE_NUMBER_ID not set");
    return false;
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    if (!res.ok) {
      console.error("❌ sendWhatsApp error:", await res.text());
      return false;
    }
    console.log("📤 Sent to:", to);
    return true;
  } catch (e) {
    console.error("❌ sendWhatsApp error:", e.message);
    return false;
  }
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
function ownerPhone() {
  return config.OWNER_PHONE.replace("@c.us", "");
}

async function notifyOrderPlaced(order) {
  const userMsg  = config.MESSAGES.ORDER_PLACED_USER(order);
  const ownerMsg = config.MESSAGES.ORDER_PLACED_OWNER(order);
  const userPhone = order.chatId || order.phone;
  if (userPhone && userPhone !== ownerPhone()) {
    await sendWhatsApp(userPhone, userMsg);
  }
  await sendWhatsApp(ownerPhone(), ownerMsg);
  console.log(`✅ Order placed notifications sent — ${order.id}`);
}

async function notifyStatusChanged(order) {
  const notifyOn = ["filling", "on my way", "arrived", "delivered", "cancelled"];
  if (!notifyOn.includes(order.status)) return;
  const userMsg  = config.MESSAGES.STATUS_CHANGED_USER(order);
  const ownerMsg = config.MESSAGES.STATUS_CHANGED_OWNER(order);
  await sendWhatsApp(order.chatId || order.phone, userMsg);
  await sendWhatsApp(ownerPhone(), ownerMsg);
  console.log(`✅ Status notifications sent — ${order.id} → ${order.status}`);
}

async function notifyPaymentChanged(order) {
  const statusText = order.paymentStatus === "done" ? "✅ Ho Gayi" : "⏳ Pending";
  const now = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short", hour12: true });
  const userMsg  = `🚰 *${config.BUSINESS_NAME}*\n\n💳 *Payment Status Update*\n\nAapke order ki payment status update hui hai.\n\n🆔 Order ID: ${order.id}\n📍 Address: ${order.address || ""}\n💰 Total: Rs. ${order.total}\n💳 Payment: *${statusText}*\n🕐 Time: ${now}`;
  const ownerMsg = `💳 *Payment Status Update*\n\n🆔 Order ID: ${order.id}\n👤 Customer: ${order.customerName}\n📍 Address: ${order.address || ""}\n💰 Total: Rs. ${order.total}\n💳 Naya Status: *${statusText}*\n🕐 Time: ${now}`;
  await sendWhatsApp(order.phone, userMsg);
  await sendWhatsApp(ownerPhone(), ownerMsg);
  console.log(`✅ Payment notification sent — ${order.id} → ${order.paymentStatus}`);
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
function initWhatsApp(app) {
  // GET /webhook — Meta verification challenge (called once when you save webhook URL in Meta dashboard)
  app.get("/webhook", (req, res) => {
    const mode      = req.query["hub.mode"];
    const token     = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
      console.log("✅ Webhook verified by Meta");
      res.status(200).send(challenge);
    } else {
      console.warn("❌ Webhook verification failed — check WEBHOOK_VERIFY_TOKEN env var");
      res.sendStatus(403);
    }
  });

  // POST /webhook — Incoming messages from customers
  app.post("/webhook", async (req, res) => {
    res.sendStatus(200); // Must respond immediately — Meta drops connection after 20s
    try {
      const body = req.body;
      if (body.object !== "whatsapp_business_account") return;
      const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!message) return;
      const { saveOrder, getDb } = require("./firebase");
      await handleBotMessage(message, sendWhatsApp, saveOrder, getDb(), notifyOrderPlaced, notifyStatusChanged);
    } catch (e) {
      console.error("Webhook handler error:", e);
    }
  });

  console.log("✅ WhatsApp Cloud API webhook ready");
}

module.exports = {
  initWhatsApp,
  sendWhatsApp,
  notifyOrderPlaced,
  notifyStatusChanged,
  notifyPaymentChanged,
  isClientReady: () => !!(WHATSAPP_TOKEN && PHONE_NUMBER_ID),
};
