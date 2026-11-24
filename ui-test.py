import asyncio, sys, json, re
from playwright.async_api import async_playwright
BASE = sys.argv[1]; ADMIN = sys.argv[2]; APW = sys.argv[3]; DPW = sys.argv[4]
OUT = '/home/claude/care-ops/test/shots/'
errors = []

async def login(page, email, pw):
    await page.goto(BASE + '/')
    await page.wait_for_selector('input[type=email]')
    await page.fill('input[type=email]', email)
    await page.fill('input[type=password]', pw)
    await page.click('button.btn.primary')
    await page.wait_for_selector('.shell', timeout=8000)
    await page.wait_for_timeout(900)

async def shot(page, name, path=None, wait=900, full=True):
    if path is not None:
        await page.goto(BASE + '/#' + path)
    await page.wait_for_timeout(wait)
    await page.screenshot(path=OUT + name + '.png', full_page=full)

async def ctx(browser, w=1440, h=900, mobile=False, geo=False):
    c = await browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1, is_mobile=mobile, has_touch=mobile,
        geolocation={'latitude': 31.615, 'longitude': -8.03} if geo else None, permissions=['geolocation'] if geo else [], locale='fr-FR')
    p = await c.new_page()
    p.on('console', lambda m: errors.append(f'[{w}] console {m.type}: {m.text}') if m.type == 'error' and 'tile.openstreetmap' not in m.text and 'ERR_' not in m.text else None)
    p.on('pageerror', lambda e: errors.append(f'[{w}] pageerror: {e}'))
    return c, p

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        c, p = await ctx(b)
        await login(p, ADMIN, APW)
        await shot(p, '01_admin_dashboard')
        ev = await p.evaluate("fetch('/api/events?scope=all').then(r=>r.json())")
        ids = {e['ref']: e['id'] for e in ev}
        e1 = ids['EV-DEMO-001']; e2 = ids['EV-DEMO-002']; e3 = ids['EV-DEMO-003']
        await shot(p, '02_event_hotel_ops', f'/events/{e1}', 1400)
        await p.click('.tabs button:nth-child(2)'); await shot(p, '03_event_map', None, 1200, False)
        await p.click('.tabs button:nth-child(4)'); await shot(p, '04_event_timeline', None, 600)
        await p.click('.tabs button:nth-child(5)'); await shot(p, '05_event_billing', None, 600)
        await shot(p, '06_event_transfer', f'/events/{e2}', 1400)
        await shot(p, '07_events_list', '/events')
        await shot(p, '08_billing', '/billing')
        await shot(p, '09_reports', '/reports')
        await shot(p, '10_hotels', '/hotels')
        await shot(p, '11_users', '/users')
        await shot(p, '12_settings', '/settings')
        await shot(p, '13_map', '/map', 1400, False)
        await shot(p, '14_report_print', f'/events/{e3}/report')
        await shot(p, '15_invoice_print', f'/events/{e3}/invoice')
        await shot(p, '16_new_event', '/events/new')
        await c.close()
        # Ryanair, English
        c, p = await ctx(b)
        await p.goto(BASE + '/'); await p.evaluate("localStorage.setItem('cops_lang','en')")
        await login(p, 'occ@demo.local', DPW)
        await shot(p, '20_ryanair_dashboard')
        await shot(p, '21_ryanair_event', f'/events/{e1}', 1400)
        await c.close()
        # driver on a phone
        c, p = await ctx(b, 390, 844, True, True)
        await login(p, 'chauffeur3@demo.local', DPW)
        await shot(p, '30_driver_mobile', None, 2500)
        await c.close()
        # hotel on a phone
        c, p = await ctx(b, 390, 844, True)
        await login(p, 'reception.palmeraie@demo.local', DPW)
        await shot(p, '31_hotel_mobile', None, 1500)
        await c.close()
        # carrier
        c, p = await ctx(b)
        await login(p, 'dispatch.atlas@demo.local', DPW)
        await shot(p, '32_carrier', None, 1500)
        await c.close()
        # desk on a phone (event detail)
        c, p = await ctx(b, 390, 844, True)
        await login(p, 'cellule@demo.local', DPW)
        await shot(p, '33_desk_mobile_event', f'/events/{e1}', 1500)
        await c.close()
        await b.close()
    print('\n'.join(errors) or 'NO JS ERRORS')
asyncio.run(main())
