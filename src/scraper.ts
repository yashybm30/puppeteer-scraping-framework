import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import puppeteer from "puppeteer";
import robotsParser from "robots-parser";
import { z } from "zod";
export const sourceSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]{2,50}$/),
  url: z.string().url(),
  itemSelector: z.string().min(1).max(200),
  fields: z.record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/),
    z.string().min(1).max(200),
  ),
  maxItems: z.number().int().min(1).max(100).default(20),
});
export type Source = z.infer<typeof sourceSchema>;
function privateIP(ip: string) {
  if (isIP(ip) === 6)
    return (
      ip === "::1" ||
      ip === "::" ||
      /^(fc|fd|fe80)/i.test(ip) ||
      ip.includes("::ffff:")
    );
  const a = ip.split(".").map(Number);
  return (
    a[0] === 0 ||
    a[0] === 10 ||
    a[0] === 127 ||
    (a[0] === 169 && a[1] === 254) ||
    (a[0] === 172 && a[1]! >= 16 && a[1]! <= 31) ||
    (a[0] === 192 && a[1] === 168) ||
    a[0]! >= 224
  );
}
export async function allowedUrl(raw: string) {
  const url = new URL(raw);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Unsupported target URL");
  const hosts = (process.env.SCRAPE_ALLOWED_HOSTS ?? "books.toscrape.com")
    .split(",")
    .map((s) => s.trim());
  if (!hosts.includes(url.hostname))
    throw new Error("Target host is not allowlisted");
  const addresses = await lookup(url.hostname, { all: true });
  if (
    process.env.ALLOW_PRIVATE_TARGETS !== "true" &&
    addresses.some((a) => privateIP(a.address))
  )
    throw new Error("Private target blocked");
  return url;
}
export async function scrape(input: Source) {
  const source = sourceSchema.parse(input),
    url = await allowedUrl(source.url);
  const robotsUrl = new URL("/robots.txt", url);
  const robotsResponse = await fetch(robotsUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (robotsResponse.status !== 404 && !robotsResponse.ok)
    throw new Error("Cannot verify robots.txt");
  const rules = robotsParser(
    robotsUrl.href,
    robotsResponse.status === 404 ? "" : await robotsResponse.text(),
  );
  if (rules.isAllowed(url.href, "PortfolioScraper") === false)
    throw new Error("robots.txt disallows this URL");
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: process.env.ALLOW_NO_SANDBOX === "true" ? ["--no-sandbox"] : [],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("PortfolioScraper/1.0 (+respect-robots)");
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (
        ["image", "font", "media", "stylesheet"].includes(
          request.resourceType(),
        )
      ) {
        void request.abort();
        return;
      }
      void allowedUrl(request.url())
        .then(() => request.continue())
        .catch(() => request.abort());
    });
    await page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page.waitForSelector(source.itemSelector, { timeout: 5000 });
    const items = await page.$$eval(
      source.itemSelector,
      (elements, settings) =>
        elements
          .slice(0, settings.maxItems)
          .map((element) =>
            Object.fromEntries(
              Object.entries(settings.fields).map(([key, selector]) => [
                key,
                (element.querySelector(selector)?.textContent ?? "")
                  .trim()
                  .slice(0, 5000),
              ]),
            ),
          ),
      { maxItems: source.maxItems, fields: source.fields },
    );
    return {
      source: source.name,
      url: url.href,
      scrapedAt: new Date().toISOString(),
      items,
    };
  } finally {
    await browser.close();
  }
}
