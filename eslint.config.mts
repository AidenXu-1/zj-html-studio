import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist",
    "esbuild.config.mjs",
    "scripts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "versions.json"
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mts", "manifest.json"]
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"]
      }
    }
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["tests/**/*.ts"],
    rules: {
      "obsidianmd/no-global-this": "off",
      "obsidianmd/prefer-window-timers": "off"
    }
  },
  {
    files: ["tests/browser/*.browser.ts"],
    rules: {
      // These run in plain Chromium, where Obsidian's createEl does not exist.
      "obsidianmd/prefer-create-el": "off"
    }
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["tests/runtime/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, app: "readonly" },
      parserOptions: { project: false, projectService: false }
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // The external runner intentionally inspects the marked test app.
      "no-restricted-globals": "off",
      "obsidianmd/prefer-window-timers": "off"
    }
  }
);
