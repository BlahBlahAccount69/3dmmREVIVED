/**
 * Resolves static asset paths under public/ so deployments work reliably at root (/),
 * in local dev, and on GitHub Pages subpath origins (./ via document.baseURI).
 */
export function assetUrl(path: string): string {
  const clean = path.replace(/^\/+/, '');
  let base = './';
  try {
    const metaEnv = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
    if (metaEnv && typeof metaEnv.BASE_URL === 'string' && metaEnv.BASE_URL.length > 0) {
      base = metaEnv.BASE_URL;
    }
  } catch {
    base = './';
  }
  if (base === './' || base === '.') {
    if (typeof document !== 'undefined' && document.baseURI) {
      try {
        return new URL(clean, document.baseURI).href;
      } catch {
        // fallback below
      }
    }
    return `./${clean}`;
  }
  if (!base.endsWith('/')) base += '/';
  return `${base}${clean}`;
}
