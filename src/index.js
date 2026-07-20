const express = require("express");
const config  = require("./config");
const { initFirebase } = require("./firebase");
const { initWhatsApp } = require("./whatsapp");
const apiRouter = require("./api");

// ─── LOAD SERVICE ACCOUNT ─────────────────────────────────────────────────────
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Firebase credentials loaded from environment variable");
  } else {
    serviceAccount = require("../serviceAccountKey.json");
    console.log("✅ Firebase credentials loaded from serviceAccountKey.json");
  }
} catch (e) {
  console.error("\n❌ Firebase credentials nahi mile!");
  process.exit(1);
}

async function start() {
  console.log(`\n🚰 ${config.BUSINESS_NAME} — Backend Starting...\n`);

  // 1. Firebase
  initFirebase(serviceAccount);

  // 2. Express
  const app = express();
  app.use(require("cors")({ origin: "*", methods: ["GET","POST","PATCH","DELETE","OPTIONS"], allowedHeaders: ["Content-Type"] }));
  app.use(express.json());
  app.use("/api", apiRouter);

  app.get("/", (req, res) => {
    res.send(`
      <html><body style="background:#060d1a;color:#fff;font-family:sans-serif;padding:40px;">
      <h2>🚰 ${config.BUSINESS_NAME}</h2>
      <p>Firebase: ✅ Connected</p>
      <p>WhatsApp: ✅ Cloud API Ready</p>
      <p><a href="/api/health" style="color:#69f0ae">Health Check →</a></p>
      </body></html>
    `);
  });

  app.listen(config.PORT, () => {
    console.log(`✅ API Server running on port ${config.PORT}`);
    console.log(`👉 Health check: http://localhost:${config.PORT}/api/health`);
  });

  // 3. WhatsApp Cloud API
  initWhatsApp(app);
  console.log("✅ Sab kuch ready! System chal raha hai.\n");
}

start().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});
