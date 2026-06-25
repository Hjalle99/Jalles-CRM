const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// DATABASE — Railway injects DATABASE_URL automatically
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS markets (
      code TEXT PRIMARY KEY,
      flag TEXT,
      name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS criteria (
      key TEXT PRIMARY KEY,
      name TEXT,
      weight INTEGER,
      descr TEXT,
      rationale TEXT,
      sort_order INTEGER
    );
  `);

  // Seed markets if empty
  const { rowCount } = await pool.query('SELECT 1 FROM markets LIMIT 1');
  if (rowCount === 0) {
    await pool.query(`
      INSERT INTO markets (code, flag, name) VALUES
        ('DE','🇩🇪','Tyskland'),
        ('NL','🇳🇱','Nederländerna'),
        ('NO','🇳🇴','Norge'),
        ('SE','🇸🇪','Sverige'),
        ('FI','🇫🇮','Finland'),
        ('DK','🇩🇰','Danmark')
      ON CONFLICT DO NOTHING;
    `);
  }

  // Seed criteria if empty
  const { rowCount: cc } = await pool.query('SELECT 1 FROM criteria LIMIT 1');
  if (cc === 0) {
    await pool.query(`
      INSERT INTO criteria (key, name, weight, descr, rationale, sort_order) VALUES
        ('demografi',      'Demografi',      4, 'Catchment Area: >100 000 personer inom 20 min bilresa', 'Kärnan i volymhandeln', 1),
        ('grannar',        'Grannar',         1, 'Grannar som bidrar till stabila besökstal', 'Vi lever på goda kundströmmar', 2),
        ('tillganglighet', 'Tillgänglighet',  3, 'Den skall vara enkel att besöka', 'Friktion vid entrén kostar köp', 3),
        ('ekonomi',        'Ekonomi',         5, 'Hyresnivå: speglar vår målbild för ett stabilt business case', 'Critical – dåligt business case dödar marginalen', 4),
        ('logistik',       'Logistik',        3, 'Enkel åtkomst för lämpligt fordon samt ändamålsenlig intransport av varor till butik', 'Driftsacceleration kräver snabb inlastning', 5),
        ('synlighet',      'Synlighet',       3, 'Fasad – skyltmöjlighet – läge', 'Minskar behovet av köpt marknadsföring', 6),
        ('butikslokal',    'Butikslokal',     3, 'Lokalens disposition stödjer vårt koncept och layout', 'Lokalen ska jobba för konceptet, inte emot det', 7)
      ON CONFLICT DO NOTHING;
    `);
  }

  // Seed demo candidates if empty
  const { rowCount: rc } = await pool.query('SELECT 1 FROM candidates LIMIT 1');
  if (rc === 0) {
    const demos = [
      { id:'hannover', city:'Hannover', market:'DE', size_sqm:820, stage:3, days_in_stage:18, rent_eur_sqm:9.5, scores:{demografi:4,grannar:4,tillganglighet:4,ekonomi:4,logistik:4,synlighet:3,butikslokal:4}, kill_switches:[], notes:'Fas 1 nordkluster. Stark H&M-ankare. LEP-granskning pågår.', owner:'', ttm:{contract_date:'2025-04-10',target_open:'2025-07-03',milestones:[{label:'Kontrakt signerat',date:'2025-04-10',done:true},{label:'Bygglov klart',date:'2025-05-01',done:true},{label:'Leverans lokalt',date:'2025-06-01',done:false,active:true},{label:'Grand Opening',date:'2025-07-03',done:false}]}, regulatory:{de:'LEP-screening pågår.',nl:null,no:null} },
      { id:'hanau',    city:'Hanau',    market:'DE', size_sqm:650, stage:4, days_in_stage:5,  rent_eur_sqm:8.2, scores:{demografi:3,grannar:4,tillganglighet:4,ekonomi:5,logistik:4,synlighet:4,butikslokal:4}, kill_switches:[], notes:'FMZ med Aldi + Deichmann.', owner:'', ttm:{contract_date:'2025-05-20',target_open:'2025-08-12',milestones:[{label:'Kontrakt signerat',date:'2025-05-20',done:true},{label:'Bygglov klart',date:'2025-06-15',done:false,active:true},{label:'Leverans lokalt',date:'2025-07-15',done:false},{label:'Grand Opening',date:'2025-08-12',done:false}]}, regulatory:{de:'Branchierung OK.',nl:null,no:null} },
      { id:'rotterdam',city:'Rotterdam Alexandrium II', market:'NL', size_sqm:880, stage:3, days_in_stage:14, rent_eur_sqm:12.0, scores:{demografi:4,grannar:4,tillganglighet:4,ekonomi:3,logistik:4,synlighet:5,butikslokal:4}, kill_switches:[], notes:'Sällsynt permissiv zonering. Prioritera.', owner:'', ttm:null, regulatory:{de:null,nl:'Permissiv bestämmingsplan bekräftad.',no:null} },
      { id:'bremen',   city:'Bremen',   market:'DE', size_sqm:750, stage:1, days_in_stage:3,  rent_eur_sqm:10.5, scores:{demografi:3,grannar:3,tillganglighet:3,ekonomi:3,logistik:3,synlighet:3,butikslokal:3}, kill_switches:[], notes:'Tidigt skede. Fas 1 nordkluster.', owner:'', ttm:null, regulatory:{de:'Ej påbörjad screening.',nl:null,no:null} },
    ];
    for (const d of demos) {
      await pool.query('INSERT INTO candidates (id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING', [d.id, JSON.stringify(d)]);
    }
  }

  console.log('Database ready');
}

// ============================================================
// API — CANDIDATES
// ============================================================
app.get('/api/candidates', async (req, res) => {
  const { rows } = await pool.query('SELECT data FROM candidates ORDER BY updated_at ASC');
  res.json(rows.map(r => r.data));
});

app.post('/api/candidates', async (req, res) => {
  const c = req.body;
  if (!c.id || !c.city || !c.market) return res.status(400).json({ error: 'id, city, market required' });
  await pool.query(
    'INSERT INTO candidates (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()',
    [c.id, JSON.stringify(c)]
  );
  res.json({ ok: true });
});

app.patch('/api/candidates/:id', async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query('SELECT data FROM candidates WHERE id=$1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const updated = { ...rows[0].data, ...req.body, id };
  await pool.query('UPDATE candidates SET data=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(updated), id]);
  res.json({ ok: true, data: updated });
});

app.delete('/api/candidates/:id', async (req, res) => {
  await pool.query('DELETE FROM candidates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ============================================================
// API — MARKETS
// ============================================================
app.get('/api/markets', async (req, res) => {
  const { rows } = await pool.query('SELECT code, flag, name FROM markets ORDER BY created_at ASC');
  res.json(rows);
});

app.post('/api/markets', async (req, res) => {
  const { code, flag, name } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code and name required' });
  await pool.query(
    'INSERT INTO markets (code, flag, name) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING',
    [code.toUpperCase(), flag || '🏳', name]
  );
  res.json({ ok: true });
});

// ============================================================
// API — CRITERIA
// ============================================================
app.get('/api/criteria', async (req, res) => {
  const { rows } = await pool.query('SELECT key, name, weight, descr, rationale FROM criteria ORDER BY sort_order ASC');
  res.json(rows);
});

app.patch('/api/criteria/:key', async (req, res) => {
  const { key } = req.params;
  const { name, weight } = req.body;
  await pool.query('UPDATE criteria SET name=$1, weight=$2 WHERE key=$3', [name, weight, key]);
  res.json({ ok: true });
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Serve index.html for all other routes
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`Lager 157 CRM running on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
