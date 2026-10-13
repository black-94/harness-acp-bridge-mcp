import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

describe("npm release metadata", () => {
  it("keeps the scoped package identity and lockfile in sync", () => {
    expect(manifest.name).toBe("@black942026/harness-acp-bridge-mcp");
    expect(manifest.private).not.toBe(true);
    expect(manifest.publishConfig.access).toBe("public");
    expect(lock.name).toBe(manifest.name);
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""].name).toBe(manifest.name);
    expect(lock.packages[""].version).toBe(manifest.version);
  });

  it("publishes a stdio executable and depends on the HTTP server package", () => {
    expect(manifest.bin["harness-acp-bridge-mcp"]).toBe("dist/main.js");
    expect(manifest.files).toContain("dist");
    expect(manifest.files).not.toContain("test");
    expect(manifest.dependencies["@black942026/harness-acp-bridge-server"]).toBeDefined();
    expect(manifest.dependencies["@black942026/harness-acp-bridge-pi-extension"]).toBeUndefined();
    expect(manifest.devDependencies["@black942026/harness-acp-bridge-pi-extension"]).toBeUndefined();
    const server = JSON.parse(readFileSync(new URL("../node_modules/@black942026/harness-acp-bridge-server/package.json", import.meta.url), "utf8"));
    expect(server.exports["."]).toBe("./dist/index.js");
  });
});
