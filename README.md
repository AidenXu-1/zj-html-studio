# ZJ HTML Studio

Preview local `.html` and `.htm` files directly in Obsidian with scoped file access, isolated tabs, live reload, diagnostics, and full screen support.

ZJ HTML Studio is a desktop-only community plugin for people who keep course pages, presentation decks, newsletter layouts, and other HTML output inside their vault.

## Features

- Open `.html` and `.htm` files in native Obsidian tabs.
- Load local images, stylesheets, scripts, modules, fonts, audio, and video without rewriting the source HTML.
- Resolve same-folder, child-folder, and parent-folder resources while keeping access inside the vault.
- Keep multiple HTML tabs isolated with a unique local origin and resource scope for each preview.
- Reload only previews affected by a changed HTML dependency.
- Explain missing or blocked resources with actionable diagnostics.
- Open an independently authorized short-lived session in the system browser.
- Reveal the source file in the operating system file manager.
- Enter full screen even when the HTML page has no full screen controls of its own.

## Requirements

- Obsidian 1.12.7 or later.
- Obsidian desktop on macOS, Windows, or Linux.
- A vault backed by a local file-system folder.

The current release has been tested in Obsidian 1.12.7 on macOS. Automated checks run on macOS, Windows, and Linux. Mobile is not supported because the plugin uses Node.js and Electron APIs.

## Usage

1. Enable ZJ HTML Studio in **Settings → Community plugins**.
2. Select an `.html` or `.htm` file in the file explorer.
3. Review the resource scope shown in the toolbar.
4. Keep **Safe read-only** for unknown HTML. Use **Trusted compatibility** only for pages you created or reviewed.

The toolbar provides reload, live reload, browser, full screen, source file, security mode, resource scope, and diagnostics controls.

## Security model

### Safe read-only

Safe read-only is the default. It displays local layout and media while disabling page scripts, background network requests, external subresources, forms, nested pages, workers, and clipboard access through both iframe sandboxing and Content Security Policy.

Links and page navigation may still leave the local preview address. Inspect unknown HTML before following links.

### Trusted compatibility

Trusted compatibility allows scripts, modules, network requests, and clipboard writes required by interactive pages. It still isolates the page from the Obsidian application window and limits local file reads to the resource scope shown in the toolbar.

A trusted page can send data to remote services selected by that page. Only enable this mode for HTML you trust.

### Local preview service

The plugin starts a short-lived HTTP service bound only to `127.0.0.1` on a random port. Every preview receives a separate 128-bit random host token and a calculated resource scope. Directory listing, wildcard CORS, paths outside the vault, and symbolic-link escapes are blocked. The service stops after the last preview and browser session closes or the plugin unloads.

## Privacy and required disclosures

- **Accounts and payment:** No account or payment is required.
- **Plugin network use:** The plugin does not contact a developer-operated service. It uses a local loopback connection for rendering. HTML opened in Trusted compatibility mode may contact remote services referenced by that HTML.
- **File access:** The plugin reads the selected HTML file and its required resources inside the displayed vault scope. It does not read files outside the vault. The **Source file** action asks the operating system to reveal the selected vault file.
- **Stored data:** Obsidian stores the live-reload preference and explicitly trusted or safe folder scopes in the plugin's `data.json` file.
- **Telemetry, ads, and updates:** The plugin contains no telemetry, analytics, advertising, or self-update mechanism.
- **Content changes:** The plugin does not modify HTML files or their dependencies.

## Installation

### Community plugins

After the plugin is accepted into the Obsidian Community directory, install it from **Settings → Community plugins → Browse** and search for **ZJ HTML Studio**.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the matching GitHub release and place them in:

```text
<vault>/.obsidian/plugins/zj-html-studio/
```

Restart Obsidian, then enable **ZJ HTML Studio** under Community plugins.

## Development

```bash
npm ci
npm run check
```

`npm run check` runs the official Obsidian ESLint rules, strict TypeScript checks, the automated test suite, a production build, and release-asset validation.

Build artifacts are written to `dist/` and are intentionally excluded from Git history. GitHub releases contain the installable assets.

## Support and security

- Report bugs and request features through [GitHub Issues](https://github.com/AidenXu-1/zj-html-studio/issues).
- Report security concerns according to [SECURITY.md](SECURITY.md).
- See release history in [CHANGELOG.md](CHANGELOG.md).

## 中文简介

ZJ HTML Studio 让保存在 Obsidian 仓库里的课程、分享会、公众号排版和其他 HTML 成品可以直接在原生标签页中预览。默认“安全只读”关闭脚本和后台联网；只有你主动选择“可信兼容”后，页面才可以运行脚本、联网并读取界面显示的资源范围。

## License

See [LICENSE](LICENSE).
