// The one place to configure the site. Everything else (page links, the
// download script, "Edit this page" links, canonical URLs) is built from it.

export default {
  name: 'Chismoso',

  // GitHub repository, "owner/name". Release downloads, source links,
  // issue links and "Edit this page on GitHub" all come from this.
  repo: 'DanielGarc/chismoso',
  // Branch the docs are edited on (for "Edit this page" links).
  branch: 'main',
  // Where this folder sits inside the repo (for "Edit this page" links).
  siteDir: 'site',

  // Custom domain for GitHub Pages. The build writes dist/CNAME from this.
  domain: 'chismoso.caprichosos.org',

  // Phone apps. Leave '' while they're "Coming soon". Filling one in turns
  // its card on the download page into a store button (a store URL wins over
  // an .apk attached to a GitHub release). See README.md, "Lighting up the
  // phone apps".
  storeUrls: {
    android: '', // e.g. 'https://play.google.com/store/apps/details?id=org.caprichosos.chismoso'
    ios: '',     // e.g. 'https://apps.apple.com/app/id0000000000'
  },

  // Documentation sidebar, in order. Each entry is a file in docs/ without
  // ".md". The first page of the first section is docs/index.html.
  sidebar: [
    { title: 'Introduction', pages: ['index'] },
    { title: 'Getting started', pages: ['install', 'sign-in', 'tour'] },
    {
      title: 'Using Chismoso',
      pages: ['live-view', 'camera-view', 'timeline', 'playback', 'clips-and-timelapses', 'notifications', 'load', 'settings'],
    },
    {
      title: 'Advanced',
      pages: ['live-video-setup', 'command-line', 'keyboard-shortcuts', 'privacy-and-security', 'updates', 'phones'],
    },
    { title: 'Help', pages: ['faq', 'troubleshooting'] },
    { title: 'Project', pages: ['roadmap'] },
    { title: 'Contributing', pages: ['building', 'contributing'] },
  ],
};
