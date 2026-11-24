import asyncio, sys, re
from playwright.async_api import async_playwright
BASE, ADMIN, APW, DPW = sys.argv[1:5]
errors = []
def log(*a): print(' ', *a)

async def newpage(b, w=1366, h=900, geo=False, mobile=False):
    c = await b.new_context(viewport={'width': w, 'height': h}, is_mobile=mobile, has_touch=mobile,
        geolocation={'latitude': 31.61, 'longitude': -8.03} if geo else None, permissions=['geolocation'] if geo else [])
    p = await c.new_page()
    p.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    p.on('console', lambda m: errors.append(f'console: {m.text}') if m.type == 'error' and '401' not in m.text and 'tile' not in m.text else None)
    p.on('dialog', lambda d: asyncio.ensure_future(d.accept('40' if d.type == 'prompt' else None)))
    return c, p

async def login(p, email, pw, lang=None):
    await p.goto(BASE + '/')
    if lang: await p.evaluate(f"localStorage.setItem('cops_lang','{lang}')"); await p.reload()
    await p.fill('input[type=email]', email); await p.fill('input[type=password]', pw)
    await p.click('button.btn.primary'); await p.wait_for_selector('.shell'); await p.wait_for_timeout(500)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        # 0. find the hotel of the demo reception account
        c, p = await newpage(b)
        await login(p, ADMIN, APW, 'fr')
        users = await p.evaluate("fetch('/api/users').then(r=>r.json())")
        HOTEL_ID = str([u for u in users if u['email'] == 'reception.atlas@demo.local'][0]['hotel_id'])
        await c.close()
        # 1. Ryanair creates an event (English UI)
        c, p = await newpage(b)
        await login(p, 'occ@demo.local', DPW, 'en')
        await p.goto(BASE + '/#/events/new'); await p.wait_for_selector('form.card')
        await p.fill('input[placeholder="FR 1234"]', 'FR 4242')
        await p.fill('input[placeholder="STN-FEZ"]', 'RAK-CRL')
        await p.select_option('form select >> nth=1', 'RAK')
        await p.fill('form input[type=number] >> nth=0', '120')
        await p.click('form button.btn.primary')
        await p.wait_for_selector('.ev-head', timeout=8000)
        eid = p.url.split('/')[-1]
        log('ryanair created event', eid, await p.inner_text('.ev-head h1'))
        await c.close()
        # 2. Desk builds the plan
        c, p = await newpage(b)
        await login(p, 'cellule@demo.local', DPW, 'fr')
        await p.goto(f'{BASE}/#/events/{eid}'); await p.wait_for_selector('.ev-head')
        await p.click('text=Ajouter un hôtel'); await p.wait_for_selector('.modal')
        await p.select_option('.modal select', HOTEL_ID)
        await p.click('.modal button.link')
        await p.click('.modal-f .btn.primary'); await p.wait_for_timeout(800)
        log('alloc cards:', await p.locator('.alloc').count())
        await p.click('text=Demander des autocars'); await p.wait_for_selector('.modal')
        copts = await p.eval_on_selector_all('.modal select >> nth=2 >> option', 'os => os.map(o => [o.value, o.textContent])')
        cv = [v for v, txt in copts if 'Atlas Tours' in txt][0]
        await p.select_option('.modal select >> nth=2', cv)
        await p.click('.modal-f .btn.primary'); await p.wait_for_timeout(800)
        log('mission rows:', await p.locator('table.missions tbody tr').count())
        await p.click('text=Confirmer le plan'); await p.wait_for_timeout(800)
        log('phase:', await p.inner_text('.ev-meta .badge >> nth=1'))
        # assign vehicle + driver on first mission
        await p.click('table.missions >> text=Modifier >> nth=0'); await p.wait_for_selector('.modal')
        vopts = await p.eval_on_selector_all('.modal select >> nth=1 >> option', 'os => os.map(o => o.value).filter(Boolean)')
        dopts = await p.eval_on_selector_all('.modal select >> nth=2 >> option', 'os => os.map(o => [o.value, o.textContent])')
        await p.select_option('.modal select >> nth=1', vopts[0])
        dv = [v for v, txt in dopts if 'Mohamed' in txt][0]
        await p.select_option('.modal select >> nth=2', dv)
        await p.click('.modal-f .btn.primary'); await p.wait_for_timeout(800)
        log('first mission driver:', (await p.inner_text('table.missions tbody tr >> nth=0')).replace('\n', ' | ')[:120])
        await c.close()
        # 3. Hotel confirms rooms
        c, p = await newpage(b, 390, 844, mobile=True)
        await login(p, 'reception.atlas@demo.local', DPW, 'fr')
        await p.wait_for_selector('.hotel-req')
        n = await p.locator('text=Confirmer les chambres').count()
        await p.locator('text=Confirmer les chambres').first.click(); await p.wait_for_timeout(900)
        log('hotel confirm buttons before/after:', n, await p.locator('text=Confirmer les chambres').count())
        await c.close()
        # 4. Driver runs the mission with GPS
        c, p = await newpage(b, 390, 844, geo=True, mobile=True)
        await login(p, 'chauffeur1@demo.local', DPW, 'fr')
        await p.wait_for_selector('.mission')
        card = p.locator('.mission', has_text=f'FR 4242').filter(has=p.locator('.btn.primary.big')).first
        for step in range(7):
            btn = card.locator('.btn.primary.big')
            if await btn.count() == 0: break
            label = await btn.inner_text()
            if 'Embarquement' in label or 'Départ' in label:
                for _ in range(3): await card.locator('.pax-in .stepper button >> nth=1').click()
            await btn.click(); await p.wait_for_timeout(700)
            if 'Terminer' in label: log('driver clicked:', label); break
            log('driver clicked:', label, '->', await card.locator('header .badge').inner_text())
        log('gps banner:', (await p.inner_text('.gps')).split('\n')[0])
        await c.close()
        # 5. Desk closes, admin invoices
        c, p = await newpage(b)
        await login(p, ADMIN, APW, 'fr')
        await p.goto(f'{BASE}/#/events/{eid}'); await p.wait_for_selector('.ev-head')
        await p.click('.ev-actions >> text=Clôturer'); await p.wait_for_timeout(900)
        await p.click('.tabs >> text=Facturation'); await p.wait_for_timeout(500)
        await p.click('text=Émettre la facture'); await p.wait_for_timeout(900)
        log('invoice badge:', await p.inner_text('.card-actions .badge'))
        log('invoice total:', await p.inner_text('tr.grand'))
        # users: create one
        await p.goto(BASE + '/#/users'); await p.wait_for_selector('.sec-title')
        await p.click('.sec-title >> text=Ajouter'); await p.wait_for_selector('.modal')
        await p.fill('.modal input >> nth=0', 'Agent Test'); await p.fill('.modal input[type=email]', 'agent.test@demo.local')
        await p.select_option('.modal select >> nth=0', 'agent')
        await p.click('.modal-f .btn.primary'); await p.wait_for_selector('.temp-pw')
        log('temp password shown:', len(await p.inner_text('.temp-pw')) >= 10)
        await p.click('.modal-f .btn.primary')
        # settings change
        await p.goto(BASE + '/#/settings'); await p.wait_for_selector('.sec-title')
        await p.fill('.card >> nth=0 >> input >> nth=3', '2450'); await p.click('.sec-title .btn.primary'); await p.wait_for_timeout(600)
        s = await p.evaluate("fetch('/api/settings').then(r=>r.json())")
        log('coach price after save:', s['prices']['coach_local'])
        await p.fill('.card >> nth=0 >> input >> nth=3', '2400'); await p.click('.sec-title .btn.primary'); await p.wait_for_timeout(600)
        # event report view
        await p.goto(f'{BASE}/#/events/{eid}/report'); await p.wait_for_selector('.doc-h')
        log('report ok')
        await c.close()
        await b.close()
    print('ERRORS:\n' + '\n'.join(errors) if errors else 'NO JS ERRORS')
asyncio.run(main())
