import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface PluginManifest {
  id: string;
  isDesktopOnly: boolean;
  minAppVersion: string;
  name: string;
  version: string;
}

interface PackageMetadata {
  name: string;
  version: string;
}

describe("plugin kickoff", () => {
  it("uses the confirmed plugin identity and desktop boundary", async () => {
    const [manifestSource, packageSource, versionsSource] = await Promise.all([
      readFile("manifest.json", "utf8"),
      readFile("package.json", "utf8"),
      readFile("versions.json", "utf8")
    ]);
    const manifest = JSON.parse(manifestSource) as PluginManifest;
    const packageMetadata = JSON.parse(packageSource) as PackageMetadata;
    const versions = JSON.parse(versionsSource) as Record<string, string>;

    expect(manifest.id).toBe("zj-html-studio");
    expect(manifest.name).toBe("ZJ HTML Studio");
    expect(manifest.version).toBe("0.2.0");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.minAppVersion).toBe("1.12.7");
    expect(manifest.isDesktopOnly).toBe(true);
    expect(packageMetadata).toMatchObject({ name: manifest.id, version: manifest.version });
    expect(versions).toMatchObject({ [manifest.version]: manifest.minAppVersion });
  });
});
