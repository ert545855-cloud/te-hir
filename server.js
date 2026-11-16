const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PIN = process.env.APP_PIN || '';
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';
const KINDS = ['teshir', 'bos'];

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Yazma işlemleri için isteğe bağlı PIN
function auth(req, res, next) {
  if (!PIN || req.get('x-pin') === PIN) return next();
  res.status(401).json({ error: 'PIN hatalı' });
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Sunucu hatası' });
});

function cleanProduct(b, partial) {
  const out = {};
  const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max));
  if (!partial || b.name !== undefined) out.name = str(b.name, 200);
  if (!partial || b.brand !== undefined) out.brand = str(b.brand, 100) || null;
  if (!partial || b.kind !== undefined) out.kind = KINDS.includes(b.kind) ? b.kind : 'teshir';
  if (!partial || b.qty !== undefined) out.qty = Math.max(0, Math.min(9999, parseInt(b.qty, 10) || 1));
  if (!partial || b.note !== undefined) out.note = str(b.note, 500) || null;
  if (!partial || b.shelf_code !== undefined) out.shelf_code = str(b.shelf_code, 20);
  if (!partial || b.row_no !== undefined) out.row_no = parseInt(b.row_no, 10);
  if (!partial || b.level_no !== undefined) out.level_no = parseInt(b.level_no, 10);
  for (const k of ['thumb', 'photo']) {
    if (b[k] === null) out[k] = null;
    else if (typeof b[k] === 'string' && b[k].startsWith('data:image/')) out[k] = b[k];
  }
  return out;
}

async function validLocation(p) {
  if (p.shelf_code === undefined) return true;
  const { shelves } = await db.config();
  const s = shelves.find((x) => x.code === p.shelf_code);
  return s && p.row_no >= 1 && p.row_no <= s.rows && p.level_no >= 1 && p.level_no <= s.levels;
}

app.get('/api/config', wrap(async (req, res) => {
  res.json({ ...(await db.config()), pinRequired: !!PIN, aiEnabled: !!AI_KEY });
}));

app.post('/api/check-pin', (req, res) => res.json({ ok: !PIN || req.get('x-pin') === PIN }));

app.get('/api/products', wrap(async (req, res) => res.json(await db.listProducts())));

app.get('/api/products/:id/:field', wrap(async (req, res) => {
  if (!['thumb', 'photo'].includes(req.params.field)) return res.status(404).end();
  const img = await db.getImage(parseInt(req.params.id, 10), req.params.field);
  if (!img) return res.status(404).end();
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(img);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(m[2], 'base64'));
}));

app.post('/api/products', auth, wrap(async (req, res) => {
  const p = cleanProduct(req.body, false);
  if (!p.name) return res.status(400).json({ error: 'Ürün adı gerekli' });
  if (!(await validLocation(p))) return res.status(400).json({ error: 'Geçersiz raf konumu' });
  const created = await db.createProduct(p);
  io.emit('product:upsert', created);
  res.json(created);
}));

app.put('/api/products/:id', auth, wrap(async (req, res) => {
  const p = cleanProduct(req.body, true);
  if (p.name === '') return res.status(400).json({ error: 'Ürün adı gerekli' });
  if (p.shelf_code !== undefined && !(await validLocation(p))) return res.status(400).json({ error: 'Geçersiz raf konumu' });
  const updated = await db.updateProduct(parseInt(req.params.id, 10), p);
  if (!updated) return res.status(404).json({ error: 'Bulunamadı' });
  io.emit('product:upsert', updated);
  res.json(updated);
}));

app.delete('/api/products/:id', auth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.deleteProduct(id);
  io.emit('product:delete', id);
  res.json({ ok: true });
}));

app.put('/api/shelves/:code', auth, wrap(async (req, res) => {
  const b = req.body;
  const code = String(req.params.code).trim().toUpperCase().slice(0, 20);
  if (!code) return res.status(400).json({ error: 'Kod gerekli' });
  await db.saveShelf({
    code,
    name: String(b.name || code).slice(0, 60),
    area: b.area === 'dis' ? 'dis' : 'magaza',
    rows: Math.max(1, Math.min(200, parseInt(b.rows, 10) || 33)),
    levels: Math.max(1, Math.min(10, parseInt(b.levels, 10) || 3)),
    sort: parseInt(b.sort, 10) || 99,
  });
  if (Array.isArray(b.zones)) {
    await db.replaceZones(code, b.zones
      .filter((z) => z.brand && String(z.brand).trim())
      .map((z) => ({
        brand: String(z.brand).trim().slice(0, 60),
        start_row: parseInt(z.start_row, 10) || 1,
        end_row: parseInt(z.end_row, 10) || 1,
        color: /^#[0-9a-f]{6}$/i.test(z.color) ? z.color : '#475569',
      })));
  }
  const cfg = await db.config();
  io.emit('config:update', cfg);
  res.json(cfg);
}));

app.delete('/api/shelves/:code', auth, wrap(async (req, res) => {
  const code = req.params.code;
  const used = (await db.listProducts()).some((p) => p.shelf_code === code);
  if (used) return res.status(400).json({ error: 'Bu rafta ürün var, önce taşıyın' });
  await db.deleteShelf(code);
  const cfg = await db.config();
  io.emit('config:update', cfg);
  res.json(cfg);
}));

// Fotoğraftan ürün adı/marka tahmini (ANTHROPIC_API_KEY tanımlıysa)
app.post('/api/recognize', auth, wrap(async (req, res) => {
  if (!AI_KEY) return res.status(400).json({ error: 'Yapay zeka tanıma kapalı' });
  const m = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(req.body.image || '');
  if (!m) return res.status(400).json({ error: 'Görsel yok' });
  const { zones } = await db.config();
  const brands = [...new Set(zones.map((z) => z.brand))].join(', ');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          { type: 'text', text: `Bu bir mağazadaki küçük ev aleti / mutfak ürünü fotoğrafı. Bilinen markalar: ${brands}. ` +
            'Kutu üzerindeki yazılardan ürünü tanı. Sadece JSON döndür: ' +
            '{"name":"model adı ve ürün türü, kısa","brand":"marka","kind":"teshir veya bos"}. ' +
            'Boş karton kutu görünüyorsa kind "bos", ürünün kendisi açıkta duruyorsa "teshir".' },
        ],
      }],
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error(j); return res.status(502).json({ error: 'Tanıma başarısız' }); }
  const text = (j.content || []).map((c) => c.text || '').join('');
  const js = /\{[\s\S]*\}/.exec(text);
  try { res.json(JSON.parse(js ? js[0] : '{}')); } catch { res.json({}); }
}));

app.get('/health', (req, res) => res.send('ok'));

io.on('connection', (socket) => {
  io.emit('presence', io.engine.clientsCount);
  socket.on('disconnect', () => io.emit('presence', io.engine.clientsCount));
});

const port = process.env.PORT || 3000;
db.init().then(() => {
  server.listen(port, () => console.log(`Raf Takip çalışıyor: ${port}`));
}).catch((e) => { console.error('DB başlatılamadı', e); process.exit(1); });
