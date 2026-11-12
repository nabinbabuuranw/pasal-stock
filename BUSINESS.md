# BUSINESS: Pasal Stock (Day 10, backlog #10)

Status: demo. No real shop, customer, supplier, price or stock is in this build. No payment is taken. Expenses to date: $0. Revenue to date: NPR 0.

## The problem

A kirana or small retail counter runs on memory and a notebook. The owner finds out an item is out when a customer asks for it. Reordering is a phone call made from the shelf, so the same three items go short every month, and the supplier order is written from memory. Staff sell the last packet and nobody writes it down.

## Who pays

- Owners of kirana, grocery, general and household shops in Nepal, first in Inaruwa and Kathmandu. Typically one shop, one or two counter staff, one owner who is also the buyer.
- Secondary: small wholesalers and distributors who receive many small purchase orders from shops.

## What the product does, in the order a shop needs it

1. Records stock in, stock out, and a counted total, with the balance after each line (a bin card).
2. Shows which items are at or below their reorder level, with the quantity to order.
3. Turns a list of low items into a supplier purchase order, sent and received in the app, and adds the received quantities to the shelf once.
4. Keeps a daily log of who moved what, in Nepal time.

## Competitive position (from search results, 2026-11-12; not verified on each vendor's current page)

| Product | What the snippets say | Where Pasal Stock is different |
|---|---|---|
| Karobar (Nepali digital khata, Google Play) | Inventory by category, low-stock alerts, product performance | Pasal Stock is built around the shelf and the purchase order, not the whole khata |
| Khata Tracker | Product tracking, stock levels, low-stock alerts | Pasal Stock is a demo with a purchase order flow and a bin card |
| Vyapar | Stock in and out, purchase orders, low-stock alerts, godowns; a general small-business suite | Pasal Stock does one job and is English and Nepali in the item names |
| Marg ERP | Accounting and inventory editions; search snippets show licence prices in rupees | Pasal Stock is not an accounting or tax product and does not try to be one |

The honest read: the category is crowded. The space this build is trying to hold is narrow: the reorder list and the purchase order, presented as a stock card a shopkeeper can read in ten seconds. Whether a shop wants that more than the suite it already has is not known yet, and nothing in this build proves it.

## Plans (no prices in this demo)

- Free: one shop, up to 40 items, up to two accounts (owner and one counter staff), the daily log, the reorder list and purchase orders.
- Shop: items without a fixed limit, up to ten accounts. Price to be confirmed before any launch. Nothing is charged in this demo. The "Ask about the Shop plan" button records interest only.

No price is stated anywhere in this build, because none has been set or tested with a shop. The master brief asks for monetisation that could reach a target range; that target is a goal for the whole programme, not a forecast for this product, and this document makes no revenue claim.

## Monetisation options (to test, not assumed)

- Subscription per shop, monthly or yearly, once a price is tested with real shops.
- Per-account add-ons for shops with more counter staff.
- A purchase-order service for distributors, priced per order or per supplier, if distributors ask for it.
- Not planned: taking a cut of supplier payments, lending, or selling shop data.

## Costs

- Build: $0 (own computer, free tools, OFL fonts, MIT libraries; no paid API).
- Hosting in this demo: the publishing host's own runtime. No domain was bought.
- Ongoing: none set. A real launch needs a domain, a database plan that may exceed the free tier at scale, and support time. None of these are priced here.

## Risks

1. Trust with shop data. A shop will not enter its stock unless it believes the data is safe. Needed: real data-protection review, backups, export, and a clear account-deletion path. None exists in this demo.
2. Connectivity. Many shops have patchy mobile data. The app is server-rendered and needs a connection; offline entry is not built.
3. Counting discipline. The product only helps if staff record movements. A shop that records one sale in five gets a wrong balance, and the app cannot know that.
4. Supplier adoption. A purchase order is only useful if the supplier reads it. Sending is a status change here; nothing is emailed or messaged.
5. Competition. Established suites already have stock modules and an installed base.

## What would tell us the idea works

Ten real shops using it for four weeks, with at least one reorder placed from the app and the daily log used at close. That is a test, not a target, and it has not been run.

## Next steps (not started)

- Show the demo to three shop owners in Inaruwa and ask what they would stop doing on paper. Nothing is sent to any shop from this build.
- Decide on the first price only after those conversations.
- Decide on hosting only after a plan is chosen.
