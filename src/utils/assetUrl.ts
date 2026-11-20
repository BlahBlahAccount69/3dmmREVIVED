/**
 * Resolves static asset paths under public/ so deployments work both at root (/)
 * and on GitHub Pages / subpath origins (./) without failing fetches or broken images.
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
  if (!base.endsWith('/')) base += '/';
  return `${base}${clean}`;
}
