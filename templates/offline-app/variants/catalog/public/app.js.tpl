// Relative URLs so the app works at any mount point (including the factory's preview proxy). Read-only: GET requests only.
const els = {
  form: document.getElementById('search'),
  query: document.getElementById('query'),
  category: document.getElementById('category'),
  list: document.getElementById('entries'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count'),
  error: document.getElementById('error'),
};

async function api(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function showError(message) {
  els.error.textContent = message || '';
  els.error.hidden = !message;
}

function render(entries) {
  els.list.replaceChildren(
    ...entries.map((entry) => {
      const li = document.createElement('li');
      li.className = 'entry';
      const text = document.createElement('div');
      text.className = 'text';
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const description = document.createElement('span');
      description.textContent = entry.description;
      text.append(name, description);
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = entry.category;
      li.append(text, tag);
      return li;
    }),
  );
  els.count.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
  els.empty.hidden = entries.length > 0;
}

async function search() {
  try {
    const params = new URLSearchParams({ q: els.query.value, category: els.category.value });
    const { entries } = await api(`api/entries?${params}`);
    showError('');
    render(entries);
  } catch (err) {
    showError(err.message);
  }
}

async function init() {
  try {
    const { categories } = await api('api/categories');
    for (const c of categories) els.category.append(new Option(c, c));
  } catch (err) {
    showError(err.message);
  }
  await search();
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  search();
});
els.category.addEventListener('change', search);
init();
