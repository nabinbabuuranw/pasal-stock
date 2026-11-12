"""Browser QA for Pasal Stock: real Chromium at 375, 768, 1024 and 1440 px.

Checks per page and width: horizontal overflow, console errors, page errors, failed requests,
axe-core violations (WCAG 2.x A and AA tags), and a screenshot. Run against a local server:
    node tools/local-server.mjs &   (serves on 127.0.0.1:8787)
    python3 qa/browser_qa.py [outdir]
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8787")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "out")
WIDTHS = [375, 768, 1024, 1440]
AXE = open(os.path.join(HERE, "axe.min.js"), encoding="utf-8").read()

PUBLIC = ["/", "/login", "/signup", "/terms", "/privacy", "/no-such-page"]
OWNER = ["/app", "/app/products", "/app/products/new", "/app/movements", "/app/alerts", "/app/suppliers",
         "/app/orders", "/app/orders/new", "/app/settings"]
STAFF = ["/app", "/app/products", "/app/alerts", "/app/movements"]
ADMIN = ["/admin"]

def product_path(page):
    page.goto(BASE + "/app/products")
    link = page.locator("table a").first
    return link.get_attribute("href")

def login(page, email, password):
    page.goto(BASE + "/login")
    page.fill("#email", email)
    page.fill("#password", password)
    page.click("button[type=submit]")
    page.wait_for_load_state("load")

def open_owner(page):
    page.goto(BASE + "/login")
    page.click("text=Open as the demo owner")
    page.wait_for_load_state("load")

def check(page, path, width, label, results, shot_dir, errors):
    url = BASE + path
    response = page.goto(url, wait_until="load")
    status = response.status if response else None
    page.wait_for_timeout(250)
    overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    inline_styles = page.evaluate("() => document.querySelectorAll('[style]').length")
    # axe is evaluated through the browser's own evaluate call, so the page's Content-Security-Policy
    # stays in force for the page's own scripts while the checker runs.
    if not page.evaluate("() => !!window.axe"):
        page.evaluate(AXE)
    axe_result = page.evaluate("""async () => {
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
        return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
    }""")
    shot = os.path.join(shot_dir, f"{label}.png")
    page.screenshot(path=shot, full_page=False)
    row = {"path": path, "label": label, "width": width, "status": status, "horizontal_overflow_px": overflow,
           "inline_style_attributes": inline_styles, "axe_violations": axe_result,
           "axe_count": len(axe_result), "screenshot": os.path.relpath(shot, OUT)}
    results.append(row)
    return row

def run_for_width(p, width, results, errors):
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": width, "height": 900}, reduced_motion="reduce")
    page = context.new_page()
    console_errors = []
    page_errors = []
    failed = []
    page.on("response", lambda r: failed.append({"url": r.url, "status": r.status}) if r.status >= 400 else None)
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    shot_dir = os.path.join(OUT, f"w{width}")
    os.makedirs(shot_dir, exist_ok=True)
    local = []
    for path in PUBLIC:
        check(page, path, width, "public" + path.replace("/", "_").rstrip("_") or "home", local, shot_dir, errors)
    open_owner(page)
    owner_pages = ["/app", "/app/products", "/app/products/new", "/app/movements", "/app/alerts", "/app/suppliers",
                   "/app/orders", "/app/orders/new", "/app/settings"]
    for path in owner_pages:
        check(page, path, width, "owner" + path.replace("/", "_"), local, shot_dir, errors)
    ppath = product_path(page)
    check(page, ppath, width, "owner_product_detail", local, shot_dir, errors)
    orders_link = None
    page.goto(BASE + "/app/orders")
    link = page.locator("table a").first
    if link.count():
        orders_link = link.get_attribute("href")
        check(page, orders_link, width, "owner_order_detail", local, shot_dir, errors)
    context.clear_cookies()
    login_page_staff = browser.new_context(viewport={"width": width, "height": 900}, reduced_motion="reduce").new_page()
    login(login_page_staff, "staff@demo.invalid", "demo-staff-2026")
    for path in STAFF:
        check(login_page_staff, path, width, "staff" + path.replace("/", "_"), local, shot_dir, errors)
    login_page_admin = browser.new_context(viewport={"width": width, "height": 900}, reduced_motion="reduce").new_page()
    login(login_page_admin, "admin@demo.invalid", "demo-admin-2026")
    for path in ADMIN:
        check(login_page_admin, path, width, "admin" + path.replace("/", "_"), local, shot_dir, errors)
    for r in local:
        r["console_errors"] = list(console_errors)
        r["page_errors"] = list(page_errors)
        r["failed_responses"] = list(failed)
    results.extend(local)
    browser.close()

def main():
    os.makedirs(OUT, exist_ok=True)
    results, errors = [], []
    with sync_playwright() as p:
        for w in WIDTHS:
            run_for_width(p, w, results, errors)
    summary = {
        "base": BASE,
        "widths": WIDTHS,
        "pages_checked": len(results),
        "pages_checked_per_width": {str(w): sum(1 for r in results if r["width"] == w) for w in WIDTHS},
        "horizontal_overflow_pages": [r for r in results if r["horizontal_overflow_px"] > 0],
        "console_error_count": sum(len(r.get("console_errors", [])) for r in results),
        "page_error_count": sum(len(r.get("page_errors", [])) for r in results),
        "axe_violation_count": sum(r["axe_count"] for r in results),
        "axe_violations": [dict(width=r["width"], path=r["path"], **v) for r in results for v in r["axe_violations"]],
        "inline_style_attribute_count": sum(r["inline_style_attributes"] for r in results),
        "non_200_pages": [r for r in results if r["status"] not in (200, 404)],
        "rows": results,
    }
    with open(os.path.join(OUT, "qa-results.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(json.dumps({k: v for k, v in summary.items() if k not in ("rows", "axe_violations")}, indent=2))
    print("axe violations:", len(summary["axe_violations"]))

if __name__ == "__main__":
    main()
