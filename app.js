import { html, render, useState, useEffect, GET, POST, t, setLang, useLang, startLive, stopLive, useRoute, go, Toasts, useLiveStatus } from './js/lib.js';
import { Icon, Spinner } from './js/components.js';
import { Login, ChangePassword, Account, LangSwitch } from './js/pages/auth.js';
import { Dashboard } from './js/pages/dashboard.js';
import { EventsList, NewEvent } from './js/pages/events.js';
import { EventDetail } from './js/pages/event.js';
import { HotelsPage, CarriersPage, VehiclesPage, UsersPage, AirportsPage, SettingsPage, AuditPage } from './js/pages/admin.js';
import { BillingPage, ReportsPage } from './js/pages/billing.js';
import { DriverHome, CarrierHome, HotelHome, MyHotel } from './js/pages/field.js';
import { EventReport, InvoicePrint, MapPage, PlanLists } from './js/pages/print.js';

const NAV = {
  admin: [['/', 'dashboard', 'nav_dashboard'], ['/events', 'events', 'nav_events'], ['/map', 'map', 'nav_map'], ['/billing', 'billing', 'nav_billing'],
    ['/reports', 'reports', 'nav_reports'], null, ['/hotels', 'hotel', 'nav_hotels'], ['/carriers', 'bus', 'nav_carriers'], ['/users', 'users', 'nav_users'],
    ['/airports', 'plane', 'nav_airports'], ['/settings', 'settings', 'nav_settings'], ['/audit', 'log', 'nav_audit']],
  desk: [['/', 'dashboard', 'nav_dashboard'], ['/events', 'events', 'nav_events'], ['/map', 'map', 'nav_map'], ['/billing', 'billing', 'nav_billing'],
    ['/reports', 'reports', 'nav_reports'], null, ['/hotels', 'hotel', 'nav_hotels'], ['/carriers', 'bus', 'nav_carriers']],
  ryanair: [['/', 'dashboard', 'nav_dashboard'], ['/events', 'events', 'nav_events'], ['/map', 'map', 'nav_map'], ['/billing', 'billing', 'nav_billing'],
    ['/reports', 'reports', 'nav_reports'], ['/hotels', 'hotel', 'nav_network']],
  agent: [['/', 'dashboard', 'nav_dashboard'], ['/events', 'events', 'nav_events'], ['/map', 'map', 'nav_map']],
  carrier: [['/', 'bus', 'nav_missions'], ['/vehicles', 'bus', 'nav_vehicles'], ['/drivers', 'users', 'nav_drivers'], ['/map', 'map', 'nav_map']],
  driver: [['/', 'bus', 'my_missions']],
  hotel: [['/', 'hotel', 'nav_requests'], ['/my-hotel', 'settings', 'nav_my_hotel']]
};

function Page({ me, route }) {
  const [a, b, c] = route.parts;
  const role = me.role;
  if (!a) {
    if (role === 'driver') return html`<${DriverHome} me=${me} />`;
    if (role === 'carrier') return html`<${CarrierHome} me=${me} />`;
    if (role === 'hotel') return html`<${HotelHome} me=${me} />`;
    return html`<${Dashboard} me=${me} />`;
  }
  if (a === 'events' && b === 'new') return html`<${NewEvent} me=${me} />`;
  if (a === 'events' && b && c === 'report') return html`<${EventReport} me=${me} id=${b} key=${b} />`;
  if (a === 'events' && b && c === 'invoice') return html`<${InvoicePrint} me=${me} id=${b} key=${b} />`;
  if (a === 'events' && b && c === 'lists') return html`<${PlanLists} me=${me} id=${b} key=${b} />`;
  if (a === 'events' && b) return html`<${EventDetail} me=${me} id=${b} key=${b} />`;
  if (a === 'events') return html`<${EventsList} me=${me} />`;
  if (a === 'map') return html`<${MapPage} me=${me} />`;
  if (a === 'billing') return html`<${BillingPage} me=${me} />`;
  if (a === 'reports') return html`<${ReportsPage} me=${me} />`;
  if (a === 'hotels') return html`<${HotelsPage} me=${me} />`;
  if (a === 'carriers') return html`<${CarriersPage} me=${me} />`;
  if (a === 'vehicles') return html`<${VehiclesPage} me=${me} />`;
  if (a === 'drivers') return html`<${UsersPage} me=${me} driversOnly=${true} />`;
  if (a === 'users') return html`<${UsersPage} me=${me} />`;
  if (a === 'airports') return html`<${AirportsPage} me=${me} />`;
  if (a === 'settings') return html`<${SettingsPage} me=${me} />`;
  if (a === 'audit') return html`<${AuditPage} me=${me} />`;
  if (a === 'my-hotel') return html`<${MyHotel} me=${me} />`;
  if (a === 'account') return html`<${Account} me=${me} />`;
  return html`<div class="page"><p>404</p></div>`;
}

function Layout({ me, onLogout }) {
  const route = useRoute();
  useLang();
  const live = useLiveStatus();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [route.path]);
  const printView = route.parts[0] === 'events' && ['report', 'invoice', 'lists'].includes(route.parts[2]);
  if (printView) return html`<${Page} me=${me} route=${route} />`;
  const nav = NAV[me.role] || [];
  const active = p => (p === '/' ? route.path === '/' : route.path.startsWith(p));
  const compact = me.role === 'driver';
  return html`<div class="shell ${menu ? 'menu-open' : ''} ${compact ? 'compact' : ''}">
    <aside class="side">
      <div class="brand"><span class="brand-dot"></span>${t('app_name')}</div>
      <div class="side-role">${t('role_' + me.role)}${me.hotel ? ' · ' + me.hotel.name : ''}${me.carrier ? ' · ' + me.carrier.name : ''}</div>
      <nav>${nav.map(n => (n ? html`<a href=${'#' + n[0]} class=${active(n[0]) ? 'on' : ''}><${Icon} name=${n[1]} /> ${t(n[2])}</a>` : html`<hr />`))}</nav>
      <div class="side-foot">
        <a href="#/account" class=${route.path === '/account' ? 'on' : ''}><${Icon} name="person" /> ${me.name}</a>
        <button onClick=${onLogout}><${Icon} name="logout" /> ${t('sign_out')}</button>
      </div>
    </aside>
    <div class="main">
      <header class="top">
        <button class="icon-btn menu-btn" onClick=${() => setMenu(!menu)} aria-label="menu"><${Icon} name="menu" /></button>
        <div class="top-brand"><span class="brand-dot"></span>${t('app_name')}</div>
        <div class="grow"></div>
        <span class="live-pill ${live}" title=${live === 'on' ? t('live') : t('offline')}><i></i><span class="lp-t">${live === 'on' ? t('live') : t('offline')}</span></span>
        <${LangSwitch} me=${me} />
      </header>
      <main><${Page} me=${me} route=${route} /></main>
    </div>
    <div class="scrim" onClick=${() => setMenu(false)}></div>
  </div>`;
}

function App() {
  const [me, setMe] = useState(undefined);
  const load = async () => {
    try { const u = await GET('/me'); if (!localStorage.getItem('cops_lang')) setLang(u.lang); setMe(u); startLive(); }
    catch (_) { setMe(null); stopLive(); }
  };
  useEffect(() => {
    load();
    const f = () => { setMe(null); stopLive(); };
    window.addEventListener('cops-unauthorized', f);
    return () => window.removeEventListener('cops-unauthorized', f);
  }, []);
  const logout = async () => { try { await POST('/auth/logout'); } catch (_) { /* ignore */ } stopLive(); setMe(null); go('/'); };
  let body;
  if (me === undefined) body = html`<${Spinner} />`;
  else if (!me) body = html`<${Login} onLogged=${() => { go('/'); load(); }} />`;
  else if (me.must_change_password) body = html`<${ChangePassword} forced=${true} onDone=${load} />`;
  else body = html`<${Layout} me=${me} onLogout=${logout} />`;
  return html`${body}<${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
