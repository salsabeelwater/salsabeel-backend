const admin = require("firebase-admin");
const config = require("./config");

let db = null;

function initFirebase(serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: config.FIREBASE_PROJECT_ID,
  });
  db = admin.firestore();
  console.log("✅ Firebase connected:", config.FIREBASE_PROJECT_ID);
  return db;
}

function listenForNewOrders(onNewOrder) {
  if (!db) return;
  db.collection("orders").where("notifiedPlaced", "==", false).onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === "added") {
        const order = { id: change.doc.id, ...change.doc.data() };
        await onNewOrder(order);
        await db.collection("orders").doc(order.id).update({ notifiedPlaced: true });
      }
    });
  });
}

function listenForStatusChanges(onStatusChange) {
  if (!db) return;
  db.collection("orders").onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === "modified") {
        const order = { id: change.doc.id, ...change.doc.data() };
        if (order.statusNotified !== order.status) {
          await onStatusChange(order);
          await db.collection("orders").doc(order.id).update({ statusNotified: order.status });
        }
      }
    });
  });
}

async function getNextOrderNumber() {
  const counterRef = db.collection("meta").doc("orderCounter");
  const result = await db.runTransaction(async (t) => {
    const doc = await t.get(counterRef);
    const nextNum = (doc.exists ? doc.data().count : 0) + 1;
    t.set(counterRef, { count: nextNum });
    return nextNum;
  });
  return String(result).padStart(6, "0");
}

async function saveOrder(order) {
  if (!db) throw new Error("Firebase not initialized");
  const orderNum = await getNextOrderNumber();
  await db.collection("orders").doc(orderNum).set({
    ...order,
    notifiedPlaced: false,
    statusNotified: "placed",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return orderNum;
}

async function getAllOrders() {
  if (!db) return [];
  const snapshot = await db.collection("orders").orderBy("createdAt", "desc").limit(100).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// Only in-flight orders — used by the panels' polling loop to keep Firebase reads low.
// Excludes delivered/cancelled history (which is loaded separately via getAllOrders).
async function getActiveOrders() {
  if (!db) return [];
  const snapshot = await db.collection("orders")
    .where("status", "in", ["placed", "filling", "on my way", "arrived"])
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// Only a single customer's orders — used by the customer panel so a client never
// receives other customers' data. Single-field query (no composite index needed);
// caller sorts newest-first client-side.
async function getOrdersByPhone(phone) {
  if (!db) return [];
  const snapshot = await db.collection("orders").where("phone", "==", phone).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// Bot ke liye — customer ka pichla order fetch karo
async function getLastCustomerOrder(phone) {
  if (!db) return null;
  try {
    const snap = await db.collection("orders")
      .where("phone", "==", phone)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch (e) {
    console.error("getLastCustomerOrder error:", e.message);
    return null;
  }
}

// Bot conversations Firebase mein save karo (server restart pe bhi survive kare)
async function getConversationState(phone) {
  if (!db) return null;
  try {
    const doc = await db.collection("bot_conversations").doc(phone).get();
    if (!doc.exists) return null;
    const data = doc.data();
    // 15 min se purana ho toh delete karo
    const age = Date.now() - (data.lastActivity || 0);
    if (age > 60 * 60 * 1000) {
      await db.collection("bot_conversations").doc(phone).delete();
      return null;
    }
    return data;
  } catch (e) { return null; }
}

async function setConversationState(phone, state) {
  if (!db) return;
  try {
    await db.collection("bot_conversations").doc(phone).set({
      ...state,
      lastActivity: Date.now(),
    });
  } catch (e) { console.error("setConversationState error:", e.message); }
}

async function clearConversationState(phone) {
  if (!db) return;
  try {
    await db.collection("bot_conversations").doc(phone).delete();
  } catch (e) {}
}

// Fallback lookup for bot orders where phone was stored as LID (legacy data)
async function getLastCustomerOrderByChatId(chatId) {
  if (!db) return null;
  try {
    const snap = await db.collection("orders")
      .where("chatId", "==", chatId)
      .get();
    if (snap.empty) return null;
    const docs = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(o => o.createdAt)
      .sort((a, b) => (b.createdAt.toMillis?.() || 0) - (a.createdAt.toMillis?.() || 0));
    return docs[0] || null;
  } catch (e) {
    console.error("getLastCustomerOrderByChatId error:", e.message);
    return null;
  }
}

// Cancel the most recent "placed" order for a customer
async function cancelLastPlacedOrder(chatId, phone) {
  if (!db) return null;
  try {
    let order = null;
    if (phone) order = await getLastCustomerOrder(phone);
    if (!order) order = await getLastCustomerOrderByChatId(chatId);
    if (!order) return { error: "no_order" };
    if (order.status !== "placed") return { error: "not_cancellable", status: order.status };
    await db.collection("orders").doc(order.id).update({ status: "cancelled" });
    return { ...order, status: "cancelled" };
  } catch (e) {
    console.error("cancelLastPlacedOrder error:", e.message);
    return null;
  }
}

// LID JID → real phone mapping (persists across sessions for repeat customer recognition)
async function getWaContact(lidJid) {
  if (!db) return null;
  try {
    const doc = await db.collection("wa_contacts").doc(lidJid).get();
    return doc.exists ? doc.data() : null;
  } catch (e) { return null; }
}

async function saveWaContact(lidJid, phone) {
  if (!db) return;
  try {
    const ref = db.collection("wa_contacts").doc(lidJid);
    const doc = await ref.get();
    await ref.set({
      phone,
      firstSeen: doc.exists ? doc.data().firstSeen : admin.firestore.FieldValue.serverTimestamp(),
      lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.error("saveWaContact error:", e.message); }
}

module.exports = {
  initFirebase,
  listenForNewOrders,
  listenForStatusChanges,
  saveOrder,
  getAllOrders,
  getActiveOrders,
  getOrdersByPhone,
  getDb: () => db,
  getLastCustomerOrder,
  getConversationState,
  setConversationState,
  clearConversationState,
  getLastCustomerOrderByChatId,
  cancelLastPlacedOrder,
  getWaContact,
  saveWaContact,
};
