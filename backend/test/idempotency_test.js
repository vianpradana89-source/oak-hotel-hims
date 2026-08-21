// idempotency_test.js
// Sends two concurrent identical requests with same Idempotency-Key and checks response equality

const url = process.argv[2] || 'http://localhost:5000/api/reservations';
const key = 'idem-test-' + Date.now();

// fetch fallback
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try { fetchFn = require('node-fetch'); console.log('Using node-fetch'); } catch(e){ console.error('Install node-fetch or use Node 18+'); process.exit(1); }
}

const payload = {
  room_id: 1,
  guest_name: 'Idem Tester',
  guest_phone: '081900000000',
  check_in: new Date().toISOString().slice(0,10),
  check_out: new Date(Date.now()+24*3600*1000).toISOString().slice(0,10),
  total_price: 100000,
  qty: 1
};

async function send(i) {
  const resp = await fetchFn(url, { method: 'POST', headers: { 'Content-Type':'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
  const text = await resp.text();
  return { i, status: resp.status, body: text };
}

(async ()=>{
  console.log('Sending 2 concurrent requests with same idempotency key:', key);
  const p1 = send(1); const p2 = send(2);
  const [r1, r2] = await Promise.all([p1, p2]);
  console.log('Response 1:', r1.status, r1.body);
  console.log('Response 2:', r2.status, r2.body);
  if (r1.body === r2.body) console.log('OK: responses identical'); else console.log('FAIL: responses differ');
})();
