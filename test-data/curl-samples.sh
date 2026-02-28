#!/usr/bin/env bash
# Trust Platform – sample API requests (retail banking)
# Start server first: npm start

BASE_URL="${BASE_URL:-http://localhost:3000}"

echo "=== Trust decision samples (POST ${BASE_URL}/trust/decision) ==="

echo -e "\n1. Balance inquiry"
curl -s -X POST "${BASE_URL}/trust/decision" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_retail_001","action":"balance_inquiry","device_id":"dev_abc123"}' | jq .

echo -e "\n2. View statements"
curl -s -X POST "${BASE_URL}/trust/decision" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_retail_002","action":"view_statements","device_id":"dev_xyz789"}' | jq .

echo -e "\n3. Bill pay"
curl -s -X POST "${BASE_URL}/trust/decision" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_retail_003","action":"bill_pay","device_id":"dev_trusted_001"}' | jq .

echo -e "\n4. Internal transfer"
curl -s -X POST "${BASE_URL}/trust/decision" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_retail_004","action":"internal_transfer","device_id":"dev_new_phone"}' | jq .

echo -e "\n5. Wire transfer"
curl -s -X POST "${BASE_URL}/trust/decision" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_retail_005","action":"wire_transfer","device_id":"dev_abc123"}' | jq .

echo -e "\n6. P2P send (Zelle)"
curl -s -X POST "${BASE_URL}/trust/decision" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_retail_006","action":"p2p_send","device_id":"dev_xyz789"}' | jq .

echo -e "\n7. Change password"
curl -s -X POST "${BASE_URL}/trust/decision" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_retail_007","action":"change_password","device_id":"dev_trusted_001"}' | jq .

echo -e "\n8. Login from new device"
curl -s -X POST "${BASE_URL}/trust/decision" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_retail_008","action":"login","device_id":"dev_first_time_999"}' | jq .
