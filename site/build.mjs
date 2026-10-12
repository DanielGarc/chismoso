// Builds the Chismoso website into dist/.
//
//   pages/*.html   promo pages (body only), wrapped in the shared template
//   docs/*.md      documentation, rendered with `marked`, ordered by the
//                  sidebar in site.config.mjs
//   assets/, img/  copied as-is (assets/download.js gets the config injected)
//
// Every link is relative, so dist/ works from GitHub Pages, any static server,
// or straight from the file system. The build fails on a broken internal link
// or anchor, so a renamed page can't slip through.
//
// Usage: node build.mjs        (or: npm run build)

import { readFile, writeFile, mkdir, rm, cp, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import config from './site.config.mjs';

const SITE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(SITE, 'dist');
const GH = `https://github.com/${config.repo}`;
const ORIGIN = `https://${config.domain}`;

// {{tokens}} available in pages/*.html and docs/*.md.
const VARS = {
  name: config.name,
  repo: config.repo,
  gh: GH,
  releases: `${GH}/releases`,
  latest: `${GH}/releases/latest`,
  issues: `${GH}/issues`,
  domain: config.domain,
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const slugify = (s) => stripTags(s).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');

function fill(text, file, extra = {}) {
  const vars = { ...VARS, ...extra };
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`${file}: unknown {{${k}}}`);
    return vars[k];
  });
}

// Minimal front matter: "key: value" lines between --- fences.
function frontMatter(src, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src);
  if (!m) throw new Error(`${file}: missing front matter (title, description)`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  if (!meta.title) throw new Error(`${file}: front matter needs a title`);
  return { meta, body: src.slice(m[0].length) };
}

// ── Icons (inline SVG, no icon font) ─────────────────────────────────────────
const ICON = {
  star: '<svg aria-hidden="true" viewBox="0 0 16 16" class="i"><path fill="currentColor" d="M8 .9l2.2 4.5 4.9.7-3.6 3.5.9 4.9L8 12.2l-4.4 2.3.9-4.9L.9 6.1l4.9-.7z"/></svg>',
  github: '<svg aria-hidden="true" viewBox="0 0 16 16" class="i"><path fill="currentColor" d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0z"/></svg>',
  search: '<svg aria-hidden="true" viewBox="0 0 24 24" class="i"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  menu: '<svg aria-hidden="true" viewBox="0 0 24 24" class="i"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  edit: '<svg aria-hidden="true" viewBox="0 0 24 24" class="i"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};

// ── Shared template ─────────────────────────────────────────────────────────
function layout({ title, description, root, urlPath, active, body, scripts = [], bodyClass = '' }) {
  const fullTitle = title === config.name ? `${config.name} — a lightweight client for Frigate NVR` : `${title} · ${config.name}`;
  const cur = (k) => (active === k ? ' aria-current="page"' : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(description || '')}">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0f16">
<link rel="canonical" href="${ORIGIN}/${urlPath}">
<meta property="og:title" content="${escapeHtml(fullTitle)}">
<meta property="og:description" content="${escapeHtml(description || '')}">
<meta property="og:type" content="website">
<meta property="og:url" content="${ORIGIN}/${urlPath}">
<meta property="og:image" content="${ORIGIN}/img/apple-touch-icon.png">
<link rel="icon" href="${root}img/favicon.svg" type="image/svg+xml">
<link rel="icon" href="${root}img/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="${root}img/apple-touch-icon.png">
<link rel="stylesheet" href="${root}assets/style.css">
${[...scripts, 'stars.js'].map((s) => `<script src="${root}assets/${s}" defer></script>`).join('\n')}
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="top-in">
    <a class="brand" href="${root}index.html"${active === 'home' ? ' aria-current="page"' : ''}>
      <img src="${root}img/logo.svg" width="30" height="30" alt="">
      <span>${config.name}</span>
    </a>
    <nav class="top-nav" aria-label="Main">
      <ul>
        <li><a href="${root}docs/index.html"${cur('docs')}>Docs</a></li>
        <li><a href="${root}download.html"${cur('download')}>Download</a></li>
        <li><a href="${GH}" class="gh-link">${ICON.github}<span class="gh-text">GitHub</span><span class="gh-stars" data-stars hidden>${ICON.star}<span></span></span></a></li>
      </ul>
    </nav>
  </div>
</header>
${body}
<footer class="foot">
  <div class="foot-in">
    <div class="foot-brand">
      <img src="${root}img/logo.svg" width="26" height="26" alt="">
      <div>
        <strong>${config.name}</strong>
        <p>A lightweight, open-source client for Frigate NVR.</p>
      </div>
    </div>
    <nav class="foot-nav" aria-label="Footer">
      <ul>
        <li><a href="${root}docs/index.html">Docs</a></li>
        <li><a href="${root}download.html">Download</a></li>
        <li><a href="${root}docs/faq.html">FAQ</a></li>
        <li><a href="${GH}">Source code</a></li>
        <li><a href="${GH}/releases">Releases</a></li>
        <li><a href="${GH}/issues">Report a problem</a></li>
      </ul>
    </nav>
    <p class="foot-note">${config.name} is an independent project. It is not affiliated with, endorsed by, or supported by the Frigate project. It's free software under the <a href="https://github.com/${config.repo}/blob/${config.branch}/LICENSE">MIT license</a>.</p>
  </div>
</footer>
</body>
</html>
`;
}

// ── Docs ─────────────────────────────────────────────────────────────────────
function docsMarked(page, toc, links) {
  const used = new Set();
  const md = new Marked({ gfm: true });
  md.use({
    walkTokens(token) {
      // "other-page.md#anchor" → "other-page.html#anchor"
      if (token.type === 'link') {
        const m = /^([\w-]+)\.md(#[\w-]*)?$/.exec(token.href);
        if (m) {
          token.href = `${m[1]}.html${m[2] || ''}`;
          links.push({ from: page, to: m[1], anchor: m[2] ? m[2].slice(1) : '' });
        }
      }
    },
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        if (depth === 1) throw new Error(`docs/${page}.md: don't use "# " headings; the title comes from front matter`);
        let id = slugify(html) || 'section';
        for (let n = 2; used.has(id); n++) id = `${slugify(html)}-${n}`;
        used.add(id);
        if (depth <= 3) toc.push({ depth, id, text: stripTags(html) });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${html}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        return `<pre${cls ? ` data-lang="${escapeHtml(lang)}"` : ''} tabindex="0"><code${cls}>${escapeHtml(text)}</code></pre>\n`;
      },
    },
  });
  return md;
}

// "> [!NOTE]" / "> [!TIP]" / "> [!WARNING]" → styled callouts.
function callouts(html) {
  html = html.replace(/<table>/g, '<div class="table-wrap" tabindex="0"><table>').replace(/<\/table>/g, '</table></div>');
  const label = { NOTE: 'Note', TIP: 'Tip', WARNING: 'Heads up' };
  return html.replace(/<blockquote>\s*<p>\[!(NOTE|TIP|WARNING)\]\s*/g, (m, k) =>
    `<blockquote class="callout callout-${k.toLowerCase()}"><p class="callout-title">${label[k]}</p><p>`);
}

function sectionsForSearch(html) {
  const out = [];
  for (const chunk of html.split(/(?=<h[23] id=")/)) {
    const h = /^<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/.exec(chunk);
    const text = stripTags(h ? chunk.slice(h[0].length) : chunk).replace(/\s+/g, ' ').trim();
    out.push({ id: h ? h[2] : '', heading: h ? stripTags(h[3]).replace(/^#/, '').trim() : '', text: text.slice(0, 900) });
  }
  return out;
}

async function buildDocs() {
  const order = config.sidebar.flatMap((s) => s.pages.map((p) => ({ slug: p, section: s.title })));
  const onDisk = (await readdir(path.join(SITE, 'docs'))).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  for (const f of onDisk) if (!order.some((o) => o.slug === f)) console.warn(`warning: docs/${f}.md isn't in the sidebar (site.config.mjs), so it isn't built`);
  if (order[0]?.slug !== 'index') throw new Error('The first sidebar page must be "index"');

  const pages = [];
  const links = [];
  for (const o of order) {
    const file = `docs/${o.slug}.md`;
    const src = fill(await readFile(path.join(SITE, file), 'utf8'), file, { root: '../' });
    const { meta, body } = frontMatter(src, file);
    const toc = [];
    const html = callouts(docsMarked(o.slug, toc, links).parse(body));
    pages.push({ ...o, meta, html, toc, file });
  }

  // Sidebar markup, with the current page marked.
  const sidebar = (current) => config.sidebar.map((s) => `
      <div class="side-group">
        <p class="side-h">${escapeHtml(s.title)}</p>
        <ul>${s.pages.map((slug) => {
          const p = pages.find((x) => x.slug === slug);
          return `<li><a href="${slug}.html"${slug === current ? ' aria-current="page"' : ''}>${escapeHtml(p.meta.nav || p.meta.title)}</a></li>`;
        }).join('')}</ul>
      </div>`).join('');

  const search = [];
  for (const [i, p] of pages.entries()) {
    const prev = pages[i - 1], next = pages[i + 1];
    const tocHtml = p.toc.filter((t) => t.depth === 2).length > 1 ? `
    <aside class="toc" aria-labelledby="toc-h">
      <p class="toc-h" id="toc-h">On this page</p>
      <ul>${p.toc.map((t) => `<li class="d${t.depth}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`).join('')}</ul>
    </aside>` : '';
    const body = `
<div class="docs">
  <aside class="docs-side" aria-label="Documentation">
    <div class="docs-tools">
      <form class="search" role="search" action="#" data-search>
        <label class="sr-only" for="q">Search the docs</label>
        ${ICON.search}
        <input id="q" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false"
          aria-controls="search-results" aria-expanded="false" aria-autocomplete="list" role="combobox">
        <kbd class="search-key" aria-hidden="true">/</kbd>
        <div class="search-results" id="search-results" role="listbox" aria-label="Search results" hidden></div>
      </form>
      <button class="menu-btn" type="button" aria-expanded="false" aria-controls="docs-nav">${ICON.menu}<span>Menu</span><span class="menu-where">${escapeHtml(p.section)} › ${escapeHtml(p.meta.nav || p.meta.title)}</span></button>
    </div>
    <nav class="docs-nav" id="docs-nav" aria-label="Docs pages">${sidebar(p.slug)}
    </nav>
  </aside>
  <main id="main" class="docs-main" tabindex="-1">
    <article class="prose">
      <p class="eyebrow">${escapeHtml(p.section)}</p>
      <h1>${escapeHtml(p.meta.title)}</h1>
      ${p.meta.description && p.slug !== 'index' ? `<p class="lede">${escapeHtml(p.meta.description)}</p>` : ''}
      ${p.html}
    </article>
    <p class="edit"><a href="${GH}/edit/${config.branch}/${config.siteDir}/${p.file}">${ICON.edit}Edit this page on GitHub</a></p>
    <nav class="pager" aria-label="Previous and next page">
      ${prev ? `<a class="prev" href="${prev.slug}.html" rel="prev"><span>Previous</span>← ${escapeHtml(prev.meta.nav || prev.meta.title)}</a>` : '<span></span>'}
      ${next ? `<a class="next" href="${next.slug}.html" rel="next"><span>Next</span>${escapeHtml(next.meta.nav || next.meta.title)} →</a>` : '<span></span>'}
    </nav>
  </main>${tocHtml}
</div>`;
    await write(`docs/${p.slug}.html`, layout({
      title: p.slug === 'index' ? 'Documentation' : p.meta.title,
      description: p.meta.description,
      root: '../',
      urlPath: `docs/${p.slug}.html`,
      active: 'docs',
      body,
      scripts: ['docs.js'],
      bodyClass: 'is-docs',
    }));
    for (const s of sectionsForSearch(p.html)) {
      search.push({ p: p.meta.title, s: p.section, h: s.heading, u: `${p.slug}.html${s.id ? '#' + s.id : ''}`, x: s.text });
    }
  }

  // Search index: a script (not .json) so it also loads from file:// previews.
  await write('assets/search-index.js', `window.CHISMOSO_SEARCH=${JSON.stringify(search)};\n`);

  // Doc-to-doc links: page and anchor must exist.
  for (const l of links) {
    const target = pages.find((p) => p.slug === l.to);
    if (!target) throw new Error(`docs/${l.from}.md links to ${l.to}.md, which isn't in the sidebar`);
    if (l.anchor && !target.toc.some((t) => t.id === l.anchor) && !new RegExp(`id="${l.anchor}"`).test(target.html)) {
      throw new Error(`docs/${l.from}.md links to ${l.to}.md#${l.anchor}, but that heading doesn't exist`);
    }
  }
  return pages.length;
}

// ── Promo pages ─────────────────────────────────────────────────────────────
async function buildPages() {
  const files = (await readdir(path.join(SITE, 'pages'))).filter((f) => f.endsWith('.html'));
  for (const f of files) {
    const file = `pages/${f}`;
    const { meta, body } = frontMatter(fill(await readFile(path.join(SITE, file), 'utf8'), file, { root: '' }), file);
    await write(f, layout({
      title: meta.title,
      description: meta.description,
      root: '',
      urlPath: f === 'index.html' ? '' : f,
      active: meta.active,
      body,
      scripts: ['download.js'],
    }));
  }
  return files.length;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function write(rel, content) {
  const p = path.join(DIST, rel);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content);
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

// Every relative href/src in dist must point at a file that exists, and every
// #anchor at an id on that page.
async function checkLinks() {
  const files = (await walk(DIST)).filter((f) => f.endsWith('.html'));
  const ids = new Map();
  const idsOf = (f) => {
    if (!ids.has(f)) ids.set(f, new Set([...readFileSync(f, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
    return ids.get(f);
  };
  const problems = [];
  for (const f of files) {
    const html = await readFile(f, 'utf8');
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:|mailto:|data:)/.test(url)) continue;
      const [p, hash] = url.split('#');
      const target = p ? path.resolve(path.dirname(f), p) : f;
      if (!existsSync(target)) { problems.push(`${path.relative(DIST, f)}: missing ${url}`); continue; }
      if (hash && target.endsWith('.html') && !idsOf(target).has(hash)) problems.push(`${path.relative(DIST, f)}: no #${hash} in ${p || 'this page'}`);
    }
  }
  if (problems.length) throw new Error('Broken internal links:\n  ' + problems.join('\n  '));
  return files.length;
}

async function dirSize(dir) {
  let n = 0;
  for (const f of await walk(dir)) n += (await readFile(f)).length;
  return n;
}

// ── Build ───────────────────────────────────────────────────────────────────
const t0 = Date.now();
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await cp(path.join(SITE, 'img'), path.join(DIST, 'img'), { recursive: true });
await cp(path.join(SITE, 'assets'), path.join(DIST, 'assets'), { recursive: true });

// The download script gets its settings from site.config.mjs.
const dl = await readFile(path.join(SITE, 'assets/download.js'), 'utf8');
const dlConfig = JSON.stringify({ repo: config.repo, storeUrls: config.storeUrls });
if (!dl.includes('/*CONFIG*/null')) throw new Error('assets/download.js: missing /*CONFIG*/null placeholder');
await write('assets/download.js', dl.replace('/*CONFIG*/null', dlConfig));

await write('CNAME', config.domain + '\n');
await write('.nojekyll', '');
const cnameFile = path.join(SITE, 'CNAME');
if (existsSync(cnameFile) && readFileSync(cnameFile, 'utf8').trim() !== config.domain) {
  console.warn(`warning: site/CNAME differs from domain in site.config.mjs (${config.domain}); dist/CNAME uses the config`);
}

const nPages = await buildPages();
const nDocs = await buildDocs();
const nChecked = await checkLinks();
const size = await dirSize(DIST);
console.log(`Built ${nPages} pages + ${nDocs} docs into dist/ (${(size / 1024).toFixed(0)} KB), ${nChecked} HTML files link-checked, in ${Date.now() - t0} ms.`);
