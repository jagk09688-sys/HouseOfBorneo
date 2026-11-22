const products = window.JC_BORNEO_PRODUCTS;

const grid = document.querySelector("#product-grid");
const statusMessage = document.querySelector(".search-status");
const overlay = document.querySelector(".overlay");
const drawer = document.querySelector(".cart-drawer");
const cartItems = document.querySelector(".cart-items");
const cartEmpty = document.querySelector(".cart-empty");
const drawerFooter = document.querySelector(".drawer-footer");
const toast = document.querySelector(".toast");
const paymentResult = document.querySelector(".payment-result");
const dialog = document.querySelector(".product-dialog");
const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
const storageKey = "jc-borneo-house-cart";

let activeFilter = "all";
let searchTerm = "";
let toastTimer;
let cart = [];
let paymentBusy = false;

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    throw new Error(`The shop returned an empty response (HTTP ${response.status}). Please try again.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The shop returned an invalid response (HTTP ${response.status}). Please try again.`);
  }
}

try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (!Array.isArray(saved) || saved.some((item) => !item || typeof item.id !== "string" || !Number.isInteger(item.quantity) || item.quantity < 1 || !products.some((product) => product.id === item.id))) {
    throw new Error("The saved bag did not match the current product list.");
  }
  cart = saved;
} catch (error) {
  console.error("Could not restore the saved shopping bag; starting with an empty bag.", error);
  localStorage.removeItem(storageKey);
}

function renderProducts() {
  const sortValue = document.querySelector("#sort-products").value;
  const visible = products.filter((product) => {
    const matchesFilter = activeFilter === "all" || product.category === activeFilter;
    const text = `${product.name} ${product.categoryLabel} ${product.shortDescription}`.toLowerCase();
    return matchesFilter && text.includes(searchTerm.toLowerCase());
  });

  if (sortValue === "price-low") visible.sort((a, b) => a.price - b.price);
  if (sortValue === "price-high") visible.sort((a, b) => b.price - a.price);
  if (sortValue === "name") visible.sort((a, b) => a.name.localeCompare(b.name));

  statusMessage.textContent = searchTerm ? `${visible.length} ${visible.length === 1 ? "find" : "finds"} for “${searchTerm}”` : "";
  if (!visible.length) {
    grid.innerHTML = '<p class="no-results">No finds just yet. Try another search.</p>';
    return;
  }
  grid.innerHTML = visible.map((product) => `
    <article class="product-card" data-product-id="${product.id}">
      <div class="product-image-wrap">
        <img src="${product.image}" alt="${product.name}" loading="lazy">
        <span class="product-tag">${product.badge}</span>
        <button class="quick-view" type="button" data-action="details" data-id="${product.id}">Read full description</button>
      </div>
      <div class="product-info">
        <p class="product-category">${product.categoryLabel}</p>
        <div class="product-title-row"><h3 class="product-title">${product.name}</h3><p class="product-price">${product.originalPrice ? `<del>${money.format(product.originalPrice)}</del> ` : ""}${money.format(product.price)}</p></div>
        <p class="product-caption">${product.shortDescription}</p>
        <button class="add-button" type="button" data-action="add" data-id="${product.id}">Add to bag <span aria-hidden="true">+</span></button>
      </div>
    </article>
  `).join("");
}

function saveCart() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(cart));
  } catch (error) {
    console.error("Could not save the shopping bag to this browser.", error);
    showToast("Your bag is available for this visit, but could not be saved.");
  }
}

function updateCart() {
  const count = cart.reduce((total, item) => total + item.quantity, 0);
  document.querySelector(".cart-count").textContent = count;
  document.querySelector(".drawer-count").textContent = `(${count})`;
  cartItems.innerHTML = cart.map((item) => {
    const product = products.find((entry) => entry.id === item.id);
    return `
      <article class="cart-row">
        <img src="${product.image}" alt="">
        <div>
          <h3>${product.name}</h3>
          <p>${money.format(product.price)}</p>
          <div class="quantity-control" aria-label="Quantity for ${product.name}">
            <button type="button" data-action="decrease" data-id="${product.id}" aria-label="Remove one ${product.name}">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-action="increase" data-id="${product.id}" aria-label="Add one ${product.name}">+</button>
          </div>
        </div>
        <span class="cart-row-price">${money.format(product.price * item.quantity)}</span>
      </article>
    `;
  }).join("");
  cartEmpty.classList.toggle("is-visible", cart.length === 0);
  cartItems.hidden = cart.length === 0;
  drawerFooter.hidden = cart.length === 0;
  if (cart.length) {
    const subtotal = cart.reduce((total, item) => {
      const product = products.find((entry) => entry.id === item.id);
      return total + product.price * item.quantity;
    }, 0);
    const shipping = subtotal >= 80 ? 0 : 10;
    drawerFooter.querySelector(".cart-subtotal").textContent = money.format(subtotal);
    drawerFooter.querySelector(".cart-shipping").textContent = shipping ? money.format(shipping) : "Free";
    drawerFooter.querySelector(".cart-total").textContent = money.format(subtotal + shipping);
    const remaining = Math.max(0, 80 - subtotal);
    const shippingNote = remaining
      ? `You're ${money.format(remaining)} away from free shipping.`
      : "Lovely! Your order qualifies for free shipping.";
    drawerFooter.querySelector(".shipping-note").innerHTML = `${shippingNote}<div class="shipping-progress" aria-label="${remaining ? "Progress towards" : "Reached"} free shipping"><span style="width:${Math.min(100, subtotal / 80 * 100)}%"></span></div>`;
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function showPaymentResult(message) {
  paymentResult.querySelector("span").textContent = message;
  paymentResult.hidden = false;
}

function addToCart(id) {
  const product = products.find((entry) => entry.id === id);
  if (!product) return;
  const existing = cart.find((item) => item.id === id);
  if (existing && existing.quantity >= 20) {
    showToast("Online orders are limited to 20 of each item.");
    return;
  }
  if (existing) existing.quantity += 1;
  else cart.push({ id, quantity: 1 });
  saveCart();
  updateCart();
  showToast(`${product.name} added to your bag.`);
}

function openCart() {
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-visible"));
  document.querySelector(".close-drawer").focus();
}

function closeCart() {
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  overlay.classList.remove("is-visible");
  window.setTimeout(() => {
    if (!drawer.classList.contains("is-open")) overlay.hidden = true;
  }, 250);
}

function openProductDetails(id) {
  const product = products.find((entry) => entry.id === id);
  if (!product) return;
  const description = product.description.split("\n\n").map((block, index) => {
    const lines = block.split("\n");
    if (index === 0) return `<p class="dialog-lead">${lines.join("<br>")}</p>`;
    if (lines.length > 1 && /:$/.test(lines[0])) {
      const heading = lines.shift();
      if (lines.every((line) => line.startsWith("•"))) {
        return `<section class="dialog-section"><h3>${heading}</h3><ul>${lines.map((line) => `<li>${line.replace(/^•\s*/, "")}</li>`).join("")}</ul></section>`;
      }
      return `<section class="dialog-section"><h3>${heading}</h3><p>${lines.join("<br>")}</p></section>`;
    }
    return `<p>${lines.join("<br>")}</p>`;
  }).join("");
  document.querySelector(".dialog-content").innerHTML = `
    <img src="${product.image}" alt="${product.name}">
    <div class="dialog-copy">
      <p class="product-category">${product.categoryLabel}</p>
      <h2>${product.name}</h2>
      <p class="dialog-price">${product.originalPrice ? `<del>${money.format(product.originalPrice)}</del> ` : ""}${money.format(product.price)}</p>
      <div class="dialog-description">${description}</div>
      <button class="button button-gold" type="button" data-action="add" data-id="${product.id}">Add to bag <span aria-hidden="true">+</span></button>
    </div>
  `;
  dialog.showModal();
}

grid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "add") addToCart(button.dataset.id);
  if (button.dataset.action === "details") openProductDetails(button.dataset.id);
});

dialog.addEventListener("click", (event) => {
  if (event.target.closest('button[data-action="add"]')) {
    addToCart(event.target.closest('button[data-action="add"]').dataset.id);
    dialog.close();
  }
});

cartItems.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const item = cart.find((entry) => entry.id === button.dataset.id);
  if (!item) return;
  if (button.dataset.action === "increase" && item.quantity < 20) item.quantity += 1;
  else if (button.dataset.action === "increase") showToast("Online orders are limited to 20 of each item.");
  if (button.dataset.action === "decrease") {
    item.quantity -= 1;
    if (item.quantity <= 0) cart = cart.filter((entry) => entry.id !== item.id);
  }
  saveCart();
  updateCart();
});

document.querySelector(".cart-button").addEventListener("click", openCart);
document.querySelector(".close-drawer").addEventListener("click", closeCart);
overlay.addEventListener("click", closeCart);
document.querySelectorAll(".continue-shopping").forEach((button) => button.addEventListener("click", closeCart));
const checkoutButton = document.querySelector(".checkout-button");
const paymentOptions = document.querySelector(".payment-options");
const paymentFeedback = document.querySelector(".payment-feedback");
const paymentButtons = [...document.querySelectorAll(".payment-method")];
const bankTransferPanel = document.querySelector(".bank-transfer");
const bankEmail = document.querySelector("#bank-email");
const bankConfirmButton = document.querySelector(".bank-confirm-button");

async function configurePaymentMethods() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return;
    const result = await readJsonResponse(response);
    const cardButton = document.querySelector('[data-payment="card"]');
    const paypalButton = document.querySelector('[data-payment="paypal"]');
    if (cardButton) cardButton.hidden = !result.paymentModes?.card;
    if (paypalButton) paypalButton.hidden = !result.paymentModes?.paypal;
  } catch (error) {
    console.error("Could not load payment availability:", error);
  }
}

configurePaymentMethods();

checkoutButton.addEventListener("click", () => {
  checkoutButton.hidden = true;
  paymentOptions.hidden = false;
  paymentFeedback.textContent = "";
});
document.querySelector(".payment-back").addEventListener("click", () => {
  paymentOptions.hidden = true;
  checkoutButton.hidden = false;
  paymentFeedback.textContent = "";
});
paymentButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    if (paymentBusy || cart.length === 0) return;
    if (button.dataset.payment === "bank") {
      bankTransferPanel.hidden = false;
      paymentFeedback.textContent = "";
      bankEmail.focus();
      return;
    }
    paymentBusy = true;
    paymentButtons.forEach((paymentButton) => { paymentButton.disabled = true; });
    paymentFeedback.textContent = "Connecting to secure checkout…";
    try {
      const provider = button.dataset.payment;
      const endpoint = provider === "card" ? "/api/checkout/card" : "/api/checkout/paypal";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: cart.map(({ id, quantity }) => ({ id, quantity })) }),
      });
      const result = await readJsonResponse(response);
      if (!response.ok) throw new Error(result.error || "We couldn't start checkout. Please try again.");
      if (typeof result.url !== "string" || !/^https:\/\//.test(result.url)) {
        throw new Error("Secure checkout is unavailable right now. Please contact the shop.");
      }
      window.location.assign(result.url);
    } catch (error) {
      paymentFeedback.textContent = error.message || "We couldn't start checkout. Please try again.";
    } finally {
      paymentBusy = false;
      paymentButtons.forEach((paymentButton) => { paymentButton.disabled = false; });
    }
  });
});
bankConfirmButton.addEventListener("click", async () => {
  if (paymentBusy || cart.length === 0) return;
  const email = bankEmail.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    paymentFeedback.textContent = "Enter a valid email address for your order.";
    bankEmail.focus();
    return;
  }

  paymentBusy = true;
  bankConfirmButton.disabled = true;
  paymentButtons.forEach((button) => { button.disabled = true; });
  paymentFeedback.textContent = "Creating your bank transfer order…";
  try {
    const response = await fetch("/api/checkout/bank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        items: cart.map(({ id, quantity }) => ({ id, quantity })),
      }),
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || "We couldn't create the bank transfer order.");

    bankTransferPanel.innerHTML = `
      <div class="bank-details">
        <strong>Transfer ${money.format(result.totalCents / 100)}</strong><br>
        BSB: <strong>${result.bsb}</strong><br>
        Account: <strong>${result.account}</strong><br>
        Reference: <strong>${result.reference}</strong><br>
        Use the reference exactly, then contact the shop if you need an update.
      </div>
      <button class="button bank-copy-button" type="button">Copy bank details</button>
    `;
    bankTransferPanel.hidden = false;
    paymentFeedback.textContent = "Bank transfer order created. It is pending payment confirmation.";
    bankTransferPanel.querySelector(".bank-copy-button").addEventListener("click", async (event) => {
      const text = `BSB: ${result.bsb}\nAccount: ${result.account}\nAmount: ${money.format(result.totalCents / 100)}\nReference: ${result.reference}`;
      await navigator.clipboard.writeText(text);
      event.currentTarget.textContent = "Copied";
    });
  } catch (error) {
    paymentFeedback.textContent = error.message || "We couldn't create the bank transfer order.";
  } finally {
    paymentBusy = false;
    bankConfirmButton.disabled = false;
    paymentButtons.forEach((button) => { button.disabled = false; });
  }
});
document.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
paymentResult.querySelector("button").addEventListener("click", () => {
  paymentResult.hidden = true;
});
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
document.querySelectorAll(".filter-button").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    document.querySelectorAll(".filter-button").forEach((filterButton) => filterButton.classList.toggle("active", filterButton === button));
    renderProducts();
  });
});
document.querySelector("#sort-products").addEventListener("change", renderProducts);

const header = document.querySelector(".site-header");
const searchButton = document.querySelector(".search-toggle");
let searchInput;
searchButton.addEventListener("click", () => {
  let panel = document.querySelector(".search-panel");
  if (panel) {
    panel.remove();
    searchTerm = "";
    renderProducts();
    searchButton.setAttribute("aria-expanded", "false");
    return;
  }
  panel = document.createElement("div");
  panel.className = "search-panel";
  panel.innerHTML = '<label for="product-search">Find a Borneo favourite</label><input id="product-search" type="search" placeholder="Try “coffee” or “gift”">';
  header.append(panel);
  searchInput = panel.querySelector("input");
  searchInput.addEventListener("input", () => {
    searchTerm = searchInput.value.trim();
    renderProducts();
  });
  searchButton.setAttribute("aria-expanded", "true");
  searchInput.focus();
});

const menuButton = document.querySelector(".menu-toggle");
const mainNav = document.querySelector(".main-nav");
menuButton.addEventListener("click", () => {
  const open = mainNav.classList.toggle("is-open");
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "Close menu" : "Open menu");
});
mainNav.addEventListener("click", (event) => {
  if (event.target.closest("a")) {
    mainNav.classList.remove("is-open");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open menu");
  }
});
document.querySelector("#newsletter-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.querySelector("#newsletter-email");
  if (!email.checkValidity()) {
    email.reportValidity();
    return;
  }
  const message = document.querySelector(".newsletter-message");
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  message.textContent = "Sending your signup…";
  message.classList.remove("is-success");
  try {
    const response = await fetch("/api/newsletter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.value.trim() }),
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || "We couldn't send your signup. Please try again.");
    message.textContent = "Thanks for joining us. Inez has received your signup.";
    message.classList.add("is-success");
    event.currentTarget.reset();
  } catch (error) {
    message.textContent = error.message || "We couldn't send your signup. Please try again.";
  } finally {
    submitButton.disabled = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (drawer.classList.contains("is-open")) closeCart();
    if (document.querySelector(".search-panel")) {
      document.querySelector(".search-panel").remove();
      searchTerm = "";
      renderProducts();
      searchButton.setAttribute("aria-expanded", "false");
    }
  }
});

document.querySelector("#year").textContent = new Date().getFullYear();
renderProducts();
updateCart();

async function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("payment") === "cancelled" || params.get("paypal") === "cancel") {
    window.history.replaceState({}, "", window.location.pathname);
    showPaymentResult("Checkout was cancelled. Your bag is still here.");
    openCart();
    return;
  }

  const cardSessionId = params.get("session_id");
  const isCardReturn = params.get("payment") === "success" && cardSessionId;
  const paypalOrderId = params.get("paypal") === "return" ? params.get("token") : null;
  if (!isCardReturn && !paypalOrderId) return;

  openCart();
  const message = "Checking your payment securely…";
  drawerFooter.hidden = false;
  paymentOptions.hidden = false;
  checkoutButton.hidden = true;
  paymentButtons.forEach((button) => { button.hidden = true; });
  document.querySelector(".payment-back").hidden = true;
  paymentFeedback.textContent = message;

  try {
    const response = isCardReturn
      ? await fetch(`/api/checkout/card/status?session_id=${encodeURIComponent(cardSessionId)}`)
      : await fetch("/api/checkout/paypal/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: paypalOrderId }),
      });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || "We could not confirm the payment. Please contact the shop.");
    if (result.paid) {
      cart = [];
      saveCart();
      updateCart();
      paymentFeedback.textContent = result.emailSent
        ? "Payment received. Your order confirmation has been emailed to you and Inez."
        : "Payment received. Your email confirmation is being retried; please contact the shop if it doesn't arrive.";
      showPaymentResult(result.emailSent
        ? "Payment successful. Your order confirmation has been emailed to you and Inez. Thank you for supporting JC Borneo House."
        : "Payment successful. Email confirmation is being retried; please contact the shop if it doesn't arrive.");
    } else {
      paymentFeedback.textContent = "Payment has not been confirmed. Your bag is unchanged; please try again or contact the shop.";
      showPaymentResult("We could not confirm the payment. Your bag has been kept; please contact the shop before trying again.");
    }
  } catch (error) {
    paymentFeedback.textContent = error.message || "We could not confirm the payment. Please contact the shop.";
    showPaymentResult(paymentFeedback.textContent);
  } finally {
    paymentButtons.forEach((button) => { button.hidden = false; });
    document.querySelector(".payment-back").hidden = false;
    window.history.replaceState({}, "", window.location.pathname);
  }
}

handlePaymentReturn();
