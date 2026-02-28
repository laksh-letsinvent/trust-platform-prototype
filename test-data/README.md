# Test data – Trust Platform API

**Endpoint:** `POST http://localhost:3000/trust/decision`  
**Body:** `application/json` with required fields: `customer_id`, `action`, `device_id`.

Start the server first: `npm start`

---

## Single request (curl)

```bash
curl -X POST http://localhost:3000/trust/decision \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_retail_001","action":"balance_inquiry","device_id":"dev_abc123"}'
```

## Run all samples

```bash
cd test-data && chmod +x curl-samples.sh && ./curl-samples.sh
```

Requires `jq` for pretty output; or remove `| jq .` from the script.

---

## Request body reference

| Field         | Type   | Required | Example / notes                    |
|---------------|--------|----------|------------------------------------|
| `customer_id` | string | Yes      | `cust_retail_001`                  |
| `action`      | string | Yes      | `balance_inquiry`, `wire_transfer` |
| `device_id`   | string | Yes      | `dev_abc123`                       |

## Example response

```json
{
  "decision": "ALLOW",
  "step_up_type": null,
  "reason": "Routine retail banking (e.g. balance inquiry, statements) on trusted device."
}
```

Decisions: `ALLOW` | `STEP_UP` | `DENY`. When `STEP_UP`, `step_up_type` may be `PASSKEY` or `OTP`.
