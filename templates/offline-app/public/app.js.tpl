// Relative URLs so the app works at any mount point (including the factory's preview proxy).
const API = 'api/items';
const els = {
  form: document.getElementById('new-item'),
  title: document.getElementById('title'),
  notes: document.getElementById('notes'),
  list: document.getElementById('items'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count'),
  error: document.getElementById('error'),
  filters: document.querySelectorAll('[data-filter]'),
};
let items = [];
let filter = 'all';

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function showError(message) {
  els.error.textContent = message || '';
  els.error.hidden = !message;
}

function render() {
  const visible = items.filter((i) => (filter === 'all' ? true : filter === 'done' ? i.done : !i.done));
  els.list.replaceChildren(
    ...visible.map((item) => {
      const li = document.createElement('li');
      li.className = item.done ? 'done' : '';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.done;
      box.setAttribute('aria-label', `Mark "${item.title}" ${item.done ? 'open' : 'done'}`);
      box.addEventListener('change', () => toggle(item));
      const text = document.createElement('div');
      text.className = 'text';
      const t = document.createElement('strong');
      t.textContent = item.title;
      text.append(t);
      if (item.notes) {
        const n = document.createElement('span');
        n.textContent = item.notes;
        text.append(n);
      }
      const del = document.createElement('button');
      del.className = 'delete';
      del.type = 'button';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', `Delete "${item.title}"`);
      del.addEventListener('click', () => remove(item));
      li.append(box, text, del);
      return li;
    }),
  );
  const open = items.filter((i) => !i.done).length;
  els.count.textContent = `${items.length} item${items.length === 1 ? '' : 's'} · ${open} open`;
  els.empty.hidden = visible.length > 0;
}

async function load() {
  try {
    items = (await api(API)).items;
    render();
  } catch (err) {
    showError(err.message);
  }
}

async function toggle(item) {
  try {
    const { item: updated } = await api(`${API}/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ done: !item.done }) });
    items = items.map((i) => (i.id === updated.id ? updated : i));
    showError('');
    render();
  } catch (err) {
    showError(err.message);
  }
}

async function remove(item) {
  try {
    await api(`${API}/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    items = items.filter((i) => i.id !== item.id);
    showError('');
    render();
  } catch (err) {
    showError(err.message);
  }
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { item } = await api(API, { method: 'POST', body: JSON.stringify({ title: els.title.value, notes: els.notes.value }) });
    items.push(item);
    els.form.reset();
    els.title.focus();
    showError('');
    render();
  } catch (err) {
    showError(err.message);
  }
});

els.filters.forEach((btn) =>
  btn.addEventListener('click', () => {
    filter = btn.dataset.filter;
    els.filters.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    render();
  }),
);

load();
