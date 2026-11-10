(function () {
  'use strict';

  var D = window.ARCH;
  var NS = 'http://www.w3.org/2000/svg';
  var NODE_H = 52;
  var byId = {};
  var zoneOf = {};
  var zones = {};
  D.zones.forEach(function (z) { zones[z.id] = z; });
  D.nodes.forEach(function (n) {
    var z = zones[n.zone];
    var rows = Math.max.apply(null, D.nodes.filter(function (m) { return m.zone === n.zone; }).map(function (m) { return m.pos[1]; }));
    var pitch = rows ? Math.min(130, (z.h - 60 - NODE_H - 8) / rows) : 0;
    n.w = z.colw;
    n.h = NODE_H;
    n.x = z.x + z.gap + n.pos[0] * (z.colw + z.gap);
    n.y = z.y + 60 + n.pos[1] * pitch;
    byId[n.id] = n;
    zoneOf[n.id] = z;
  });

  function kind(a, b) {
    var za = a.zone;
    var zb = b.zone;
    if (za === 'renderer' && zb === 'renderer') return 'inproc';
    if (za === 'shell' && zb === 'shell') return 'inproc';
    if (za === 'shell' && zb === 'storage' || za === 'storage' && zb === 'shell') return 'disk';
    if (za === 'shell' && zb === 'external' || za === 'external' && zb === 'shell') return 'net';
    return 'ipc';
  }

  var edges = [];
  var edgeKey = {};
  function addEdge(a, b) {
    var k = a + '>' + b;
    var r = b + '>' + a;
    if (edgeKey[k] !== undefined) return edgeKey[k];
    if (edgeKey[r] !== undefined) return edgeKey[r];
    edgeKey[k] = edges.length;
    edges.push({ a: a, b: b, kind: kind(byId[a], byId[b]) });
    return edgeKey[k];
  }
  D.extraEdges.forEach(function (e) { addEdge(e[0], e[1]); });
  D.flows.forEach(function (f) {
    f.steps.forEach(function (s) {
      s.edges = [];
      for (var i = 0; i < s.path.length - 1; i++) s.edges.push(addEdge(s.path[i], s.path[i + 1]));
    });
  });

  function el(name, attrs, text) {
    var e = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function h(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function anchor(n, other) {
    var cx = n.x + n.w / 2;
    var cy = n.y + n.h / 2;
    var ox = other.x + other.w / 2;
    var oy = other.y + other.h / 2;
    var dx = ox - cx;
    var dy = oy - cy;
    if (Math.abs(dx) * n.h > Math.abs(dy) * n.w) {
      return { x: dx > 0 ? n.x + n.w : n.x, y: cy, h: true, s: dx > 0 ? 1 : -1 };
    }
    return { x: cx, y: dy > 0 ? n.y + n.h : n.y, h: false, s: dy > 0 ? 1 : -1 };
  }
  function edgePath(e) {
    var a = byId[e.a];
    var b = byId[e.b];
    var p = anchor(a, b);
    var q = anchor(b, a);
    var k = 40;
    var c1 = p.h ? [p.x + p.s * k, p.y] : [p.x, p.y + p.s * k];
    var c2 = q.h ? [q.x + q.s * k, q.y] : [q.x, q.y + q.s * k];
    return 'M' + p.x + ' ' + p.y + ' C' + c1[0] + ' ' + c1[1] + ' ' + c2[0] + ' ' + c2[1] + ' ' + q.x + ' ' + q.y;
  }

  var svg = document.getElementById('map');
  var nodeEls = {};
  var edgeEls = [];
  var state = { sel: null, hover: null, flow: null, step: 0, zoom: 1, timer: null };

  function build() {
    var W = 1420;
    var H = 700;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var defs = el('defs');
    ['', '-on'].forEach(function (s) {
      var m = el('marker', { id: 'arrow' + s, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
      m.appendChild(el('path', { d: 'M0 0L10 5L0 10z', class: 'arrow' + s }));
      defs.appendChild(m);
    });
    svg.appendChild(defs);

    D.zones.forEach(function (z) {
      var g = el('g', { class: 'zone' + (z.outside ? ' outside' : '') });
      g.style.setProperty('--zc', z.color);
      g.appendChild(el('rect', { x: z.x, y: z.y, width: z.w, height: z.h, rx: 14, class: 'bg' }));
      g.appendChild(el('text', { x: z.x + 14, y: z.y + 26, class: 'ztitle' }, z.title));
      g.appendChild(el('text', { x: z.x + 14, y: z.y + 44, class: 'zblurb' }, z.blurb));
      svg.appendChild(g);
    });

    var eg = el('g', { class: 'edges' });
    edges.forEach(function (e) {
      var p = el('path', { d: edgePath(e), class: 'edge ' + e.kind, 'marker-end': 'url(#arrow)' });
      eg.appendChild(p);
      edgeEls.push(p);
    });
    svg.appendChild(eg);

    D.nodes.forEach(function (n) {
      var g = el('g', { class: 'node', tabindex: '0', role: 'button', 'data-id': n.id, 'aria-label': n.title + '. ' + n.summary });
      g.style.setProperty('--zc', zoneOf[n.id].color);
      g.appendChild(el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 9, class: 'card' }));
      g.appendChild(el('rect', { x: n.x, y: n.y, width: 5, height: n.h, rx: 2, class: 'strip' }));
      g.appendChild(el('text', { x: n.x + 16, y: n.y + 22, class: 'ntitle' }, n.title));
      var code = n.code.length > 30 ? n.code.slice(0, 29) + '…' : n.code;
      g.appendChild(el('text', { x: n.x + 16, y: n.y + 39, class: 'ncode' }, code));
      g.addEventListener('click', function () { select(n.id); });
      g.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n.id); }
        else if (ev.key === 'Escape') select(null);
      });
      g.addEventListener('mouseenter', function () { state.hover = n.id; paint(); });
      g.addEventListener('mouseleave', function () { state.hover = null; paint(); });
      g.addEventListener('focus', function () { state.hover = n.id; paint(); });
      g.addEventListener('blur', function () { state.hover = null; paint(); });
      svg.appendChild(g);
      nodeEls[n.id] = g;
    });
  }

  function flowNodes(f) {
    var s = {};
    f.steps.forEach(function (st) { st.path.forEach(function (i) { s[i] = true; }); });
    return s;
  }
  function flowsOf(id) {
    return D.flows.filter(function (f) { return flowNodes(f)[id]; });
  }
  function neighbours(id) {
    var out = [];
    edges.forEach(function (e) {
      if (e.a === id) out.push(e.b);
      else if (e.b === id) out.push(e.a);
    });
    return out;
  }

  function paint() {
    var focus = state.hover || state.sel;
    var f = state.flow !== null ? D.flows[state.flow] : null;
    var all = f ? flowNodes(f) : null;
    var now = f ? {} : null;
    var onEdges = {};
    var doneEdges = {};
    if (f) {
      f.steps.forEach(function (s, i) {
        if (i === state.step) {
          s.path.forEach(function (n) { now[n] = true; });
          s.edges.forEach(function (e) { onEdges[e] = true; });
        } else if (i < state.step) s.edges.forEach(function (e) { doneEdges[e] = true; });
      });
    }
    var nb = focus ? neighbours(focus) : [];
    Object.keys(nodeEls).forEach(function (id) {
      var c = nodeEls[id].classList;
      c.toggle('sel', id === state.sel);
      c.toggle('now', !!(now && now[id]));
      c.toggle('dim', !!((all && !all[id]) || (!all && focus && id !== focus && nb.indexOf(id) < 0)));
    });
    edgeEls.forEach(function (p, i) {
      var e = edges[i];
      var linked = focus && (e.a === focus || e.b === focus);
      var on = !!onEdges[i] || (!f && linked);
      p.classList.toggle('on', on);
      p.classList.toggle('done', !!doneEdges[i]);
      p.classList.toggle('flowing', !!onEdges[i]);
      p.classList.toggle('dim', !!(f && !onEdges[i] && !doneEdges[i]) || !!(!f && focus && !linked));
      p.setAttribute('marker-end', on ? 'url(#arrow-on)' : 'url(#arrow)');
    });
    flowSelect.value = f ? String(state.flow) : '';
    var stepper = document.getElementById('stepper');
    stepper.hidden = !f;
    if (f) {
      document.getElementById('step-count').textContent = 'Step ' + (state.step + 1) + ' of ' + f.steps.length;
      document.getElementById('step-text').textContent = f.steps[state.step].text;
      document.getElementById('prev').disabled = state.step === 0;
      document.getElementById('next').disabled = state.step === f.steps.length - 1;
    }
    document.getElementById('play').textContent = state.timer ? 'Pause' : 'Play';
    document.getElementById('play').setAttribute('aria-pressed', String(!!state.timer));
  }

  function chip(id) {
    var b = h('button', { type: 'button', class: 'chip' }, byId[id].title);
    b.addEventListener('click', function () { select(id); });
    return b;
  }

  function detail() {
    var box = document.getElementById('detail');
    box.textContent = '';
    var n = state.sel ? byId[state.sel] : null;
    if (!n) {
      box.appendChild(h('p', { class: 'muted' }, 'Click a component to see what it does. Pick a flow above to follow one task through the system.'));
      return;
    }
    var z = zoneOf[n.id];
    box.appendChild(h('p', { class: 'eyebrow' }, z.title));
    box.appendChild(h('h2', {}, n.title));
    box.appendChild(h('p', { class: 'code' }, n.code));
    box.appendChild(h('p', {}, n.summary));
    var ul = h('ul');
    n.details.forEach(function (t) { ul.appendChild(h('li', {}, t)); });
    box.appendChild(ul);
    var nb = neighbours(n.id);
    if (nb.length) {
      box.appendChild(h('h3', {}, 'Connected to'));
      var row = h('div', { class: 'chips' });
      nb.forEach(function (i) { row.appendChild(chip(i)); });
      box.appendChild(row);
    }
    var fl = flowsOf(n.id);
    if (fl.length) {
      box.appendChild(h('h3', {}, 'Appears in flows'));
      var r2 = h('div', { class: 'chips' });
      fl.forEach(function (f) {
        var b = h('button', { type: 'button', class: 'chip' }, f.title);
        b.addEventListener('click', function () { setFlow(D.flows.indexOf(f)); });
        r2.appendChild(b);
      });
      box.appendChild(r2);
    }
    if (n.files.length) {
      box.appendChild(h('h3', {}, 'Source'));
      var fu = h('ul', { class: 'files' });
      n.files.forEach(function (p) {
        var li = h('li');
        li.appendChild(h('a', { href: D.repo + p }, p));
        fu.appendChild(li);
      });
      box.appendChild(fu);
    }
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function select(id) {
    stop();
    state.sel = id;
    history.replaceState(null, '', id ? '#' + id : location.pathname + location.search);
    detail();
    paint();
  }

  function setFlow(i) {
    stop();
    state.flow = i;
    state.step = 0;
    if (state.flow !== null) { state.sel = null; detail(); history.replaceState(null, '', '#flow-' + D.flows[state.flow].id); }
    else history.replaceState(null, '', location.pathname + location.search);
    paint();
  }

  function step(d) {
    var f = D.flows[state.flow];
    state.step = Math.max(0, Math.min(f.steps.length - 1, state.step + d));
    paint();
  }

  function play() {
    if (state.timer) { stop(); paint(); return; }
    if (state.flow === null) state.flow = 0;
    var f = D.flows[state.flow];
    if (state.step >= f.steps.length - 1) state.step = 0;
    state.timer = setInterval(function () {
      if (state.step >= f.steps.length - 1) { stop(); paint(); return; }
      state.step += 1;
      paint();
    }, 3500);
    paint();
  }

  function zoom(f) {
    state.zoom = f ? Math.max(0.6, Math.min(2.5, state.zoom * f)) : 1;
    svg.style.width = state.zoom * 100 + '%';
  }

  var flowSelect;
  function init() {
    build();
    flowSelect = document.getElementById('flows');
    flowSelect.appendChild(h('option', { value: '' }, 'None (overview)'));
    D.flows.forEach(function (f, i) {
      flowSelect.appendChild(h('option', { value: String(i) }, f.title + ' - ' + f.text));
    });
    flowSelect.addEventListener('change', function () { setFlow(flowSelect.value === '' ? null : Number(flowSelect.value)); });
    document.getElementById('prev').addEventListener('click', function () { stop(); step(-1); });
    document.getElementById('next').addEventListener('click', function () { stop(); step(1); });
    document.getElementById('play').addEventListener('click', play);
    document.getElementById('zin').addEventListener('click', function () { zoom(1.2); });
    document.getElementById('zout').addEventListener('click', function () { zoom(1 / 1.2); });
    document.getElementById('zfit').addEventListener('click', function () { zoom(0); });

    var q = document.getElementById('search');
    var res = document.getElementById('results');
    q.addEventListener('input', function () {
      var t = q.value.trim().toLowerCase();
      res.textContent = '';
      if (!t) return;
      D.nodes.filter(function (n) {
        return (n.title + ' ' + n.code + ' ' + n.summary).toLowerCase().indexOf(t) >= 0;
      }).slice(0, 8).forEach(function (n) {
        var li = h('li');
        var b = h('button', { type: 'button' }, n.title);
        b.addEventListener('click', function () { select(n.id); q.value = ''; res.textContent = ''; nodeEls[n.id].focus(); });
        li.appendChild(b);
        res.appendChild(li);
      });
    });
    document.addEventListener('keydown', function (ev) {
      var tag = ev.target.tagName;
      if (ev.key === '/' && tag !== 'INPUT') { ev.preventDefault(); q.focus(); }
      else if (ev.key === 'Escape' && state.flow !== null && tag !== 'INPUT' && tag !== 'SELECT') setFlow(null);
    });

    var gl = document.getElementById('glossary');
    D.glossary.forEach(function (g) {
      gl.appendChild(h('dt', {}, g[0]));
      gl.appendChild(h('dd', {}, g[1]));
    });

    var hash = decodeURIComponent(location.hash.slice(1));
    if (hash.indexOf('flow-') === 0) {
      var i = D.flows.map(function (f) { return f.id; }).indexOf(hash.slice(5));
      if (i >= 0) { state.flow = i; }
    } else if (byId[hash]) state.sel = hash;
    detail();
    paint();
  }

  init();
})();
