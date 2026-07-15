import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const targetVersion = process.env.npm_package_version;
if (!targetVersion || !/^\d+\.\d+\.\d+$/.test(targetVersion)) {
  throw new Error("npm_package_version must use x.y.z format.");
}

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
manifest.version = targetVersion;
await writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(await readFile("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
await writeFile("versions.json", `${JSON.stringify(versions, null, 2)}\n`);
