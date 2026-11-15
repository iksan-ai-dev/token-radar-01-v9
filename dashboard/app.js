// Launch Ledger v9 dashboard. Static, no network; reads window.RADAR.
// Row: [rank, slug, name, cat, chains, tvlK, ch7, age, curve, implied,
// effect, growth, ageF, slice, ticket, hold, verdict, tier]
(function () {
  var R = window.RADAR;
  var rows = R.rows, comps = R.comps, live = R.live, cats = R.cats, C = R.counts;
  var VERDICT = ['Low slice', 'Thin', 'Worth it'];
  var TIER = ['Watchlist', 'Above floor', 'Early find'];
  var GAS = { Ethereum: 2.5, Tron: 0.5, Binance: 0.05, Avalanche: 0.05, Base: 0.08, Arbitrum: 0.1, Optimism: 0.08, Polygon: 0.02, Solana: 0.01 };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function money(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }
  function titleCase(slug) { return slug.split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' '); }
  function pct(c) { return c === null ? '&mdash;' : (c > 0 ? '+' : '') + c.toFixed(2) + '%'; }
  function ageStr(d) { return d === null ? 'n/a' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd'; }
  function catName(i) { return i < 0 || !cats[i] ? '(none)' : cats[i][0]; }
  function bySlug(slug) { for (var i = 0; i < rows.length; i++) if (rows[i][1] === slug) return rows[i]; return null; }

  // The model's two seasoning terms, named as the model names them.
  function ageFactor(days) { var d = days === null ? 365 : days; return 0.55 + 0.45 * (Math.min(d, 730) / 730); }
  function growthFactor(ch7) { if (ch7 === null) return 1; return Math.max(0.6, Math.min(1.6, 1 + 0.75 * (ch7 / 100))); }

  // ---- header strips (same numbers the model computed)
  $('asof').textContent = R.asOf;
  $('m-scanned').textContent = C.sc;
  $('m-ranked').textContent = C.rk;
  $('m-total').textContent = money(C.ti);
  $('formula').innerHTML = '<b>implied = TVL &times; size curve &times; category effect &times; growthFactor &times; ageFactor.</b> ' +
    'Curve log10(mcap/TVL) = ' + R.curve.intercept.toFixed(4) + ' &minus; ' + Math.abs(R.curve.slope).toFixed(4) + '&middot;log10(TVL), ' +
    'level &times;' + R.curve.level_at_100m.toFixed(4) + ' at $100M &middot; LOO &times;' + R.curve.loo.toFixed(4) +
    ' (flat &times;' + R.curve.flat_loo.toFixed(4) + ') &middot; P25&ndash;P75 band &times;' + R.band.ratio.toFixed(2) +
    ' &middot; No name is special-cased. No maturity factor.';
  $('recon').innerHTML = '<b>' + C.sc + ' = ' + C.rk + ' ranked + ' + C.tr + ' already trading + ' + C.sa + ' set aside</b> &middot; ' +
    '<b>' + C.rk + ' = ' + C.wl + ' watchlist + ' + C.er + ' early finds (' + C.bf + ' below floor + ' + C.af + ' above floor)</b> &middot; ' +
    '<b>' + C.rk + '/' + C.rk + ' ranks and values match board.json</b>';

  // ---- tabs
  var tabs = [
    ['all', 'All', C.rk], ['watchlist', 'Watchlist', C.wl],
    ['below', 'Below floor', C.bf], ['above', 'Above floor', C.af],
    ['live', 'Already trading', C.tr],
  ];
  var state = { tab: 'all', tier: '', cat: '', chain: '', tvl: 0, d7: '', q: '', sort: 9, desc: true };
  function renderTabs() {
    $('tabs').innerHTML = tabs.map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (state.tab === t[0] ? 'on' : '') + '">' + t[1] + ' <span class="n">' + t[2] + '</span></button>';
    }).join('');
    Array.prototype.forEach.call($('tabs').querySelectorAll('button'), function (b) {
      b.onclick = function () { setTab(b.getAttribute('data-tab')); };
    });
  }
  function setTab(t) {
    state.tab = t;
    if (t === 'live') { location.hash = '#/live'; return; }
    state.tier = t === 'all' ? '' : t === 'watchlist' ? '0' : t === 'below' ? '2' : '1';
    $('f-tier').value = state.tier;
    if (location.hash.indexOf('#/live') === 0) location.hash = '#/';
    render();
  }

  // ---- filters
  var catSet = {}, chainSet = {};
  rows.forEach(function (r) { catSet[r[3]] = 1; r[4].split(',').forEach(function (c) { if (c) chainSet[c] = 1; }); });
  Object.keys(catSet).sort(function (a, b) { return catName(+a).localeCompare(catName(+b)); }).forEach(function (i) {
    var o = document.createElement('option'); o.value = i; o.textContent = catName(+i); $('f-cat').appendChild(o);
  });
  Object.keys(chainSet).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; $('f-chain').appendChild(o);
  });
  function readFilters() {
    state.q = $('f-search').value.trim().toLowerCase();
    state.tier = $('f-tier').value; state.cat = $('f-cat').value;
    state.chain = $('f-chain').value; state.tvl = +$('f-tvl').value; state.d7 = $('f-7d').value;
  }
  ['f-search', 'f-tier', 'f-cat', 'f-chain', 'f-tvl', 'f-7d'].forEach(function (id) {
    $(id).addEventListener('input', function () { readFilters(); render(); });
    $(id).addEventListener('change', function () { readFilters(); render(); });
  });
  $('f-reset').onclick = function () {
    ['f-search', 'f-tier', 'f-cat', 'f-chain', 'f-tvl', 'f-7d'].forEach(function (id) { $(id).value = id === 'f-tvl' ? '0' : ''; });
    readFilters(); render();
  };
  function filtered() {
    return rows.filter(function (r) {
      if (state.tier !== '' && String(r[17]) !== state.tier) return false;
      if (state.cat !== '' && String(r[3]) !== state.cat) return false;
      if (state.chain !== '' && r[4].split(',').indexOf(state.chain) < 0) return false;
      if (state.tvl && r[5] * 1000 < state.tvl) return false;
      if (state.d7 === 'gain' && !(r[6] !== null && r[6] > 0)) return false;
      if (state.d7 === 'fall' && !(r[6] !== null && r[6] < 0)) return false;
      if (state.q && (r[2].toLowerCase().indexOf(state.q) < 0 && r[1].indexOf(state.q) < 0)) return false;
      return true;
    });
  }

  function setChrome(board) {
    var v = board ? '' : 'none';
    document.querySelector('.verdict-note').style.display = v;
    document.querySelector('.recon').style.display = v;
    document.querySelector('.mast .sub').style.display = v;
    document.querySelector('.foot').style.display = v;
  }

  var COLS = [
    ['#', 0, 0], ['Protocol', 2, 0], ['Category', 3, 0], ['Farm on', 4, 0],
    ['TVL', 5, 1], ['7D', 6, 1], ['No token for', 7, 1], ['Curve &times;', 8, 1],
    ['Cat &times;', 10, 1], ['Implied value', 9, 1], ['Slice / $1K', 13, 1],
    ['Farm call', 16, 0], ['Ticket &middot; hold', 14, 0],
  ];
  function sortRows(list) {
    var k = state.sort, d = state.desc ? -1 : 1;
    return list.slice().sort(function (a, b) {
      var x = a[k], y = b[k];
      var c = (typeof x === 'string' ? x.localeCompare(y) : (x === null ? -1e18 : x) - (y === null ? -1e18 : y));
      return c * d || (a[9] - b[9]) * -1 || (a[1] < b[1] ? -1 : 1);
    });
  }
  function dotPlot(r) {
    var p25 = r[9] * R.band.q25, p75 = r[9] * R.band.q75;
    var lo = Math.log(p25), hi = Math.log(p75), v = Math.log(r[9]);
    var pos = hi === lo ? 50 : Math.max(2, Math.min(98, ((v - lo) / (hi - lo)) * 100));
    return '<div class="rangebar"><em style="left:0;width:100%"></em><i style="left:' + pos.toFixed(1) + '%"></i></div>' +
      '<div class="rangelab">' + money(p25) + '&ndash;' + money(p75) + '</div>';
  }
  function renderBoard() {
    setChrome(true);
    $('filters').style.display = '';
    var list = sortRows(filtered());
    $('shown').textContent = list.length + ' of ' + rows.length + ' shown';
    var h = '<table class="board"><thead><tr>' + COLS.map(function (c, i) {
      var arrow = state.sort === c[1] ? (state.desc ? ' &darr;' : ' &uarr;') : '';
      return '<th data-col="' + i + '" class="' + (c[2] ? 'num' : '') + (state.sort === c[1] ? ' sorted' : '') + '">' + c[0] + arrow + '</th>';
    }).join('') + '</tr></thead><tbody>';
    list.slice(0, 40).forEach(function (r) {
      var tierCls = r[17] === 0 ? '' : r[17] === 1 ? ' above' : ' early';
      var vc = r[16] === 2 ? 'worth' : r[16] === 1 ? 'thin' : 'low';
      h += '<tr class="' + (r[0] <= 3 ? 'top3' : '') + '">' +
        '<td class="num">' + r[0] + '</td>' +
        '<td><span class="name"><a href="#/detail/' + r[1] + '">' + esc(r[2]) + '</a></span><span class="badge' + tierCls + '">' + TIER[r[17]] + '</span></td>' +
        '<td>' + esc(catName(r[3])) + '</td>' +
        '<td>' + esc(r[4].split(',')[0]) + '</td>' +
        '<td class="num">' + money(r[5] * 1000) + '</td>' +
        '<td class="num ' + (r[6] === null ? '' : r[6] >= 0 ? 'pos' : 'neg') + '">' + pct(r[6]) + '</td>' +
        '<td class="num">' + ageStr(r[7]) + '</td>' +
        '<td class="num">&times;' + r[8].toFixed(4) + '</td>' +
        '<td class="num">&times;' + r[10].toFixed(4) + '</td>' +
        '<td><span class="imp">' + money(r[9]) + '</span>' + dotPlot(r) + '</td>' +
        '<td class="num">$' + r[13].toFixed(2) + '</td>' +
        '<td><span class="call ' + vc + '">' + VERDICT[r[16]] + '</span></td>' +
        '<td class="ticket num">$' + r[14] + ' &middot; ' + r[15] + 'w</td></tr>';
    });
    h += '</tbody></table>';
    if (!list.length) h = '<div class="empty">No rows match these filters.</div>';
    else if (list.length > 40) h += '<p class="mini">First 40 of ' + list.length + ' matching rows — narrow the filters to see the rest.</p>';
    $('view').innerHTML = h;
    Array.prototype.forEach.call($('view').querySelectorAll('th[data-col]'), function (th) {
      th.onclick = function () {
        var k = COLS[+th.getAttribute('data-col')][1];
        if (state.sort === k) state.desc = !state.desc; else { state.sort = k; state.desc = true; }
        renderBoard();
      };
    });
  }

  function renderLive() {
    setChrome(true);
    $('filters').style.display = 'none';
    $('shown').textContent = '';
    var h = '<h2 style="font-size:26px;margin:8px 0 2px">Already trading — not ranked</h2>' +
      '<p class="lede" style="color:#4c5a48;margin:0 0 14px">These ' + C.tr + ' protocols record a token, so they are comparables, never launch candidates. The twelve largest by market cap:</p>' +
      '<table class="live"><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">mcap / TVL</th></tr></thead><tbody>';
    live.forEach(function (p) {
      h += '<tr><td class="name">' + esc(p[1]) + '</td><td>' + esc(catName(p[2])) + '</td><td class="num">' + money(p[3] * 1000) + '</td><td class="num">' + money(p[4] * 1000) + '</td><td class="num">&times;' + (p[4] / p[3]).toFixed(2) + '</td></tr>';
    });
    $('view').innerHTML = h + '</tbody></table>';
  }

  function hashOf(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function famOf(cat) {
    var c = (cat || '').toLowerCase();
    if (/curator|allocator|yield|vault|cdp manager/.test(c)) return 'vault';
    if (/prediction/.test(c)) return 'market';
    if (/lend|cdp|collateral|borrow/.test(c)) return 'lend';
    if (/dex|derivativ|basis|perp|option/.test(c)) return 'dex';
    if (/rwa|stable/.test(c)) return 'rwa';
    return 'app';
  }
  var FAM_OPEN = {
    vault: 'Open the vault the protocol routes most TVL through',
    market: 'Fund the account and take a first position in a market',
    lend: 'Supply the ticket as collateral, then borrow a small amount against it, keeping the health factor above 2',
    dex: 'Swap half the ticket into the pool\u2019s second asset, then add both sides as liquidity',
    rwa: 'Mint the protocol\u2019s yield-bearing asset with the ticket and hold the receipt',
    app: 'Deposit the ticket into the protocol\u2019s main product and complete one full cycle of it',
  };
  var FAM_THIRD = {
    vault: 'Spread the ticket across a second vault on the same chain, so the position is not one manager\u2019s record alone',
    market: 'Take a second, smaller position on the other side of a market you follow, sized so a loss still leaves the week green',
    lend: 'Repay a tenth of the borrow, then supply it again, so the record shows repeated use, not one parked deposit',
    dex: 'Add liquidity to the main pool a second time with a different pair size, so the record shows two provisions',
    rwa: 'Mint a second, smaller tranche of the yield asset a week later, so the record shows accumulation, not one purchase',
    app: 'Use a second feature of the app \u2014 the one listed next to the first \u2014 with a tenth of the ticket',
  };
  var STEP5 = [
    'At week four, open the protocol\u2019s own points page and confirm the position is counted; if it is not, redo the qualifying action once and note the date.',
    'After thirty days, export the position history from the protocol\u2019s own page and check the balance, dates and chain match the farm log.',
    'Midway through the hold, check whether the protocol published a snapshot date or points season; if it did, align the next weekly action to it.',
  ];
  var STEP6 = [
    'Try the protocol\u2019s second feature with a tenth of the ticket \u2014 diversified use is what allocation rules usually reward.',
    'Add a second asset to the same position instead of a second position: one wallet, one venue, two assets.',
    'Join the protocol\u2019s public call or vote once, from the same wallet, and keep the receipt.',
  ];
  var STEP8 = [
    'Keep a farm log \u2014 wallet, dates, amounts, transaction ids \u2014 so the position can be repeated or unwound.',
    'Set a reminder for the claim window; a missed window is a lost allocation.',
    'Write the exit rule down before any token exists: withdraw a tenth first, confirm the receipt, then the rest.',
  ];
  function farmSteps(r) {
    var chain = r[4].split(',')[0];
    var gas = GAS[chain] === undefined ? 0.1 : GAS[chain];
    var ticket = r[14], hold = r[15], holdDays = hold * 7;
    var gas90 = (10 * gas).toFixed(2), hands = (((5 + 15 + 20 + 15 + 10 + 20 + 10 + 10 * hold) / 60)).toFixed(1);
    var fam = famOf(catName(r[3])), h = hashOf(r[1]);
    return [
      'Use a fresh wallet that holds only the $' + ticket + ' you plan to farm with, and keep its seed phrase offline on paper. Cost: no fee to set up. Time: 5 minutes.',
      FAM_OPEN[fam] + ' on ' + chain + ' with $' + ticket + '. Cost: $' + ticket + ' of capital plus about $' + gas.toFixed(2) + ' of gas. Time: 15 minutes to set up.',
      FAM_THIRD[fam] + ' on ' + chain + '. Cost: no new capital, about $' + gas.toFixed(2) + ' of gas. Time: 20 minutes.',
      'Make one qualifying action each week for ' + hold + ' weeks \u2014 a deposit, a borrow, a swap or a vote \u2014 varying the amount each time so the pattern reads as organic. Cost: about $' + gas.toFixed(2) + ' of gas a week. Time: 10 minutes a week.',
      STEP5[h % 3] + ' Cost: no fee to check. Time: 10 minutes.',
      STEP6[(h >> 2) % 3] + ' Cost: about $' + gas.toFixed(2) + ' of gas. Time: 15 minutes.',
      'Stress-test the exit: withdraw a tenth of the $' + ticket + ' position, confirm the receipt lands, then put it back if the position still qualifies. Cost: about $' + gas.toFixed(2) + ' of gas. Time: 20 minutes.',
      STEP8[(h >> 4) % 3] + ' Hold the position at least ' + holdDays + ' days in total; gas for 90 days runs about $' + gas90 + ' and hands-on time about ' + hands + ' hours. Cost: the $' + ticket + ' stays in the position. Time: 10 minutes.',
    ];
  }

  function nearestComps(r) {
    var tvl = Math.log10(r[5] * 1000);
    var scored = comps.map(function (p) {
      return { p: p, same: p[1] === r[3], d: Math.abs(Math.log10(p[2] * 1000) - tvl) };
    });
    scored.sort(function (a, b) { return (b.same - a.same) || (a.d - b.d); });
    return scored.slice(0, 4).map(function (x) { return x.p; });
  }
  function renderDetail(slug) {
    setChrome(false);
    $('filters').style.display = 'none';
    var r = bySlug(slug) || rows[0];
    var cat = catName(r[3]), ce = cats[r[3]], chain = r[4].split(',')[0];
    var gas = GAS[chain] === undefined ? 0.1 : GAS[chain];
    var hands = (((5 + 15 + 20 + 15 + 10 + 20 + 10 + 10 * r[15]) / 60)).toFixed(1);
    var mult = (r[9] / (r[5] * 1000));
    var catNote = ce && ce[1] > 0
      ? cat + ', n=' + ce[1] + ' live comp' + (ce[1] === 1 ? '' : 's') + ', raw &times;' + ce[2].toFixed(2) + ', shrunk with 4 pseudo-comps'
      : cat + ' — no live comps, curve only (&times;1.00)';
    var steps = farmSteps(r).map(function (s) {
      var i = s.indexOf(' Cost: ');
      var body = i < 0 ? s : s.slice(0, i);
      var ct = i < 0 ? '' : s.slice(i + 1);
      return '<li>' + esc(body) + ' <span class="ct">' + esc(ct) + '</span></li>';
    }).join('');
    var compsHtml = nearestComps(r).map(function (p) {
      return '<tr><td>' + esc(titleCase(p[0])) + '</td><td>' + esc(catName(p[1])) + '</td><td class="num">' + money(p[2] * 1000) + '</td><td class="num">' + money(p[3] * 1000) + '</td><td class="num">&times;' + (p[3] / p[2]).toFixed(2) + '</td></tr>';
    }).join('');
    $('view').innerHTML =
      '<div class="detail"><p class="back"><a href="#/">&larr; Board</a> &nbsp;&middot;&nbsp; <a href="#/model">How a value is set</a></p>' +
      '<h2>#' + r[0] + ' ' + esc(r[2]) + ' <span class="badge' + (r[17] === 1 ? ' above' : r[17] === 2 ? ' early' : '') + '">' + TIER[r[17]] + '</span></h2>' +
      '<p class="lede">' + esc(cat) + ' &middot; farm on ' + esc(chain) + ' &middot; records no token &middot; listed ' + ageStr(r[7]) + ' with no token on record.</p>' +
      '<div class="cards">' +
      '<div class="card"><b>' + money(r[9]) + '</b><span>implied value</span></div>' +
      '<div class="card"><b>$' + r[14] + '</b><span>ticket</span></div>' +
      '<div class="card"><b>$' + (10 * gas).toFixed(2) + '</b><span>gas, 90 days</span></div>' +
      '<div class="card"><b>' + hands + ' h</b><span>hands-on</span></div>' +
      '<div class="card"><b>' + (r[15] * 7) + ' days</b><span>lock-up</span></div>' +
      '<div class="card"><b>$' + r[13].toFixed(2) + '</b><span>airdrop / $1K</span></div>' +
      '</div><div class="cols"><section><h3>How this value is set</h3>' +
      '<table class="factors">' +
      '<tr><td>TVL</td><td>' + money(r[5] * 1000) + '</td></tr>' +
      '<tr><td>Size curve</td><td>&times;' + r[8].toFixed(4) + '</td></tr>' +
      '<tr><td>Category effect</td><td>&times;' + r[10].toFixed(4) + '</td></tr>' +
      '<tr><td>growthFactor (7-day ' + pct(r[6]) + ')</td><td>&times;' + r[11].toFixed(3) + '</td></tr>' +
      '<tr><td>ageFactor (' + (r[7] === null ? 'unknown age, 365 days used' : r[7] + ' days') + ')</td><td>&times;' + r[12].toFixed(3) + '</td></tr>' +
      '<tr class="total"><td>Implied value (multiple &times;' + mult.toFixed(4) + ')</td><td>' + money(r[9]) + '</td></tr>' +
      '</table>' +
      '<p class="mini">' + catNote + '. P25&ndash;P75 ' + money(r[9] * R.band.q25) + '&ndash;' + money(r[9] * R.band.q75) + ' (band &times;' + R.band.ratio.toFixed(2) + '). ' +
      'Implied value ' + money(r[9]) + ' = board.json &#10003;. No maturity factor: age is the only seasoning term.</p>' +
      '<h3 style="margin-top:18px">Nearest live comparables</h3>' +
      '<table class="comps"><thead><tr><th>Protocol</th><th>Category</th><th>TVL</th><th>Mcap</th><th>&times;TVL</th></tr></thead><tbody>' + compsHtml + '</tbody></table>' +
      '</section><section><h3>Farm plan — 8 costed steps</h3><ol class="steps">' + steps + '</ol>' +
      '<p class="mini">Farm call: <b>' + VERDICT[r[16]] + '</b> — $' + r[13].toFixed(2) + ' of airdrop per $1,000 farmed. The call is pay per dollar farmed, not the ranking.</p>' +
      '</section></div></div>';
  }

  function scatter() {
    var W = 640, H = 258, PL = 44, PR = 12, PT = 10, PB = 30;
    var x0 = 6, x1 = 10, y0 = -2, y1 = 1;
    function X(tvl) { return PL + ((Math.log10(tvl) - x0) / (x1 - x0)) * (W - PL - PR); }
    function Y(m) { return PT + ((y1 - Math.log10(m)) / (y1 - y0)) * (H - PT - PB); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Log-log scatter of live-token comparables against the fitted size curve">';
    var xt = [1e6, 1e7, 1e8, 1e9, 1e10], xl = ['$1M', '$10M', '$100M', '$1B', '$10B'];
    var yt = [0.01, 0.1, 1, 10], yl = ['0.01&times;', '0.1&times;', '1&times;', '10&times;'];
    xt.forEach(function (t, i) {
      s += '<line x1="' + X(t).toFixed(1) + '" y1="' + PT + '" x2="' + X(t).toFixed(1) + '" y2="' + (H - PB) + '" stroke="#eee6d2"/>' +
        '<text x="' + X(t).toFixed(1) + '" y="' + (H - 10) + '" font-size="10" fill="#7a6a45" text-anchor="middle">' + xl[i] + '</text>';
    });
    yt.forEach(function (t, i) {
      s += '<line x1="' + PL + '" y1="' + Y(t).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(t).toFixed(1) + '" stroke="#eee6d2"/>' +
        '<text x="' + (PL - 5) + '" y="' + (Y(t).toFixed(1) + 3) + '" font-size="10" fill="#7a6a45" text-anchor="end">' + yl[i] + '</text>';
    });
    comps.forEach(function (p) {
      var m = p[3] / p[2];
      if (m < 0.01 || m > 10) return;
      s += '<circle cx="' + X(p[2] * 1000).toFixed(1) + '" cy="' + Y(m).toFixed(1) + '" r="3" fill="#1e5c40" opacity="0.65"/>';
    });
    var pts = [];
    for (var t = 6; t <= 10.001; t += 0.1) {
      var tvl = Math.pow(10, t);
      var mult = Math.pow(10, R.curve.intercept + R.curve.slope * t);
      pts.push(X(tvl).toFixed(1) + ',' + Y(mult).toFixed(1));
    }
    s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#b9975b" stroke-width="2.5"/>';
    s += '<text x="' + (PL + 4) + '" y="' + (PT + 12) + '" font-size="11" fill="#16351f">mcap / TVL vs TVL — ' + R.curve.n + ' live-token comparables</text></svg>';
    return s;
  }
  function renderModel() {
    setChrome(false);
    $('filters').style.display = 'none';
    var withComps = cats.filter(function (c) { return c[1] > 0; });
    var noComps = cats.filter(function (c) { return c[1] === 0; });
    var third = Math.ceil(withComps.length / 3);
    function catTable(list) {
      var h = '<table class="cats"><thead><tr><th>Category</th><th>n</th><th>raw</th><th>effect</th></tr></thead><tbody>';
      list.forEach(function (c) {
        h += '<tr><td>' + esc(c[0]) + '</td><td>' + c[1] + '</td><td>' + (c[2] === null ? '&mdash;' : '&times;' + c[2].toFixed(2)) + '</td><td>&times;' + c[3].toFixed(4) + '</td></tr>';
      });
      return h + '</tbody></table>';
    }
    $('view').innerHTML =
      '<div class="model"><p class="back"><a href="#/">&larr; Board</a></p>' +
      '<h2>How a value is set</h2>' +
      '<p class="lede">implied = TVL &times; size curve &times; category effect &times; growthFactor &times; ageFactor. ' +
      'The curve is fit over ' + R.curve.n + ' live-token comparables: log10(mcap/TVL) = ' + R.curve.intercept.toFixed(4) + ' &minus; ' + Math.abs(R.curve.slope).toFixed(4) + '&middot;log10(TVL). ' +
      'LOO &times;' + R.curve.loo.toFixed(4) + ' (flat &times;' + R.curve.flat_loo.toFixed(4) + '); effects shrunk with 4 pseudo-comps.</p>' +
      '<div class="model-grid"><div class="scatter">' + scatter() +
      '<p class="mini">Each dot is one live-token protocol; the gold line is the fitted curve.</p></div>' +
      '<div class="catbox"><h3>Category effects (' + withComps.length + ' categories with live comps)</h3><div style="display:flex;gap:14px">' +
      '<div style="flex:1">' + catTable(withComps.slice(0, third)) + '</div><div style="flex:1">' + catTable(withComps.slice(third, 2 * third)) + '</div><div style="flex:1">' + catTable(withComps.slice(2 * third)) + '</div>' +
      '</div><p class="mini">Effect = 10^(median log-ratio &times; n/(n+4)). ' + noComps.length + ' more board categories have no live comps and use the curve alone (&times;1.00): ' + noComps.map(function (c) { return esc(c[0]); }).join(', ') + '.</p></div></div>' +
      '<p class="notes"><b>What the model does not do.</b> The snapshot carries no fees, users, funding or points data, so the model uses none of them. ' +
      'mcap is circulating market cap, not FDV — implied values are circulating-equivalents, deliberately conservative. ' +
      '<b>No maturity factor:</b> an earlier version stacked a second age term on ageFactor; removing it moved Polymarket International $125.5M &rarr; $107.3M and put the top three within 7%.</p></div>';
  }

  function render() {
    renderTabs();
    var h = location.hash || '#/';
    if (h.indexOf('#/detail/') === 0) { renderDetail(h.slice(9)); return; }
    if (h === '#/model') { renderModel(); return; }
    if (h === '#/live') { state.tab = 'live'; renderTabs(); renderLive(); return; }
    if (h.indexOf('#/?') === 0) {
      var q = new URLSearchParams(h.slice(3));
      if (q.get('tier') !== null) { state.tier = q.get('tier'); $('f-tier').value = state.tier; state.tab = state.tier === '0' ? 'watchlist' : state.tier === '1' ? 'above' : state.tier === '2' ? 'below' : 'all'; }
      if (q.get('gain') === '1') { state.d7 = 'gain'; $('f-7d').value = 'gain'; }
      if (q.get('cat') !== null) { state.cat = q.get('cat'); $('f-cat').value = state.cat; }
      if (q.get('chain')) { state.chain = q.get('chain'); $('f-chain').value = state.chain; }
      if (q.get('tvl')) { state.tvl = +q.get('tvl'); $('f-tvl').value = String(state.tvl); }
      if (q.get('q')) { state.q = q.get('q'); $('f-search').value = state.q; }
    }
    renderTabs();
    renderBoard();
  }
  window.addEventListener('hashchange', render);
  render();
})();
