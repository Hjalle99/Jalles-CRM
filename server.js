const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// DATABASE
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ============================================================
// SESSION
// ============================================================
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'lager157-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 24 hours
}));

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Inte inloggad' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(403).json({ error: 'Kräver admin-behörighet' });
}

// ============================================================
// DB INIT
// ============================================================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

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

  // Seed markets
  const { rowCount: mc } = await pool.query('SELECT 1 FROM markets LIMIT 1');
  if (mc === 0) {
    await pool.query(`INSERT INTO markets (code, flag, name) VALUES
      ('DE','🇩🇪','Tyskland'),('NL','🇳🇱','Nederländerna'),('NO','🇳🇴','Norge'),
      ('SE','🇸🇪','Sverige'),('FI','🇫🇮','Finland'),('DK','🇩🇰','Danmark')
      ON CONFLICT DO NOTHING`);
  }

  // Seed criteria
  const { rowCount: cc } = await pool.query('SELECT 1 FROM criteria LIMIT 1');
  if (cc === 0) {
    await pool.query(`INSERT INTO criteria (key, name, weight, descr, rationale, sort_order) VALUES
      ('demografi','Demografi',4,'Catchment Area: >100 000 personer inom 20 min bilresa','Kärnan i volymhandeln',1),
      ('grannar','Grannar',1,'Grannar som bidrar till stabila besökstal','Vi lever på goda kundströmmar',2),
      ('tillganglighet','Tillgänglighet',3,'Den skall vara enkel att besöka','Friktion vid entrén kostar köp',3),
      ('ekonomi','Ekonomi',5,'Hyresnivå: speglar vår målbild för ett stabilt business case','Critical – dåligt business case dödar marginalen',4),
      ('logistik','Logistik',3,'Enkel åtkomst för lämpligt fordon samt ändamålsenlig intransport av varor till butik','Driftsacceleration kräver snabb inlastning',5),
      ('synlighet','Synlighet',3,'Fasad – skyltmöjlighet – läge','Minskar behovet av köpt marknadsföring',6),
      ('butikslokal','Butikslokal',3,'Lokalens disposition stödjer vårt koncept och layout','Lokalen ska jobba för konceptet, inte emot det',7)
      ON CONFLICT DO NOTHING`);
  }

  // Seed demo candidates
  const { rowCount: rc } = await pool.query('SELECT 1 FROM candidates LIMIT 1');
  if (rc === 0) {
    const demos = [
      { id:'hannover', city:'Hannover', market:'DE', size_sqm:820, stage:3, days_in_stage:18, rent_eur_sqm:9.5, scores:{demografi:4,grannar:4,tillganglighet:4,ekonomi:4,logistik:4,synlighet:3,butikslokal:4}, kill_switches:[], notes:'Fas 1 nordkluster. Stark H&M-ankare.', owner:'', ttm:null, regulatory:{de:'LEP-screening pågår.'} },
      { id:'rotterdam', city:'Rotterdam Alexandrium II', market:'NL', size_sqm:880, stage:3, days_in_stage:14, rent_eur_sqm:12.0, scores:{demografi:4,grannar:4,tillganglighet:4,ekonomi:3,logistik:4,synlighet:5,butikslokal:4}, kill_switches:[], notes:'Sällsynt permissiv zonering.', owner:'', ttm:null, regulatory:{nl:'GDV-klassad.'} },
    ];
    for (const d of demos) {
      await pool.query('INSERT INTO candidates (id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING', [d.id, JSON.stringify(d)]);
    }
  }

  // Create default admin if no users exist
  const { rowCount: uc } = await pool.query('SELECT 1 FROM users LIMIT 1');
  if (uc === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      'INSERT INTO users (email, password_hash, name, is_admin) VALUES ($1, $2, $3, TRUE)',
      ['admin@lager157.se', hash, 'Admin']
    );
    console.log('Default admin created: admin@lager157.se / admin123 — CHANGE THIS PASSWORD!');
  }

  console.log('Database ready');
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-post och lösenord krävs' });
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
  if (!rows.length) return res.status(401).json({ error: 'Felaktig e-post eller lösenord' });
  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Felaktig e-post eller lösenord' });
  req.session.userId = user.id;
  req.session.email = user.email;
  req.session.name = user.name;
  req.session.isAdmin = user.is_admin;
  res.json({ ok: true, name: user.name, email: user.email, isAdmin: user.is_admin });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Inte inloggad' });
  res.json({ name: req.session.name, email: req.session.email, isAdmin: req.session.isAdmin });
});

// ============================================================
// ADMIN — USER MANAGEMENT
// ============================================================
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at ASC');
  res.json(rows);
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { email, password, name, is_admin } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-post och lösenord krävs' });
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      'INSERT INTO users (email, password_hash, name, is_admin) VALUES ($1, $2, $3, $4)',
      [email.toLowerCase(), hash, name || '', is_admin || false]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ error: 'E-postadressen används redan' });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Kan inte ta bort dig själv' });
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.patch('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Lösenord krävs' });
  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
  res.json({ ok: true });
});

// ============================================================
// API — CANDIDATES (protected)
// ============================================================
app.get('/api/candidates', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT data FROM candidates ORDER BY updated_at ASC');
  res.json(rows.map(r => r.data));
});

app.post('/api/candidates', requireAuth, async (req, res) => {
  const c = req.body;
  if (!c.id || !c.city || !c.market) return res.status(400).json({ error: 'id, city, market required' });
  await pool.query(
    'INSERT INTO candidates (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()',
    [c.id, JSON.stringify(c)]
  );
  res.json({ ok: true });
});

app.patch('/api/candidates/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT data FROM candidates WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const updated = { ...rows[0].data, ...req.body, id: req.params.id };
  await pool.query('UPDATE candidates SET data=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(updated), req.params.id]);
  res.json({ ok: true, data: updated });
});

app.delete('/api/candidates/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM candidates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ============================================================
// API — MARKETS (protected)
// ============================================================
app.get('/api/markets', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT code, flag, name FROM markets ORDER BY created_at ASC');
  res.json(rows);
});

app.post('/api/markets', requireAuth, requireAdmin, async (req, res) => {
  const { code, flag, name } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code and name required' });
  await pool.query(
    'INSERT INTO markets (code, flag, name) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING',
    [code.toUpperCase(), flag || '🏳', name]
  );
  res.json({ ok: true });
});

// ============================================================
// API — CRITERIA (protected)
// ============================================================
app.get('/api/criteria', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT key, name, weight, descr, rationale FROM criteria ORDER BY sort_order ASC');
  res.json(rows);
});

app.patch('/api/criteria/:key', requireAuth, requireAdmin, async (req, res) => {
  const { name, weight } = req.body;
  await pool.query('UPDATE criteria SET name=$1, weight=$2 WHERE key=$3', [name, weight, req.params.key]);
  res.json({ ok: true });
});

// ============================================================
// HEALTH
// ============================================================
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve login page for unauthenticated, app for authenticated
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 8080;
initDB()
  .then(() => app.listen(PORT, () => console.log(`Lager 157 CRM running on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
