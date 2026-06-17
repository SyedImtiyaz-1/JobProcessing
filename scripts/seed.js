// Fire a mixed batch of jobs at the API to exercise the queue / retries /
// rate limiting. Usage: node scripts/seed.js [count] [baseUrl]

const count = Number(process.argv[2] || 40);
const base = process.argv[3] || 'http://localhost:3000';
const priorities = ['HIGH', 'NORMAL', 'LOW'];
const types = ['image-resize', 'report-gen', 'data-export', 'email-batch'];
const clients = ['acme-co', 'globex', 'initech'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

let ok = 0;
let limited = 0;
await Promise.all(
  Array.from({ length: count }, async (_, i) => {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': pick(clients) },
      body: JSON.stringify({ type: pick(types), priority: pick(priorities), payload: { i } }),
    });
    if (res.status === 429) limited++;
    else if (res.ok) ok++;
  }),
);
console.log(`seeded: ${ok} accepted, ${limited} rate-limited (429)`);
