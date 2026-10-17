const express = require("express");
const crypto = require("crypto");
const { initDb } = require("./db");
const { router: qboRouter, qboGet } = require("./qbo");

const app = express();

initDb()
  .then(() => console.log("DB ready, tables ensured"))
  .catch((err) => console.error("DB init failed", err));

const VERIFIER_TOKEN = process.env.QBO_WEBHOOK_VERIFIER;

// Health check so you can confirm the service is up in a browser
app.get("/", (req, res) => res.send("OK"));

// OAuth routes: /auth/connect and /auth/callback
app.use(qboRouter);

// Handle one change event from QuickBooks
async function handleEvent(realmId, entity) {
  console.log("QBO event:", realmId, entity.name, entity.id, entity.operation);

  if (entity.name !== "Estimate" || entity.operation !== "Create") return;

  const data = await qboGet(realmId, `estimate/${entity.id}`);
  const est = data.Estimate;

  // Log just the key fields so you can see what is available to map
  console.log("Estimate fetched:", {
    id: est.Id,
    docNumber: est.DocNumber,
    customer: est.CustomerRef,
    status: est.TxnStatus,
    total: est.TotalAmt,
    txnDate: est.TxnDate,
    project: est.ProjectRef || null,
  });

  // TODO: create the card in AgilePlace, then record it in project_map
}

app.post("/webhooks/quickbooks", express.raw({ type: "*/*" }), (req, res) => {
  const signature = req.get("intuit-signature") || "";
  const expected = crypto
    .createHmac("sha256", VERIFIER_TOKEN || "")
    .update(req.body)
    .digest("base64");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.sendStatus(401);
  }

  res.sendStatus(200); // acknowledge fast

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch (err) {
    console.error("Invalid JSON body", err);
    return;
  }

  for (const n of payload.eventNotifications || []) {
    for (const e of n.dataChangeEvent?.entities || []) {
      handleEvent(n.realmId, e).catch((err) =>
        console.error("Error handling event:", err.message)
      );
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
