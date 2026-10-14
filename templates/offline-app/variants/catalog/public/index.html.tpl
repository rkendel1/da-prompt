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

    <form id="search" role="search" autocomplete="off">
      <label class="sr" for="query">Search</label>
      <input id="query" name="q" maxlength="100" placeholder="Search the catalog…">
      <label class="sr" for="category">Category</label>
      <select id="category" name="category"><option value="">All categories</option></select>
      <button type="submit">Search</button>
    </form>
    <p id="error" class="error" role="alert" hidden></p>

    <div class="toolbar"><span id="count">0 entries</span></div>
    <ul id="entries" aria-live="polite"></ul>
    <p id="empty" class="empty" hidden>No entries match your search.</p>
  </main>
  <script src="app.js" type="module"></script>
</body>
</html>
