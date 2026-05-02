/**
 * HELPERS & UTILITIES
 */

export function makeLRUBlobCache(limit) {
  const store = new Map();
  return {
    has: url => store.has(url),
    get(url) { 
      const val = store.get(url); 
      if (val !== undefined) { 
        store.delete(url); 
        store.set(url, val); 
      } 
      return val; 
    },
    set(url, blobUrl) {
      if (store.has(url)) store.delete(url);
      store.set(url, blobUrl);
      if (store.size > limit) {
        const oldest = store.keys().next().value;
        URL.revokeObjectURL(store.get(oldest));
        store.delete(oldest);
      }
    },
    forEach: fn => store.forEach(fn),
    clear() { 
      store.forEach(blobUrl => URL.revokeObjectURL(blobUrl)); 
      store.clear(); 
    }
  };
}

export function makeLRUCache(limit) {
  const store = new Map();
  return {
    has: key => store.has(key),
    get(key) { 
      const val = store.get(key); 
      if (val !== undefined) { 
        store.delete(key); 
        store.set(key, val); 
      } 
      return val; 
    },
    set(key, val) {
      if (store.has(key)) store.delete(key);
      store.set(key, val);
      if (store.size > limit) store.delete(store.keys().next().value);
    },
    clear() { store.clear(); }
  };
}

export function sanitizeHTML(raw) {
  if (!raw) return '';
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, link').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on') || (attr.name === 'href' && attr.value.trimStart().startsWith('javascript:'))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

export function formatClock(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` 
    : `${m}:${String(sec).padStart(2, '0')}`;
}
