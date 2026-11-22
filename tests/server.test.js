const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jc-borneo-tests-"));
process.env.DATABASE_PATH = path.join(temporaryDirectory, "orders.sqlite");

const { app, calculateOrder, closeDatabase, normalizeCart, products } = require("../server");
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDatabase();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("catalog prices are normalized on the server and shipping is A$10 under A$80", () => {
  const cart = normalizeCart([{ id: "kopi-o", quantity: 1, price: 0.01, name: "tampered" }]);
  assert.equal(cart[0].name, products.find((product) => product.id === "kopi-o").name);
  assert.equal(cart[0].priceCents, 6500);
  assert.deepEqual(calculateOrder(cart), {
    subtotalCents: 6500,
    shippingCents: 1000,
    totalCents: 7500,
  });
});

test("orders of A$80 or more receive free shipping", () => {
  const cart = normalizeCart([{ id: "kopi-o", quantity: 2 }]);
  assert.deepEqual(calculateOrder(cart), {
    subtotalCents: 13000,
    shippingCents: 0,
    totalCents: 13000,
  });
});

test("invalid products, duplicate products, and excessive quantities are rejected", () => {
  assert.throws(() => normalizeCart([{ id: "unknown", quantity: 1 }]), /invalid quantity/i);
  assert.throws(() => normalizeCart([{ id: "kopi-o", quantity: 1 }, { id: "kopi-o", quantity: 1 }]), /invalid item/i);
  assert.throws(() => normalizeCart([{ id: "kopi-o", quantity: 21 }]), /invalid quantity/i);
});

test("health and storefront assets load without exposing server files", async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    paymentModes: { card: false, paypal: false, bank: true },
  });

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /catalog\.js/);

  const catalog = await fetch(`${baseUrl}/catalog.js`);
  assert.equal(catalog.status, 200);
  assert.match(await catalog.text(), /JC_BORNEO_PRODUCTS/);

  for (const privatePath of ["/server.js", "/package.json", "/.env.example", "/data/orders.sqlite"]) {
    const response = await fetch(`${baseUrl}${privatePath}`);
    assert.equal(response.status, 404, `${privatePath} should not be publicly served`);
  }
});

test("cross-origin checkout requests are rejected", async () => {
  const response = await fetch(`${baseUrl}/api/checkout/card`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://not-the-shop.example",
    },
    body: JSON.stringify({ items: [{ id: "kopi-o", quantity: 1 }] }),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /not accepted/i);
});

test("bank transfer checkout works without external payment or email credentials", async () => {
  const response = await fetch(`${baseUrl}/api/checkout/bank`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    body: JSON.stringify({
      email: "customer@example.com",
      items: [{ id: "kopi-o", quantity: 1 }],
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.bsb, "083004");
  assert.equal(result.account, "472998542");
  assert.equal(result.totalCents, 7500);
  assert.match(result.reference, /^[A-Z0-9]{8}$/);
});

test("missing email setup returns an explicit checkout error", async () => {
  const originalEmailKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.EMAIL_FROM;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  try {
    const response = await fetch(`${baseUrl}/api/checkout/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ id: "kopi-o", quantity: 1 }] }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /email is not configured/i);
  } finally {
    if (originalEmailKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalEmailKey;
    if (originalFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = originalFrom;
  }
});
