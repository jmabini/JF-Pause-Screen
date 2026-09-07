/**
 * THE SMALLEST DOM THAT WILL BOOT src/core/pauseScreen.js — test support only.
 *
 * Round 3 found that every new defect lived in the façade <-> pauseScreen seam, and that
 * none were catchable because the harness tested the façade in isolation and pauseScreen
 * only by grepping source. This closes that gap: it is enough of a DOM for the REAL
 * initPauseScreen() to construct, bind, show its overlay and run the REAL updateProgress()
 * against the REAL façade. No test dependency is added — it is ~300 lines of plain node.
 *
 * It is deliberately partial. It supports exactly the DOM this codebase touches on the
 * boot -> bind -> pause -> show -> progress path:
 *   - element creation, a tiny HTML parser for createOverlay()'s innerHTML block
 *   - querySelector/querySelectorAll/closest over `tag`, `.class`, `#id`, `[attr]`,
 *     `[attr="v"]`, comma lists and the descendant combinator (no `>`, `+`, `~`;
 *     any `:pseudo` never matches, which is what the OSD-hover probe expects here)
 *   - style with setProperty/cssText, classList, dataset, textContent, innerHTML
 *   - addEventListener/removeEventListener plus a listener census, so tests can assert
 *     that destroy() actually unhooks things
 *   - a MANUAL requestAnimationFrame queue, so tests can interleave a purge between
 *     showOverlay() scheduling a frame and that frame running
 *
 * Layout is faked with fixed rects: nothing here measures anything, and no test asserts
 * on geometry. Worker is deliberately left undefined so directorRequest() rejects and
 * adjustLayout() takes its DOM fallback path, which this shim does support.
 *
 * KNOWN BLIND SPOT — priority is not modelled. setProperty() stores name -> value and
 * discards the third argument, and there is no cascade and no computed style. So a style
 * assertion here proves what OUR code SET, never what a browser would PAINT, and in
 * particular this shim CANNOT catch a dropped `!important`. That matters: the overlay's
 * `display: none !important` and `opacity: 1 !important` exist to win against jellyfin-web's
 * own CSS, and losing one would be invisible to every check in the harness. Verify that
 * contract in a real browser, not here.
 */

const RAF_QUEUE = [];
let rafId = 0;

/** Mime types the shim's <video> claims it can decode. Populated by installDomShim(). */
const PLAYABLE_MIMES = new Set();

function makeStyle() {
  const props = new Map();
  const style = {
    setProperty(name, value) { props.set(name, value); },
    getPropertyValue(name) { return props.get(name) ?? ''; },
    removeProperty(name) { props.delete(name); },
    get cssText() { return [...props].map(([k, v]) => `${k}:${v}`).join(';'); },
    set cssText(text) {
      for (const decl of String(text).split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) props.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      }
    }
  };
  // The camelCase properties the codebase assigns directly (el.style.display = ...).
  for (const name of [
    'display', 'opacity', 'visibility', 'transition', 'transform', 'transformOrigin',
    'backgroundImage', 'pointerEvents', 'width', 'height', 'maxHeight', 'fontSize',
    'flexShrink', 'position', 'left', 'top', 'maskImage', 'webkitMaskImage',
    'webkitLineClamp', 'webkitBoxOrient', 'flex', 'contain'
  ]) {
    Object.defineProperty(style, name, {
      enumerable: true,
      get() { return props.get(name) ?? ''; },
      set(v) { props.set(name, v); }
    });
  }
  return style;
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = makeStyle();
    this.dataset = {};
    this.listeners = new Map();
    this._text = '';
    this.src = '';
    this.scrollTop = 0;
    // Fixed, plausible layout numbers. Nothing under test reads these for correctness.
    this.scrollHeight = 100;
    this.clientHeight = 100;
    this.offsetHeight = 40;
    this.offsetWidth = 200;
    this.classList = {
      add: (...c) => this._setClasses([...this._classes(), ...c]),
      remove: (...c) => this._setClasses(this._classes().filter(x => !c.includes(x))),
      contains: (c) => this._classes().includes(c)
    };
  }

  _classes() { return String(this.attributes.get('class') || '').split(/\s+/).filter(Boolean); }
  _setClasses(list) { this.attributes.set('class', [...new Set(list)].join(' ')); }

  get id() { return this.attributes.get('id') || ''; }
  set id(v) { this.attributes.set('id', v); }
  get className() { return this.attributes.get('class') || ''; }
  set className(v) { this.attributes.set('class', v); }
  get currentSrc() { return this.src; }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  /** Used by the Android veto's direct-play probe. Tests control PLAYABLE_MIMES. */
  canPlayType(mime) { return PLAYABLE_MIMES.has(mime) ? 'probably' : ''; }

  get children() { return this.childNodes.filter(n => n instanceof El); }

  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map(n => (n instanceof El ? n.textContent : String(n))).join('');
  }
  set textContent(v) { this.childNodes = []; this._text = v == null ? '' : String(v); }

  get innerHTML() { return this._text; } // only ever read back as a truthiness check
  set innerHTML(html) {
    this.childNodes = [];
    this._text = '';
    for (const node of parseHTML(String(html))) this.appendChild(node);
  }

  appendChild(node) {
    if (node && node.__fragment) { node.childNodes.forEach(c => this.appendChild(c)); return node; }
    if (node instanceof El) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; }
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    const i = this.childNodes.indexOf(ref);
    if (node instanceof El) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; }
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    if (node instanceof El) node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  cloneNode() {
    const copy = new El(this.tagName);
    this.attributes.forEach((v, k) => copy.attributes.set(k, v));
    copy._text = this._text;
    return copy;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const kids = this.parentNode.childNodes;
    return kids[kids.indexOf(this) + 1] || null;
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0 };
  }

  descendants(out = []) {
    for (const child of this.children) { out.push(child); child.descendants(out); }
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return this.descendants().filter(el => matches(el, sel)); }
  closest(sel) {
    let node = this;
    while (node) { if (matches(node, sel)) return node; node = node.parentNode; }
    return null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  listenerCount(type) { return this.listeners.get(type)?.size ?? 0; }
  fire(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, target: this, ...event });
  }
}

// ── Selector matching ────────────────────────────────────────────────────────────────
function matchesSimple(el, simple) {
  if (simple.includes(':')) return false; // :hover etc. never match in this shim
  const parts = simple.match(/^[a-zA-Z][\w-]*|[.#][\w-]+|\[[^\]]+\]/g) || [];
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (part[0] === '.') { if (!el.classList.contains(part.slice(1))) return false; }
    else if (part[0] === '#') { if (el.id !== part.slice(1)) return false; }
    else if (part[0] === '[') {
      const m = part.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"'\]]*)["']?)?$/);
      if (!m) return false;
      const value = el.getAttribute(m[1]) ?? (el.dataset[camel(m[1])] !== undefined ? String(el.dataset[camel(m[1])]) : null);
      if (value === null) return false;
      if (m[2] !== undefined && value !== m[2]) return false;
    } else if (el.tagName !== part.toUpperCase()) return false;
  }
  return true;
}
const camel = (attr) => attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function matches(el, selector) {
  return String(selector).split(',').some(one => {
    const chain = one.trim().split(/\s+/).filter(Boolean);
    if (chain.length === 0) return false;
    if (!matchesSimple(el, chain[chain.length - 1])) return false;
    let node = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (node && !matchesSimple(node, chain[i])) node = node.parentNode;
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  });
}

// ── A tiny HTML parser, sufficient for createOverlay()'s template ────────────────────
function parseHTML(html) {
  const roots = [];
  const stack = [];
  const push = (node) => { (stack[stack.length - 1] || { childNodes: roots }).childNodes.push(node); };
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [full, tag, attrText, selfClose, text] = m;
    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed) {
        const parent = stack[stack.length - 1];
        if (parent) parent._text = (parent._text || '') + trimmed;
      }
      continue;
    }
    if (full.startsWith('</')) {
      const done = stack.pop();
      if (done && stack.length === 0) roots.push(done);
      else if (done) stack[stack.length - 1].appendChild(done);
      continue;
    }
    const el = new El(tag);
    for (const a of attrText.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) {
      el.attributes.set(a[1], a[2]);
      if (a[1].startsWith('data-')) el.dataset[camel(a[1])] = a[2];
    }
    if (selfClose || tag.toLowerCase() === 'img' || tag.toLowerCase() === 'br') {
      if (stack.length) stack[stack.length - 1].appendChild(el); else roots.push(el);
    } else {
      stack.push(el);
    }
  }
  while (stack.length) { const done = stack.pop(); if (stack.length) stack[stack.length - 1].appendChild(done); else roots.push(done); }
  return roots;
}

// ── Install ──────────────────────────────────────────────────────────────────────────
export function installDomShim({ origin = 'http://localhost', credentials = null, playableMimes = [] } = {}) {
  PLAYABLE_MIMES.clear();
  for (const m of playableMimes) PLAYABLE_MIMES.add(m);
  const documentElement = new El('html');
  const head = new El('head');
  const body = new El('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const docListeners = new Map();
  const document = {
    documentElement, head, body,
    createElement: (tag) => new El(tag),
    createDocumentFragment: () => ({ __fragment: true, childNodes: [], appendChild(n) { this.childNodes.push(n); return n; } }),
    getElementById: (id) => documentElement.querySelectorAll(`#${id}`)[0] || null,
    querySelector: (sel) => documentElement.querySelector(sel),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
    listenerCount: (type) => docListeners.get(type)?.size ?? 0,
    fire(type, event = {}) { for (const fn of [...(docListeners.get(type) || [])]) fn({ type, ...event }); }
  };

  const store = new Map();
  if (credentials) store.set('jellyfin_credentials', JSON.stringify(credentials));

  globalThis.document = document;
  globalThis.window = {
    Events: globalThis.window?.Events,
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    location: { origin, hash: '', search: '' },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: '24px', fontSize: '16px', width: '600px' })
  };
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  globalThis.requestAnimationFrame = (fn) => { RAF_QUEUE.push({ id: ++rafId, fn }); return rafId; };
  globalThis.cancelAnimationFrame = (id) => {
    const i = RAF_QUEUE.findIndex(e => e.id === id);
    if (i >= 0) RAF_QUEUE.splice(i, 1);
  };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.DOMParser = class { parseFromString() { return { body: { innerHTML: '' }, querySelectorAll: () => [] }; } };
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '', blob: async () => ({}) });

  return { document, El };
}

/** Run every currently-queued animation frame (frames they schedule land in the next run). */
export function flushRAF(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    const batch = RAF_QUEUE.splice(0, RAF_QUEUE.length);
    for (const { fn } of batch) fn(performance.now());
  }
}
