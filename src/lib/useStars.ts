import { useEffect, useState } from "react";

const KEY = "harfiyen.stars";
const MAX_AGE = 60 * 60 * 1000;

/** The repo's GitHub star count, or null while it loads or if GitHub can't be reached. Cached for an hour per tab session (the API allows 60 unauthenticated calls an hour per IP). */
export function useStars(repo: string): number | null {
  const [stars, setStars] = useState<number | null>(() => {
    try {
      const c = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
      if (c && c.repo === repo && Date.now() - c.at < MAX_AGE && Number.isFinite(c.n)) return c.n;
    } catch {
      /* no storage, or a bad entry: fetch instead */
    }
    return null;
  });

  useEffect(() => {
    if (stars !== null) return;
    const ctl = new AbortController();
    fetch(`https://api.github.com/repos/${repo}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const n = d?.stargazers_count;
        if (typeof n !== "number") return;
        setStars(n);
        try {
          sessionStorage.setItem(KEY, JSON.stringify({ repo, n, at: Date.now() }));
        } catch {
          /* the count still shows, it just isn't cached */
        }
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [repo, stars]);

  return stars;
}

/** 116 → "116", 1234 → "1,2B" (Turkish thousands), 12 345 → "12B". */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(".", ",")}B`;
}
