// Veri katmanı: DATABASE_URL varsa Postgres, yoksa yerel JSON dosyası (geliştirme için)
const fs = require('fs');
const path = require('path');

const DEFAULT_SHELVES = [
  { code: 'A', name: 'A Rafı', area: 'magaza', rows: 33, levels: 3, sort: 1 },
  { code: 'B', name: 'B Rafı', area: 'magaza', rows: 33, levels: 3, sort: 2 },
  { code: 'C', name: 'C Rafı', area: 'magaza', rows: 33, levels: 3, sort: 3 },
  { code: 'D', name: 'D Rafı', area: 'magaza', rows: 33, levels: 3, sort: 4 },
  { code: 'DD1', name: 'Dış Depo 1', area: 'dis', rows: 33, levels: 3, sort: 5 },
  { code: 'DD2', name: 'Dış Depo 2', area: 'dis', rows: 33, levels: 3, sort: 6 },
];

const DEFAULT_ZONES = [
  { shelf_code: 'A', brand: 'Korkmaz', start_row: 1, end_row: 33, color: '#c2410c' },
  { shelf_code: 'B', brand: 'Schafer', start_row: 1, end_row: 17, color: '#1d4ed8' },
  { shelf_code: 'B', brand: 'Luxell', start_row: 18, end_row: 33, color: '#7c3aed' },
  { shelf_code: 'C', brand: 'Tefal', start_row: 1, end_row: 8, color: '#dc2626' },
  { shelf_code: 'C', brand: 'Arzum', start_row: 9, end_row: 16, color: '#0891b2' },
  { shelf_code: 'C', brand: 'Fakir', start_row: 17, end_row: 24, color: '#16a34a' },
  { shelf_code: 'C', brand: 'Philips', start_row: 25, end_row: 33, color: '#0f766e' },
  { shelf_code: 'D', brand: 'Boş Kutular', start_row: 1, end_row: 33, color: '#78716c' },
];

const PRODUCT_COLS = 'id, name, brand, kind, qty, note, shelf_code, row_no, level_no, created_at, updated_at';

function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: /render\.com|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  const q = (text, params) => pool.query(text, params);

  return {
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS shelves (
        code TEXT PRIMARY KEY, name TEXT NOT NULL, area TEXT NOT NULL,
        rows INT NOT NULL, levels INT NOT NULL, sort INT NOT NULL DEFAULT 0)`);
      await q(`CREATE TABLE IF NOT EXISTS zones (
        id SERIAL PRIMARY KEY, shelf_code TEXT NOT NULL, brand TEXT NOT NULL,
        start_row INT NOT NULL, end_row INT NOT NULL, color TEXT)`);
      await q(`CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, brand TEXT, kind TEXT NOT NULL DEFAULT 'teshir',
        qty INT NOT NULL DEFAULT 1, note TEXT, shelf_code TEXT NOT NULL, row_no INT NOT NULL,
        level_no INT NOT NULL, thumb TEXT, photo TEXT,
        created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
      await q(`CREATE INDEX IF NOT EXISTS products_loc ON products(shelf_code, row_no, level_no)`);
      const { rows } = await q('SELECT count(*)::int AS n FROM shelves');
      if (rows[0].n === 0) {
        for (const s of DEFAULT_SHELVES) await this.saveShelf(s);
        for (const z of DEFAULT_ZONES) await q(
          'INSERT INTO zones(shelf_code,brand,start_row,end_row,color) VALUES($1,$2,$3,$4,$5)',
          [z.shelf_code, z.brand, z.start_row, z.end_row, z.color]);
      }
    },
    async config() {
      const shelves = (await q('SELECT * FROM shelves ORDER BY sort, code')).rows;
      const zones = (await q('SELECT * FROM zones ORDER BY shelf_code, start_row')).rows;
      return { shelves, zones };
    },
    async saveShelf(s) {
      await q(`INSERT INTO shelves(code,name,area,rows,levels,sort) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (code) DO UPDATE SET name=$2, area=$3, rows=$4, levels=$5, sort=$6`,
        [s.code, s.name, s.area, s.rows, s.levels, s.sort || 0]);
    },
    async deleteShelf(code) {
      await q('DELETE FROM zones WHERE shelf_code=$1', [code]);
      await q('DELETE FROM shelves WHERE code=$1', [code]);
    },
    async replaceZones(shelfCode, zones) {
      await q('DELETE FROM zones WHERE shelf_code=$1', [shelfCode]);
      for (const z of zones) await q(
        'INSERT INTO zones(shelf_code,brand,start_row,end_row,color) VALUES($1,$2,$3,$4,$5)',
        [shelfCode, z.brand, z.start_row, z.end_row, z.color]);
    },
    async listProducts() {
      return (await q(`SELECT ${PRODUCT_COLS}, (photo IS NOT NULL) AS has_photo FROM products ORDER BY updated_at DESC`)).rows;
    },
    async getImage(id, field) {
      const col = field === 'photo' ? 'photo' : 'thumb';
      const { rows } = await q(`SELECT ${col} AS img FROM products WHERE id=$1`, [id]);
      return rows[0] ? rows[0].img : null;
    },
    async createProduct(p) {
      const { rows } = await q(`INSERT INTO products(name,brand,kind,qty,note,shelf_code,row_no,level_no,thumb,photo)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${PRODUCT_COLS}, (photo IS NOT NULL) AS has_photo`,
        [p.name, p.brand, p.kind, p.qty, p.note, p.shelf_code, p.row_no, p.level_no, p.thumb, p.photo]);
      return rows[0];
    },
    async updateProduct(id, p) {
      const sets = []; const vals = [];
      for (const k of ['name', 'brand', 'kind', 'qty', 'note', 'shelf_code', 'row_no', 'level_no', 'thumb', 'photo']) {
        if (p[k] !== undefined) { vals.push(p[k]); sets.push(`${k}=$${vals.length}`); }
      }
      vals.push(id);
      const { rows } = await q(`UPDATE products SET ${sets.join(',')}, updated_at=now() WHERE id=$${vals.length}
        RETURNING ${PRODUCT_COLS}, (photo IS NOT NULL) AS has_photo`, vals);
      return rows[0];
    },
    async deleteProduct(id) { await q('DELETE FROM products WHERE id=$1', [id]); },
  };
}

function fileStore(file) {
  let data = { shelves: [], zones: [], products: [], seq: 0, zseq: 0 };
  const save = () => fs.writeFileSync(file, JSON.stringify(data));
  const pub = (p) => { const { thumb, photo, ...rest } = p; return { ...rest, has_photo: !!photo }; };
  return {
    async init() {
      if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data.shelves.length) {
        data.shelves = DEFAULT_SHELVES.map((s) => ({ ...s }));
        data.zones = DEFAULT_ZONES.map((z) => ({ id: ++data.zseq, ...z }));
        save();
      }
    },
    async config() {
      return {
        shelves: [...data.shelves].sort((a, b) => a.sort - b.sort),
        zones: [...data.zones].sort((a, b) => a.shelf_code.localeCompare(b.shelf_code) || a.start_row - b.start_row),
      };
    },
    async saveShelf(s) {
      const i = data.shelves.findIndex((x) => x.code === s.code);
      if (i >= 0) data.shelves[i] = { ...s }; else data.shelves.push({ ...s });
      save();
    },
    async deleteShelf(code) {
      data.shelves = data.shelves.filter((s) => s.code !== code);
      data.zones = data.zones.filter((z) => z.shelf_code !== code);
      save();
    },
    async replaceZones(shelfCode, zones) {
      data.zones = data.zones.filter((z) => z.shelf_code !== shelfCode)
        .concat(zones.map((z) => ({ id: ++data.zseq, shelf_code: shelfCode, ...z })));
      save();
    },
    async listProducts() {
      return [...data.products].sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1)).map(pub);
    },
    async getImage(id, field) {
      const p = data.products.find((x) => x.id === id);
      return p ? p[field === 'photo' ? 'photo' : 'thumb'] : null;
    },
    async createProduct(p) {
      const now = new Date().toISOString();
      const rec = { id: ++data.seq, ...p, created_at: now, updated_at: now };
      data.products.push(rec); save();
      return pub(rec);
    },
    async updateProduct(id, p) {
      const rec = data.products.find((x) => x.id === id);
      if (!rec) return null;
      for (const [k, v] of Object.entries(p)) if (v !== undefined) rec[k] = v;
      rec.updated_at = new Date().toISOString(); save();
      return pub(rec);
    },
    async deleteProduct(id) { data.products = data.products.filter((x) => x.id !== id); save(); },
  };
}

module.exports = process.env.DATABASE_URL
  ? pgStore(process.env.DATABASE_URL)
  : fileStore(path.join(__dirname, 'data.json'));
