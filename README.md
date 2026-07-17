<h1 align="center">ZJ HTML Studio</h1>

<p align="center"><strong>让保存在 Obsidian 仓库里的 HTML 成品，像 Markdown 一样直接打开。</strong></p>

<p align="center">课程页面 · 分享会 · 公众号排版 · 交互演示</p>

## English overview

ZJ HTML Studio lets Obsidian Desktop open local `.html` and `.htm` files in native tabs. It supports scoped local resources, safe read-only, local interactive and trusted compatibility modes, live reload, read-only source view, page zoom, in-page search, fullscreen, and Markdown embeds.

### Installation and usage

1. Install **ZJ HTML Studio** from **Settings → Community plugins → Browse**, or download `main.js`, `manifest.json`, and `styles.css` from the matching [GitHub Release](https://github.com/AidenXu-1/zj-html-studio/releases) and place them in `<vault>/.obsidian/plugins/zj-html-studio/`.
2. Enable the plugin in **Settings → Community plugins**.
3. Click an `.html` or `.htm` file in the file explorer to preview it.
4. Keep unfamiliar files in **Safe read-only** mode. Use **Local interactive** only for local pages you created and inspected; it blocks common fetch/XHR/WebSocket traffic but does not claim absolute offline isolation for navigation or WebRTC. Use **Trusted compatibility** only when a reviewed page also needs remote resources or network APIs.
5. To embed a page in Markdown, use `![[page.html]]`, `![[page.html|760]]`, or `![[page.html|760x430]]`.

The plugin is desktop-only and requires Obsidian 1.12.7 or later. It does not collect telemetry or send vault content to a developer-operated service. Local previews bind only to `127.0.0.1` and are limited to the resource scope shown in the toolbar.

## 它解决什么

许多课程、分享会、公众号排版和 AI 生成页面最终都会变成 HTML 文件。文件虽然保存在 Obsidian 仓库里，却常常需要离开 Obsidian，再到 Finder 或浏览器中打开。

ZJ HTML Studio 为 `.html` 和 `.htm` 注册原生标签页视图。点击文件即可预览，页面依赖的图片、样式、脚本、字体和媒体资源也会在明确的仓库范围内加载。

| 原来的麻烦 | 使用 ZJ HTML Studio 后 |
|---|---|
| HTML 文件无法在 Obsidian 内直接查看 | 点击文件即可在原生标签页预览 |
| 父目录图片、样式或模块容易失效 | 自动分析依赖并计算最小资源范围 |
| 多个页面共用一个服务，容易互相干扰 | 每个预览拥有独立来源和会话 |
| 页面空白时难以判断原因 | 诊断面板会说明缺失资源和受限能力 |
| 页面没有全屏按钮 | 插件工具栏提供通用全屏 |
| 长页面不好找内容，源码又无法直接看 | 支持页内查找、页面缩放和只读源码 |
| HTML 只能单独打开，很难和笔记放在一起 | 可以用 `![[file.html]]` 直接嵌入 Markdown |

## 核心能力

- 在 Obsidian 原生标签页打开 `.html` 和 `.htm` 文件。
- 加载同目录、子目录和父目录中的图片、样式、脚本、模块、字体、音频与视频。
- 支持中文路径、空格、查询参数、哈希地址和媒体分段请求。
- 多个 HTML 标签彼此隔离，刷新一个页面不会切换其他页面的资源根目录。
- 根据依赖关系自动刷新，只重载真正受到文件变化影响的页面。
- 用大白话解释资源缺失、路径越界、权限受限和服务异常。
- 为系统浏览器创建独立、短时、需要再次授权的预览会话。
- 一键定位源文件，并为任何 HTML 提供插件级全屏。
- 在预览和只读源码之间切换，不改写磁盘上的 HTML。
- 页面可在 50% 到 200% 之间缩放，并支持 `Ctrl/Cmd+F` 查找、上一处和下一处。
- 在 Markdown 中嵌入 HTML，支持默认尺寸、指定宽度和指定宽高。
- 笔记内嵌采用延迟加载、离屏回收和全局 8 会话上限，避免长笔记无界占用资源。

## 三种打开模式

| 模式 | 适合什么页面 | 能做什么 |
|---|---|---|
| **安全只读**，默认 | 来源不明、只需查看排版的 HTML | 显示本地排版与媒体，关闭页面脚本、常见后台请求、外部子资源、表单、嵌套页面、Worker 和剪贴板能力 |
| **本地交互** | 你自己制作并检查过、靠 JavaScript 渲染正文的本地课件 | 允许页面脚本和当前资源范围中的脚本，阻止常见 fetch/XHR/WebSocket、外部子资源、Worker、嵌套页、表单、剪贴板和 `unsafe-eval`；页面导航及 WebRTC 不作绝对离线承诺 |
| **可信兼容** | 你自己制作或已经审查过的交互页面 | 允许脚本、模块、联网请求和剪贴板写入，同时继续限制页面只能读取工具栏显示的本地资源范围 |

三种模式中的链接或页面跳转都仍可能离开本地预览地址。本地交互会执行页面脚本，当前 Chromium 不会执行 `webrtc 'none'`，因此只用于自己制作并检查过的文件。陌生 HTML 保持安全只读。

如果页面的正文由 JavaScript 动态生成，安全只读会显示明确提醒和“本地交互打开”按钮，不再把纯背景或黑屏当成正常加载。

## 快速使用

1. 在 **设置 → 第三方插件** 中启用 ZJ HTML Studio。
2. 在文件列表中点击 `.html` 或 `.htm` 文件。
3. 查看工具栏显示的安全模式与资源范围。
4. 陌生页面保持“安全只读”；自己生成的本地脚本课件优先用“本地交互”；需要联网或远程资源时再使用“可信兼容”。

工具栏提供刷新、自动刷新、浏览器打开、全屏、源文件定位、安全模式、资源范围和诊断入口。

### 在笔记里嵌入

```markdown
![[course.html]]
![[course.html|760]]
![[course.html|760x430]]
```

- 第一种使用笔记宽度和 480px 默认高度。
- 第二种指定宽度，高度仍为默认值。
- 第三种指定宽高，笔记变窄时会按比例缩小。

嵌入会沿用文件夹的安全/本地交互/可信规则。安全只读检测到页面脚本时，可对当前嵌入临时切换到本地交互。若页面需要读取较大范围，会先显示确认入口。Canvas 预览本轮未开启，会提供“在标签页打开”按钮。

## 隐私与安全

插件以本地优先和最小权限为设计前提：

- **账号与付费**：不需要注册账号，不包含付费功能。
- **插件自身联网**：不会连接开发者运营的服务器，也没有云端处理流程。
- **本地预览服务**：只绑定 `127.0.0.1`，使用系统随机端口；最后一个预览关闭或插件停用后自动停止。
- **文件读取**：只读取当前仓库内、工具栏明确显示的资源范围；阻止仓库越界、目录遍历和符号链接逃逸。
- **常见远程访问**：只有切换到“可信兼容”后，页面才能使用常见 HTTP/API 请求和远程子资源。
- **本地交互的边界**：Obsidian 1.12.7 实机探针表明当前 Chromium 不执行 `webrtc 'none'`。本地交互会阻止已列出的常见请求通道，但 WebRTC 仍可产生网络活动。
- **本地存储**：仅通过插件的 `data.json` 保存自动刷新偏好，以及用户明确记住的安全、本地交互或可信目录规则。
- **内容处理**：不修改 HTML 及其依赖，不保存页面正文副本。
- **页内查找**：安全模式只运行插件注入、带一次性密钥的最小查找桥；用户 HTML 里的脚本仍会被阻止。
- **查找结果**：安全只读在有界预检后使用 Chromium 原生定位；本地交互与可信兼容使用可取消、分片执行的有界 DOM 定位，并明确标记“部分受限”，避免页面脚本制造的封闭区域或巨大 DOM 卡住 Obsidian。源码模式提供精确计数。
- **HTML 大小**：为保证编码验证、并发保存和实际响应使用同一份内容，单个 HTML 上限为 32 MiB；最多同时保留两份快照，正常的多标签恢复会进入有界等待队列。较大的图片、视频和字体应拆为独立资源文件。
- **日志与诊断**：诊断只记录路径和失败原因，不保存页面正文。
- **数据收集**：没有遥测、统计分析、广告、用户画像或自更新机制。
- **公开仓库隐私**：源码、测试和文档使用虚构夹具，不包含真实知识库内容、本机绝对路径、个人邮箱、访问令牌或真实工作截图。

## 安装

### Obsidian 第三方插件市场

插件已进入 Obsidian 官方社区插件目录，可在 **设置 → 第三方插件 → 浏览** 中搜索 **ZJ HTML Studio** 并安装。官方清单仍注明尚未经过 Obsidian staff 人工审核。

### 手动安装

从对应版本的 [GitHub Release](https://github.com/AidenXu-1/zj-html-studio/releases) 下载：

- `main.js`
- `manifest.json`
- `styles.css`

将三个文件放入：

```text
<你的仓库>/.obsidian/plugins/zj-html-studio/
```

重启 Obsidian，然后在第三方插件设置中启用 ZJ HTML Studio。

## 平台与兼容性

- 最低 Obsidian 版本：`1.12.7`
- 支持平台：macOS、Windows、Linux 桌面端
- 不支持移动端，因为插件使用 Node.js 与 Electron 能力
- `0.3.0` 已在 macOS / Obsidian 1.12.7 完成安全只读脚本提示、本地交互课件渲染与翻页、Markdown 嵌入、三态往返和最后会话回收的真实运行验收
- 当前完整门禁包含 20 个测试文件、288 项测试；CI 会在 macOS、Windows、Linux 执行同一套 lint、类型检查、测试、生产构建、发布资产校验和高危依赖审计

Markdown HTML 嵌入会在启动时检查当前 Obsidian 是否提供扩展嵌入能力。若未来版本取消该能力，只会停用笔记内嵌并给出提示，HTML 原生标签页与其他功能仍可继续使用。

Windows 与 Linux 已通过自动检查，但尚未完成真实 Obsidian 实机验收。

## 开发与验证

```bash
npm ci
npm run check
```

`npm run check` 会依次执行：

1. Obsidian 官方 ESLint 规则
2. TypeScript 严格类型检查
3. 20 个测试文件、288 项自动测试
4. 最小化生产构建
5. Release 安装文件一致性检查

插件没有运行时第三方依赖。当前生产安装文件合计约 235 KiB；`node_modules/`、`dist/`、本地设置、日志和环境变量文件均不会进入 Git 历史。

## 为什么仓库保留这些文件

- `src/`：插件正式源码。
- `tests/`：安全边界、跨平台路径、并发和生命周期的回归保护。
- `manifest.json`、`versions.json`：Obsidian 安装与版本兼容所需。
- `package-lock.json`：锁定构建依赖，保证审核和发布可以复现。
- `.github/workflows/`：三平台检查与可复现的 Release 构建。
- `SECURITY.md`、`CHANGELOG.md`、`CONTRIBUTING.md`：安全报告、版本变化和协作规则。

这些文件直接服务于安装、审核、安全或维护。构建缓存、依赖目录、真实仓库内容和内部研发资料不进入公开仓库。

## 反馈与安全报告

- 功能建议与普通问题：[GitHub Issues](https://github.com/AidenXu-1/zj-html-studio/issues)
- 安全漏洞：请按照 [SECURITY.md](SECURITY.md) 使用 GitHub 私密漏洞报告，不要在公开 Issue 中提交敏感内容
- 版本变化：[CHANGELOG.md](CHANGELOG.md)
- 参与贡献：[CONTRIBUTING.md](CONTRIBUTING.md)

## 开源许可

本项目使用 [MIT License](LICENSE)。
