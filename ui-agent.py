import asyncio, sys, os, json, re
from playwright.async_api import async_playwright
BASE, ADMIN, APW = sys.argv[1:4]
SHOTS = os.path.join(os.path.dirname(__file__), 'shots')
FIX = os.path.join(os.path.dirname(__file__), 'fixtures')
os.makedirs(SHOTS, exist_ok=True)
errors = []
def log(*a): print(' ', *a, flush=True)

async def newpage(b, w=1366, h=900, mobile=False):
    c = await b.new_context(viewport={'width': w, 'height': h}, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
    p = await c.new_page()
    p.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    p.on('console', lambda m: errors.append(f'console: {m.text}') if m.type == 'error' and '401' not in m.text and 'tile' not in m.text else None)
    p.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    return c, p

async def login(p, email, pw, lang='fr'):
    await p.goto(BASE + '/')
    await p.evaluate(f"localStorage.setItem('cops_lang','{lang}')"); await p.reload()
    await p.fill('input[type=email]', email); await p.fill('input[type=password]', pw)
    await p.click('button.btn.primary'); await p.wait_for_selector('.shell'); await p.wait_for_timeout(400)

async def api(p, method, path, body=None):
    return await p.evaluate("""async ([m, u, b]) => { const r = await fetch('/api' + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : (m === 'GET' ? undefined : '{}') }); return { status: r.status, data: await r.json().catch(() => null) }; }""", [method, path, body])

async def shot(p, name, full=True):
    await p.wait_for_timeout(500)
    await p.screenshot(path=os.path.join(SHOTS, name), full_page=full)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        c, p = await newpage(b)
        await login(p, ADMIN, APW)
        r = await api(p, 'POST', '/admin/demo')
        if r['data'].get('already_loaded'):
            await api(p, 'DELETE', '/admin/demo'); r = await api(p, 'POST', '/admin/demo')
        DPW = r['data']['password']
        await p.goto(BASE + '/#/settings'); await p.wait_for_selector('.page')
        await shot(p, 'ag_settings.png')
        await c.close()

        # 1. Ryanair opens the event and drops the Word list in the Info tab
        c, p = await newpage(b)
        await login(p, 'occ@demo.local', DPW, 'en')
        r = await api(p, 'POST', '/events', {'type': 'hotel', 'flight_no': 'FR 2563', 'route': 'RAK-BVA', 'reason': 'technical', 'airport_code': 'RAK', 'pax_total': 47, 'pax_hotel': 47})
        eid = r['data']['id']
        await p.goto(f'{BASE}/#/events/{eid}'); await p.wait_for_selector('.ev-head')
        await p.click('nav.tabs button >> text=Information')
        await p.set_input_files('label.upload input[type=file]', os.path.join(FIX, 'liste_ryanair_tableau.docx'))
        await p.wait_for_timeout(1500)
        log('ryanair uploaded the list on event', eid)
        await c.close()

        # 2. Desk reviews the list in the agent tab
        c, p = await newpage(b)
        await login(p, 'cellule@demo.local', DPW)
        await p.goto(f'{BASE}/#/events/{eid}'); await p.wait_for_selector('.ev-head')
        await p.click('nav.tabs button >> text=Agent dispatch')
        await p.wait_for_selector('.ag-review', timeout=8000)
        log('review:', (await p.inner_text('.card.hl .card-h')).replace('\n', ' | '))
        log('state:', await p.inner_text('.ag-head .card-actions'))
        await shot(p, 'ag_1_review.png')
        await p.click('.card.hl button.btn.primary')
        await p.wait_for_selector('.ag-sols', timeout=8000)
        await shot(p, 'ag_2_requests.png')
        desk = (c, p)

        # 3. Coach operator answers in the app (phone)
        c2, q = await newpage(b, 390, 844, mobile=True)
        await login(q, 'dispatch.atlas@demo.local', DPW)
        await q.wait_for_selector('.sol-card', timeout=8000)
        await shot(q, 'ag_3_carrier_request.png', full=False)
        await q.fill('.sol-card input >> nth=1', '2')
        await q.fill('.sol-card input >> nth=3', '25')
        await q.click('.sol-card button.btn.primary')
        await q.wait_for_selector('.sol-sum', timeout=5000)
        log('carrier reply:', await q.inner_text('.sol-sum'))
        await c2.close()

        # 4. Menara answers from the e-mail link (phone, no login)
        ob = (await api(p, 'GET', f'/events/{eid}/agent'))['data']['outbox']
        mail = [o for o in ob if o['kind'] == 'carrier_request' and o['to_email'] == 'dispatch.menara@demo.local'][0]
        html_ = (await api(p, 'GET', f"/outbox/{mail['id']}"))['data']['html']
        token = re.search(r'/r/([a-f0-9]{48})', html_).group(1)
        c3, m = await newpage(b, 390, 844, mobile=True)
        await m.goto(f'{BASE}/r/{token}'); await m.wait_for_selector('form', timeout=8000)
        await shot(m, 'ag_4_public_reply.png')
        await m.fill('input[name=coaches]', '1')
        await m.fill('input[name=eta_min]', '40')
        await m.click('button[type=submit]')
        await m.wait_for_selector('.rp-ok', timeout=5000)
        log('public reply:', await m.inner_text('.rp-ok'))
        await c3.close()

        # 5. Hotel answers in the app
        c4, h = await newpage(b, 390, 844, mobile=True)
        await login(h, 'reception.atlas@demo.local', DPW)
        await h.wait_for_selector('.sol-card', timeout=8000)
        inputs = h.locator('.sol-card input[type=number]')
        await inputs.nth(0).fill('26'); await inputs.nth(1).fill('2'); await inputs.nth(2).fill('6'); await inputs.nth(3).fill('10')
        await h.click('.sol-card button.btn.primary')
        await h.wait_for_selector('.sol-sum', timeout=5000)
        await shot(h, 'ag_5_hotel_reply.png', full=False)
        await c4.close()

        # 6. Desk enters the Agdal answer taken by phone, Gueliz declines
        await p.wait_for_timeout(800)
        row = p.locator('.ag-sols tr', has_text='Agdal')
        await row.locator('button', has_text='Saisir la réponse').click()
        await p.wait_for_selector('.modal')
        await p.fill('.modal input[type=number] >> nth=0', '30')
        await p.fill('.modal input[type=number] >> nth=2', '6')
        await p.fill('.modal input[type=number] >> nth=3', '12')
        await p.click('.modal button.btn.primary')
        await p.wait_for_timeout(600)
        row = p.locator('.ag-sols tr', has_text='Guéliz')
        await row.locator('button', has_text='Saisir la réponse').click()
        await p.wait_for_selector('.modal')
        await p.click('.modal button.danger-ghost')
        await p.wait_for_selector('.ag-plan', timeout=8000)
        await p.wait_for_timeout(800)
        log('plan:', (await p.inner_text('.ag-kpis')).replace('\n', ' '))
        await p.wait_for_timeout(3600)
        await shot(p, 'ag_6_plan.png')
        await p.locator('.ag-plan').screenshot(path=os.path.join(SHOTS, 'ag_6c_plan_card.png'))
        # open the manifest of V1
        await p.click('.ag-veh details summary >> nth=0')
        await shot(p, 'ag_6b_plan_detail.png')

        # 7. One-click validation
        await p.click('.ag-plan button.btn.primary')
        await p.wait_for_selector('.ag-plan.ok', timeout=8000)
        await p.wait_for_timeout(800)
        log('validated:', await p.inner_text('.ag-plan .card-h'))
        await shot(p, 'ag_7_validated.png')
        # outbox preview
        await p.click('.card:has-text("Boîte d\'envoi") tbody tr >> nth=0')
        await p.wait_for_selector('.mail-frame', timeout=5000)
        await shot(p, 'ag_8_mail.png', full=False)
        await p.keyboard.press('Escape')
        # operations tab after validation
        await p.click('nav.tabs button >> text=Opérations')
        await shot(p, 'ag_9_ops.png')
        await p.click('nav.tabs button >> text=Chronologie')
        await shot(p, 'ag_10_timeline.png')
        await p.goto(f'{BASE}/#/events/{eid}/lists'); await p.wait_for_selector('.doc', timeout=8000)
        await shot(p, 'ag_11_lists.png')

        # 8. Operator assigns a driver, the driver sees his list
        c5, q = await newpage(b)
        await login(q, 'dispatch.atlas@demo.local', DPW)
        ms = (await api(q, 'GET', '/my/missions'))['data']
        mine = [x for x in ms if x['event_id'] == eid and x['leg'] == 'outbound']
        drivers = (await api(q, 'GET', '/users'))['data']
        d1 = [u for u in drivers if u['email'] == 'chauffeur1@demo.local'][0]
        await api(q, 'PATCH', f"/missions/{mine[0]['id']}", {'driver_id': d1['id']})
        await q.reload(); await q.wait_for_timeout(800)
        await shot(q, 'ag_12_carrier_home.png')
        await c5.close()
        c6, d = await newpage(b, 390, 844, mobile=True)
        await login(d, 'chauffeur1@demo.local', DPW)
        await d.wait_for_selector('.mission', timeout=8000)
        await d.click('.manifest summary')
        await shot(d, 'ag_13_driver.png')
        await d.locator('.mission:has(.manifest)').screenshot(path=os.path.join(SHOTS, 'ag_13b_driver_card.png'))
        await c6.close()
        await desk[0].close()
        await b.close()
    print('\nERRORS:' if errors else '\nNO BROWSER ERRORS', *errors, sep='\n  ')

asyncio.run(main())
