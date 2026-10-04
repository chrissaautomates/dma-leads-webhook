// Read-only: lists every attribute key CheckCherry's /leads feed actually
// returns, how many leads have it non-null, and one sample value — to confirm
// the attribute names mapCheckCherryLead() (sync.js) guesses at for event date,
// guest count, budget and owner (CC_*_KEYS), then trim those lists to the real
// names.
//
//   CHECKCHERRY_API_KEY=... node scripts/inspect-checkcherry-leads.js
//
// Sample values can be personal data: they are truncated, and nothing is stored.

async function main() {
  const apiKey = process.env.CHECKCHERRY_API_KEY;
  if (!apiKey) throw new Error('CHECKCHERRY_API_KEY is not set');
  const stats = new Map();
  let total = 0;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`https://api.checkcherry.com/api/v1/leads?page=${page}&per=100`, { headers: { 'Api-Key': apiKey } });
    if (!res.ok) throw new Error(`CheckCherry HTTP ${res.status}`);
    const body = await res.json();
    const records = Array.isArray(body) ? body : (body.leads || body.data || []);
    if (!records.length) break;
    for (const r of records) {
      total++;
      Object.entries((r && r.attributes) || r || {}).forEach(([k, v]) => {
        const s = stats.get(k) || { filled: 0, sample: '' };
        if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) {
          s.filled++;
          if (!s.sample) s.sample = JSON.stringify(v).slice(0, 40);
        }
        stats.set(k, s);
      });
    }
    if (records.length < 100) break;
  }
  console.log(`${total} leads scanned\n`);
  [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, s]) => {
    console.log(`${k.padEnd(34)} ${String(s.filled).padStart(5)} filled   e.g. ${s.sample}`);
  });
}

main().catch((err) => { console.error(err.message); process.exit(1); });
