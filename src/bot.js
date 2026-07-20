// ─── IMPORTS ──────────────────────────────────────────────────────────────────
const config = require("./config");
const {
  getLastCustomerOrder, getLastCustomerOrderByChatId,
  getConversationState, setConversationState, clearConversationState,
  cancelLastPlacedOrder,
  getWaContact, saveWaContact,
} = require("./firebase");

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const MAX_MSGS_PER_HOUR = 20;
const rateLimits = new Map();
const lastSeen   = new Map();

// ─── RATE LIMIT & DEBOUNCE ────────────────────────────────────────────────────
function isRateLimited(phone) {
  const now = Date.now();
  const rl = rateLimits.get(phone);
  if (!rl || now > rl.resetTime) { rateLimits.set(phone, { count: 1, resetTime: now + 3600000 }); return false; }
  if (rl.count >= MAX_MSGS_PER_HOUR) return true;
  rl.count++;
  return false;
}

function isDuplicate(phone, body) {
  const last = lastSeen.get(phone);
  const now = Date.now();
  if (last && last.body === body && (now - last.time) < 3000) return true;
  lastSeen.set(phone, { body, time: now });
  return false;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatPhone(phone) {
  const digits = String(phone).replace(/\D/g, "").replace(/^92/, "");
  if (digits.length === 10) return "0" + digits.slice(0, 3) + "-" + digits.slice(3);
  return "0" + digits;
}

// Accepts 03XXXXXXXXX, 3XXXXXXXXX, 923XXXXXXXXX, 0334-XXXXXXX → 92XXXXXXXXXX
function validateOrderData(qty, phone) {
  if (!qty || qty < 1 || qty > 10) return { valid: false, reason: "Qty 1-10 hona chahiye" };
  const digits = String(phone || "").replace(/\D/g, "").replace(/^92/, "").replace(/^0/, "");
  if (digits.length < 9 || digits.length > 11) return { valid: false, reason: "Phone number galat hai" };
  return { valid: true, normalizedPhone: "92" + digits };
}

// ─── VOICE TRANSCRIPTION ──────────────────────────────────────────────────────
async function transcribeVoiceNote(mediaId) {
  if (!mediaId) return null;
  try {
    const urlRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { "Authorization": "Bearer " + process.env.WHATSAPP_TOKEN },
    });
    if (!urlRes.ok) { console.error("Media URL error:", await urlRes.text()); return null; }
    const { url, mime_type } = await urlRes.json();
    const audioRes = await fetch(url, { headers: { "Authorization": "Bearer " + process.env.WHATSAPP_TOKEN } });
    if (!audioRes.ok) { console.error("Audio download error:", await audioRes.text()); return null; }
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    const blob = new Blob([audioBuffer], { type: mime_type || "audio/ogg; codecs=opus" });
    const formData = new FormData();
    formData.append("file", blob, "voice.ogg");
    formData.append("model", "whisper-large-v3");
    formData.append("language", "ur");
    formData.append("response_format", "json");
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + GROQ_API_KEY },
      body: formData,
    });
    if (!res.ok) { console.error("Whisper error:", await res.text()); return null; }
    const data = await res.json();
    return data.text?.trim() || null;
  } catch (e) {
    console.error("Transcription error:", e.message);
    return null;
  }
}

// ─── LLM AGENT ────────────────────────────────────────────────────────────────
function buildSystemPrompt(ctx) {
  return `You are the WhatsApp ordering assistant for Salsabeel Paani Delivery, Lahore.
We sell 19-liter water bottles at Rs. ${config.PRICE_PER_BOTTLE} each (max 10 per order).

CUSTOMER:
- Phone: ${formatPhone(ctx.senderPhone)} (auto-captured — NEVER ask customer for phone)
- Returning: ${ctx.isReturning ? "YES" : "NO"}
- Last address: ${ctx.lastAddress || "NONE ON RECORD"}
- Last pin location: ${ctx.lastLat ? `SAVED (lat=${ctx.lastLat}, lng=${ctx.lastLng})` : "NOT SAVED"}

GOAL: Collect qty (1-10) and delivery address, then optional pin location, then confirm and place order.

STYLE:
- Ultra short replies — 1-3 lines max
- Use bullet points (•) for summaries and confirmations
- No long paragraphs, no greetings, no filler words
- Roman Urdu only. Switch to English only if customer writes entirely in English.

RULES:
1. Extract ALL info from each message at once — never re-ask for what customer already gave
2. Returning customer: suggest last address; just need qty
3. After collecting qty + address: ask for pin location — "📍 Pin bhejein (optional) ya Skip likhein"
4. Returning customer with SAVED pin + same address: reuse saved lat/lng automatically — skip asking for pin
5. Returning customer with SAVED pin + NEW address: ask for pin again
6. When customer shares location (message "Location shared: lat=X lng=Y"): extract those values for the order
7. When all info collected: show bullet summary, ask 1-Confirm ✅ / 2-Cancel
8. On confirmation: call place_order tool immediately
9. YES = "1", haan, han, ha, yes, ok, okay, ji, theek, bilkul, confirm, sahi, zaroor, done, ہاں
10. NO/CHANGE = "2", nahi, nai, na, cancel, naya
11. NEVER invent an address — use only what customer explicitly stated
12. CANCEL: if customer asks to cancel (mid-flow or a placed order), call cancel_order tool — no extra confirmation needed`;
}

async function runAgent(messages) {
  const models = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
  for (const model of models) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_API_KEY },
      body: JSON.stringify({
        model,
        messages,
        tools: [
          {
            type: "function",
            function: {
              name: "place_order",
              description: "Place the confirmed order. Call ONLY after customer explicitly confirms.",
              parameters: {
                type: "object",
                properties: {
                  qty:     { anyOf: [{ type: "integer" }, { type: "number" }, { type: "string" }], description: "Number of bottles (1-10), e.g. 3" },
                  address: { type: "string", description: "Full delivery address" },
                  lat:     { type: "string", description: "Latitude from WhatsApp pin (optional, omit if not shared or skipped)" },
                  lng:     { type: "string", description: "Longitude from WhatsApp pin (optional, omit if not shared or skipped)" },
                },
                required: ["qty", "address"],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "cancel_order",
              description: "Cancel the conversation or the customer's last placed order. Call when customer wants to cancel.",
              parameters: { type: "object", properties: {}, required: [] },
            },
          },
        ],
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: 400,
      }),
    });
    if (res.status === 429) {
      console.log(`Rate limit on ${model}, trying fallback`);
      continue;
    }
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()).choices[0].message;
  }
  throw new Error("All models rate limited");
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
async function handleBotMessage(message, sendFn, saveOrderFn, db, notifyOrderPlacedFn, notifyStatusChangedFn) {
  if (!message.from) return;
  if (!message.text?.body && message.type !== "location" && message.type !== "audio") return;
  const phone = message.from;
  const fullPhone = phone.startsWith("92") ? phone : "92" + phone.replace(/^0/, "");
  const isLidPhone = false;
  let body = (message.text?.body || "").trim();

  // audio body is always "" — skip duplicate check now, re-check after transcription
  if (message.type !== "audio" && isDuplicate(phone, body)) { console.log("Duplicate skip:", phone); return; }

  async function reply(text) {
    try { await sendFn(phone, text); }
    catch (e) { console.error("Reply error:", e.message); }
  }

  if (isRateLimited(phone)) {
    await reply("Aap ne bahut zyada messages bheje hain. 1 ghante baad dobara try karein. 🙏");
    return;
  }

  // ── Voice note (audio) ──────────────────────────────────────────────────────
  if (message.type === "audio") {
    if (!GROQ_API_KEY) {
      await reply("Voice notes abhi available nahi. Text mein order dein.");
      return;
    }
    const transcript = message.audio?.id ? await transcribeVoiceNote(message.audio.id) : null;
    if (!transcript) {
      await reply("Awaaz samajh nahi aayi (transcription fail). Saaf awaaz mein dobara bhejein ya text likhein.");
      return;
    }
    console.log("Voice [" + phone + "]:", transcript);
    body = transcript;
    if (isDuplicate(phone, body)) { console.log("Duplicate audio skip:", phone); return; }
  }

  // ── Location message ────────────────────────────────────────────────────────
  if (message.type === "location") {
    const { latitude, longitude } = message.location;
    body = "Location shared: lat=" + latitude + " lng=" + longitude;
  }

  // Truncate oversized input to limit token abuse
  if (body.length > 500) body = body.substring(0, 500);

  console.log("Bot [" + phone + "]: " + body.substring(0, 60));

  // ── Load conversation state ─────────────────────────────────────────────────
  const convDoc = await getConversationState(phone);
  // Wipe old state-machine format (had a `step` field)
  if (convDoc?.step) await clearConversationState(phone);
  const history = (convDoc?.step ? [] : convDoc?.messages) || [];

  // ── Customer context ────────────────────────────────────────────────────────
  const knownContact = await getWaContact(phone);
  const knownPhone = convDoc?.knownPhone || knownContact?.phone || (!isLidPhone ? fullPhone : null);
  const lastOrder = knownPhone
    ? (await getLastCustomerOrder(knownPhone) || await getLastCustomerOrderByChatId(phone))
    : await getLastCustomerOrderByChatId(phone);

  const ctx = {
    senderPhone: fullPhone,
    knownPhone,
    lastAddress: lastOrder?.address || null,
    lastLat: lastOrder?.lat || null,
    lastLng: lastOrder?.lng || null,
    isReturning: !!(knownPhone && lastOrder),
  };

  // ── Build LLM messages ──────────────────────────────────────────────────────
  const messages = [
    { role: "system", content: buildSystemPrompt(ctx) },
    ...history,
    { role: "user", content: body },
  ];

  // ── Call agent ──────────────────────────────────────────────────────────────
  let agentMsg;
  try {
    agentMsg = await runAgent(messages);
  } catch (e) {
    console.error("Agent error:", e.message);
    const isRateLimit = e.message.toLowerCase().includes("rate");
    await reply(isRateLimit
      ? "AI quota khatam — kal subah dobara try karein. Text order ke liye likhein: bottles, address, number."
      : "AI service mein masla. Thodi der mein dobara bhejein.");
    return;
  }

  // ── Tool calls ──────────────────────────────────────────────────────────────
  if (agentMsg.tool_calls?.length) {
    let args = {};
    try {
      args = JSON.parse(agentMsg.tool_calls[0].function.arguments);
    } catch (e) {
      console.error("Tool args parse error:", e.message);
      await reply("Order details decode nahi hue. Dobara bhejein.");
      return;
    }

    const toolName = agentMsg.tool_calls[0].function.name;

    // ── cancel_order ──────────────────────────────────────────────────────────
    if (toolName === "cancel_order") {
      const cancelResult = await cancelLastPlacedOrder(message.from, knownPhone);
      await clearConversationState(phone);
      if (!cancelResult) {
        await reply("Cancel karne mein masla aaya. Dobara try karein.");
      } else if (cancelResult.error === "no_order") {
        await reply("Koi recent placed order nahi mila. Dobara order ke liye message karein.");
      } else if (cancelResult.error === "not_cancellable") {
        await reply("Order cancel nahi ho sakta — abhi \"" + cancelResult.status + "\" status mein hai. Owner ko call karein.");
      } else {
        if (notifyStatusChangedFn) notifyStatusChangedFn(cancelResult).catch(e => console.error("Cancel notify:", e));
        await reply("✅ Order #" + cancelResult.id + " cancel ho gaya.\n\nDobara order ke liye message karein.");
      }
      return;
    }

    // ── place_order ───────────────────────────────────────────────────────────
    if (toolName === "place_order") {
      const { address, lat: rawLat, lng: rawLng } = args;
      const qty = Number(args.qty);
      if (!qty || qty < 1 || qty > 10) {
        await reply("Qty 1-10 hona chahiye. Dobara batayein.");
        return;
      }
      const finalPhone = fullPhone;
      try {
        const order = {
          customerName: "Customer",
          phone: finalPhone,
          chatId: message.from,
          address: address.trim(),
          qty,
          total: qty * config.PRICE_PER_BOTTLE,
          status: "placed",
          rider: null,
          riderPhone: null,
          source: "whatsapp_bot",
          ...(rawLat && rawLng ? { lat: parseFloat(rawLat), lng: parseFloat(rawLng) } : {}),
          time: new Date().toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hour12: true }),
          date: new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "2-digit", year: "2-digit" }),
        };
        const orderId = await saveOrderFn(order);
        order.id = orderId;
        if (notifyOrderPlacedFn) notifyOrderPlacedFn(order).catch(e => console.error("Notify:", e));
        await clearConversationState(phone);
        console.log("Agent order:", orderId);
      } catch (e) {
        console.error("Order save error:", e.message);
        await reply("Order database mein save nahi hua. Dobara try karein.");
      }
      return;
    }
  }

  // ── Text reply ──────────────────────────────────────────────────────────────
  const replyText = agentMsg.content;
  if (replyText) await reply(replyText);

  // ── Save history (cap at 8 messages) ───────────────────────────────────────
  const updated = [
    ...history,
    { role: "user", content: body },
    { role: "assistant", content: replyText || "" },
  ].slice(-8);
  await setConversationState(phone, { messages: updated, knownPhone: knownPhone || null });
}

module.exports = { handleBotMessage };
