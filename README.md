# ZJ HTML Studio

Open local HTML in Obsidian, edit slide notes in the sidebar, and present the course in a separate window.

English · [简体中文](README.zh-CN.md)

## Install

1. Open **Settings → Community plugins → Browse** in Obsidian.
2. Search for **ZJ HTML Studio**, install it, and enable it.
3. Click an `.html` or `.htm` file in your vault's file list.

Requires **Obsidian 1.12.7 or later on desktop**. No account or payment is required. For manual installation, download `main.js`, `manifest.json`, and `styles.css` from the same [GitHub Release](https://github.com/AidenXu-1/zj-html-studio/releases), place them in `<vault>/.obsidian/plugins/zj-html-studio/`, and enable the plugin.

## Preview and search

- Open HTML in native tabs, with local images, styles, scripts, fonts, audio, and video.
- Buttons, animations, navigation, and online resources work by default. Saved restrictions still apply.
- Search loaded text across recognized slides. Previous and next results move between matching pages; the result menu jumps directly to a page. Ordinary pages and source view use text matches.
- Zoom the whole page from **50% to 200%**. At 100%, the preview uses its normal fitted size. Smaller views are centered; enlarged views can be scrolled.
- Switch to read-only source, refresh manually, or reload automatically when referenced files change.
- Use **Fullscreen** on your computer. **Esc** returns to the original tab and page.

The toolbar contains Preview/Source, zoom, search, refresh, fullscreen, notes, presentation, and More. Less frequent actions include Open in browser, Locate source file, Page information and issues, Page permissions, and automatic reload. Narrow panes move hidden actions into More without duplicating them.

## Edit slide notes

Click **讲义** (Notes) to write directly in the right sidebar, alongside Obsidian's outline. Click a paragraph to edit it; inactive blocks render as Markdown. Changes save automatically, with drafts retained if saving fails.

Each course uses one ordinary Markdown note. Opening a course or its sidebar does **not** create an empty file. The first non-empty edit creates a note in the managed **讲义库** folder. You can associate an existing note from the sidebar menu; it stays in its original location. Use second-level headings to separate pages:

```markdown
## 第 15 页 · Comparison

### Speaking prompts
Ask the audience first, then show the next page.

- First question
- Compare the responses

## 第 16 页

Continue the demonstration.
```

Notes follow recognized slides. The bottom field accepts a page number; its menu shows at most five rows and scrolls for longer decks. If the course cannot be controlled, the picker selects notes manually. The next recognized course change resumes following. Unrecognized single-page HTML keeps `1 / 1` and disabled arrows. Update note headings when you add, remove, or reorder course pages.

## Present on another display

1. Connect your display and choose **extended desktop** in the operating system.
2. Open the original course and go to the page you want to present.
3. Click **投屏演示** (Present). A course-only window starts from that page. When an independent display is available, it moves there and enters fullscreen; your computer keeps the course and notes.
4. Navigate on your computer. Click **结束投屏** (End presentation) to close the output and continue on the current page.

Without an independent display, the presentation window stays available to move manually. Double-click its course area or use its fullscreen action. Meeting software can share this window separately. Esc in the output exits that window's fullscreen. On macOS, presentation uses fullscreen on the selected display without moving the main workspace into another fullscreen Space.

Numbered decks with reliable controls use a separate page-synchronized course session. Other supported frameworks and HTML use a live picture of the visible course region. The picture pauses when the source is hidden or covered, and resumes when visible. Moving the source to another window ends picture presentation; start it again from the new window. The output preserves aspect ratio and excludes notes and the desktop. Audio continues on the computer. This mode is for teaching, not high-frame-rate video sharing. Page-synchronized output does not synchronize video position or form state.

## Embed in Markdown

```markdown
![[course.html]]
![[course.html|760]]
![[course.html|760x430]]
```

Without dimensions, the embed uses the note width and a 480px height. One number sets width; two set width and height. Embeds shrink proportionally in narrower notes. They load lazily and release sessions offscreen, with at most eight active embeds. Canvas embeds are not supported; an action opens the HTML in a tab instead.

## Privacy and review disclosures

**Plugin network use:** no vault content is sent to a developer-operated service. **Telemetry, ads, and updates:** none. The plugin does not collect telemetry, show ads, require an account, or update itself outside Obsidian.

- **Local server:** binds only to `127.0.0.1` on a random port. Previews have isolated sessions. Closing the last preview or disabling the plugin stops it.
- **Direct filesystem access:** reads HTML and streams local resources, resolves real paths, and verifies file identity. These checks prevent directory traversal and symbolic-link escapes. The original HTML is not rewritten. Markdown notes are saved through Obsidian's vault APIs.
- **Vault file enumeration:** locates and maintains course/notes associations. It does not automatically authorize HTML to read other notes.
- **File access:** the entry HTML, common companion resources, and recognized references are allowed. Additional notes and data files require individual permission, valid only for that course session. Hidden files and Obsidian's configuration directory stay protected. Incomplete analysis never grants blanket vault access.
- **Networking:** HTML can load online resources by default. Use More → Page permissions to restrict unfamiliar pages. Networking does not grant clipboard, camera, or microphone access.
- **Clipboard:** copying an unsaved notes draft writes only after you request it. HTML clipboard writing requires a separate permission. The plugin does not read clipboard contents.
- **Restricted modes:** safe reading disables user scripts. Local interaction blocks common HTTP requests and remote resources, but navigation and WebRTC can still make network connections. It is not an offline guarantee.
- **Storage:** preferences and relative course/notes associations use the plugin's `data.json`. Notes stay in ordinary Markdown and are never sent to the course or output. Diagnostics store paths and reasons, not page body text.

Marketplace capability disclosures describe these necessary operations. See [SECURITY.md](SECURITY.md) for private security reporting.

## Compatibility and limits

Page recognition covers continuous `p01…pNN` and `slide-01…slide-NN` identifiers, supported fixed-canvas decks, Reveal, Swiper, and mutually exclusive slides with arbitrary or missing IDs. Recognition and navigation are checked separately, using the author's controls and actual results. Articles containing carousels are not automatically treated as decks.

- A single HTML file can be up to **64 MiB**. Large media work best as separate resources. Bounded scanning and session limits prevent unbounded memory growth.
- Search reads loaded text, not image text or pages a virtual deck has not created. It skips script, style, and image data.
- HTML editing, automatic dark-mode rewriting, MHTML/MHT, and mobile devices are not supported.
- Markdown embedding depends on a host capability checked at startup. If removed in a future host, only embedding is disabled; HTML tabs remain available.

Actual macOS Obsidian checks cover notes, search, zoom, window migration, fullscreen exit, and presentation lifecycle. The presentation route has passed an HDMI extended-display check with notes on the computer and slides on the external screen. Actual meeting sharing and Windows/Linux native Obsidian sessions have not been verified. Cross-platform CI does not establish compatibility with every theme or display.

## Development

```bash
npm ci
npm run check
```

Checks run Obsidian ESLint, strict TypeScript, unit/integration tests, a production build, and release-asset validation. CI covers macOS, Windows, and Linux, with Chromium tests on Linux. Tests use fictional fixtures; runtime scripts require an explicitly marked disposable vault. Installation files bundle the notes editor; users do not install dependencies.

Source is in `src/`, tests in `tests/`, and workflows in `.github/workflows/`. Dependency locks allow reproducible builds. Generated packages, dependencies, logs, environment files, and personal vault contents are excluded from Git.

## Feedback and license

- [Issues and feature requests](https://github.com/AidenXu-1/zj-html-studio/issues)
- [Security reporting](SECURITY.md)
- [Release history](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [MIT License](LICENSE)
