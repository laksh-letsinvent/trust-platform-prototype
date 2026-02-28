# Data stores

Data holds **raw scores and attributes only** (e.g. fraud_score, trust_level, confidence_level). Risk bands and confidence formulas are defined in **policy** (see `policies/confidence.json`).

Data can come from **Google Sheets** (when configured) or from **local JSON files** in this folder.

## Google Sheets (recommended for managing users, devices, actions)

1. **Create a Google Cloud project** and enable the [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com).
2. **Create a service account** (APIs & Services → Credentials → Create credentials → Service account). Download the JSON key.
3. **Create a spreadsheet** with four sheets exactly named: **Users**, **Devices**, **Actions**, **Authenticators**.
4. **Share the spreadsheet** with the service account email (e.g. `xxx@yyy.iam.gserviceaccount.com`) as Viewer.
5. **Set environment variables**:
   - `GOOGLE_SHEETS_SPREADSHEET_ID` – the ID from the spreadsheet URL (`https://docs.google.com/spreadsheets/d/<THIS_ID>/edit`).
   - `GOOGLE_APPLICATION_CREDENTIALS` – path to the service account JSON key file (or use `GOOGLE_SHEETS_CREDENTIALS_PATH`).

Optional: `SHEETS_CACHE_MS` (default 60000) – cache sheet data for this many milliseconds.

### Sheet layout (first row = headers)

| Sheet           | Columns                                                                 |
|----------------|-------------------------------------------------------------------------|
| **Users**      | customer_id, fraud_score, geography (UK / DE)                           |
| **Devices**    | device_id, device_score (0–100 number)                                  |
| **Actions**    | id, name, tier (LOW / MEDIUM / HIGH), required_confidence (number)       |
| **Authenticators** | id, name, confidence_level (number), description                    |

- **Users**: one row per customer; **fraud_score** and optional geography.
- **Devices**: one row per device; **device_score** is a number (0–100). No geography or customer link.

Header names are normalized (e.g. "Customer ID" or "customer_id" both work).

## Local JSON (fallback)

When `GOOGLE_SHEETS_SPREADSHEET_ID` is not set, the app reads from:

- **users.json** – `users`: array of `{ customer_id, fraud_score, geography }`
- **devices.json** – `devices`: array of `{ device_id, device_score }`
- **actions.json** – `actions`: array of `{ id, name, tier, required_confidence }`
- **authenticators.json** – `authenticators`: array of `{ id, name, confidence_level, description }`

Edit these files to add or change data when not using Sheets.
