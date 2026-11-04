/** 保留反向代理路径，只打开 Dashboard，不把凭据带入浏览器地址。 */
export function dashboardUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Runmark endpoint must use HTTP or HTTPS");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.hash = "/summary";
  return url.href;
}
