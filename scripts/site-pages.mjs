// Builds the search landing pages (content/pages/*.html) into dist/<slug>/index.html and writes dist/sitemap.xml.
// Runs after `vite build`, so the pages stay out of the app's offline precache (sw.js is already written).
//
// A page file starts with a JSON header in an HTML comment, then the body HTML:
//   <!--
//   { "title": "...", "description": "...", "h1": "...", "lead": "...", "shot": { "file": "x.jpg", "alt": "..." },
//     "faq": [{ "q": "...", "a": "HTML" }] }
//   -->
//   <section>...</section>
// In the body, <!-- shot: file.jpg | alt text --> places a screenshot from public/site/screens/. A missing file is
// left out with a warning, so a page can name screenshots before they are taken.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIGIN = "https://harfiyen.dev";
const APP_STORE = "https://apps.apple.com/app/id6832223953";
const SRC = "content/pages";
const SCREENS = "public/site/screens";
const OUT = "dist";

// Pages that are not generated here, for the sitemap.
const STATIC_PAGES = ["/", "/mcp/", "/support/", "/privacy/", "/terms/"];

if (!existsSync(OUT)) {
  console.error("site-pages: dist/ yok, önce vite build çalışmalı.");
  process.exit(1);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (html) => String(html).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// Width and height of a JPEG or PNG, so the page does not jump while screenshots load.
function size(file) {
  const b = readFileSync(file);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

const warnings = [];
function shot(file, alt, page, eager = false) {
  const path = join(SCREENS, file);
  if (!existsSync(path)) {
    warnings.push(`${page}: ${path} yok, ekran görüntüsü atlandı.`);
    return "";
  }
  const s = size(path);
  const dims = s ? ` width="${s.w}" height="${s.h}"` : "";
  return `<figure class="shot"><img src="/site/screens/${esc(file)}"${dims} alt="${esc(alt)}"${eager ? "" : ' loading="lazy"'} /></figure>`;
}

const pages = readdirSync(SRC)
  .filter((f) => f.endsWith(".html"))
  .sort()
  .map((f) => {
    const raw = readFileSync(join(SRC, f), "utf8");
    const m = raw.match(/^\s*<!--([\s\S]*?)-->/);
    if (!m) throw new Error(`${f}: başta JSON başlığı yok.`);
    const meta = JSON.parse(m[1]);
    return { slug: f.replace(/\.html$/, ""), meta, body: raw.slice(m[0].length).trim() };
  });

const footer = (current) => `
    <footer>
      <div class="wrap">
        <span class="fnote">Harfiyen, açık kaynak (MIT)</span>
        <a href="/">Uygulama</a>
${pages
  .filter((p) => p.slug !== current)
  .map((p) => `        <a href="/${p.slug}/">${esc(p.meta.nav)}</a>`)
  .join("\n")}
        <a href="/mcp/">MCP</a>
        <a href="/support/">Destek</a>
        <a href="/privacy/">Gizlilik</a>
        <a href="https://github.com/ozcancelik/harfiyen">GitHub</a>
      </div>
    </footer>`;

for (const { slug, meta, body } of pages) {
  const url = `${ORIGIN}/${slug}/`;
  const hero = meta.shot ? shot(meta.shot.file, meta.shot.alt, slug, true) : "";
  // A sharing image made for the page (og-<slug>.jpg, 1200×630), else the general one.
  const ogImage = `${ORIGIN}/site/screens/${existsSync(join(SCREENS, `og-${slug}.jpg`)) ? `og-${slug}.jpg` : "og.jpg"}`;
  const content = body.replace(/<!--\s*shot:\s*([^|]+?)\s*\|\s*([\s\S]*?)\s*-->/g, (_, file, alt) => shot(file, alt, slug));

  const faq = meta.faq?.length
    ? `
      <section>
        <h2>Sık sorulan sorular</h2>
        <div class="faq">
${meta.faq.map((x) => `          <details>\n            <summary>${esc(x.q)}</summary>\n            <p>${x.a}</p>\n          </details>`).join("\n")}
        </div>
      </section>`
    : "";

  const ld = [
    {
      "@type": "WebPage",
      "@id": url,
      url,
      name: meta.title,
      description: meta.description,
      inLanguage: "tr",
      isPartOf: { "@type": "WebSite", name: "Harfiyen", url: `${ORIGIN}/` },
      about: { "@type": "WebApplication", name: "Harfiyen", url: `${ORIGIN}/` },
    },
  ];
  // "app": true makes the page about the iPhone app: the App Store badge leads (also on phones) and the page
  // describes the app as a MobileApplication.
  const badge = (cls) =>
    `<a class="${cls}" href="${APP_STORE}"><img src="/site/app-store-tr.svg" width="151" height="40" alt="App Store'dan İndirin" /></a>`;
  const actions = meta.app
    ? `      <div class="actions">
        ${badge("store store-main")}
        <a class="btn" href="/">Bilgisayarda tarayıcıda dene</a>
      </div>
      <p class="meta">${meta.app.note}</p>`
    : `      <div class="actions">
        <a class="btn primary" href="/">Tarayıcıda ücretsiz aç</a>
        ${badge("store")}
      </div>
      <p class="meta">Kayıt yok. Dosyan yüklenmez, cihazında işlenir.</p>`;
  if (meta.app) {
    ld.push({
      "@type": "MobileApplication",
      name: meta.app.name,
      url: APP_STORE,
      installUrl: APP_STORE,
      operatingSystem: meta.app.os,
      applicationCategory: "MultimediaApplication",
      inLanguage: ["tr", "en"],
      image: `${ORIGIN}/icon-512.png`,
      offers: { "@type": "Offer", price: "0", priceCurrency: "TRY" },
    });
  }
  if (meta.faq?.length) {
    ld.push({
      "@type": "FAQPage",
      mainEntity: meta.faq.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: text(x.a) } })),
    });
  }

  const html = `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark light" />
    <title>${esc(meta.title)}</title>
    <meta name="description" content="${esc(meta.description)}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${url}" />
    <meta property="og:site_name" content="Harfiyen" />
    <meta property="og:locale" content="tr_TR" />
    <meta property="og:title" content="${esc(meta.title)}" />
    <meta property="og:description" content="${esc(meta.description)}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="apple-itunes-app" content="app-id=6832223953" />
    <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="theme-color" content="#14171a" />
    <script src="/site/site.js"></script>
    <link rel="stylesheet" href="/site/site.css" />
    <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": ld }).replace(/</g, "\\u003c")}</script>
  </head>
  <body>
    <header>
      <div class="wrap">
        <a class="logo" href="/" aria-label="Harfiyen">
          <img class="logo-dark" src="/brand/harfiyen-logo-light.png" alt="Harfiyen" />
          <img class="logo-light" src="/brand/harfiyen-logo.png" alt="Harfiyen" />
        </a>
        <nav>
          <a class="hide-sm" href="/support/">Destek</a>
          <a href="/">Uygulamayı aç</a>
        </nav>
      </div>
    </header>

    <main class="wrap">
      <h1>${esc(meta.h1)}</h1>
      <p class="lead">${meta.lead}</p>
${actions}
      ${hero}

${content}
${faq}
    </main>
${footer(slug)}
  </body>
</html>
`;
  mkdirSync(join(OUT, slug), { recursive: true });
  writeFileSync(join(OUT, slug, "index.html"), html);
}

const urls = [...STATIC_PAGES, ...pages.map((p) => `/${p.slug}/`)];
writeFileSync(
  join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${ORIGIN}${u}</loc></url>`).join("\n")}
</urlset>
`,
);

for (const w of warnings) console.warn(`site-pages: ${w}`);
console.log(`site-pages: ${pages.length} sayfa ve sitemap.xml yazıldı.`);
