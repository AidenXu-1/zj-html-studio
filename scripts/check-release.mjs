import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}

async function fileExists(relativePath) {
  try {
    await access(path.join(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

for (const requiredFile of [
  "README.md",
  "LICENSE",
  "manifest.json",
  "versions.json",
  "dist/main.js",
  "dist/manifest.json",
  "dist/styles.css"
]) {
  check(await fileExists(requiredFile), `Missing required release file: ${requiredFile}`);
}

const manifest = await readJson("manifest.json");
const packageJson = await readJson("package.json");
const versions = await readJson("versions.json");
const semverPattern = /^\d+\.\d+\.\d+$/;

check(/^[a-z-]+$/.test(manifest.id), "manifest.id must contain only lowercase letters and hyphens.");
check(!manifest.id.includes("obsidian"), "manifest.id must not contain obsidian.");
check(!manifest.id.endsWith("plugin"), "manifest.id must not end with plugin.");
check(typeof manifest.name === "string" && manifest.name.length > 0, "manifest.name is required.");
check(/^[\x20-\x7E]+$/.test(manifest.name), "manifest.name must use Basic Latin characters.");
check(!/obsidian/i.test(manifest.name), "manifest.name must not include Obsidian.");
check(!/\bplugin\b/i.test(manifest.name), "manifest.name must not include Plugin.");
check(semverPattern.test(manifest.version), "manifest.version must use x.y.z format.");
check(semverPattern.test(manifest.minAppVersion), "manifest.minAppVersion must use x.y.z format.");
check(typeof manifest.description === "string" && manifest.description.length <= 250, "manifest.description must be 250 characters or fewer.");
check(manifest.description.endsWith("."), "manifest.description must end with a period.");
check(typeof manifest.author === "string" && manifest.author.length > 0, "manifest.author is required.");
check(manifest.isDesktopOnly === true, "manifest.isDesktopOnly must remain true while using Node.js or Electron APIs.");
check(packageJson.name === manifest.id, "package.json name must match manifest.id.");
check(packageJson.version === manifest.version, "package.json version must match manifest.version.");
check(packageJson.license && packageJson.license !== "UNLICENSED", "package.json must declare the chosen license.");
check(versions[manifest.version] === manifest.minAppVersion, "versions.json must map the current plugin version to minAppVersion.");
check(!packageJson.dependencies || Object.keys(packageJson.dependencies).length === 0, "Runtime dependencies require an explicit release review.");

if (await fileExists("dist/manifest.json")) {
  const distManifest = await readJson("dist/manifest.json");
  check(JSON.stringify(distManifest) === JSON.stringify(manifest), "dist/manifest.json must exactly match manifest.json.");
}

if (await fileExists("dist/main.js")) {
  const mainJs = await readFile(path.join(ROOT, "dist/main.js"), "utf8");
  const mainStats = await stat(path.join(ROOT, "dist/main.js"));
  check(mainStats.size > 1_000, "dist/main.js is unexpectedly small.");
  check(!mainJs.includes("sourceMappingURL="), "Release main.js must not contain a source map.");
}

if (await fileExists("dist/styles.css")) {
  const stylesStats = await stat(path.join(ROOT, "dist/styles.css"));
  check(stylesStats.size > 0, "dist/styles.css must not be empty.");
}

const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
for (const disclosure of ["Plugin network use", "File access", "Telemetry, ads, and updates"]) {
  check(readme.includes(disclosure), `README is missing required disclosure: ${disclosure}`);
}

const releaseTag = process.env.RELEASE_TAG ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
if (releaseTag) {
  check(releaseTag === manifest.version, `Release tag ${releaseTag} must exactly match manifest.version ${manifest.version}.`);
}

if (errors.length > 0) {
  console.error("Release validation failed:\n");
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`Release validation passed for ${manifest.id} ${manifest.version}.`);
