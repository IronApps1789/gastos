/* Gastos — app del móvil. Habla con el script de Google (Apps Script). */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem(k); } catch { } }
};

const CATS_DEF = ['Supermercado', 'Restaurantes y café', 'Transporte', 'Casa y servicios', 'Salud', 'Ocio', 'Ropa', 'Otros'];
const EMOJI = {
  'Supermercado': '🛒', 'Restaurantes y café': '☕', 'Transporte': '🚆', 'Casa y servicios': '🏠',
  'Salud': '💊', 'Ocio': '🎟️', 'Ropa': '👕', 'Otros': '📦'
};

let cfg = LS.get('gastos.cfg', null);              // { url, key }
let meta = LS.get('gastos.meta', { base: 'EUR', categorias: CATS_DEF, hoja: '' });
const state = { mes: mesActual(), data: null, pendientes: [] };

// ---------- utilidades de formato ----------
function mesActual() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function hoyStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dinero(n, moneda) {
  if (n == null || isNaN(n)) return '—';
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: moneda, minimumFractionDigits: 2 }).format(n);
  } catch { return n.toFixed(2) + ' ' + moneda; }
}
function nombreMes(mes) {
  const [y, m] = mes.split('-').map(Number);
  const s = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
  return s.charAt(0).toUpperCase() + s.slice(1).replace(' de ', ' ');
}
function sumarMes(mes, delta) {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function diaPartes(fecha) {
  const d = new Date(fecha + 'T12:00:00');
  return {
    dia: d.getDate(),
    mes: new Intl.DateTimeFormat('es-ES', { month: 'short' }).format(d).replace('.', '')
  };
}
function uid() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
function parseImporte(v) {
  let s = String(v || '').replace(/[^\d.,]/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else s = s.replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
function colorCat(cat) {
  const i = (meta.categorias || CATS_DEF).indexOf(cat);
  return `var(--c${(i < 0 ? 7 : i % 8) + 1})`;
}

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- comunicación con el script ----------
async function api(action, data = {}, { timeout = 30000 } = {}) {
  if (!cfg) { const e = new Error('App sin configurar'); e.code = 'auth'; throw e; }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      // text/plain evita la comprobación previa (CORS) que Apps Script no admite
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...data, action, key: cfg.key }),
      signal: ctrl.signal,
      redirect: 'follow'
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'El servidor tardó demasiado' : 'Sin conexión');
    err.network = true;
    throw err;
  } finally {
    clearTimeout(t);
  }
  let j;
  try { j = await res.json(); } catch {
    throw new Error('Respuesta inesperada. Revisa la URL y que el acceso sea “Cualquier usuario”.');
  }
  if (!j.ok) { const err = new Error(j.error || 'Error'); err.code = j.code; throw err; }
  return j;
}

// ---------- cola sin conexión (IndexedDB) ----------
const outbox = {
  _db: null,
  open() {
    if (this._db) return this._db;
    this._db = new Promise((res, rej) => {
      const r = indexedDB.open('gastos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this._db;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('outbox', mode);
      const req = fn(tx.objectStore('outbox'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  },
  add(item) { return this.run('readwrite', (s) => s.put(item)); },
  all() { return this.run('readonly', (s) => s.getAll()).catch(() => []); },
  del(id) { return this.run('readwrite', (s) => s.delete(id)); }
};

let enviando = false;
async function enviarPendientes() {
  if (enviando || !cfg || !navigator.onLine) return;
  enviando = true;
  let ok = 0;
  try {
    for (const it of await outbox.all()) {
      try {
        await api(it.action, it.payload, { timeout: it.action === 'receipt' ? 120000 : 30000 });
        await outbox.del(it.id);
        ok++;
      } catch (e) {
        if (e.network || e.code === 'auth') break;
        await outbox.del(it.id);
        toast('Un gasto pendiente no se pudo registrar: ' + e.message, 5000);
      }
    }
  } finally {
    enviando = false;
  }
  state.pendientes = await outbox.all();
  if (ok) {
    toast(ok === 1 ? 'Gasto pendiente enviado' : `${ok} gastos pendientes enviados`);
    cargar();
  } else {
    pintar();
  }
}

async function refrescarPendientes() {
  state.pendientes = await outbox.all();
  pintar();
}

/** Envía; si no hay conexión lo guarda en la cola y devuelve null. */
async function enviarOEncolar(action, payload, timeout) {
  try {
    return await api(action, payload, { timeout });
  } catch (e) {
    if (!e.network) throw e;
    await outbox.add({ id: payload.id, action, payload, creado: Date.now() });
    await refrescarPendientes();
    return null;
  }
}

// ---------- pantalla principal ----------
async function cargar(mes) {
  if (mes) state.mes = mes;
  const cache = LS.get('gastos.cache.' + state.mes, null);
  if (cache) { state.data = cache; }
  else if (!state.data || state.data.mes !== state.mes) { state.data = null; }
  pintar();
  try {
    const j = await api('summary', { mes: state.mes });
    if (j.mes !== state.mes) return; // cambió de mes mientras cargaba
    state.data = j;
    if (j.categorias) { meta.categorias = j.categorias; meta.base = j.base; LS.set('gastos.meta', meta); }
    LS.set('gastos.cache.' + j.mes, j);
    pintar();
  } catch (e) {
    if (e.code === 'auth') return mostrarSetup(e.message);
    if (!e.network) toast(e.message, 4000);
  }
}

function pintar() {
  const d = state.data;
  const base = meta.base || 'EUR';
  $('#mesLabel').textContent = nombreMes(state.mes);
  $('#next').disabled = state.mes >= mesActual();
  $('.eyebrow').textContent = state.mes === mesActual() ? 'Gastado este mes' : 'Gastado en el mes';

  if (!d) {
    $('#total').textContent = '…';
    $('#sub').textContent = 'Cargando';
    $('#bar').innerHTML = '';
    $('#legend').innerHTML = '';
    $('#lista').innerHTML = '';
    return;
  }

  $('#total').textContent = dinero(d.total, base);
  const n = d.movimientos.length;
  let sub = n === 0 ? 'Sin gastos todavía' : n === 1 ? '1 gasto' : `${n} gastos`;
  $('#sub').innerHTML = esc(sub) +
    (d.revisar ? ` · <span class="revisar">${d.revisar} por revisar</span>` : '');

  const total = d.total || 0;
  $('#bar').innerHTML = total > 0 ? d.porCategoria.map((c) =>
    `<span style="flex:${c.total};background:${colorCat(c.categoria)}"></span>`).join('') : '';
  $('#legend').innerHTML = d.porCategoria.map((c) => `
    <li><i style="background:${colorCat(c.categoria)}"></i>${esc(c.categoria)}
      <span class="n">${dinero(c.total, base)}</span>
      <span class="p">${total ? Math.round(c.total / total * 100) : 0}%</span></li>`).join('');

  const pend = state.mes === mesActual() ? state.pendientes : [];
  const filasPend = pend.map((p) => {
    const g = p.payload;
    const esTicket = p.action === 'receipt';
    const dp = diaPartes(g.fecha || hoyStr());
    return `<li><button type="button" data-pend="${esc(p.id)}">
      <span class="dia"><b>${dp.dia}</b><small>${esc(dp.mes)}</small></span>
      <span class="que"><strong>${esTicket ? 'Ticket (foto)' : esc(g.comercio || g.categoria)}</strong>
        <small><span class="tag pend">Pendiente de envío</span></small></span>
      <span class="cuanto"><b>${esTicket ? '—' : dinero(parseImporte(g.importe), g.moneda)}</b></span>
    </button></li>`;
  });

  const filas = d.movimientos.map((g) => {
    const dp = diaPartes(g.fecha);
    const revisar = /^Revisar/.test(g.estado);
    const otraMoneda = g.moneda !== base && g.importe != null;
    return `<li><button type="button" data-id="${esc(g.id)}">
      <span class="dia"><b>${dp.dia}</b><small>${esc(dp.mes)}</small></span>
      <span class="que"><strong>${esc(g.comercio || g.nota || g.categoria)}</strong>
        <small>${EMOJI[g.categoria] || '•'} ${esc(g.categoria)}${g.origen === 'Ticket' ? ' · 🧾' : ''}
        ${revisar ? '<span class="tag">Revisar</span>' : ''}</small></span>
      <span class="cuanto"><b>${dinero(g.base, base)}</b>${otraMoneda ? `<small>${dinero(g.importe, g.moneda)}</small>` : ''}</span>
    </button></li>`;
  });

  const todas = filasPend.concat(filas);
  $('#lista').innerHTML = todas.length ? todas.join('')
    : '<li class="vacio">Haz una foto a tu primer ticket<br>o añade un gasto sin ticket.</li>';
}

// ---------- hoja inferior ----------
function abrirHoja(html) {
  $('#sheet').innerHTML = html;
  $('#sheetWrap').hidden = false;
  document.body.style.overflow = 'hidden';
  return $('#sheet');
}
function cerrarHoja() {
  $('#sheetWrap').hidden = true;
  $('#sheet').innerHTML = '';
  document.body.style.overflow = '';
}

// ---------- formulario de gasto (nuevo / editar) ----------
function monedasRecientes(actual) {
  const base = meta.base || 'EUR';
  const lista = [base, 'SEK', ...LS.get('gastos.monedas', [])];
  if (actual) lista.push(actual);
  return [...new Set(lista)].slice(0, 6);
}

function formularioGasto(g, modo) {
  const moneda = g.moneda || LS.get('gastos.moneda', 'SEK');
  const cats = meta.categorias || CATS_DEF;
  const titulo = modo === 'nuevo' ? 'Gasto sin ticket' : 'Editar gasto';
  return `
  <h3>${titulo}</h3>
  ${g.estado && /^Revisar/.test(g.estado) ? `<p class="aviso">${esc(g.estado)}</p>` : ''}
  <form id="fGasto" autocomplete="off">
    <div class="importe">
      <input name="importe" inputmode="decimal" placeholder="0,00" required
        value="${g.importe != null ? String(g.importe).replace('.', ',') : ''}" aria-label="Importe">
      <span id="monedaVista">${esc(moneda)}</span>
    </div>
    <label>Moneda</label>
    <div class="chips" id="chipsMoneda">
      ${monedasRecientes(moneda).map((m) =>
        `<button type="button" class="chip mono" data-moneda="${m}" aria-pressed="${m === moneda}">${m}</button>`).join('')}
      <input class="otra" id="otraMoneda" maxlength="3" placeholder="Otra" aria-label="Otra moneda (código de 3 letras)">
    </div>
    <label>Categoría</label>
    <div class="chips" id="chipsCat">
      ${cats.map((c) => `<button type="button" class="chip" data-cat="${esc(c)}"
        aria-pressed="${c === (g.categoria || '')}">${EMOJI[c] || '•'} ${esc(c)}</button>`).join('')}
    </div>
    <div class="fila2">
      <label>Fecha<input type="date" name="fecha" value="${esc(g.fecha || hoyStr())}" max="${hoyStr()}"></label>
      <label>Dónde<input name="comercio" value="${esc(g.comercio || '')}" placeholder="Opcional"></label>
    </div>
    <label>Nota<input name="nota" value="${esc(g.nota || '')}" placeholder="Opcional"></label>
    ${g.ticket ? `<a class="enlace" href="${esc(g.ticket)}" target="_blank" rel="noopener">Ver foto del ticket ↗</a>` : ''}
    <div class="botones">
      ${modo === 'editar' ? '<button type="button" class="btn danger" id="borrar">Borrar</button>' : ''}
      <button type="submit" class="btn primary">Guardar</button>
    </div>
    <p class="error" id="fError" role="alert"></p>
  </form>`;
}

function montarFormulario(g, modo) {
  const hoja = abrirHoja(formularioGasto(g, modo));
  const f = $('#fGasto', hoja);
  let moneda = g.moneda || LS.get('gastos.moneda', 'SEK');
  let categoria = g.categoria || '';

  $('#chipsMoneda', hoja).addEventListener('click', (e) => {
    const b = e.target.closest('[data-moneda]');
    if (!b) return;
    moneda = b.dataset.moneda;
    $('#otraMoneda', hoja).value = '';
    hoja.querySelectorAll('[data-moneda]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    $('#monedaVista', hoja).textContent = moneda;
  });
  $('#otraMoneda', hoja).addEventListener('input', (e) => {
    const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
    e.target.value = v;
    if (v.length === 3) {
      moneda = v;
      hoja.querySelectorAll('[data-moneda]').forEach((x) => x.setAttribute('aria-pressed', false));
      $('#monedaVista', hoja).textContent = v;
    }
  });
  $('#chipsCat', hoja).addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    categoria = b.dataset.cat;
    hoja.querySelectorAll('[data-cat]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  });

  if (modo === 'nuevo') setTimeout(() => f.importe.focus(), 250);

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const importe = parseImporte(f.importe.value);
    const err = $('#fError', hoja);
    if (!(importe > 0)) { err.textContent = 'Escribe un importe.'; return; }
    if (!categoria) { err.textContent = 'Elige una categoría.'; return; }
    const datos = {
      id: g.id || uid(), importe, moneda, categoria,
      fecha: f.fecha.value || hoyStr(), comercio: f.comercio.value.trim(), nota: f.nota.value.trim()
    };
    recordarMoneda(moneda);
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (modo === 'nuevo') {
        const r = await enviarOEncolar('add', datos);
        cerrarHoja();
        toast(r ? `Guardado · ${dinero(r.gasto.base ?? importe, r.gasto.base != null ? meta.base : moneda)}`
          : 'Sin conexión: se enviará automáticamente');
      } else {
        await api('update', datos);
        cerrarHoja();
        toast('Cambios guardados');
      }
      cargar();
    } catch (ex) {
      btn.disabled = false;
      err.textContent = ex.network ? 'Sin conexión. Inténtalo de nuevo.' : ex.message;
    }
  });

  const borrar = $('#borrar', hoja);
  if (borrar) borrar.addEventListener('click', async () => {
    if (!confirm('¿Borrar este gasto?')) return;
    borrar.disabled = true;
    try {
      await api('delete', { id: g.id });
      cerrarHoja();
      toast('Gasto borrado');
      cargar();
    } catch (ex) {
      borrar.disabled = false;
      $('#fError', hoja).textContent = ex.network ? 'Sin conexión.' : ex.message;
    }
  });
}

function recordarMoneda(m) {
  LS.set('gastos.moneda', m);
  if (m !== (meta.base || 'EUR') && m !== 'SEK') {
    const l = LS.get('gastos.monedas', []).filter((x) => x !== m);
    l.unshift(m);
    LS.set('gastos.monedas', l.slice(0, 3));
  }
}

// ---------- foto del ticket ----------
async function comprimir(file, max = 2000, calidad = 0.82) {
  let img;
  try {
    img = await createImageBitmap(file);
  } catch {
    img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('No pude abrir la imagen'));
      i.src = URL.createObjectURL(file);
    });
  }
  const w = img.width, h = img.height;
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', calidad);
  return { dataUrl, b64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

async function procesarFoto(file) {
  if (!file) return;
  let foto;
  try { foto = await comprimir(file); } catch (e) { return toast(e.message); }
  const payload = {
    id: uid(), imagen: foto.b64, mime: 'image/jpeg',
    monedaSugerida: LS.get('gastos.moneda', 'SEK'), fecha: hoyStr()
  };
  enviarTicket(payload, foto.dataUrl);
}

async function enviarTicket(payload, dataUrl) {
  const hoja = abrirHoja(`
    <div class="proc"><img src="${dataUrl}" alt="">
      <div><div class="spinner"></div><strong>Leyendo el ticket…</strong>
      <p>Suele tardar unos segundos.</p></div></div>`);
  try {
    const r = await enviarOEncolar('receipt', payload, 120000);
    if (!r) {
      hoja.innerHTML = `<div class="proc"><img src="${dataUrl}" alt="">
        <div><strong>Guardado sin conexión</strong><p>Se enviará en cuanto vuelva la conexión.</p></div></div>
        <button class="btn primary wide" data-close>Vale</button>`;
      return;
    }
    mostrarResultado(r.gasto, dataUrl);
    cargar();
  } catch (e) {
    hoja.innerHTML = `<div class="proc"><img src="${dataUrl}" alt="">
      <div><strong>No se pudo registrar</strong><p>${esc(e.message)}</p></div></div>
      <div class="botones"><button class="btn ghost" data-close>Cancelar</button>
      <button class="btn primary" id="reintentar">Reintentar</button></div>`;
    $('#reintentar', hoja).onclick = () => enviarTicket(payload, dataUrl);
  }
}

function mostrarResultado(g, dataUrl) {
  const base = meta.base || 'EUR';
  const revisar = /^Revisar/.test(g.estado);
  const hoja = abrirHoja(`
    <h3>${revisar ? 'Revisa este ticket' : 'Ticket registrado ✓'}</h3>
    ${revisar ? `<p class="aviso">${esc(g.estado)}</p>` : ''}
    <div class="proc"><img src="${dataUrl}" alt="">
      <div class="resultado" style="margin:0">
        <div class="r"><span>Comercio</span><span>${esc(g.comercio || '—')}</span></div>
        <div class="r"><span>Fecha</span><span>${esc(g.fecha)}</span></div>
        <div class="r"><span>Categoría</span><span>${esc(g.categoria)}</span></div>
        ${g.moneda !== base ? `<div class="r"><span>Importe</span><span>${dinero(g.importe, g.moneda)}</span></div>` : ''}
        <div class="r big"><span>Total</span><span>${dinero(g.base, base)}</span></div>
      </div>
    </div>
    <div class="botones">
      <button class="btn ghost" id="corregir">Corregir</button>
      <button class="btn primary" data-close>${revisar ? 'Más tarde' : 'Listo'}</button>
    </div>`);
  $('#corregir', hoja).onclick = () => montarFormulario(g, 'editar');
}

// ---------- ajustes ----------
function abrirAjustes() {
  const hoja = abrirHoja(`
    <h3>Ajustes</h3>
    <div class="ajustes-lista">
      ${meta.hoja ? `<a class="btn ghost wide" href="${esc(meta.hoja)}" target="_blank" rel="noopener">Abrir la hoja de cálculo ↗</a>` : ''}
      <button class="btn ghost wide" id="actualizar">Actualizar datos</button>
      <button class="btn danger wide" id="desconectar">Desconectar esta app</button>
    </div>
    <p class="error" style="color:var(--muted)">Moneda base: ${esc(meta.base)} · ${meta.ia === false ? 'IA sin configurar' : 'Lectura de tickets con IA'}</p>`);
  $('#actualizar', hoja).onclick = () => { cerrarHoja(); cargar(); enviarPendientes(); };
  $('#desconectar', hoja).onclick = () => {
    if (!confirm('Se borrará la conexión de este móvil. Tus gastos siguen en la hoja.')) return;
    LS.del('gastos.cfg');
    cfg = null;
    cerrarHoja();
    mostrarSetup();
  };
}

// ---------- configuración inicial ----------
function leerEnlace() {
  const h = new URLSearchParams(location.hash.slice(1));
  const url = h.get('url'), key = h.get('key');
  if (url && key) {
    history.replaceState(null, '', location.pathname + location.search);
    return { url, key };
  }
  return null;
}

function mostrarSetup(msg) {
  $('#app').hidden = true;
  $('#actions').hidden = true;
  $('#setup').hidden = false;
  $('#setupError').textContent = msg || '';
  if (cfg) { $('#setupForm').url.value = cfg.url; $('#setupForm').key.value = cfg.key; }
}

async function conectar(nuevo) {
  const previo = cfg;
  cfg = { url: nuevo.url.trim(), key: nuevo.key.trim() };
  try {
    const j = await api('ping');
    meta = { base: j.base, categorias: j.categorias, ia: j.ia, hoja: j.hoja || '' };
    LS.set('gastos.meta', meta);
    LS.set('gastos.cfg', cfg);
    iniciarApp();
    toast(j.ia ? 'Conectado ✓' : 'Conectado ✓ (falta la clave de IA para leer tickets)', 4000);
    return true;
  } catch (e) {
    cfg = previo;
    mostrarSetup(e.network ? 'No se pudo conectar. Revisa la URL y tu conexión.' : e.message);
    $('#setupForm').url.value = nuevo.url;
    $('#setupForm').key.value = nuevo.key;
    return false;
  }
}

function iniciarApp() {
  $('#setup').hidden = true;
  $('#app').hidden = false;
  $('#actions').hidden = false;
  cargar();
  refrescarPendientes().then(enviarPendientes);
}

// ---------- eventos ----------
function eventos() {
  $('#prev').onclick = () => cargar(sumarMes(state.mes, -1));
  $('#next').onclick = () => { if (state.mes < mesActual()) cargar(sumarMes(state.mes, 1)); };
  $('#ajustes').onclick = abrirAjustes;
  $('#manual').onclick = () => montarFormulario({}, 'nuevo');
  for (const id of ['camara', 'galeria']) {
    $('#' + id).addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      procesarFoto(f);
    });
  }
  $('#sheetWrap').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) cerrarHoja(); });
  $('#lista').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b && state.data) {
      const g = state.data.movimientos.find((x) => x.id === b.dataset.id);
      if (g) montarFormulario(g, 'editar');
      return;
    }
    if (e.target.closest('[data-pend]')) {
      toast(navigator.onLine ? 'Enviando…' : 'Se enviará cuando haya conexión');
      enviarPendientes();
    }
  });
  $('#setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const b = f.querySelector('button');
    b.disabled = true;
    await conectar({ url: f.url.value, key: f.key.value });
    b.disabled = false;
  });
  window.addEventListener('hashchange', () => { const l = leerEnlace(); if (l) conectar(l); });
  window.addEventListener('online', enviarPendientes);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cfg) { cargar(); enviarPendientes(); }
  });
}

// ---------- arranque ----------
(async function inicio() {
  eventos();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  const enlace = leerEnlace();
  if (enlace) {
    if (await conectar(enlace)) return;
    return;
  }
  if (cfg) iniciarApp();
  else mostrarSetup();
})();
