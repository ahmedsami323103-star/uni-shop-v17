# Uni Shop V16 — Storefront + Backend Starter

## V16 updates
- Buy Now buttons use the Uni Shop teal brand color.
- Shopping cart rows now include the actual product thumbnail, with responsive spacing.
- Customer registration asks for name, email, and password only; login uses email and password. A successful login opens the customer profile with the saved name and email.
- The customer database migration allows phone to remain empty at registration; delivery phone is still collected separately at checkout. Existing customer records are preserved by the migration.
- Hotline strip is thinner and the extra delivery/COD text above it is removed.
- Reduced vertical spacing around the hero/trust/category areas so products appear sooner.
- Improved modal/product transitions, sticky modal controls, darker variant dropdown styling, and faster product image priority/decoding.
- Fixed a catalog issue found during review: all 186 products now have unique SKUs, so cart quantity controls, order matching, reviews and stock records do not collide for products that previously had a blank SKU. Existing databases are repaired and missing catalog items are synced on startup.

## Included
- Responsive storefront with 186 products and 10 categories from the supplied catalog.
- Mobile account/cart icon buttons, menu links, policy pages and category navigation.
- Checkout does not ask customers for an email. UddoktaPay contact email is configured only on the server via `UDDOKTAPAY_DEFAULT_EMAIL`.
- SQLite-backed products, categories, settings, orders, customer accounts and reviews.
- Admin dashboard for product stock/price/visibility, orders, categories, delivery fees, payment toggles, hotline and notification email.
- UddoktaPay checkout/verification scaffold. Live payments remain disabled by default.

## Run locally
1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set a long random `SESSION_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` before the first start.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`; the admin panel is at `http://localhost:3000/admin`.
6. Configure HTTPS, SMTP and UddoktaPay merchant credentials on the server before taking real payments. Never put API secrets in browser code or send them in chat.

## Important production checks
- Configure SMTP and `ADMIN_NOTIFICATION_EMAIL` for order notifications.
- Configure `UDDOKTAPAY_API_KEY`, `UDDOKTAPAY_DEFAULT_EMAIL`, `UDDOKTAPAY_BASE_URL`, and `PUBLIC_BASE_URL` only from the merchant account and official docs. Online payments are disabled by default.
- Current stock decrement is product-SKU based; variant-level stock must be modeled separately if different variants have independent inventories.
- Confirm delivery-zone rules, returns/refunds policy, privacy terms and support contact details before launch.
- Configure domain, HTTPS, database backups, security monitoring and real payment callbacks before public launch.
- The local-file preview uses browser-local cart/review demo data and cannot authenticate customer accounts or verify live payment processing.
- This is a starter implementation, not a hosted or production-certified store. Browser preview cannot verify live payment processing.


## V17 update
- Fixed customer account form visibility: Login shows only email and password; Register shows name, email and password (no duplicate email fields).
- Buy Now buttons on product cards and product details use a darker, logo-matched teal gradient with white text.
- These interface settings can be edited later in `public/index.html`; business settings remain in the Admin Panel where supported.
- Free hosting may be possible for a prototype, but confirm that the provider supports Node.js, persistent SQLite storage, sessions, environment variables, and custom domains before using it for real orders. Some free services sleep or reset local files.
