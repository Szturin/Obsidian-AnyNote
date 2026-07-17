import "./pdf-ink-modal.scss";
import { App, Modal, Notice, TFile, normalizePath, setIcon } from "obsidian";
import { PDFDocument, PDFPage, rgb } from "pdf-lib";
import type InkPlugin from "../main";

type PdfInkTool = "pen" | "ballpoint" | "highlighter" | "eraser" | "select";

interface PdfInkPoint {
	x: number;
	y: number;
	t: number;
	pressure: number;
}

interface PdfInkStroke {
	id: string;
	tool: Exclude<PdfInkTool, "eraser" | "select">;
	color: string;
	width: number;
	points: PdfInkPoint[];
}

interface PdfInkData {
	version: 1;
	sourcePath: string;
	width: number;
	height: number;
	strokes: PdfInkStroke[];
	updatedAt: number;
}

interface PdfInkRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

type PdfInkAction =
	| { type: "add"; stroke: PdfInkStroke }
	| { type: "remove"; strokes: Array<{ stroke: PdfInkStroke; index: number }> };

export class PdfInkModal extends Modal {
	private plugin: InkPlugin;
	private file: TFile;
	private data: PdfInkData;
	private canvas: HTMLCanvasElement;
	private previewCanvas: HTMLCanvasElement;
	private selectionBox: HTMLElement;
	private tool: PdfInkTool = "pen";
	private previousDrawingTool: Exclude<PdfInkTool, "eraser" | "select"> = "pen";
	private temporaryEraserActive = false;
	private color = "#111111";
	private highlighterColor = "#ffd54a";
	private width = 2.5;
	private highlighterWidth = 18;
	private eraserRadius = 18;
	private pointerId: number | null = null;
	private currentStroke: PdfInkStroke | null = null;
	private renderedPointCount = 0;
	private selectionStart: PdfInkPoint | null = null;
	private selectedStrokeIds = new Set<string>();
	private undoStack: PdfInkAction[] = [];
	private redoStack: PdfInkAction[] = [];
	private abortController: AbortController | null = null;

	constructor(app: App, plugin: InkPlugin, file: TFile) {
		super(app);
		this.plugin = plugin;
		this.file = file;
	}

	async onOpen() {
		this.abortController = new AbortController();
		this.modalEl.addClass("anynote-pdf-modal");
		this.contentEl.empty();
		this.contentEl.addClass("anynote-pdf-content");

		const root = this.contentEl.createDiv({ cls: "anynote-pdf-root" });
		const stage = root.createDiv({ cls: "anynote-pdf-stage" });
		const resourceUrl = this.app.vault.getResourcePath(this.file);
		stage.createEl("iframe", {
			cls: "anynote-pdf-frame",
			attr: { src: resourceUrl, title: this.file.basename }
		});

		this.canvas = stage.createEl("canvas", { cls: "anynote-pdf-ink-canvas" });
		this.previewCanvas = stage.createEl("canvas", { cls: "anynote-pdf-preview-canvas" });
		this.selectionBox = stage.createDiv({ cls: "anynote-pdf-selection-box" });
		const toolbar = this.createToolbar(root);
		root.appendChild(toolbar);

		await nextFrame();
		this.resizeCanvases();
		this.data = await this.load();
		this.renderAll();
		this.installEvents();
	}

	onClose() {
		if (this.data) void this.writeCache();
		this.abortController?.abort();
		this.contentEl.empty();
	}

	private createToolbar(root: HTMLElement): HTMLElement {
		const toolbar = root.createDiv({ cls: "anynote-pdf-toolbar" });
		const tools = toolbar.createDiv({ cls: "anynote-toolbar-group" });
		this.iconButton(tools, "pen-line", "普通笔", () => this.setTool("pen"));
		this.iconButton(tools, "circle-dot", "原子笔", () => this.setTool("ballpoint"));
		this.iconButton(tools, "highlighter", "荧光笔", () => this.setTool("highlighter"));
		this.iconButton(tools, "eraser", "橡皮擦", () => this.setTool("eraser"));
		this.iconButton(tools, "scan", "框选", () => this.setTool("select"));

		const controls = toolbar.createDiv({ cls: "anynote-toolbar-group" });
		const colorInput = controls.createEl("input", { attr: { type: "color", "aria-label": "颜色" }, cls: "anynote-color" });
		colorInput.value = this.color;
		colorInput.addEventListener("input", () => {
			if (this.tool === "highlighter") this.highlighterColor = colorInput.value;
			else this.color = colorInput.value;
		}, { signal: this.abortController?.signal });
		const widthInput = controls.createEl("input", { attr: { type: "range", min: "1", max: "42", step: "0.5", "aria-label": "笔宽" }, cls: "anynote-width" });
		widthInput.value = String(this.width);
		widthInput.addEventListener("input", () => {
			const value = Number(widthInput.value);
			if (this.tool === "highlighter") this.highlighterWidth = value;
			else if (this.tool === "eraser") this.eraserRadius = value;
			else this.width = value;
		}, { signal: this.abortController?.signal });

		const actions = toolbar.createDiv({ cls: "anynote-toolbar-group" });
		this.iconButton(actions, "undo-2", "撤销", () => this.undo());
		this.iconButton(actions, "redo-2", "重做", () => this.redo());
		this.iconButton(actions, "trash-2", "删除选中", () => this.deleteSelected());
		this.iconButton(actions, "save", "保存", () => void this.save());
		this.iconButton(actions, "file-down", "导出带批注 PDF", () => void this.exportAnnotatedPdf());
		this.iconButton(actions, "x", "退出", () => this.close());
		return toolbar;
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, callback: () => void) {
		const button = parent.createEl("button", { cls: "anynote-icon-button", attr: { type: "button", title: label, "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", callback, { signal: this.abortController?.signal });
		return button;
	}

	private installEvents() {
		const signal = this.abortController?.signal;
		this.previewCanvas.addEventListener("pointerdown", (event) => this.onPointerDown(event), { signal, passive: false });
		this.previewCanvas.addEventListener("pointermove", (event) => this.onPointerMove(event), { signal, passive: false });
		this.previewCanvas.addEventListener("pointerrawupdate", (event) => this.onPointerMove(event as PointerEvent), { signal, passive: false });
		this.previewCanvas.addEventListener("pointerup", (event) => this.onPointerUp(event), { signal, passive: false });
		this.previewCanvas.addEventListener("pointercancel", (event) => this.onPointerUp(event), { signal, passive: false });
		window.addEventListener("resize", () => {
			this.resizeCanvases();
			this.renderAll();
		}, { signal });
	}

	private onPointerDown(event: PointerEvent) {
		event.preventDefault();
		if (this.pointerId !== null) return;
		this.pointerId = event.pointerId;
		this.previewCanvas.setPointerCapture(event.pointerId);
		const point = this.eventToPoint(event);
		this.clearSelection();
		const activeTool = this.getActiveTool(event);

		if (activeTool === "eraser") {
			this.eraseAt(point);
			return;
		}

		if (activeTool === "select") {
			this.selectionStart = point;
			this.updateSelectionBox(rectFromPoints(point, point));
			return;
		}

		this.currentStroke = {
			id: crypto.randomUUID(),
			tool: activeTool,
			color: activeTool === "highlighter" ? this.highlighterColor : this.color,
			width: activeTool === "highlighter" ? this.highlighterWidth : this.width,
			points: [point]
		};
		this.renderedPointCount = 0;
		this.renderCurrentIncrement();
	}

	private onPointerMove(event: PointerEvent) {
		if (this.pointerId !== event.pointerId) return;
		event.preventDefault();
		const points = getCoalesced(event).map((item) => this.eventToPoint(item));
		const activeTool = this.getActiveTool(event);

		if (activeTool === "eraser") {
			for (const point of points) this.eraseAt(point);
			return;
		}

		if (activeTool === "select" && this.selectionStart) {
			const rect = rectFromPoints(this.selectionStart, this.eventToPoint(event));
			this.updateSelectionBox(rect);
			this.selectedStrokeIds = new Set(this.data.strokes.filter((stroke) => strokeIntersectsRect(stroke, rect)).map((stroke) => stroke.id));
			this.renderAll();
			return;
		}

		if (!this.currentStroke) return;
		for (const point of points) {
			const last = this.currentStroke.points[this.currentStroke.points.length - 1];
			if (last && distanceSquared(last, point) < 0.25) continue;
			this.currentStroke.points.push(smoothPoint(last, point, 0.16));
		}
		this.renderCurrentIncrement();
	}

	private onPointerUp(event: PointerEvent) {
		if (this.pointerId !== event.pointerId) return;
		event.preventDefault();
		if (this.previewCanvas.hasPointerCapture(event.pointerId)) this.previewCanvas.releasePointerCapture(event.pointerId);
		this.pointerId = null;

		if (this.currentStroke) {
			const stroke = cloneStroke(this.currentStroke);
			this.data.strokes.push(stroke);
			this.undoStack.push({ type: "add", stroke });
			this.redoStack = [];
			this.currentStroke = null;
			this.renderedPointCount = 0;
			this.clearCanvas(this.previewCanvas);
			this.renderAll();
		}
		this.selectionStart = null;
		this.finishTemporaryEraser();
	}

	private setTool(tool: PdfInkTool) {
		if (tool === "pen" || tool === "ballpoint" || tool === "highlighter") {
			this.previousDrawingTool = tool;
		}
		this.tool = tool;
		this.temporaryEraserActive = false;
	}

	private getActiveTool(event: PointerEvent): PdfInkTool {
		if (isHardwareEraserEvent(event)) {
			if (!this.temporaryEraserActive && this.tool !== "eraser") {
				this.temporaryEraserActive = true;
				if (this.tool === "pen" || this.tool === "ballpoint" || this.tool === "highlighter") {
					this.previousDrawingTool = this.tool;
				}
			}
			return "eraser";
		}
		return this.tool;
	}

	private finishTemporaryEraser() {
		if (!this.temporaryEraserActive) return;
		this.temporaryEraserActive = false;
		if (!this.plugin.settings.autoSwitchToPenAfterErase) return;
		this.tool = this.previousDrawingTool;
	}

	private renderCurrentIncrement() {
		if (!this.currentStroke) return;
		const context = this.context(this.previewCanvas);
		renderStrokeRange(context, this.currentStroke, Math.max(0, this.renderedPointCount - 1));
		this.renderedPointCount = this.currentStroke.points.length;
	}

	private renderAll() {
		this.clearCanvas(this.canvas);
		const context = this.context(this.canvas);
		for (const stroke of this.data?.strokes || []) {
			renderStrokeRange(context, stroke, 0, this.selectedStrokeIds.has(stroke.id) ? 0.45 : 1);
		}
	}

	private eraseAt(point: PdfInkPoint) {
		const removed: Array<{ stroke: PdfInkStroke; index: number }> = [];
		const remaining: PdfInkStroke[] = [];
		this.data.strokes.forEach((stroke, index) => {
			if (strokeIntersectsPoint(stroke, point, this.eraserRadius)) removed.push({ stroke: cloneStroke(stroke), index });
			else remaining.push(stroke);
		});
		if (removed.length === 0) return;
		this.data.strokes = remaining;
		this.undoStack.push({ type: "remove", strokes: removed });
		this.redoStack = [];
		this.renderAll();
	}

	private deleteSelected() {
		if (this.selectedStrokeIds.size === 0) return;
		const removed: Array<{ stroke: PdfInkStroke; index: number }> = [];
		const remaining: PdfInkStroke[] = [];
		this.data.strokes.forEach((stroke, index) => {
			if (this.selectedStrokeIds.has(stroke.id)) removed.push({ stroke: cloneStroke(stroke), index });
			else remaining.push(stroke);
		});
		this.data.strokes = remaining;
		this.undoStack.push({ type: "remove", strokes: removed });
		this.redoStack = [];
		this.clearSelection();
		this.renderAll();
	}

	private undo() {
		const action = this.undoStack.pop();
		if (!action) return;
		if (action.type === "add") this.data.strokes = this.data.strokes.filter((stroke) => stroke.id !== action.stroke.id);
		else for (const item of action.strokes.sort((a, b) => a.index - b.index)) this.data.strokes.splice(item.index, 0, cloneStroke(item.stroke));
		this.redoStack.push(action);
		this.renderAll();
	}

	private redo() {
		const action = this.redoStack.pop();
		if (!action) return;
		if (action.type === "add") this.data.strokes.push(cloneStroke(action.stroke));
		else {
			const ids = new Set(action.strokes.map((item) => item.stroke.id));
			this.data.strokes = this.data.strokes.filter((stroke) => !ids.has(stroke.id));
		}
		this.undoStack.push(action);
		this.renderAll();
	}

	private async load(): Promise<PdfInkData> {
		const path = this.dataPath();
		await ensureFolder(this.app, path.split("/").slice(0, -1).join("/"));
		if (await this.app.vault.adapter.exists(path)) {
			try {
				const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as PdfInkData;
				const repaired = this.normalizeLoadedData(parsed);
				if (repaired) return repaired;
			} catch (error) {
				console.error("PDF ink load failed", error);
				new Notice("PDF 批注缓存读取失败，将使用空白批注层");
			}
		}
		return { version: 1, sourcePath: this.file.path, width: this.canvas.clientWidth, height: this.canvas.clientHeight, strokes: [], updatedAt: Date.now() };
	}

	private async save() {
		await this.writeCache();
		new Notice("PDF 批注已保存");
	}

	private async writeCache() {
		this.data.updatedAt = Date.now();
		this.data.sourcePath = this.file.path;
		this.data.width = Math.max(1, this.canvas.clientWidth);
		this.data.height = Math.max(1, this.canvas.clientHeight);
		await this.app.vault.adapter.write(this.dataPath(), JSON.stringify(this.data, null, 2));
	}

	private normalizeLoadedData(parsed: Partial<PdfInkData>): PdfInkData | null {
		if (!parsed || !Array.isArray(parsed.strokes)) return null;
		const storedWidth = parsed.width;
		const storedHeight = parsed.height;
		const storedUpdatedAt = parsed.updatedAt;
		const strokes = parsed.strokes
			.filter((stroke): stroke is PdfInkStroke => {
				return Boolean(
					stroke
					&& typeof stroke.id === "string"
					&& (stroke.tool === "pen" || stroke.tool === "ballpoint" || stroke.tool === "highlighter")
					&& typeof stroke.color === "string"
					&& Number.isFinite(stroke.width)
					&& Array.isArray(stroke.points)
				);
			})
			.map((stroke) => ({
				...stroke,
				width: clamp(stroke.width, 0.5, 80),
				points: stroke.points
					.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
					.map((point) => ({
						x: point.x,
						y: point.y,
						t: Number.isFinite(point.t) ? point.t : Date.now(),
						pressure: clamp(Number.isFinite(point.pressure) ? point.pressure : 0.5, 0.05, 1)
					}))
			}))
			.filter((stroke) => stroke.points.length > 0);

		return {
			version: 1,
			sourcePath: typeof parsed.sourcePath === "string" ? parsed.sourcePath : this.file.path,
			width: storedWidth !== undefined && Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : Math.max(1, this.canvas.clientWidth),
			height: storedHeight !== undefined && Number.isFinite(storedHeight) && storedHeight > 0 ? storedHeight : Math.max(1, this.canvas.clientHeight),
			strokes,
			updatedAt: storedUpdatedAt !== undefined && Number.isFinite(storedUpdatedAt) ? storedUpdatedAt : Date.now()
		};
	}

	private async exportAnnotatedPdf() {
		try {
			if (this.currentStroke) {
				new Notice("请先抬笔结束当前笔画，再导出 PDF");
				return;
			}
			await this.writeCache();
			const sourceBytes = await this.app.vault.readBinary(this.file);
			const pdf = await PDFDocument.load(sourceBytes);
			const firstPage = pdf.getPages()[0];
			if (!firstPage) {
				new Notice("PDF 没有可导出的页面");
				return;
			}
			drawPdfInkOnPage(firstPage, this.data);
			const outputBytes = await pdf.save();
			const outputPath = await this.nextExportPath();
			const outputBuffer = outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength) as ArrayBuffer;
			await this.app.vault.createBinary(outputPath, outputBuffer);
			new Notice(`已导出带批注 PDF：${outputPath}`);
		} catch (error) {
			console.error("PDF ink export failed", error);
			new Notice("导出带批注 PDF 失败，请查看开发者控制台");
		}
	}

	private async nextExportPath() {
		const parent = this.file.parent?.path && this.file.parent.path !== "/" ? this.file.parent.path : "";
		const base = this.file.basename.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
		for (let index = 0; index < 1000; index++) {
			const suffix = index === 0 ? "" : `-${index + 1}`;
			const candidate = normalizePath(`${parent ? `${parent}/` : ""}${base}.anynote${suffix}.pdf`);
			if (!(await this.app.vault.adapter.exists(candidate))) return candidate;
		}
		throw new Error("Cannot allocate annotated PDF output path.");
	}

	private dataPath() {
		const dir = normalizePath(`${this.plugin.manifest.dir || `.obsidian/plugins/${this.plugin.manifest.id}`}/pdf-annotations`);
		return normalizePath(`${dir}/${this.file.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_")}.${hash(this.file.path)}.json`);
	}

	private resizeCanvases() {
		const rect = this.previewCanvas.getBoundingClientRect();
		for (const canvas of [this.canvas, this.previewCanvas]) {
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			canvas.width = Math.max(1, Math.ceil(rect.width * dpr));
			canvas.height = Math.max(1, Math.ceil(rect.height * dpr));
			const context = this.context(canvas);
			context.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
	}

	private eventToPoint(event: PointerEvent): PdfInkPoint {
		const rect = this.previewCanvas.getBoundingClientRect();
		return {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
			t: Date.now(),
			pressure: Math.max(0.05, Math.min(1, event.pressure || 0.5))
		};
	}

	private context(canvas: HTMLCanvasElement) {
		const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
		if (!context) throw new Error("Cannot create canvas context.");
		return context;
	}

	private clearCanvas(canvas: HTMLCanvasElement) {
		this.context(canvas).clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
	}

	private clearSelection() {
		this.selectedStrokeIds.clear();
		this.selectionStart = null;
		this.selectionBox.style.display = "none";
	}

	private updateSelectionBox(rect: PdfInkRect) {
		this.selectionBox.style.display = "block";
		this.selectionBox.style.left = `${rect.x}px`;
		this.selectionBox.style.top = `${rect.y}px`;
		this.selectionBox.style.width = `${rect.width}px`;
		this.selectionBox.style.height = `${rect.height}px`;
	}
}

function getCoalesced(event: PointerEvent): PointerEvent[] {
	return typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
}

function isHardwareEraserEvent(event: PointerEvent): boolean {
	return event.pointerType === "pen" && (event.button === 5 || (event.buttons & 32) === 32);
}

function smoothPoint(last: PdfInkPoint | undefined, point: PdfInkPoint, amount: number): PdfInkPoint {
	if (!last) return point;
	return {
		...point,
		x: last.x + (point.x - last.x) * (1 - amount),
		y: last.y + (point.y - last.y) * (1 - amount),
		pressure: last.pressure + (point.pressure - last.pressure) * 0.65
	};
}

function renderStrokeRange(context: CanvasRenderingContext2D, stroke: PdfInkStroke, startIndex: number, alphaScale = 1) {
	if (stroke.points.length === 0) return;
	context.save();
	context.lineCap = "round";
	context.lineJoin = "round";
	context.strokeStyle = stroke.color;
	context.fillStyle = stroke.color;
	context.globalAlpha = (stroke.tool === "highlighter" ? 0.34 : 1) * alphaScale;
	context.globalCompositeOperation = stroke.tool === "highlighter" ? "multiply" : "source-over";
	if (stroke.points.length === 1) {
		const point = stroke.points[0];
		context.beginPath();
		context.arc(point.x, point.y, stroke.width * point.pressure, 0, Math.PI * 2);
		context.fill();
		context.restore();
		return;
	}
	for (let index = Math.max(1, startIndex + 1); index < stroke.points.length; index++) {
		const a = stroke.points[index - 1];
		const b = stroke.points[index];
		context.beginPath();
		context.moveTo(a.x, a.y);
		context.lineTo(b.x, b.y);
		const pressure = stroke.tool === "ballpoint" ? 0.82 : (a.pressure + b.pressure) / 2;
		context.lineWidth = Math.max(0.5, stroke.width * (0.45 + pressure * 0.75));
		context.stroke();
	}
	context.restore();
}

function strokeIntersectsPoint(stroke: PdfInkStroke, point: PdfInkPoint, radius: number) {
	const threshold = Math.pow(radius + stroke.width / 2, 2);
	for (let index = 0; index < stroke.points.length; index++) {
		if (distanceSquared(stroke.points[index], point) <= threshold) return true;
		if (index > 0 && segmentDistanceSquared(point, stroke.points[index - 1], stroke.points[index]) <= threshold) return true;
	}
	return false;
}

function strokeIntersectsRect(stroke: PdfInkStroke, rect: PdfInkRect) {
	return stroke.points.some((point) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height);
}

function rectFromPoints(a: PdfInkPoint, b: PdfInkPoint): PdfInkRect {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function segmentDistanceSquared(point: PdfInkPoint, start: PdfInkPoint, end: PdfInkPoint) {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const l2 = dx * dx + dy * dy;
	if (l2 === 0) return distanceSquared(point, start);
	const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / l2));
	return distanceSquared(point, { ...point, x: start.x + t * dx, y: start.y + t * dy });
}

function distanceSquared(a: Pick<PdfInkPoint, "x" | "y">, b: Pick<PdfInkPoint, "x" | "y">) {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

function cloneStroke(stroke: PdfInkStroke): PdfInkStroke {
	return { ...stroke, points: stroke.points.map((point) => ({ ...point })) };
}

function drawPdfInkOnPage(page: PDFPage, data: PdfInkData) {
	const { width: pageWidth, height: pageHeight } = page.getSize();
	const sourceWidth = Math.max(1, data.width);
	const sourceHeight = Math.max(1, data.height);
	const scaleX = pageWidth / sourceWidth;
	const scaleY = pageHeight / sourceHeight;
	const scale = (scaleX + scaleY) / 2;

	for (const stroke of data.strokes) {
		if (stroke.points.length === 1) {
			const point = toPdfPoint(stroke.points[0], sourceWidth, sourceHeight, pageWidth, pageHeight);
			const radius = Math.max(0.25, stroke.width * scale * stroke.points[0].pressure * 0.5);
			page.drawEllipse({
				x: point.x,
				y: point.y,
				xScale: radius,
				yScale: radius,
				color: parseRgb(stroke.color),
				opacity: stroke.tool === "highlighter" ? 0.34 : 1
			});
			continue;
		}

		for (let index = 1; index < stroke.points.length; index++) {
			const a = stroke.points[index - 1];
			const b = stroke.points[index];
			const start = toPdfPoint(a, sourceWidth, sourceHeight, pageWidth, pageHeight);
			const end = toPdfPoint(b, sourceWidth, sourceHeight, pageWidth, pageHeight);
			const pressure = stroke.tool === "ballpoint" ? 0.82 : (a.pressure + b.pressure) / 2;
			page.drawLine({
				start,
				end,
				thickness: Math.max(0.25, stroke.width * scale * (0.45 + pressure * 0.75)),
				color: parseRgb(stroke.color),
				opacity: stroke.tool === "highlighter" ? 0.34 : 1
			});
		}
	}
}

function toPdfPoint(
	point: PdfInkPoint,
	sourceWidth: number,
	sourceHeight: number,
	pageWidth: number,
	pageHeight: number
) {
	return {
		x: clamp(point.x / sourceWidth, 0, 1) * pageWidth,
		y: pageHeight - clamp(point.y / sourceHeight, 0, 1) * pageHeight
	};
}

function parseRgb(color: string) {
	const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
	if (!match) return rgb(0, 0, 0);
	return rgb(
		parseInt(match[1], 16) / 255,
		parseInt(match[2], 16) / 255,
		parseInt(match[3], 16) / 255
	);
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

async function ensureFolder(app: App, dir: string) {
	const parts = dir.split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!(await app.vault.adapter.exists(current))) await app.vault.adapter.mkdir(current);
	}
}

function hash(value: string) {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}
