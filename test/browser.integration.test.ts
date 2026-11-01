import { test, expect } from "vitest";
import { createServer } from "node:http";
import { scrape } from "../dist/scraper";
test("Chromium extracts structured records and obeys robots disallow", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.end("User-agent: *\nDisallow: /private");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<article><h2>First</h2><p>12</p></article><article><h2>Second</h2><p>24</p></article>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  process.env.SCRAPE_ALLOWED_HOSTS = "127.0.0.1";
  process.env.ALLOW_PRIVATE_TARGETS = "true";
  const source = {
    name: "fixture",
    url: `http://127.0.0.1:${address.port}/`,
    itemSelector: "article",
    fields: { name: "h2", price: "p" },
    maxItems: 1,
  };
  try {
    const result = await scrape(source);
    expect(result.items).toEqual([{ name: "First", price: "12" }]);
    await expect(
      scrape({ ...source, url: source.url + "private" }),
    ).rejects.toThrow("robots.txt");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
