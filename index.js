const express = require("express");
const crypto = require("crypto");
const app = express();

const VERIFIER_TOKEN = process.env.QBO_WEBHOOK_VERIFIER;

// Health check so you can confirm the service is up in a browser
app.get("/", (req, res) => res.send("OK"));

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

  const payload = JSON.parse(req.body.toString());
  for (const n of payload.eventNotifications || []) {
    for (const e of n.dataChangeEvent?.entities || []) {
      console.log("QBO event:", n.realmId, e.name, e.id, e.operation);
      // TODO: fetch project from QBO, create card in AgilePlace
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));