# Pasal Stock

Stock, reorder alerts and supplier purchase orders for a small shop (a kirana or retail counter). Built for a shop owner and one or two counter staff, in English and Nepali item names.

Demo only. Every shop, person, supplier and item in the demo is made up or illustrative. No payment is taken, no real stock is held, and nothing is sent to a supplier.

Live demo: https://pasal-stock.sites.tab.bot/

## Demo accounts

The login page lists three demo accounts: the owner, a counter staff member and a platform admin, each with its password. They exist only in the demo database. "Open as the demo owner" signs in without typing a password.

## What it does

- Items with category, unit, item code, Nepali name, usual supplier, reorder level and usual order quantity.
- Stock in, stock out and a counted total. Every change is a line in the bin card with the balance after it. A sale that would take the shelf below zero is refused.
- Reorder list: items at or below their reorder level, with the quantity to order.
- Purchase orders: draft, sent, received, cancelled. Receiving an order adds its quantities to the shelf once, in one transaction.
- Daily log in Nepal time (UTC+05:45).
- Suppliers, settings, counter accounts (owner only), and a platform admin page.
- Free plan: one shop, up to 40 items, two accounts. Shop plan: price to be confirmed, no payment taken, interest recorded only.

## Stack

- One Cloudflare Worker (`site/_worker.js`) with a D1 database bound as `DB`. Every page is rendered on the server; forms post, check a CSRF token and an Origin, and redirect.
- Stock rules are enforced in the database: a CHECK constraint keeps stock at zero or above, and receiving an order is guarded by a token so it cannot be applied twice.
- One small script (`site/static/app.js`) adds the gauge animation, confirm prompts and scroll reveals. The app works without it.
- Fonts (OFL): Big Shoulders Display, Instrument Sans, Hind (Latin and Devanagari). Self-hosted in `site/static/fonts`.
- Security: PBKDF2-SHA256 password hashes (100,000 iterations), HttpOnly, Secure, SameSite=Lax session cookie, CSRF token and Origin check on every form, login throttling, strict Content-Security-Policy with no inline scripts or styles.

## Run the tests

    npm test

38 tests on an in-memory D1 stand-in built on `node:sqlite` (Node 22.13 or newer).

## Run it locally

    node tools/local-server.mjs

Then open http://127.0.0.1:8787/ . The local server is for development and QA only.

## Browser QA

    pip install playwright && playwright install chromium
    python3 qa/browser_qa.py out/

Checks 21 pages at 375, 768, 1024 and 1440 px for horizontal overflow, console and page errors, status codes, and axe-core accessibility rules (needs `qa/axe.min.js`, included).

## Documents

- DESIGN.md: research, palette and contrast, type, motif, structure, motion.
- BUSINESS.md: the problem, the market, plans, costs, risks. No prices, no revenue claims.
- AUDIT_30.md: the 30-point anti-AI UI audit, each point with evidence.
- QA_REPORT.md: test and browser results, defects found and fixed, what was not tested.

## Not built

Real payments, real shops, email or SMS, offline entry, backups and data export, account deletion, tax or invoicing, multi-shop reporting.

## Licence

MIT. See LICENSE.
