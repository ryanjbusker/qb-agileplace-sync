// ---- Configuration (all from Render environment variables) ----
const BASE_URL = (process.env.AGILEPLACE_URL || "").replace(/\/+$/, ""); // https://yourcompany.leankit.com
const TOKEN = process.env.AGILEPLACE_TOKEN;
const BOARD_ID = process.env.AGILEPLACE_BOARD_ID;
const LANE_ID = process.env.AGILEPLACE_LANE_ID; // optional; default drop lane if unset

for (const [name, value] of Object.entries({
  AGILEPLACE_URL: BASE_URL,
  AGILEPLACE_TOKEN: TOKEN,
  AGILEPLACE_BOARD_ID: BOARD_ID,
})) {
  if (!value) console.warn(`Missing environment variable: ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create a card and return its id. Retries only on 429 (rate limited), since
// retrying a 5xx could create a duplicate if the card was actually saved.
// API docs: POST /io/card/ with { destination, title } -> 201 { id }
async function createCard({ title }) {
  const destination = LANE_ID ? { laneId: LANE_ID } : { boardId: BOARD_ID };

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE_URL}/io/card/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ destination, title }),
    });

    if (res.ok) {
      const body = await res.json();
      return String(body.id);
    }

    if (res.status !== 429 || attempt >= 3) {
      const text = await res.text();
      throw new Error(`AgilePlace create card failed (${res.status}): ${text}`);
    }
    await sleep(attempt * 2000);
  }
}

module.exports = { createCard };
