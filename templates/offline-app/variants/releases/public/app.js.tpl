// Relative URLs so the app works at any mount point. Read-only: lists releases and verifies each one with the server.
const els = { list: document.getElementById('releases'), empty: document.getElementById('empty'), count: document.getElementById('count'), error: document.getElementById('error'), publisher: document.getElementById('publisher') };

async function api(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function init() {
  try {
    const health = await api('api/health');
    els.publisher.textContent = `Publisher ${health.publisher.id}${health.publisher.canPublish ? '' : ' (publishing not configured)'}`;
    const { releases } = await api('api/releases');
    const rows = await Promise.all(releases.map(async (r) => {
      const check = await api('api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ release: r.release }) });
      const li = document.createElement('li');
      li.className = 'entry';
      const text = document.createElement('div');
      text.className = 'text';
      const name = document.createElement('strong');
      name.textContent = `${r.name} ${r.version}`;
      const meta = document.createElement('span');
      meta.textContent = `${r.artifactId} · ${r.size} bytes · ${r.publishedAt}`;
      text.append(name, meta);
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = check.valid ? 'verified' : `invalid: ${check.reason}`;
      li.append(text, tag);
      return li;
    }));
    els.list.replaceChildren(...rows);
    els.count.textContent = `${releases.length} ${releases.length === 1 ? 'release' : 'releases'}`;
    els.empty.hidden = releases.length > 0;
  } catch (err) {
    els.error.textContent = err.message;
    els.error.hidden = false;
  }
}
init();
