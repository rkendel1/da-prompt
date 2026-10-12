<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{APP_TITLE_HTML}}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="shell">
    <header>
      <p class="eyebrow">built by the software factory</p>
      <h1>{{APP_TITLE_HTML}}</h1>
      <p class="lede">{{IDEA_HTML}}</p>
    </header>

    <form id="new-item" autocomplete="off">
      <label class="sr" for="title">Title</label>
      <input id="title" name="title" maxlength="200" placeholder="Add something…" required>
      <label class="sr" for="notes">Notes</label>
      <input id="notes" name="notes" maxlength="2000" placeholder="Notes (optional)">
      <button type="submit">Add</button>
    </form>
    <p id="error" class="error" role="alert" hidden></p>

    <div class="toolbar">
      <span id="count">0 items</span>
      <div class="filters" role="group" aria-label="Filter">
        <button type="button" data-filter="all" aria-pressed="true">All</button>
        <button type="button" data-filter="open" aria-pressed="false">Open</button>
        <button type="button" data-filter="done" aria-pressed="false">Done</button>
      </div>
    </div>

    <ul id="items" aria-live="polite"></ul>
    <p id="empty" class="empty">Nothing here yet. Add your first item above.</p>
  </main>
  <script src="app.js" type="module"></script>
</body>
</html>
