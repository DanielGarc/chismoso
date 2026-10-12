/* Shows the GitHub star count next to the GitHub link in the header.
 * One request per visit (cached for the browser session); if the API is
 * unreachable or rate-limited, the link simply shows no count. */
(function () {
  'use strict';
  var link = document.querySelector('.gh-link');
  var out = link && link.querySelector('[data-stars]');
  if (!out) return;
  var repo = link.getAttribute('href').replace(/^https:\/\/github\.com\//, '');
  var key = 'chismoso-stars:' + repo;

  function show(n) {
    if (typeof n !== 'number') return;
    out.lastElementChild.textContent = n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
    out.hidden = false;
    link.setAttribute('aria-label', 'GitHub, ' + n + (n === 1 ? ' star' : ' stars'));
  }

  try {
    var cached = sessionStorage.getItem(key);
    if (cached !== null) { show(Number(cached)); return; }
  } catch (e) { /* storage blocked: just fetch */ }

  fetch('https://api.github.com/repos/' + repo, { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || typeof d.stargazers_count !== 'number') return;
      show(d.stargazers_count);
      try { sessionStorage.setItem(key, String(d.stargazers_count)); } catch (e) { /* ignore */ }
    })
    .catch(function () { /* no count, no fuss */ });
})();
