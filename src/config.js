// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Yahan aapki saari settings hain. Sirf yahi file edit karni hogi future mein.

// Pakistan time (GMT+5)
function pkTime() {
  return new Date().toLocaleString("en-PK", {
    timeZone: "Asia/Karachi",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    day: "2-digit",
    month: "short",
  });
}

module.exports = {
  // Firebase
  FIREBASE_PROJECT_ID: "minaab-79c2c",

  // Owner WhatsApp (international format, no + sign)
  OWNER_PHONE: "923114355860@c.us",
  OWNER_NAME: "Mutee",

  // Business
  PRICE_PER_BOTTLE: 100,
  BUSINESS_NAME: "Salsabeel Paani Delivery",

  // Server — Railway (and most hosts) inject PORT; must bind to it, not a fixed 3000
  PORT: process.env.PORT || 3000,

  // WhatsApp message templates
  MESSAGES: {
    // Jab naya order aaye
    ORDER_PLACED_USER: (order) =>
      `🚰 *${module.exports.BUSINESS_NAME}*\n\nAssalamu Alaikum ${order.customerName}! 👋\n\nAapka order place ho gaya hai!\n\n📦 *Order Details:*\n🆔 Order ID: ${order.id}\n🍶 Bottles: ${order.qty} x 19L\n💰 Total: Rs. ${order.total}\n📍 Address: ${order.address}\n\n⏳ Status: *Order Placed*\n\nHum jald hi aapka order process karenge. Shukriya! 🙏\n\nDobara order ke liye message karein! 😊`,

    ORDER_PLACED_OWNER: (order) =>
      `🔔 *Naya Order Aaya!*\n\n👤 Customer: ${order.customerName}\n📞 Phone: ${order.phone}\n📍 Address: ${order.address}\n🍶 Bottles: ${order.qty} x 19L\n💰 Total: Rs. ${order.total}\n🆔 Order ID: ${order.id}\n🕐 Time: ${pkTime()}\n\nRider Panel mein dekh sakte hain. ✅`,

    // Jab status change ho
    STATUS_CHANGED_USER: (order) => {
      const statusEmoji = {
        filling:      "🚿",
        "on my way":  "🏍️",
        arrived:      "📍",
        delivered:    "✅",
        cancelled:    "❌",
      };
      const statusMsg = {
        filling:      "Aapki bottles fill ho rahi hain!",
        "on my way":  "Aapka rider rawana ho gaya hai!",
        arrived:      "Rider aapke darwaze pe pahunch gaya hai!",
        delivered:    "Aapka order deliver ho gaya! Shukriya 🙏",
        cancelled:    "Aapka order cancel ho gaya hai.",
      };
      const emoji = statusEmoji[order.status] || "📦";
      const msg   = statusMsg[order.status]   || "Status update hua hai.";
      const paymentLine = order.status === "delivered"
        ? (order.paymentStatus === "done"
            ? "\n💳 Payment: *✅ Ho Gayi*"
            : "\n💳 Payment: *⏳ Pending* — Rider ko cash dein")
        : "";
      return `🚰 *${module.exports.BUSINESS_NAME}*\n\n${emoji} *Order Update*\n\n${msg}\n\n🆔 Order ID: ${order.id}\n📍 Address: ${order.address || ""}\n📊 Status: *${order.status.toUpperCase()}*\n🍶 Bottles: ${order.qty} x 19L\n💰 Total: Rs. ${order.total}${paymentLine}\n🕐 Time: ${pkTime()}\n\n${order.status === "delivered" ? "Dobara order karne ke liye message karein! 😊" : "Hum aapko update karte rahenge."}`;
    },

    STATUS_CHANGED_OWNER: (order) =>
      `📊 *Order Status Update*\n\n🆔 Order ID: ${order.id}\n👤 Customer: ${order.customerName}\n📍 Address: ${order.address || "N/A"}\n📊 Naya Status: *${order.status.toUpperCase()}*\n🏍️ Rider: ${order.rider || "Assigned nahi"}\n💰 Total: Rs. ${order.total}\n🕐 Time: ${pkTime()}`,
  },
};
