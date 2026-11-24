(function () {
  var root = document.getElementById('rp');
  var token = (location.pathname.split('/r/')[1] || '').replace(/\/.*/, '');
  var TZ = 'Africa/Casablanca';
  function hhmm(iso) { return iso ? new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : ''; }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function field(label, name, value, hint) {
    var input = el('input', { type: 'number', min: '0', inputmode: 'numeric', name: name });
    if (value != null) input.value = value;
    return el('label', { class: 'field' }, [el('span', { class: 'field-l', text: label }), input, hint ? el('span', { class: 'field-h', text: hint }) : null]);
  }
  function show(d) {
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'rp-h' }, [
      el('div', { class: 'brand' }, [el('span', { class: 'brand-dot' }), d.company + ' · Cellule 24/7']),
      el('p', { text: d.kind === 'carrier' ? 'Demande de disponibilité : autocars et minibus' : 'Demande de disponibilité : hébergement cette nuit' })
    ]));
    var card = el('div', { class: 'rp-card' });
    card.appendChild(el('h2', { text: d.supplier }));
    var kv = el('div', { class: 'rp-kv' });
    [['Vol', (d.flight || '') + ' ' + (d.route || '')], ['Aéroport', d.airport], d.destination ? ['Destination', d.destination] : null,
      ['Passagers', d.pax + (d.prm ? ' dont ' + d.prm + ' PMR' : '')], ['Réponse avant', hhmm(d.deadline_at)]].forEach(function (r) {
      if (!r) return; kv.appendChild(el('span', { text: r[0] })); kv.appendChild(el('b', { text: r[1] }));
    });
    card.appendChild(kv);
    if (d.closed) {
      card.appendChild(el('div', { class: 'rp-closed', text: d.answer ? 'Merci, votre réponse a bien été prise en compte. Cette demande est maintenant close.' : 'Cette demande est close. Merci.' }));
      root.appendChild(card); return;
    }
    if (d.answer) card.appendChild(el('div', { class: 'rp-ok', text: 'Réponse enregistrée à ' + hhmm(d.answer.answered_at) + '. Vous pouvez la modifier ci-dessous.' }));
    var a = d.answer || {};
    var form = el('form', { class: 'stack' });
    if (d.kind === 'carrier') {
      form.appendChild(el('div', { class: 'rp-grid' }, [field('Autocars ' + (a.coach_seats || d.defaults.coach_seats) + ' places', 'coaches', a.coaches),
        field('Minibus ' + (a.minibus_seats || d.defaults.minibus_seats) + ' places', 'minibuses', a.minibuses)]));
      form.appendChild(el('div', { class: 'rp-grid' }, [field('Véhicules adaptés PMR', 'adapted', a.adapted), field('Au terminal dans (minutes)', 'eta_min', a.eta_min == null ? 60 : a.eta_min)]));
    } else {
      form.appendChild(field('Passagers que vous pouvez héberger', 'pax_capacity', a.pax_capacity));
      form.appendChild(el('div', { class: 'rp-grid' }, [field('Chambres single', 'rooms_single', a.rooms_single), field('Chambres double', 'rooms_double', a.rooms_double)]));
      form.appendChild(field('Chambres accessibles PMR', 'rooms_accessible', a.rooms_accessible));
    }
    var note = el('textarea', { name: 'note', rows: '2', placeholder: 'Remarque (facultatif)' });
    if (a.note) note.value = a.note;
    form.appendChild(note);
    var err = el('p', { class: 'form-err' });
    form.appendChild(err);
    var send = el('button', { class: 'btn primary big', type: 'submit', text: 'Envoyer ma réponse' });
    var none = el('button', { class: 'btn danger-ghost', type: 'button', text: 'Aucune disponibilité' });
    form.appendChild(send); form.appendChild(none);
    function post(body) {
      send.disabled = none.disabled = true; err.textContent = '';
      fetch('/api/public/sol/' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'erreur'); return j; }); })
        .then(load).catch(function (e) { err.textContent = e.message === 'request_closed' ? 'Cette demande est close.' : 'Envoi impossible, réessayez ou appelez la cellule.'; send.disabled = none.disabled = false; });
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = {}; Array.prototype.forEach.call(form.elements, function (x) { if (x.name) body[x.name] = x.value; });
      post(body);
    });
    none.addEventListener('click', function () { post({ decline: true, note: note.value }); });
    card.appendChild(form);
    if (d.desk_phone) card.appendChild(el('p', { class: 'muted small', text: 'Une question ? Cellule 24/7 : ' + d.desk_phone }));
    root.appendChild(card);
  }
  function load() {
    fetch('/api/public/sol/' + token).then(function (r) { if (!r.ok) throw new Error(); return r.json(); }).then(show)
      .catch(function () { root.innerHTML = ''; root.appendChild(el('div', { class: 'rp-card' }, [el('h2', { text: 'Lien invalide ou expiré' }), el('p', { class: 'muted', text: 'Contactez la cellule 24/7 de Bandy\'s Cars.' })])); });
  }
  load();
})();
