// concurrency_test.js
// Usage: node concurrency_test.js [concurrency] [url]
// Example: node concurrency_test.js 10 http://localhost:5000/api/reservations

const concurrency = Number(process.argv[2] || 10);
const url = process.argv[3] || 'http://localhost:5000/api/reservations';

// Fetch fallback for Node versions without global fetch
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    // Try require node-fetch (v2) as fallback
    // If not installed, instruct user to install or use Node 18+
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fetchFn = require('node-fetch');
    console.log('Using node-fetch fallback');
  } catch (e) {
    console.error('Global fetch is not available. Please run on Node 18+ or install node-fetch: npm install node-fetch');
    process.exit(1);
  }
}


async function sendReservation(i) {
  const payload = {
    room_id: 1,
    guest_name: `Test Guest ${i}`,
    guest_phone: `0811000${100 + i}`,
    check_in: new Date().toISOString().slice(0,10),
    check_out: new Date(Date.now() + 24*3600*1000).toISOString().slice(0,10),
    total_price: 100000,
    qty: 1
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-Id': `test-${Date.now()}-${i}`
      },
      body: JSON.stringify(payload)
    });
    const text = await resp.text();
    return { i, status: resp.status, body: text };
  } catch (err) {
    return { i, error: err.message };
  }
}

(async function main(){
  console.log(`Running ${concurrency} concurrent reservation requests to ${url}`);
  const promises = [];
  for (let i=0;i<concurrency;i++) promises.push(sendReservation(i));
  const results = await Promise.all(promises);
  const success = results.filter(r => r.status && r.status < 300);
  const conflict = results.filter(r => r.status === 409);
  const error = results.filter(r => r.error || (r.status && r.status >= 500));

  console.log('--- Results ---');
  console.log(`Total: ${results.length}, Success: ${success.length}, Conflict: ${conflict.length}, Error: ${error.length}`);
  console.log('\nSuccess responses:');
  success.slice(0,10).forEach(s => console.log(`#${s.i} status=${s.status} body=${s.body}`));
  console.log('\nConflict responses (409):');
  conflict.slice(0,10).forEach(s => console.log(`#${s.i} status=${s.status} body=${s.body}`));
  if (error.length) {
    console.log('\nErrors:');
    error.slice(0,10).forEach(s => console.log(JSON.stringify(s)));
  }
})();
