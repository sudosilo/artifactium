// Artifactium backend v1: specimen records, contributions and photos.
// Postgres holds records and photos. Redis caches the catalog list.
// Photos move to Cloudflare R2 automatically when the R2 variables are set.
import express from 'express';
import pg from 'pg';
import { createClient } from 'redis';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const PORT = process.env.PORT || 8080;
const DB_URL = process.env.DATABASE_URL;
const LIST_KEY = 'artifactium:list:v1';

const pool = new pg.Pool({
  connectionString: DB_URL,
  ssl: !DB_URL || DB_URL.includes('.railway.internal') ? false : { rejectUnauthorized: false },
  max: 8
});

let redis = null;
if (process.env.REDIS_URL) {
  redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', e => console.error('redis', e.message));
  redis.connect().catch(e => { console.error('redis connect', e.message); redis = null; });
}

const R2 = process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
    })
  : null;

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS specimens (
      code TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS photos (
      id BIGSERIAL PRIMARY KEY,
      code TEXT,
      mime TEXT NOT NULL DEFAULT 'image/jpeg',
      full_img BYTEA,
      thumb_img BYTEA,
      in_r2 BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS contributions (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS contributions_code ON contributions(code);
    CREATE TABLE IF NOT EXISTS counters (
      fam TEXT PRIMARY KEY,
      n INTEGER NOT NULL
    );
  `);
}

const CODE_RE = /^ART-[A-Z]{3}-\d{4,}$/;
const FAM_RE = /^[A-Z]{3}$/;
const PHOTO_URL_RE = /^\/api\/photos\/\d+\/(full|thumb)$/;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

function cleanRecord(rec, code) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('record missing');
  const r = { ...rec, code };
  delete r._t; delete r.sim;
  for (const k of ['photo', 'photoFull']) if (r[k] && !PHOTO_URL_RE.test(r[k])) delete r[k];
  if (JSON.stringify(r).length > 200000) throw new Error('record too large');
  return r;
}

function decodeImage(dataUrl, maxBytes) {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error('bad image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) throw new Error('image too large');
  return { mime: m[1], buf };
}

async function nextCode(fam) {
  const { rows } = await pool.query(
    `INSERT INTO counters (fam, n) VALUES ($1, 101)
     ON CONFLICT (fam) DO UPDATE SET n = counters.n + 1 RETURNING n`, [fam]);
  return `ART-${fam}-${String(rows[0].n).padStart(4, '0')}`;
}

async function storePhoto(code, full, thumb) {
  if (R2) {
    const { rows } = await pool.query(`INSERT INTO photos (code, mime, in_r2) VALUES ($1, $2, true) RETURNING id`, [code, full.mime]);
    const id = rows[0].id;
    await R2.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `photos/${id}-full`, Body: full.buf, ContentType: full.mime }));
    await R2.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `photos/${id}-thumb`, Body: (thumb || full).buf, ContentType: (thumb || full).mime }));
    return id;
  }
  const { rows } = await pool.query(
    `INSERT INTO photos (code, mime, full_img, thumb_img) VALUES ($1, $2, $3, $4) RETURNING id`,
    [code, full.mime, full.buf, (thumb || full).buf]);
  return rows[0].id;
}

async function dropCache() { if (redis) { try { await redis.del(LIST_KEY); } catch {} } }

let READY = false;
const app = express();
app.disable('x-powered-by');
app.get('/', (req, res) => res.json({ name: 'artifactium-backend', ready: READY, photos: R2 ? 'r2' : 'postgres' }));
app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api', (req, res, next) => READY ? next() : res.status(503).json({ error: 'starting up' }));

app.get('/health', async (req, res) => {
  let db = false;
  try { await pool.query('SELECT 1'); db = true; } catch {}
  res.json({ ok: db, db, redis: !!(redis && redis.isReady), photos: R2 ? 'r2' : 'postgres' });
});

app.get('/api/specimens', async (req, res) => {
  try {
    if (redis && redis.isReady) {
      const hit = await redis.get(LIST_KEY);
      if (hit) return res.type('application/json').send(hit);
    }
    const { rows } = await pool.query('SELECT data FROM specimens ORDER BY code');
    const body = JSON.stringify({ records: rows.map(r => r.data), at: new Date().toISOString() });
    if (redis && redis.isReady) await redis.set(LIST_KEY, body, { EX: 300 });
    res.type('application/json').send(body);
  } catch (e) { console.error(e); res.status(500).json({ error: 'list failed' }); }
});

app.get('/api/specimens/:code', async (req, res) => {
  if (!CODE_RE.test(req.params.code)) return res.status(400).json({ error: 'bad code' });
  const { rows } = await pool.query('SELECT data FROM specimens WHERE code = $1', [req.params.code]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const notes = await pool.query('SELECT data, created_at FROM contributions WHERE code = $1 ORDER BY id', [req.params.code]);
  res.json({ record: rows[0].data, contributions: notes.rows });
});

app.post('/api/specimens', async (req, res) => {
  try {
    const { record, fam, photo, thumb } = req.body || {};
    if (!FAM_RE.test(fam || '')) return res.status(400).json({ error: 'bad family' });
    const full = decodeImage(photo, 6 * 1024 * 1024);
    const small = decodeImage(thumb, 600 * 1024);
    const code = await nextCode(fam);
    const r = cleanRecord(record, code);
    delete r.photo; delete r.photoFull;
    if (full) {
      const id = await storePhoto(code, full, small);
      r.photo = `/api/photos/${id}/thumb`;
      r.photoFull = `/api/photos/${id}/full`;
    }
    if (!r.logged) r.logged = new Date().toISOString().slice(0, 10);
    await pool.query('INSERT INTO specimens (code, data) VALUES ($1, $2)', [code, r]);
    await dropCache();
    res.json({ record: r });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

app.post('/api/specimens/:code/contributions', async (req, res) => {
  try {
    const code = req.params.code;
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'bad code' });
    const { contribution, record } = req.body || {};
    const c = contribution || {};
    const note = { role: clip(c.role, 40), handle: clip(c.handle, 60) || 'anonymous', text: clip(c.text, 2000), target: clip(c.target, 80) };
    const r = cleanRecord(record, code);
    const old = await pool.query('SELECT data FROM specimens WHERE code = $1', [code]);
    if (old.rows.length) { r.photo = old.rows[0].data.photo; r.photoFull = old.rows[0].data.photoFull; if (!r.photo) { delete r.photo; delete r.photoFull; } }
    await pool.query(
      `INSERT INTO specimens (code, data) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [code, r]);
    await pool.query('INSERT INTO contributions (code, data) VALUES ($1, $2)', [code, note]);
    await dropCache();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

app.get('/api/photos/:id/:size', async (req, res) => {
  const id = Number(req.params.id), size = req.params.size;
  if (!Number.isInteger(id) || !['full', 'thumb'].includes(size)) return res.sendStatus(400);
  try {
    const { rows } = await pool.query(
      `SELECT mime, in_r2, ${size === 'full' ? 'full_img' : 'thumb_img'} AS img FROM photos WHERE id = $1`, [id]);
    if (!rows.length) return res.sendStatus(404);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(rows[0].mime);
    if (rows[0].in_r2) {
      if (!R2) return res.sendStatus(503);
      const obj = await R2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `photos/${id}-${size}` }));
      return obj.Body.pipe(res);
    }
    res.send(rows[0].img);
  } catch (e) { console.error(e); res.sendStatus(500); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`artifactium backend on ${PORT}`));
(async function boot(tries = 0) {
  try { await init(); READY = true; console.log('database ready'); }
  catch (e) { console.error('init failed, retrying', e.message); setTimeout(() => boot(tries + 1), Math.min(30000, 2000 * (tries + 1))); }
})();
