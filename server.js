require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
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
const uploadsDir = path.join(ROOT, 'uploads', 'products');

fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = Date.now() + '-' +
      Math.random().toString(36).slice(2, 10) + ext;

    cb(null, safeName);
  }
});

const uploadProductPdf = multer({
  storage,
  limits: { files: 1, fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req,file,cb) => file.mimetype === 'application/pdf' ? cb(null,true) : cb(new Error('Only PDF files are allowed.'))
});

const uploadProductImages = multer({
  storage,
  limits: {
    files: 10,
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, WEBP and GIF images are allowed.'));
    }
  }
});

const dbFile = path.resolve(ROOT, process.env.DATABASE_FILE || './data/uni-shop.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use('/uploads/products', express.static(uploadsDir, { index: false, dotfiles: 'deny' }));
app.set('trust proxy', 1);
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.dirname(dbFile) }),
  name: 'uni_shop_admin', secret: sessionSecret,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));

// Schema: all prices and payment state are determined on the server.
db.exec(`
CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, title TEXT NOT NULL, price REAL NOT NULL, compare_price REAL DEFAULT 0, category TEXT DEFAULT '', image TEXT DEFAULT '', stock INTEGER DEFAULT 0, active INTEGER DEFAULT 1, featured INTEGER DEFAULT 0, description TEXT DEFAULT '', variants_json TEXT DEFAULT '[]', options_json TEXT DEFAULT '[]', display_sku TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY, active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, parent_name TEXT DEFAULT '', image_url TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payment_status TEXT NOT NULL DEFAULT 'unpaid', payment_method TEXT NOT NULL, customer_json TEXT NOT NULL, address_json TEXT NOT NULL, items_json TEXT NOT NULL, subtotal REAL NOT NULL, delivery REAL NOT NULL, total REAL NOT NULL, invoice_id TEXT, transaction_id TEXT, stock_reserved INTEGER DEFAULT 0, stock_released INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, customer_id INTEGER NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(sku,customer_id), FOREIGN KEY(customer_id) REFERENCES customers(id));
CREATE TABLE IF NOT EXISTS admin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login_at TEXT);
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_user_id INTEGER, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, details_json TEXT DEFAULT '{}', created_at TEXT NOT NULL, FOREIGN KEY(admin_user_id) REFERENCES admin_users(id) ON DELETE SET NULL);
`);
// Review moderation fields are additive; existing reviews remain approved.
const reviewCols = new Set(db.prepare('PRAGMA table_info(reviews)').all().map(c=>c.name));
if (!reviewCols.has('status')) db.exec("ALTER TABLE reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
if (!reviewCols.has('moderated_at')) db.exec("ALTER TABLE reviews ADD COLUMN moderated_at TEXT DEFAULT NULL");
// Safe additive migrations for databases created by earlier preview versions.
const productCols = new Set(db.prepare('PRAGMA table_info(products)').all().map(c=>c.name));
if (!productCols.has('display_sku')) db.exec("ALTER TABLE products ADD COLUMN display_sku TEXT DEFAULT ''");
// V17 product editor fields: additive only; existing product data remains intact.
const productEditorColumns = [
  ['brand', "TEXT DEFAULT ''"], ['track_quantity', 'INTEGER DEFAULT 1'], ['continue_selling', 'INTEGER DEFAULT 0'],
  ['delivery_inside', "REAL DEFAULT NULL"], ['delivery_outside', "REAL DEFAULT NULL"], ['payment_auto', 'INTEGER DEFAULT 1'], ['payment_cod', 'INTEGER DEFAULT 0'], ['advance_payment', "TEXT DEFAULT 'none'"],
  ['sample_pdf', "TEXT DEFAULT ''"], ['youtube_url', "TEXT DEFAULT ''"], ['seo_handle', "TEXT DEFAULT ''"], ['seo_title', "TEXT DEFAULT ''"], ['seo_description', "TEXT DEFAULT ''"]
];
for (const [name,type] of productEditorColumns) { if (!productCols.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${type}`); }

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
const customerStatusCols = new Set(db.prepare('PRAGMA table_info(customers)').all().map(c=>c.name));
if (!customerStatusCols.has('status')) db.exec("ALTER TABLE customers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
const defaults = { shop_name: 'Uni Shop', hotline_number: '01758254433', delivery_inside_dhaka: '80', delivery_outside_dhaka: '150', cod_enabled: 'true', bkash_enabled: 'true', nagad_enabled: 'true', online_payment_enabled: 'true', newsletter_enabled: 'true' };
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
Object.entries(defaults).forEach(([k,v]) => insertSetting.run(k,v));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT,'data','catalog.json'),'utf8'));
const catalogSkus = [...new Set((catalog.products || []).map(p => String(p.sku || '').trim()).filter(Boolean))];
const upsertCatalogProduct = db.prepare(`
  INSERT INTO products(sku,title,price,compare_price,category,image,stock,active,featured,description,variants_json,options_json,display_sku)
  VALUES(@sku,@title,@price,@compare_price,@category,@image,@stock,@active,@featured,@description,'[]','[]',@display_sku)
  ON CONFLICT(sku) DO NOTHING
`);
const syncCatalog = db.transaction(() => {
  for (const p of catalog.products || []) {
    const sku = String(p.sku || '').trim();
    if (!sku) continue; // Blank source SKUs use private stable keys in the catalog.
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
      description: String(p.description || ''),
      display_sku: String(p.displaySku !== undefined ? p.displaySku : p.sku || '')
    });
  }
  // Keep old products for order/history references, but hide SKUs absent from the current source.
// Keep admin-managed products active states unchanged during startup.
  const currentCategories = (catalog.categories || []).map(name => String(name || '').trim()).filter(Boolean);// Preserve category active states during startup.
  const upsertCategory = db.prepare(`
    INSERT INTO categories(name,active,sort_order) VALUES(?,1,?)
    ON CONFLICT(name) DO NOTHING
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
const legacyAdminSeedName=getSetting.get('admin_username')?.value; const legacyAdminSeedHash=getSetting.get('admin_password_hash')?.value;
if(legacyAdminSeedName&&legacyAdminSeedHash&&!db.prepare('SELECT 1 FROM admin_users LIMIT 1').get()) db.prepare("INSERT INTO admin_users(username,password_hash,role,active,created_at) VALUES(?,?, 'admin',1,?)").run(legacyAdminSeedName,legacyAdminSeedHash,new Date().toISOString());
const adminOnly = (req,res,next) => req.session && req.session.admin === true ? next() : res.status(401).json({error:'Admin login required'});
// Upload multiple product images (admin only)

app.post('/api/admin/products/upload-pdf', adminOnly, (req,res,next)=>{
  uploadProductPdf.single('pdf')(req,res,err=>{
    if(err) return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'PDF must be 20 MB or smaller.':err.message||'PDF upload failed.'});
    next();
  });
}, (req,res)=>{ if(!req.file)return res.status(400).json({error:'Choose a PDF file.'}); res.json({url:'/uploads/products/'+req.file.filename,name:req.file.originalname}); });
app.post(
  '/api/admin/products/upload-images',
  adminOnly,
  (req, res, next) => {
    uploadProductImages.array('images', 10)(req, res, (err) => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? 'প্রতিটি ছবির সাইজ সর্বোচ্চ 5 MB হতে পারবে।'
          : err.code === 'LIMIT_FILE_COUNT'
            ? 'একসঙ্গে সর্বোচ্চ 10টি ছবি আপলোড করা যাবে।'
            : err.message || 'ছবি আপলোড করা যায়নি।';

        return res.status(400).json({ error: message });
      }

      next();
    });
  },
  (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'অন্তত একটি ছবি নির্বাচন করুন।'
      });
    }

    const images = req.files.map(file => ({
      url: '/uploads/products/' + file.filename,
      filename: file.filename
    }));

    res.status(201).json({ ok: true, images });
  }
);
const loginLimiter = rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:true,legacyHeaders:false});
const orderLimiter = rateLimit({windowMs:10*60*1000,limit:20,standardHeaders:true,legacyHeaders:false});
const makeAutoSku = () => {
  let sku;
  do {
    sku = 'AUTO-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (db.prepare('SELECT 1 FROM products WHERE sku=?').get(sku));
  return sku;
};
const normalizeDisplaySku = value => String(value ?? '').trim();

const publicProduct = r => ({sku:r.sku,displaySku:r.display_sku || '',title:r.title,price:r.price,compare:r.compare_price,category:r.category,image:r.image,stock:r.stock,featured:!!r.featured,description:r.description,variants:JSON.parse(r.variants_json||'[]'),options:JSON.parse(r.options_json||'[]')});
const productStmt = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY featured DESC,title');
app.get('/api/health', (_req,res)=>res.json({ok:true,service:'uni-shop-api'}));
app.get('/api/products', (_req,res)=>res.json({products:productStmt.all().map(publicProduct),categories:db.prepare('SELECT name FROM categories WHERE active=1 ORDER BY sort_order,name').all().map(x=>x.name)}));
app.get('/api/store-config',(_req,res)=>{const v=k=>getSetting.get(k)?.value;res.json({shopName:v('shop_name')||'Uni Shop',hotlineNumber:v('hotline_number')||'01758254433',announcement:v('announcement')||'',heroImage:v('hero_image')||'',sliderInterval:Number(v('slider_interval')||5),deliveryInsideDhaka:Number(v('delivery_inside_dhaka')||80),deliveryOutsideDhaka:Number(v('delivery_outside_dhaka')||150),deliveryTimeInsideDhaka:v('delivery_time_inside_dhaka')||'1–3 business days',deliveryTimeOutsideDhaka:v('delivery_time_outside_dhaka')||'2–5 business days',codEnabled:v('cod_enabled')!=='false',bkashEnabled:v('bkash_enabled')!=='false',nagadEnabled:v('nagad_enabled')!=='false',onlinePaymentEnabled:v('online_payment_enabled')==='true',newsletterEnabled:v('newsletter_enabled')!=='false'});});
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

app.post('/api/customer/login',loginLimiter,async(req,res)=>{const login=String(req.body.login||req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');const c=db.prepare('SELECT * FROM customers WHERE lower(email)=?').get(login);if(!c||String(c.status||'active')!=='active'||!await bcrypt.compare(password,c.password_hash))return res.status(401).json({error:String(c?.status||'active')==='suspended'?'This customer account is suspended.':'Invalid email or password.'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not create customer session'});req.session.customerId=c.id;req.session.save(e=>{if(e)return res.status(500).json({error:'Could not save customer session'});res.json({ok:true,id:c.id,name:c.name,email:c.email,phone:c.phone})})})});
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
app.get('/api/products/:sku/reviews',(req,res)=>{const sku=String(req.params.sku);const rows=db.prepare("SELECT r.rating,r.body,r.created_at,c.name customer_name FROM reviews r JOIN customers c ON c.id=r.customer_id WHERE r.sku=? AND COALESCE(r.status,'approved')='approved' ORDER BY r.created_at DESC LIMIT 100").all(sku);const avg=db.prepare("SELECT AVG(rating) average,COUNT(*) count FROM reviews WHERE sku=? AND COALESCE(status,'approved')='approved'").get(sku);res.json({reviews:rows,average:Number(avg.average||0),count:Number(avg.count||0)})});
app.post('/api/products/:sku/reviews',customerOnly,(req,res)=>{const sku=String(req.params.sku),rating=Number(req.body.rating),body=String(req.body.body||'').trim();if(!db.prepare('SELECT 1 FROM products WHERE sku=? AND active=1').get(sku))return res.status(404).json({error:'Product not found'});if(!Number.isInteger(rating)||rating<1||rating>5||body.length<8||body.length>1200)return res.status(400).json({error:'Choose 1–5 stars and write a review between 8 and 1200 characters.'});try{db.prepare("INSERT INTO reviews(sku,customer_id,rating,body,created_at,status) VALUES(?,?,?,?,?,'pending') ON CONFLICT(sku,customer_id) DO UPDATE SET rating=excluded.rating,body=excluded.body,created_at=excluded.created_at,status='pending',moderated_at=NULL").run(sku,req.session.customerId,rating,body,new Date().toISOString());res.status(201).json({ok:true})}catch(e){res.status(500).json({error:'Could not save review'})}});
function releaseOrderStock(orderId){const row=db.prepare('SELECT items_json,stock_reserved,stock_released FROM orders WHERE id=?').get(orderId);if(!row||!row.stock_reserved||row.stock_released)return false;const items=JSON.parse(row.items_json||'[]');const tx=db.transaction(()=>{for(const item of items)db.prepare('UPDATE products SET stock=stock+? WHERE sku=?').run(Math.max(1,Number(item.qty)||1),String(item.sku));db.prepare('UPDATE orders SET stock_reserved=0,stock_released=1 WHERE id=?').run(orderId)});tx();return true;}
const adminRoles={admin:['*'],manager:['dashboard','orders','products','customers','reviews','reports'],editor:['products','reviews','categories','inventory'],viewer:['dashboard','orders','products','customers','reviews']};
function currentAdmin(){ if(!db.prepare('SELECT 1 FROM admin_users WHERE id=?').get(reqSafeId())) return null; }
function reqSafeId(){ return 0; }
function audit(req,action,entityType='',entityId='',details={}){ try{ const id=req.session?.adminUserId||null; db.prepare('INSERT INTO audit_logs(admin_user_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?)').run(id,action,entityType,String(entityId||''),JSON.stringify(details),new Date().toISOString()); }catch(e){ console.error('Audit log failed:',e.message); } }
function adminRole(req){ return String(req.session?.adminRole||'admin'); }
function requireRole(...roles){ return (req,res,next)=>{ if(!adminOnly) return next(); if(roles.includes(adminRole(req))||adminRole(req)==='admin') return next(); return res.status(403).json({error:'You do not have permission for this action.'}); }; }
app.post('/api/admin/login',loginLimiter,async(req,res)=>{
  const username=String(req.body.username||'').trim(); const password=String(req.body.password||'');
  const user=db.prepare('SELECT * FROM admin_users WHERE lower(username)=lower(?)').get(username);
  const savedUser=getSetting.get('admin_username')?.value; const hash=getSetting.get('admin_password_hash')?.value;
  const validUser=user&&user.active&&await bcrypt.compare(password,user.password_hash);
  const legacyValid=!user&&savedUser&&username===savedUser&&hash&&await bcrypt.compare(password,hash);
  if(!validUser&&!legacyValid)return res.status(401).json({error:'Invalid username or password'});
  req.session.regenerate(err=>{ if(err)return res.status(500).json({error:'Could not create session'});
    req.session.admin=true; req.session.adminUserId=user?.id||null; req.session.adminRole=user?.role||'admin';
    if(user) db.prepare('UPDATE admin_users SET last_login_at=? WHERE id=?').run(new Date().toISOString(),user.id);
    audit(req,'admin.login','admin',user?.id||savedUser,{username:user?.username||savedUser});
    req.session.save(saveErr=>{ if(saveErr)return res.status(500).json({error:'Could not save admin session'}); res.json({ok:true,user:user?.username||savedUser,role:user?.role||'admin'}); });
  });
});
app.post('/api/admin/logout',adminOnly,(req,res)=>{audit(req,'admin.logout','admin',req.session.adminUserId||'');req.session.destroy(err=>{res.clearCookie('uni_shop_admin',{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'});if(err)return res.status(500).json({error:'Could not end admin session'});res.json({ok:true});});});
app.get('/api/admin/me',adminOnly,(req,res)=>res.json({ok:true,id:req.session.adminUserId||null,user:getSetting.get('admin_username')?.value||'owner',role:adminRole(req)}));
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
app.get('/api/admin/reviews',adminOnly,(req,res)=>{
  try {
    const statusRaw=String(req.query.status||'all').trim().toLowerCase();
    const allowed=new Set(['all','pending','approved','rejected']);
    const status=allowed.has(statusRaw)?statusRaw:'all';
    const search=String(req.query.search||'').trim().toLowerCase();
    const rows=db.prepare(`
      SELECT r.id,r.sku,r.rating,r.body,r.created_at,r.status,r.moderated_at,
             c.name customer_name,c.email customer_email,
             p.title product_title,p.image product_image
      FROM reviews r
      LEFT JOIN customers c ON c.id=r.customer_id
      LEFT JOIN products p ON p.sku=r.sku
      ${status==='all'?'':'WHERE COALESCE(r.status,"approved")=?'}
      ORDER BY CASE COALESCE(r.status,'approved') WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.created_at DESC
      LIMIT 1000
    `).all(...(status==='all'?[]:[status]));
    const filtered=search?rows.filter(r=>[r.product_title,r.sku,r.customer_name,r.customer_email,r.body].some(v=>String(v||'').toLowerCase().includes(search))):rows;
    const counts=db.prepare("SELECT COALESCE(status,'approved') status,COUNT(*) count FROM reviews GROUP BY COALESCE(status,'approved')").all();
    const summary={pending:0,approved:0,rejected:0};
    for(const row of counts) if(summary[row.status]!==undefined) summary[row.status]=Number(row.count);
    res.json({reviews:filtered,summary});
  } catch(err) { console.error('Admin reviews error:',err); res.status(500).json({error:'Could not load product reviews.'}); }
});
app.patch('/api/admin/reviews/:id',adminOnly,(req,res)=>{
  const status=String(req.body.status||'').trim().toLowerCase();
  if(!['pending','approved','rejected'].includes(status)) return res.status(400).json({error:'Invalid review status'});
  const review=db.prepare('SELECT id FROM reviews WHERE id=?').get(req.params.id);
  if(!review) return res.status(404).json({error:'Review not found'});
  db.prepare("UPDATE reviews SET status=?,moderated_at=? WHERE id=?").run(status,new Date().toISOString(),req.params.id); audit(req,'review.moderate','review',req.params.id,{status});
  res.json({ok:true,status});
});
app.delete('/api/admin/reviews/:id',adminOnly,(req,res)=>{
  const result=db.prepare('DELETE FROM reviews WHERE id=?').run(req.params.id);
  if(!result.changes) return res.status(404).json({error:'Review not found'}); audit(req,'review.delete','review',req.params.id);
  res.json({ok:true});
});
app.get('/api/admin/customers',adminOnly,(req,res)=>{
  const q=String(req.query.search||'').trim().toLowerCase(); const status=String(req.query.status||'all');
  let rows=db.prepare(`SELECT c.id,c.name,c.email,c.phone,c.created_at,c.status,
    (SELECT COUNT(*) FROM orders o WHERE lower(json_extract(o.customer_json,'$.email'))=lower(c.email)) AS order_count,
    (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE lower(json_extract(o.customer_json,'$.email'))=lower(c.email) AND (o.payment_status='paid' OR o.payment_status='cash_on_delivery')) AS lifetime_value
    FROM customers c ORDER BY c.created_at DESC LIMIT 1000`).all();
  if(status!=='all') rows=rows.filter(r=>String(r.status||'active')===status);
  if(q) rows=rows.filter(r=>[r.name,r.email,r.phone].some(v=>String(v||'').toLowerCase().includes(q)));
  res.json({customers:rows});
});
app.patch('/api/admin/customers/:id/status',adminOnly,requireRole('admin','manager'),(req,res)=>{
  const status=String(req.body.status||'').toLowerCase(); if(!['active','suspended'].includes(status))return res.status(400).json({error:'Invalid customer status'});
  const result=db.prepare('UPDATE customers SET status=? WHERE id=?').run(status,req.params.id); if(!result.changes)return res.status(404).json({error:'Customer not found'}); audit(req,'customer.status','customer',req.params.id,{status}); res.json({ok:true,status});
});
app.delete('/api/admin/customers/:id',adminOnly,requireRole('admin'),(req,res)=>{
  const c=db.prepare('SELECT id,email FROM customers WHERE id=?').get(req.params.id); if(!c)return res.status(404).json({error:'Customer not found'});
  const tx=db.transaction(()=>{db.prepare('DELETE FROM reviews WHERE customer_id=?').run(c.id);db.prepare('DELETE FROM customers WHERE id=?').run(c.id);}); tx(); audit(req,'customer.delete','customer',c.id,{email:c.email}); res.json({ok:true});
});
app.get('/api/admin/admins',adminOnly,(req,res)=>{
  const admins=db.prepare('SELECT id,username,role,active,created_at,last_login_at FROM admin_users ORDER BY created_at ASC').all();
  res.json({admins,roles:Object.keys(adminRoles).map(role=>({role,permissions:adminRoles[role]}))});
});
app.post('/api/admin/admins',adminOnly,requireRole('admin'),async(req,res)=>{
  const username=String(req.body.username||'').trim(); const password=String(req.body.password||''); const role=String(req.body.role||'viewer');
  if(!/^[A-Za-z0-9._-]{3,40}$/.test(username))return res.status(400).json({error:'Username must be 3–40 letters, numbers, dot, dash or underscore.'});
  if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters.'}); if(!adminRoles[role])return res.status(400).json({error:'Invalid role'});
  try{const hash=await bcrypt.hash(password,12);const result=db.prepare('INSERT INTO admin_users(username,password_hash,role,active,created_at) VALUES(?,?,?,1,?)').run(username,hash,role,new Date().toISOString());audit(req,'admin.create','admin',result.lastInsertRowid,{username,role});res.status(201).json({ok:true});}catch(e){res.status(409).json({error:'Admin username already exists.'});}
});
app.patch('/api/admin/admins/:id',adminOnly,requireRole('admin'),async(req,res)=>{
  const id=Number(req.params.id); const existing=db.prepare('SELECT * FROM admin_users WHERE id=?').get(id); if(!existing)return res.status(404).json({error:'Admin not found'});
  const role=req.body.role!==undefined?String(req.body.role):existing.role; const active=req.body.active!==undefined?(req.body.active?1:0):existing.active; if(!adminRoles[role])return res.status(400).json({error:'Invalid role'});
  if(req.session.adminUserId===id&&active===0)return res.status(400).json({error:'You cannot deactivate your own account.'});
  if(req.body.password!==undefined&&String(req.body.password).length<8)return res.status(400).json({error:'Password must be at least 8 characters.'});
  let sql='UPDATE admin_users SET role=?,active=?'; const vals=[role,active]; if(req.body.password){sql+=',password_hash=?';vals.push(await bcrypt.hash(String(req.body.password),12));} sql+=' WHERE id=?';vals.push(id);db.prepare(sql).run(...vals);audit(req,'admin.update','admin',id,{role,active});res.json({ok:true});
});
app.delete('/api/admin/admins/:id',adminOnly,requireRole('admin'),(req,res)=>{const id=Number(req.params.id);if(req.session.adminUserId===id)return res.status(400).json({error:'You cannot delete your own account.'});const r=db.prepare('DELETE FROM admin_users WHERE id=?').run(id);if(!r.changes)return res.status(404).json({error:'Admin not found'});audit(req,'admin.delete','admin',id);res.json({ok:true});});
app.get('/api/admin/audit',adminOnly,requireRole('admin','manager'),(req,res)=>{const search=String(req.query.search||'').trim().toLowerCase();const rows=db.prepare(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.details_json,a.created_at,u.username FROM audit_logs a LEFT JOIN admin_users u ON u.id=a.admin_user_id ORDER BY a.created_at DESC LIMIT 1000`).all();const filtered=search?rows.filter(r=>[r.action,r.entity_type,r.entity_id,r.username,r.details_json].some(v=>String(v||'').toLowerCase().includes(search))):rows;res.json({logs:filtered});});

app.patch('/api/admin/orders/:id',adminOnly,(req,res)=>{const allowed=['pending','confirmed','processing','ready_to_pack','shipped','sent_to_courier','out_for_delivery','delivered','cancelled','returned','refunded'];const status=String(req.body.status||'').trim().toLowerCase().replace(/[\s/-]+/g,'_');if(!allowed.includes(status))return res.status(400).json({error:'Invalid order status'});const current=db.prepare('SELECT status FROM orders WHERE id=?').get(req.params.id);if(!current)return res.status(404).json({error:'Order not found'});if(status==='cancelled'&&current.status!=='cancelled')releaseOrderStock(req.params.id);db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,req.params.id); audit(req,'order.status','order',req.params.id,{status}); res.json({ok:true,status})});
app.get('/api/admin/products',adminOnly,(_req,res)=>{const rows=db.prepare('SELECT * FROM products ORDER BY title').all().map(p=>({...p,internalSku:p.sku,sku:p.display_sku||p.sku,name:p.title,variants:p.variants_json?JSON.parse(p.variants_json):[],options:p.options_json?JSON.parse(p.options_json):[]}));res.json(rows)});
app.patch('/api/admin/products/:sku',adminOnly,(req,res)=>{
  const currentSku=String(req.params.sku||'').trim();
  const current=db.prepare('SELECT * FROM products WHERE sku=?').get(currentSku);
  if(!current)return res.status(404).json({error:'Product not found'});

  // Resolve the live schema at request time so older production databases remain
  // backward-compatible even when the server was upgraded before the database.
  const editableColumns = new Set(db.prepare('PRAGMA table_info(products)').all().map(c=>c.name));
  const fields={};
  for(const k of ['title','price','compare_price','category','image','stock','active','featured','description','variants_json','options_json','brand','track_quantity','continue_selling','delivery_inside','delivery_outside','payment_auto','payment_cod','advance_payment','sample_pdf','youtube_url','seo_handle','seo_title','seo_description'])
    if(req.body[k]!==undefined && editableColumns.has(k))fields[k]=req.body[k];

  if(fields.price!==undefined&&(!Number.isFinite(Number(fields.price))||Number(fields.price)<0))
    return res.status(400).json({error:'Price must be a non-negative number'});
  if(fields.stock!==undefined&&(!Number.isInteger(Number(fields.stock))||Number(fields.stock)<0))
    return res.status(400).json({error:'Stock must be a non-negative integer'});

  const hasSkuChange=Object.prototype.hasOwnProperty.call(req.body,'sku');
  if(!Object.keys(fields).length&&!hasSkuChange)
    return res.status(400).json({error:'No editable fields provided'});

  let nextSku=currentSku;
  let nextDisplaySku=current.display_sku || '';

  if(hasSkuChange){
    const requested=normalizeDisplaySku(req.body.sku);
    nextDisplaySku=requested;

    if(requested){
      nextSku=requested;
    }else if(!/^AUTO-[A-Z0-9-]+$/i.test(currentSku)){
      nextSku=makeAutoSku();
    }
    // If the current key is already AUTO-*, clearing the optional SKU only
    // clears its display value; the internal key remains stable.
  }

  if(nextSku!==currentSku){
    const collision=db.prepare('SELECT 1 FROM products WHERE sku=?').get(nextSku);
    if(collision)return res.status(409).json({error:'That SKU is already used by another product.'});
  }

  try{
    const transaction=db.transaction(()=>{
      const sets=[];
      const values=[];
      for(const [k,v] of Object.entries(fields)){
        sets.push(`${k}=?`);
        values.push(['active','featured'].includes(k)?(v?1:0):v);
      }
      // Keep display_sku nullable/empty-safe. Older databases may contain many
      // products without a display SKU, so never turn an empty value into a
      // uniqueness conflict and never assume the column exists.
      if(editableColumns.has('display_sku')){
        sets.push('display_sku=?');
        values.push(nextDisplaySku || null);
      }
      if(nextSku!==currentSku){sets.push('sku=?');values.push(nextSku);}
      values.push(currentSku);
      db.prepare(`UPDATE products SET ${sets.join(',')} WHERE sku=?`).run(...values);
    });
    transaction(); audit(req,'product.update','product',nextSku,{previousSku:currentSku});
    res.json({ok:true,sku:nextSku,displaySku:nextDisplaySku});
  }catch(e){
    console.error('Product update failed:',e);
    const raw=String(e?.message||'');
    const message=raw.toLowerCase();
    if(message.includes('unique') || message.includes('constraint')) return res.status(409).json({error:'That SKU is already used by another product. Please use a different SKU.'});
    if(message.includes('readonly') || message.includes('read-only')) return res.status(503).json({error:'Product storage is read-only on the server.'});
    // Return the real server-side failure instead of masking it as a generic
    // error; this also makes the next diagnosis deterministic without changing
    // the existing UI flow.
    res.status(500).json({error:`Could not update product: ${raw || 'database update failed'}`});
  }
});
app.post('/api/admin/products',adminOnly,(req,res)=>{
  const p=req.body||{};
  if(!p.title||!Number.isFinite(Number(p.price))||Number(p.price)<0)
    return res.status(400).json({error:'Product title and a valid price are required'});

  const requestedSku=normalizeDisplaySku(p.sku);
  const internalSku=requestedSku||makeAutoSku();
  const displaySku=requestedSku;

  try{
    db.prepare(`INSERT INTO products(sku,title,price,compare_price,category,image,stock,active,featured,description,variants_json,options_json,display_sku,brand,track_quantity,continue_selling,delivery_inside,delivery_outside,payment_auto,payment_cod,advance_payment,sample_pdf,youtube_url,seo_handle,seo_title,seo_description) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(internalSku,String(p.title),Number(p.price),Number(p.compare||p.compare_price||0),String(p.category||''),String(p.image||''),Math.max(0,Number(p.stock)||0),p.active===false?0:1,p.featured?1:0,String(p.description||''),JSON.stringify(p.variants||[]),JSON.stringify(p.options||[]),displaySku || null,String(p.brand||''),p.track_quantity===false?0:1,p.continue_selling?1:0,p.delivery_inside===''||p.delivery_inside==null?null:Number(p.delivery_inside),p.delivery_outside===''||p.delivery_outside==null?null:Number(p.delivery_outside),p.payment_auto===false?0:1,p.payment_cod?1:0,String(p.advance_payment||'none'),String(p.sample_pdf||''),String(p.youtube_url||''),String(p.seo_handle||''),String(p.seo_title||''),String(p.seo_description||''));
    audit(req,'product.create','product',internalSku,{title:String(p.title)}); res.status(201).json({ok:true,sku:internalSku,displaySku});
  }catch(e){
    res.status(409).json({error:'Could not add product; SKU may already exist'});
  }
});
app.get('/api/admin/categories',adminOnly,(_req,res)=>{const rows=db.prepare('SELECT name,active,sort_order,parent_name,image_url FROM categories ORDER BY parent_name,sort_order,name').all().map(c=>({...c,id:c.name,slug:c.name}));res.json(rows)});
app.put('/api/admin/categories/:name',adminOnly,(req,res)=>{
  const oldName=String(req.params.name||'').trim();
  const newName=String(req.body.name||'').trim();
  const parentName=String(req.body.parent_name||'').trim();
  const imageUrl=String(req.body.image_url||'').trim();
  if(!newName)return res.status(400).json({error:'Category name is required'});
  if(parentName===newName)return res.status(400).json({error:'A category cannot be its own parent'});
  const current=db.prepare('SELECT name FROM categories WHERE name=?').get(oldName);
  if(!current)return res.status(404).json({error:'Category not found'});
  if(parentName && !db.prepare('SELECT 1 FROM categories WHERE name=?').get(parentName)) return res.status(400).json({error:'Parent category not found'});
  try{
    db.transaction(()=>{
      db.prepare('UPDATE categories SET name=?,parent_name=?,image_url=? WHERE name=?').run(newName,parentName,imageUrl,oldName);
      if(newName!==oldName){
        db.prepare('UPDATE categories SET parent_name=? WHERE parent_name=?').run(newName,oldName);
        db.prepare('UPDATE products SET category=? WHERE category=?').run(newName,oldName);
      }
    })();
    audit(req,'category.update','category',newName,{previousName:oldName}); res.json({ok:true});
  }catch(e){res.status(409).json({error:'Category already exists or could not be updated'});}
});
app.post('/api/admin/categories',adminOnly,(req,res)=>{const name=String(req.body.name||'').trim();const parentName=String(req.body.parent_name||'').trim();const imageUrl=String(req.body.image_url||'').trim();if(!name)return res.status(400).json({error:'Category name is required'});if(parentName===name)return res.status(400).json({error:'A category cannot be its own parent'});if(parentName&&!db.prepare('SELECT 1 FROM categories WHERE name=?').get(parentName))return res.status(400).json({error:'Parent category not found'});try{db.prepare('INSERT INTO categories(name,active,sort_order,parent_name,image_url) VALUES(?,1,?,?,?)').run(name,db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM categories WHERE parent_name=?').get(parentName).n,parentName,imageUrl);audit(req,'category.create','category',name,{parentName});res.status(201).json({ok:true})}catch(e){res.status(409).json({error:'Category already exists'})}});
app.patch('/api/admin/categories/:name',adminOnly,(req,res)=>{const result=db.prepare('UPDATE categories SET active=? WHERE name=?').run(req.body.active?1:0,req.params.name);if(!result.changes)return res.status(404).json({error:'Category not found'});audit(req,'category.status','category',req.params.name,{active:!!req.body.active});res.json({ok:true})});
app.post('/api/admin/categories/:name/order',adminOnly,(req,res)=>{
  const name=String(req.params.name||'').trim(); const direction=req.body.direction==='down'?'down':'up';
  const current=db.prepare('SELECT name,parent_name,sort_order FROM categories WHERE name=?').get(name);
  if(!current)return res.status(404).json({error:'Category not found'});
  const neighbor=direction==='up'
    ? db.prepare('SELECT name,sort_order FROM categories WHERE parent_name=? AND sort_order<? ORDER BY sort_order DESC LIMIT 1').get(current.parent_name||'',current.sort_order)
    : db.prepare('SELECT name,sort_order FROM categories WHERE parent_name=? AND sort_order>? ORDER BY sort_order ASC LIMIT 1').get(current.parent_name||'',current.sort_order);
  if(!neighbor)return res.json({ok:true,moved:false});
  db.transaction(()=>{
    db.prepare('UPDATE categories SET sort_order=? WHERE name=?').run(neighbor.sort_order,name);
    db.prepare('UPDATE categories SET sort_order=? WHERE name=?').run(current.sort_order,neighbor.name);
  })();
  res.json({ok:true,moved:true});
});
app.post('/api/admin/categories/:name/subcategories',adminOnly,(req,res)=>{
  const parentName=String(req.params.name||'').trim(); const name=String(req.body.name||'').trim(); const imageUrl=String(req.body.image_url||'').trim();
  if(!name)return res.status(400).json({error:'Subcategory name is required'});
  if(!db.prepare('SELECT 1 FROM categories WHERE name=?').get(parentName))return res.status(404).json({error:'Parent category not found'});
  if(name===parentName)return res.status(400).json({error:'A category cannot be its own child'});
  try{const next=db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM categories WHERE parent_name=?').get(parentName).n;db.prepare('INSERT INTO categories(name,active,sort_order,parent_name,image_url) VALUES(?,1,?,?,?)').run(name,next,parentName,imageUrl);res.status(201).json({ok:true});}catch(e){res.status(409).json({error:'Category already exists'});
  }
});

app.delete('/api/admin/categories/:name', adminOnly, (req, res) => {
  const name = String(req.params.name || '').trim();

  const category = db.prepare(
    'SELECT name FROM categories WHERE name = ?'
  ).get(name);

  if (!category) {
    return res.status(404).json({ error: 'Category not found' });
  }

  const product = db.prepare(
    'SELECT 1 FROM products WHERE category = ? LIMIT 1'
  ).get(name);

  if (product) {
    return res.status(409).json({
      error: 'This category has products. Move those products to another category before deleting it.'
    });
  }

  db.prepare('DELETE FROM categories WHERE name = ?').run(name);

  res.json({ ok: true });
});

app.get('/api/admin/settings',adminOnly,(_req,res)=>{const out={};db.prepare('SELECT key,value FROM settings').all().forEach(x=>{if(!x.key.includes('password')&&!x.key.includes('api_key'))out[x.key]=x.value});res.json(out)});
app.patch('/api/admin/settings',adminOnly,(req,res)=>{
  const editable=['shop_name','admin_notification_email','hotline_number','logo_url','favicon_url','pixel_id','cod_enabled','newsletter_enabled','announcement','hero_image','slider_interval','delivery_inside_dhaka','delivery_outside_dhaka','delivery_time_inside_dhaka','delivery_time_outside_dhaka','supplier_name','supplier_url','supplier_sync','supplier_orders','theme','language','currency','gtm_id','ga4_id','bkash_enabled','nagad_enabled','online_payment_enabled'];
  if(req.body.slider_interval!==undefined){const n=Number(req.body.slider_interval);if(!Number.isInteger(n)||n<2||n>60)return res.status(400).json({error:'Slider interval must be between 2 and 60 seconds.'});}
  for(const k of ['delivery_inside_dhaka','delivery_outside_dhaka']){if(req.body[k]!==undefined){const n=Number(req.body[k]);if(!Number.isFinite(n)||n<0||n>100000)return res.status(400).json({error:`${k} must be between 0 and 100000.`});}}
  for(const k of editable)if(req.body[k]!==undefined)setSetting.run(k,String(req.body[k]));
  audit(req,'settings.update','settings','store',Object.keys(req.body||{}));
  res.json({ok:true});
});
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
