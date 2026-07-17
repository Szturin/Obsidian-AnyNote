# Obsidian AnyNote

Obsidian AnyNote 是一个本地学习版 Obsidian 手写插件工程，目标是在 Obsidian 内提供接近 iPad 笔记软件的书写体验：手写区域、绘图区域、PDF 页级批注、中文 UI、触控笔优先输入、橡皮擦与框选等基础批注能力。

> 当前仓库包含从 `daledesilva/obsidian_ink` 复制并集成的代码，只能用于个人、本地、非商业学习实验。该上游仓库声明其主要代码和文档不是开源许可，采用 CC BY-NC-ND 4.0。未取得上游授权或完成 clean-room 重写前，不应公开发布、分发或推送派生代码。

## 当前功能

- 手写区域：在 Markdown 中插入和打开手写区域。
- 绘图区域：在 Markdown 中插入和打开绘图区域。
- 中文命令：常用命令已改为中文显示。
- PDF 手写批注：在 Obsidian 原生 PDF 页面上挂载页级 Canvas 标注层，不再把顶部控件或左侧缩略图当作书写区域。
- PDF 自动入口：打开 PDF 时默认在当前 PDF 页面内显示 AnyNote 手写工具栏，也可用左侧按钮、命令或右键菜单打开。
- PDF 工具：手/浏览、普通笔、原子笔、荧光笔、橡皮擦、框选、删除选中、撤销、重做、保存。
- PDF 工具栏状态：当前工具按钮会显示选中状态；切到“手/浏览”后可正常拖动和滚动 PDF。
- PDF 导出：可生成新的 `*.anynote.pdf`，将当前手写 stroke 作为矢量批注写入 PDF。
- PDF 手感优化：参考 tldraw/freehand 的笔迹模型，使用 Pointer Events、`pointerrawupdate`、`getCoalescedEvents()`、压力值、轮廓填充笔迹、短距预测层和 desynchronized canvas context 降低输入延迟。
- Pencil 连续性：对触控笔输入增加压力下限、采样补点和短暂断流续接，减少 Apple Pencil 书写时出现虚线/断线。
- 临时橡皮：支持可识别的硬件橡皮事件；设置开启时，橡皮使用结束后自动切回原书写工具。
- 橡皮回笔开关：可在插件设置中控制擦除后是否自动切回画笔。
- tldraw 书写/绘图橡皮：擦除动作完成后可按设置自动切回画笔工具。

## PDF 批注行为

PDF 批注目前是页级 JSON 批注：每条笔迹都会记录 PDF 页码、页面尺寸和页内坐标。工具栏直接浮在 Obsidian 的原生 PDF 视图内，书写 stage 会直接插入真实 PDF page DOM 内部，因此滚动、拖动和缩放时会跟随 PDF 页面。它不会直接修改原 PDF 文件。

保存后，批注数据写入插件目录：

```text
.obsidian/plugins/obsidian-anynote/pdf-annotations/*.json
```

这意味着：

- 不产生新的 PDF 附件。
- 不在 Markdown 中插入 SVG 附件。
- 原始 PDF 保持不变。
- 批注依赖插件读取 JSON 后按页重新绘制。

点击 `导出带批注 PDF` 时，插件会生成一个新的导出文件：

```text
原文件名.anynote.pdf
```

导出文件会把当前 JSON stroke 按页码写入对应 PDF 页面。当前实现不是截图叠加，因此缩放和打印质量比栅格导出更好。

## 命令

- `新建手写区域`
- `插入已有手写区域`
- `插入已复制手写区域`
- `新建绘图`
- `插入已有绘图`
- `插入已复制绘图`
- `PDF 手写批注`

打开 PDF 时默认会自动显示原生 PDF 浮动批注工具栏。工具栏内还有 `导出带批注 PDF` 按钮；如不想自动显示，可在设置中关闭 `打开 PDF 时自动进入批注`。

## 工程结构

```text
src/main.ts                         插件入口，注册命令、视图、嵌入和 PDF 批注
src/pdf/pdf-ink-modal.ts             PDF 原生视图页级 Canvas 批注实现
src/pdf/pdf-ink-modal.scss           PDF 批注界面样式
src/tldraw/writing/                  手写区域编辑器与预览
src/tldraw/drawing/                  绘图区域编辑器与预览
src/extensions/widgets/              Markdown 嵌入部件
src/commands/                        插入、创建手写和绘图文件命令
src/tabs/settings-tab/               插件设置页
LOCAL_LEARNING_NOTICE.md             本地学习和发布限制说明
docs/PROJECT_SUMMARY.md              工程总结
AGENTS.md                            后续代理开发说明
```

## 开发

```bash
npm install
npm run build
```

构建产物：

```text
main.js
styles.css
manifest.json
```

本地测试时，将这些文件放在 Obsidian vault 的插件目录：

```text
.obsidian/plugins/obsidian-anynote/
```

## 发布状态

当前状态不适合公开发布到 GitHub 或 Obsidian 社区插件列表，因为工程含有上游 `obsidian_ink` 的复制派生代码。安全发布路径有三种：

1. 获得上游作者明确授权。
2. 只发布不含复制代码的工程骨架和文档。
3. 基于功能需求做 clean-room 重写，再发布到 `Szturin/Obsidian-AnyNote`。

## BRAT 安装与更新

工程已准备 GitHub Release 工作流。许可问题解决后，发布 BRAT 可安装版本的流程是：

```bash
git tag 0.2.7
git push origin main
git push origin 0.2.7
```

GitHub Actions 会构建并上传：

```text
main.js
manifest.json
styles.css
versions.json
```

BRAT 用户添加仓库 `Szturin/Obsidian-AnyNote` 后，可通过 GitHub Release 下载和更新插件。当前复制派生代码不应推送到公开仓库；如果使用私有仓库，需要确认 BRAT 端可访问该仓库。

## 后续优化方向

- 将页级 JSON 批注进一步升级为更接近 PDF 原生 annotation object 的模型。
- 更完整的 Apple Pencil/iPad 行为适配，包括可检测能力范围内的硬件橡皮和系统事件。
- 继续细化笔画预测渲染层，减少快速书写时的视觉落后。
- 继续对齐 tldraw/GoodNotes 类的速度、压力和曲率笔尖模型。
- 局部重绘和空间索引，优化大量笔画下的橡皮和框选性能。
- 将当前复制代码逐步替换为可公开发布的 clean-room 实现。
