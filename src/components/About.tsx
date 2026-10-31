// Settings → Hakkında: what the app is, its version and where to go next.

const REPO = "https://github.com/ozcancelik/harfiyen";
const AUTHOR = { name: "Özcan Çelik", url: "https://x.com/ozcancelik", email: "hello@ozcan.dev" };

const LINKS = [
  { label: "harfiyen.dev", href: "https://harfiyen.dev" },
  { label: "Kaynak kod", href: REPO },
  { label: "Sürüm notları", href: `${REPO}/blob/main/CHANGELOG.md` },
  { label: "Hata bildir", href: `${REPO}/issues` },
];

export function About() {
  return (
    <div className="grid justify-items-start gap-4">
      {/* "-light" is the version for dark backgrounds. */}
      <img
        className="block h-7 w-auto light:hidden"
        src={`${import.meta.env.BASE_URL}brand/harfiyen-logo-light.png`}
        alt="Harfiyen"
      />
      <img
        className="hidden h-7 w-auto light:block"
        src={`${import.meta.env.BASE_URL}brand/harfiyen-logo.png`}
        alt="Harfiyen"
      />
      <div className="grid gap-1.5">
        <span className="text-[12px] text-fg-3 tabular-nums">Sürüm {__APP_VERSION__}</span>
        <p className="m-0 max-w-[460px] text-[13px] leading-normal text-fg-2">
          Videoyu tarayıcında yazıya dök, çevir, seslendir, altyazı ekle, dışa aktar. Türkçe ve İngilizce desteklenir.
          Her şey senin bilgisayarında çalışır; dosyan hiçbir yere gönderilmez.
        </p>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {LINKS.map((l) => (
          <a
            key={l.href}
            className="text-[12.5px] text-fg no-underline underline-offset-2 hover:underline"
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {l.label}
          </a>
        ))}
      </div>
      <p className="m-0 border-t border-line-soft pt-3 text-[12px] text-fg-3">
        <a
          className="text-fg-2 no-underline hover:text-fg hover:underline"
          href={AUTHOR.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {AUTHOR.name}
        </a>{" "}
        tarafından geliştiriliyor ·{" "}
        <a className="text-fg-2 no-underline hover:text-fg hover:underline" href={`mailto:${AUTHOR.email}`}>
          {AUTHOR.email}
        </a>
      </p>
    </div>
  );
}
