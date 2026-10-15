# Uni_Shop — Customer Dashboard + Admin Panel

Responsive HTML/CSS/JavaScript frontend with a Node.js/Express API, MongoDB persistence, bcrypt password hashing, and MongoDB-backed sessions.

## Included

- Login and registration tabs; email/password authentication; optional phone; terms checkbox
- Session cookies (`HttpOnly`, `SameSite=Lax`, `Secure` in production), session ID rotation after login
- Customer dashboard, order history, order tracking, profile, security, and placeholder navigation for the remaining requested sections
- Admin-only customer listing, account suspension/reactivation/deletion, and order-status management
- Server-side role checks, login/register rate limiting, Helmet security headers, input validation, and MongoDB storage
- Responsive layout for phone, tablet, and desktop

## Important feature boundaries

This is a working account/dashboard foundation, not a complete commerce engine. The project does **not** yet create orders from your existing checkout, manage real products or wishlists, send password-reset emails, or implement Google/Facebook OAuth. Social buttons explain that OAuth is not connected; do not advertise it as enabled until provider credentials and callback routes are configured. A real payment gateway must be integrated and verified before taking payments. The Terms & Conditions link must be replaced with your published policy.

## 1. Create a MongoDB database

1. Sign in to MongoDB Atlas and create a cluster.
2. Create a database user with a strong password.
3. In Network Access, allow your deployment to connect. Prefer Render's outbound IP controls if available; `0.0.0.0/0` is easier for testing but less restrictive.
4. Copy the MongoDB connection string and replace the username/password and database name.

## 2. Run locally

Install Node.js 20 or newer. In the project folder:

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `MONGODB_URI`, a long random `SESSION_SECRET`, `APP_ORIGIN`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`. Never commit `.env`.

```bash
npm start
```

Open `http://localhost:3000`. Register a customer account, then sign in with the admin credentials set in `.env`. The first startup creates the admin account if that email does not already exist. If the email already belongs to a customer, the app intentionally does not promote it automatically.

## 3. Push to GitHub

1. Create a new empty GitHub repository.
2. Upload the project files, or use Git locally:

```bash
git init
git add .
git commit -m "Add Uni_Shop dashboard and admin panel"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

Check `.gitignore` and confirm `.env` is not in the commit.

## 4. Deploy to Render

1. In Render, choose **New → Web Service** and connect the GitHub repository.
2. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
3. Add environment variables:
   - `NODE_ENV` = `production`
   - `MONGODB_URI` = your Atlas connection string
   - `SESSION_SECRET` = a long random secret (32+ characters)
   - `APP_ORIGIN` = your Render URL, e.g. `https://your-service.onrender.com`
   - `ADMIN_EMAIL` = a unique admin email
   - `ADMIN_PASSWORD` = a strong, unique password
4. Deploy and check `https://YOUR-SERVICE.onrender.com/api/health`; it should return `{"ok":true,"database":"connected"}`.
5. Register a customer and test login/logout. Sign in with the configured admin email to see Admin Panel.

`render.yaml` can be used as a Blueprint, but the environment variables marked `sync: false` must be supplied in Render's dashboard.

## Production checklist before public launch

- Use a unique admin email/password and rotate any credentials shared in chats or screenshots.
- Configure verified email delivery and a secure one-time password-reset flow.
- Add CSRF protection/origin validation for state-changing endpoints if you deploy under a custom cross-site architecture; keep same-origin deployment and `SameSite=Lax` cookies.
- Configure Google/Facebook OAuth with their official SDKs, redirect URIs, state validation, and secrets kept only in Render environment variables.
- Add audit logs, backups, monitoring, and a documented retention policy for customer data.
- Connect this user/order schema to the existing checkout and product catalogue; don't assume a successful checkout automatically appears here until the API integration is built and tested.
- Implement a real wishlist, address book, notifications, coupons, and reviews before presenting those menu items as complete.
- Run dependency audits and test role boundaries before production.

## API outline

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/dashboard`
- `GET /api/orders`
- `PATCH /api/profile`
- `GET /api/admin/users`
- `PATCH /api/admin/users/:id/status`
- `DELETE /api/admin/users/:id`
- `GET /api/admin/orders`
- `PATCH /api/admin/orders/:id/status`

The `Order` model is ready for integration but no public order-creation endpoint is provided, so customers cannot fabricate order totals through the browser.
