// Prüft alle paar Minuten, ob eine Erinnerung fällig ist, und schickt sie als Push-Nachricht.
// Läuft als GitHub Action (.github/workflows/push.yml) mit TZ=Europe/Berlin.
// Secret PUSH_GEHEIM = "<Familien-Code>|<VAPID Private Key>", erzeugt in der App unter Familie > Push-Nachrichten.
// Der passende öffentliche Schlüssel liegt in config/push. DRY=1 zeigt nur an, was gesendet würde.
import webpush from 'web-push';

const API_KEY = 'AIzaSyA40ZFUpG5i5G8337ItJ4yxnHyGPW4iKgw';
const PROJECT = 'frahm-a5202';
const APP_URL = 'https://jannikfrahm1-design.github.io/Frahm/';
const DRY = !!process.env.DRY;

const [CODE, VAPID_PRIVATE] = String(process.env.PUSH_GEHEIM || '').split('|').map(s => s.trim());
if (!CODE || !VAPID_PRIVATE) { console.log('Secret PUSH_GEHEIM fehlt, nichts zu tun.'); process.exit(0); }

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/families/${CODE}`;

/* ---------- Firestore REST ---------- */
function val(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  if ('mapValue' in v) return obj(v.mapValue.fields);
  return null;
}
function obj(f) { const o = {}; for (const k in f || {}) o[k] = val(f[k]); return o; }
function fromDoc(d) { return Object.assign({ id: d.name.split('/').pop() }, obj(d.fields)); }
async function list(col) {
  const out = []; let tok = '';
  do {
    const r = await fetch(`${BASE}/${col}?key=${API_KEY}&pageSize=300${tok ? '&pageToken=' + tok : ''}`);
    if (!r.ok) throw new Error(`${col}: ${r.status} ${await r.text()}`);
    const j = await r.json(); (j.documents || []).forEach(d => out.push(fromDoc(d))); tok = j.nextPageToken || '';
  } while (tok);
  return out;
}
async function get(path) {
  const r = await fetch(`${BASE}/${path}?key=${API_KEY}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return fromDoc(await r.json());
}
// Legt das Dokument nur an, wenn es noch nicht existiert. true = wir sind die Ersten.
async function claim(id, date) {
  if (DRY) return true;
  const r = await fetch(`${BASE}/pushlog?documentId=${encodeURIComponent(id)}&key=${API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { date: { stringValue: date }, at: { integerValue: String(Date.now()) } } })
  });
  if (r.ok) return true;
  if (r.status === 409) return false;
  throw new Error(`pushlog ${id}: ${r.status} ${await r.text()}`);
}
async function del(path) { if (!DRY) await fetch(`${BASE}/${path}?key=${API_KEY}`, { method: 'DELETE' }); }

const pushCfg = await get('config/push');
if (!pushCfg || !pushCfg.vapidPublic) { console.log('Push ist in der App noch nicht eingerichtet.'); process.exit(0); }
webpush.setVapidDetails('mailto:frahm@users.noreply.github.com', pushCfg.vapidPublic, VAPID_PRIVATE);

/* ---------- Datum ---------- */
const pad = n => String(n).padStart(2, '0');
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const diffDays = (a, b) => Math.round((parse(key(b)) - parse(key(a))) / 864e5);
const at = (d, hhmm) => { const [h, m] = hhmm.split(':').map(Number); const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
const today = parse(key(now));
const tomorrow = addDays(today, 1);
const T = key(today);
const inWin = (from, to) => now >= from && now < to;

/* ---------- Müll: gleiche Logik wie nextPickup() in index.html ---------- */
const BINS = [
  { id: 'rest', n: 'Restabfall (graue Tonne)', w: 2 },
  { id: 'bio', n: 'Bioabfall (Biotonne)', w: 2 },
  { id: 'gelb', n: 'Wertstofftonne (gelbe Tonne)', w: 2 },
  { id: 'papier', n: 'Papier (blaue Tonne)', w: 4 }
];
function nextPickup(muell, bin, from) {
  const cfg = muell && muell[bin.id]; if (!cfg) return null;
  const dates = (Array.isArray(cfg.dates) ? cfg.dates : []).slice().sort();
  const listed = dates.find(k => parse(k) >= from);
  if (listed) return parse(listed);
  if (!cfg.start) return null;
  const d = parse(cfg.start), step = (+cfg.weeks || bin.w) * 7;
  let floor = from; const last = dates[dates.length - 1];
  if (last && addDays(parse(last), Math.ceil(step / 2)) > floor) floor = addDays(parse(last), Math.ceil(step / 2));
  if (d >= floor) return d;
  const n = Math.ceil(diffDays(d, floor) / step); return addDays(d, n * step);
}

/* ---------- Was ist fällig? ---------- */
async function due() {
  const out = []; // {id, title, body, to?: name}
  const [tasks, events, bdays, muellDoc] = await Promise.all([list('tasks'), list('events'), list('birthdays'), get('config/muell')]);

  // Aufgaben mit Frist: 30 Minuten vorher, wenn noch nicht abgehakt
  for (const c of tasks) {
    if (!c.t || !/^\d\d:\d\d$/.test(c.due || '')) continue;
    const once = /^\d{4}-\d\d-\d\d$/.test(c.once || '') ? c.once : '';
    const days = Array.isArray(c.days) && c.days.length && c.days.length < 7 ? c.days : null;
    if (once ? once !== T : days && !days.includes(today.getDay())) continue;
    const dl = at(today, c.due);
    if (!inWin(new Date(dl - 30 * 6e4), new Date(+dl + 60 * 6e4))) continue;
    if (await get(`done/${T}_c-${c.id}`)) continue;
    const late = now >= dl;
    out.push({ id: `frist_${T}_${c.id}`, title: late ? '⏰ Frist vorbei' : '⏰ Bald fällig', body: `${c.t}: ${late ? 'sollte bis' : 'bis'} ${c.due} Uhr erledigt sein`, to: c.who || '' });
  }

  // Müll: am Vorabend ab 18 Uhr
  if (inWin(at(today, '18:00'), at(today, '22:00'))) {
    const muell = muellDoc || {};
    const bins = BINS.filter(b => { const p = nextPickup(muell, b, tomorrow); return p && key(p) === key(tomorrow); });
    if (bins.length) out.push({ id: `muell_${key(tomorrow)}`, title: '🗑️ Morgen ist Müllabfuhr', body: bins.map(b => b.n).join(', ') + ' – heute Abend rausstellen' });
  }

  // Geburtstage: am Tag ab 8 Uhr
  if (inWin(at(today, '08:00'), at(today, '21:00'))) {
    for (const b of bdays) {
      const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(b.date || ''); if (!b.name || !m) continue;
      const y = +m[1], mo = +m[2] - 1, d = +m[3];
      let hit = today.getMonth() === mo && today.getDate() === d;
      // 29. Februar in Nicht-Schaltjahren am 28. feiern
      if (mo === 1 && d === 29 && addDays(new Date(today.getFullYear(), 1, 28), 1).getMonth() !== 1) hit = today.getMonth() === 1 && today.getDate() === 28;
      if (!hit || (y && y > today.getFullYear())) continue;
      const age = y ? today.getFullYear() - y : null;
      out.push({ id: `bd_${T}_${b.id}`, title: '🎂 Geburtstag', body: `${b.name} hat heute Geburtstag${age ? ` und wird ${age}` : ''}! 🎉` });
    }
  }

  // Termine: mit Uhrzeit eine Stunde vorher, ohne Uhrzeit morgens um 7
  for (const e of events) {
    if (!e.title || e.date !== T) continue;
    const timed = /^\d\d:\d\d$/.test(e.time || '');
    const ok = timed ? inWin(new Date(at(today, e.time) - 60 * 6e4), at(today, e.time)) : inWin(at(today, '07:00'), at(today, '21:00'));
    if (!ok) continue;
    const who = Array.isArray(e.persons) && e.persons.length ? ' · ' + e.persons.join(', ') : '';
    out.push({ id: `ev_${T}_${e.id}`, title: '📅 ' + (timed ? `Um ${e.time}: ` : 'Heute: ') + e.title, body: (e.place ? e.place : 'Termin') + who });
  }
  return out;
}

/* ---------- Senden ---------- */
const subs = await list('push');
if (DRY && !subs.length) subs.push({ id: 'test', name: '', endpoint: 'x' });
const items = await due();
console.log(`${hm(now)} · ${subs.length} Handy(s) angemeldet · ${items.length} fällig`);
for (const it of items) {
  const targets = subs.filter(s => s.endpoint && (!it.to || !s.name || s.name === it.to));
  if (!targets.length) continue;
  if (!(await claim(it.id, T))) continue; // schon geschickt
  const payload = JSON.stringify({ title: it.title, body: it.body, tag: it.id, url: APP_URL });
  for (const s of targets) {
    if (DRY) { console.log(`[DRY] an ${s.name || '?'}: ${it.title} – ${it.body}`); continue; }
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 4 * 3600 }); console.log(`gesendet an ${s.name || '?'}: ${it.title}`); }
    catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { console.log(`Abo von ${s.name || '?'} abgelaufen, entfernt`); await del(`push/${s.id}`); }
      else console.log(`Fehler bei ${s.name || '?'}: ${err.statusCode || ''} ${err.body || err.message}`);
    }
  }
}

// Alte Protokoll-Einträge (älter als 14 Tage) aufräumen, einmal am Tag
if (now.getHours() === 3 && now.getMinutes() < 15) {
  const cut = key(addDays(today, -14));
  for (const l of await list('pushlog')) if (!l.date || l.date < cut) await del(`pushlog/${l.id}`);
}
