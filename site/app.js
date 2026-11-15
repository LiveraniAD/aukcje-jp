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
  var NB = ' ';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sp(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NB); }
  function pln(n) { return n == null || !isFinite(n) ? '—' : sp(n) + NB + 'zł'; }
  function jpy(n) { return n == null || !isFinite(n) ? '—' : '¥' + NB + sp(n); }
  function pct(p) { return p == null || !isFinite(p) ? '—' : (p > 0 ? '+' : '') + Math.round(p) + '%'; }
  function pctCls(p) { return p == null ? '' : p >= 30 ? 'good' : p >= 15 ? 'ok' : p >= 0 ? 'warn' : 'bad'; }
  function dmy(iso) { if (!iso) return ''; var p = iso.split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }
  function dm(iso) { if (!iso) return ''; var p = iso.split('-'); return p[2] + '.' + p[1]; }
  var DAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
  function iso(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function when(i) {
    var t = new Date(); if (i === iso(t)) return 'dziś';
    t.setDate(t.getDate() + 1); if (i === iso(t)) return 'jutro';
    var d = new Date(i + 'T12:00:00'); return isNaN(d) ? '' : DAYS[d.getDay()];
  }
  function stamp(s) { return s ? new Date(s).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
  // "MERCEDES BENZ S-CLASS 4D 4WD S580 4MATIC LONG" -> "Mercedes-Benz S-Class 4D 4WD S580 4MATIC Long"
  function pretty(t) {
    return String(t || '').replace(/^MERCEDES BENZ\b/, 'MERCEDES-BENZ').split(' ').map(function (w) {
      return w.split('-').map(function (p) {
        return (/\d/.test(p) || p.length <= 3 || /^(AMG|BMW|GMC|SUV|MASERATI)$/.test(p) && p.length <= 3) ? p : p.charAt(0) + p.slice(1).toLowerCase();
      }).join('-');
    }).join(' ');
  }

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
  function A(c) { return c._a || (c._a = analyse(c)); }
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

  // ---------- ikony i obrazki ----------
  function svg(path, size, extra) { return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || '') + '>' + path + '</svg>'; }
  var IC = {
    heart: svg('<path d="M12 20.3s-7.2-4.4-7.2-9.7A4.1 4.1 0 0 1 12 8a4.1 4.1 0 0 1 7.2 2.6c0 5.3-7.2 9.7-7.2 9.7z"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>', 16),
    left: svg('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
    right: svg('<path d="M9.5 5.5L16 12l-6.5 6.5"/>'),
    up: svg('<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    sliders: svg('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>', 16)
  };
  var NOIMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#8e8e93" fill-opacity=".16"/><text x="200" y="156" fill="#8e8e93" font-family="sans-serif" font-size="16" text-anchor="middle">brak zdjęcia</text></svg>');
  window.__imgFail = function (img) {
    var alt = img.getAttribute('data-alt');
    if (alt) { img.removeAttribute('data-alt'); img.src = alt; } else { img.onerror = null; img.src = NOIMG; }
  };
  function imgTag(src, alt2, alt) { return '<img loading="lazy" referrerpolicy="no-referrer" src="' + esc(src || NOIMG) + '"' + (alt2 ? ' data-alt="' + esc(alt2) + '"' : '') + ' onerror="__imgFail(this)" alt="' + esc(alt || '') + '">'; }

  // ---------- motyw ----------
  function setThemeColor() { var m = document.getElementById('theme-color'); if (m) m.setAttribute('content', document.documentElement.getAttribute('data-theme') === 'dark' ? '#000000' : '#f5f5f7'); }
  document.getElementById('theme-btn').addEventListener('click', function () {
    var t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('theme', t); } catch (e) {}
    setThemeColor();
  });
  setThemeColor();
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onSys = function (e) { var st = null; try { st = localStorage.getItem('theme'); } catch (x) {} if (!st) { document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light'); setThemeColor(); } };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
  }

  // ---------- nagłówek / stopka ----------
  function renderChrome(active) {
    document.getElementById('upd').innerHTML = META.updated ? 'Aktualizacja <b>' + stamp(META.updated) + '</b>' : '';
    document.getElementById('rate').innerHTML = RATE.mid ? '1' + NB + '000' + NB + '000' + NB + '¥ = <b>' + pln(RATE.mid * 1e6) + '</b><span class="rate-date"> · NBP ' + dm(RATE.date) + '</span>' : '';
    Array.prototype.forEach.call(document.querySelectorAll('.tabs a'), function (a) { a.classList.toggle('on', a.getAttribute('data-nav') === active); });
    var cn = META.counts || {};
    document.getElementById('foot').innerHTML = '<hr>' +
      'Aukcje: RajAuto (' + (cn.rajauto || 0) + ') i Fabryka Klasyków (' + (cn.fabryka || 0) + '). Po scaleniu duplikatów: ' + (cn.unique || 0) + ' unikalnych aukcji, w tym ' + (cn.shown || 0) + ' z ceną wywoławczą. Ceny w Polsce: Otomoto i Autoplac.<br>' +
      'Ostatnie odświeżenie aukcji: ' + stamp(META.updated) + '. Kurs jena: NBP z dnia ' + dmy(RATE.date) + ' (NBP nie publikuje kursów w weekendy i święta).<br>' +
      'Wyliczenia są szacunkowe. Przed licytacją sprawdź auto i ceny samodzielnie.' +
      ((META.blocked || []).length ? '<br><span class="c-warn">W ostatnim odświeżeniu nie udało się pobrać danych z: ' + esc(META.blocked.join(', ')) + '.</span>' : '');
  }
  var topBtn = document.createElement('button');
  topBtn.className = 'to-top'; topBtn.type = 'button'; topBtn.setAttribute('aria-label', 'Wróć na górę'); topBtn.innerHTML = IC.up;
  topBtn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  document.body.appendChild(topBtn);
  window.addEventListener('scroll', function () { topBtn.classList.toggle('show', window.scrollY > 900); }, { passive: true });

  // ====================== LISTA ======================
  var F0 = { q: '', brand: '', pmin: '', pmax: '', score: '', ymin: '', ymax: '', kmax: '', date: '', sort: 'profit', onlyVal: false, onlyGem: false, onlyFav: false, hideDmg: true };
  var F = Object.assign({}, F0, store.get('filters', {}));
  var ADV = ['pmin', 'pmax', 'score', 'ymin', 'ymax', 'kmax', 'date'];
  var shown = 48;
  var listScroll = 0;

  function favs() { return store.get('favs', {}); }
  function notes() { return store.get('notes', {}); }

  function filtered() {
    var fv = favs(), nt = notes();
    var words = (F.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < CARS.length; i++) {
      var c = CARS[i];
      if (F.brand && c.brand !== F.brand) continue;
      if (words.length) {
        var hay = (c.brand + ' ' + c.title + ' ' + c.year + ' ' + c.lot).toLowerCase(), ok = true;
        for (var w = 0; w < words.length; w++) if (hay.indexOf(words[w]) < 0) { ok = false; break; }
        if (!ok) continue;
      }
      var a = A(c);
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
    var a = A(c);
    var fv = favs()[c.id], nt = notes()[c.id];
    var pills = '';
    if (a.gem) pills += '<span class="pill gem">★ Perełka</span>';
    if (c.med) pills += a.symbolic ? '<span class="pill" title="Cena wywoławcza jest symboliczna – kieruj się kwotą „Licytuj do”">Start symboliczny</span>'
      : '<span class="pill ' + pctCls(a.profitEst) + '" title="Opłacalność przy szacowanej cenie licytacji">' + pct(a.profitEst) + '</span>';
    if (damaged(c)) pills += '<span class="pill bad">Ocena ' + esc(c.score) + '</span>';
    var bid = c.med
      ? (a.maxJpy > 0 ? '<span class="v num">' + jpy(a.maxJpy) + '<small>≈ ' + pln(a.maxJpy * RATE.mid) + '</small></span>' : '<span class="v c-bad" style="font-size:14.5px">nie opłaca się</span>')
      : '<span class="v muted" style="font-size:14.5px;font-weight:400">brak wyceny</span>';
    return '<a class="card" href="#/auto/' + esc(c.id) + '">' +
      '<div class="ph">' + imgTag(c.img, c.img2, pretty(c.title)) + '<div class="pills">' + pills + '</div>' +
      '<button class="fav' + (fv ? ' on' : '') + '" type="button" data-fav="' + esc(c.id) + '" aria-label="' + (fv ? 'Usuń z ulubionych' : 'Dodaj do ulubionych') + '" aria-pressed="' + (fv ? 'true' : 'false') + '">' + IC.heart + '</button>' +
      (nt ? '<span class="pill note-mark" title="Masz notatkę do tego auta">✎ notatka</span>' : '') + '</div>' +
      '<div class="cb"><div class="eyebrow">' + dm(c.date) + ' · ' + when(c.date) + ' · ' + esc(c.site) + '</div>' +
      '<h3>' + esc(pretty(c.title)) + '</h3>' +
      '<div class="meta">' + c.year + ' · ' + sp(c.km) + NB + 'km · ' + (c.cc ? sp(c.cc) + NB + 'cm³' : '—') + ' · ocena ' + esc(c.score || '—') + '</div>' +
      '<dl class="rows">' +
      '<dt>Cena wywoławcza</dt><dd class="num">' + jpy(c.start) + ' <small>≈ ' + pln(a.startPln) + '</small></dd>' +
      '<dt>Mediana w Polsce</dt><dd class="num">' + (c.med ? pln(c.med) + ' <small>(' + c.n + ')</small><span class="dot ' + c.conf + '" title="Pewność wyceny: ' + ({ high: 'wysoka', mid: 'średnia', low: 'niska' }[c.conf] || '') + '"></span>' : '<small>brak wyceny</small>') + '</dd>' +
      '<dt>Szac. cena licytacji</dt><dd class="num">' + jpy(a.estJpy) + ' <small>≈ ' + pln(a.estPln) + '</small></dd>' +
      '</dl><div class="bid"><div class="bid-in"><span class="l">Licytuj do</span>' + bid + '</div></div></div></a>';
  }

  function renderList() {
    renderChrome('list');
    var brands = {}, dates = {}, gemsAll = 0;
    CARS.forEach(function (c) { brands[c.brand] = (brands[c.brand] || 0) + 1; dates[c.date] = (dates[c.date] || 0) + 1; if (A(c).gem) gemsAll++; });
    function opt(v, l, cur) { return '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + l + '</option>'; }
    var bOpts = opt('', 'Wszystkie marki', F.brand) + Object.keys(brands).sort().map(function (b) { return opt(b, esc(b) + ' (' + brands[b] + ')', F.brand); }).join('');
    var dOpts = opt('', 'Wszystkie dni', F.date) + Object.keys(dates).sort().map(function (d) { return opt(d, dmy(d) + ' – ' + when(d) + ' (' + dates[d] + ')', F.date); }).join('');
    function chip(k, l) { return '<label class="chip' + (F[k] ? ' on' : '') + '"><input type="checkbox" id="f-' + k + '"' + (F[k] ? ' checked' : '') + '>' + l + '</label>'; }
    var cn = META.counts || {};
    var open = !!store.get('panelOpen', false);

    var h = '<div class="page">';
    if (META.partial) h += '<div class="banner">Dane testowe: wycenę ma tylko część aut.</div>';
    h += '<div class="toolbar">' +
      '<label class="search">' + IC.search + '<input id="f-q" type="search" placeholder="Szukaj: marka, model, rocznik, numer lotu" value="' + esc(F.q) + '" aria-label="Szukaj aukcji"></label>' +
      '<select id="f-brand" aria-label="Marka">' + bOpts + '</select>' +
      '<select id="f-sort" aria-label="Sortowanie">' + opt('profit', 'Najlepsza opłacalność', F.sort) + opt('maxbid', 'Największy zapas do „Licytuj do”', F.sort) + opt('priceAsc', 'Cena wywoławcza rosnąco', F.sort) + opt('priceDesc', 'Cena wywoławcza malejąco', F.sort) + opt('date', 'Data licytacji', F.sort) + opt('yearDesc', 'Najnowsze roczniki', F.sort) + opt('kmAsc', 'Najmniejszy przebieg', F.sort) + '</select>' +
      '<button class="btn" id="f-toggle" type="button" aria-expanded="' + open + '" aria-controls="panel">' + IC.sliders + 'Filtry<span class="badge" id="f-badge" hidden></span></button>' +
      '</div>' +
      '<div class="panel" id="panel"' + (open ? '' : ' hidden') + '>' +
      '<label class="field">Cena wywoławcza (zł)<span class="pair"><input id="f-pmin" type="number" min="0" step="1000" placeholder="od" value="' + esc(F.pmin) + '"><input id="f-pmax" type="number" min="0" step="1000" placeholder="do" value="' + esc(F.pmax) + '"></span></label>' +
      '<label class="field">Rocznik<span class="pair"><input id="f-ymin" type="number" placeholder="od" value="' + esc(F.ymin) + '"><input id="f-ymax" type="number" placeholder="do" value="' + esc(F.ymax) + '"></span></label>' +
      '<label class="field">Przebieg do (km)<input id="f-kmax" type="number" min="0" step="10000" placeholder="np. 100 000" value="' + esc(F.kmax) + '"></label>' +
      '<label class="field">Ocena aukcyjna<select id="f-score">' + opt('', 'Dowolna', F.score) + opt(3, 'od 3', F.score) + opt(3.5, 'od 3.5', F.score) + opt(4, 'od 4', F.score) + opt(4.5, 'od 4.5', F.score) + opt(5, 'od 5', F.score) + '</select></label>' +
      '<label class="field">Dzień licytacji<select id="f-date">' + dOpts + '</select></label>' +
      '</div>' +
      '<div class="chips">' + chip('onlyVal', 'Tylko z wyceną') + chip('onlyGem', '★ Perełki') + chip('onlyFav', '♥ Ulubione i notatki') + chip('hideDmg', 'Bez aut po wypadku') +
      '<button class="btn link" id="f-reset" type="button">Wyczyść filtry</button><span class="count" id="count" aria-live="polite"></span></div>' +
      '<div class="grid" id="grid"></div><button class="btn more" id="more" type="button">Pokaż więcej</button></div>';
    app.innerHTML = h;

    function draw() {
      var list = filtered();
      var gems = 0; list.forEach(function (c) { if (c._a.gem) gems++; });
      document.getElementById('count').textContent = list.length + ' z ' + CARS.length + ' aukcji' + (gems ? ' · ' + gems + ' perełek' : '');
      document.getElementById('grid').innerHTML = list.slice(0, shown).map(cardHtml).join('') || '<div class="empty"><b>Brak aukcji dla tych filtrów</b>Zmień kryteria albo wyczyść filtry.</div>';
      var more = document.getElementById('more');
      more.style.display = list.length > shown ? '' : 'none';
      more.textContent = 'Pokaż więcej (' + Math.max(0, list.length - shown) + ')';
      var n = ADV.filter(function (k) { return F[k] !== '' && F[k] != null; }).length, b = document.getElementById('f-badge');
      b.hidden = !n; b.textContent = n;
    }
    function bind(key, isChk) {
      var el = document.getElementById('f-' + key);
      el.addEventListener(isChk || el.tagName === 'SELECT' ? 'change' : 'input', function () {
        F[key] = isChk ? el.checked : el.value;
        if (isChk) el.parentNode.classList.toggle('on', el.checked);
        store.set('filters', F); shown = 48; draw();
      });
    }
    ['q', 'brand', 'sort', 'pmin', 'pmax', 'ymin', 'ymax', 'kmax', 'score', 'date'].forEach(function (k) { bind(k); });
    ['onlyVal', 'onlyGem', 'onlyFav', 'hideDmg'].forEach(function (k) { bind(k, true); });
    document.getElementById('f-toggle').addEventListener('click', function () {
      var p = document.getElementById('panel'); p.hidden = !p.hidden;
      this.setAttribute('aria-expanded', String(!p.hidden)); store.set('panelOpen', !p.hidden);
    });
    document.getElementById('f-reset').addEventListener('click', function () { F = Object.assign({}, F0); store.set('filters', F); shown = 48; listScroll = window.scrollY; renderList(); });
    document.getElementById('more').addEventListener('click', function () { shown += 48; draw(); });
    document.getElementById('grid').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-fav]') : null;
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      var id = b.getAttribute('data-fav'), f = favs();
      if (f[id]) delete f[id]; else f[id] = 1;
      store.set('favs', f);
      b.classList.toggle('on', !!f[id]); b.setAttribute('aria-pressed', String(!!f[id]));
      if (F.onlyFav) draw();
    });
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
    return '<div class="scroll-x"><table><thead><tr><th></th><th>przy cenie wywoławczej</th><th>przy szacowanej cenie</th></tr></thead><tbody>' +
      '<tr><td>Cena auta na aukcji</td>' + col('bid') + '</tr>' +
      '<tr><td>Transport do Polski</td>' + col('transport') + '</tr>' +
      '<tr><td>Cło ' + Math.round(FIX.duty * 100) + '%</td>' + col('duty') + '</tr>' +
      '<tr><td>Akcyza ' + (a.costEst.exciseRate * 100).toFixed(1).replace('.', ',') + '% <span class="muted small">(' + (c.cc ? sp(c.cc) + NB + 'cm³' : 'brak pojemności') + ')</span></td>' + col('excise') + '</tr>' +
      '<tr><td>VAT ' + Math.round(FIX.vat * 100) + '%</td>' + col('vat') + '</tr>' +
      '<tr class="sum"><td>Razem koszt auta w Polsce</td>' + col('total') + '</tr>' +
      '<tr><td>Bezpieczna cena sprzedaży <span class="muted small">(mediana −' + S.safety + '%)</span></td><td class="num">' + pln(a.safe) + '</td><td class="num">' + pln(a.safe) + '</td></tr>' +
      '<tr class="sum"><td>Zysk</td><td class="num c-' + pctCls(a.profitStart) + '">' + pln(pS) + ' (' + pct(a.profitStart) + ')</td><td class="num c-' + pctCls(a.profitEst) + '">' + pln(pE) + ' (' + pct(a.profitEst) + ')</td></tr>' +
      '</tbody></table></div>';
  }

  var keyHandler = null;
  function setKeys(fn) { if (keyHandler) document.removeEventListener('keydown', keyHandler); keyHandler = fn; if (fn) document.addEventListener('keydown', fn); }

  function renderDetail(id) {
    renderChrome('list');
    var c = null;
    for (var i = 0; i < CARS.length; i++) if (CARS[i].id === id) { c = CARS[i]; break; }
    var back = '<a class="back" href="#/">' + IC.left + 'Wszystkie aukcje</a>';
    if (!c) { app.innerHTML = '<div class="page">' + back + '<div class="empty"><b>Tej aukcji nie ma już na liście</b>Zakończyła się albo została usunięta ze źródła.</div></div>'; return; }
    var a = c._a = analyse(c);
    app.innerHTML = '<div class="page">' + back + '<p class="muted">Ładowanie karty auta…</p></div>';
    window.scrollTo(0, 0);
    loadDetail(id, function (d) {
      d = d || { photos: [c.img], equip: [], urls: {}, hist: {}, comps: [] };
      var photos = (d.photos || []).filter(Boolean);
      var conf = { high: 'wysoka', mid: 'średnia', low: 'niska' };
      var pills = '';
      if (a.gem) pills += '<span class="pill flat gem">★ Perełka</span>';
      if (c.med && !a.symbolic) pills += '<span class="pill flat ' + pctCls(a.profitEst) + '">Opłacalność ' + pct(a.profitEst) + '</span>';
      if (damaged(c)) pills += '<span class="pill flat bad">Ocena ' + esc(c.score) + ' – ' + esc(trScore(c.score)) + '</span>';
      pills += '<span class="pill flat">Licytacja ' + dmy(c.date) + ' · ' + when(c.date) + '</span>';

      var h = '<div class="page">' + back +
        '<div class="dhead"><h1>' + esc(pretty(c.title)) + '</h1>' +
        '<div class="meta">' + c.year + ' · ' + sp(c.km) + NB + 'km · ' + (c.cc ? sp(c.cc) + NB + 'cm³' : '—') + ' · ocena ' + esc(c.score || '—') + ' · ' + esc(c.site) + '</div>' +
        '<div class="pills">' + pills + '</div></div>' +
        '<div class="dgrid"><div class="d-a">';

      // galeria
      h += '<div class="box gal"><div class="gal-main" id="gal-main">' + imgTag(photos[0] || c.img, c.img2, pretty(c.title)) +
        '<button class="gal-nav prev" id="g-prev" type="button" aria-label="Poprzednie zdjęcie">' + IC.left + '</button><button class="gal-nav next" id="g-next" type="button" aria-label="Następne zdjęcie">' + IC.right + '</button></div>' +
        '<div class="thumbs" id="thumbs">' + photos.map(function (p, i) { return '<img loading="lazy" referrerpolicy="no-referrer" src="' + esc(p) + '"' + (i === 0 ? ' class="on"' : '') + ' onerror="this.remove()" alt="Zdjęcie ' + (i + 1) + '">'; }).join('') + '</div></div>';

      // dane pojazdu (przetłumaczone)
      var mn = modelNote(d.model);
      var rows = [
        ['Marka', esc(c.brand) + (d.maker && d.maker.toLowerCase() !== c.brand.toLowerCase() ? ' <span class="muted">(' + esc(d.maker) + ')</span>' : '')],
        ['Model', esc(d.model || '') + (mn ? ' <span class="muted">– ' + esc(mn) + '</span>' : '')],
        ['Wersja', esc(d.grade || '—')],
        ['Rocznik', c.year],
        ['Przebieg', sp(c.km) + NB + 'km'],
        ['Pojemność silnika', c.cc ? sp(c.cc) + NB + 'cm³' : '—'],
        ['Skrzynia biegów', esc(trTrans(c.trans)) + ' <span class="muted">(' + esc(c.trans) + ')</span>'],
        ['Kolor', esc(trColor(d.color) || '—')],
        ['Nadwozie', esc(TR.body[(d.body || '').toUpperCase()] || (d.body || '—').toLowerCase())],
        ['Kierownica', esc(TR.steering[d.steering] || d.steering || '—')],
        ['Klimatyzacja', esc(TR.ac[d.ac] || d.ac || '—')],
        ['Japoński przegląd', esc(TR.inspection[d.inspection] || d.inspection || '—')],
        ['Kod nadwozia', esc(d.chassis || '—')],
        ['Ocena aukcyjna', esc(c.score || '—') + ' <span class="muted">– ' + esc(trScore(c.score) || 'brak opisu') + '</span>'],
        ['Wyposażenie', (d.equip || []).length ? esc(d.equip.map(function (e) { return TR.equip[e] || e; }).join(', ')) : '—'],
        ['Dom aukcyjny', esc(c.site || '—')],
        ['Data licytacji', dmy(c.date) + ' (' + when(c.date) + ')'],
        ['Numer lotu', esc(c.lot)]
      ];
      h += '</div><div class="d-c"><div class="box"><h2>Dane pojazdu</h2><dl class="kv">' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl></div>';

      // karta aukcyjna
      h += '<div class="box sheet"><h2>Karta aukcyjna</h2>' +
        (d.sheet ? '<img loading="lazy" referrerpolicy="no-referrer" src="' + esc(d.sheet) + '" id="sheet-img" onerror="this.outerHTML=\'<p class=&quot;muted&quot;>Zdjęcie karty aukcyjnej nie jest dostępne dla tej aukcji.</p>\'" alt="Karta aukcyjna">' : '<p class="muted">Zdjęcie karty aukcyjnej nie jest dostępne dla tej aukcji.</p>') +
        '<details><summary>Co oznaczają symbole na karcie</summary><ul class="legend">' + LEGEND.map(function (l) { return '<li><b>' + l[0] + '</b> ' + l[1] + '</li>'; }).join('') + '</ul></details></div>';
      h += '</div><div class="d-b">';

      // decyzja
      h += '<div class="box"><h2>Czy warto licytować</h2><div class="kpis">';
      if (c.med) {
        h += '<div class="kpi wide hero-kpi' + (a.maxJpy > 0 ? '' : ' no') + '"><div class="l">Licytuj maksymalnie do <span class="muted">· zostaje ' + S.margin + '% zysku</span></div>' +
          '<div class="v num ' + (a.maxJpy > 0 ? 'c-good' : 'c-bad') + '">' + (a.maxJpy > 0 ? jpy(a.maxJpy) : 'Nie opłaca się') + '</div>' +
          '<div class="s num">' + (a.maxJpy > 0 ? '≈ ' + pln(a.maxJpy * RATE.mid) : 'przy żadnej cenie licytacji') + '</div>' +
          (a.symbolic ? '<div class="s" style="margin-top:8px;color:var(--text)">Cena wywoławcza jest symboliczna (dużo poniżej wartości auta), więc licytacja skończy się znacznie wyżej. Kieruj się tą kwotą, a nie procentem opłacalności.</div>' : '') + '</div>';
      }
      h += '<div class="kpi"><div class="l">Cena wywoławcza</div><div class="v num">' + jpy(c.start) + '</div><div class="s num">≈ ' + pln(a.startPln) + '</div></div>' +
        '<div class="kpi"><div class="l">Szacowana cena licytacji</div><div class="v num">' + jpy(a.estJpy) + '</div><div class="s">≈ ' + pln(a.estPln) + ' · ' + (a.learned ? 'z historii ' + (d.estN || '') + ' aukcji' : 'wywoławcza × ' + String(S.multiplier).replace('.', ',')) + '</div></div>' +
        '<div class="kpi"><div class="l">Mediana cen w Polsce</div><div class="v num">' + (c.med ? pln(c.med) : 'Brak wyceny') + '</div><div class="s">' + (c.med ? c.n + ' ogłoszeń<span class="dot ' + c.conf + '"></span> pewność ' + (conf[c.conf] || '') : 'nie znaleziono podobnych aut') + '</div></div>';
      if (c.med) h += '<div class="kpi"><div class="l">Opłacalność</div><div class="v c-' + pctCls(a.profitEst) + '">' + pct(a.profitEst) + '</div><div class="s">przy szacowanej cenie · przy wywoławczej ' + pct(a.profitStart) + '</div></div>';
      h += '</div><div class="actions" style="margin-top:16px">' +
        '<a class="btn primary" href="#/kalkulator?bid=' + a.estJpy + '&cc=' + c.cc + '&sale=' + (c.med || '') + '">Otwórz w kalkulatorze</a>' +
        (d.urls && d.urls.rajauto ? '<a class="btn" target="_blank" rel="noopener noreferrer" href="' + esc(d.urls.rajauto) + '">RajAuto ↗</a>' : '') +
        (d.urls && d.urls.fabryka ? '<a class="btn" target="_blank" rel="noopener noreferrer" href="' + esc(d.urls.fabryka) + '">Fabryka Klasyków ↗</a>' : '') +
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
          '<dt>Porównywane auta</dt><dd>' + esc(m.makeName) + ' ' + esc(m.modelName) + ', roczniki ' + m.yFrom + '–' + m.yTo + (m.capFrom ? ', silnik ' + sp(m.capFrom) + '–' + sp(m.capTo) + NB + 'cm³' : '') + (v.version ? ', wersja „' + esc(v.version) + '”' : '') + (v.kmMatch ? ', podobny przebieg' : ', dowolny przebieg') + ', bez uszkodzonych</dd>' +
          '<dt>Pewność</dt><dd><span class="dot ' + v.conf + '" style="margin:0 8px 0 0"></span>' + ({ high: 'wysoka – dużo podobnych ogłoszeń z podobnym przebiegiem', mid: 'średnia – mało ogłoszeń albo inny przebieg', low: 'niska – bardzo mało ogłoszeń' + (m.widened ? ' (rozszerzono roczniki)' : '') }[v.conf] || '') + (v.dropped ? ' <span class="muted">· pominięto ' + v.dropped + ' ogł. z nietypową ceną</span>' : '') + '</dd></dl>' +
          '<details><summary>Linki do porównywanych ogłoszeń (' + (d.comps || []).length + ')</summary>' +
          '<p class="small" style="margin:12px 0 0"><a style="color:var(--link)" target="_blank" rel="noopener noreferrer" href="' + esc(m.urlO) + '">Całe wyszukiwanie w Otomoto ↗</a>' + (m.urlA ? ' · <a style="color:var(--link)" target="_blank" rel="noopener noreferrer" href="' + esc(m.urlA) + '">w Autoplac ↗</a>' : '') + '</p>' +
          '<ul class="comps">' + (d.comps || []).map(function (x) { return '<li><span class="num">' + pln(x[0]) + '</span><a target="_blank" rel="noopener noreferrer" href="' + esc(x[5]) + '" title="' + esc(x[4]) + '">' + esc(x[4]) + '</a><span class="muted num hide-s">' + x[1] + ' · ' + sp(x[2]) + NB + 'km</span><span class="src">' + (x[6] === 'o' ? 'Otomoto' : 'Autoplac') + '</span></li>'; }).join('') + '</ul></details>';
      } else if (m) {
        h += '<p class="muted">Nie znaleziono podobnych ogłoszeń (' + esc(m.makeName) + ' ' + esc(m.modelName) + ', ' + m.yFrom + '–' + m.yTo + ').</p><a class="btn" target="_blank" rel="noopener noreferrer" href="' + esc(m.urlO) + '">Sprawdź ręcznie w Otomoto ↗</a>';
      } else {
        h += '<p class="muted">Nie udało się dopasować tego modelu do katalogu Otomoto. Wyceń go ręcznie i wpisz cenę w kalkulatorze.</p>';
      }
      h += '</div>';

      // historia
      var hs = d.hist || {};
      h += '<div class="box"><h2>Historia</h2><dl class="kv"><dt>Na liście od</dt><dd>' + (hs.first ? dmy(hs.first) : '—') + '</dd>' +
        ((hs.changes || []).length ? '<dt>Zmiany ceny wywoławczej</dt><dd>' + hs.changes.map(function (x) { return dmy(x[0]) + ': ' + jpy(x[1]); }).join('<br>') + '</dd>' : '') + '</dl>';
      if ((hs.similar || []).length) {
        h += '<details><summary>Wcześniejsze aukcje tego modelu (' + hs.similar.length + ')</summary><div class="scroll-x" style="margin-top:10px"><table><thead><tr><th>Data</th><th>Rocznik</th><th>Przebieg</th><th>Ocena</th><th>Wywoławcza</th><th>Wynik</th></tr></thead><tbody>' +
          hs.similar.map(function (x) { return '<tr><td>' + dmy(x.d) + (x.g ? ' <span class="muted small">' + esc(pretty(x.g)) + '</span>' : '') + '</td><td>' + x.y + '</td><td class="num">' + sp(x.km) + NB + 'km</td><td>' + esc(x.sc) + '</td><td class="num">' + jpy(x.s) + '</td><td class="num">' + (x.sold > 0 ? jpy(x.sold) : '<span class="muted">' + esc(x.res || 'brak danych') + '</span>') + '</td></tr>'; }).join('') + '</tbody></table></div></details>';
      } else {
        h += '<p class="muted small" style="margin:12px 0 0">Historia wcześniejszych aukcji tego modelu buduje się z każdym dniem działania strony.</p>';
      }
      h += '</div>';

      // notatki
      h += '<div class="box"><h2>Moje notatki</h2><label class="switch"><input type="checkbox" id="fav"' + (favs()[id] ? ' checked' : '') + '> Dodaj do ulubionych</label><textarea id="note" placeholder="Np. limit licytacji, uwagi do karty aukcyjnej, co sprawdzić…">' + esc(notes()[id] || '') + '</textarea><div class="muted small" id="note-s" style="margin-top:8px">Notatki zapisują się automatycznie w tej przeglądarce.</div></div>';
      h += '</div></div></div>';
      app.innerHTML = h;

      // galeria: miniatury, strzałki, powiększenie
      var main = document.querySelector('#gal-main img');
      function thumbs() { return Array.prototype.slice.call(document.querySelectorAll('#thumbs img')); }
      function cur() { var t = thumbs(); for (var k = 0; k < t.length; k++) if (t[k].classList.contains('on')) return k; return 0; }
      function show(k) {
        var t = thumbs(); if (!t.length) return;
        k = (k + t.length) % t.length;
        t.forEach(function (x, j) { x.classList.toggle('on', j === k); });
        main.removeAttribute('data-alt'); main.src = t[k].src;
        if (t[k].scrollIntoView) t[k].scrollIntoView({ block: 'nearest', inline: 'nearest' });
        var lb = document.querySelector('.lightbox img[data-gal]'); if (lb) lb.src = t[k].src;
      }
      document.getElementById('thumbs').addEventListener('click', function (e) { var t = thumbs(), k = t.indexOf(e.target); if (k >= 0) show(k); });
      document.getElementById('g-prev').addEventListener('click', function () { show(cur() - 1); });
      document.getElementById('g-next').addEventListener('click', function () { show(cur() + 1); });
      function zoom(src, gallery) {
        var lb = document.createElement('div'); lb.className = 'lightbox'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-label', 'Powiększone zdjęcie');
        lb.innerHTML = '<img referrerpolicy="no-referrer" src="' + esc(src) + '"' + (gallery ? ' data-gal="1"' : '') + ' alt="">' +
          '<button class="lb-close" type="button" aria-label="Zamknij">' + IC.close + '</button>' +
          (gallery ? '<button class="lb-prev" type="button" aria-label="Poprzednie zdjęcie">' + IC.left + '</button><button class="lb-next" type="button" aria-label="Następne zdjęcie">' + IC.right + '</button>' : '');
        lb.addEventListener('click', function (e) {
          var b = e.target.closest('button');
          if (b && b.classList.contains('lb-prev')) return show(cur() - 1);
          if (b && b.classList.contains('lb-next')) return show(cur() + 1);
          lb.remove();
        });
        document.body.appendChild(lb);
      }
      main.addEventListener('click', function () { zoom(main.src, true); });
      var sh = document.getElementById('sheet-img'); if (sh) sh.addEventListener('click', function () { zoom(sh.src, false); });
      setKeys(function (e) {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || '')) return;
        var lb = document.querySelector('.lightbox');
        if (e.key === 'Escape' && lb) lb.remove();
        else if (e.key === 'ArrowLeft') show(cur() - 1);
        else if (e.key === 'ArrowRight') show(cur() + 1);
      });

      // notatki i ulubione
      var ta = document.getElementById('note'), tmr;
      ta.addEventListener('input', function () { clearTimeout(tmr); tmr = setTimeout(function () { var n = notes(); if (ta.value.trim()) n[id] = ta.value; else delete n[id]; store.set('notes', n); document.getElementById('note-s').textContent = 'Zapisano.'; }, 400); });
      document.getElementById('fav').addEventListener('change', function (e) { var f = favs(); if (e.target.checked) f[id] = 1; else delete f[id]; store.set('favs', f); });
    });
  }

  // ====================== KALKULATOR ======================
  function renderCalc(q) {
    renderChrome('calc');
    var v = { bid: q.bid || '', rate: RATE.mid ? +(RATE.mid * 1e6).toFixed(0) : '', cc: q.cc || '', sale: q.sale || '', transport: S.transport, safety: S.safety, margin: S.margin, multiplier: S.multiplier };
    function inp(id, label, val, extra) { return '<label class="field">' + label + '<input id="k-' + id + '" type="number" inputmode="decimal" value="' + esc(val) + '" ' + (extra || '') + '></label>'; }
    app.innerHTML = '<div class="page"><section class="hero" style="padding-bottom:18px"><h1>Kalkulator opłacalności.</h1><p>Wpisz cenę z aukcji i cenę, za jaką takie auto sprzedaje się w Polsce.</p></section>' +
      '<div class="calc"><div class="box"><div class="form">' +
      '<h3>Auto</h3>' +
      inp('bid', 'Cena licytacji (¥)', v.bid, 'min="0" step="10000"') +
      inp('sale', 'Cena sprzedaży w Polsce (zł)', v.sale, 'min="0" step="1000"') +
      inp('cc', 'Pojemność silnika (cm³)', v.cc, 'min="0" step="100"') +
      inp('rate', 'Kurs: 1 000 000 ¥ = … zł', v.rate, 'min="0" step="1"') +
      '<h3>Ustawienia</h3>' +
      inp('transport', 'Transport do Polski (zł)', v.transport, 'min="0" step="500"') +
      inp('safety', 'Zapas bezpieczeństwa (% ceny w PL)', v.safety, 'min="0" max="90" step="1"') +
      inp('margin', 'Docelowy zysk (%)', v.margin, 'min="0" step="1"') +
      inp('multiplier', 'Szac. cena licytacji = wywoławcza ×', v.multiplier, 'min="1" step="0.05"') +
      '<div class="full actions"><button class="btn primary" id="k-save" type="button">Zapisz ustawienia dla całej strony</button><button class="btn" id="k-def" type="button">Przywróć domyślne</button></div>' +
      '<div class="full muted small" id="k-msg">Zapisane ustawienia obowiązują na liście aukcji i w kartach aut. Stałe: cło ' + Math.round(FIX.duty * 100) + '%, akcyza ' + String(FIX.exS * 100).replace('.', ',') + '% do ' + sp(FIX.thr) + NB + 'cm³ i ' + (FIX.exL * 100).toFixed(1).replace('.', ',') + '% powyżej, VAT ' + Math.round(FIX.vat * 100) + '%.</div>' +
      '</div></div><div class="box" id="k-out" aria-live="polite"></div></div></div>';
    function g(id) { return num(document.getElementById('k-' + id).value, 0); }
    function calc() {
      var rate = g('rate') / 1e6, bid = g('bid') * rate, cc = g('cc'), sale = g('sale'), t = g('transport'), sf = g('safety'), mg = g('margin');
      var k = costs(bid, cc, t), safe = sale * (1 - sf / 100);
      var o = '';
      if (sale > 0 && g('bid') > 0) {
        var p = (safe - k.total) / k.total * 100;
        var mb = maxBidPln(safe, cc, mg, t);
        o += '<div class="muted small">Opłacalność</div><div class="big c-' + pctCls(p) + '">' + pct(p) + '</div><div class="muted" style="margin-top:8px">Zysk ' + pln(safe - k.total) + '</div>' +
          '<div class="result-line"><div class="muted small">Licytuj maksymalnie do · zostaje ' + mg + '% zysku</div><b class="num">' + (mb > 0 && rate > 0 ? jpy(Math.floor(mb / rate / 10000) * 10000) + '</b> <span class="muted num">≈ ' + pln(mb) + '</span>' : 'nie opłaca się</b>') + '</div>';
      } else { o += '<h2>Wynik</h2><p class="muted">Wpisz cenę licytacji i cenę sprzedaży w Polsce.</p>'; }
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
      document.getElementById('k-msg').textContent = 'Zapisano. Lista aukcji i karty aut liczą się teraz według tych ustawień.';
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
    setKeys(null);
    var lb = document.querySelector('.lightbox'); if (lb) lb.remove();
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
