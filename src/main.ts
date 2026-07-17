import './ddc-library/settings-styles.scss';
import { Editor, Notice, Plugin, TFile, addIcon } from 'obsidian';
import { DEFAULT_SETTINGS, PluginSettings } from 'src/types/plugin-settings';
import { registerSettingsTab } from './tabs/settings-tab/settings-tab';
import {registerWritingEmbed} from './extensions/widgets/writing-embed-widget'
import insertExistingWritingFile from './commands/insert-existing-writing-file';
import insertNewWritingFile from './commands/insert-new-writing-file';
import { registerWritingView } from './views/writing-view';
import insertNewDrawingFile from './commands/insert-new-drawing-file';
import insertExistingDrawingFile from './commands/insert-existing-drawing-file';
import { registerDrawingView } from './views/drawing-view';
import { registerDrawingEmbed } from './extensions/widgets/drawing-embed-widget';
import insertRememberedDrawingFile from './commands/insert-remembered-drawing-file';
import insertRememberedWritingFile from './commands/insert-remembered-writing-file';
import { showWelcomeTips_maybe } from './notices/welcome-notice';
import { blueskySvgStr, mastodonSvgStr, threadsSvgStr, twitterSvgStr } from './graphics/social-icons/social-icons';
import * as semver from "semver";
import { showVersionNotice } from './notices/version-notices';
import { atom, useSetAtom } from 'jotai';
import { debug } from './utils/log-to-console';
import { drawDefaultSvgStr, writeDefaultSvgStr, writeExistingSvgStr, writePasteSvgStr } from './graphics/icons/command-icons';
import { drawExistingSvgStr, drawPasteSvgStr } from './graphics/icons/command-icons';
import { PdfInkModal } from './pdf/pdf-ink-modal';

////////
////////

export default class InkPlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		// const setPlugin = useSetAtom(inkPluginAtom);
		// setPlugin(this);

		addIcon('write_default', writeDefaultSvgStr);
		addIcon('write_existing', writeExistingSvgStr);
		addIcon('write_paste', writePasteSvgStr);

		addIcon('draw_default', drawDefaultSvgStr);
		addIcon('draw_existing', drawExistingSvgStr);
		addIcon('draw_paste', drawPasteSvgStr);

		addIcon('bluesky', blueskySvgStr);
		addIcon('mastodon', mastodonSvgStr);
		addIcon('threads', threadsSvgStr);
		addIcon('twitter', twitterSvgStr);

		//: NOTE: For testing only
		// this.app.emulateMobile(true);	// Use this as true or false in console to switch
		// implementHandwrittenNoteAction(this)
		// implementHandDrawnNoteAction(this)

		if(this.settings.writingEnabled) {
			registerWritingView(this);
			registerWritingEmbed(this);
			implementWritingEmbedActions(this);
		}
		
		if(this.settings.drawingEnabled) {
			registerDrawingView(this);
			registerDrawingEmbed(this);		
			implementDrawingEmbedActions(this);
		}

		implementPdfAnnotationActions(this);
		
		registerSettingsTab(this);

		// // If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// // Using this function will automatically remove the event listener when this plugin is disabled.
		// // this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
		// // 	console.log('click', evt);
		// // });

		showOnboardingTips_maybe(this);
	}
	
	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async resetSettings() {
		this.settings = JSON.parse( JSON.stringify(DEFAULT_SETTINGS) );
		this.saveSettings();
		new Notice('Ink 设置已重置');
	}
}

export const inkPluginAtom = atom<InkPlugin>();

function implementWritingEmbedActions(plugin: InkPlugin) {
	plugin.addCommand({
		id: 'create-handwritten-section',
		name: '新建手写区域',
		icon: 'write_default',
		editorCallback: (editor: Editor) => insertNewWritingFile(plugin, editor)
	});
	plugin.addCommand({
		id: 'embed-writing-file',
		name: '插入已有手写区域',
		icon: 'write_existing',
		editorCallback: (editor: Editor) => insertExistingWritingFile(plugin, editor)
	});
	plugin.addCommand({
		id: 'insert-copied-writing',
		name: '插入已复制手写区域',
		icon: 'write_paste',
		editorCallback: (editor: Editor) => insertRememberedWritingFile(plugin, editor)
	});
}

function implementDrawingEmbedActions(plugin: InkPlugin) {
	plugin.addCommand({
		id: 'create-drawing-section',
		name: '新建绘图',
		icon: 'draw_default',
		editorCallback: (editor: Editor) => insertNewDrawingFile(plugin, editor)
	});
	plugin.addCommand({
		id: 'embed-drawing-file',
		name: '插入已有绘图',
		icon: 'draw_existing',
		editorCallback: (editor: Editor) => insertExistingDrawingFile(plugin, editor)
	});
	plugin.addCommand({
		id: 'insert-copied-drawing',
		name: '插入已复制绘图',
		icon: 'draw_paste',
		editorCallback: (editor: Editor) => insertRememberedDrawingFile(plugin, editor)
	});
}

// function implementHandwrittenNoteAction(plugin: InkPlugin) {
// 	plugin.addCommand({
// 		id: 'create-writing-file',
// 		name: 'Create new handwritten note',
// 		callback: async () => {
// 			const fileRef = await createNewWritingFile(plugin);
// 			openInkFile(plugin, fileRef);
// 		}
// 	});
// 	plugin.addRibbonIcon("pencil", "New handwritten note", async () => {
// 		const fileRef = await createNewWritingFile(plugin);
// 		openInkFile(plugin, fileRef);
// 	});
// }

// function implementHandDrawnNoteAction(plugin: InkPlugin) {
// 	plugin.addCommand({
// 		id: 'create-drawing-file',
// 		name: 'Create new drawing',
// 		callback: async () => {
// 			const fileRef = await createNewDrawingFile(plugin);
// 			openInkFile(plugin, fileRef);
// 		}
// 	});
// 	plugin.addRibbonIcon("pencil", "New hand drawn note", async () => {
// 		const fileRef = await createNewDrawingFile(plugin);
// 		openInkFile(plugin, fileRef);
// 	});
// }

function showOnboardingTips_maybe(plugin: InkPlugin) {
	const newInstall = showWelcomeTips_maybe(plugin);

	if(!newInstall) {
		showVersionNotice(plugin);
	}
}

function implementPdfAnnotationActions(plugin: InkPlugin) {
	plugin.addCommand({
		id: 'annotate-pdf-with-ink',
		name: 'PDF 手写批注',
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			const canAnnotate = file instanceof TFile && file.extension.toLowerCase() === 'pdf';
			if (canAnnotate && !checking) {
				new PdfInkModal(plugin.app, plugin, file).open();
			}
			return canAnnotate;
		}
	});

	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, file) => {
			if (file instanceof TFile && file.extension.toLowerCase() === 'pdf') {
				menu.addItem((item) => {
					item
						.setTitle('PDF 手写批注')
						.setIcon('pen-line')
						.onClick(() => new PdfInkModal(plugin.app, plugin, file).open());
				});
			}
		})
	);
}
