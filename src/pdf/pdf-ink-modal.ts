import "./pdf-ink-modal.scss";
import { App, Notice, Platform, TFile, normalizePath, setIcon } from "obsidian";
import { PDFDocument, PDFPage, rgb } from "pdf-lib";
import type InkPlugin from "../main";
import {
	TLDRAW_EASINGS,
	createTldrawInkPath,
	drawTldrawInkStrokePoints,
	getStrokePoints,
	setStrokePointRadii,
	type StrokeOptions,
	type StrokePoint,
	type VecLike
} from "./tldraw-freehand";

type PdfInkTool = "hand" | "pen" | "ballpoint" | "highlighter" | "eraser" | "select";

interface PdfInkPoint {
	x: number;
	y: number;
	t: number;
	pressure: number;
	velocity?: number;
}

interface PdfInkStroke {
	id: string;
	tool: Exclude<PdfInkTool, "hand" | "eraser" | "select">;
	color: string;
	width: number;
	pageNumber: number;
	pageWidth: number;
	pageHeight: number;
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

interface PdfPageInkLayer {
	pageNumber: number;
	page: HTMLElement;
	stage: HTMLElement;
	canvas: HTMLCanvasElement;
	previewCanvas: HTMLCanvasElement;
	predictionCanvas: HTMLCanvasElement;
	selectionBox: HTMLElement;
	originalPosition: string;
	positionChanged: boolean;
	width: number;
	height: number;
	renderSignature: string;
}

type ToolbarDock = "bottom" | "top" | "left" | "right";

interface PdfStrokeRenderCache {
	signature: string;
	kind: "ink" | "centerline";
	strokePoints: StrokePoint[];
	path: Path2D | null;
	width: number;
	options: StrokeOptions;
}

const MAX_PDF_CANVAS_PIXELS_DESKTOP = 3_200_000;
const MAX_PDF_CANVAS_PIXELS_MOBILE = 1_800_000;
const PAGE_VIRTUALIZATION_MARGIN = 1.2;

export class PdfInkOverlay {
	private plugin: InkPlugin;
	private file: TFile;
	private host: HTMLElement;
	private onClosed?: () => void;
	private data: PdfInkData;
	private root: HTMLElement;
	private stage: HTMLElement;
	private canvas: HTMLCanvasElement;
	private previewCanvas: HTMLCanvasElement;
	private predictionCanvas: HTMLCanvasElement;
	private selectionBox: HTMLElement;
	private tool: PdfInkTool = "pen";
	private previousDrawingTool: Exclude<PdfInkTool, "hand" | "eraser" | "select"> = "pen";
	private toolButtons = new Map<PdfInkTool, HTMLButtonElement>();
	private temporaryEraserActive = false;
	private color = "#111111";
	private highlighterColor = "#ffd54a";
	private width = 2.5;
	private highlighterWidth = 18;
	private eraserRadius = 18;
	private pointerId: number | null = null;
	private pointerStartedAt = 0;
	private lastPointerEventAt = 0;
	private currentStroke: PdfInkStroke | null = null;
	private selectionStart: PdfInkPoint | null = null;
	private selectedStrokeIds = new Set<string>();
	private undoStack: PdfInkAction[] = [];
	private redoStack: PdfInkAction[] = [];
	private abortController: AbortController | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private originalHostPosition = "";
	private closed = false;
	private lastStageRect: PdfInkRect | null = null;
	private lastFinishedStroke: { stroke: PdfInkStroke; index: number; finishedAt: number; pointerType: string } | null = null;
	private stageHost: HTMLElement | null = null;
	private activeLayer: PdfPageInkLayer | null = null;
	private pageInkLayers = new Map<number, PdfPageInkLayer>();
	private renderFrame: number | null = null;
	private resizeRenderTimer: number | null = null;
	private fullRenderPending = false;
	private dirtyPageNumbers = new Set<number>();
	private strokeRenderCache = new Map<string, PdfStrokeRenderCache>();
	private toolbar: HTMLElement;
	private snapOverlay: HTMLElement;
	private toolbarDock: ToolbarDock = "bottom";
	private toolbarDrag:
		| { pointerId: number; startX: number; startY: number; dock: ToolbarDock }
		| null = null;

	constructor(private app: App, plugin: InkPlugin, file: TFile, host: HTMLElement, onClosed?: () => void) {
		this.plugin = plugin;
		this.file = file;
		this.host = host;
		this.onClosed = onClosed;
	}

	async open() {
		this.abortController = new AbortController();

		this.originalHostPosition = this.host.style.position;
		if (getComputedStyle(this.host).position === "static") this.host.style.position = "relative";

		this.root = this.host.createDiv({ cls: "anynote-pdf-overlay-root" });
		if (Platform.isMobile || window.matchMedia("(pointer: coarse)").matches) {
			this.root.addClass("is-mobile-toolbar");
		}
		const toolbar = this.createToolbar(this.root);
		this.root.appendChild(toolbar);
		this.updateToolUi();

		await nextFrame();
		if (!(await this.waitForInkTarget())) {
			throw new Error("PDF page target was not ready for ink overlay.");
		}
		this.data = await this.load();
		this.syncStageToInkTarget();
		this.resizeCanvases();
		this.renderAll();
		this.installEvents();
	}

	isConnected() {
		return Boolean(this.root?.isConnected);
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		if (this.data) void this.writeCache();
		if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
		if (this.resizeRenderTimer !== null) window.clearTimeout(this.resizeRenderTimer);
		this.resizeObserver?.disconnect();
		this.abortController?.abort();
		this.root?.remove();
		for (const layer of this.pageInkLayers.values()) this.removePageInkLayer(layer);
		this.pageInkLayers.clear();
		this.host.removeClass("anynote-pdf-native-host");
		if (this.host.style.position === "relative" && !this.originalHostPosition) this.host.style.position = "";
		else this.host.style.position = this.originalHostPosition;
		this.onClosed?.();
	}

	private createToolbar(root: HTMLElement): HTMLElement {
		const toolbar = root.createDiv({ cls: "anynote-pdf-toolbar" });
		this.toolbar = toolbar;
		const dragHandle = toolbar.createDiv({ cls: "anynote-toolbar-drag-handle", attr: { title: "拖动工具栏", "aria-label": "拖动工具栏" } });
		setIcon(dragHandle, "grip");
		dragHandle.addEventListener("pointerdown", (event) => this.onToolbarDragStart(event), { signal: this.abortController?.signal });
		const tools = toolbar.createDiv({ cls: "anynote-toolbar-group" });
		this.toolButton(tools, "hand", "hand", "手/浏览");
		this.toolButton(tools, "pen", "pen-line", "普通笔");
		this.toolButton(tools, "ballpoint", "circle-dot", "原子笔");
		this.toolButton(tools, "highlighter", "highlighter", "荧光笔");
		this.toolButton(tools, "eraser", "eraser", "橡皮擦");
		this.toolButton(tools, "select", "scan", "框选");

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
		this.snapOverlay = root.createDiv({ cls: "anynote-toolbar-snap-overlay" });
		for (const dock of ["top", "bottom", "left", "right"] as ToolbarDock[]) {
			this.snapOverlay.createDiv({ cls: `anynote-snap-zone anynote-snap-${dock}` });
		}
		this.setToolbarDock(this.toolbarDock);
		return toolbar;
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, callback: () => void) {
		const button = parent.createEl("button", { cls: "anynote-icon-button", attr: { type: "button", title: label, "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", callback, { signal: this.abortController?.signal });
		return button;
	}

	private toolButton(parent: HTMLElement, tool: PdfInkTool, icon: string, label: string) {
		const button = this.iconButton(parent, icon, label, () => this.setTool(tool));
		button.addClass("anynote-tool-button");
		button.setAttr("aria-pressed", tool === this.tool ? "true" : "false");
		this.toolButtons.set(tool, button);
		return button;
	}

	private onToolbarDragStart(event: PointerEvent) {
		event.preventDefault();
		event.stopPropagation();
		this.toolbarDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dock: this.toolbarDock };
		this.toolbar.setPointerCapture(event.pointerId);
		this.root.addClass("is-snapping-toolbar");
		this.toolbar.addClass("is-dragging");
		const signal = this.abortController?.signal;
		const onMove = (moveEvent: PointerEvent) => this.onToolbarDragMove(moveEvent);
		const onEnd = (upEvent: PointerEvent) => {
			this.onToolbarDragEnd(upEvent);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onEnd);
		};
		window.addEventListener("pointermove", onMove, { signal });
		window.addEventListener("pointerup", onEnd, { signal });
		window.addEventListener("pointercancel", onEnd, { signal });
	}

	private onToolbarDragMove(event: PointerEvent) {
		if (!this.toolbarDrag || event.pointerId !== this.toolbarDrag.pointerId) return;
		event.preventDefault();
		const dock = dockFromPoint(event.clientX, event.clientY);
		this.root.removeClasses(["is-snap-top", "is-snap-bottom", "is-snap-left", "is-snap-right"]);
		this.root.addClass(`is-snap-${dock}`);
		this.setToolbarDock(dock);
	}

	private onToolbarDragEnd(event: PointerEvent) {
		if (!this.toolbarDrag || event.pointerId !== this.toolbarDrag.pointerId) return;
		event.preventDefault();
		const dock = dockFromPoint(event.clientX, event.clientY);
		this.setToolbarDock(dock);
		this.toolbarDrag = null;
		this.root.removeClasses(["is-snapping-toolbar", "is-snap-top", "is-snap-bottom", "is-snap-left", "is-snap-right"]);
		this.toolbar.removeClass("is-dragging");
		if (this.toolbar.hasPointerCapture(event.pointerId)) this.toolbar.releasePointerCapture(event.pointerId);
	}

	private setToolbarDock(dock: ToolbarDock) {
		this.toolbarDock = dock;
		if (!this.toolbar) return;
		this.toolbar.removeClasses(["dock-top", "dock-bottom", "dock-left", "dock-right"]);
		this.toolbar.addClass(`dock-${dock}`);
	}

	private installEvents() {
		const signal = this.abortController?.signal;
		window.addEventListener("pointerup", (event) => this.onPointerEnd(event), { signal, passive: false });
		window.addEventListener("pointercancel", (event) => this.onPointerEnd(event), { signal, passive: false });
		this.host.addEventListener("pointerdown", (event) => this.onHostPointerDown(event), { signal, capture: true, passive: false });
		window.addEventListener("resize", () => {
			this.scheduleDeferredResizeRender();
		}, { signal });
		this.host.addEventListener("scroll", () => {
			const previousStageHost = this.stageHost;
			this.syncStageToInkTarget();
			if (previousStageHost !== this.stageHost) this.resizeCanvases(false);
			this.scheduleRenderAll();
		}, { signal, capture: true });
		this.resizeObserver = new ResizeObserver(() => {
			this.scheduleDeferredResizeRender();
		});
		this.resizeObserver.observe(this.host);
	}

	private onHostPointerDown(event: PointerEvent) {
		if (event.target instanceof Element && event.target.closest(".anynote-pdf-preview-canvas")) return;
		if (this.tool === "hand" || this.pointerId !== null) return;
		if (event.target instanceof Element && event.target.closest(".anynote-pdf-toolbar, .anynote-toolbar-snap-overlay")) return;
		const page = this.findPageAtPoint(event.clientX, event.clientY);
		if (!page) return;
		this.activatePageLayer(page);
		this.resizeCanvases(false);
		this.scheduleRenderAll();
		this.onPointerDown(event);
	}

	private onPointerDown(event: PointerEvent) {
		if (this.pointerId !== null) this.recoverInterruptedPointer(event);
		if (this.pointerId !== null) return;
		if (!this.activeLayer) {
			const page = this.findPageAtPoint(event.clientX, event.clientY) || this.findInkTarget();
			if (page) this.activatePageLayer(page);
			if (!this.activeLayer) return;
		}
		const activeTool = this.getActiveTool(event);
		if (activeTool === "hand") return;
		event.preventDefault();
		this.clearCanvas(this.predictionCanvas);
		this.pointerId = event.pointerId;
		this.pointerStartedAt = event.timeStamp || performance.now();
		this.lastPointerEventAt = this.pointerStartedAt;
		this.previewCanvas.setPointerCapture(event.pointerId);
		const point = this.eventToPoint(event);
		this.clearSelection();

		if (activeTool === "eraser") {
			this.eraseAt(point);
			return;
		}

		if (activeTool === "select") {
			this.selectionStart = point;
			this.updateSelectionBox(rectFromPoints(point, point));
			return;
		}

		const stitchedStroke = this.tryResumeRecentPencilStroke(activeTool, point, event);
		this.currentStroke = stitchedStroke || {
			id: crypto.randomUUID(),
			tool: activeTool,
			color: activeTool === "highlighter" ? this.highlighterColor : this.color,
			width: activeTool === "highlighter" ? this.highlighterWidth : this.width,
			pageNumber: this.currentPageNumber(),
			pageWidth: this.currentStageWidth(),
			pageHeight: this.currentStageHeight(),
			points: [point]
		};
		this.renderCurrentStroke();
	}

	private onPointerMove(event: PointerEvent) {
		if (this.pointerId !== event.pointerId) return;
		event.preventDefault();
		this.lastPointerEventAt = event.timeStamp || performance.now();
		this.clearCanvas(this.predictionCanvas);
		const points = getCoalesced(event).map((item) => this.eventToPoint(item));
		const activeTool = this.getActiveTool(event);

		if (activeTool === "eraser") {
			for (const point of points) this.eraseAt(point);
			return;
		}

		if (activeTool === "select" && this.selectionStart) {
			const rect = rectFromPoints(this.selectionStart, this.eventToPoint(event));
			this.updateSelectionBox(rect);
			this.selectedStrokeIds = new Set(this.currentPageStrokes().filter((stroke) => strokeIntersectsRect(this.strokeForCurrentStage(stroke), rect)).map((stroke) => stroke.id));
			this.scheduleRenderPages([this.currentPageNumber()]);
			return;
		}

		if (!this.currentStroke) return;
		for (const point of points) {
			this.appendStrokePoint(this.currentStroke, point);
		}
		this.renderCurrentStroke();
		this.renderPrediction();
	}

	private onPointerEnd(event: PointerEvent) {
		if (this.pointerId !== event.pointerId) return;
		event.preventDefault();
		this.finishActivePointer(event);
	}

	private onPointerLost(event: PointerEvent) {
		if (this.pointerId !== event.pointerId) return;
		this.finishActivePointer(event);
	}

	private recoverInterruptedPointer(event: PointerEvent) {
		const now = event.timeStamp || performance.now();
		if (event.pointerId === this.pointerId) return;
		if (now - this.lastPointerEventAt < 24 && now - this.pointerStartedAt < 60) return;
		this.finishActivePointer(event);
	}

	private finishActivePointer(event: PointerEvent, releaseCapture = true) {
		const activePointerId = this.pointerId;
		if (activePointerId === null) return;
		if (releaseCapture && this.previewCanvas.hasPointerCapture(activePointerId)) this.previewCanvas.releasePointerCapture(activePointerId);
		this.pointerId = null;
		this.pointerStartedAt = 0;
		this.lastPointerEventAt = 0;

		if (this.currentStroke) this.commitCurrentStroke(event);
		this.selectionStart = null;
		this.finishTemporaryEraser();
	}

	private commitCurrentStroke(event: PointerEvent) {
		if (!this.currentStroke) return;
		const stroke = cloneStroke(this.currentStroke);
		this.data.strokes.push(stroke);
		this.undoStack.push({ type: "add", stroke });
		this.lastFinishedStroke = {
			stroke: cloneStroke(stroke),
			index: this.data.strokes.length - 1,
			finishedAt: performance.now(),
			pointerType: event.pointerType
		};
		this.redoStack = [];
		this.currentStroke = null;
		this.commitStrokeToVisibleLayer(stroke);
		this.clearCanvas(this.previewCanvas);
		this.clearCanvas(this.predictionCanvas);
	}

	private setTool(tool: PdfInkTool) {
		if (tool === "pen" || tool === "ballpoint" || tool === "highlighter") {
			this.previousDrawingTool = tool;
		}
		if (this.predictionCanvas) this.clearCanvas(this.predictionCanvas);
		this.tool = tool;
		this.temporaryEraserActive = false;
		this.updateToolUi();
	}

	private updateToolUi() {
		for (const [tool, button] of this.toolButtons) {
			const active = tool === this.tool;
			button.toggleClass("is-active", active);
			button.setAttr("aria-pressed", active ? "true" : "false");
		}
		const handMode = this.tool === "hand";
		for (const layer of this.pageInkLayers.values()) {
			layer.previewCanvas.toggleClass("is-hand-mode", handMode);
			layer.previewCanvas.style.pointerEvents = handMode ? "none" : "auto";
			layer.previewCanvas.style.cursor = handMode ? "grab" : "crosshair";
		}
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
		this.updateToolUi();
	}

	private appendStrokePoint(stroke: PdfInkStroke, point: PdfInkPoint) {
		const last = stroke.points[stroke.points.length - 1];
		if (!last) {
			stroke.points.push(point);
			return;
		}
		const mergeDistance = stroke.tool === "highlighter" ? 1.25 : 0.75;
		const distance2 = distanceSquared(last, point);
		const nextPoint = withVelocity(last, point);
		if (distance2 < mergeDistance * mergeDistance) {
			stroke.points[stroke.points.length - 1] = {
				...nextPoint,
				pressure: Math.max(last.pressure, nextPoint.pressure)
			};
			return;
		}
		const distance = Math.sqrt(distance2);
		const maxSpacing = stroke.tool === "highlighter"
			? Math.max(3, stroke.width * 0.28)
			: Math.max(2.2, stroke.width * 1.25);
		if (distance > maxSpacing) {
			const steps = Math.min(24, Math.floor(distance / maxSpacing));
			let previous = last;
			for (let index = 1; index <= steps; index++) {
				const interpolated = interpolateInkPoint(last, nextPoint, index / (steps + 1));
				const withInterpolatedVelocity = withVelocity(previous, interpolated);
				stroke.points.push(withInterpolatedVelocity);
				previous = withInterpolatedVelocity;
			}
		}
		stroke.points.push(nextPoint);
	}

	private renderCurrentStroke() {
		if (!this.previewCanvas) return;
		this.clearCanvas(this.previewCanvas);
		if (!this.currentStroke) return;
		const context = this.context(this.previewCanvas);
		renderLiveStroke(context, this.currentStroke);
	}

	private renderPrediction() {
		if (!this.predictionCanvas) return;
		this.clearCanvas(this.predictionCanvas);
		if (!this.currentStroke) return;
		const predicted = predictStroke(this.currentStroke);
		if (!predicted) return;
		const context = this.context(this.predictionCanvas);
		renderLiveStroke(context, predicted, 0.32);
	}

	private renderAll() {
		this.fullRenderPending = false;
		this.dirtyPageNumbers.clear();
		const strokesByPage = this.strokesByPage();
		this.syncStageToInkTarget();
		this.renderPageInkLayers(strokesByPage);
		this.pruneStrokeRenderCache();
	}

	private scheduleRenderAll() {
		this.fullRenderPending = true;
		this.dirtyPageNumbers.clear();
		if (this.renderFrame !== null) return;
		this.renderFrame = window.requestAnimationFrame(() => {
			this.renderFrame = null;
			if (this.fullRenderPending) this.renderAll();
			else this.renderDirtyPages();
		});
	}

	private scheduleRenderPages(pageNumbers: Iterable<number>) {
		if (this.fullRenderPending) return;
		for (const pageNumber of pageNumbers) {
			if (!Number.isFinite(pageNumber) || pageNumber <= 0) continue;
			const normalizedPageNumber = Math.floor(pageNumber);
			this.dirtyPageNumbers.add(normalizedPageNumber);
			const layer = this.pageInkLayers.get(normalizedPageNumber);
			if (layer) layer.renderSignature = "";
		}
		if (this.dirtyPageNumbers.size === 0 || this.renderFrame !== null) return;
		this.renderFrame = window.requestAnimationFrame(() => {
			this.renderFrame = null;
			if (this.fullRenderPending) this.renderAll();
			else this.renderDirtyPages();
		});
	}

	private renderDirtyPages() {
		if (this.dirtyPageNumbers.size === 0) return;
		const pageNumbers = Array.from(this.dirtyPageNumbers);
		this.dirtyPageNumbers.clear();
		for (const pageNumber of pageNumbers) this.renderPageNumberNow(pageNumber);
		this.pruneStrokeRenderCache();
	}

	private scheduleDeferredResizeRender() {
		this.syncStageToInkTarget();
		if (this.pointerId !== null) {
			this.resizeCanvases(false);
			this.scheduleRenderPages([this.currentPageNumber()]);
			return;
		}
		if (this.resizeRenderTimer !== null) window.clearTimeout(this.resizeRenderTimer);
		this.resizeRenderTimer = window.setTimeout(() => {
			this.resizeRenderTimer = null;
			this.resizeCanvases(false);
			this.scheduleRenderAll();
		}, 180);
	}

	private renderPageInkLayers(strokesByPage: Map<number, PdfInkStroke[]>) {
		if (!this.data) return;
		const hostRect = this.host.getBoundingClientRect();
		const visiblePages = this.findPageTargets().filter((page) => this.isPageNearViewport(page, hostRect));
		const visiblePageNumbers = new Set<number>();
		for (const page of visiblePages) {
			const pageNumber = getPageNumber(page);
			if (!pageNumber) continue;
			visiblePageNumbers.add(pageNumber);
			const layer = this.ensurePageInkLayer(page, pageNumber);
			this.resizePageInkLayer(layer, false);
			this.renderPageInkLayer(layer, strokesByPage.get(pageNumber) || []);
		}
		for (const [pageNumber, layer] of Array.from(this.pageInkLayers.entries())) {
			if (!visiblePageNumbers.has(pageNumber)) {
				this.removePageInkLayer(layer);
				this.pageInkLayers.delete(pageNumber);
			}
		}
	}

	private ensurePageInkLayer(page: HTMLElement, pageNumber: number): PdfPageInkLayer {
		const existing = this.pageInkLayers.get(pageNumber);
		if (existing && existing.page === page && existing.stage.isConnected) return existing;
		if (existing) this.removePageInkLayer(existing);
		const originalPosition = page.style.position;
		const positionChanged = getComputedStyle(page).position === "static";
		if (positionChanged) page.style.position = "relative";
		page.addClass("anynote-pdf-page-host");
		const stage = page.createDiv({ cls: "anynote-pdf-stage anynote-pdf-page-stage" });
		const canvas = stage.createEl("canvas", { cls: "anynote-pdf-ink-canvas" });
		const previewCanvas = stage.createEl("canvas", { cls: "anynote-pdf-preview-canvas" });
		const predictionCanvas = stage.createEl("canvas", { cls: "anynote-pdf-prediction-canvas" });
		const selectionBox = stage.createDiv({ cls: "anynote-pdf-selection-box" });
		const layer: PdfPageInkLayer = {
			pageNumber,
			page,
			stage,
			canvas,
			previewCanvas,
			predictionCanvas,
			selectionBox,
			originalPosition,
			positionChanged,
			width: 0,
			height: 0,
			renderSignature: ""
		};
		this.installPageLayerEvents(layer);
		this.pageInkLayers.set(pageNumber, layer);
		return layer;
	}

	private installPageLayerEvents(layer: PdfPageInkLayer) {
		const signal = this.abortController?.signal;
		layer.previewCanvas.addEventListener("pointerdown", (event) => {
			this.activateLayer(layer);
			this.onPointerDown(event);
		}, { signal, passive: false });
		layer.previewCanvas.addEventListener("pointermove", (event) => this.onPointerMove(event), { signal, passive: false });
		layer.previewCanvas.addEventListener("pointerrawupdate", (event) => this.onPointerMove(event as PointerEvent), { signal, passive: false });
		layer.previewCanvas.addEventListener("pointerup", (event) => this.onPointerEnd(event), { signal, passive: false });
		layer.previewCanvas.addEventListener("pointercancel", (event) => this.onPointerEnd(event), { signal, passive: false });
		layer.previewCanvas.addEventListener("lostpointercapture", (event) => this.onPointerLost(event as PointerEvent), { signal, passive: false });
	}

	private resizePageInkLayer(layer: PdfPageInkLayer, resizeCommitted = true) {
		const rect = layer.stage.getBoundingClientRect();
		const width = Math.max(1, rect.width);
		const height = Math.max(1, rect.height);
		const dpr = canvasDprForSize(width, height);
		const pixelWidth = Math.ceil(width * dpr);
		const pixelHeight = Math.ceil(height * dpr);
		for (const canvas of [layer.canvas, layer.previewCanvas, layer.predictionCanvas]) {
			if (canvas === layer.canvas && !resizeCommitted) continue;
			if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
				canvas.width = pixelWidth;
				canvas.height = pixelHeight;
				if (canvas === layer.canvas) layer.renderSignature = "";
			}
			const context = this.context(canvas);
			context.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
		if (layer.width !== width || layer.height !== height) {
			layer.width = width;
			layer.height = height;
			layer.renderSignature = "";
		}
	}

	private renderPageInkLayer(layer: PdfPageInkLayer, strokes: PdfInkStroke[]) {
		const width = Math.max(1, layer.width || layer.stage.getBoundingClientRect().width);
		const height = Math.max(1, layer.height || layer.stage.getBoundingClientRect().height);
		this.renderPageCanvas(layer.canvas, layer.pageNumber, width, height, strokes, (signature) => {
			if (layer.renderSignature === signature) return false;
			layer.renderSignature = signature;
			return true;
		});
	}

	private renderPageCanvas(
		canvas: HTMLCanvasElement,
		pageNumber: number,
		width: number,
		height: number,
		strokes: PdfInkStroke[],
		shouldRender: (signature: string) => boolean
	) {
		const signature = this.pageRenderSignature(pageNumber, width, height, strokes);
		if (!shouldRender(signature)) return;
		const context = this.context(canvas);
		const dpr = canvasDprForSize(width, height);
		const pixelWidth = Math.ceil(width * dpr);
		const pixelHeight = Math.ceil(height * dpr);
		if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
			this.renderPageCanvasOffscreen(canvas, width, height, pixelWidth, pixelHeight, dpr, strokes);
			return;
		}
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.clearRect(0, 0, width, height);
		for (const stroke of strokes) {
			renderStrokeOnPage(context, stroke, width, height, this.selectedStrokeIds.has(stroke.id) ? 0.45 : 1, this.strokeRenderCache);
		}
	}

	private renderPageCanvasOffscreen(
		canvas: HTMLCanvasElement,
		width: number,
		height: number,
		pixelWidth: number,
		pixelHeight: number,
		dpr: number,
		strokes: PdfInkStroke[]
	) {
		const buffer = document.createElement("canvas");
		buffer.width = pixelWidth;
		buffer.height = pixelHeight;
		const bufferContext = this.context(buffer);
		bufferContext.setTransform(dpr, 0, 0, dpr, 0, 0);
		bufferContext.clearRect(0, 0, width, height);
		for (const stroke of strokes) {
			renderStrokeOnPage(bufferContext, stroke, width, height, this.selectedStrokeIds.has(stroke.id) ? 0.45 : 1, this.strokeRenderCache);
		}
		canvas.width = pixelWidth;
		canvas.height = pixelHeight;
		const context = this.context(canvas);
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, pixelWidth, pixelHeight);
		context.drawImage(buffer, 0, 0);
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	private commitStrokeToVisibleLayer(stroke: PdfInkStroke) {
		const layer = this.pageInkLayers.get(stroke.pageNumber);
		if (!layer || !layer.stage.isConnected) return;
		this.resizePageInkLayer(layer, false);
		const width = Math.max(1, layer.width || layer.stage.getBoundingClientRect().width);
		const height = Math.max(1, layer.height || layer.stage.getBoundingClientRect().height);
		const dpr = canvasDprForSize(width, height);
		if (
			!layer.renderSignature
			|| this.selectedStrokeIds.size > 0
			|| layer.canvas.width !== Math.ceil(width * dpr)
			|| layer.canvas.height !== Math.ceil(height * dpr)
		) {
			this.renderPageNumberNow(stroke.pageNumber);
			return;
		}
		const context = this.context(layer.canvas);
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		renderStrokeOnPage(context, stroke, width, height, 1, this.strokeRenderCache);
		layer.renderSignature = this.pageRenderSignature(stroke.pageNumber, width, height, this.pageStrokes(stroke.pageNumber));
	}

	private renderPageNumberNow(pageNumber: number) {
		const layer = this.pageInkLayers.get(pageNumber);
		if (!layer || !layer.stage.isConnected) return;
		this.resizePageInkLayer(layer, false);
		layer.renderSignature = "";
		this.renderPageInkLayer(layer, this.pageStrokes(pageNumber));
	}

	private pageRenderSignature(pageNumber: number, width: number, height: number, strokes: PdfInkStroke[]) {
		const selected = this.selectedStrokeIds.size ? Array.from(this.selectedStrokeIds).sort().join(",") : "";
		return [
			pageNumber,
			Math.round(width * 10),
			Math.round(height * 10),
			selected,
			strokes.map(strokeSignature).join("|")
		].join(":");
	}

	private pruneStrokeRenderCache() {
		if (this.strokeRenderCache.size <= Math.max(256, this.data.strokes.length * 2)) return;
		const liveIds = new Set(this.data.strokes.map((stroke) => stroke.id));
		for (const id of Array.from(this.strokeRenderCache.keys())) {
			if (!liveIds.has(id)) this.strokeRenderCache.delete(id);
		}
	}

	private forgetStrokeRenderCache(strokes: PdfInkStroke[]) {
		for (const stroke of strokes) this.strokeRenderCache.delete(stroke.id);
	}

	private removePageInkLayer(layer: PdfPageInkLayer) {
		layer.stage.remove();
		if (layer === this.activeLayer) {
			this.activeLayer = null;
			this.stageHost = null;
		}
		layer.page.removeClass("anynote-pdf-page-host");
		if (layer.positionChanged) layer.page.style.position = layer.originalPosition;
	}

	private eraseAt(point: PdfInkPoint) {
		const removed: Array<{ stroke: PdfInkStroke; index: number }> = [];
		const remaining: PdfInkStroke[] = [];
		const pageNumber = this.currentPageNumber();
		this.data.strokes.forEach((stroke, index) => {
			if (stroke.pageNumber === pageNumber && strokeIntersectsPoint(this.strokeForCurrentStage(stroke), point, this.eraserRadius)) removed.push({ stroke: cloneStroke(stroke), index });
			else remaining.push(stroke);
		});
		if (removed.length === 0) return;
		this.data.strokes = remaining;
		this.undoStack.push({ type: "remove", strokes: removed });
		this.redoStack = [];
		this.forgetStrokeRenderCache(removed.map((item) => item.stroke));
		this.scheduleRenderPages([pageNumber]);
	}

	private tryResumeRecentPencilStroke(
		tool: PdfInkTool,
		point: PdfInkPoint,
		event: PointerEvent
	): PdfInkStroke | null {
		if (event.pointerType !== "pen" || !(tool === "pen" || tool === "ballpoint" || tool === "highlighter")) return null;
		const last = this.lastFinishedStroke;
		if (!last || last.pointerType !== "pen") return null;
		if (performance.now() - last.finishedAt > 240) return null;
		const stroke = last.stroke;
		const lastPoint = stroke.points[stroke.points.length - 1];
		if (!lastPoint) return null;
		const sameTool = stroke.tool === tool;
		const samePage = stroke.pageNumber === this.currentPageNumber();
		const sameSize = Math.abs(stroke.width - (tool === "highlighter" ? this.highlighterWidth : this.width)) < 0.75;
		const sameColor = stroke.color === (tool === "highlighter" ? this.highlighterColor : this.color);
		const maxGap = Math.max(26, stroke.width * 3.5);
		if (!sameTool || !samePage || !sameSize || !sameColor || distanceSquared(lastPoint, point) > maxGap * maxGap) return null;

		const currentIndex = this.data.strokes.findIndex((item) => item.id === stroke.id);
		if (currentIndex >= 0) this.data.strokes.splice(currentIndex, 1);
		const previousAction = this.undoStack[this.undoStack.length - 1];
		if (previousAction?.type === "add" && previousAction.stroke.id === stroke.id) this.undoStack.pop();
		this.lastFinishedStroke = null;
		this.forgetStrokeRenderCache([stroke]);
		this.renderPageNumberNow(stroke.pageNumber);
		return cloneStroke(stroke);
	}

	private deleteSelected() {
		if (this.selectedStrokeIds.size === 0) return;
		const removed: Array<{ stroke: PdfInkStroke; index: number }> = [];
		const remaining: PdfInkStroke[] = [];
		const affectedPages = new Set<number>();
		this.data.strokes.forEach((stroke, index) => {
			if (this.selectedStrokeIds.has(stroke.id)) {
				removed.push({ stroke: cloneStroke(stroke), index });
				affectedPages.add(stroke.pageNumber);
			}
			else remaining.push(stroke);
		});
		this.data.strokes = remaining;
		this.undoStack.push({ type: "remove", strokes: removed });
		this.redoStack = [];
		this.forgetStrokeRenderCache(removed.map((item) => item.stroke));
		this.clearSelection();
		this.scheduleRenderPages(affectedPages);
	}

	private currentPageNumber() {
		return getPageNumber(this.stageHost) || getPageNumber(this.findInkTarget()) || 1;
	}

	private currentPageStrokes() {
		return this.pageStrokes(this.currentPageNumber());
	}

	private pageStrokes(pageNumber: number) {
		return (this.data?.strokes || []).filter((stroke) => stroke.pageNumber === pageNumber);
	}

	private strokesByPage() {
		const byPage = new Map<number, PdfInkStroke[]>();
		for (const stroke of this.data?.strokes || []) {
			const strokes = byPage.get(stroke.pageNumber);
			if (strokes) strokes.push(stroke);
			else byPage.set(stroke.pageNumber, [stroke]);
		}
		return byPage;
	}

	private strokeForCurrentStage(stroke: PdfInkStroke): PdfInkStroke {
		return scaleStrokeToSize(stroke, this.currentStageWidth(), this.currentStageHeight(), this.data);
	}

	private currentStageWidth() {
		return Math.max(1, this.activeLayer?.width || this.lastStageRect?.width || this.stage?.getBoundingClientRect().width || this.canvas?.clientWidth || 1);
	}

	private currentStageHeight() {
		return Math.max(1, this.activeLayer?.height || this.lastStageRect?.height || this.stage?.getBoundingClientRect().height || this.canvas?.clientHeight || 1);
	}

	private undo() {
		const action = this.undoStack.pop();
		if (!action) return;
		const affectedPages = this.actionPageNumbers(action);
		if (action.type === "add") {
			this.data.strokes = this.data.strokes.filter((stroke) => stroke.id !== action.stroke.id);
			this.forgetStrokeRenderCache([action.stroke]);
		} else {
			for (const item of action.strokes.sort((a, b) => a.index - b.index)) this.data.strokes.splice(item.index, 0, cloneStroke(item.stroke));
		}
		this.redoStack.push(action);
		this.scheduleRenderPages(affectedPages);
	}

	private redo() {
		const action = this.redoStack.pop();
		if (!action) return;
		const affectedPages = this.actionPageNumbers(action);
		if (action.type === "add") this.data.strokes.push(cloneStroke(action.stroke));
		else {
			const ids = new Set(action.strokes.map((item) => item.stroke.id));
			this.data.strokes = this.data.strokes.filter((stroke) => !ids.has(stroke.id));
			this.forgetStrokeRenderCache(action.strokes.map((item) => item.stroke));
		}
		this.undoStack.push(action);
		this.scheduleRenderPages(affectedPages);
	}

	private actionPageNumbers(action: PdfInkAction): Set<number> {
		if (action.type === "add") return new Set([action.stroke.pageNumber]);
		return new Set(action.strokes.map((item) => item.stroke.pageNumber));
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
		return { version: 1, sourcePath: this.file.path, width: this.currentStageWidth(), height: this.currentStageHeight(), strokes: [], updatedAt: Date.now() };
	}

	private async save() {
		await this.writeCache();
		new Notice("PDF 批注已保存");
	}

	private async writeCache() {
		this.data.updatedAt = Date.now();
		this.data.sourcePath = this.file.path;
		this.data.width = this.currentStageWidth();
		this.data.height = this.currentStageHeight();
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
				pageNumber: Number.isFinite(stroke.pageNumber) && stroke.pageNumber > 0 ? Math.floor(stroke.pageNumber) : 1,
				pageWidth: Number.isFinite(stroke.pageWidth) && stroke.pageWidth > 0
					? stroke.pageWidth
					: (storedWidth !== undefined && Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : this.currentStageWidth()),
				pageHeight: Number.isFinite(stroke.pageHeight) && stroke.pageHeight > 0
					? stroke.pageHeight
					: (storedHeight !== undefined && Number.isFinite(storedHeight) && storedHeight > 0 ? storedHeight : this.currentStageHeight()),
				points: restorePointVelocities(stroke.points
					.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
					.map((point) => ({
						x: point.x,
						y: point.y,
						t: Number.isFinite(point.t) ? point.t : Date.now(),
						pressure: clamp(Number.isFinite(point.pressure) ? point.pressure : 0.5, 0.05, 1),
						velocity: Number.isFinite(point.velocity) ? point.velocity : undefined
					})))
			}))
			.filter((stroke) => stroke.points.length > 0);

		return {
			version: 1,
			sourcePath: typeof parsed.sourcePath === "string" ? parsed.sourcePath : this.file.path,
			width: storedWidth !== undefined && Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : this.currentStageWidth(),
			height: storedHeight !== undefined && Number.isFinite(storedHeight) && storedHeight > 0 ? storedHeight : this.currentStageHeight(),
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
			const pages = pdf.getPages();
			if (pages.length === 0) {
				new Notice("PDF 没有可导出的页面");
				return;
			}
			for (let index = 0; index < pages.length; index++) {
				drawPdfInkOnPage(pages[index], this.data, index + 1);
			}
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

	private resizeCanvases(resizeCommitted = true) {
		const rect = this.syncStageToInkTarget();
		for (const layer of this.pageInkLayers.values()) this.resizePageInkLayer(layer, resizeCommitted);
		if (this.activeLayer) this.resizePageInkLayer(this.activeLayer, resizeCommitted);
		else this.lastStageRect = rect;
	}

	private syncStageToInkTarget(): PdfInkRect {
		const target = this.pointerId === null ? this.findInkTarget() : this.stageHost || this.findInkTarget();
		if (target) this.activatePageLayer(target);
		else {
			for (const page of this.findPageTargets()) {
				const pageNumber = getPageNumber(page);
				if (!pageNumber) continue;
				this.activateLayer(this.ensurePageInkLayer(page, pageNumber));
				break;
			}
		}
		const stageRect = this.activeLayer?.stage.getBoundingClientRect();
		const fallback = fallbackInkRect(this.host.getBoundingClientRect());
		const nextRect = {
			x: 0,
			y: 0,
			width: Math.max(1, stageRect?.width || fallback.width),
			height: Math.max(1, stageRect?.height || fallback.height)
		};
		this.lastStageRect = nextRect;
		return nextRect;
	}

	private activatePageLayer(page: HTMLElement) {
		const pageNumber = getPageNumber(page);
		if (!pageNumber) return;
		this.activateLayer(this.ensurePageInkLayer(page, pageNumber));
	}

	private activateLayer(layer: PdfPageInkLayer) {
		this.activeLayer = layer;
		this.stageHost = layer.page;
		this.stage = layer.stage;
		this.canvas = layer.canvas;
		this.previewCanvas = layer.previewCanvas;
		this.predictionCanvas = layer.predictionCanvas;
		this.selectionBox = layer.selectionBox;
		this.lastStageRect = {
			x: 0,
			y: 0,
			width: Math.max(1, layer.width || layer.stage.getBoundingClientRect().width),
			height: Math.max(1, layer.height || layer.stage.getBoundingClientRect().height)
		};
		this.updateToolUi();
	}

	private findInkTarget(): HTMLElement | null {
		const hostRect = this.host.getBoundingClientRect();
		const candidates = this.findPageTargets();
		let best: { element: HTMLElement; score: number } | null = null;
		for (const element of candidates) {
			if (!getPageNumber(element)) continue;
			if (element.closest(".anynote-pdf-stage")) continue;
			if (element.closest(".anynote-pdf-overlay-root")) continue;
			if (isPdfThumbnailElement(element)) continue;
			const rect = element.getBoundingClientRect();
			if (rect.width < hostRect.width * 0.28 || rect.height < hostRect.height * 0.28) continue;
			const visibleWidth = Math.max(0, Math.min(rect.right, hostRect.right) - Math.max(rect.left, hostRect.left));
			const visibleHeight = Math.max(0, Math.min(rect.bottom, hostRect.bottom) - Math.max(rect.top, hostRect.top));
			const visibleArea = visibleWidth * visibleHeight;
			if (visibleArea <= 0) continue;
			const score = visibleArea + rect.width * rect.height * 0.08;
			if (!best || score > best.score) best = { element, score };
		}
		return best?.element || null;
	}

	private isPageNearViewport(page: HTMLElement, hostRect = this.host.getBoundingClientRect()) {
		const rect = page.getBoundingClientRect();
		const marginY = Math.max(hostRect.height, 1) * PAGE_VIRTUALIZATION_MARGIN;
		const marginX = Math.max(hostRect.width, 1) * 0.35;
		return rect.bottom >= hostRect.top - marginY
			&& rect.top <= hostRect.bottom + marginY
			&& rect.right >= hostRect.left - marginX
			&& rect.left <= hostRect.right + marginX;
	}

	private findPageAtPoint(clientX: number, clientY: number): HTMLElement | null {
		const hostRect = this.host.getBoundingClientRect();
		if (clientX < hostRect.left || clientX > hostRect.right || clientY < hostRect.top || clientY > hostRect.bottom) return null;
		const pages = new Set(this.findPageTargets());
		for (const element of document.elementsFromPoint(clientX, clientY)) {
			if (!(element instanceof HTMLElement)) continue;
			if (element.closest(".anynote-pdf-overlay-root")) continue;
			if (isPdfThumbnailElement(element)) continue;
			const page = element.closest<HTMLElement>(".page[data-page-number], .page, [data-page-number]") || element;
			if (!getPageNumber(page)) continue;
			if (!pages.has(page)) continue;
			const rect = page.getBoundingClientRect();
			if (rect.width < 80 || rect.height < 80) continue;
			return page;
		}
		return null;
	}

	private findPageTargets(): HTMLElement[] {
		const selectors = [
			".pdfViewer .page",
			".pdf-viewer .page",
			".pdf-container .page",
			".page[data-page-number]",
			"[data-page-number]",
			"canvas"
		];
		const candidates = new Set<HTMLElement>();
		for (const element of Array.from(this.host.querySelectorAll<HTMLElement>(selectors.join(",")))) {
			if (element.closest(".anynote-pdf-stage, .anynote-pdf-overlay-root")) continue;
			if (isPdfThumbnailElement(element)) continue;
			const page = this.resolvePdfPageElement(element);
			if (page) candidates.add(page);
		}
		return Array.from(candidates).map((page, index) => {
			if (!getPageNumber(page)) page.setAttr("data-anynote-page-number", String(index + 1));
			return page;
		});
	}

	private resolvePdfPageElement(element: HTMLElement): HTMLElement | null {
		const page = element.closest<HTMLElement>(".page[data-page-number], .page, [data-page-number]");
		if (page && page !== this.host) return page;
		if (!(element instanceof HTMLCanvasElement)) return element;
		const parent = element.parentElement;
		if (!(parent instanceof HTMLElement) || parent === this.host) return null;
		if (parent.closest(".anynote-pdf-overlay-root") || isPdfThumbnailElement(parent)) return null;
		const canvasRect = element.getBoundingClientRect();
		const parentRect = parent.getBoundingClientRect();
		const parentLooksLikePage = parentRect.width >= canvasRect.width * 0.92
			&& parentRect.height >= canvasRect.height * 0.92
			&& parentRect.width <= canvasRect.width * 1.25
			&& parentRect.height <= canvasRect.height * 1.35;
		return parentLooksLikePage ? parent : null;
	}

	private async waitForInkTarget(): Promise<boolean> {
		for (let index = 0; index < 25; index++) {
			if (this.findInkTarget()) return true;
			await delay(80);
		}
		return false;
	}

	private eventToPoint(event: PointerEvent): PdfInkPoint {
		const rect = this.previewCanvas.getBoundingClientRect();
		return {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
			t: event.timeStamp || performance.now(),
			pressure: normalizePointerPressure(event)
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
		const affectedPages = this.selectedStrokeIds.size
			? new Set((this.data?.strokes || []).filter((stroke) => this.selectedStrokeIds.has(stroke.id)).map((stroke) => stroke.pageNumber))
			: new Set<number>();
		this.selectedStrokeIds.clear();
		this.selectionStart = null;
		for (const layer of this.pageInkLayers.values()) layer.selectionBox.style.display = "none";
		this.scheduleRenderPages(affectedPages);
	}

	private updateSelectionBox(rect: PdfInkRect) {
		if (!this.selectionBox) return;
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

function withVelocity(last: PdfInkPoint, point: PdfInkPoint): PdfInkPoint {
	const distance = Math.sqrt(distanceSquared(last, point));
	const dt = Math.max(1, point.t - last.t);
	const velocity = distance / dt;
	return {
		...point,
		velocity: last.velocity === undefined ? velocity : last.velocity * 0.62 + velocity * 0.38
	};
}

function normalizePointerPressure(event: PointerEvent): number {
	const rawPressure = Number.isFinite(event.pressure) && event.pressure > 0 ? event.pressure : 0.5;
	const minPressure = event.pointerType === "pen" ? 0.24 : 0.05;
	return clamp(rawPressure, minPressure, 1);
}

function interpolateInkPoint(a: PdfInkPoint, b: PdfInkPoint, t: number): PdfInkPoint {
	return {
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t,
		t: a.t + (b.t - a.t) * t,
		pressure: a.pressure + (b.pressure - a.pressure) * t,
		velocity: a.velocity !== undefined && b.velocity !== undefined
			? a.velocity + (b.velocity - a.velocity) * t
			: a.velocity ?? b.velocity
	};
}

function predictStroke(stroke: PdfInkStroke): PdfInkStroke | null {
	if (stroke.tool === "highlighter" || stroke.points.length < 3) return null;
	const points = stroke.points;
	const a = points[points.length - 3];
	const b = points[points.length - 2];
	const c = points[points.length - 1];
	const dt = Math.max(1, c.t - b.t);
	const vx = (c.x - b.x) / dt;
	const vy = (c.y - b.y) / dt;
	const previousVx = (b.x - a.x) / Math.max(1, b.t - a.t);
	const previousVy = (b.y - a.y) / Math.max(1, b.t - a.t);
	const blendedVx = vx * 0.72 + previousVx * 0.28;
	const blendedVy = vy * 0.72 + previousVy * 0.28;
	const speed = Math.sqrt(blendedVx * blendedVx + blendedVy * blendedVy);
	if (speed < 0.08) return null;
	const horizonMs = clamp(18 + speed * 10, 18, 32);
	const maxDistance = stroke.tool === "ballpoint" ? 18 : 24;
	const dx = clamp(blendedVx * horizonMs, -maxDistance, maxDistance);
	const dy = clamp(blendedVy * horizonMs, -maxDistance, maxDistance);
	const predictedPoint: PdfInkPoint = {
		x: c.x + dx,
		y: c.y + dy,
		t: c.t + horizonMs,
		pressure: c.pressure,
		velocity: c.velocity
	};
	return {
		...stroke,
		points: [b, c, predictedPoint]
	};
}

function renderStroke(context: CanvasRenderingContext2D, stroke: PdfInkStroke, alphaScale = 1) {
	if (stroke.points.length === 0) return;
	const renderCache = buildStrokeRenderCache(stroke);
	renderCachedStroke(context, stroke, renderCache, alphaScale);
}

function renderLiveStroke(context: CanvasRenderingContext2D, stroke: PdfInkStroke, alphaScale = 1) {
	const points = stroke.points;
	if (points.length === 0) return;
	context.save();
	context.strokeStyle = stroke.color;
	context.fillStyle = stroke.color;
	context.globalAlpha = (stroke.tool === "highlighter" ? 0.34 : 1) * alphaScale;
	context.globalCompositeOperation = stroke.tool === "highlighter" ? "multiply" : "source-over";
	context.lineCap = "round";
	context.lineJoin = "round";

	if (points.length === 1) {
		const radius = Math.max(0.5, strokeWidthAt(stroke, points[0]) / 2);
		context.beginPath();
		context.arc(points[0].x, points[0].y, radius, 0, Math.PI * 2);
		context.fill();
		context.restore();
		return;
	}

	const fixedWidth = stroke.tool === "highlighter" || stroke.tool === "ballpoint";
	if (fixedWidth) {
		context.lineWidth = Math.max(1, stroke.tool === "highlighter" ? stroke.width : stroke.width * 1.05);
		context.beginPath();
		context.moveTo(points[0].x, points[0].y);
		for (let index = 1; index < points.length - 1; index++) {
			const current = points[index];
			const next = points[index + 1];
			context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
		}
		const last = points[points.length - 1];
		context.lineTo(last.x, last.y);
		context.stroke();
		context.restore();
		return;
	}

	for (let index = 1; index < points.length; index++) {
		const previous = points[index - 1];
		const current = points[index];
		context.lineWidth = Math.max(0.7, strokeWidthAt(stroke, current));
		context.beginPath();
		context.moveTo(previous.x, previous.y);
		context.lineTo(current.x, current.y);
		context.stroke();
	}
	context.restore();
}

function renderStrokeOnPage(
	context: CanvasRenderingContext2D,
	stroke: PdfInkStroke,
	targetWidth: number,
	targetHeight: number,
	alphaScale: number,
	cache: Map<string, PdfStrokeRenderCache>
) {
	if (stroke.points.length === 0) return;
	const sourceWidth = Math.max(1, stroke.pageWidth || targetWidth);
	const sourceHeight = Math.max(1, stroke.pageHeight || targetHeight);
	const scaleX = Math.max(1, targetWidth) / sourceWidth;
	const scaleY = Math.max(1, targetHeight) / sourceHeight;
	let renderCache = cache.get(stroke.id);
	const signature = strokeSignature(stroke);
	if (!renderCache || renderCache.signature !== signature) {
		renderCache = buildStrokeRenderCache(stroke, signature);
		cache.set(stroke.id, renderCache);
	}
	context.save();
	context.scale(scaleX, scaleY);
	renderCachedStroke(context, stroke, renderCache, alphaScale);
	context.restore();
}

function buildStrokeRenderCache(stroke: PdfInkStroke, signature = strokeSignature(stroke)): PdfStrokeRenderCache {
	const options = getTldrawFreehandOptions(stroke, true);
	const strokePoints = getStrokePoints(toTldrawPoints(stroke.points), options);
	setStrokePointRadii(strokePoints, options);
	const kind = stroke.tool === "highlighter" || stroke.tool === "ballpoint" ? "centerline" : "ink";
	return {
		signature,
		kind,
		strokePoints,
		path: kind === "ink" ? createTldrawInkPath(strokePoints, options) : createCenterlinePath(strokePoints),
		width: options.size ?? stroke.width,
		options
	};
}

function renderCachedStroke(
	context: CanvasRenderingContext2D,
	stroke: PdfInkStroke,
	renderCache: PdfStrokeRenderCache,
	alphaScale = 1
) {
	context.save();
	context.fillStyle = stroke.color;
	context.strokeStyle = stroke.color;
	context.globalAlpha = (stroke.tool === "highlighter" ? 0.34 : 1) * alphaScale;
	context.globalCompositeOperation = stroke.tool === "highlighter" ? "multiply" : "source-over";

	if (renderCache.kind === "centerline") {
		context.lineWidth = Math.max(1, renderCache.width);
		context.lineCap = "round";
		context.lineJoin = "round";
		if (renderCache.path) context.stroke(renderCache.path);
		else strokeTldrawCenterline(context, renderCache.strokePoints, renderCache.width);
		context.restore();
		return;
	}

	if (renderCache.path) context.fill(renderCache.path);
	else drawTldrawInkStrokePoints(context, renderCache.strokePoints, renderCache.options);
	context.restore();
}

function createCenterlinePath(strokePoints: StrokePoint[]): Path2D | null {
	if (typeof Path2D === "undefined" || strokePoints.length === 0) return null;
	const points = strokePoints.map((point) => point.point);
	if (points.length < 2) return null;
	const path = new Path2D();
	path.moveTo(points[0].x, points[0].y);
	if (points.length === 2) {
		path.lineTo(points[1].x, points[1].y);
		return path;
	}
	let previousControl: PdfVector = points[1];
	path.quadraticCurveTo(
		points[1].x,
		points[1].y,
		(points[1].x + points[2].x) / 2,
		(points[1].y + points[2].y) / 2
	);
	let current: PdfVector = { x: (points[1].x + points[2].x) / 2, y: (points[1].y + points[2].y) / 2 };
	for (let index = 2, max = points.length - 1; index < max; index++) {
		const reflected = {
			x: current.x * 2 - previousControl.x,
			y: current.y * 2 - previousControl.y
		};
		const end = {
			x: (points[index].x + points[index + 1].x) / 2,
			y: (points[index].y + points[index + 1].y) / 2
		};
		path.quadraticCurveTo(reflected.x, reflected.y, end.x, end.y);
		previousControl = reflected;
		current = end;
	}
	const last = points[points.length - 1];
	path.lineTo(last.x, last.y);
	return path;
}

interface PdfVector {
	x: number;
	y: number;
}

function getTldrawFreehandOptions(stroke: PdfInkStroke, complete: boolean): StrokeOptions {
	if (stroke.tool === "highlighter") {
		return {
			size: Math.max(1, 1 + stroke.width),
			thinning: 0,
			streamline: 0.5,
			smoothing: 0.5,
			simulatePressure: false,
			easing: TLDRAW_EASINGS.easeOutSine,
			last: complete
		};
	}
	if (stroke.tool === "ballpoint") {
		return {
			size: Math.max(0.75, stroke.width * 1.05),
			thinning: 0,
			streamline: 0.62,
			smoothing: 0.62,
			simulatePressure: false,
			easing: TLDRAW_EASINGS.linear,
			last: complete
		};
	}
	return {
		size: Math.max(0.75, 1 + stroke.width * 1.2),
		thinning: 0.62,
		streamline: 0.62,
		smoothing: 0.62,
		simulatePressure: false,
		easing: TLDRAW_EASINGS.pen,
		last: complete
	};
}

function toTldrawPoints(points: PdfInkPoint[]): VecLike[] {
	return points.map((point) => ({
		x: point.x,
		y: point.y,
		z: clamp(point.pressure, 0.01, 1)
	}));
}

function strokeTldrawCenterline(context: CanvasRenderingContext2D, strokePoints: StrokePoint[], width: number) {
	if (strokePoints.length === 0) return;
	context.strokeStyle = context.fillStyle;
	context.lineWidth = Math.max(1, width);
	context.lineCap = "round";
	context.lineJoin = "round";
	context.beginPath();
	if (strokePoints.length < 2) {
		const point = strokePoints[0].point;
		context.arc(point.x, point.y, Math.max(0.5, width / 2), 0, Math.PI * 2);
		context.fill();
		return;
	}
	const points = strokePoints.map((point) => point.point);
	context.moveTo(points[0].x, points[0].y);
	if (points.length === 2) {
		context.lineTo(points[1].x, points[1].y);
		context.stroke();
		return;
	}
	let previousControl: PdfVector = points[1];
	context.quadraticCurveTo(
		points[1].x,
		points[1].y,
		(points[1].x + points[2].x) / 2,
		(points[1].y + points[2].y) / 2
	);
	let current: PdfVector = { x: (points[1].x + points[2].x) / 2, y: (points[1].y + points[2].y) / 2 };
	for (let index = 2, max = points.length - 1; index < max; index++) {
		const reflected = {
			x: current.x * 2 - previousControl.x,
			y: current.y * 2 - previousControl.y
		};
		const end = {
			x: (points[index].x + points[index + 1].x) / 2,
			y: (points[index].y + points[index + 1].y) / 2
		};
		context.quadraticCurveTo(reflected.x, reflected.y, end.x, end.y);
		previousControl = reflected;
		current = end;
	}
	const last = points[points.length - 1];
	context.lineTo(last.x, last.y);
	context.stroke();
}

function strokeWidthAt(stroke: PdfInkStroke, point: PdfInkPoint) {
	if (stroke.tool === "highlighter") return stroke.width;
	if (stroke.tool === "ballpoint") return Math.max(0.5, stroke.width * 0.96);
	const velocity = point.velocity ?? 0.4;
	const velocityFactor = clamp(1.18 - velocity * 0.34, 0.72, 1.18);
	const pressureFactor = 0.54 + clamp(point.pressure, 0.05, 1) * 0.68;
	return Math.max(0.45, stroke.width * velocityFactor * pressureFactor);
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

function strokeSignature(stroke: PdfInkStroke): string {
	const first = stroke.points[0];
	const last = stroke.points[stroke.points.length - 1] || first;
	return [
		stroke.id,
		stroke.tool,
		stroke.width,
		stroke.pageNumber,
		Math.round((stroke.pageWidth || 0) * 10),
		Math.round((stroke.pageHeight || 0) * 10),
		stroke.points.length,
		first ? `${Math.round(first.x * 10)},${Math.round(first.y * 10)},${Math.round(first.pressure * 100)}` : "",
		last ? `${Math.round(last.x * 10)},${Math.round(last.y * 10)},${Math.round(last.pressure * 100)},${Math.round(last.t)}` : ""
	].join(",");
}

function scaleStrokeToSize(stroke: PdfInkStroke, targetWidth: number, targetHeight: number, data?: PdfInkData): PdfInkStroke {
	const sourceWidth = Math.max(1, stroke.pageWidth || data?.width || targetWidth);
	const sourceHeight = Math.max(1, stroke.pageHeight || data?.height || targetHeight);
	targetWidth = Math.max(1, targetWidth);
	targetHeight = Math.max(1, targetHeight);
	if (Math.abs(sourceWidth - targetWidth) < 0.5 && Math.abs(sourceHeight - targetHeight) < 0.5) return stroke;
	const scaleX = targetWidth / sourceWidth;
	const scaleY = targetHeight / sourceHeight;
	return {
		...stroke,
		width: stroke.width * ((scaleX + scaleY) / 2),
		pageWidth: targetWidth,
		pageHeight: targetHeight,
		points: stroke.points.map((point) => ({
			...point,
			x: point.x * scaleX,
			y: point.y * scaleY
		}))
	};
}

function restorePointVelocities(points: PdfInkPoint[]): PdfInkPoint[] {
	return points.map((point, index) => {
		const previous = points[index - 1];
		if (point.velocity !== undefined || !previous) return point;
		const distance = Math.sqrt(distanceSquared(previous, point));
		const dt = Math.max(1, point.t - previous.t);
		return {
			...point,
			velocity: distance / dt
		};
	});
}

function drawPdfInkOnPage(page: PDFPage, data: PdfInkData, pageNumber: number) {
	const { width: pageWidth, height: pageHeight } = page.getSize();
	for (const stroke of data.strokes.filter((item) => item.pageNumber === pageNumber)) {
		const sourceWidth = Math.max(1, stroke.pageWidth || data.width);
		const sourceHeight = Math.max(1, stroke.pageHeight || data.height);
		const scaleX = pageWidth / sourceWidth;
		const scaleY = pageHeight / sourceHeight;
		const scale = (scaleX + scaleY) / 2;
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
			page.drawLine({
				start,
				end,
				thickness: Math.max(0.25, strokeWidthAt(stroke, b) * scale),
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

function canvasDprForSize(width: number, height: number): number {
	const deviceDpr = Math.min(window.devicePixelRatio || 1, 2);
	const maxPixels = Platform.isMobile ? MAX_PDF_CANVAS_PIXELS_MOBILE : MAX_PDF_CANVAS_PIXELS_DESKTOP;
	const area = Math.max(1, width * height);
	const budgetDpr = Math.sqrt(maxPixels / area);
	return clamp(Math.min(deviceDpr, budgetDpr), 0.5, deviceDpr);
}

function rectRelativeToHost(target: DOMRect, host: DOMRect): PdfInkRect {
	return {
		x: target.left - host.left,
		y: target.top - host.top,
		width: target.width,
		height: target.height
	};
}

function fallbackInkRect(host: DOMRect): PdfInkRect {
	return {
		x: Math.max(0, host.width * 0.18),
		y: Math.max(0, host.height * 0.08),
		width: Math.max(1, host.width * 0.7),
		height: Math.max(1, host.height * 0.84)
	};
}

function sameRect(a: PdfInkRect | null, b: PdfInkRect) {
	if (!a) return false;
	return Math.abs(a.x - b.x) < 0.5
		&& Math.abs(a.y - b.y) < 0.5
		&& Math.abs(a.width - b.width) < 0.5
		&& Math.abs(a.height - b.height) < 0.5;
}

function getPageNumber(element: HTMLElement | null): number | null {
	const page = element?.closest<HTMLElement>("[data-page-number], [data-anynote-page-number], .page");
	const value = page?.getAttr("data-page-number")
		|| page?.getAttr("data-anynote-page-number")
		|| element?.getAttr("data-page-number")
		|| element?.getAttr("data-anynote-page-number");
	const parsed = value ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function isPdfThumbnailElement(element: HTMLElement): boolean {
	return Boolean(element.closest(".thumbnail, .thumbnailView, .pdf-thumbnail, .pdf-sidebar, .sidebar, .tree-item"));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function dockFromPoint(x: number, y: number): ToolbarDock {
	const width = Math.max(1, window.innerWidth);
	const height = Math.max(1, window.innerHeight);
	const distances: Array<{ dock: ToolbarDock; distance: number }> = [
		{ dock: "top", distance: y },
		{ dock: "bottom", distance: height - y },
		{ dock: "left", distance: x },
		{ dock: "right", distance: width - x }
	];
	distances.sort((a, b) => a.distance - b.distance);
	return distances[0].dock;
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
