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
    <p id="publisher" class="lede"></p>
    <p id="error" class="error" role="alert" hidden></p>
    <div class="toolbar"><span id="count">0 releases</span></div>
    <ul id="releases" aria-live="polite"></ul>
    <p id="empty" class="empty" hidden>Nothing has been published yet. Publishers use the AppPort capability releases.publish.</p>
  </main>
  <script src="app.js" type="module"></script>
</body>
</html>
