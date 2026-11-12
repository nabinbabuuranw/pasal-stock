# DESIGN: Pasal Stock (Day 10)

Pasal Stock is a stock sheet for a kirana or retail counter: what is on the shelf, what is low, what to order, and who moved what. The design follows the job. A shopkeeper glances at a phone between customers, so the screen has to say what is out and what is low before anything else. This document records the research, the palette, the type and the decisions, with the evidence for each.

Status of the workflow, stated plainly:
- Research: done (sources below, read through search snippets on 2026-11-12; competitor claims are from those snippets and are labelled as such).
- 21st.dev: searched once for "inventory stock table with status tags" (4 results, components listed by name). No component code was retrieved or copied; the free daily retrieval allowance was not spent.
- Coolors: done. The palette was read on Nabin's logged-in coolors.co account by a browser worker, which compared it with five other palettes; the contrast figures below were re-measured by me.

## 1. Audience and research

- Who: owners of small kirana, grocery and general stores in Nepal, often with one or two counter staff. Mostly on low-end Android phones, often on mobile data. Nepali and English, often both in one sentence (item names like "chiura" or "mustard oil" are said in Nepali at the counter).
- Current practice: a notebook, a register, or a messaging thread. Stock is counted by eye. Reordering happens when the shelf is empty.
- Competing products in the same market (names from search results, 2026-11-12):
  - Karobar, "Nepali Digital Khata" (Google Play listing): inventory by category, low-stock alerts, product performance. Source: play.google.com listing for com.bytecaretech.merokarobar.
  - Khata Tracker (khatatracker.com/features/inventory-management): product tracking, stock levels, low-stock alerts for small businesses.
  - Vyapar (vyapar.com/inventory-management-software): stock in and out, purchase orders, low-stock alerts, godown transfers. A general small-business suite.
  - Marg ERP (margerp.org/pricing and margcompusoft.com price list): accounting plus inventory, licensed editions. Search snippets show list prices in rupees; these were not verified on the vendor page and are not used in this build.
- What the research says we should copy in principle: the stock card (bin card) format with in, out and balance columns, which warehouse and accounting teams have used for decades (study.com "In and Out Stock and Stock Card"). We use that structure, not any vendor's screens.
- What we deliberately do differently: Pasal Stock is a demo. It has no billing, no tax, no payment, and no claim to be an accounting system. Its one job is the shelf, the reorder list and the purchase order.

## 2. Design direction: "Bin Card"

A warehouse stock sheet: ruled columns, a slate header band on every bin card, sage used for graphics and status, and a brick tag for anything that is low or out. No cards in grids, no shadows, no gradients, no glass, no rounded pills except tab pills in the status filter.

What it is not: the SaaS landing page (feature grid, big gradient hero), the Indian retail app (saturated orange and blue), or a dashboard of coloured tiles.

Why it fits: the owner reads the shelf the way they would read a stock card. A low item is a brick tag with a hole punched in it, and the balance column is the number they already trust.

## 3. Palette (Coolors, read on Nabin's account)

- Source: https://coolors.co/cad2c5-84a98c-52796f-354f52-2f3e46 (read on the logged-in page; picked by the browser worker over five other palettes it compared: Olive Garden Feast, Neutral Harmony Bliss, Ocean Pearl Delight, Earthy Forest Hues, Warm Rustic Palette. Olive was rejected as too close to the Sunkoshi moss-and-clay family already logged).
- Coolors hexes and roles: #2F3E46 ink; #354F52 deep (headers, hover); #52796F primary (action); #84A98C graphics only; #CAD2C5 tint (selected states).
- Derived, not in the palette (the palette has no light neutral, so these were added and are marked as derived): paper #F3F5EF (page), card #FBFCF8 (surfaces, not pure white), sunk #E6EBE2 (sidebar), rule #C3CCBF (lines), muted #4F5C58 (secondary text), brick #9A3A24 (low and out stock), brick tint #F2DED5.
- Contrast (WCAG 2.x, measured by me on 2026-11-12 with the formula, not copied from the worker):

| Pair | Ratio | Use |
|---|---|---|
| ink #2F3E46 on paper #F3F5EF | 10.07 | body text |
| muted #4F5C58 on paper | 6.36 | secondary text |
| muted on card #FBFCF8 | 6.78 | captions in cards |
| deep #354F52 on paper | 7.99 | section numbers, step numbers |
| white on primary #52796F | 4.86 | primary buttons |
| ok text #2F5A4A on tint #CAD2C5 | 5.05 | "In stock" tags |
| brick #9A3A24 on paper | 6.36 | low-stock figures |
| brick on brick tint | 5.39 | low-stock tags |
| primary #52796F on paper | 4.42 | not used for text (fails 4.5) |
| graphic #84A98C on paper | 2.38 | not used for text; graphics only |

The first build used primary and graphic colours for small text. The browser audit caught it (axe colour-contrast, 2 nodes on the home page and 6 on the items page); the text colours were moved to the deep tones and the audit then passed. This is recorded in QA_REPORT.md.

## 4. Typography

- Display: Big Shoulders Display 700 and 800 (SIL Open Font License), condensed, uppercase headings. Chosen because it reads like printed stock labels and stays legible at small sizes on a phone.
- Text: Instrument Sans 400, 500, 600, 700 (SIL OFL). Tabular figures are on for every number.
- Nepali (Devanagari): Hind 400 and 600 (SIL OFL), loaded with a unicode-range so the Latin subset is used for Latin text.
- Fonts are self-hosted in site/static/fonts from the Fontsource packages (npm, OFL). No font is fetched from another domain.
- Sizes: body 16 px, line height 1.55; headings clamp between 2.2 rem and 4.2 rem; the stock figure on an item page is 3.4 rem.

## 5. Motif and icons

- Bin card: a table with a slate header band, the balance column on the right, and a "Reorder now" stamp in brick.
- Low-stock tag: a brick outline circle (a punched hole) before the item name in every alert list.
- Icons: twelve custom 24 px line icons in one SVG sprite (site/static/icons.svg), square caps and mitred joins. No icon font and no default icon set.
- Logo: a square outline with three lines, the shorthand of a stock sheet.

## 6. Structure of each surface

- Home (public): split hero (headline left; a live-looking bin card specimen labelled Illustrative right) → "How the counter works" as four numbered rows that reveal on scroll → two plan cards (Free and Shop) with no prices → footer with Terms, Privacy and the demo notice. No testimonials, no statistics, no logos.
- Owner and counter staff dashboard: a fixed left index of sections on desktop (Overview, Items, Daily log, Reorder, Orders, Suppliers, Settings) and a horizontal strip of the same items on phones. The overview is four figures in a ruled row, then "Reorder now" (tag rows) and "Latest movements" (table).
- Item page: the stock figure and a gauge at the top; a movement form (stock in, stock out, counted total) beside the owner's settings form; the bin card (newest first) at the bottom.
- Orders: a status pill row, a ruled table, and an order page with its lines and dates.
- Admin: a count row, shops table, audit table. Demo only.

## 7. Navigation

Public: a plain sticky bar with three text links. App: a sticky app bar (brand, role label, log out) and the section index described above. The active item has the tint background and ink text; no coloured stripe on the side of a card (the audit's point 17).

## 8. Motion

- Reveal: rows and plan cards fade and rise when they enter the viewport, and reverse when scrolled back out (IntersectionObserver toggles the class in both directions).
- Gauge: the stock bar grows from empty to its level on the first frame.
- Hover and focus: colour transitions of 200 ms on buttons, links and nav items.
- Reduced motion: every transition is cut to 0.01 ms and reveals are shown at once (CSS media query and the script both check prefers-reduced-motion).
- Not animated on purpose: tables, numbers, forms.

## 9. Stack pattern (not the same as earlier days)

Server-rendered HTML. The Worker renders every page; there is no client-side router and no framework. Forms post, check a CSRF token and an Origin, then redirect (POST, redirect, GET), with a one-minute flash cookie for the message. One small script (site/static/app.js, about 40 lines) adds the gauge animation, the confirm prompts and the reveals; the app works without it. One Cloudflare Worker over one D1 database (binding DB). The stock rules live in the database: a CHECK constraint refuses any stock that would go below zero, and a receipt is written in one transaction that cannot be repeated.

## 10. Accessibility

- Every form field has a visible label. Errors are flashed with role=status and the form error with role=alert.
- Focus is a 3 px ink outline. Skip link to main content.
- Scrollable tables are keyboard focusable (tabindex 0), per the axe rule.
- Tables use real th and scope; the stock figure has a text status ("In stock", "Low stock", "Out of stock") as well as colour.
- Minimum 44 px touch targets on buttons and inputs.

## 11. What was checked and what was not

Checked: contrast (above), axe-core 4.14.0 with WCAG 2.0 A and AA, 2.1 AA and 2.2 AA tags at four widths on 21 pages per width (84 page loads, 0 violations), horizontal overflow at four widths, console errors, status codes. See QA_REPORT.md.

Not checked: a real low-end Android device on mobile data; a screen-reader walkthrough; a Nepali-speaking user test; Lighthouse performance scores.

## 12. Sources

- Karobar, Google Play listing: https://play.google.com/store/apps/details?id=com.bytecaretech.merokarobar&hl=en_NZ
- Khata Tracker inventory feature page: https://www.khatatracker.com/features/inventory-management
- Vyapar inventory management: https://vyapar.com/inventory-management-software
- Marg ERP pricing (search snippet, not verified on the page): https://margerp.org/pricing/
- Stock card (in, out, balance columns): https://study.com/academy/lesson/how-to-use-stock-cards-for-sales-purchases.html
- 21st.dev search result list used for orientation only: "Inventory Table" (arihantcodes), "Invoice History Table" (cnippet-dev), "Records Table" (theshanelevine), "Table" (cnippet-dev). No code retrieved.
- Coolors palette: https://coolors.co/cad2c5-84a98c-52796f-354f52-2f3e46
