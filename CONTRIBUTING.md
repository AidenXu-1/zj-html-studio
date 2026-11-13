# 参与贡献

感谢你愿意帮助改进 ZJ HTML Studio。

## 提交前

1. 行为变化或较大重构，请先创建 Issue 说明问题和预期结果。
2. 保持改动聚焦，保持独立网页来源、逐文件访问、敏感能力限制与现有资源预算。正常打开默认支持交互和联网。
3. 行为发生变化时，补充或更新对应测试。
4. 在本地运行完整检查：

```bash
npm ci
npm run check
```

页面通信改动还要运行真实 Chromium 检查，Linux CI 已包含此项：

```bash
npx playwright-core install chromium
npm run test:browser
```

讲义、投屏、窗口迁移或文件改名改动，还要运行 `npm run test:obsidian`。
页面搜索改动另运行 `npm run test:obsidian:search`，沿用同一显式测试仓库、调试端口和产物目录配置。它验证课件内快捷键、中文输入、跨页定位、讲义/投屏联动、上下处、清空、源码往返与刷新；不得连接日常知识库。
使用独立、可丢弃的测试库，根目录的 `.html-studio-runtime-test` 必须只有 `disposable-test-vault`；
以 `HTML_STUDIO_TEST_VAULT` 指定其绝对路径，以 `HTML_STUDIO_TEST_CDP` 指定独立 Obsidian 的调试地址（默认本机 9234）。
测试库应使用普通主窗口标签布局，并安装本次构建的插件。不要连接日常知识库。
脚本会建立自己的 47 页合成课件，验证延迟切页、投屏全屏与两端 Esc、内容版本、窗口移出/移回和慢保存时改名，最后删除自己的样本并恢复设置。
这项检查不包含扩展屏、会议共享或其他平台的真实 Obsidian 验收，不能用 Chromium 检查替代。

讲义编辑改动另运行 `npm run test:obsidian:lecture`，验证真实输入、格式、按页保存、失败恢复与冲突保护。单页讲义和问题面板运行 `npm run test:obsidian:page-info`，包含 5 MiB HTML 首次打开与刷新、侧栏反复展开、主题和缩放。两者沿用上述独立测试库约束；大文件选择当前文件夹安全打开，不授予整个知识库读取范围。

默认打开和文件访问改动运行 `npm run test:obsidian:resource-access`；它检查默认脚本与配套资源、单文件允许、刷新和投屏继承、撤回及重开失效。另运行 `npm run test:obsidian:access-regression`，检查额外图片撤权、范围收窄后的实际刷新、首次扩大路由范围后的页码、讲义和投屏同步。均沿用上述独立测试库约束，只使用合成文件，不连接日常知识库。

## Pull Request 说明

请写清楚：

- 要解决的用户问题
- 采用的实现方式
- 对安全与隐私的影响
- 已执行的验证
- 尚未覆盖的平台或场景

测试夹具、截图和日志中不得包含真实知识库内容、账号凭据、私有链接、本机绝对路径或其他个人数据。

固定画布适配运行 `npm run test:obsidian:canvas`，检查侧栏开合、窄/矮预览区、50%/100%/150% 控件和课件原生翻页。默认使用项目内合成夹具；可用 `HTML_STUDIO_CANVAS_SAMPLE` 显式指定项目内的用户样本副本，禁止直接传入日常知识库文件。全屏与原生 Esc 另用实际界面验收，CDP 键盘不能代替这一步。

显示器和投屏全屏改动运行 `npm run test:obsidian:display`，沿用明确标记的独立库；可用 `HTML_STUDIO_PROJECTION_SAMPLE` 指定项目内 47 页课件副本。结果记录真实显示器清单、是否自动投到外屏、画面边界、15 → 16 → 15、Esc 和关闭保页。默认主题及 Primary 主题均须核对。仅单屏时 `automatic: false` 属于窗口流程通过，不能作为 HDMI 扩展屏验收；最终仍需实际双屏确认。截图等待作者的有限入场动画结束，不改变课件动画。

其他页数用 `HTML_STUDIO_PROJECTION_PAGES` 指定；需要原样字体、图片和视频时，以 `HTML_STUDIO_PROJECTION_ASSETS` 指定项目内配套文件夹副本，测试将保留该文件夹名称复制到合成课程目录。不得指向日常知识库。

通用课件识别和画面投屏另运行 `node tests/runtime/universal-deck.mjs` 与 `node tests/runtime/picture-projection.mjs`，沿用上述三个 `HTML_STUDIO_TEST_*` 环境变量。覆盖原生按钮/输出键盘/讲义联动、刷新恢复、源窗口迁移、讲义关联、裁切区域、遮挡、切标签、缩放、全屏和结束清理。运行各套验收前关闭专用库遗留的合成课件标签，避免污染活动会话基线。

`tests/browser/framework-decks.browser.ts` 可选使用官方框架发布包。将 Reveal 5.2.1 解压为 `<assets>/reveal/`、Swiper 11.2.10 解压为 `<assets>/swiper/` 后，设置 `HTML_STUDIO_FRAMEWORK_ASSETS=<assets>` 再运行浏览器检查。资产只放项目内 `scratch/`，不进入生产依赖或提交；未提供时明确跳过这组框架检查。
