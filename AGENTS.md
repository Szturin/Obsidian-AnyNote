# Agent Notes

## 项目身份

- 插件 id：`obsidian-anynote`
- 插件名：`Obsidian AnyNote`
- npm 包名：`obsidian-anynote`
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
- `src/pdf/pdf-ink-modal.ts`：PDF 批注模态框和 Canvas 手写核心。
- `src/pdf/pdf-ink-modal.scss`：PDF 批注工具栏和覆盖层样式。
- `src/tldraw/writing/tldraw-writing-editor.tsx`：手写编辑器。
- `src/tldraw/drawing/tldraw-drawing-editor.tsx`：绘图编辑器。
- `LOCAL_LEARNING_NOTICE.md`：本地学习和发布限制说明。
- `docs/PROJECT_SUMMARY.md`：工程总结。

## PDF 批注事实

PDF 批注是覆盖层 JSON 批注：

- 不修改 PDF。
- 不生成 PDF 附件。
- 不向 Markdown 插入 SVG。
- 数据保存在 `.obsidian/plugins/obsidian-anynote/pdf-annotations/*.json`。

## 手写优化方向

优先改 `src/pdf/pdf-ink-modal.ts`：

- 增加笔画预测层。
- 以速度、压力和曲率调整线宽。
- 为橡皮/框选增加空间索引。
- 建立 PDF 多页坐标模型。
- 避免每次输入都全量重绘。

修改后至少运行：

```bash
npm run build
```
