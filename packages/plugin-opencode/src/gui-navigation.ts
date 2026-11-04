/** Bounded document-local history; never uses the parent application's joint history. */
export function createFrameNavigation(base: URL) {
  const entries = [base.href];
  let index = 0;
  return {
    current: () => entries[index],
    back: () => index > 0 ? entries[--index] : undefined,
    forward: () => index + 1 < entries.length ? entries[++index] : undefined,
    canBack: () => index > 0,
    canForward: () => index + 1 < entries.length,
    visit(href: unknown, replace = false): boolean {
      if (typeof href !== 'string' || href.length > 8192) return false;
      let url: URL;
      try { url = new URL(href); } catch { return false; }
      if (url.origin !== base.origin || url.pathname !== base.pathname || url.search !== base.search || url.username || url.password) return false;
      if (entries[index] === url.href) return true;
      if (replace) entries[index] = url.href;
      else {
        entries.splice(index + 1);
        entries.push(url.href);
        if (entries.length > 128) entries.shift();
        index = entries.length - 1;
      }
      return true;
    },
    display() {
      const url = new URL(entries[index]);
      url.searchParams.delete('embedOrigin');
      return url.href;
    },
  };
}
