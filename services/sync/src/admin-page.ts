// The admin dashboard page: one self-contained document. It builds everything with textContent (never innerHTML), so a
// hostile value in a table cannot run as script. The look follows the desktop app's dark theme.

export const ADMIN_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>IMC-Mail sync admin</title>
<style>
  :root { color-scheme: dark; --ground:#0d0f12; --rail:#13161a; --sheet:#171a1f; --raised:#1d2128; --line:#2a2f37; --line2:#667180; --ink:#e8ebef; --ink2:#b5bcc6; --ink3:#8f97a3; --accent:#7d9fff; --on:#0a1020; --alert:#ff7a70; --attn:#f2c230; --ok:#4cc38a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ground); color:var(--ink); font:14px/1.45 system-ui, "Segoe UI", sans-serif; }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:14px 20px; background:var(--rail); border-bottom:1px solid var(--line); }
  header h1 { font-size:16px; margin:0; font-weight:600; flex:1; min-width:200px; }
  main { padding:20px; max-width:1200px; margin:0 auto; display:grid; gap:20px; }
  button { font:inherit; color:var(--ink); background:transparent; border:1px solid var(--line2); border-radius:4px; padding:6px 12px; cursor:pointer; }
  button:hover { background:var(--raised); }
  button.primary { background:var(--accent); color:var(--on); border-color:var(--accent); font-weight:600; }
  button.danger { border-color:var(--alert); color:var(--alert); }
  button:disabled { opacity:.5; cursor:default; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .tile { background:var(--sheet); border:1px solid var(--line); border-radius:4px; padding:12px; }
  .tile b { display:block; font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; }
  .tile span { color:var(--ink3); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .panel { background:var(--sheet); border:1px solid var(--line); border-radius:4px; padding:14px; }
  .panel h2 { font-size:12px; margin:0 0 10px; color:var(--ink3); text-transform:uppercase; letter-spacing:.08em; font-weight:600; }
  .chart { display:flex; align-items:flex-end; gap:2px; height:90px; }
  .chart i { flex:1; background:var(--accent); min-height:1px; position:relative; border-radius:1px 1px 0 0; }
  .chart i u { position:absolute; left:0; right:0; bottom:0; background:var(--alert); text-decoration:none; }
  .tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin-bottom:10px; }
  .tabs button { border:0; border-bottom:2px solid transparent; border-radius:0; color:var(--ink3); }
  .tabs button.on { color:var(--ink); border-bottom-color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th { text-align:left; color:var(--ink3); font-weight:500; font-size:12px; padding:6px 8px; border-bottom:1px solid var(--line); }
  td { padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:middle; }
  td.r, th.r { text-align:right; }
  code { font-family:ui-monospace, Consolas, monospace; font-size:12px; color:var(--ink2); }
  .muted { color:var(--ink3); }
  .bad { color:var(--alert); } .ok { color:var(--ok); } .warn { color:var(--attn); }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:10px; }
  input { font:inherit; color:var(--ink); background:var(--ground); border:1px solid var(--line2); border-radius:4px; padding:6px 10px; }
  #login { position:fixed; inset:0; background:var(--ground); display:none; place-items:center; z-index:10; }
  #login form { background:var(--sheet); border:1px solid var(--line); border-radius:6px; padding:24px; width:min(92vw,380px); display:grid; gap:12px; }
  #login h1 { margin:0; font-size:16px; }
  #msg { min-height:1.4em; }
  .scroll { overflow-x:auto; }
</style>
</head>
<body>
<div id="login"><form id="loginForm"><h1>IMC-Mail sync admin</h1><label class="muted">Admin token<input id="token" type="password" autocomplete="off" style="width:100%;margin-top:6px"></label><button class="primary" type="submit">Open</button><div id="loginErr" class="bad"></div></form></div>
<header>
  <h1>IMC-Mail sync admin <span id="up" class="muted"></span></h1>
  <span id="signups"></span>
  <button id="toggleSignups">Close signups</button>
  <button id="restart" class="danger">Restart server</button>
  <button id="signout">Sign out</button>
</header>
<main>
  <div id="msg" class="muted"></div>
  <section class="tiles" id="tiles"></section>
  <section class="panel"><h2>Requests, last hour <span id="chartNote" class="muted"></span></h2><div class="chart" id="chart"></div></section>
  <section class="panel">
    <div class="tabs" id="tabs"></div>
    <div id="view"></div>
  </section>
</main>
<script>
(function () {
  var TABS = ['Groups', 'Addresses', 'Banned', 'Events'];
  var tab = 'Groups';
  var token = sessionStorage.getItem('imcAdminToken') || '';
  var timer = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function when(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function dur(ms) {
    var s = Math.round(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return (d ? d + 'd ' : '') + (h || d ? h + 'h ' : '') + m + 'm';
  }
  function size(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'; }
  function num(n) { return Number(n).toLocaleString(); }
  function note(text, bad) { var m = $('msg'); m.textContent = text || ''; m.className = bad ? 'bad' : 'muted'; }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401) { showLogin('That token was not accepted.'); throw new Error('signed out'); }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('Error ' + r.status)); return j; });
    });
  }
  function showLogin(err) {
    clearInterval(timer);
    sessionStorage.removeItem('imcAdminToken');
    token = '';
    $('login').style.display = 'grid';
    $('loginErr').textContent = err || '';
    $('token').focus();
  }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    token = $('token').value.trim();
    $('token').value = '';
    api('GET', '/api/overview').then(function () {
      sessionStorage.setItem('imcAdminToken', token);
      $('login').style.display = 'none';
      start();
    }).catch(function () {});
  });
  $('signout').addEventListener('click', function () { showLogin(''); });

  function tile(label, value, cls) { return el('div', { class: 'tile' }, [el('b', { text: value, class: cls || '' }), el('span', { text: label })]); }

  function drawOverview(o) {
    $('up').textContent = 'up ' + dur(o.now - o.startedAt) + ' · node ' + o.node;
    $('signups').textContent = o.signupsClosed ? 'New signups are closed' : 'New signups are open';
    $('signups').className = o.signupsClosed ? 'warn' : 'ok';
    $('toggleSignups').textContent = o.signupsClosed ? 'Open signups' : 'Close signups';
    $('toggleSignups').dataset.closed = o.signupsClosed ? '1' : '';
    var req = 0, err = 0, lim = 0, unauth = 0, banned = 0;
    o.minutes.forEach(function (m) { req += m.requests; err += m.errors; lim += m.limited; unauth += m.unauthorized; banned += m.banned; });
    var t = $('tiles'); t.textContent = '';
    [
      tile('Groups', num(o.totals.groups) + ' / ' + num(o.limits.maxGroups)),
      tile('Devices', num(o.totals.devices)),
      tile('Records', num(o.totals.records)),
      tile('Deletion records', num(o.totals.deletions)),
      tile('Database', size(o.totals.bytes)),
      tile('Requests (1 h)', num(req)),
      tile('Server errors', num(err), err ? 'bad' : ''),
      tile('Rate limited', num(lim), lim ? 'warn' : ''),
      tile('Not signed in', num(unauth), unauth > 50 ? 'warn' : ''),
      tile('Banned tries', num(banned))
    ].forEach(function (x) { t.appendChild(x); });
    var max = Math.max.apply(null, o.minutes.map(function (m) { return m.requests; }).concat([1]));
    var c = $('chart'); c.textContent = '';
    o.minutes.forEach(function (m) {
      var bar = el('i', { title: new Date(m.at).toLocaleTimeString() + ': ' + m.requests + ' requests' });
      bar.style.height = Math.max(1, Math.round((m.requests / max) * 100)) + '%';
      if (m.errors) { var u = el('u'); u.style.height = Math.round((m.errors / m.requests) * 100) + '%'; bar.appendChild(u); }
      c.appendChild(bar);
    });
    $('chartNote').textContent = '(busiest minute: ' + max + ')';
  }

  function table(head, rows) {
    var thead = el('thead', null, [el('tr', null, head.map(function (h) { return el('th', { text: h.text, class: h.r ? 'r' : '' }); }))]);
    var tbody = el('tbody', null, rows);
    return el('div', { class: 'scroll' }, [el('table', null, [thead, tbody])]);
  }
  function empty(text) { return el('p', { class: 'muted', text: text }); }

  function banButton(ip) {
    return el('button', { class: 'danger', text: 'Ban', onclick: function () {
      var why = prompt('Ban ' + ip + '? Optional note:', '');
      if (why === null) return;
      api('POST', '/api/bans', { ip: ip, reason: why }).then(function () { note('Banned ' + ip); refresh(); }).catch(function (e) { note(e.message, true); });
    } });
  }

  var views = {
    Groups: function () {
      return api('GET', '/api/groups').then(function (r) {
        var box = el('div');
        var row = el('div', { class: 'row' });
        var days = el('input', { type: 'number', min: '1', value: '90', style: 'width:80px' });
        row.appendChild(el('span', { class: 'muted', text: 'Delete groups no device has used for' }));
        row.appendChild(days);
        row.appendChild(el('span', { class: 'muted', text: 'days' }));
        row.appendChild(el('button', { class: 'danger', text: 'Delete unused groups', onclick: function () {
          var d = Number(days.value);
          if (!confirm('Delete every group that no device has used for ' + d + ' days? This cannot be undone.')) return;
          api('POST', '/api/groups/prune', { days: d }).then(function (x) { note('Deleted ' + x.removed + ' groups'); refresh(); }).catch(function (e) { note(e.message, true); });
        } }));
        box.appendChild(row);
        if (!r.groups.length) { box.appendChild(empty('No groups yet.')); return box; }
        box.appendChild(table([{ text: 'Group' }, { text: 'Devices', r: 1 }, { text: 'Records', r: 1 }, { text: 'Size', r: 1 }, { text: 'Created' }, { text: 'Last used' }, { text: '' }], r.groups.map(function (g) {
          return el('tr', null, [
            el('td', null, [el('code', { text: g.id.slice(0, 10) + '…' })]),
            el('td', { class: 'r', text: String(g.devices) }),
            el('td', { class: 'r', text: num(g.records) }),
            el('td', { class: 'r', text: size(g.payloadBytes) }),
            el('td', { text: when(g.createdAt) }),
            el('td', { text: when(g.lastSeen) }),
            el('td', { class: 'r' }, [el('button', { class: 'danger', text: 'Delete', onclick: function () {
              if (!confirm('Delete this group and everything stored for it? Its devices will stop syncing. This cannot be undone.')) return;
              api('DELETE', '/api/groups/' + g.id).then(function () { note('Group deleted'); refresh(); }).catch(function (e) { note(e.message, true); });
            } })])
          ]);
        })));
        return box;
      });
    },
    Addresses: function () {
      return api('GET', '/api/ips').then(function (r) {
        if (!r.ips.length) return empty('No requests since the server started.');
        return table([{ text: 'Address' }, { text: 'Requests', r: 1 }, { text: 'Refused', r: 1 }, { text: 'Last seen' }, { text: '' }], r.ips.map(function (s) {
          return el('tr', null, [
            el('td', null, [el('code', { text: s.ip })]),
            el('td', { class: 'r', text: num(s.requests) }),
            el('td', { class: 'r ' + (s.refused ? 'warn' : ''), text: num(s.refused) }),
            el('td', { text: when(s.lastSeen) }),
            el('td', { class: 'r' }, [s.banned ? el('span', { class: 'bad', text: 'banned' }) : banButton(s.ip)])
          ]);
        }));
      });
    },
    Banned: function () {
      return api('GET', '/api/bans').then(function (r) {
        var box = el('div');
        var row = el('div', { class: 'row' });
        var ip = el('input', { placeholder: 'IP address to ban', style: 'width:220px' });
        var why = el('input', { placeholder: 'Note (optional)', style: 'width:240px' });
        row.appendChild(ip); row.appendChild(why);
        row.appendChild(el('button', { class: 'danger', text: 'Ban address', onclick: function () {
          api('POST', '/api/bans', { ip: ip.value, reason: why.value }).then(function () { note('Banned ' + ip.value); refresh(); }).catch(function (e) { note(e.message, true); });
        } }));
        box.appendChild(row);
        if (!r.bans.length) { box.appendChild(empty('No banned addresses.')); return box; }
        box.appendChild(table([{ text: 'Address' }, { text: 'Note' }, { text: 'Banned' }, { text: '' }], r.bans.map(function (b) {
          return el('tr', null, [
            el('td', null, [el('code', { text: b.ip })]),
            el('td', { text: b.reason }),
            el('td', { text: when(b.createdAt) }),
            el('td', { class: 'r' }, [el('button', { text: 'Unban', onclick: function () {
              api('DELETE', '/api/bans/' + encodeURIComponent(b.ip)).then(function () { note('Unbanned ' + b.ip); refresh(); }).catch(function (e) { note(e.message, true); });
            } })])
          ]);
        })));
        return box;
      });
    },
    Events: function () {
      return api('GET', '/api/events').then(function (r) {
        if (!r.events.length) return empty('Nothing has happened since the server started.');
        return table([{ text: 'When' }, { text: 'What' }, { text: 'Address' }, { text: 'Detail' }], r.events.map(function (e) {
          return el('tr', null, [el('td', { text: when(e.at) }), el('td', { text: e.kind }), el('td', null, [el('code', { text: e.ip })]), el('td', { text: e.detail })]);
        }));
      });
    }
  };

  function drawTabs() {
    var t = $('tabs'); t.textContent = '';
    TABS.forEach(function (name) {
      t.appendChild(el('button', { class: name === tab ? 'on' : '', text: name, onclick: function () { tab = name; drawTabs(); refresh(); } }));
    });
  }

  var busy = false;
  function refresh() {
    if (busy || !token) return;
    busy = true;
    api('GET', '/api/overview').then(drawOverview)
      .then(function () { return views[tab](); })
      .then(function (node) { var v = $('view'); v.textContent = ''; v.appendChild(node); })
      .catch(function (e) { if (e.message !== 'signed out') note(e.message, true); })
      .then(function () { busy = false; }, function () { busy = false; });
  }

  $('toggleSignups').addEventListener('click', function () {
    var closing = !$('toggleSignups').dataset.closed;
    api('POST', '/api/signups', { closed: closing }).then(function () { note(closing ? 'New signups are closed' : 'New signups are open'); refresh(); }).catch(function (e) { note(e.message, true); });
  });
  $('restart').addEventListener('click', function () {
    if (!confirm('Restart the sync server? Devices will retry on their own within a few minutes.')) return;
    api('POST', '/api/restart').then(function () {
      note('Restarting… the page will reconnect.');
      setTimeout(refresh, 4000);
    }).catch(function (e) { note(e.message, true); });
  });

  function start() { drawTabs(); refresh(); clearInterval(timer); timer = setInterval(function () { if (!document.hidden) refresh(); }, 5000); }
  if (token) { $('login').style.display = 'none'; start(); } else showLogin('');
})();
</script>
</body>
</html>
`
