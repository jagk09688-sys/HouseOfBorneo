# JC Borneo House online shop

The storefront uses Stripe-hosted card checkout and PayPal Checkout. Customers enter payment details on the providers' secure pages; the shop server never handles or stores card numbers. Prices, quantities, shipping, provider confirmations, and paid-order email notifications are verified on the server.

## Local setup

Use Node.js 22.13 or newer. From this folder:

1. Copy `.env.example` to `.env`.
2. Keep `PUBLIC_SITE_URL=http://localhost:3000` for local testing.
3. Add Stripe **test** keys and PayPal **sandbox** credentials from their merchant dashboards.
4. Configure a Resend API key and an `EMAIL_FROM` address on a domain verified with Resend. Order notifications and newsletter signups go to `inezanthony@yahoo.com.au`.
5. Run `npm install`, then `npm start`, and open `http://localhost:3000`.

The site displays an explicit checkout error until payment and email credentials are configured. Never put API keys in the browser, source control, or a chat message.

## Configure provider webhooks

Set these webhook URLs after the shop has a public HTTPS address:

- Stripe: `https://YOUR-SHOP-DOMAIN/api/webhooks/stripe`, subscribe to `checkout.session.completed`, and save its signing secret as `STRIPE_WEBHOOK_SECRET`.
- PayPal: `https://YOUR-SHOP-DOMAIN/api/webhooks/paypal`, subscribe to `PAYMENT.CAPTURE.COMPLETED`, and save the webhook ID as `PAYPAL_WEBHOOK_ID`.

The server checks completed payment amounts against the stored order before notifying the shop. Notification emails are sent only after provider confirmation, with idempotency keys to avoid duplicate messages when a webhook is retried.

## Deploy and go live

Deploy this folder to a Node.js host with HTTPS and a **persistent disk**. The shop stores pending and paid orders in SQLite at `data/orders.sqlite` by default; set `DATABASE_PATH` to a file on the persistent disk. Set `PUBLIC_SITE_URL` to the final HTTPS website origin, configure all variables from `.env.example` in the host dashboard, and use `npm start` as the start command.

Test a purchase with Stripe test cards and PayPal sandbox accounts before launch. Only switch `PAYPAL_MODE` to `live` and use Stripe keys beginning `sk_live_` once the accounts, provider webhooks, verified email sender, Australian shipping details, order emails, and fulfillment process are confirmed. Live mode intentionally rejects Stripe test keys and PayPal sandbox credentials.

Shipping is A$10 for Australian orders under A$80 and free for orders of A$80 or more. Stripe checkout restricts delivery addresses to Australia, and PayPal addresses are checked before payment is captured. Product prices and quantities are set in `catalog.js`; browser-submitted prices are never used as payment amounts.
