const express = require("express");
const crypto = require("crypto");
const { pool } = require("./db");

// ---- Configuration (all from Render environment variables) ----
const CLIENT_ID = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const REDIRECT_URI = process.env.QBO_REDIRECT_URI; // https://qb-agileplace-sync.onrender.com/auth/callback
const ADMIN_KEY = process.env.ADMIN_KEY; // secret you add to /auth/connect?key=...
const SCOPES = process.env.QBO_SCOPES || "com.intuit.quickbooks.accounting";
const IS_SANDBOX = process.env.QBO_ENV === "sandbox";

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const API_BASE = IS_SANDBOX
  ? "https://sandbox-quickbooks.api.intuit.com"
  : "https://quickbooks.api.intuit.com";
const MINOR_VERSION = 75;

for (const [name, value] of Object.entries({
  QBO_CLIENT_ID: CLIENT_ID,
  QBO_CLIENT_SECRET: CLIENT_SECRET,
  QBO_REDIRECT_URI: REDIRECT_URI,
  ADMIN_KEY,
})) {
  if (!value) console.warn(`Missing environment variable: ${name}`);
}

// ---- Helpers ----
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function tokenRequest(params) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intuit token request failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function saveTokens(realmId, tok) {
  // Intuit rotates refresh tokens, so always store the newest one
  await pool.query(
    `INSERT INTO qbo_tokens (realm_id, refresh_token, access_token, expires_at, updated_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), now())
     ON CONFLICT (realm_id) DO UPDATE SET
       refresh_token = EXCLUDED.refresh_token,
       access_token  = EXCLUDED.access_token,
       expires_at    = EXCLUDED.expires_at,
       updated_at    = now()`,
    [realmId, tok.refresh_token, tok.access_token, Number(tok.expires_in)]
  );
}

// Prevents two simultaneous refreshes from invalidating each other's token
const refreshing = new Map();

async function getAccessToken(realmId) {
  const { rows } = await pool.query(
    "SELECT refresh_token, access_token, expires_at FROM qbo_tokens WHERE realm_id = $1",
    [realmId]
  );
  if (!rows.length) {
    throw new Error(`No tokens stored for realm ${realmId}. Visit /auth/connect first.`);
  }
  const row = rows[0];

  const stillValid =
    row.access_token &&
    row.expires_at &&
    new Date(row.expires_at).getTime() - Date.now() > 60 * 1000;
  if (stillValid) return row.access_token;

  if (!refreshing.has(realmId)) {
    const p = (async () => {
      const tok = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: row.refresh_token,
      });
      await saveTokens(realmId, tok);
      return tok.access_token;
    })().finally(() => refreshing.delete(realmId));
    refreshing.set(realmId, p);
  }
  return refreshing.get(realmId);
}

// GET from the QuickBooks API, e.g. qboGet(realmId, "estimate/123")
async function qboGet(realmId, path) {
  const accessToken = await getAccessToken(realmId);
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API_BASE}/v3/company/${realmId}/${path}${sep}minorversion=${MINOR_VERSION}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QuickBooks API error (${res.status}): ${text}`);
  }
  return res.json();
}

// ---- Routes ----
const router = express.Router();
const pendingStates = new Map(); // state -> expiry timestamp (fine for a single instance)

router.get("/auth/connect", (req, res) => {
  if (!ADMIN_KEY || !safeEqual(req.query.key, ADMIN_KEY)) {
    return res.sendStatus(403);
  }
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now() + 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });
  res.redirect(`${AUTH_URL}?${params}`);
});

router.get("/auth/callback", async (req, res) => {
  try {
    const { code, state, realmId, error } = req.query;
    if (error) return res.status(400).send(`Authorization failed: ${error}`);

    const expiry = pendingStates.get(state);
    pendingStates.delete(state);
    if (!expiry || expiry < Date.now()) {
      return res.status(400).send("Invalid or expired state. Start again at /auth/connect.");
    }
    if (!code || !realmId) {
      return res.status(400).send("Missing code or realmId.");
    }

    const tok = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });
    await saveTokens(realmId, tok);

    console.log(`Connected QuickBooks company (realm ${realmId})`);
    res.send(`Connected! Company ID ${realmId} is now linked. You can close this tab.`);
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).send("Something went wrong connecting to QuickBooks. Check the logs.");
  }
});

module.exports = { router, getAccessToken, qboGet };
