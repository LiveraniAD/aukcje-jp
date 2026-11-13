/* Aukcje JP – logika strony. Dane: window.RATE, window.META, window.CARS (+ data/detail/ID.js na żądanie). */
(function () {
  'use strict';
  var RATE = window.RATE || { mid: 0, date: '' };
  var META = window.META || { costs: {}, valuation: {}, gems: {}, counts: {} };
  var CARS = window.CARS || [];
  var app = document.getElementById('app');

  // ---------- pamięć przeglądarki ----------
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  // ---------- ustawienia kosztów ----------
  var C = META.costs || {};
  var DEF = {
    transport: num(C.transportPln, 12000),
    safety: num((META.valuation || {}).safetyDiscountPct, 15),
    margin: num((META.valuation || {}).targetMarginPct, 15),
    multiplier: num(META.defaultBidMultiplier, 1.25)
  };
  var FIX = { duty: num(C.dutyPct, 10) / 100, exS: num(C.exciseSmallPct, 3.1) / 100, exL: num(C.exciseLargePct, 18.6) / 100, thr: num(C.exciseThresholdCc, 2000), vat: num(C.vatPct, 23) / 100 };
  var S = Object.assign({}, DEF, store.get('settings', {}));
  var GEM = { minProfit: num((META.gems || {}).minProfitPct, 30), minN: num((META.gems || {}).minComparables, 8) };

  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }

  // ---------- formatowanie ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sp(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function pln(n) { return n == null || !isFinite(n) ? '—' : sp(n) + ' zł'; }
  function jpy(n) { return n == null || !isFinite(n) ? '—' : '¥ ' + sp(n); }
  function pct(p) { return p == null || !isFinite(p) ? '—' : (p > 0 ? '+' : '') + Math.round(p) + '%'; }
  function pctCls(p) { return p == null ? '' : p >= 30 ? 'good' : p >= 15 ? 'ok' : p >= 0 ? 'warn' : 'bad'; }
  function dmy(iso) { if (!iso) return ''; var p = iso.split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }
  var DAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
  function dayName(iso) { var d = new Date(iso + 'T12:00:00'); return isNaN(d) ? '' : DAYS[d.getDay()]; }
  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function when(iso) { var t = todayIso(); if (iso === t) return 'dziś'; var d = new Date(t + 'T12:00:00'); d.setDate(d.getDate() + 1); var tm = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); return iso === tm ? 'jutro' : dayName(iso); }

  // ---------- obliczenia ----------
  function exciseRate(cc) { return cc > 0 && cc <= FIX.thr ? FIX.exS : FIX.exL; }
  // Koszt auta w Polsce: (cena + transport) -> cło -> akcyza -> VAT (każda opłata liczona od sumy poprzednich).
  function costs(bidPln, cc, transport) {
    var t = transport == null ? S.transport : transport;
    var cif = bidPln + t;
    var duty = cif * FIX.duty;
    var ex = (cif + duty) * exciseRate(cc);
    var vat = (cif + duty + ex) * FIX.vat;
    return { bid: bidPln, transport: t, duty: duty, excise: ex, exciseRate: exciseRate(cc), vat: vat, total: cif + duty + ex + vat };
  }
  // Najwyższa cena licytacji (w zł), przy której po sprzedaży za `sale` zostaje `marginPct` zysku.
  function maxBidPln(sale, cc, marginPct, transport) {
    var t = transport == null ? S.transport : transport;
    var k = (1 + FIX.duty) * (1 + exciseRate(cc)) * (1 + FIX.vat);
    return sale / (1 + marginPct / 100) / k - t;
  }
  function analyse(c) {
    var r = { startPln: c.start * RATE.mid, ratio: null, learned: false };
    if (c.estBasis && c.estBasis !== 'default' && c.est > 0) { r.ratio = c.est / c.start; r.learned = true; } else { r.ratio = S.multiplier; }
    r.estJpy = Math.round(c.start * r.ratio / 1000) * 1000;
    r.estPln = r.estJpy * RATE.mid;
    if (c.med) {
      r.safe = c.med * (1 - S.safety / 100);
      r.costStart = costs(r.startPln, c.cc);
      r.costEst = costs(r.estPln, c.cc);
      r.profitStart = (r.safe - r.costStart.total) / r.costStart.total * 100;
      r.profitEst = (r.safe - r.costEst.total) / r.costEst.total * 100;
      r.maxPln = maxBidPln(r.safe, c.cc, S.margin);
      r.maxJpy = r.maxPln > 0 ? Math.floor(r.maxPln / RATE.mid / 10000) * 10000 : 0;
      var be = maxBidPln(r.safe, c.cc, 0);
      // Cena wywoławcza dużo niższa niż realna wartość auta = cena "symboliczna", licytacja i tak pójdzie wysoko.
      r.symbolic = !r.learned && be > 0 && r.startPln < 0.3 * be;
      r.gem = !r.symbolic && r.profitEst >= GEM.minProfit && c.n >= GEM.minN && c.conf !== 'low' && !damaged(c);
    }
    return r;
  }
  function scoreNum(s) { if (s === 'S') return 6; var v = parseFloat(s); return isFinite(v) ? v : 0; }
  function damaged(c) { return /^R|^A$|\*/.test(c.score || ''); }

  // ---------- tłumaczenia ----------
  var TR = {
    color: { white: 'biały', black: 'czarny', silver: 'srebrny', gray: 'szary', grey: 'szary', red: 'czerwony', blue: 'niebieski', green: 'zielony', yellow: 'żółty', pearl: 'perłowy', wine: 'bordowy', brown: 'brązowy', gold: 'złoty', orange: 'pomarańczowy', beige: 'beżowy', pink: 'różowy', purple: 'fioletowy', navy: 'granatowy', champagne: 'szampański', gunmetal: 'grafitowy', metallic: 'metalik', dark: 'ciemny', light: 'jasny', other: 'inny', others: 'inny', two: 'dwu', tone: 'kolorowy', cream: 'kremowy', ivory: 'kość słoniowa', bronze: 'brązowy metalik', lightblue: 'jasnoniebieski', darkblue: 'granatowy' },
    body: { 'SUV': 'SUV', 'COUPE': 'coupé', 'SEDAN': 'sedan', 'STATION WAGON': 'kombi', 'STATIONWAGON': 'kombi', 'WAGON': 'kombi', 'CONVERTIBLE': 'kabriolet', 'OPEN': 'kabriolet', 'HATCHBACK': 'hatchback', 'MINIVAN': 'minivan', 'ONE BOX': 'van', 'VAN': 'van', 'PICKUP': 'pick-up', 'TRUCK': 'pick-up', 'HARDTOP': 'hardtop', 'OTHERS': 'inne' },
    equip: { 'Aluminum wheels': 'felgi aluminiowe', 'Leather seat': 'skórzana tapicerka', 'Navigation system': 'nawigacja', 'Power steering': 'wspomaganie kierownicy', 'Power window': 'elektryczne szyby', 'Sunroof': 'szyberdach' },
    steering: { 'Left side': 'po lewej stronie (jak w Polsce)', 'Right side': 'po prawej stronie' },
    ac: { 'AAC': 'automatyczna', 'AC': 'manualna', 'WAC': 'automatyczna dwustrefowa', 'W-AAC': 'automatyczna dwustrefowa' },
    inspection: { 'Remain': 'ważny', 'Not': 'brak ważnego przeglądu' },
    suffix: { '2D': '2-drzwiowy', '3D': '3-drzwiowy', '4D': '4-drzwiowy', '5D': '5-drzwiowy', 'CP': 'coupé', 'OP': 'kabriolet', '4WD': 'napęd 4×4', '2WD': 'napęd na jedną oś', 'WG': 'kombi', 'STATIONWAGON': 'kombi', 'WAGON': 'kombi', 'CROSSOVER': 'crossover' }
  };
  function trColor(s) { if (!s) return ''; return s.toLowerCase().split(/[\s\/-]+/).map(function (w) { return TR.color[w] || w; }).join(' '); }
  function trTrans(t) {
    t = (t || '').toUpperCase();
    var m;
    if (!t) return '';
    if (t === 'AT' || t === 'FAT') return 'automatyczna';
    if (t === 'FA') return 'automatyczna (lewarek w podłodze)';
    if (t === 'CA') return 'automatyczna (lewarek przy kierownicy)';
    if (t === 'IA' || t === 'DA') return 'automatyczna (lewarek na desce)';
    if (t === 'MT') return 'manualna';
    if (t === 'SQ' || t === 'SAT') return 'sekwencyjna / półautomat';
    if (t === 'CVT') return 'bezstopniowa (CVT)';
    if ((m = /^F(\d)$/.exec(t))) return 'manualna ' + m[1] + '-biegowa';
    if ((m = /^C(\d)$/.exec(t))) return 'manualna ' + m[1] + '-biegowa (lewarek przy kierownicy)';
    return t;
  }
  function trScore(s) {
    var m = { 'S': 'jak nowy (do 12 miesięcy)', '6': 'jak nowy', '5': 'idealny, znikome ślady użytkowania', '4.5': 'bardzo dobry, drobne ślady', '4': 'dobry, drobne rysy lub wgniotki', '3.5': 'przeciętny, widoczne rysy/wgniotki', '3': 'słabszy, wyraźne uszkodzenia lakieru', '2': 'zły stan', '1': 'bardzo zły stan / po zalaniu', 'R': 'po naprawie powypadkowej', 'RA': 'po drobnej naprawie powypadkowej', 'A': 'po wypadku, nienaprawiony' };
    if (m[s]) return m[s];
    if (/\*/.test(s || '')) return 'bez oceny – zwykle auto uszkodzone lub niesprawne';
    return '';
  }
  function modelNote(model) { return (model || '').split(/\s+/).map(function (w) { return TR.suffix[w]; }).filter(Boolean).join(', '); }
  var LEGEND = [['A1', 'ledwo widoczna rysa'], ['A2', 'widoczna rysa'], ['A3', 'duża rysa'], ['U1', 'małe wgniecenie'], ['U2', 'wgniecenie wielkości kciuka'], ['U3', 'wgniecenie wielkości dłoni'], ['B1', 'małe wgniecenie z rysą'], ['B2', 'średnie wgniecenie z rysą'], ['B3', 'duże wgniecenie z rysą'], ['E1', 'drobne wgniotki'], ['E2', 'kilka wgniotek'], ['E3', 'dużo wgniotek'], ['W1', 'naprawa lakieru – ledwo widoczna'], ['W2', 'naprawa lakieru – widoczna'], ['W3', 'naprawa elementu – wyraźne ślady'], ['S1', 'lekka rdza'], ['S2', 'widoczna rdza'], ['C1', 'oznaki korozji'], ['C2', 'znaczna korozja'], ['P', 'ślady / odpryski na lakierze'], ['H', 'wyblakły lakier'], ['X', 'element do wymiany'], ['XX', 'element wymieniony'], ['Y1', 'małe pęknięcie lub dziura'], ['Y2', 'pęknięcie lub dziura'], ['Y3', 'duże pęknięcie lub dziura'], ['G', 'odprysk na szybie'], ['X1', 'małe pęknięcie szyby'], ['R', 'naprawione pęknięcie szyby'], ['RX', 'naprawione pęknięcie szyby – do wymiany']];

  // ---------- obrazki ----------
  var NOIMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#0b0d10"/><text x="200" y="155" fill="#4b5563" font-family="sans-serif" font-size="18" text-anchor="middle">brak zdjęcia</text></svg>');
  window.__imgFail = function (img) {
    var alt = img.getAttribute('data-alt');
    if (alt) { img.removeAttribute('data-alt'); img.src = alt; } else { img.onerror = null; img.src = NOIMG; }
  };
  function imgTag(src, alt2, cls) { return '<img loading="lazy" referrerpolicy="no-referrer" src="' + esc(src || NOIMG) + '"' + (alt2 ? ' data-alt="' + esc(alt2) + '"' : '') + (cls ? ' class="' + cls + '"' : '') + ' onerror="__imgFail(this)" alt="">'; }

  // ---------- nagłówek / stopka ----------
  function renderChrome(active) {
    var el = document.getElementById('rate');
    el.innerHTML = RATE.mid ? '1&nbsp;000&nbsp;000&nbsp;¥ = <b>' + pln(RATE.mid * 1e6) + '</b> <span class="muted">· kurs NBP z ' + dmy(RATE.date) + '</span>' : 'brak kursu';
    Array.prototype.forEach.call(document.querySelectorAll('nav a'), function (a) { a.classList.toggle('on', a.getAttribute('data-nav') === active); });
    var up = META.updated ? new Date(META.updated) : null;
    var cn = META.counts || {};
    document.getElementById('foot').innerHTML =
      'Dane aukcji: RajAuto (' + (cn.rajauto || 0) + ') i Fabryka Klasyków (' + (cn.fabryka || 0) + '), po scaleniu duplikatów ' + (cn.unique || 0) + ' unikalnych aukcji, ' + (cn.shown || 0) + ' z ceną wywoławczą. ' +
      'Ceny w Polsce: Otomoto i Autoplac. ' + (up ? 'Ostatnia aktualizacja: ' + up.toLocaleString('pl-PL') + '. ' : '') +
      'Wyliczenia są szacunkowe – przed licytacją sprawdź auto i ceny samodzielnie.' +
      ((META.blocked || []).length ? '<br><b class="c-warn">Uwaga:</b> w ostatnim odświeżeniu nie udało się pobrać danych z: ' + esc(META.blocked.join(', ')) + '.' : '');
  }

  // ====================== LISTA ======================
  var F0 = { brand: '', pmin: '', pmax: '', score: '', ymin: '', ymax: '', kmax: '', date: '', sort: 'profit', onlyVal: false, onlyGem: false, onlyFav: false, hideDmg: true };
  var F = Object.assign({}, F0, store.get('filters', {}));
  var shown = 60;
  var listScroll = 0;

  function favs() { return store.get('favs', {}); }
  function notes() { return store.get('notes', {}); }

  function filtered() {
    var fv = favs(), nt = notes();
    var out = [];
    for (var i = 0; i < CARS.length; i++) {
      var c = CARS[i];
      if (F.brand && c.brand !== F.brand) continue;
      var a = c._a || (c._a = analyse(c));
      if (F.pmin !== '' && a.startPln < +F.pmin) continue;
      if (F.pmax !== '' && a.startPln > +F.pmax) continue;
      if (F.score && scoreNum(c.score) < +F.score) continue;
      if (F.hideDmg && damaged(c)) continue;
      if (F.ymin !== '' && c.year < +F.ymin) continue;
      if (F.ymax !== '' && c.year > +F.ymax) continue;
      if (F.kmax !== '' && c.km > +F.kmax) continue;
      if (F.date && c.date !== F.date) continue;
      if (F.onlyVal && !c.med) continue;
      if (F.onlyGem && !a.gem) continue;
      if (F.onlyFav && !fv[c.id] && !nt[c.id]) continue;
      out.push(c);
    }
    var by = {
      profit: function (x, y) { return rank(y) - rank(x); },
      maxbid: function (x, y) { return (y._a.maxJpy || -1) / Math.max(y.start, 1) - (x._a.maxJpy || -1) / Math.max(x.start, 1); },
      priceAsc: function (x, y) { return x.start - y.start; },
      priceDesc: function (x, y) { return y.start - x.start; },
      date: function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; },
      yearDesc: function (x, y) { return y.year - x.year; },
      kmAsc: function (x, y) { return x.km - y.km; }
    }[F.sort] || null;
    if (by) out.sort(by);
    return out;
  }
  // Najpierw auta z realną ceną wywoławczą (wg opłacalności), potem z symboliczną, na końcu bez wyceny.
  function rank(c) { var a = c._a; if (a.profitEst == null) return -1e9; if (a.symbolic) return -1e6 + Math.min(a.profitEst, 1e5) / 1e3; return a.profitEst; }

  function cardHtml(c) {
    var a = c._a || (c._a = analyse(c));
    var fv = favs()[c.id], nt = notes()[c.id];
    var badge = '';
    if (c.med) {
      badge = a.symbolic ? '<div class="pct" title="Cena wywoławcza jest symboliczna – patrz „Licytuj do”">start symboliczny</div>'
        : '<div class="pct ' + pctCls(a.profitEst) + '" title="Opłacalność przy szacowanej cenie licytacji">' + pct(a.profitEst) + '</div>';
    }
    var tags = '';
    if (a.gem) tags += '<span class="tag gem">★ perełka</span>';
    if (damaged(c)) tags += '<span class="tag warn">ocena ' + esc(c.score) + '</span>';
    return '<a class="card" href="#/auto/' + esc(c.id) + '">' +
      '<div class="ph">' + imgTag(c.img, c.img2) + '<div class="tags">' + tags + '</div>' + badge + (fv || nt ? '<div class="star">' + (fv ? '★' : '') + (nt ? '✎' : '') + '</div>' : '') + '</div>' +
      '<div class="cb"><h3>' + esc(c.title) + '</h3>' +
      '<div class="sub">' + c.year + ' · ' + sp(c.km) + ' km · ' + (c.cc ? sp(c.cc) + ' cm³' : '—') + ' · ocena ' + esc(c.score || '—') + '</div>' +
      '<div class="sub">Licytacja: ' + dmy(c.date) + ' (' + when(c.date) + ') · ' + esc(c.site) + '</div>' +
      '<dl class="rows">' +
      '<dt>Cena wywoławcza</dt><dd class="num">' + jpy(c.start) + ' <small>≈ ' + pln(a.startPln) + '</small></dd>' +
      '<dt>Mediana w Polsce</dt><dd class="num">' + (c.med ? pln(c.med) + ' <small>(' + c.n + ')</small><span class="dot ' + c.conf + '" title="Pewność wyceny"></span>' : '<small>brak wyceny</small>') + '</dd>' +
      '<dt>Szac. cena licytacji</dt><dd class="num">' + jpy(a.estJpy) + ' <small>≈ ' + pln(a.estPln) + '</small></dd>' +
      (c.med ? '<dt>Licytuj do</dt><dd class="num">' + (a.maxJpy > 0 ? jpy(a.maxJpy) + ' <small>≈ ' + pln(a.maxJpy * RATE.mid) + '</small>' : '<small class="c-bad">nie opłaca się</small>') + '</dd>' : '') +
      '</dl></div></a>';
  }

  function renderList() {
    renderChrome('list');
    var brands = {}, dates = {};
    CARS.forEach(function (c) { brands[c.brand] = (brands[c.brand] || 0) + 1; dates[c.date] = (dates[c.date] || 0) + 1; });
    var bOpts = '<option value="">Wszystkie marki</option>' + Object.keys(brands).sort().map(function (b) { return '<option value="' + esc(b) + '"' + (F.brand === b ? ' selected' : '') + '>' + esc(b) + ' (' + brands[b] + ')</option>'; }).join('');
    var dOpts = '<option value="">Wszystkie dni</option>' + Object.keys(dates).sort().map(function (d) { return '<option value="' + d + '"' + (F.date === d ? ' selected' : '') + '>' + dmy(d) + ' – ' + when(d) + ' (' + dates[d] + ')</option>'; }).join('');
    function opt(v, l, cur) { return '<option value="' + v + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + l + '</option>'; }
    var h = '';
    if (META.partial) h += '<div class="note">Dane testowe: wycenę ma tylko część aut (pełne odświeżenie jeszcze trwa lub nie zostało wykonane).</div>';
    h += '<div class="bar">' +
      '<label>Marka<select id="f-brand">' + bOpts + '</select></label>' +
      '<label>Cena wywoławcza (zł)<span class="pair"><input id="f-pmin" type="number" min="0" step="1000" placeholder="od" value="' + esc(F.pmin) + '"><input id="f-pmax" type="number" min="0" step="1000" placeholder="do" value="' + esc(F.pmax) + '"></span></label>' +
      '<label>Ocena aukcyjna<select id="f-score">' + opt('', 'dowolna', F.score) + opt(3, 'od 3', F.score) + opt(3.5, 'od 3.5', F.score) + opt(4, 'od 4', F.score) + opt(4.5, 'od 4.5', F.score) + opt(5, 'od 5', F.score) + '</select></label>' +
      '<label>Rocznik<span class="pair"><input id="f-ymin" type="number" placeholder="od" value="' + esc(F.ymin) + '"><input id="f-ymax" type="number" placeholder="do" value="' + esc(F.ymax) + '"></span></label>' +
      '<label>Przebieg do (km)<input id="f-kmax" type="number" min="0" step="10000" placeholder="np. 100000" value="' + esc(F.kmax) + '"></label>' +
      '<label>Dzień licytacji<select id="f-date">' + dOpts + '</select></label>' +
      '<label>Sortowanie<select id="f-sort">' + opt('profit', 'Opłacalność (najlepsze)', F.sort) + opt('maxbid', 'Największy zapas do „Licytuj do”', F.sort) + opt('priceAsc', 'Cena wywoławcza rosnąco', F.sort) + opt('priceDesc', 'Cena wywoławcza malejąco', F.sort) + opt('date', 'Data licytacji', F.sort) + opt('yearDesc', 'Najnowsze roczniki', F.sort) + opt('kmAsc', 'Najmniejszy przebieg', F.sort) + '</select></label>' +
      '</div>' +
      '<div class="checks">' +
      chk('onlyVal', 'tylko z wyceną') + chk('onlyGem', 'tylko perełki ★') + chk('onlyFav', 'ulubione i z notatką') + chk('hideDmg', 'ukryj auta po wypadku / bez oceny') +
      '<button class="btn" id="f-reset" type="button">Wyczyść filtry</button><span class="count" id="count"></span></div>' +
      '<div class="grid" id="grid"></div><button class="btn more" id="more" type="button">Pokaż więcej</button>';
    app.innerHTML = h;
    function chk(k, l) { return '<label><input type="checkbox" id="f-' + k + '"' + (F[k] ? ' checked' : '') + '>' + l + '</label>'; }

    function draw() {
      var list = filtered();
      var gems = list.filter(function (c) { return c._a.gem; }).length;
      document.getElementById('count').textContent = list.length + ' z ' + CARS.length + ' aukcji' + (gems ? ' · perełek: ' + gems : '');
      document.getElementById('grid').innerHTML = list.slice(0, shown).map(cardHtml).join('') || '<p class="muted">Brak aukcji dla tych filtrów.</p>';
      document.getElementById('more').style.display = list.length > shown ? '' : 'none';
    }
    function bind(id, key, isChk) {
      var el = document.getElementById(id);
      el.addEventListener(isChk || el.tagName === 'SELECT' ? 'change' : 'input', function () { F[key] = isChk ? el.checked : el.value; store.set('filters', F); shown = 60; draw(); });
    }
    bind('f-brand', 'brand'); bind('f-pmin', 'pmin'); bind('f-pmax', 'pmax'); bind('f-score', 'score'); bind('f-ymin', 'ymin'); bind('f-ymax', 'ymax'); bind('f-kmax', 'kmax'); bind('f-date', 'date'); bind('f-sort', 'sort');
    bind('f-onlyVal', 'onlyVal', true); bind('f-onlyGem', 'onlyGem', true); bind('f-onlyFav', 'onlyFav', true); bind('f-hideDmg', 'hideDmg', true);
    document.getElementById('f-reset').addEventListener('click', function () { F = Object.assign({}, F0); store.set('filters', F); shown = 60; renderList(); });
    document.getElementById('more').addEventListener('click', function () { shown += 60; draw(); });
    draw();
    window.scrollTo(0, listScroll);
  }

  // ====================== KARTA AUTA ======================
  function loadDetail(id, cb) {
    if (window.DETAIL && window.DETAIL[id]) return cb(window.DETAIL[id]);
    var s = document.createElement('script');
    s.src = 'data/detail/' + encodeURIComponent(id) + '.js?v=' + encodeURIComponent(META.updated || '');
    s.onload = function () { cb(window.DETAIL && window.DETAIL[id]); };
    s.onerror = function () { cb(null); };
    document.head.appendChild(s);
  }

  function costTable(a, c) {
    function col(k) { return '<td class="num">' + pln(a.costStart[k]) + '</td><td class="num">' + pln(a.costEst[k]) + '</td>'; }
    var pS = a.safe - a.costStart.total, pE = a.safe - a.costEst.total;
    return '<table><thead><tr><th></th><th>przy cenie wywoławczej</th><th>przy szacowanej cenie</th></tr></thead><tbody>' +
      '<tr><td>Cena auta na aukcji</td>' + col('bid') + '</tr>' +
      '<tr><td>Transport do Polski</td>' + col('transport') + '</tr>' +
      '<tr><td>Cło ' + Math.round(FIX.duty * 100) + '%</td>' + col('duty') + '</tr>' +
      '<tr><td>Akcyza ' + (a.costEst.exciseRate * 100).toFixed(1).replace('.', ',') + '% <span class="muted small">(' + (c.cc ? sp(c.cc) + ' cm³' : 'brak pojemności') + ')</span></td>' + col('excise') + '</tr>' +
      '<tr><td>VAT ' + Math.round(FIX.vat * 100) + '%</td>' + col('vat') + '</tr>' +
      '<tr class="sum"><td>Razem koszt auta w Polsce</td>' + col('total') + '</tr>' +
      '<tr><td>Bezpieczna cena sprzedaży <span class="muted small">(mediana −' + S.safety + '%)</span></td><td class="num">' + pln(a.safe) + '</td><td class="num">' + pln(a.safe) + '</td></tr>' +
      '<tr class="sum"><td>Zysk</td><td class="num c-' + pctCls(a.profitStart) + '">' + pln(pS) + ' (' + pct(a.profitStart) + ')</td><td class="num c-' + pctCls(a.profitEst) + '">' + pln(pE) + ' (' + pct(a.profitEst) + ')</td></tr>' +
      '</tbody></table>';
  }

  function renderDetail(id) {
    renderChrome('list');
    var c = null;
    for (var i = 0; i < CARS.length; i++) if (CARS[i].id === id) { c = CARS[i]; break; }
    if (!c) { app.innerHTML = '<a class="back" href="#/">← Wróć do listy</a><p>Tej aukcji nie ma już na liście (zakończyła się lub została usunięta).</p>'; return; }
    var a = c._a = analyse(c);
    app.innerHTML = '<a class="back" href="#/">← Wróć do listy</a><p class="muted">Ładowanie karty auta…</p>';
    window.scrollTo(0, 0);
    loadDetail(id, function (d) {
      d = d || { photos: [c.img], equip: [], urls: {}, hist: {}, comps: [] };
      var photos = (d.photos || []).filter(Boolean);
      var h = '<a class="back" href="#/">← Wróć do listy</a>';
      h += '<div class="dhead"><h1>' + esc(c.title) + ' <span class="muted">' + c.year + '</span></h1>' + (a.gem ? '<span class="tag gem">★ perełka</span>' : '') + (damaged(c) ? '<span class="tag warn">ocena ' + esc(c.score) + ' – ' + esc(trScore(c.score)) + '</span>' : '') + '</div>';
      h += '<div class="dgrid"><div>';

      // galeria
      h += '<div class="box"><div class="gal-main" id="gal-main">' + imgTag(photos[0] || c.img, c.img2) + '</div><div class="thumbs" id="thumbs">' + photos.map(function (p, i) { return '<img loading="lazy" referrerpolicy="no-referrer" src="' + esc(p) + '" data-i="' + i + '"' + (i === 0 ? ' class="on"' : '') + ' onerror="this.remove()" alt="">'; }).join('') + '</div></div>';

      // dane pojazdu (przetłumaczone)
      var mn = modelNote(d.model);
      var rows = [
        ['Marka', esc(c.brand) + (d.maker && d.maker.toLowerCase() !== c.brand.toLowerCase() ? ' <span class="muted">(' + esc(d.maker) + ')</span>' : '')],
        ['Model', esc(d.model || '') + (mn ? ' <span class="muted">– ' + esc(mn) + '</span>' : '')],
        ['Wersja', esc(d.grade || '—')],
        ['Rocznik', c.year],
        ['Przebieg', sp(c.km) + ' km'],
        ['Pojemność silnika', c.cc ? sp(c.cc) + ' cm³' : '—'],
        ['Skrzynia biegów', esc(trTrans(c.trans)) + ' <span class="muted">(' + esc(c.trans) + ')</span>'],
        ['Kolor', esc(trColor(d.color) || '—')],
        ['Nadwozie', esc(TR.body[(d.body || '').toUpperCase()] || (d.body || '—').toLowerCase())],
        ['Kierownica', esc(TR.steering[d.steering] || d.steering || '—')],
        ['Klimatyzacja', esc(TR.ac[d.ac] || d.ac || '—')],
        ['Japoński przegląd', esc(TR.inspection[d.inspection] || d.inspection || '—')],
        ['Kod nadwozia', esc(d.chassis || '—')],
        ['Ocena aukcyjna', '<b>' + esc(c.score || '—') + '</b> <span class="muted">– ' + esc(trScore(c.score) || 'brak opisu') + '</span>'],
        ['Wyposażenie', (d.equip || []).length ? esc(d.equip.map(function (e) { return TR.equip[e] || e; }).join(', ')) : '—'],
        ['Dom aukcyjny', esc(c.site || '—')],
        ['Data licytacji', dmy(c.date) + ' (' + when(c.date) + ')'],
        ['Numer lotu', esc(c.lot)]
      ];
      h += '<div class="box"><h2>Dane pojazdu</h2><dl class="kv">' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl></div>';

      // karta aukcyjna
      h += '<div class="box sheet"><h2>Karta aukcyjna</h2>' +
        (d.sheet ? '<img loading="lazy" referrerpolicy="no-referrer" src="' + esc(d.sheet) + '" id="sheet-img" onerror="this.outerHTML=\'<p class=&quot;muted&quot;>Zdjęcie karty aukcyjnej nie jest dostępne dla tej aukcji.</p>\'" alt="Karta aukcyjna">' : '<p class="muted">Zdjęcie karty aukcyjnej nie jest dostępne dla tej aukcji.</p>') +
        '<details><summary>Co oznaczają symbole na karcie</summary><ul class="legend">' + LEGEND.map(function (l) { return '<li><b>' + l[0] + '</b> ' + l[1] + '</li>'; }).join('') + '</ul></details></div>';
      h += '</div><div>';

      // liczby
      h += '<div class="box"><h2>Czy warto licytować</h2><div class="kpis">' +
        '<div class="kpi"><div class="l">Cena wywoławcza</div><div class="v num">' + jpy(c.start) + '</div><div class="s num">≈ ' + pln(a.startPln) + '</div></div>' +
        '<div class="kpi"><div class="l">Mediana cen w Polsce</div><div class="v num">' + (c.med ? pln(c.med) : 'brak wyceny') + '</div><div class="s">' + (c.med ? c.n + ' ogłoszeń <span class="dot ' + c.conf + '"></span> pewność ' + ({ high: 'wysoka', mid: 'średnia', low: 'niska' }[c.conf] || '') : 'nie znaleziono podobnych aut') + '</div></div>' +
        '<div class="kpi"><div class="l">Szacowana cena licytacji</div><div class="v num">' + jpy(a.estJpy) + '</div><div class="s num">≈ ' + pln(a.estPln) + ' · ' + (a.learned ? 'z historii ' + (d.estN || '') + ' aukcji' : 'orientacyjnie: wywoławcza × ' + String(S.multiplier).replace('.', ',')) + '</div></div>';
      if (c.med) {
        h += '<div class="kpi"><div class="l">Opłacalność</div><div class="v c-' + pctCls(a.profitEst) + '">' + pct(a.profitEst) + '</div><div class="s">przy szacowanej cenie · przy wywoławczej ' + pct(a.profitStart) + '</div></div>' +
          '<div class="kpi wide"><div class="l">Licytuj maksymalnie do <span class="muted">(zostaje ' + S.margin + '% zysku)</span></div><div class="v num ' + (a.maxJpy > 0 ? 'c-good' : 'c-bad') + '">' + (a.maxJpy > 0 ? jpy(a.maxJpy) + ' <span class="muted" style="font-size:15px">≈ ' + pln(a.maxJpy * RATE.mid) + '</span>' : 'nie opłaca się przy żadnej cenie') + '</div>' +
          (a.symbolic ? '<div class="s c-warn">Cena wywoławcza jest symboliczna (dużo poniżej wartości auta), więc licytacja skończy się znacznie wyżej. Kieruj się kwotą „Licytuj do”, a nie procentem opłacalności.</div>' : '') + '</div>';
      }
      h += '</div><div class="actions" style="margin-top:12px">' +
        '<a class="btn primary" href="#/kalkulator?bid=' + a.estJpy + '&cc=' + c.cc + '&sale=' + (c.med || '') + '">Otwórz w kalkulatorze</a>' +
        (d.urls && d.urls.rajauto ? '<a class="btn" target="_blank" rel="noopener noreferrer" href="' + esc(d.urls.rajauto) + '">Aukcja w RajAuto ↗</a>' : '') +
        (d.urls && d.urls.fabryka ? '<a class="btn" target="_blank" rel="noopener noreferrer" href="' + esc(d.urls.fabryka) + '">Aukcja w Fabryce Klasyków ↗</a>' : '') +
        '</div></div>';

      // koszty
      if (c.med) h += '<div class="box"><h2>Wyliczenie kosztów</h2>' + costTable(a, c) + '</div>';

      // wycena rynku
      var v = d.val, m = d.market;
      h += '<div class="box"><h2>Wycena na polskim rynku</h2>';
      if (v && m) {
        h += '<dl class="kv">' +
          '<dt>Otomoto</dt><dd class="num">' + (v.nO ? pln(v.medO) + ' <span class="muted">(' + v.nO + ' ogł.)</span>' : '<span class="muted">brak podobnych</span>') + '</dd>' +
          '<dt>Autoplac</dt><dd class="num">' + (v.nA ? pln(v.medA) + ' <span class="muted">(' + v.nA + ' ogł.)</span>' : '<span class="muted">brak podobnych</span>') + '</dd>' +
          '<dt>Mediana łącznie</dt><dd class="num">' + pln(v.med) + ' <span class="muted">(' + v.n + ' ogł.)</span></dd>' +
          '<dt>Zakres cen</dt><dd class="num">' + pln(v.lo) + ' – ' + pln(v.hi) + '</dd>' +
          '<dt>Porównywane auta</dt><dd>' + esc(m.makeName) + ' ' + esc(m.modelName) + ', roczniki ' + m.yFrom + '–' + m.yTo + (m.capFrom ? ', silnik ' + sp(m.capFrom) + '–' + sp(m.capTo) + ' cm³' : '') + (v.version ? ', wersja „' + esc(v.version) + '”' : '') + (v.kmMatch ? ', podobny przebieg' : ', dowolny przebieg') + ', bez uszkodzonych</dd>' +
          '<dt>Pewność</dt><dd><span class="dot ' + v.conf + '" style="margin:0 6px 0 0"></span>' + ({ high: 'wysoka – dużo podobnych ogłoszeń z podobnym przebiegiem', mid: 'średnia – mało ogłoszeń albo inny przebieg', low: 'niska – bardzo mało ogłoszeń' + (m.widened ? ' (rozszerzono roczniki)' : '') }[v.conf] || '') + (v.dropped ? ' <span class="muted">· pominięto ' + v.dropped + ' ogł. z nietypową ceną</span>' : '') + '</dd></dl>' +
          '<details><summary>Linki do porównywanych ogłoszeń (' + (d.comps || []).length + ')</summary>' +
          '<p class="small"><a target="_blank" rel="noopener noreferrer" href="' + esc(m.urlO) + '">Całe wyszukiwanie w Otomoto ↗</a>' + (m.urlA ? ' · <a target="_blank" rel="noopener noreferrer" href="' + esc(m.urlA) + '">w Autoplac ↗</a>' : '') + '</p>' +
          '<ul class="comps">' + (d.comps || []).map(function (x) { return '<li><span class="num">' + pln(x[0]) + '</span><a target="_blank" rel="noopener noreferrer" href="' + esc(x[5]) + '" title="' + esc(x[4]) + '">' + esc(x[4]) + '</a><span class="muted num">' + x[1] + ' · ' + sp(x[2]) + ' km</span><span class="src">' + (x[6] === 'o' ? 'Otomoto' : 'Autoplac') + '</span></li>'; }).join('') + '</ul></details>';
      } else if (m) {
        h += '<p class="muted">Nie znaleziono podobnych ogłoszeń (' + esc(m.makeName) + ' ' + esc(m.modelName) + ', ' + m.yFrom + '–' + m.yTo + ').</p><p class="small"><a target="_blank" rel="noopener noreferrer" href="' + esc(m.urlO) + '">Sprawdź ręcznie w Otomoto ↗</a></p>';
      } else {
        h += '<p class="muted">Nie udało się dopasować tego modelu do katalogu Otomoto – wyceń ręcznie i wpisz cenę w kalkulatorze.</p>';
      }
      h += '</div>';

      // historia
      var hs = d.hist || {};
      h += '<div class="box"><h2>Historia</h2><dl class="kv"><dt>Na liście od</dt><dd>' + (hs.first ? dmy(hs.first) : '—') + '</dd>' +
        ((hs.changes || []).length ? '<dt>Zmiany ceny wywoławczej</dt><dd>' + hs.changes.map(function (x) { return dmy(x[0]) + ': ' + jpy(x[1]); }).join('<br>') + '</dd>' : '') + '</dl>';
      if ((hs.similar || []).length) {
        h += '<details><summary>Wcześniejsze aukcje tego modelu (' + hs.similar.length + ')</summary><table><thead><tr><th>Data</th><th>Rocznik</th><th>Przebieg</th><th>Ocena</th><th>Wywoławcza</th><th>Wynik</th></tr></thead><tbody>' +
          hs.similar.map(function (x) { return '<tr><td>' + dmy(x.d) + (x.g ? ' <span class="muted small">' + esc(x.g) + '</span>' : '') + '</td><td>' + x.y + '</td><td class="num">' + sp(x.km) + ' km</td><td>' + esc(x.sc) + '</td><td class="num">' + jpy(x.s) + '</td><td class="num">' + (x.sold > 0 ? jpy(x.sold) : '<span class="muted">' + esc(x.res || 'brak danych') + '</span>') + '</td></tr>'; }).join('') + '</tbody></table></details>';
      } else {
        h += '<p class="muted small">Historia wcześniejszych aukcji tego modelu buduje się z każdym dniem działania strony.</p>';
      }
      h += '</div>';

      // notatki
      h += '<div class="box"><h2>Moje notatki</h2><label class="checks" style="margin-bottom:8px"><input type="checkbox" id="fav"' + (favs()[id] ? ' checked' : '') + '> ★ ulubione</label><textarea id="note" placeholder="Np. sprawdzić historię serwisową, limit licytacji, uwagi do karty aukcyjnej…">' + esc(notes()[id] || '') + '</textarea><div class="muted small" id="note-s">Notatki zapisują się automatycznie w tej przeglądarce.</div></div>';
      h += '</div></div>';
      app.innerHTML = h;

      // zdarzenia
      var main = document.querySelector('#gal-main img');
      Array.prototype.forEach.call(document.querySelectorAll('#thumbs img'), function (t) {
        t.addEventListener('click', function () { main.removeAttribute('data-alt'); main.src = t.src; Array.prototype.forEach.call(document.querySelectorAll('#thumbs img'), function (x) { x.classList.toggle('on', x === t); }); });
      });
      function zoom(src) { var lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = '<img referrerpolicy="no-referrer" src="' + esc(src) + '" alt="">'; lb.addEventListener('click', function () { lb.remove(); }); document.body.appendChild(lb); }
      main.addEventListener('click', function () { zoom(main.src); });
      var sh = document.getElementById('sheet-img'); if (sh) sh.addEventListener('click', function () { zoom(sh.src); });
      var ta = document.getElementById('note'), tmr;
      ta.addEventListener('input', function () { clearTimeout(tmr); tmr = setTimeout(function () { var n = notes(); if (ta.value.trim()) n[id] = ta.value; else delete n[id]; store.set('notes', n); document.getElementById('note-s').textContent = 'Zapisano.'; }, 400); });
      document.getElementById('fav').addEventListener('change', function (e) { var f = favs(); if (e.target.checked) f[id] = 1; else delete f[id]; store.set('favs', f); });
    });
  }

  // ====================== KALKULATOR ======================
  function renderCalc(q) {
    renderChrome('calc');
    var v = { bid: q.bid || '', rate: RATE.mid ? +(RATE.mid * 1e6).toFixed(0) : '', cc: q.cc || '', sale: q.sale || '', transport: S.transport, safety: S.safety, margin: S.margin, multiplier: S.multiplier };
    function inp(id, label, val, extra) { return '<label>' + label + '<input id="k-' + id + '" type="number" inputmode="decimal" value="' + esc(val) + '" ' + (extra || '') + '></label>'; }
    app.innerHTML = '<h1 style="margin:18px 0 0">Kalkulator opłacalności</h1><p class="muted">Wpisz cenę z aukcji i cenę, za jaką takie auto sprzedaje się w Polsce.</p>' +
      '<div class="calc"><div class="box"><h2>Dane</h2><div class="form">' +
      inp('bid', 'Cena licytacji (¥)', v.bid, 'min="0" step="10000"') +
      inp('rate', 'Kurs: 1 000 000 ¥ = … zł', v.rate, 'min="0" step="1"') +
      inp('cc', 'Pojemność silnika (cm³)', v.cc, 'min="0" step="100"') +
      inp('sale', 'Cena sprzedaży w Polsce (zł)', v.sale, 'min="0" step="1000"') +
      inp('transport', 'Transport do Polski (zł)', v.transport, 'min="0" step="500"') +
      inp('safety', 'Zapas bezpieczeństwa (% od ceny w PL)', v.safety, 'min="0" max="90" step="1"') +
      inp('margin', 'Docelowy zysk (%)', v.margin, 'min="0" step="1"') +
      inp('multiplier', 'Szac. cena licytacji = wywoławcza ×', v.multiplier, 'min="1" step="0.05"') +
      '<div class="full actions"><button class="btn primary" id="k-save" type="button">Zapisz jako ustawienia całej strony</button><button class="btn" id="k-def" type="button">Przywróć domyślne</button></div>' +
      '<div class="full muted small" id="k-msg">Transport, zapas bezpieczeństwa, docelowy zysk i mnożnik po zapisaniu obowiązują na liście aukcji i w kartach aut. Stałe: cło ' + Math.round(FIX.duty * 100) + '%, akcyza ' + String(FIX.exS * 100).replace('.', ',') + '% do ' + sp(FIX.thr) + ' cm³ i ' + (FIX.exL * 100).toFixed(1).replace('.', ',') + '% powyżej, VAT ' + Math.round(FIX.vat * 100) + '%.</div>' +
      '</div></div><div class="box" id="k-out"></div></div>';
    function g(id) { return num(document.getElementById('k-' + id).value, 0); }
    function calc() {
      var rate = g('rate') / 1e6, bid = g('bid') * rate, cc = g('cc'), sale = g('sale'), t = g('transport'), sf = g('safety'), mg = g('margin');
      var k = costs(bid, cc, t), safe = sale * (1 - sf / 100);
      var o = '<h2>Wynik</h2>';
      if (sale > 0 && g('bid') > 0) {
        var p = (safe - k.total) / k.total * 100;
        var mb = maxBidPln(safe, cc, mg, t);
        o += '<div class="big c-' + pctCls(p) + '">' + pct(p) + '</div><div class="muted">opłacalność · zysk ' + pln(safe - k.total) + '</div>' +
          '<p>Licytuj maksymalnie do: <b class="num">' + (mb > 0 && rate > 0 ? jpy(Math.floor(mb / rate / 10000) * 10000) + ' (≈ ' + pln(mb) + ')' : 'nie opłaca się') + '</b> <span class="muted">– wtedy zostaje ' + mg + '% zysku</span></p>';
      } else { o += '<p class="muted">Wpisz cenę licytacji i cenę sprzedaży w Polsce.</p>'; }
      o += '<table><tbody>' +
        '<tr><td>Cena auta na aukcji</td><td class="num">' + pln(k.bid) + '</td></tr>' +
        '<tr><td>Transport do Polski</td><td class="num">' + pln(k.transport) + '</td></tr>' +
        '<tr><td>Cło ' + Math.round(FIX.duty * 100) + '%</td><td class="num">' + pln(k.duty) + '</td></tr>' +
        '<tr><td>Akcyza ' + (k.exciseRate * 100).toFixed(1).replace('.', ',') + '%</td><td class="num">' + pln(k.excise) + '</td></tr>' +
        '<tr><td>VAT ' + Math.round(FIX.vat * 100) + '%</td><td class="num">' + pln(k.vat) + '</td></tr>' +
        '<tr class="sum"><td>Razem koszt auta w Polsce</td><td class="num">' + pln(k.total) + '</td></tr>' +
        (sale > 0 ? '<tr><td>Bezpieczna cena sprzedaży (−' + sf + '%)</td><td class="num">' + pln(safe) + '</td></tr>' : '') +
        '</tbody></table>';
      document.getElementById('k-out').innerHTML = o;
    }
    Array.prototype.forEach.call(app.querySelectorAll('input'), function (el) { el.addEventListener('input', calc); });
    document.getElementById('k-save').addEventListener('click', function () {
      S = { transport: g('transport'), safety: g('safety'), margin: g('margin'), multiplier: Math.max(1, g('multiplier') || 1) };
      store.set('settings', S); CARS.forEach(function (c) { c._a = null; });
      document.getElementById('k-msg').textContent = 'Zapisano – lista aukcji i karty aut liczą się teraz według tych ustawień.';
    });
    document.getElementById('k-def').addEventListener('click', function () { S = Object.assign({}, DEF); store.del('settings'); CARS.forEach(function (c) { c._a = null; }); renderCalc({}); });
    calc();
    window.scrollTo(0, 0);
  }

  // ====================== ROUTING ======================
  var current = 'list';
  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    if (current === 'list') listScroll = window.scrollY;
    var m;
    if ((m = /^auto\/([^?]+)/.exec(h))) { current = 'detail'; renderDetail(decodeURIComponent(m[1])); }
    else if (/^kalkulator/.test(h)) {
      current = 'calc';
      var q = {}; (h.split('?')[1] || '').split('&').forEach(function (p) { var kv = p.split('='); if (kv[0]) q[kv[0]] = decodeURIComponent(kv[1] || ''); });
      renderCalc(q);
    } else { current = 'list'; renderList(); }
  }
  window.addEventListener('hashchange', route);
  route();
})();
