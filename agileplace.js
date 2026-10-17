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

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

// Board custom fields by lowercase label, loaded once.
// API docs: GET /io/board/:boardId/customfield -> { customFields: [{ id, label, type }] }
let boardFieldsPromise;
function getBoardFields() {
  if (!boardFieldsPromise) {
    boardFieldsPromise = (async () => {
      const res = await fetch(`${BASE_URL}/io/board/${BOARD_ID}/customfield`, { headers: HEADERS });
      if (!res.ok) {
        throw new Error(`AgilePlace custom field lookup failed (${res.status}): ${await res.text()}`);
      }
      const { customFields = [] } = await res.json();
      return new Map(customFields.map((f) => [String(f.label).trim().toLowerCase(), f]));
    })().catch((err) => {
      boardFieldsPromise = null; // try again next time
      throw err;
    });
  }
  return boardFieldsPromise;
}

// Turn { "Field Label": value } into the API's [{ fieldId, value }], skipping
// empty values and labels that don't exist on the board.
async function resolveCustomFields(byLabel) {
  const entries = Object.entries(byLabel).filter(([, v]) => v != null && v !== "");
  if (!entries.length) return [];

  let fields;
  try {
    fields = await getBoardFields();
  } catch (err) {
    console.warn(err.message, "- creating card without custom fields");
    return [];
  }

  const result = [];
  for (const [label, value] of entries) {
    const field = fields.get(label.toLowerCase());
    if (!field) {
      console.warn(`AgilePlace board has no custom field "${label}", skipping it`);
      continue;
    }
    result.push({ fieldId: String(field.id), value: field.type === "number" ? Number(value) : String(value) });
  }
  return result;
}

// Create a card and return its id. Retries only on 429 (rate limited), since
// retrying a 5xx could create a duplicate if the card was actually saved.
// API docs: POST /io/card/ with { destination, title, customId, customFields } -> 201 { id }
// header is shown at the top of the card; customFields is { "Field Label": value }.
async function createCard({ title, header, customFields = {} }) {
  const destination = LANE_ID ? { laneId: LANE_ID } : { boardId: BOARD_ID };
  const body = { destination, title };
  if (header) body.customId = header; // must be a plain string (docs example shows an object, API rejects it)
  const resolved = await resolveCustomFields(customFields);
  if (resolved.length) body.customFields = resolved;

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE_URL}/io/card/`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
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
