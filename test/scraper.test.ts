import { test, expect } from "vitest";
import { sourceSchema, allowedUrl } from "../dist/scraper";
test("rejects unsafe configuration and non-allowlisted targets", async () => {
  expect(sourceSchema.safeParse({ url: "file:///etc/passwd" }).success).toBe(
    false,
  );
  await expect(allowedUrl("http://169.254.169.254/latest")).rejects.toThrow(
    "allowlisted",
  );
  await expect(allowedUrl("file:///etc/passwd")).rejects.toThrow();
});
