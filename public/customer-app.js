const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
let currentUser = null;
let dashboardData = null;
let activePage = "dashboard";
let toastTimer;

function toast(message, type = "") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.className = "toast", 3600);
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed. Please try again.");
  return data;
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function money(value) { return new Intl.NumberFormat("en-BD", { style: "currency", currency: "BDT", maximumFractionDigits: 0 }).format(Number(value) || 0); }
function date(value) { return value ? new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—"; }
function statusClass(status = "") { return status.toLowerCase().replace(/\s+/g, "-"); }

function showAuth(tab = "login") {
  $("#appView").classList.add("hidden");
  $("#authView").classList.remove("hidden");
  switchAuthTab(tab);
}
function showApp() {
  $("#authView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#headerName").textContent = currentUser.name;
  $("#headerRole").textContent = currentUser.role === "admin" ? "Administrator" : "Customer account";
  $("#avatar").textContent = (currentUser.name || "U").trim().charAt(0).toUpperCase();
  $("#adminNav").classList.toggle("hidden", currentUser.role !== "admin");
  goPage(currentUser.role === "admin" ? "admin" : "dashboard");
}
function switchAuthTab(tab) {
  $$(".auth-tab").forEach(b => b.classList.toggle("active", b.dataset.authTab === tab));
  $("#loginForm").classList.toggle("hidden", tab !== "login");
  $("#registerForm").classList.toggle("hidden", tab !== "register");
}
$$("[data-auth-tab]").forEach(b => b.addEventListener("click", () => switchAuthTab(b.dataset.authTab)));

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();

  const form = new FormData(e.currentTarget);
  const button = e.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const data = await api("/api/customer/login", {
      method: "POST",
      body: JSON.stringify({
        login: form.get("email"),
        password: form.get("password")
      })
    });

    currentUser = {
      ...data,
      role: "customer"
    };

    showApp();
    toast("Welcome back!", "success");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    button.disabled = false;
  }
});
$("#registerForm").addEventListener("submit", async e => {
e.preventDefault();

const form = new FormData(e.currentTarget);

if (form.get("password") !== form.get("confirmPassword")) {
return toast("Passwords do not match.", "error");
}

const button = e.currentTarget.querySelector('button[type="submit"]');
button.disabled = true;

try {
const data = await api("/api/customer/register", {
method: "POST",
body: JSON.stringify({
name: form.get("name"),
email: form.get("email"),
phone: form.get("phone"),
password: form.get("password")
})
});

currentUser = { ...data, role: "customer" };
showApp();
toast("Your account has been created.", "success");

} catch (err) {
toast(err.message, "error");
} finally {
button.disabled = false;
}
});
$("#forgotButton").addEventListener("click", () => toast("Password reset email requires an email delivery provider. Configure one before enabling password recovery."));
$("#termsLink").addEventListener("click", e => { e.preventDefault(); toast("Add your published Terms & Conditions URL before launch."); });
$$("[data-social]").forEach(b => b.addEventListener("click", () => toast(`${b.dataset.social} sign-in is not connected yet. Configure OAuth credentials and callback routes first.`)));
$("#logoutButton").addEventListener("click", logout);
$("#dropdownLogout").addEventListener("click", logout);
async function logout() {
  try {
  await api("/api/customer/logout", {
    method: "POST",
    body: "{}"
  });
} catch (_) {}  currentUser = null; dashboardData = null; showAuth("login"); toast("You have logged out.", "success");
}
$("#menuButton").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#userMenuButton").addEventListener("click", () => $("#userDropdown").classList.toggle("hidden"));
$("#notificationButton").addEventListener("click", () => goPage("notifications"));
$$("[data-page]").forEach(b => b.addEventListener("click", e => {
  e.preventDefault();
  const page = b.dataset.page;
  if (page) goPage(page);
}));
function goPage(page) {
  if (page === "admin" && currentUser?.role !== "admin") return toast("Admin access required.", "error");
  activePage = page;
  $("#userDropdown").classList.add("hidden");
  $("#sidebar").classList.remove("open");
  $$(".nav-link[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  if (page === "dashboard") renderDashboardPage();
  else if (page === "orders") renderOrdersPage();
  else if (page === "admin") renderAdminPage();
  else if (page === "profile") renderProfilePage();
  else if (page === "security") renderSecurityPage();
  else if (page === "track") renderTrackPage();
  else renderComingSoon(page);
}
function pageHeader(title, subtitle) { return `<h1 class="page-title">${escapeHtml(title)}</h1><p class="page-subtitle">${escapeHtml(subtitle)}</p>`; }
function renderDashboardPage() {
  $("#pageContent").innerHTML = `<div class="welcome-banner"><div><div class="eyebrow">YOUR ACCOUNT OVERVIEW</div><h1>Welcome back, ${escapeHtml(currentUser.name.split(" ")[0])} 👋</h1><p>Here’s what’s happening with your orders today.<br>Manage your shopping from one simple dashboard.</p></div><button class="banner-button" data-page="orders">VIEW MY ORDERS&nbsp; →</button></div><div class="section-heading"><div><h2>Account overview</h2><p>A quick snapshot of your shopping activity</p></div><button class="plain-button" id="refreshDashboard">↻ Refresh</button></div><div id="metricMount"><div class="empty-state">Loading your dashboard…</div></div><div class="content-grid"><section class="panel"><div class="panel-head"><div><h2>Recent orders</h2><p>Keep track of your latest purchases</p></div><button class="plain-button" data-page="orders">View all</button></div><div id="recentOrders" class="table-wrap"><div class="empty-state">Loading orders…</div></div></section><section class="panel"><div class="panel-head"><div><h2>Quick actions</h2><p>Common tasks, just one click away</p></div></div><div class="quick-actions"><button class="quick-action" data-page="orders"><span class="quick-icon">▤</span><span><strong>View my orders</strong><small>See purchase history and status</small></span><span class="arrow">→</span></button><button class="quick-action" data-page="track"><span class="quick-icon">⌖</span><span><strong>Track a delivery</strong><small>Check the latest order progress</small></span><span class="arrow">→</span></button><button class="quick-action" data-page="profile"><span class="quick-icon">♙</span><span><strong>Update my profile</strong><small>Keep your contact details current</small></span><span class="arrow">→</span></button><button class="quick-action" data-page="support"><span class="quick-icon">◌</span><span><strong>Get support</strong><small>Find help with your account</small></span><span class="arrow">→</span></button></div></section></div>`;
  $$("[data-page]", $("#pageContent")).forEach(b => b.addEventListener("click", () => goPage(b.dataset.page)));
  $("#refreshDashboard").addEventListener("click", loadDashboard);
  loadDashboard();
}
async function loadDashboard() {
  try {
    dashboardData = await api("/api/dashboard");
    const m = dashboardData.metrics;
    const metrics = [
      ["Total orders", m.totalOrders, "▤", "All-time purchases"],
      ["Pending", m.pending, "◷", "Awaiting processing"],
      ["Shipped", m.shipped, "➤", "On the way to you"],
      ["Delivered", m.delivered, "✓", "Successfully received"],
      ["Wishlist", m.wishlist, "♡", "Saved favourites"]
    ];
    $("#metricMount").innerHTML = `<div class="metrics-grid">${metrics.map(([label, value, icon, foot]) => `<article class="metric-card"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon}</span></div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></article>`).join("")}</div>`;
    $("#recentOrders").innerHTML = dashboardData.orders.length ? `<table><thead><tr><th>ORDER</th><th>DATE</th><th>TOTAL</th><th>STATUS</th><th></th></tr></thead><tbody>${dashboardData.orders.slice(0, 5).map(o => `<tr><td><span class="order-no">#${escapeHtml(o.orderNumber)}</span></td><td>${date(o.createdAt)}</td><td><strong>${money(o.total)}</strong></td><td><span class="status ${statusClass(o.status)}">${escapeHtml(o.status)}</span></td><td><button class="row-action" data-track="${escapeHtml(o.orderNumber)}">Details</button></td></tr>`).join("")}</tbody></table>` : `<div class="empty-state"><strong>No orders yet</strong>Your orders will appear here after checkout.</div>`;
    $$("[data-track]").forEach(b => b.addEventListener("click", () => { goPage("track"); $("#trackOrderInput").value = b.dataset.track; }));
  } catch (e) { $("#metricMount").innerHTML = `<div class="inline-notice">${escapeHtml(e.message)}</div>`; $("#recentOrders").innerHTML = ""; }
}
async function renderOrdersPage() {
  $("#pageContent").innerHTML = `${pageHeader("My Orders", "View your purchases and follow their progress")}<section class="panel"><div class="panel-head"><h2>Order history</h2><button class="plain-button" id="reloadOrders">↻ Refresh</button></div><div id="allOrders" class="table-wrap"><div class="empty-state">Loading orders…</div></div></section>`;
  $("#reloadOrders").addEventListener("click", renderOrdersPage);
  try {
    const { orders } = await api("/api/orders");
    $("#allOrders").innerHTML = orders.length ? `<table><thead><tr><th>ORDER</th><th>DATE</th><th>ITEMS</th><th>TOTAL</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>${orders.map(o => `<tr><td><span class="order-no">#${escapeHtml(o.orderNumber)}</span></td><td>${date(o.createdAt)}</td><td>${(o.items || []).reduce((n, i) => n + (i.quantity || 0), 0)}</td><td><strong>${money(o.total)}</strong></td><td><span class="status ${statusClass(o.status)}">${escapeHtml(o.status)}</span></td><td><button class="row-action" data-track="${escapeHtml(o.orderNumber)}">Track</button></td></tr>`).join("")}</tbody></table>` : `<div class="empty-state"><strong>No orders found</strong>Once you place an order, it will be listed here.</div>`;
    $$("[data-track]").forEach(b => b.addEventListener("click", () => { goPage("track"); $("#trackOrderInput").value = b.dataset.track; }));
  } catch (e) { $("#allOrders").innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`; }
}

function renderTrackPage() {
  $("#pageContent").innerHTML = `
    ${pageHeader(
      "Track Order",
      "Track your delivery and view complete order information"
    )}

    <section class="track-search-card">
      <div class="track-search-heading">
        <div>
          <span class="track-eyebrow">ORDER TRACKING</span>
          <h2>Where is your order?</h2>
          <p>Enter your order number to see its latest details.</p>
        </div>
        <div class="track-search-icon">⌕</div>
      </div>

      <form id="trackForm" class="track-search-form">
        <label for="trackOrderInput">Order number</label>
        <div class="track-search-row">
          <input
            id="trackOrderInput"
            placeholder="e.g. US-MVAGRLHO"
            required
          >
          <button class="primary-button" type="submit">
            TRACK ORDER →
          </button>
        </div>
      </form>
      <p class="track-help">Use the order number shown in your order confirmation.</p>
    </section>

    <div id="trackResult"></div>
  `;

  $("#trackForm").addEventListener("submit", async e => {
    e.preventDefault();

    const query = $("#trackOrderInput").value.trim().replace(/^#/, "").toLowerCase();
    const result = $("#trackResult");

    result.innerHTML = `
      <div class="track-loading">
        <div class="track-spinner"></div>
        <strong>Finding your order...</strong>
        <p>Please wait while we load the order details.</p>
      </div>
    `;

    try {
      const data = await api("/api/orders");
      const orders = data.orders || [];

      const order = orders.find(o =>
        String(o.orderNumber || "").replace(/^#/, "").toLowerCase() === query ||
        String(o._id || "").toLowerCase() === query
      );

      if (!order) {
        result.innerHTML = `
          <div class="track-empty">
            <div class="track-empty-icon">⌕</div>
            <h3>Order not found</h3>
            <p>Check the order number and try again. Only orders available in your account can be displayed.</p>
          </div>
        `;
        return;
      }

      const status = String(order.status || "pending").toLowerCase();
      const steps = [
        { key: "pending", title: "Order placed", detail: "Your order has been received." },
        { key: "processing", title: "Processing", detail: "Your order is being prepared." },
        { key: "shipped", title: "Shipped", detail: "Your parcel is on its way." },
        { key: "delivered", title: "Delivered", detail: "Your order has been delivered." }
      ];

      const stage = {
        pending: 0,
        processing: 1,
        shipped: 2,
        delivered: 3
      };

      const currentStage = stage[status] ?? -1;
      const cancelled = status === "cancelled";
      const items = Array.isArray(order.items) ? order.items : [];
      const itemCount = items.reduce(
        (sum, item) => sum + Number(item.quantity || item.qty || 1), 0
      );

      const address = order.shippingAddress || order.address || order.customer || {};
      const addressText = typeof address === "string"
        ? address
        : [
            address.fullName || address.name,
            address.phone || address.mobile,
            address.address || address.fullAddress,
            address.area || address.thana,
            address.district || address.city,
            address.division
          ].filter(Boolean).join(", ");

      result.innerHTML = `
        <section class="track-order-card">
          <div class="track-order-top">
            <div>
              <span class="track-eyebrow">ORDER DETAILS</span>
              <h2>#${escapeHtml(order.orderNumber || order._id || "")}</h2>
              <p>Placed on ${date(order.createdAt)}</p>
            </div>
            <span class="status ${statusClass(status)}">
              ${escapeHtml(status)}
            </span>
          </div>

          <div class="track-summary-grid">
            <div class="track-summary-item">
              <span>Order total</span>
              <strong>${money(order.total)}</strong>
            </div>
            <div class="track-summary-item">
              <span>Items</span>
              <strong>${itemCount}</strong>
            </div>
            <div class="track-summary-item">
              <span>Payment method</span>
              <strong>${escapeHtml(order.paymentMethod || order.payment_method || "As recorded on order")}</strong>
            </div>
          </div>
        </section>

        <section class="track-detail-card">
          <div class="track-section-heading">
            <div>
              <h2>Delivery progress</h2>
              <p>Follow your order's current status</p>
            </div>
          </div>

          ${cancelled ? `
            <div class="track-cancelled">
              <strong>Order cancelled</strong>
              <p>This order is marked as cancelled. Contact support if you need help.</p>
            </div>
          ` : `
            <div class="track-timeline">
              ${steps.map((step, index) => {
                const complete = currentStage >= index;
                const current = currentStage === index;
                return `
                  <div class="track-step ${complete ? "complete" : ""} ${current ? "current" : ""}">
                    <div class="track-step-marker">${complete ? "✓" : index + 1}</div>
                    <div class="track-step-copy">
                      <strong>${step.title}</strong>
                      <p>${step.detail}</p>
                      ${current ? `<span class="track-current-label">CURRENT STATUS</span>` : ""}
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          `}
          <p class="track-status-note">
            Latest recorded status:
            <strong>${escapeHtml(order.status || "Pending")}</strong>
          </p>
        </section>

        <section class="track-detail-card">
          <div class="track-section-heading">
            <div>
              <h2>Items in this order</h2>
              <p>Products included in your purchase</p>
            </div>
          </div>

          ${items.length ? `
            <div class="track-items">
              ${items.map(item => `
                <div class="track-product-row">
                  <div class="track-product-icon">▣</div>
                  <div class="track-product-info">
                    <strong>${escapeHtml(item.title || item.name || item.sku || "Product")}</strong>
                    <span>SKU: ${escapeHtml(item.sku || "—")}</span>
                    <span>Quantity: ${Number(item.quantity || item.qty || 1)}</span>
                  </div>
                  <strong class="track-product-price">
                    ${money(Number(item.price || 0) * Number(item.quantity || item.qty || 1))}
                  </strong>
                </div>
              `).join("")}
            </div>
          ` : `
            <div class="inline-notice">
              Product-level details were not included in the order information returned by the server.
            </div>
          `}
        </section>

        <section class="track-bottom-grid">
          <div class="track-detail-card">
            <div class="track-section-heading">
              <div>
                <h2>Delivery address</h2>
                <p>Address recorded for this order</p>
              </div>
            </div>
            <div class="track-address">
              <div class="track-address-icon">⌂</div>
              <div>
                <strong>${escapeHtml(address.fullName || address.name || order.fullName || "Recipient")}</strong>
                <p>${escapeHtml(addressText || "The saved delivery address is not available in the order response.")}</p>
              </div>
            </div>
          </div>

          <div class="track-detail-card">
            <div class="track-section-heading">
              <div>
                <h2>Payment summary</h2>
                <p>Order amount breakdown</p>
              </div>
            </div>
            <div class="track-price-lines">
              <div><span>Subtotal</span><strong>${money(order.subtotal ?? order.total)}</strong></div>
              <div><span>Delivery charge</span><strong>${money(order.deliveryFee ?? order.delivery_fee ?? 0)}</strong></div>
              <div class="track-grand-total"><span>Total</span><strong>${money(order.total)}</strong></div>
            </div>
            <p class="track-help">Only amounts supplied by the server can be displayed accurately.</p>
          </div>
        </section>

        <section class="track-support-card">
          <div class="track-support-icon">?</div>
          <div>
            <h3>Need help with this order?</h3>
            <p>Keep your order number ready when contacting the store.</p>
          </div>
          <button type="button" class="plain-button" id="trackAgainButton">
            Track another order
          </button>
        </section>
      `;

      $("#trackAgainButton").addEventListener("click", () => {
        $("#trackOrderInput").value = "";
        $("#trackResult").innerHTML = "";
        $("#trackOrderInput").focus();
      });

    } catch (err) {
      result.innerHTML = `
        <div class="track-empty">
          <h3>Could not load order</h3>
          <p>${escapeHtml(err.message || "Please try again.")}</p>
        </div>
      `;
    }
  });
}

function renderSecurityPage() {
  $("#pageContent").innerHTML = `${pageHeader("Security", "Keep your Uni_Shop account secure")}<section class="simple-card"><h2>Sign-in security</h2><div class="inline-notice">Your password is stored as a bcrypt hash and your sign-in session is held in MongoDB. Never share your password or admin credentials.</div><p class="admin-note">Password change and password-reset emails are not enabled in this starter. Configure verified email delivery and a secure, expiring reset-token flow before offering password recovery.</p><button class="primary-button" id="securityLogout">LOG OUT OF THIS SESSION</button></section>`;
  $("#securityLogout").addEventListener("click", logout);
}
function renderComingSoon(page) {
  const pages = {
    wishlist: ["Wishlist", "Your saved products", "Wishlist persistence is not connected to a product catalogue yet."],
    addresses: ["My Addresses", "Manage delivery addresses", "Address book storage can be connected to your checkout data model."],
    payments: ["Payments & Coupons", "Payment methods and discount codes", "Connect your verified payment gateway and coupon validation before accepting payments."],
    notifications: ["Notifications", "Account and order updates", "Notifications will appear here when an order or account event is added."],
    reviews: ["My Reviews", "Your product feedback", "Product reviews need a product catalogue and review moderation model."],
    support: ["Help & Support", "We’re here to help", "Add your support email, WhatsApp, and published help-center URL here."]
  };
  const [title, subtitle, note] = pages[page] || ["Page", "", "This page is not configured yet."];
  $("#pageContent").innerHTML = `${pageHeader(title, subtitle)}<section class="simple-card"><h2>${title}</h2><div class="inline-notice">${note}</div></section>`;
}
async function renderAdminPage() {
  $("#pageContent").innerHTML = `${pageHeader("Admin Panel", "Manage customer accounts and order fulfilment")}<div class="admin-toolbar"><button class="plain-button" id="adminUsersTab">Customer accounts</button><button class="plain-button" id="adminOrdersTab">Orders</button><button class="plain-button" id="adminRefresh">↻ Refresh</button></div><div id="adminContent"><div class="empty-state">Loading admin data…</div></div><p class="admin-note">Admin access is server-enforced. Suspend blocks sign-in and active sessions. Deleting a customer also deletes that customer's orders; use carefully.</p>`;
  $("#adminUsersTab").addEventListener("click", loadAdminUsers);
  $("#adminOrdersTab").addEventListener("click", loadAdminOrders);
  $("#adminRefresh").addEventListener("click", loadAdminUsers);
  loadAdminUsers();
}
async function loadAdminUsers() {
  const mount = $("#adminContent"); mount.innerHTML = `<div class="empty-state">Loading customers…</div>`;
  try {
    const { users } = await api("/api/admin/users");
    mount.innerHTML = `<section class="panel"><div class="panel-head"><div><h2>Registered customers</h2><p>${users.length} recent customer account(s), maximum 500 shown</p></div></div><div class="admin-toolbar" style="padding:14px 16px 0"><input id="adminSearch" placeholder="Search name, email, phone..."></div><div class="table-wrap"><table><thead><tr><th>CUSTOMER</th><th>PHONE</th><th>JOINED</th><th>STATUS</th><th>MANAGE</th></tr></thead><tbody id="usersRows">${users.map(u => `<tr data-user-row="${escapeHtml(`${u.name} ${u.email} ${u.phone || ""}`.toLowerCase())}"><td><strong>${escapeHtml(u.name)}</strong><br><small>${escapeHtml(u.email)}</small></td><td>${escapeHtml(u.phone || "—")}</td><td>${date(u.createdAt)}</td><td><span class="status ${u.status === "active" ? "delivered" : "cancelled"}">${escapeHtml(u.status)}</span></td><td><button class="row-action" data-user-status="${u.id}" data-next-status="${u.status === "active" ? "suspended" : "active"}">${u.status === "active" ? "Suspend" : "Activate"}</button> <button class="danger-button" data-user-delete="${u.id}">Delete</button></td></tr>`).join("")}</tbody></table></div></section>`;
    $("#adminSearch").addEventListener("input", e => $$("[data-user-row]").forEach(row => row.classList.toggle("hidden", !row.dataset.userRow.includes(e.target.value.toLowerCase()))));
    $$("[data-user-status]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm(`Change this account to ${b.dataset.nextStatus}?`)) return;
      try { await api(`/api/admin/users/${b.dataset.userStatus}/status`, { method: "PATCH", body: JSON.stringify({ status: b.dataset.nextStatus }) }); toast("Customer status updated.", "success"); loadAdminUsers(); } catch (e) { toast(e.message, "error"); }
    }));
    $$("[data-user-delete]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Permanently delete this customer and their orders? This cannot be undone.")) return;
      try { await api(`/api/admin/users/${b.dataset.userDelete}`, { method: "DELETE", body: "{}" }); toast("Customer deleted.", "success"); loadAdminUsers(); } catch (e) { toast(e.message, "error"); }
    }));
  } catch (e) { mount.innerHTML = `<div class="inline-notice">${escapeHtml(e.message)}</div>`; }
}async function loadAdminOrders() {
  const mount = $("#adminContent");
  mount.innerHTML = '<div class="empty-state">Loading orders…</div>';

  try {
    const { orders } = await api("/api/admin/orders");

    mount.innerHTML = `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>All orders</h2>
            <p>${orders.length} recent order(s)</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ORDER</th>
                <th>CUSTOMER</th>
                <th>DATE</th>
                <th>TOTAL</th>
                <th>STATUS</th>
                <th>UPDATE</th>
              </tr>
            </thead>
            <tbody>
              ${orders.map(o => {
                const customer = o.customer || {};
                const options = [
                  "pending",
                  "processing",
                  "shipped",
                  "delivered",
                  "cancelled"
                ];

                return `
                  <tr>
                    <td><span class="order-no">#${escapeHtml(o.id)}</span></td>
                    <td>
                      ${escapeHtml(customer.name || "Customer")}<br>
                      <small>${escapeHtml(customer.email || "")}</small>
                    </td>
                    <td>${date(o.created_at)}</td>
                    <td><strong>${money(o.total)}</strong></td>
                    <td>
                      <span class="status ${statusClass(o.status)}">
                        ${escapeHtml(o.status)}
                      </span>
                    </td>
                    <td>
                      <select data-order-status="${escapeHtml(o.id)}">
                        ${options.map(s => `
                          <option value="${s}" ${o.status === s ? "selected" : ""}>
                            ${s}
                          </option>
                        `).join("")}
                      </select>
                    </td>
                  </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </section>`;

    $$("[data-order-status]").forEach(sel => {
      sel.addEventListener("change", async () => {
        try {
          await api(
            `/api/admin/orders/${encodeURIComponent(sel.dataset.orderStatus)}`,
            {
              method: "PATCH",
              body: JSON.stringify({ status: sel.value })
            }
          );
          toast("Order status updated.", "success");
        } catch (e) {
          toast(e.message, "error");
        }
      });
    });
  } catch (e) {
    mount.innerHTML =
      `<div class="inline-notice">${escapeHtml(e.message)}</div>`;
  }
}
$("#globalSearch").addEventListener("keydown", e => { if (e.key === "Enter") { const q = e.target.value.trim(); if (q) { goPage("track"); $("#trackOrderInput").value = q; } } });
$$("[data-year]").forEach(el => el.textContent = new Date().getFullYear());

  (async function init() {
  try {
    const data = await api("/api/customer/me");
    currentUser = { ...data, role: "customer" };
    showApp();
  } catch (_) {
    showAuth();
  }
})();
