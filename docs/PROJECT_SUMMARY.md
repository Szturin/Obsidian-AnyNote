# Obsidian AnyNote 工程总结

## 项目定位

Obsidian AnyNote 是一个本地学习实验工程，用来研究 Obsidian 内的手写、绘图和 PDF 批注体验。当前代码集成了 `obsidian_ink` 的功能形态，并增加了中文命令和 PDF 覆盖层批注 MVP。

## 关键能力

- Markdown 手写区域和绘图区域。
- tldraw 驱动的手写/绘图编辑体验。
- 中文命令入口。
- PDF 上方叠加 Canvas 标注层。
- 打开 PDF 时默认自动进入 AnyNote 批注界面；也支持左侧按钮、命令和右键菜单入口。
- PDF 普通笔、原子笔、荧光笔、橡皮擦、框选、撤销、重做、保存。
- PDF 批注保存为插件目录内 JSON，不修改 PDF，不创建附件。
- PDF 批注可导出为新的 `*.anynote.pdf`，导出时将 stroke 作为矢量线段写入 PDF。
- “擦除后自动切回画笔”可在设置中开关，默认开启。

## 手写体验实现要点

- 使用 Pointer Events 统一鼠标、触摸和触控笔输入。
- 使用 `pointerrawupdate` 获取更高频输入。
- 使用 `getCoalescedEvents()` 合并浏览器采样点，减少断裂。
- 使用自适应平滑保留转折，同时压低快速书写抖动。
- 使用压力值和书写速度共同影响线宽。
- 使用短距预测层减少视觉落后，真实采样到达后清除预测。
- 当前笔画先画在 preview canvas，完成后提交到主 canvas。
- 主 canvas、preview canvas、prediction canvas 分离，减少全量重绘并改善跟手感。
- PDF Canvas context 使用 `{ desynchronized: true }` 降低输入到显示的延迟。
- 橡皮擦使用笔画命中检测删除整条 stroke。
- 框选使用矩形与 stroke 点相交检测。
- 导出使用 `pdf-lib`，按记录时的覆盖层尺寸将 Canvas 坐标映射到 PDF 第一页坐标。

## 主要限制

- PDF 还不是逐页语义模型，当前覆盖层按 iframe/stage 尺寸保存。
- PDF 批注不会写回原 PDF 文件；只在用户点击导出时生成新的 PDF。
- PDF 导出当前只针对现有覆盖层模型映射到第一页，多页逐页坐标还未完成。
- 自动打开 PDF 批注是设置项，用户可关闭。
- Apple Pencil 双击侧面事件在 Web/Obsidian 环境中通常没有标准 PointerEvent 暴露；当前只能支持浏览器可识别的硬件橡皮按钮事件。
- 上游复制代码许可限制阻止公开发布当前派生版本。

## 构建

```bash
npm run build
```

构建入口是 `src/main.ts`，输出 `main.js` 和 `styles.css`。

## 发布建议

当前代码只能作为本地学习构建保存。要发布到 `Szturin/Obsidian-AnyNote`，应先取得上游授权，或完成 clean-room 重写后再推送公开仓库。

已加入 `.github/workflows/release.yml`。许可问题解决后，推送与 `manifest.json` 版本一致的标签（例如 `0.2.3`）会生成 BRAT 需要的 release assets：`main.js`、`manifest.json`、`styles.css`、`versions.json`。
