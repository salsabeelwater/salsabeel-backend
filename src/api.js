const express = require("express");
const cors    = require("cors");
const config  = require("./config");
const { saveOrder, getAllOrders, getActiveOrders, getOrdersByPhone, getDb } = require("./firebase");
const { notifyOrderPlaced, notifyStatusChanged, notifyPaymentChanged, isClientReady, sendWhatsApp: sendMessage } = require("./whatsapp");
const admin = require("firebase-admin");

const router = express.Router();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
router.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
router.use(express.json());

// ─── HELPER — sirf WhatsApp message bhejne ke liye ───────────────────────────
function toWhatsAppNumber(phone) {
  const clean = phone.replace(/\D/g, "").replace(/^0/, "").replace(/^92/, "");
  return "92" + clean + "@c.us";
}

// Bot ka apna WhatsApp number — yeh khud ko message nahi bhej sakta
const BOT_OWN_NUMBER = "923114355860";
function normalizePhone(phone) {
  const clean = phone.replace(/\D/g, "").replace(/^0/, "").replace(/^92/, "");
  return "92" + clean;
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    whatsapp: isClientReady() ? "connected" : "disconnected",
    firebase: getDb() ? "connected" : "disconnected",
    business: config.BUSINESS_NAME,
  });
});

// ─── AUTH — OTP SEND ──────────────────────────────────────────────────────────
router.post("/auth/send-otp", async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: "Phone aur code chahiye" });

    // Bot apne number ko message nahi bhej sakta — Owner ke liye fixed OTP, WhatsApp skip
    if (normalizePhone(phone) === BOT_OWN_NUMBER) {
      console.log("📌 Owner self-login — WhatsApp skip, fixed OTP use hoga");
      return res.json({ success: true, selfLogin: true });
    }

    const msg = `🚰 *Salsabeel Paani Delivery*\n\nAapka verification code:\n\n*${code}*\n\nYeh code 10 minute mein expire ho jaayega.\n\n_Agar aapne request nahi ki toh ignore karein._`;
    await sendMessage(toWhatsAppNumber(phone), msg);
    res.json({ success: true });
  } catch (err) {
    console.error("OTP error:", err);
    res.status(500).json({ error: "OTP send nahi hua" });
  }
});

// ─── AUTH — VERIFY ────────────────────────────────────────────────────────────
router.post("/auth/verify", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone chahiye" });
    // Always 92 format mein normalize karo
    const digits = phone.replace(/\D/g, "").replace(/^0/, "").replace(/^92/, "");
    const fullPhone = "92" + digits;
    const db = getDb();
    // 92 format mein dhundho
    let usersSnap = await db.collection("users").where("phone", "==", fullPhone).get();
    // Fallback — bina 92 ke bhi dhundho (purane records k liye)
    if (usersSnap.empty) {
      usersSnap = await db.collection("users").where("phone", "==", digits).get();
    }
    if (!usersSnap.empty) {
      const userData = usersSnap.docs[0].data();
      // Purana record — 92 format mein update kar do
      if (userData.phone !== fullPhone) {
        await db.collection("users").doc(usersSnap.docs[0].id).update({ phone: fullPhone });
      }
      return res.json({ user: { phone: fullPhone, name: userData.name, role: userData.role } });
    }
    // Naya user — 92 format mein save karo
    await db.collection("users").add({
      phone: fullPhone, name: "Customer", role: "user",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ user: { phone: fullPhone, name: "Customer", role: "user" } });
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ error: "Verify nahi hua" });
  }
});

// ─── ORDERS — GET ALL ─────────────────────────────────────────────────────────
router.get("/orders", async (req, res) => {
  try {
    let orders;
    if (req.query.phone) {
      // Customer panel — only that customer's own orders (no data leak)
      const digits = String(req.query.phone).replace(/\D/g, "").replace(/^0/, "").replace(/^92/, "");
      orders = await getOrdersByPhone("92" + digits);
    } else if (req.query.scope === "active") {
      orders = await getActiveOrders();
    } else {
      orders = await getAllOrders();
    }
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: "Orders load nahi hue." });
  }
});

// ─── ORDERS — PLACE NEW ───────────────────────────────────────────────────────
router.post("/orders", async (req, res) => {
  try {
    const { customerName, phone, address, qty } = req.body;
    if (!customerName || !phone || !address || !qty) {
      return res.status(400).json({ error: "Saari details zaroor bhejein" });
    }
    const order = {
      customerName, phone,
      address, qty: Number(qty),
      total: Number(qty) * config.PRICE_PER_BOTTLE,
      status: "placed", rider: null, riderPhone: null,
      time: new Date().toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hour12: true }),
      date: new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "2-digit", year: "2-digit" }),
    };
    if (req.body.lat) order.lat = Number(req.body.lat);
    if (req.body.lng) order.lng = Number(req.body.lng);
    const docId = await saveOrder(order);
    order.id = docId;
    await notifyOrderPlaced(order);
    res.status(201).json({ success: true, orderId: docId, order });
  } catch (err) {
    console.error("Order save error:", err);
    res.status(500).json({ error: "Order save nahi hua." });
  }
});

// ─── ORDERS — STATUS UPDATE ───────────────────────────────────────────────────
router.patch("/orders/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rider } = req.body;
    const validStatuses = ["placed", "filling", "on my way", "arrived", "delivered", "cancelled"];
    if (status && !validStatuses.includes(status)) return res.status(400).json({ error: "Invalid status" });
    const db = getDb();
    const docRef = db.collection("orders").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Order nahi mila" });
    const updateData = status ? { status } : {};
    if (rider !== undefined) updateData.rider = rider;
    if (req.body.riderPhone !== undefined) updateData.riderPhone = req.body.riderPhone;
    if (req.body.paymentStatus !== undefined) updateData.paymentStatus = req.body.paymentStatus;
    await docRef.update(updateData);
    const updatedOrder = { id, ...doc.data(), ...updateData };
    // Sirf tab notify karo jab status change ho, rider assign pe nahi
    if (status && status !== doc.data().status) await notifyStatusChanged(updatedOrder);
    res.json({ success: true, order: updatedOrder });
  } catch (err) {
    console.error("Status update error:", err);
    res.status(500).json({ error: "Status update nahi hua." });
  }
});

// ─── PAYMENT STATUS UPDATE ────────────────────────────────────────────────────
router.patch("/orders/:id/payment", async (req, res) => {
  try {
    const { paymentStatus } = req.body;
    if (!["done", "pending"].includes(paymentStatus)) return res.status(400).json({ error: "Invalid payment status" });
    const db = getDb();
    const docRef = db.collection("orders").doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Order nahi mila" });
    await docRef.update({ paymentStatus });
    const order = { id: req.params.id, ...doc.data(), paymentStatus };
    await notifyPaymentChanged(order);
    res.json({ success: true });
  } catch (err) {
    console.error("Payment update error:", err);
    res.status(500).json({ error: "Payment update nahi hua: " + err.message });
  }
});

// ─── ORDERS — DELETE ──────────────────────────────────────────────────────────
router.delete("/orders/:id", async (req, res) => {
  try {
    const db = getDb();
    await db.collection("orders").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Order delete nahi hua." });
  }
});

// ─── RIDERS — GET ALL ─────────────────────────────────────────────────────────
router.get("/riders", async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("users").where("role", "==", "rider").get();
    const riders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ riders });
  } catch (err) {
    res.status(500).json({ error: "Riders load nahi hue" });
  }
});

// ─── RIDERS — ADD ─────────────────────────────────────────────────────────────
router.post("/riders", async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "Naam aur phone chahiye" });
    const db = getDb();
    const existing = await db.collection("users").where("phone", "==", phone).get();
    if (!existing.empty) {
      await db.collection("users").doc(existing.docs[0].id).update({ role: "rider", name });
    } else {
      await db.collection("users").add({ phone, name, role: "rider" });
    }
    const appUrl = process.env.APP_URL || "https://salsabeelwater.shop";
    await sendMessage(toWhatsAppNumber(phone), `🏍️ *Salsabeel Paani Delivery*\n\nSalam ${name}!\n\nAapko rider access mil gaya hai. 🎉\n\n📱 App yahan kholen:\n${appUrl}\n\nApna number daalen aur login karein.`);
    res.json({ success: true });
  } catch (err) {
    console.error("Add rider error:", err);
    res.status(500).json({ error: "Rider add nahi hua" });
  }
});

// ─── RIDERS — REMOVE ──────────────────────────────────────────────────────────
router.delete("/riders/:phone", async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("users").where("phone", "==", req.params.phone).get();
    if (!snap.empty) {
      await db.collection("users").doc(snap.docs[0].id).update({ role: "user" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Remove nahi hua" });
  }
});


// ─── RIDERS — EDIT ────────────────────────────────────────────────────────────
router.patch("/riders/:id", async (req, res) => {
  try {
    const { name, phone } = req.body;
    const db = getDb();
    const updateData = {};
    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    await db.collection("users").doc(req.params.id).update(updateData);
    if (name && phone) {
      const snap = await db.collection("orders").where("riderPhone", "==", phone).get();
      if (!snap.empty) {
        const batch = db.batch();
        snap.docs.forEach(doc => batch.update(doc.ref, { rider: name }));
        await batch.commit();
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Rider edit error:", err);
    res.status(500).json({ error: "Edit nahi hua: " + err.message });
  }
});

module.exports = router;
