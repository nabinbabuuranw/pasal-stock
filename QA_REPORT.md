# QA_REPORT: Pasal Stock (Day 10)

Date: 2026-11-12. Final code, re-run for this report. Commands and outputs below are copied from real runs on the box.

## 1. Automated tests (npm test)

Command: `npm test` (node --test, one file at a time). Node 22.23.3, node:sqlite (in-memory D1 stand-in).

```
# tests 38
# suites 0
# pass 38
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

By file: tests/api.test.js 23 tests (sign-in, roles, stock, purchase orders, concurrency, plan limits, tenant isolation, signup, throttling, passwords, sessions, Shop-plan interest); tests/security.test.js 8 tests (CSP on every response, no inline style, script or event handler in any page, cookie flags, CSRF, Origin, unauthenticated posts, oversized bodies, no secrets printed); tests/static.test.js 7 tests (files present, D1 binding, stylesheet and client script rules, no em dashes, local server responses).

The 38 test names, in order, are in `qa/npm-test-output.txt`. Selected facts the tests check:
- Twenty parallel stock-outs against five units: exactly five succeed, shelf ends at 0, no negative stock anywhere.
- A purchase order received twice adds its quantities once; a cancelled order cannot be received.
- Free plan refuses the 41st item; a second account, a second shop's items and a second shop's suppliers are refused.
- Counter staff can record stock and receive orders; they get 403 on item setup, suppliers, orders, settings and the admin page.
- Passwords are stored as PBKDF2-SHA256 with 100,000 iterations and a salt; the login throttle locks an email after eight failures for fifteen minutes.

Defects the first runs found, all fixed before the final run:
- Two API tests failed before a fix: the flash message did not render on the new-item and new-order pages (`productNewPage` and `orderNewPage` did not receive the flash). Fixed; both now pass.
- The new-order page returned HTTP 500 (a template referenced a parameter I had removed). Found by the browser pass, fixed, re-run clean.
- Two security test helpers were wrong (the login throttle caught a helper that logged in once per page, and the origin test changed the request URL, not the header). Test harness corrected; the assertions were not weakened.

## 2. Browser pass (real Chromium, Playwright, reduced motion on, CSP enforced)

Command: `python3 qa/browser_qa.py <outdir>` against the local server (127.0.0.1:8787) and then `BASE=https://pasal-stock.sites.tab.bot python3 qa/browser_qa.py <outdir>` against the live site. Widths: 375, 768, 1024, 1440. Pages per width: 21 (public: home, log in, sign up, terms, privacy, a missing page; owner: overview, items, new item, daily log, reorder, suppliers, orders, new order, an item page, an order page, settings; counter staff: overview, items, reorder, daily log; admin: shops and activity). Total page loads: 84 per run.

| Check | Local (final) | Live (final) |
|---|---|---|
| Page loads | 84 | 84 |
| Pages per width | 21 / 21 / 21 / 21 | 21 / 21 / 21 / 21 |
| Horizontal overflow (pages) | 0 | 0 |
| axe-core violations (WCAG 2.0 A/AA, 2.1 AA, 2.2 AA) | 0 | 0 |
| Page errors (uncaught exceptions) | 0 | 0 |
| Non-200 pages (other than the deliberate missing page) | 0 | 0 |
| Console errors | 84, all "404 Not Found" for the deliberate missing page `/no-such-page` (84 loads) | the same 84 |
| Style attributes present after the client script runs | 4 (gauge bars, set through the CSS API by app.js; none in the HTML) | 4 |

Raw summary: `qa/qa-results.json` (local) and `qa/qa-results-live.json` (live), with per-page rows, axe rule names and screenshot paths.

Screenshots: `screenshots/w375`, `screenshots/w768`, `screenshots/w1024`, `screenshots/w1440`; one PNG per page per width (21 each).

Note on the counts: the browser pass checks status, overflow, console and axe for each page load. It does not click through every button and form on a phone. Form flows are covered by the API tests above; the browser pass exercised the sign-in form and the demo button.

## 3. Checked by reading the rendered pages

Four screenshots were looked at by the builder: home at 375 and 1440, the owner overview at 1440, and an item page at 375. Those looks found no layout fault. Faults the measurements found and fixed: the two-column layout forced the overview wider than 375 px (fixed with minmax(0, 1fr) and min-width 0); the call-to-action buttons and the bin card table pushed the home page 9 px wider than 375 px (fixed: the buttons wrap and stack on phones, the bin card scrolls inside itself). Every width was re-measured after each fix; the final numbers are in section 2. A few header-spacing changes were made without a visual check on a phone, and are not claimed as verified.

## 4. What was not tested

- A real low-end Android phone on mobile data.
- A screen-reader walkthrough (NVDA, TalkBack).
- A keyboard-only walkthrough of every form.
- Lighthouse performance and SEO scores.
- Email, SMS or any outbound message (the app sends none).
- Concurrency beyond the in-memory stand-in: production uses D1, which serialises writes per database; the stand-in serialises the same way, but a live D1 run was not done here.
- Backups, data export and account deletion (not built).

## 5. Versions

- Node 22.23.3 (test runner and local server); Python 3 with Playwright 1.64.1 (Chromium 156.0.8078.4 on the box); axe-core 4.14.0 (qa/axe.min.js, MIT).
- Fonts: Fontsource 5.3.0 packages (OFL 1.1).
