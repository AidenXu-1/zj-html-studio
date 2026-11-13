<h1 align="center">ZJ HTML Studio</h1>

<p align="center"><strong>让保存在 Obsidian 仓库里的 HTML 成品，像 Markdown 一样直接打开。</strong></p>

<p align="center">课程页面 · 分享会 · 公众号排版 · 交互演示</p>

> 0.4.21：直接预览 HTML、右栏逐页讲义、独立窗口投屏，以及跨页搜索和整体缩放。

## English overview

ZJ HTML Studio lets Obsidian Desktop open local `.html` and `.htm` files in native tabs. It supports scoped local resources, interactive online previews by default, optional restricted modes, live reload, read-only source view, page zoom, in-page search, fullscreen, and Markdown embeds.

The native right-sidebar **讲义** tab lets you edit slide notes directly while a separate presentation window shows the course. Notes are ordinary Markdown sections such as `## 第 15 页` and stay in the local sidebar. Page recognition supports existing numbered decks, Reveal, Swiper and mutually exclusive slide layouts with arbitrary or missing IDs. Navigation uses the author's controls and confirms the actual page. Other HTML files can still present their visible course region as a live picture, without sharing the notes or desktop. No original HTML changes are required.

### Installation and usage

1. Install **ZJ HTML Studio** from **Settings → Community plugins → Browse**, or download `main.js`, `manifest.json`, and `styles.css` from the matching [GitHub Release](https://github.com/AidenXu-1/zj-html-studio/releases) and place them in `<vault>/.obsidian/plugins/zj-html-studio/`.
2. Enable the plugin in **Settings → Community plugins**.
3. Click an `.html` or `.htm` file in the file explorer to preview it.
4. Buttons, navigation, animations, and online content work by default. Use **More → Page permissions** to turn off page interaction or networking for unfamiliar files. Existing saved restrictions are preserved. Extra local notes and data files require individual permission; networking does not grant clipboard, camera, or microphone access.
5. To embed a page in Markdown, use `![[page.html]]`, `![[page.html|760]]`, or `![[page.html|760x430]]`.

The plugin is desktop-only and requires Obsidian 1.12.7 or later. It does not collect telemetry or send vault content to a developer-operated service. Local previews bind only to `127.0.0.1` and are limited to the resource scope available under **More → Page permissions**.

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
- 页面可在 50% 到 200% 之间整体缩放，100% 保持默认适配，缩小时居中、放大后可滚动查看；支持 `Ctrl/Cmd+F` 查找、上一处和下一处。
- 可识别页码的课件会查找整份已生成内容，按命中页前后切换，也可点结果数字直接选页；讲义和投屏跟随翻页。图片里的文字、未生成的动态内容与不可访问的区域不在查找范围内。
- 在 Markdown 中嵌入 HTML，支持默认尺寸、指定宽度和指定宽高。
- 笔记内嵌采用延迟加载、离屏回收和全局 8 会话上限，避免长笔记无界占用资源。

## 直接打开与文件访问

点击 HTML 即可使用按钮、翻页、动画和在线内容，不需要先选择打开模式。

自动加载课件本身、同目录常见配套资源及已识别的常见引用资源。其他笔记、数据文件需要在 **更多 → 页面信息与问题** 中逐个允许；只开放选中的文件，关闭课件后失效。文件较大或资源分析未完成，都不会自动开放整个知识库。

联网不会自动开放剪贴板、摄像头或麦克风。需要复制时，可以在 **更多 → 页面权限…** 单独允许剪贴板写入；也可主动关闭联网或页面交互。已记住的文件夹规则仍然生效，设置中的默认开关控制没有例外规则的 HTML。

## 快速使用

1. 在 **设置 → 第三方插件** 中启用 ZJ HTML Studio。
2. 在文件列表中点击 `.html` 或 `.htm` 文件。
3. 直接查看、翻页和操作课件。
4. 需要查看或调整允许的功能时，打开 **更多 → 页面权限…**。

工具栏保持一行：预览/源码、缩放、查找、刷新、全屏、讲义、投屏和更多。**文件改动时自动刷新、在浏览器中打开、定位源文件、页面信息与问题** 收在更多菜单；查找、刷新仅在窄面板隐藏了外部按钮时出现在这里，避免重复入口。本地文件访问说明收在权限和页面信息里。

### 逐页讲义与投屏演示

1. 照常打开原来的 HTML 课件。点击工具栏的 **讲义**，直接在右栏写下提示，或从右上角关联已有笔记。右栏讲义和 Obsidian 原有大纲并存。
2. 每份课件配一篇普通 Markdown 笔记，以 `## 第 1 页`、`## 第 2 页` 等二级标题区分页码。标题后可以加说明，每页下面自由写提示、大纲或其他 Markdown 内容。直接点击正文编辑，自动保存；不编辑的段落显示排版。首次写入时自动创建在统一的“讲义库”目录，已有讲义保留原位置；右上角可打开完整笔记。
3. 已关联课件再次打开时自动显示讲义。课件自己的翻页按钮、键盘翻页、目录跳页，以及讲义栏底部的页码输入都会联动。底部下拉最多显示五行，更多页面在列表内滚动；保存失败会保留草稿并给出重试入口。
4. 连接外接显示器，并在系统中选择 **扩展显示器**。点击 **投屏演示**，独立窗口从当前页自动移到外屏并全屏，本机继续保留课件和讲义。macOS 使用原位全屏，避免把本机切到另一个全屏桌面。未找到独立外屏时保留演示窗口；可手动移动、双击画面或点击“全屏演示”，线上会议可单独共享此窗口。
5. 本机翻页会同步到投屏。开始后，本机按钮变为 **结束投屏**，点击即可关闭投屏窗口；查看源码时也能结束。关闭输出窗口或使用其中的“结束投屏”同样有效，本机保留当前页和讲义，可以继续讲课或重新投屏。
6. 原 **全屏** 用于本机查看课件效果，按 **Esc** 返回原标签页和页码；投屏窗口中的 Esc 只退出该窗口的全屏。

```markdown
## 第 15 页 · 现场比较

### 讲述提示
先让大家回答，再展示下一页。

### 本页大纲
- 第一次提问
- 观察回答的区别
```

页码识别支持连续 `p01…pNN`、`slide-01…slide-NN`、已有固定画布课件，以及 Reveal、Swiper 和任意名称或无 ID 的互斥页面。插件分别判断总页数、当前页和能否跳转，通过课件原有接口或按钮翻页，以实际显示结果确认，不改原文件。普通文章、文章里的轮播和存在多个独立轮播的页面不会被随意当成课件。

能识别当前页但不能控制翻页时，讲义仍会自动跟随；手动选页只切换讲义，课件下一次翻页后恢复跟随。未识别分页时默认 `1 / 1`，保留灰色翻页按钮；若关联了多页讲义，可手动选讲义页。只打开不创建文件，首次实际写入才生成 Markdown。增加、删除或重排课件页后，请同时维护讲义页码。

原有连续编号和按键课件沿用独立页码同步，不同步页内视频进度或表单。新增框架与其他 HTML 自动采用课件区域的实时画面，不增加模式选择。切到其他标签、课件被菜单遮挡时保留上一帧，恢复可见后继续；把源课件移到另一窗口会结束本次投屏，需要重新开始。画面按比例完整显示，声音仍由本机播放。当前画面模式主要用于讲课，不是高帧率视频共享。

预览、页面查找和逐页投屏共用 64 MiB 的单文件上限。搜索只处理已加载的可读文字，跳过图片数据、脚本和样式，并分段执行；保留独立的文字量、节点数和匹配数保护。虚拟课件尚未生成的页面文字无法提前搜索。全屏会按课件自身布局适配窗口；响应式演示课件可以等比完整显示，插件不会改写原 HTML 的排版。

### 在笔记里嵌入

```markdown
![[course.html]]
![[course.html|760]]
![[course.html|760x430]]
```

- 第一种使用笔记宽度和 480px 默认高度。
- 第二种指定宽度，高度仍为默认值。
- 第三种指定宽高，笔记变窄时会按比例缩小。

嵌入同样默认支持交互和联网，并沿用已有文件夹例外。额外文件可在 HTML 标签页中逐个允许。Canvas 预览本轮未开启，会提供“在标签页打开”按钮。

## 隐私与安全

插件以本地优先和最小权限为设计前提：

- **账号与付费**：不需要注册账号，不包含付费功能。
- **插件自身联网**：不会连接开发者运营的服务器，也没有云端处理流程。
- **本地预览服务**：只绑定 `127.0.0.1`，使用系统随机端口；最后一个预览关闭或插件停用后自动停止。
- **文件读取**：按文件核验入口、配套资源与明确允许的额外文件；不因路由目录覆盖知识库而开放其中的笔记。隐藏配置和 Obsidian 配置目录不会随课件开放，仍阻止仓库越界、目录遍历和符号链接逃逸。
- **常见远程访问**：正常打开默认支持 HTTP/API 请求和远程资源；可在页面权限中关闭常见联网通道。
- **本地交互的边界**：Obsidian 1.12.7 实机探针表明当前 Chromium 不执行 `webrtc 'none'`。本地交互会阻止已列出的常见请求通道，但 WebRTC 仍可产生网络活动。
- **本地存储**：通过插件的 `data.json` 保存自动刷新偏好、用户明确记住的目录规则，以及 HTML 与讲义笔记的相对路径关联；讲义正文保存在用户选择的普通 Markdown 笔记里。
- **讲义与投屏**：讲义正文不会发送到课件或投屏窗口。投屏沿用本机当前课件的资源范围和权限；关闭来源、撤回交互权限、结束投屏或停用插件后关闭对应投屏会话。
- **内容处理**：不修改 HTML 及其依赖，不保存页面正文副本。
- **页内查找**：安全模式只运行插件注入、带一次性密钥的最小查找桥；用户 HTML 里的脚本仍会被阻止。
- **查找结果**：安全只读在有界预检后使用 Chromium 原生定位；本地交互与可信兼容使用可取消、分片执行的有界 DOM 定位。正常结果显示命中页或位置，实际扫描不完整时才说明具体限制，避免巨大页面卡住 Obsidian。源码模式提供精确计数。
- **HTML 大小**：为保证编码验证、并发保存和实际响应使用同一份内容，单个 HTML 上限为 64 MiB；最多同时保留两份快照，正常的多标签恢复会进入有界等待队列。较大的图片、视频和字体应拆为独立资源文件。
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
- `0.4.21` 已在 macOS 真实 Obsidian 中完成右栏编辑、页码同步、跨窗口移动、全屏退出和连续开启/关闭投屏检查。
- 同一投屏路线已完成 HDMI 扩展屏实测：外屏只显示课件，本机保留讲义，15 → 16 → 15 同步且结束后保留当前页。会议软件实际共享尚未验证。
- 当前本地验证包含 32 个测试文件、390 项自动测试、51 项 Chromium 检查，以及 lint、类型检查、生产构建和发布资产校验。公开 CI 覆盖 macOS、Windows、Linux；每次运行结果见仓库 Actions。

Markdown HTML 嵌入会在启动时检查当前 Obsidian 是否提供扩展嵌入能力。若未来版本取消该能力，只会停用笔记内嵌并给出提示，HTML 原生标签页与其他功能仍可继续使用。

Windows 与 Linux 尚未完成真实 Obsidian 实机验收。自动检查通过不代表所有显示器、主题和系统组合都已实测。

## 开发与验证

```bash
npm ci
npm run check
```

`npm run check` 会依次执行：

1. Obsidian 官方 ESLint 规则
2. TypeScript 严格类型检查
3. 32 个测试文件、390 项自动测试
4. 最小化生产构建
5. Release 安装文件一致性检查

安装包已包含所需的讲义编辑组件，无需另行安装依赖。`node_modules/`、`dist/`、本地设置、日志和环境变量文件均不会进入 Git 历史。

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
