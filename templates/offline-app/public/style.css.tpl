:root {
  --bg: #f6f5f1;
  --card: #fffefb;
  --ink: #1d1d1b;
  --muted: #6b6a66;
  --line: #e3e1da;
  --accent: #e5533c;
  --ok: #2f7d4f;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --card: #1f1f1d; --ink: #ecebe6; --muted: #9b9a94; --line: #33322f; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); }
.shell { max-width: 680px; margin: 0 auto; padding: 48px 16px 80px; }
.eyebrow { font: 12px/1.4 ui-monospace, Menlo, monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
h1 { font-size: clamp(28px, 6vw, 40px); margin: 0 0 8px; letter-spacing: -.02em; }
.lede { color: var(--muted); margin: 0 0 28px; line-height: 1.5; }
form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; }
@media (max-width: 560px) { form { grid-template-columns: 1fr; } }
input:not([type=checkbox]) { font: inherit; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--ink); min-width: 0; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button { font: inherit; cursor: pointer; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--ink); padding: 10px 14px; }
form button { background: var(--ink); color: var(--bg); border-color: var(--ink); font-weight: 600; }
.error { color: var(--accent); margin: 10px 0 0; }
.toolbar { display: flex; justify-content: space-between; align-items: center; margin: 28px 0 10px; color: var(--muted); font-size: 14px; gap: 12px; flex-wrap: wrap; }
.filters { display: flex; gap: 4px; }
.filters button { padding: 6px 10px; font-size: 13px; }
.filters button[aria-pressed=true] { border-color: var(--accent); color: var(--accent); }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
li input { width: 18px; height: 18px; accent-color: var(--ok); }
.text { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.text span { color: var(--muted); font-size: 14px; }
li.done strong { text-decoration: line-through; color: var(--muted); }
.delete { font-size: 13px; padding: 6px 10px; color: var(--muted); }
.delete:hover { color: var(--accent); border-color: var(--accent); }
.empty { color: var(--muted); text-align: center; padding: 32px 0; }
.empty[hidden] { display: none; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
