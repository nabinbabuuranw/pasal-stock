# AUDIT_30: Pasal Stock anti-AI UI audit (final build)

Run on the final build (npm test 38 of 38; browser pass 84 page loads, 0 axe violations, 0 horizontal overflow). Each point is marked pass, reasoned exception, or fail. No point fails.

| # | Point | Result | Evidence |
|---|---|---|---|
| 1 | Harsh gradients | pass | app.css has no gradient declarations (grep for gradient returns none) |
| 2 | Pure white backgrounds | pass | page paper #F3F5EF; surfaces #FBFCF8; no #FFF page background |
| 3 | Rainbow colouring | pass | one primary family (sage and slate) plus one brick signal |
| 4 | Heavy drop shadows | pass | no box-shadow in app.css |
| 5 | Liquid glass | pass | no backdrop-filter in app.css |
| 6 | Generic purple and black scheme | pass | sage and slate; no purple |
| 7 | Radial orbs | pass | no radial-gradient or decorative circles |
| 8 | Excessive neon | pass | no saturated neon; the strongest colour is brick #9A3A24 |
| 9 | Basic pastel palette | reasoned exception | the palette is muted sage and slate, not a pastel set; chosen from Coolors and checked for WCAG AA |
| 10 | Default icon set | pass | twelve custom line icons in site/static/icons.svg |
| 11 | Emojis as UI icons | pass | none in any template (grep) |
| 12 | Default Inter, Geist or Space Grotesk | pass | Big Shoulders Display, Instrument Sans, Hind |
| 13 | Unnecessary sparkle icons | pass | none |
| 14 | Animated arrows | pass | none |
| 15 | Hover animation on every element | pass | colour transitions on buttons, links and nav only; no transform on hover |
| 16 | Three-feature-card rows | pass | home uses four numbered rows and two plan cards; no three-card row |
| 17 | Coloured left stripes on cards | pass | active nav uses a tint background, not a stripe (changed during the audit) |
| 18 | Repetitive bento grids | pass | none |
| 19 | Terminal mockups | pass | none |
| 20 | Generic three-tier pricing | pass | two plans, no prices, no highlighted middle tier |
| 21 | Soft rounded corners everywhere | pass | radius 4 px; sharp corners on tables and tags |
| 22 | Dot-grid backgrounds | pass | none |
| 23 | Excessive em dashes | pass | none in the Worker or the stylesheet (a test checks this) |
| 24 | "It is not X, it is Y" copy | pass | copy read through; headlines state the job directly |
| 25 | Repetitive checkmark bullets | pass | plan lists use small square markers; no checkmarks |
| 26 | Fake testimonials | pass | none; no statistics; no logos |
| 27 | Missing real product demo | pass | a working app: sign-in, stock movements, purchase orders, reorder list, daily log, admin, all with seeded illustrative data |
| 28 | Missing skeleton loaders | reasoned exception | pages are rendered by the server and do not fetch data in the browser, so there is no loading state to skeleton; empty states, error flashes and success flashes are present |
| 29 | Missing Terms of Service | pass | /terms, linked from every page footer |
| 30 | Missing Privacy Policy | pass | /privacy, linked from every page footer |

## Motion (master prompt section 3, checked)

- Reveal on scroll that reverses when scrolled back out: app.js toggles is-in in both directions.
- Gauge animation on item pages: width grows from zero on the next frame.
- prefers-reduced-motion: all transitions cut and reveals shown at once (CSS and script).
- Not animated: tables, figures, forms.

## Premium quality checks (section 2, honest read)

- Hierarchy: headings in a condensed display face, body in a text face, tabular figures for every number.
- Consistency: one set of tokens (colours, radius, rules) in app.css; every page uses them.
- Accessibility: contrast checked (DESIGN.md table), axe clean at four widths, focus visible, labels on every field.
- Not done: a designer's review, a device test on a low-end Android phone, a screen-reader pass.
