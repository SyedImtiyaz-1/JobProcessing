// Dashboard logic: job submission + live SSE feed.

const $ = (id) => document.getElementById(id);

/* ---------- counters ---------- */
const counts = { submitted: 0, completed: 0, retrying: 0, failed: 0, limited: 0 };
const bump = (k, n = 1) => {
  counts[k] += n;
  $(`c-${k}`).textContent = counts[k];
};

/* ---------- submit ---------- */
async function submitJobs(n) {
  const clientId = $('clientId').value || 'anonymous';
  const type = $('type').value;
  const priority = $('priority').value;
  let ok = 0;
  let limited = 0;
  for (let i = 0; i < n; i++) {
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-client-id': clientId },
        body: JSON.stringify({ type, priority, payload: { n: i } }),
      });
      if (res.status === 429) { limited++; bump('limited'); }
      else if (res.ok) ok++;
    } catch { /* ignore */ }
  }
  $('submitMsg').textContent =
    `Submitted ${ok}/${n}` + (limited ? ` - ${limited} rate-limited (429)` : '');
}

$('submitBtn').addEventListener('click', () => submitJobs(Math.max(1, +$('count').value || 1)));
$('burstBtn').addEventListener('click', () => submitJobs(25));

/* ---------- queue + worker stats ---------- */
function renderStats(s) {
  $('d-HIGH').textContent = s.depth.HIGH;
  $('d-NORMAL').textContent = s.depth.NORMAL;
  $('d-LOW').textContent = s.depth.LOW;
  $('active').textContent = s.active;
  $('capacity').textContent = s.capacity;
  $('clientsRunning').textContent = s.clientsRunning;
}

/* ---------- live feed ---------- */
const feed = $('feed');
const rows = new Map(); // jobId -> <tr>
const MAX_ROWS = 120;

const shortId = (id) => id.slice(0, 8);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString();

function upsert(ev) {
  if (ev.status === 'queued') bump('submitted');
  if (ev.status === 'completed') bump('completed');
  if (ev.status === 'retrying') bump('retrying');
  if (ev.status === 'failed') bump('failed');

  let tr = rows.get(ev.jobId);
  if (!tr) {
    tr = document.createElement('tr');
    rows.set(ev.jobId, tr);
    feed.prepend(tr);
    if (rows.size > MAX_ROWS) {
      const oldestId = [...rows.keys()][0];
      rows.get(oldestId)?.remove();
      rows.delete(oldestId);
    }
  }
  const detail = ev.error
    ? ev.error
    : ev.result
    ? ev.result.output || ''
    : '';
  tr.innerHTML = `
    <td class="mono">${shortId(ev.jobId)}</td>
    <td>${ev.clientId || ''}</td>
    <td>${ev.type || ''}</td>
    <td>${ev.priority || ''}</td>
    <td>${ev.status}</td>
    <td class="mono">${ev.attempts ?? ''}</td>
    <td>${detail}</td>
    <td class="mono">${fmtTime(ev.ts)}</td>`;
}

/* ---------- SSE connection ---------- */
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => {
    $('conn').textContent = 'live';
    $('conn').className = 'conn on';
  });
  es.addEventListener('update', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('stats', (e) => renderStats(JSON.parse(e.data)));
  es.addEventListener('error', () => {
    $('conn').textContent = 'reconnecting';
    $('conn').className = 'conn';
  });
}
connect();
