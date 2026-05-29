# -*- coding: utf-8 -*-
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 390, "height": 844})

    print("Navigating to mini-app...")
    page.goto("https://avrora-library-production.up.railway.app/telegram-app")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    page.screenshot(path="tmp-upload/miniapp-tabs.png", full_page=False)

    # Find Dokumenty tab specifically
    doc_tab = page.locator("button", has_text="\u0414\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u044b")
    if doc_tab.count() > 0:
        print("PASS: Dokumenty tab is VISIBLE")
        doc_tab.first.click()
        page.wait_for_timeout(1000)
        page.screenshot(path="tmp-upload/miniapp-docs-tab.png", full_page=False)
        content = page.locator("body").inner_text()
        if "\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044f" in content or "\u0430\u0434\u043c\u0438\u043d\u0438\u0441\u0442\u0440\u0430\u0442\u043e\u0440\u0430" in content:
            print("PASS: Shows access-required message for non-admin user")
        else:
            print("INFO: Content after click (first 300 chars):")
            print(content[:300])
    else:
        print("FAIL: Dokumenty tab NOT found")
        # List all buttons
        buttons = page.locator("button").all()
        print("All button labels:")
        for b in buttons:
            try:
                label = b.inner_text().strip()
                if label:
                    print(f"  - {repr(label)}")
            except:
                pass

    browser.close()
    print("Done.")
