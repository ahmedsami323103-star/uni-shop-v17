require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', 1);

// A stable, private session secret is mandatory. Set SESSION_SECRET in the host's
// environment variables; never use a public fallback in production.
const sessionSecret = String(process.env.SESSION_SECRET || '');
if (sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be set to a private random value of at least 32 characters.');
}
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const dbFile = path.resolve(ROOT, process.env.DATABASE_FILE || './data/uni-shop.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.dirname(dbFile) }),
  name: 'uni_shop_admin', secret: sessionSecret,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));

// Schema: all prices and payment state are determined on the server.
db.exec(`
CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, title TEXT NOT NULL, price REAL NOT NULL, compare_price REAL DEFAULT 0, category TEXT DEFAULT '', image TEXT DEFAULT '', stock INTEGER DEFAULT 0, active INTEGER DEFAULT 1, featured INTEGER DEFAULT 0, description TEXT DEFAULT '', variants_json TEXT DEFAULT '[]', options_json TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY, active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payment_status TEXT NOT NULL DEFAULT 'unpaid', payment_method TEXT NOT NULL, customer_json TEXT NOT NULL, address_json TEXT NOT NULL, items_json TEXT NOT NULL, subtotal REAL NOT NULL, delivery REAL NOT NULL, total REAL NOT NULL, invoice_id TEXT, transaction_id TEXT, stock_reserved INTEGER DEFAULT 0, stock_released INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, customer_id INTEGER NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(sku,customer_id), FOREIGN KEY(customer_id) REFERENCES customers(id));
`);
// Safe additive migrations for databases created by earlier preview versions.
const orderCols = new Set(db.prepare('PRAGMA table_info(orders)').all().map(c=>c.name));
if (!orderCols.has('stock_reserved')) db.exec('ALTER TABLE orders ADD COLUMN stock_reserved INTEGER DEFAULT 0');
if (!orderCols.has('stock_released')) db.exec('ALTER TABLE orders ADD COLUMN stock_released INTEGER DEFAULT 0');
// V16: customer signup only requires name, email and password; phone is collected at checkout.
const customerCols = db.prepare('PRAGMA table_info(customers)').all();
const customerPhoneCol = customerCols.find(c=>c.name==='phone');
if (customerPhoneCol && customerPhoneCol.notnull) {
  db.pragma('foreign_keys = OFF');
  db.exec(`BEGIN;
    CREATE TABLE customers_v16 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO customers_v16(id,name,email,phone,password_hash,created_at) SELECT id,name,email,phone,password_hash,created_at FROM customers;
    DROP TABLE customers;
    ALTER TABLE customers_v16 RENAME TO customers;
    COMMIT;`);
  db.pragma('foreign_keys = ON');
}
const defaults = { shop_name: 'Uni Shop', hotline_number: '01758254433', delivery_inside_dhaka: '80', delivery_outside_dhaka: '150', cod_enabled: 'true', bkash_enabled: 'true', nagad_enabled: 'true', online_payment_enabled: 'true', newsletter_enabled: 'true' };
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
Object.entries(defaults).forEach(([k,v]) => insertSetting.run(k,v));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT,'data','catalog.json'),'utf8'));
const catalogSkus = [...new Set((catalog.products || []).map(p => String(p.sku || '').trim()).filter(Boolean))];
const upsertCatalogProduct = db.prepare(`
  INSERT INTO products(sku,title,price,compare_price,category,image,stock,active,featured,description,variants_json,options_json)
  VALUES(@sku,@title,@price,@compare_price,@category,@image,@stock,@active,@featured,@description,'[]','[]')
  ON CONFLICT(sku) DO UPDATE SET
    title=excluded.title,
    price=excluded.price,
    compare_price=excluded.compare_price,
    category=excluded.category,
    image=excluded.image,
    stock=excluded.stock,
    active=excluded.active,
    featured=excluded.featured,
    description=excluded.description
`);
const syncCatalog = db.transaction(() => {
  for (const p of catalog.products || []) {
    const sku = String(p.sku || '').trim();
    if (!sku) continue; // Never invent a SKU for a source row that has none.
    const price = Number(p.price);
    const compare = Number(p.compare);
    const stock = Number(p.stock);
    if (!String(p.title || '').trim() || !Number.isFinite(price) || price < 0 ||
        !Number.isFinite(compare) || compare < 0 || !Number.isInteger(stock) || stock < 0) {
      throw new Error(`Invalid catalog data for SKU ${sku}; catalog sync aborted.`);
    }
    upsertCatalogProduct.run({
      sku,
      title: String(p.title),
      price,
      compare_price: compare,
      category: String(p.category || ''), // Blank source category stays blank; do not guess.
      image: String(p.image || ''), // Keep the source image field intact, including multiple URLs.
      stock,
      active: p.active === false ? 0 : 1,
      featured: p.featured ? 1 : 0,
      description: String(p.description || '')
    });
  }
  // Keep old products for order/history references, but hide SKUs absent from the current source.
  if (catalogSkus.length) {
    const placeholders = catalogSkus.map(() => '?').join(',');
    db.prepare(`UPDATE products SET active=0 WHERE sku='' OR sku IS NULL OR sku NOT IN (${placeholders})`).run(...catalogSkus);
  } else {
    db.prepare("UPDATE products SET active=0").run();
  }
  const currentCategories = (catalog.categories || []).map(name => String(name || '').trim()).filter(Boolean);
  if (currentCategories.length) {
    const placeholders = currentCategories.map(() => '?').join(',');
    db.prepare(`UPDATE categories SET active=0 WHERE name NOT IN (${placeholders})`).run(...currentCategories);
  } else {
    db.prepare('UPDATE categories SET active=0').run();
  }
  const upsertCategory = db.prepare(`
    INSERT INTO categories(name,active,sort_order) VALUES(?,1,?)
    ON CONFLICT(name) DO UPDATE SET active=1, sort_order=excluded.sort_order
  `);
  currentCategories.forEach((name, index) => upsertCategory.run(name, index));
});
syncCatalog();

// Create the initial admin only once. Change credentials in .env before first run.
const adminPassword = process.env.ADMIN_PASSWORD || '';
if (!db.prepare("SELECT value FROM settings WHERE key='admin_password_hash'").get() && adminPassword && adminPassword !== 'change-this-to-a-long-unique-password') {
  insertSetting.run('admin_username', process.env.ADMIN_USERNAME || 'owner');
  insertSetting.run('admin_password_hash', bcrypt.hashSync(adminPassword, 12));
}
const getSetting = db.prepare('SELECT value FROM settings WHERE key=?');
const setSetting = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const adminOnly = (req,res,next) => req.session && req.session.admin === true ? next() : res.status(401).json({error:'Admin login required'});
const loginLimiter = rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:true,legacyHeaders:false});
const orderLimiter = rateLimit({windowMs:10*60*1000,limit:20,standardHeaders:true,legacyHeaders:false});
const publicProduct = r => ({sku:r.sku,title:r.title,price:r.price,compare:r.compare_price,category:r.category,image:r.image,stock:r.stock,featured:!!r.featured,description:r.description,variants:JSON.parse(r.variants_json||'[]'),options:JSON.parse(r.options_json||'[]')});
const productStmt = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY featured DESC,title');
app.get('/api/health', (_req,res)=>res.json({ok:true,service:'uni-shop-api'}));
app.get('/api/products', (_req,res)=>res.json({products:productStmt.all().map(publicProduct),categories:db.prepare('SELECT name FROM categories WHERE active=1 ORDER BY sort_order,name').all().map(x=>x.name)}));
app.get('/api/store-config',(_req,res)=>{const v=k=>getSetting.get(k)?.value;res.json({shopName:v('shop_name')||'Uni Shop',hotlineNumber:v('hotline_number')||'01758254433',deliveryInsideDhaka:Number(v('delivery_inside_dhaka')||80),deliveryOutsideDhaka:Number(v('delivery_outside_dhaka')||150),codEnabled:v('cod_enabled')!=='false',bkashEnabled:v('bkash_enabled')!=='false',nagadEnabled:v('nagad_enabled')!=='false',onlinePaymentEnabled:v('online_payment_enabled')==='true',newsletterEnabled:v('newsletter_enabled')!=='false'});});
const customerOnly=(req,res,next)=>req.session&&Number.isInteger(req.session.customerId)?next():res.status(401).json({error:'Please sign in to your customer account first.'});

app.post('/api/customer/register', loginLimiter, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (name.length < 2 || name.length > 100) {
    return res.status(400).json({ error: 'Name must be 2 to 100 characters.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    db.prepare(
      'INSERT INTO customers (name, email, phone, password_hash, created_at) VALUES (?, ?, NULL, ?, ?)'
    ).run(name, email, passwordHash, new Date().toISOString());

    const customer = db.prepare(
      'SELECT id, name, email, phone FROM customers WHERE email = ?'
    ).get(email);

    req.session.customerId = customer.id;

    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ error: 'Could not save customer session.' });
      }

      res.status(201).json(customer);
    });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'This email is already registered. Please log in.' });
    }

    console.error('Customer registration failed:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/customer/login',loginLimiter,async(req,res)=>{const login=String(req.body.login||req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');const c=db.prepare('SELECT * FROM customers WHERE lower(email)=?').get(login);if(!c||!await bcrypt.compare(password,c.password_hash))return res.status(401).json({error:'Invalid email or password.'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not create customer session'});req.session.customerId=c.id;req.session.save(e=>{if(e)return res.status(500).json({error:'Could not save customer session'});res.json({ok:true,id:c.id,name:c.name,email:c.email,phone:c.phone})})})});
app.post('/api/customer/google-login', loginLimiter, async (req, res) => {
try {
const accessToken = String(req.body.access_token || '');
if (!accessToken) {
return res.status(400).json({ error: 'Google login token is missing.' });
}

const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseKey = String(process.env.SUPABASE_ANON_KEY || '');

if (!supabaseUrl || !supabaseKey) {
  return res.status(503).json({ error: 'Google login is not configured on the server.' });
}

const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
  headers: {
    apikey: supabaseKey,
    Authorization: `Bearer ${accessToken}`
  }
});

if (!response.ok) {
  return res.status(401).json({ error: 'Google login verification failed. Please try again.' });
}

const user = await response.json();
const email = String(user.email || '').trim().toLowerCase();
const name = String(
  user.user_metadata?.full_name ||
  user.user_metadata?.name ||
  email.split('@')[0] ||
  'Customer'
).trim().slice(0, 100);

if (!email || !user.email_confirmed_at) {
  return res.status(401).json({ error: 'Please use a verified Google email address.' });
}

let customer = db.prepare(
  'SELECT id, name, email, phone FROM customers WHERE lower(email)=?'
).get(email);

if (!customer) {
  const passwordHash = await bcrypt.hash(
    require('crypto').randomBytes(32).toString('hex'),
    12
  );

  const result = db.prepare(
    'INSERT INTO customers (name, email, phone, password_hash, created_at) VALUES (?, ?, NULL, ?, ?)'
  ).run(name, email, passwordHash, new Date().toISOString());

  customer = db.prepare(
    'SELECT id, name, email, phone FROM customers WHERE id=?'
  ).get(result.lastInsertRowid);
}

req.session.regenerate(err => {
  if (err) {
    return res.status(500).json({ error: 'Could not create customer session.' });
  }

  req.session.customerId = customer.id;

  req.session.save(saveErr => {
    if (saveErr) {
      return res.status(500).json({ error: 'Could not save customer session.' });
    }

    res.json({ ok: true, ...customer });
  });
});

} catch (err) {
console.error('Google customer login failed:', err);
res.status(500).json({ error: 'Google login failed. Please try again.' });
}
});
app.get('/api/customer/me',customerOnly,(req,res)=>{const c=db.prepare('SELECT id,name,email,phone FROM customers WHERE id=?').get(req.session.customerId);if(!c){req.session.customerId=null;return res.status(401).json({error:'Customer session expired'})}res.json(c)});
app.post('/api/customer/logout',customerOnly,(req,res)=>{req.session.customerId=null;req.session.save(()=>res.json({ok:true}))});
// Customer dashboard: return only the logged-in customer's orders
// Google OAuth: verify Supabase user and create a Uni Shop customer session.
app.post('/api/customer/google-login', loginLimiter, async (req, res) => {
  try {
    const accessToken = String(req.body.access_token || '');
    const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const supabaseKey = String(process.env.SUPABASE_ANON_KEY || '');

    if (!accessToken || !supabaseUrl || !supabaseKey) {
      return res.status(400).json({
        error: 'Google login is not configured correctly.'
      });
    }

    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      return res.status(401).json({ error: 'Google sign-in verification failed.' });
    }

    const user = await response.json();
    const email = String(user.email || '').trim().toLowerCase();
    const name = String(
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      email.split('@')[0] ||
      ''
    ).trim();

    if (!user.email || user.email_confirmed_at == null || !email) {
      return res.status(403).json({
        error: 'Please use a verified Google email address.'
      });
    }

    let customer = db.prepare(
      'SELECT id, name, email, phone FROM customers WHERE lower(email) = ?'
    ).get(email);

    if (!customer) {
      const passwordHash = await bcrypt.hash(
        require('crypto').randomBytes(32).toString('hex'),
        12
      );

      const result = db.prepare(
        `INSERT INTO customers
         (name, email, phone, password_hash, created_at)
         VALUES (?, ?, NULL, ?, ?)`
      ).run(name.slice(0, 100) || 'Google Customer', email,
        passwordHash, new Date().toISOString());

      customer = db.prepare(
        'SELECT id, name, email, phone FROM customers WHERE id = ?'
      ).get(result.lastInsertRowid);
    }

    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ error: 'Could not create customer session.' });
      }

      req.session.customerId = customer.id;

      req.session.save((saveError) => {
        if (saveError) {
          return res.status(500).json({ error: 'Could not save customer session.' });
        }

        return res.json({ ok: true, ...customer });
      });
    });
  } catch (error) {
    console.error('Google customer login failed:', error);
    return res.status(500).json({ error: 'Google login failed. Please try again.' });
  }
});
app.get('/api/orders', customerOnly, (req, res) => {
  try {
    const customer = db.prepare(
      'SELECT id, name, email FROM customers WHERE id = ?'
    ).get(req.session.customerId);

    if (!customer) {
      return res.status(401).json({
        error: 'Customer session expired. Please log in again.'
      });
    }

    const rows = db.prepare(`
      SELECT id, created_at, status, payment_method,
             customer_json, address_json, items_json,
             subtotal, delivery, total
      FROM orders
      WHERE lower(json_extract(customer_json, '$.email')) = lower(?)
      ORDER BY created_at DESC
      LIMIT 100
    `).all(customer.email);

    const orders = rows.map(o => {
      let address = {};
      let customerInfo = {};
      let items = [];

      try {
        address = JSON.parse(o.address_json || '{}');
      } catch (_) {}

      try {
        customerInfo = JSON.parse(o.customer_json || '{}');
      } catch (_) {}

      try {
        items = JSON.parse(o.items_json || '[]');
      } catch (_) {}

      return {
        orderNumber: o.id,
        _id: o.id,
        id: o.id,
        createdAt: o.created_at,
        status: o.status,
        paymentMethod: o.payment_method || '',
        customer: customerInfo,
        address: address,
        shippingAddress: address,
        items: items.map(item => ({
          ...item,
          quantity: Number(item.qty || item.quantity || 1)
        })),
        subtotal: Number(o.subtotal || 0),
        delivery: Number(o.delivery || 0),
        deliveryCharge: Number(o.delivery || 0),
        total: Number(o.total || 0)
      };
    });

    res.json({ orders });
  } catch (err) {
    console.error('Customer orders error:', err);
    res.status(500).json({
      error: 'Could not load your orders.'
    });
  }
});

app.get('/api/dashboard', customerOnly, (req, res) => {
  try {
    const customer = db.prepare(
      'SELECT id, email FROM customers WHERE id = ?'
    ).get(req.session.customerId);

    if (!customer) {
      return res.status(401).json({ error: 'Customer session expired. Please log in again.' });
    }

    const rows = db.prepare(`
      SELECT id, created_at, status, items_json, total
      FROM orders
      WHERE lower(json_extract(customer_json, '$.email')) = lower(?)
      ORDER BY created_at DESC
      LIMIT 100
    `).all(customer.email);

    const orders = rows.map(o => ({
      orderNumber: o.id,
      _id: o.id,
      createdAt: o.created_at,
      status: o.status,
      total: Number(o.total || 0),
      items: JSON.parse(o.items_json || '[]').map(item => ({
        ...item,
        quantity: Number(item.qty || item.quantity || 0)
      }))
    }));

    const metrics = {
      totalOrders: orders.length,
      pending: orders.filter(o => o.status === 'pending' || o.status === 'processing').length,
      shipped: orders.filter(o => o.status === 'shipped').length,
      delivered: orders.filter(o => o.status === 'delivered').length,
      wishlist: 0
    };

    res.json({ metrics, orders });
  } catch (err) {
    console.error('Customer dashboard error:', err);
    res.status(500).json({ error: 'Could not load your dashboard.' });
  }
});
app.get('/api/products/:sku/reviews',(req,res)=>{const sku=String(req.params.sku);const rows=db.prepare('SELECT r.rating,r.body,r.created_at,c.name customer_name FROM reviews r JOIN customers c ON c.id=r.customer_id WHERE r.sku=? ORDER BY r.created_at DESC LIMIT 100').all(sku);const avg=db.prepare('SELECT AVG(rating) average,COUNT(*) count FROM reviews WHERE sku=?').get(sku);res.json({reviews:rows,average:Number(avg.average||0),count:Number(avg.count||0)})});
app.post('/api/products/:sku/reviews',customerOnly,(req,res)=>{const sku=String(req.params.sku),rating=Number(req.body.rating),body=String(req.body.body||'').trim();if(!db.prepare('SELECT 1 FROM products WHERE sku=? AND active=1').get(sku))return res.status(404).json({error:'Product not found'});if(!Number.isInteger(rating)||rating<1||rating>5||body.length<8||body.length>1200)return res.status(400).json({error:'Choose 1–5 stars and write a review between 8 and 1200 characters.'});try{db.prepare('INSERT INTO reviews(sku,customer_id,rating,body,created_at) VALUES(?,?,?,?,?) ON CONFLICT(sku,customer_id) DO UPDATE SET rating=excluded.rating,body=excluded.body,created_at=excluded.created_at').run(sku,req.session.customerId,rating,body,new Date().toISOString());res.status(201).json({ok:true})}catch(e){res.status(500).json({error:'Could not save review'})}});
function releaseOrderStock(orderId){const row=db.prepare('SELECT items_json,stock_reserved,stock_released FROM orders WHERE id=?').get(orderId);if(!row||!row.stock_reserved||row.stock_released)return false;const items=JSON.parse(row.items_json||'[]');const tx=db.transaction(()=>{for(const item of items)db.prepare('UPDATE products SET stock=stock+? WHERE sku=?').run(Math.max(1,Number(item.qty)||1),String(item.sku));db.prepare('UPDATE orders SET stock_reserved=0,stock_released=1 WHERE id=?').run(orderId)});tx();return true;}
app.post('/api/admin/login',loginLimiter,async(req,res)=>{
  const username=String(req.body.username||'');const password=String(req.body.password||'');
  const savedUser=getSetting.get('admin_username')?.value;const hash=getSetting.get('admin_password_hash')?.value;
  if(!hash || !savedUser){return res.status(503).json({error:'Admin is not initialized. Set ADMIN_USERNAME and a strong ADMIN_PASSWORD in .env, then restart.'})}
  if(username!==savedUser || !await bcrypt.compare(password,hash))return res.status(401).json({error:'Invalid username or password'});
  req.session.regenerate(err=>{
    if(err)return res.status(500).json({error:'Could not create session'});
    req.session.admin=true;
    req.session.save(saveErr=>{
      if(saveErr)return res.status(500).json({error:'Could not save admin session'});
      res.json({ok:true,user:savedUser});
    });
  });
});
app.post('/api/admin/logout',adminOnly,(req,res)=>req.session.destroy(err=>{
  res.clearCookie('uni_shop_admin',{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'});
  if(err)return res.status(500).json({error:'Could not end admin session'});
  res.json({ok:true});
}));
app.get('/api/admin/me',adminOnly,(req,res)=>res.json({ok:true,user:getSetting.get('admin_username')?.value||'owner'}));
app.get('/api/admin/orders',adminOnly,(req,res)=>res.json(db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all().map(r=>({...r,customer:JSON.parse(r.customer_json),address:JSON.parse(r.address_json),items:JSON.parse(r.items_json)}))));
app.get('/api/admin/dashboard',adminOnly,(_req,res)=>{
  const totals=db.prepare(`SELECT
    COUNT(*) AS order_count,
    COALESCE(SUM(CASE WHEN payment_status='paid' OR payment_status='cash_on_delivery' THEN total ELSE 0 END),0) AS recorded_revenue,
    COALESCE(SUM(
      CASE
        WHEN (payment_status='paid' OR payment_status='cash_on_delivery')
         AND date(created_at,'+6 hours')=date('now','+6 hours')
        THEN total
        ELSE 0
      END
    ),0) AS today_recorded_revenue,
    COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending_orders,
    COALESCE(SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END),0) AS processing_orders,
    COALESCE(SUM(CASE WHEN status='shipped' THEN 1 ELSE 0 END),0) AS shipped_orders
    FROM orders`).get();

  const products=db.prepare(
    'SELECT COUNT(*) count, COALESCE(SUM(CASE WHEN stock<=5 AND active=1 THEN 1 ELSE 0 END),0) low_stock FROM products'
  ).get();

  const customers=db.prepare('SELECT COUNT(*) count FROM customers').get();

  res.json({
    ...totals,
    product_count:products.count,
    low_stock_count:products.low_stock,
    customer_count:customers.count
  });
});
app.get('/api/admin/customers',adminOnly,(_req,res)=>{
  const rows=db.prepare(`SELECT c.id,c.name,c.email,c.phone,c.created_at,
    (SELECT COUNT(*) FROM orders o WHERE lower(json_extract(o.customer_json,'$.email'))=lower(c.email)) AS order_count
    FROM customers c ORDER BY c.created_at DESC LIMIT 1000`).all();
  res.json(rows);
});
app.patch('/api/admin/orders/:id',adminOnly,(req,res)=>{const allowed=['pending','processing','shipped','delivered','cancelled'];const status=String(req.body.status||'');if(!allowed.includes(status))return res.status(400).json({error:'Invalid order status'});const current=db.prepare('SELECT status FROM orders WHERE id=?').get(req.params.id);if(!current)return res.status(404).json({error:'Order not found'});if(status==='cancelled'&&current.status!=='cancelled')releaseOrderStock(req.params.id);db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,req.params.id);res.json({ok:true})});
app.get('/api/admin/products',adminOnly,(_req,res)=>{const rows=db.prepare('SELECT sku,title,price,compare_price,category,image,stock,active,featured FROM products ORDER BY title').all().map(p=>({...p,name:p.title}));res.json(rows)});
app.patch('/api/admin/products/:sku',adminOnly,(req,res)=>{const fields={};for(const k of ['title','price','compare_price','category','image','stock','active','featured','description'])if(req.body[k]!==undefined)fields[k]=req.body[k];if(!Object.keys(fields).length)return res.status(400).json({error:'No editable fields provided'});if(fields.price!==undefined&&(!Number.isFinite(Number(fields.price))||Number(fields.price)<0))return res.status(400).json({error:'Price must be a non-negative number'});if(fields.stock!==undefined&&(!Number.isInteger(Number(fields.stock))||Number(fields.stock)<0))return res.status(400).json({error:'Stock must be a non-negative integer'});const cols=Object.keys(fields);const vals=cols.map(k=>['active','featured'].includes(k)?(fields[k]?1:0):fields[k]);const info=db.prepare(`UPDATE products SET ${cols.map(k=>`${({compare_price:'compare_price'})[k]||k}=?`).join(',')} WHERE sku=?`).run(...vals,req.params.sku);if(!info.changes)return res.status(404).json({error:'Product not found'});res.json({ok:true})});
app.post('/api/admin/products',adminOnly,(req,res)=>{const p=req.body||{};if(!p.sku||!p.title||!Number.isFinite(Number(p.price))||Number(p.price)<0)return res.status(400).json({error:'SKU, title and a valid price are required'});try{db.prepare('INSERT INTO products(sku,title,price,compare_price,category,image,stock,active,featured,description,variants_json,options_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(String(p.sku),String(p.title),Number(p.price),Number(p.compare||0),String(p.category||''),String(p.image||''),Math.max(0,Number(p.stock)||0),p.active===false?0:1,p.featured?1:0,String(p.description||''),JSON.stringify(p.variants||[]),JSON.stringify(p.options||[]));res.status(201).json({ok:true})}catch(e){res.status(409).json({error:'Could not add product; SKU may already exist'})}});
app.get('/api/admin/categories',adminOnly,(_req,res)=>{const rows=db.prepare('SELECT name,active,sort_order FROM categories ORDER BY sort_order,name').all().map((c,i)=>({...c,id:c.name,slug:c.name}));res.json(rows)});
app.post('/api/admin/categories',adminOnly,(req,res)=>{const name=String(req.body.name||'').trim();if(!name)return res.status(400).json({error:'Category name is required'});try{db.prepare('INSERT INTO categories(name,active,sort_order) VALUES(?,1,?)').run(name,db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM categories').get().n);res.status(201).json({ok:true})}catch(e){res.status(409).json({error:'Category already exists'})}});
app.patch('/api/admin/categories/:name',adminOnly,(req,res)=>{const result=db.prepare('UPDATE categories SET active=? WHERE name=?').run(req.body.active?1:0,req.params.name);if(!result.changes)return res.status(404).json({error:'Category not found'});res.json({ok:true})});
app.get('/api/admin/settings',adminOnly,(_req,res)=>{const out={};db.prepare('SELECT key,value FROM settings').all().forEach(x=>{if(!x.key.includes('password')&&!x.key.includes('api_key'))out[x.key]=x.value});res.json(out)});
app.patch('/api/admin/settings',adminOnly,(req,res)=>{const editable=['shop_name','hotline_number','delivery_inside_dhaka','delivery_outside_dhaka','cod_enabled','bkash_enabled','nagad_enabled','online_payment_enabled','newsletter_enabled','admin_notification_email'];for(const k of editable)if(req.body[k]!==undefined)setSetting.run(k,String(req.body[k]));res.json({ok:true})});
function sendOrderEmail(order){const notifyTo=getSetting.get('admin_notification_email')?.value||process.env.ADMIN_NOTIFICATION_EMAIL;if(!process.env.SMTP_HOST||!notifyTo)return Promise.resolve();const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE)==='true',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined});return transporter.sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER,to:notifyTo,subject:`Uni Shop order ${order.id}`,text:`New order ${order.id}\nCustomer: ${order.customer.name}\nPhone: ${order.customer.phone}\nTotal: BDT ${order.total}\nItems: ${order.items.map(i=>`${i.title} x${i.qty}`).join(', ')}\nAddress: ${order.address.fullAddress}, ${order.address.thana}, ${order.address.district}, ${order.address.division}`}).catch(e=>console.error('Order email failed:',e.message));}
function deliveryFee(zone){const key=zone==='inside'?'delivery_inside_dhaka':'delivery_outside_dhaka';return Math.max(0,Number(getSetting.get(key)?.value||(zone==='inside'?'80':'150'))||0)}
app.post('/api/orders',orderLimiter,async(req,res)=>{
 // Guest checkout: customers can place orders without login. }
  
const b = req.body || {};
const submittedCustomer = b.customer || {};
const address = b.address || {};
const items = Array.isArray(b.items) ? b.items : [];

const loggedInCustomer = Number.isInteger(req.session?.customerId)
  ? db.prepare(
      'SELECT id, name, email, phone FROM customers WHERE id = ?'
    ).get(req.session.customerId)
  : null;

const customer = loggedInCustomer
  ? {
      ...submittedCustomer,
      name: loggedInCustomer.name,
      email: loggedInCustomer.email,
      phone: loggedInCustomer.phone || submittedCustomer.phone
    }
  : submittedCustomer;

 if(!String(customer.name||'').trim()||!/^01[3-9]\d{8}$/.test(String(customer.phone||''))||!address.division||!address.district||!address.thana||!address.area||!address.fullAddress||!items.length)return res.status(400).json({error:'Please complete all required checkout fields.'});
 const paymentMethod = String(b.paymentMethod || 'Cash on Delivery');

const allowedMethods = ['Cash on Delivery', 'Online Payment'];

if (!allowedMethods.includes(paymentMethod)) {
  return res.status(400).json({
    error: 'Unsupported payment method.'
  });
}

const online = paymentMethod === 'Online Payment';

if (online && getSetting.get('online_payment_enabled')?.value !== 'true') {
  return res.status(503).json({
    error: 'Online payment is not enabled by the store administrator.'
  });
}

if (
  paymentMethod === 'Cash on Delivery' &&
  getSetting.get('cod_enabled')?.value === 'false'
) {
  return res.status(400).json({
    error: 'Cash on Delivery is currently disabled.'
  });
}

const zone = String(b.deliveryZone || 'outside') === 'inside'
  ? 'inside'
  : 'outside';

const delivery = deliveryFee(zone);
let subtotal = 0;
const normalized = [];
for (const item of items) {
const p = db.prepare(
'SELECT sku,title,price,stock,active FROM products WHERE sku=?'
).get(String(item.sku));

const qty = Math.max(1, Math.min(99, Math.floor(Number(item.qty) || 1)));

if (!p || !p.active) {
  return res.status(400).json({ error: `Product unavailable: ${item.sku}` });
}

if (p.stock < qty) {
  return res.status(400).json({ error: `Insufficient stock for ${p.title}` });
}

subtotal += p.price * qty;
normalized.push({
  sku: p.sku,
  title: p.title,
  price: p.price,
  qty,
  variant: String(item.variant || '')
});

}
  const id='US-'+Date.now().toString(36).toUpperCase();const order={id,created_at:new Date().toISOString(),status:'pending',payment_status:online?'unpaid':'cash_on_delivery',payment_method:paymentMethod,customer,address,items:normalized,subtotal,delivery,total:subtotal+delivery};
 try{const reserveAndInsert=db.transaction(()=>{for(const item of normalized){const changed=db.prepare('UPDATE products SET stock=stock-? WHERE sku=? AND active=1 AND stock>=?').run(item.qty,item.sku,item.qty);if(!changed.changes)throw new Error('Stock changed while placing order. Please refresh the cart and try again.');}db.prepare('INSERT INTO orders(id,created_at,status,payment_status,payment_method,customer_json,address_json,items_json,subtotal,delivery,total,stock_reserved,stock_released) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(order.id,order.created_at,order.status,order.payment_status,order.payment_method,JSON.stringify(customer),JSON.stringify({...address,deliveryZone:zone}),JSON.stringify(normalized),subtotal,delivery,order.total,1,0)});reserveAndInsert()}catch(e){return res.status(409).json({error:e.message||'Could not reserve stock for this order.'})}
 
await Promise.race([
  sendOrderEmail(order),
  new Promise(resolve => setTimeout(resolve, 5000))
]).catch(err => console.error('Order email error:', err.message));

 if(!online)return res.status(201).json({ok:true,orderId:id,total:order.total,paymentRequired:false});
 if(!process.env.UDDOKTAPAY_API_KEY){releaseOrderStock(id);return res.status(503).json({error:'UddoktaPay API key is not configured on the server. The order is saved as unpaid and reserved stock was released.'});}
 try{const base=(process.env.UDDOKTAPAY_BASE_URL||'https://sandbox.uddoktapay.com').replace(/\/$/,'');const response=await fetch(base+'/api/checkout-v2',{method:'POST',headers:{'RT-UDDOKTAPAY-API-KEY':process.env.UDDOKTAPAY_API_KEY,'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({full_name:String(customer.name),email:String(process.env.UDDOKTAPAY_DEFAULT_EMAIL),amount:String(order.total),metadata:{order_id:id},redirect_url:(process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT)+'/api/payments/uddoktapay/return',return_type:'GET',cancel_url:(process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT)+'/payment-cancelled.html',webhook_url:(process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT)+'/api/payments/uddoktapay/webhook'})});const data=await response.json();if(!response.ok||!data.status||!data.payment_url)throw new Error(data.message||'UddoktaPay checkout could not be created');db.prepare('UPDATE orders SET invoice_id=? WHERE id=?').run(data.invoice_id||null,id);return res.status(201).json({ok:true,orderId:id,paymentUrl:data.payment_url,total:order.total});}catch(e){console.error('UddoktaPay checkout error:',e.message);return res.status(502).json({error:'Could not start online payment. The order remains unpaid; please contact the shop.'});}
});
app.get('/api/payments/uddoktapay/return',async(req,res)=>{const invoiceId=String(req.query.invoice_id||'');if(!invoiceId||!process.env.UDDOKTAPAY_API_KEY)return res.redirect('/payment-result.html?status=unverified');try{const base=(process.env.UDDOKTAPAY_BASE_URL||'https://sandbox.uddoktapay.com').replace(/\/$/,'');const response=await fetch(base+'/api/verify-payment',{method:'POST',headers:{'RT-UDDOKTAPAY-API-KEY':process.env.UDDOKTAPAY_API_KEY,'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({invoice_id:invoiceId})});const data=await response.json();const orderId=String(data?.metadata?.order_id||'');const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);if(response.ok&&data.status==='COMPLETED'&&order&&Number(data.amount)===Number(order.total)){db.prepare("UPDATE orders SET payment_status='paid',invoice_id=?,transaction_id=? WHERE id=?").run(invoiceId,String(data.transaction_id||''),orderId);return res.redirect('/payment-result.html?status=paid&order='+encodeURIComponent(orderId));}if(order){db.prepare("UPDATE orders SET payment_status='unpaid',invoice_id=? WHERE id=?").run(invoiceId,orderId);releaseOrderStock(orderId)}return res.redirect('/payment-result.html?status=unverified&order='+encodeURIComponent(orderId));}catch(e){console.error('Payment verification failed:',e.message);return res.redirect('/payment-result.html?status=unverified');}});
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/customer', (_req, res) =>
  res.sendFile(path.join(ROOT, 'index.html'))
);
app.post('/api/payments/uddoktapay/webhook',async(req,res)=>{const key=req.get('RT-UDDOKTAPAY-API-KEY');if(!process.env.UDDOKTAPAY_API_KEY||key!==process.env.UDDOKTAPAY_API_KEY)return res.status(401).send('Unauthorized');const invoiceId=String(req.body?.invoice_id||'');if(!invoiceId)return res.status(400).send('Missing invoice_id');try{const base=(process.env.UDDOKTAPAY_BASE_URL||'https://sandbox.uddoktapay.com').replace(/\/$/,'');const vr=await fetch(base+'/api/verify-payment',{method:'POST',headers:{'RT-UDDOKTAPAY-API-KEY':process.env.UDDOKTAPAY_API_KEY,'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({invoice_id:invoiceId})});const payment=await vr.json();const orderId=String(payment?.metadata?.order_id||'');const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);if(vr.ok&&payment.status==='COMPLETED'&&order&&Number(payment.amount)===Number(order.total)){db.prepare("UPDATE orders SET payment_status='paid',invoice_id=?,transaction_id=? WHERE id=?").run(invoiceId,String(payment.transaction_id||''),orderId);return res.status(200).send('Payment verified');}return res.status(202).send('Payment is not verified as completed');}catch(e){console.error('UddoktaPay webhook verify failed:',e.message);return res.status(502).send('Verification unavailable');}});
app.get('/customer-app.js', (_req, res) =>
  res.sendFile(path.join(ROOT, 'public', 'customer-app.js'))
);

app.get('/customer-styles.css', (_req, res) =>
  res.sendFile(path.join(ROOT, 'public', 'customer-styles.css'))
);

app.use(express.static(path.join(ROOT,'public')));
app.get('/admin',(_req,res)=>res.sendFile(path.join(ROOT,'admin','index.html')));
app.get('/payment-result.html',(_req,res)=>res.sendFile(path.join(ROOT,'public','payment-result.html')));
app.get('/payment-cancelled.html',(_req,res)=>res.sendFile(path.join(ROOT,'public','payment-cancelled.html')));
app.listen(PORT,()=>console.log(`Uni Shop server listening on port ${PORT}`));
