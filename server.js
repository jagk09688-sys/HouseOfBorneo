require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const Stripe = require("stripe");
const products = require("./catalog");

const APP_ROOT = __dirname;
const OWNER_EMAIL = process.env.ORDER_EMAIL_TO || "inezanthony@yahoo.com.au";
const publicSite = new URL(process.env.PUBLIC_SITE_URL || "http://localhost:3000");
if (process.env.NODE_ENV === "production" && publicSite.protocol !== "https:") {
  throw new Error("PUBLIC_SITE_URL must use HTTPS in production.");
}
const PUBLIC_SITE_URL = publicSite.origin;
const PAYPAL_BASE_URL = process.env.PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";
const SHIPPING_THRESHOLD_CENTS = 8000;
const SHIPPING_FEE_CENTS = 1000;
const MAX_QUANTITY = 20;
const emailKeySalt = "jc-borneo-house-email-key-v1";

const databasePath = path.resolve(APP_ROOT, process.env.DATABASE_PATH || "data/orders.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_id TEXT UNIQUE,
    provider_capture_id TEXT,
    status TEXT NOT NULL,
    items_json TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    shipping_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    customer_email TEXT,
    shipping_address_json TEXT,
    notification_sent_at TEXT,
    notification_error TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE TABLE IF NOT EXISTS subscribers (
    email TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    notification_sent_at TEXT,
    notification_error TEXT
  );
`);
const orderColumns = database.prepare("PRAGMA table_info(orders)").all().map((column) => column.name);
if (!orderColumns.includes("shipping_address_json")) {
  database.exec("ALTER TABLE orders ADD COLUMN shipping_address_json TEXT");
}
const subscriberColumns = database.prepare("PRAGMA table_info(subscribers)").all().map((column) => column.name);
if (!subscriberColumns.includes("notification_sent_at")) {
  database.exec("ALTER TABLE subscribers ADD COLUMN notification_sent_at TEXT");
}
if (!subscriberColumns.includes("notification_error")) {
  database.exec("ALTER TABLE subscribers ADD COLUMN notification_error TEXT");
}

const statements = {
  insertOrder: database.prepare(`
    INSERT INTO orders (id, provider, status, items_json, subtotal_cents, shipping_cents, total_cents, created_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
  `),
  getOrder: database.prepare("SELECT * FROM orders WHERE id = ?"),
  getOrderByProviderId: database.prepare("SELECT * FROM orders WHERE provider_id = ?"),
  updateProviderId: database.prepare("UPDATE orders SET provider_id = ? WHERE id = ?"),
  setCustomerEmail: database.prepare("UPDATE orders SET customer_email = ? WHERE id = ?"),
  failOrder: database.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'"),
  markPaid: database.prepare(`
    UPDATE orders
    SET status = 'paid',
        customer_email = COALESCE(?, customer_email),
        shipping_address_json = COALESCE(?, shipping_address_json),
        provider_capture_id = COALESCE(?, provider_capture_id),
        paid_at = COALESCE(paid_at, ?),
        notification_error = NULL
    WHERE id = ?
  `),
  markEmailSent: database.prepare("UPDATE orders SET notification_sent_at = ?, notification_error = NULL WHERE id = ?"),
  markEmailError: database.prepare("UPDATE orders SET notification_error = ? WHERE id = ? AND notification_sent_at IS NULL"),
  addSubscriber: database.prepare("INSERT OR IGNORE INTO subscribers (email, created_at) VALUES (?, ?)"),
  getSubscriber: database.prepare("SELECT * FROM subscribers WHERE email = ?"),
  markSubscriberNotified: database.prepare("UPDATE subscribers SET notification_sent_at = ?, notification_error = NULL WHERE email = ?"),
  markSubscriberError: database.prepare("UPDATE subscribers SET notification_error = ? WHERE email = ? AND notification_sent_at IS NULL"),
};

const app = express();
app.disable("x-powered-by");

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new ServiceError("Card payments are not configured yet. Please contact the shop.", 503);
  }
  if (process.env.NODE_ENV === "production" && !process.env.STRIPE_SECRET_KEY.startsWith("sk_live_")) {
    throw new ServiceError("Card payments are still in test mode. Please contact the shop.", 503);
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function getRequiredEmailConfig() {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    throw new ServiceError("Order email is not configured yet. Please contact the shop.", 503);
  }
  return { apiKey: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };
}

function getPayPalConfig() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    throw new ServiceError("PayPal is not configured yet. Please contact the shop.", 503);
  }
  if (process.env.NODE_ENV === "production" && process.env.PAYPAL_MODE !== "live") {
    throw new ServiceError("PayPal is still in sandbox mode. Please contact the shop.", 503);
  }
  if (process.env.PAYPAL_MODE && !["sandbox", "live"].includes(process.env.PAYPAL_MODE)) {
    throw new ServiceError("PayPal is misconfigured. Please contact the shop.", 503);
  }
  return {
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  };
}

class ServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function normalizeCart(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > products.length) {
    throw new ServiceError("Your bag is empty or could not be read. Please refresh and try again.");
  }

  const seen = new Set();
  return input.map((item) => {
    if (!item || typeof item.id !== "string" || seen.has(item.id)) {
      throw new ServiceError("Your bag contains an invalid item. Please refresh and try again.");
    }
    const product = products.find((entry) => entry.id === item.id);
    if (!product || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) {
      throw new ServiceError("Your bag contains an invalid quantity. Please refresh and try again.");
    }
    seen.add(item.id);
    return { id: product.id, quantity: item.quantity, name: product.name, priceCents: Math.round(product.price * 100) };
  });
}

function calculateOrder(items) {
  const subtotalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const shippingCents = subtotalCents >= SHIPPING_THRESHOLD_CENTS ? 0 : SHIPPING_FEE_CENTS;
  return { subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}

function createOrder(provider, items) {
  const totals = calculateOrder(items);
  const id = crypto.randomUUID();
  statements.insertOrder.run(
    id,
    provider,
    JSON.stringify(items),
    totals.subtotalCents,
    totals.shippingCents,
    totals.totalCents,
    new Date().toISOString(),
  );
  return { ...statements.getOrder.get(id), items };
}

function formatMoney(cents) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatShippingAddress(name, address) {
  if (!address || typeof address !== "object") return null;
  const formatted = {
    name: typeof name === "string" ? name.slice(0, 160) : "",
  };
  const fields = {
    line1: address.line1 || address.address_line_1,
    line2: address.line2 || address.address_line_2,
    city: address.city || address.admin_area_2,
    state: address.state || address.admin_area_1,
    postal_code: address.postal_code,
    country: address.country || address.country_code,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value === "string" && value.trim()) formatted[field] = value.trim().slice(0, 160);
  }
  return formatted.line1 || formatted.city || formatted.postal_code ? formatted : null;
}

async function sendEmail({ to, subject, html, idempotencyKey }) {
  const { apiKey, from } = getRequiredEmailConfig();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.createHmac("sha256", emailKeySalt).update(idempotencyKey).digest("hex"),
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Email delivery failed with HTTP ${response.status}: ${detail.slice(0, 400)}`);
  }
}

function orderEmailHtml(order, customerEmail) {
  const rows = order.items.map((item) => {
    const lineTotal = item.priceCents * item.quantity;
    return `<tr><td style="padding:8px 0">${escapeHtml(item.name)} × ${item.quantity}</td><td style="padding:8px 0;text-align:right">${formatMoney(lineTotal)}</td></tr>`;
  }).join("");
  const shippingAddress = order.shipping_address_json && JSON.parse(order.shipping_address_json);
  const addressLines = shippingAddress
    ? [shippingAddress.name, shippingAddress.line1, shippingAddress.line2, shippingAddress.city, shippingAddress.state, shippingAddress.postal_code, shippingAddress.country]
      .filter(Boolean)
      .map((part) => escapeHtml(part))
      .join("<br>")
    : "Address will be available in the payment provider order details.";
  return `<div style="font-family:Arial,sans-serif;color:#30200f;max-width:620px;margin:auto">
    <h1 style="font-family:Georgia,serif">JC Borneo House</h1>
    <h2>${customerEmail ? "Thanks for your order" : "New paid order"} · ${escapeHtml(order.id.slice(0, 8).toUpperCase())}</h2>
    <p>${customerEmail ? "We have received your paid order and will send an update when it is ready." : "A customer has completed payment."}</p>
    ${customerEmail ? `<p>Customer email: <a href="mailto:${escapeHtml(customerEmail)}">${escapeHtml(customerEmail)}</a></p>` : ""}
    <h3>Delivery address</h3><p>${addressLines}</p>
    <table style="width:100%;border-collapse:collapse">${rows}
      <tr><td style="padding:8px 0;border-top:1px solid #ddd">Shipping</td><td style="padding:8px 0;border-top:1px solid #ddd;text-align:right">${order.shippingCents ? formatMoney(order.shippingCents) : "Free"}</td></tr>
      <tr><td style="padding:10px 0;border-top:1px solid #ddd"><strong>Total paid</strong></td><td style="padding:10px 0;border-top:1px solid #ddd;text-align:right"><strong>${formatMoney(order.totalCents)} AUD</strong></td></tr>
    </table>
    <p>Payment provider: ${escapeHtml(order.provider)}<br>Order reference: ${escapeHtml(order.id)}</p>
  </div>`;
}

async function notifyPaidOrder(orderId) {
  const row = statements.getOrder.get(orderId);
  if (!row || row.status !== "paid") return false;
  if (row.notification_sent_at) return true;

  const order = { ...row, items: JSON.parse(row.items_json) };
  const customerEmail = row.customer_email && row.customer_email.toLowerCase() !== OWNER_EMAIL.toLowerCase()
    ? row.customer_email
    : null;
  try {
    await sendEmail({
      to: OWNER_EMAIL,
      subject: `Paid ${order.provider} order ${order.id.slice(0, 8).toUpperCase()}`,
      html: orderEmailHtml(order, row.customer_email),
      idempotencyKey: `order-${order.id}-owner`,
    });
    if (customerEmail) {
      await sendEmail({
        to: customerEmail,
        subject: "Your JC Borneo House order",
        html: orderEmailHtml(order, customerEmail),
        idempotencyKey: `order-${order.id}-customer`,
      });
    }
    statements.markEmailSent.run(new Date().toISOString(), orderId);
    return true;
  } catch (error) {
    statements.markEmailError.run(error.message.slice(0, 500), orderId);
    console.error(`Order email delivery failed for ${orderId}:`, error.message);
    throw error;
  }
}

function markOrderPaid(order, { amountCents, currency, customerEmail, captureId, shippingAddress }) {
  if (amountCents !== order.total_cents || currency.toLowerCase() !== "aud") {
    throw new ServiceError("The payment amount did not match the order. Please contact the shop.", 400);
  }
  statements.markPaid.run(
    typeof customerEmail === "string" ? customerEmail : null,
    shippingAddress ? JSON.stringify(shippingAddress) : null,
    captureId || null,
    new Date().toISOString(),
    order.id,
  );
}

let paypalToken;
let paypalTokenExpiresAt = 0;
async function getPayPalAccessToken() {
  const config = getPayPalConfig();
  if (paypalToken && Date.now() < paypalTokenExpiresAt - 60_000) return paypalToken;
  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(`PayPal authentication failed with HTTP ${response.status}.`);
  }
  paypalToken = result.access_token;
  paypalTokenExpiresAt = Date.now() + (result.expires_in || 300) * 1000;
  return paypalToken;
}

async function paypalRequest(endpoint, { method = "GET", body, requestId } = {}) {
  const accessToken = await getPayPalAccessToken();
  const response = await fetch(`${PAYPAL_BASE_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(`PayPal returned HTTP ${response.status}: ${JSON.stringify(result).slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function asPaypalMoney(cents) {
  return { currency_code: "AUD", value: (cents / 100).toFixed(2) };
}

function validateOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return next();

  const forwardedProto = req.get("x-forwarded-proto");
  const forwardedHost = req.get("x-forwarded-host");
  const requestProtocol = forwardedProto ? forwardedProto.split(",")[0].trim() : req.protocol;
  const requestHost = forwardedHost ? forwardedHost.split(",")[0].trim() : req.get("host");
  const requestOrigin = requestHost ? `${requestProtocol}://${requestHost}` : "";
  if (origin !== PUBLIC_SITE_URL && origin !== requestOrigin) {
    res.status(403).json({ error: "This checkout request was not accepted." });
    return;
  }
  next();
}

function apiError(res, error) {
  if (error instanceof ServiceError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error("Shop API request failed:", error.message);
  res.status(502).json({ error: "We could not complete that request. Please try again or contact the shop." });
}

async function handleStripePaidSession(session) {
  if (!session || session.mode !== "payment" || session.payment_status !== "paid") return false;
  const orderId = session.metadata && session.metadata.order_id;
  const order = orderId && statements.getOrder.get(orderId);
  if (!order || order.provider !== "stripe" || order.provider_id !== session.id) {
    throw new Error("Paid Stripe checkout did not match a pending shop order.");
  }
  markOrderPaid(order, {
    amountCents: session.amount_total,
    currency: session.currency,
    customerEmail: session.customer_details && session.customer_details.email,
    shippingAddress: formatShippingAddress(
      session.shipping_details && session.shipping_details.name,
      session.shipping_details && session.shipping_details.address,
    ),
  });
  await notifyPaidOrder(orderId);
  return true;
}

app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json", limit: "256kb" }),
  async (req, res) => {
    let event;
    try {
      if (!process.env.STRIPE_WEBHOOK_SECRET) throw new ServiceError("Stripe webhooks are not configured.", 503);
      event = getStripe().webhooks.constructEvent(req.body, req.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
      res.status(error.status || 400).send("Webhook signature verification failed.");
      return;
    }
    if (event.type === "checkout.session.completed") {
      try {
        await handleStripePaidSession(event.data.object);
      } catch (error) {
        console.error(`Stripe webhook processing failed for event ${event.id}:`, error.message);
        res.status(500).json({ error: "Order processing failed. The payment provider will retry this webhook." });
        return;
      }
    }
    res.json({ received: true });
  },
);

app.post("/api/webhooks/paypal", express.json({ limit: "256kb" }), async (req, res) => {
  try {
    if (!process.env.PAYPAL_WEBHOOK_ID) {
      throw new ServiceError("PayPal webhooks are not configured.", 503);
    }
    const verification = await paypalRequest("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: {
        auth_algo: req.get("paypal-auth-algo"),
        cert_url: req.get("paypal-cert-url"),
        transmission_id: req.get("paypal-transmission-id"),
        transmission_sig: req.get("paypal-transmission-sig"),
        transmission_time: req.get("paypal-transmission-time"),
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: req.body,
      },
    });
    if (verification.verification_status !== "SUCCESS") {
      res.status(400).json({ error: "Webhook signature verification failed." });
      return;
    }
    if (req.body.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const capture = req.body.resource;
      const paypalOrderId = capture.supplementary_data
        && capture.supplementary_data.related_ids
        && capture.supplementary_data.related_ids.order_id;
      const order = paypalOrderId && statements.getOrderByProviderId.get(paypalOrderId);
      if (order && order.provider === "paypal") {
        const paypalOrder = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);
        const unit = paypalOrder.purchase_units && paypalOrder.purchase_units[0];
        const capture = unit && unit.payments && unit.payments.captures && unit.payments.captures[0];
        if (!unit || unit.custom_id !== order.id || !capture || capture.id !== req.body.resource.id) {
          throw new Error("PayPal capture did not match the stored order.");
        }
        markOrderPaid(order, {
          amountCents: Math.round(Number(capture.amount.value) * 100),
          currency: capture.amount.currency_code,
          customerEmail: paypalOrder.payer && paypalOrder.payer.email_address,
          captureId: capture.id,
          shippingAddress: formatShippingAddress(
            unit.shipping && unit.shipping.name && unit.shipping.name.full_name,
            unit.shipping && unit.shipping.address,
          ),
        });
        try {
          await notifyPaidOrder(order.id);
        } catch {
          res.status(500).json({ error: "Order email failed. The payment provider will retry this webhook." });
          return;
        }
      }
    }
    res.json({ received: true });
  } catch (error) {
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error("PayPal webhook processing failed:", error.message);
    res.status(500).json({ error: "Webhook processing failed." });
  }
});

app.use(express.json({ limit: "16kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, paymentModes: { card: Boolean(process.env.STRIPE_SECRET_KEY), paypal: Boolean(process.env.PAYPAL_CLIENT_ID), bank: true } });
});

app.post("/api/checkout/bank", validateOrigin, async (req, res) => {
  let order;
  try {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ServiceError("Enter a valid email address for your order.");
    }
    const items = normalizeCart(req.body.items);
    order = createOrder("bank_transfer", items);
    statements.setCustomerEmail.run(email, order.id);
    statements.updateProviderId.run(order.id, order.id);

    const reference = order.id.slice(0, 8).toUpperCase();
    const rows = items.map((item) => `
      <tr><td style="padding:8px 0">${escapeHtml(item.name)} × ${item.quantity}</td><td style="padding:8px 0;text-align:right">${formatMoney(item.priceCents * item.quantity)}</td></tr>
    `).join("");
    const html = `<div style="font-family:Arial,sans-serif;color:#30200f;max-width:620px;margin:auto">
      <h1 style="font-family:Georgia,serif">JC Borneo House</h1>
      <h2>Bank transfer order ${escapeHtml(reference)}</h2>
      <p>Payment is pending confirmation.</p>
      <p><strong>BSB:</strong> 083004<br><strong>Account:</strong> 472998542<br><strong>Reference:</strong> ${escapeHtml(reference)}<br><strong>Total:</strong> ${formatMoney(order.total_cents)} AUD</p>
      <table style="width:100%;border-collapse:collapse">${rows}
        <tr><td style="padding:8px 0;border-top:1px solid #ddd">Shipping</td><td style="padding:8px 0;border-top:1px solid #ddd;text-align:right">${order.shipping_cents ? formatMoney(order.shipping_cents) : "Free"}</td></tr>
        <tr><td style="padding:10px 0;border-top:1px solid #ddd"><strong>Total</strong></td><td style="padding:10px 0;border-top:1px solid #ddd;text-align:right"><strong>${formatMoney(order.total_cents)} AUD</strong></td></tr>
      </table>
      <p>Customer: <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
      <p>Order reference: ${escapeHtml(order.id)}</p>
    </div>`;

    if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
      try {
        await sendEmail({
          to: OWNER_EMAIL,
          subject: `Bank transfer order ${reference}`,
          html,
          idempotencyKey: `bank-order-${order.id}-owner`,
        });
        await sendEmail({
          to: email,
          subject: `Your JC Borneo House bank transfer order ${reference}`,
          html,
          idempotencyKey: `bank-order-${order.id}-customer`,
        });
      } catch (error) {
        statements.markEmailError.run(error.message.slice(0, 500), order.id);
        console.error(`Bank transfer order email delivery failed for ${order.id}:`, error.message);
      }
    }

    res.json({
      orderId: order.id,
      reference,
      bsb: "083004",
      account: "472998542",
      totalCents: order.total_cents,
    });
  } catch (error) {
    if (order) statements.failOrder.run(order.id);
    apiError(res, error);
  }
});

app.post("/api/checkout/card", validateOrigin, async (req, res) => {
  let order;
  try {
    getRequiredEmailConfig();
    const items = normalizeCart(req.body.items);
    order = createOrder("stripe", items);
    const lineItems = items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: "aud",
        unit_amount: item.priceCents,
        product_data: { name: item.name },
      },
    }));
    if (order.shipping_cents) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "aud",
          unit_amount: order.shipping_cents,
          product_data: { name: "Shipping (orders under A$80)" },
        },
      });
    }
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      billing_address_collection: "auto",
      shipping_address_collection: { allowed_countries: ["AU"] },
      phone_number_collection: { enabled: false },
      metadata: { order_id: order.id },
      customer_creation: "always",
      success_url: `${PUBLIC_SITE_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_SITE_URL}/?payment=cancelled`,
    });
    statements.updateProviderId.run(session.id, order.id);
    res.json({ url: session.url });
  } catch (error) {
    if (order) statements.failOrder.run(order.id);
    apiError(res, error);
  }
});

app.post("/api/checkout/paypal", validateOrigin, async (req, res) => {
  let order;
  try {
    getRequiredEmailConfig();
    const items = normalizeCart(req.body.items);
    order = createOrder("paypal", items);
    const totals = order;
    const purchaseUnit = {
      custom_id: order.id,
      invoice_id: order.id,
      description: "JC Borneo House online order",
      amount: {
        currency_code: "AUD",
        value: (totals.total_cents / 100).toFixed(2),
        breakdown: {
          item_total: asPaypalMoney(totals.subtotal_cents),
          shipping: asPaypalMoney(totals.shipping_cents),
        },
      },
      items: items.map((item) => ({
        name: item.name.slice(0, 127),
        sku: item.id,
        quantity: String(item.quantity),
        unit_amount: asPaypalMoney(item.priceCents),
        category: "PHYSICAL_GOODS",
      })),
    };
    const paypalOrder = await paypalRequest("/v2/checkout/orders", {
      method: "POST",
      requestId: order.id,
      body: {
        intent: "CAPTURE",
        purchase_units: [purchaseUnit],
        application_context: {
          brand_name: "JC Borneo House",
          user_action: "PAY_NOW",
          shipping_preference: "GET_FROM_FILE",
          return_url: `${PUBLIC_SITE_URL}/?paypal=return`,
          cancel_url: `${PUBLIC_SITE_URL}/?paypal=cancel`,
        },
      },
    });
    if (paypalOrder.status !== "CREATED" || !paypalOrder.id) {
      throw new Error("PayPal did not create an order.");
    }
    const approveLink = paypalOrder.links && paypalOrder.links.find((link) => ["approve", "payer-action"].includes(link.rel));
    if (!approveLink) throw new Error("PayPal did not return an approval link.");
    statements.updateProviderId.run(paypalOrder.id, order.id);
    res.json({ url: approveLink.href });
  } catch (error) {
    if (order) statements.failOrder.run(order.id);
    apiError(res, error);
  }
});

app.post("/api/checkout/paypal/capture", validateOrigin, async (req, res) => {
  try {
    const paypalOrderId = req.body.orderId;
    if (typeof paypalOrderId !== "string" || !/^[A-Z0-9-]{10,64}$/i.test(paypalOrderId)) {
      throw new ServiceError("The PayPal order could not be verified.");
    }
    let order = statements.getOrderByProviderId.get(paypalOrderId);
    if (!order || order.provider !== "paypal") {
      throw new ServiceError("That PayPal order was not found. Please contact the shop.", 404);
    }
    if (order.status === "paid") {
      res.json({ paid: true, emailSent: Boolean(order.notification_sent_at) });
      return;
    }
    const paypalOrder = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);
    const unit = paypalOrder.purchase_units && paypalOrder.purchase_units[0];
    if (paypalOrder.status !== "APPROVED" || !unit || unit.custom_id !== order.id) {
      throw new ServiceError("PayPal has not approved this order. Please try again.");
    }
    const expectedTotal = (order.total_cents / 100).toFixed(2);
    if (unit.amount.currency_code !== "AUD" || unit.amount.value !== expectedTotal) {
      throw new ServiceError("The payment amount did not match the order. Please contact the shop.");
    }
    if (!unit.shipping || !unit.shipping.address || unit.shipping.address.country_code !== "AU") {
      throw new ServiceError("Please choose an Australian delivery address in PayPal before paying.");
    }
    const captureResponse = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      method: "POST",
      requestId: `${order.id}-capture`,
      body: {},
    });
    const capturedOrder = captureResponse.purchase_units && captureResponse.purchase_units[0];
    const capture = capturedOrder && capturedOrder.payments && capturedOrder.payments.captures
      && capturedOrder.payments.captures[0];
    if (captureResponse.status !== "COMPLETED" || !capture) {
      throw new ServiceError("PayPal has not completed this payment. Please try again.");
    }
    order = statements.getOrder.get(order.id);
    markOrderPaid(order, {
      amountCents: Math.round(Number(capture.amount.value) * 100),
      currency: capture.amount.currency_code,
      customerEmail: captureResponse.payer && captureResponse.payer.email_address,
      captureId: capture.id,
      shippingAddress: formatShippingAddress(
        unit.shipping && unit.shipping.name && unit.shipping.name.full_name,
        unit.shipping && unit.shipping.address,
      ),
    });
    let emailSent = false;
    try {
      emailSent = await notifyPaidOrder(order.id);
    } catch {
      emailSent = false;
    }
    res.json({ paid: true, emailSent });
  } catch (error) {
    apiError(res, error);
  }
});

app.get("/api/checkout/card/status", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (typeof sessionId !== "string" || !sessionId.startsWith("cs_") || sessionId.length > 255) {
      throw new ServiceError("The checkout session could not be verified.");
    }
    const order = statements.getOrderByProviderId.get(sessionId);
    if (!order || order.provider !== "stripe") {
      throw new ServiceError("This order was not found. Please contact the shop.", 404);
    }
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.metadata.order_id !== order.id) {
      throw new ServiceError("The checkout session did not match this order.", 400);
    }
    if (session.payment_status === "paid") {
      markOrderPaid(order, {
        amountCents: session.amount_total,
        currency: session.currency,
        customerEmail: session.customer_details && session.customer_details.email,
        shippingAddress: formatShippingAddress(
          session.shipping_details && session.shipping_details.name,
          session.shipping_details && session.shipping_details.address,
        ),
      });
      let emailSent = false;
      try {
        emailSent = await notifyPaidOrder(order.id);
      } catch {
        emailSent = false;
      }
      res.json({ paid: true, emailSent });
      return;
    }
    res.json({ paid: false, emailSent: false });
  } catch (error) {
    apiError(res, error);
  }
});

app.post("/api/newsletter", validateOrigin, async (req, res) => {
  try {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ServiceError("Enter a valid email address to join the list.");
    }
    getRequiredEmailConfig();
    statements.addSubscriber.run(email, new Date().toISOString());
    const subscriber = statements.getSubscriber.get(email);
    if (!subscriber.notification_sent_at) {
      try {
        await sendEmail({
          to: OWNER_EMAIL,
          subject: "New JC Borneo House newsletter subscriber",
          html: `<p>New newsletter signup: <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>`,
          idempotencyKey: `newsletter-${crypto.createHash("sha256").update(email).digest("hex")}`,
        });
        statements.markSubscriberNotified.run(new Date().toISOString(), email);
      } catch (error) {
        statements.markSubscriberError.run(error.message.slice(0, 500), email);
        console.error("Newsletter notification delivery failed:", error.message);
        throw new ServiceError("We couldn't confirm your signup yet. Please try again shortly.", 502);
      }
    }
    res.json({ subscribed: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.use((req, res, next) => {
  const requestPath = decodeURIComponent(req.path);
  if (
    requestPath === "/server.js"
    || requestPath.startsWith("/data/")
    || requestPath.startsWith("/node_modules/")
    || /^\/(?:package(?:-lock)?\.json|\.env(?:\..*)?|\.git)(?:\/|$)/i.test(requestPath)
  ) {
    res.sendStatus(404);
    return;
  }
  next();
});
app.use(express.static(APP_ROOT, { dotfiles: "deny", index: "index.html" }));

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "The request was not valid JSON." });
    return;
  }
  console.error("Unhandled server error:", error.message);
  res.status(500).json({ error: "Something went wrong. Please contact the shop." });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, "0.0.0.0", () => {
    console.log(`JC Borneo House shop listening on port ${port} (${process.env.NODE_ENV || "development"}).`);
  });
}

module.exports = { app, calculateOrder, normalizeCart, products, closeDatabase: () => database.close() };
