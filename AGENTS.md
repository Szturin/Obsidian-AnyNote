# Agent Notes

## 项目身份

- 插件 id：`obsidian-anynote`
- 插件名：`Obsidian AnyNote`
- npm 包名：`obsidian-anynote`
- 当前版本：`0.2.10`
- 目标 GitHub 仓库：`Szturin/Obsidian-AnyNote`

## 必须遵守的许可边界

当前工程包含从 `daledesilva/obsidian_ink` 复制并修改的代码。上游仓库声明主要代码和文档使用 CC BY-NC-ND 4.0，且 README 明确说明它不是开源项目。

因此：

- 可以用于用户本机的个人学习实验。
- 不要公开发布、分发、上传派生源码或构建产物。
- 不要移除 `private: true` 或 `UNLICENSED`，除非已经完成 clean-room 重写或取得上游授权。
- 不要把当前复制派生代码推送到公开 GitHub 仓库。

## 开发命令

```bash
npm run build
```

构建入口：`src/main.ts`

构建产物：

- `main.js`
- `styles.css`
- `manifest.json`

## 关键文件

- `src/main.ts`：插件入口，注册手写、绘图和 PDF 批注命令。
- `src/pdf/pdf-ink-modal.ts`：PDF 原生视图页级覆盖层和 Canvas 手写核心。
- `src/pdf/pdf-ink-modal.scss`：PDF 批注工具栏和覆盖层样式。
- `src/pdf/tldraw-freehand.ts`：PDF 手写使用的 tldraw/freehand stroke points、半径和轮廓算法本地实现。
- `src/tldraw/writing/tldraw-writing-editor.tsx`：手写编辑器。
- `src/tldraw/drawing/tldraw-drawing-editor.tsx`：绘图编辑器。
- `LOCAL_LEARNING_NOTICE.md`：本地学习和发布限制说明。
- `docs/PROJECT_SUMMARY.md`：工程总结。

## PDF 批注事实

PDF 批注是原生 PDF 视图内的页级 JSON 批注：

- 不修改 PDF。
- 不生成 PDF 附件。
- 不向 Markdown 插入 SVG。
- 数据保存在 `.obsidian/plugins/obsidian-anynote/pdf-annotations/*.json`。
- 每条 stroke 必须绑定 `pageNumber`、`pageWidth`、`pageHeight` 和页内坐标。
- 用户点击 `导出带批注 PDF` 时，会额外生成新的 `*.anynote.pdf`，并按页码以矢量线段写入当前批注。
- 工具栏直接挂载在 Obsidian 当前 PDF leaf 的 `.view-content` 内，不再创建 modal、iframe 或独立窗口。
- 书写 stage 必须直接插入真实 PDF page DOM 内部，不允许用外层 `.view-content` 坐标追踪页面。
- 非当前可书写页也必须用静态 passive ink layer 渲染，保证滚动时能连续看到每页笔迹。
- 书写 stage 不允许覆盖 PDF 顶部控件、左侧缩略图目录或右侧面板。
- Apple Pencil 输入需要保留压力下限、采样补点和短暂断流续接，避免虚线/断线。
- 工具栏包含“手/浏览”模式；该模式会让底层 PDF 接收拖动和滚动事件。
- 当前工具按钮必须有 `is-active`/`aria-pressed` 选中状态。
- 移动端/iPad 工具栏必须使用 viewport fixed fallback，不要依赖 PDF 滚动容器内的 absolute bottom。
- 工具栏必须支持拖动并吸附上下左右，吸附时显示浅色 snap zone 提示。

## BRAT 发布准备

`.github/workflows/release.yml` 会在推送版本标签时构建并上传 BRAT 需要的 release assets。优先使用与 `manifest.json` 版本一致的标签，例如 `0.2.10`。

- `main.js`
- `manifest.json`
- `styles.css`
- `versions.json`

不要把当前复制派生代码推送到公开 GitHub 仓库，除非已经取得上游授权或完成 clean-room 重写。若使用私有仓库，需要确认 BRAT 客户端能访问该仓库和 release assets。

## 手写优化方向

优先改 `src/pdf/pdf-ink-modal.ts`：

- 增加笔画预测层。
- PDF 笔迹已经切到 tldraw/freehand 同构算法；后续重点是 iPad Pencil 实机采样、预测和大批量 stroke 性能。
- 为橡皮/框选增加空间索引。
- 将页级 JSON 批注升级为更接近 PDF 原生 annotation object 的模型。
- 避免每次输入都全量重绘。

修改后至少运行：

```bash
npm run build
```
