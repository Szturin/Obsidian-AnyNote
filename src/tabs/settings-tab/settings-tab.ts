import { createSupportButtonSet } from 'src/components/dom-components/support-button-set';
import './settings-tab.scss';
import { App, PluginSettingTab, Setting } from "obsidian";
import InkPlugin from "src/main";
import MyPlugin from "src/main";
import { ConfirmationModal } from "src/modals/confirmation-modal/confirmation-modal";
import { DEFAULT_SETTINGS } from 'src/types/plugin-settings';
import { showWelcomeTips, showWelcomeTips_maybe } from 'src/notices/welcome-notice';
import { ToggleAccordionSetting } from 'src/components/dom-components/toggle-accordion-setting';

/////////
/////////

export function registerSettingsTab(plugin: InkPlugin) {
	plugin.addSettingTab(new MySettingsTab(plugin.app, plugin));
}

export class MySettingsTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		
		containerEl.createEl('h1').setText('Ink 手写');
		containerEl.createEl('p').setText('在 Obsidian 笔记段落之间直接使用触控笔手写或绘图。');
		
		containerEl.createEl('hr');
		insertMoreInfoLinks(containerEl);
		insertPrereleaseWarning(containerEl);
		insertSetupGuide(this.plugin, containerEl);

		insertHighLevelSettings(containerEl, this.plugin, () => this.display());
		insertSubfolderSettings(containerEl, this.plugin, () => this.display());

		containerEl.createEl('hr');
		if(this.plugin.settings.writingEnabled)	insertWritingSettings(containerEl, this.plugin, () => this.display());
		if(this.plugin.settings.drawingEnabled)	insertDrawingSettings(containerEl, this.plugin, () => this.display());
	
		new Setting(containerEl)
			.addButton( (button) => {
				button.setButtonText('重置设置');
				button.onClick(() => {
					new ConfirmationModal({
						plugin: this.plugin,
						title: '请确认',
						message: '要将 Ink 插件恢复为默认设置吗？',
						confirmLabel: '重置设置',
						confirmAction: async () => {
							await this.plugin.resetSettings();
							this.display();
						}
					}).open();
				})
			})

		createSupportButtonSet(containerEl);
		

	}
}

function insertSetupGuide(plugin: InkPlugin, containerEl: HTMLElement) {
	const sectionEl = containerEl.createDiv('ddc_ink_section ddc_ink_setup-guide-section');
	const accordionEl = sectionEl.createEl('details');
	accordionEl.createEl('summary', { text: `展开设置提示` });

	new Setting(accordionEl)
		.setClass('ddc_ink_setting')
		.setName('斜杠命令')
		.setDesc(`为了更顺手地插入手写区域，可以在 Obsidian 设置 / 核心插件中启用“斜杠命令”，或安装 Slash Commander 插件。`)

	new Setting(accordionEl)
		.setClass('ddc_ink_setting')
		.setName('Apple Pencil 随手写')
		.setDesc(`如果使用 iPad，Apple Pencil 的“随手写”可能干扰 Ink 区域输入。建议在 iPadOS 设置中关闭它以获得更好的书写体验。`)

	new Setting(accordionEl)
		.setClass('ddc_ink_setting')
		.setName('Obsidian Sync')
		.setDesc(`如果使用 Obsidian Sync，请在同步设置里开启“同步所有其他类型文件”。`)

	new Setting(accordionEl)
		.addButton( btn => {
			btn.setButtonText('重新查看欢迎提示');
			btn.onClick( () => showWelcomeTips(plugin) );
			btn.setCta();
		})
}

function insertMoreInfoLinks(containerEl: HTMLElement) {
	const sectionEl = containerEl.createDiv('ddc_ink_section');
	sectionEl.createEl('p', { text: `以下链接来自上游 Ink 项目，可用于了解原插件的发展路线和问题记录。` });
	const list = sectionEl.createEl('ul');
	list.createEl('li').createEl('a', {
		href: 'https://github.com/daledesilva/obsidian_ink/releases',
		text: '最新变更'
	});
	list.createEl('li').createEl('a', {
		href: 'https://github.com/daledesilva/obsidian_ink',
		text: '路线图'
	});
	list.createEl('li').createEl('a', {
		href: 'https://www.youtube.com/playlist?list=PLAiv7XV4xFx2NMRSCxdGiVombKO-TiMAL',
		text: '开发日志'
	});
	list.createEl('li').createEl('a', {
		href: 'https://github.com/daledesilva/obsidian_ink/issues',
		text: '功能建议 / Bug 反馈'
	});
}

function insertHighLevelSettings(containerEl: HTMLElement, plugin: InkPlugin, refresh: Function) {

	new Setting(containerEl)
		.setClass('ddc_ink_setting')
		.setName('启用手写')
		// .setDesc('If disabled, you will still be able to view previously created writing embeds.')
		.setDesc('关闭后将无法新增手写嵌入，已有嵌入会显示为原始代码；现有手写文件仍保留在磁盘上。修改后需要重启 Obsidian 生效。')
		.addToggle((toggle) => {
			toggle.setValue(plugin.settings.writingEnabled);
			toggle.onChange(async (value) => {
				plugin.settings.writingEnabled = value;
				await plugin.saveSettings();
				refresh();
			});
		});

	new Setting(containerEl)
		.setClass('ddc_ink_setting')
		.setName('启用绘图')
		// .setDesc('If disabled, you will still be able to view previously created drawing embeds.')
		.setDesc('关闭后将无法新增绘图嵌入，已有嵌入会显示为原始代码；现有绘图文件仍保留在磁盘上。修改后需要重启 Obsidian 生效。')
		.addToggle((toggle) => {
			toggle.setValue(plugin.settings.drawingEnabled);
			toggle.onChange(async (value) => {
				plugin.settings.drawingEnabled = value;
				await plugin.saveSettings();
				refresh();
			});
		});

}

function insertSubfolderSettings(containerEl: HTMLElement, plugin: InkPlugin, refresh: Function) {

	const saveWritingFolder = async (enteredValue: string) => {
		const value = enteredValue || DEFAULT_SETTINGS.writingSubfolder;
		plugin.settings.writingSubfolder = value.trim();
		await plugin.saveSettings();
		refresh();
	}

	const saveDrawingFolder = async (enteredValue: string) => {
		const value = enteredValue || DEFAULT_SETTINGS.drawingSubfolder;
		plugin.settings.drawingSubfolder = value.trim();
		await plugin.saveSettings();
		refresh();
	}

	const accordionSection = new ToggleAccordionSetting(containerEl)
		.setName('自定义文件组织方式')
		.setExpanded(plugin.settings.customAttachmentFolders)
		.onToggle( async (value: boolean) => {
			plugin.settings.customAttachmentFolders = value;
			await plugin.saveSettings();
			refresh();
		})
		.setContent((container) => {
			// TODO: This should be abstracted as a dom component
			new Setting(container)
				.setClass('ddc_ink_button-set')
				.setName(`在笔记中创建 Ink 文件时保存到哪里？`)
				// .setDesc(`The writing and drawing files will be saved into same location as other Obsidian attachments rather than the vault's root folder. The files will still be organised into the subfolders you specify below. You can change the default Obsidian attachment path in in the Files and links tab.`)
				.addButton( (button) => {
					button.setButtonText('Obsidian 附件文件夹')
					button.setClass('ddc_ink_left-most')
					if(plugin.settings.noteAttachmentFolderLocation === 'obsidian') {
						button.setCta()
						button.setDisabled(true)
					}
					button.onClick( async (e) => {
						plugin.settings.noteAttachmentFolderLocation = 'obsidian';
						await plugin.saveSettings();
						refresh();
					})
				})
				.addButton( (button) => {
					button.setButtonText('库根目录')
					button.setClass('ddc_ink_middle')
					if(plugin.settings.noteAttachmentFolderLocation === 'root') {
						button.setCta()
						button.setDisabled(true)
					}
					button.onClick( async (e) => {
						plugin.settings.noteAttachmentFolderLocation = 'root';
						await plugin.saveSettings();
						refresh();
					})
				})
				.addButton( (button) => {
					button.setButtonText('笔记旁边')
					button.setClass('ddc_ink_right-most')
					if(plugin.settings.noteAttachmentFolderLocation === 'note') {
						button.setCta()
						button.setDisabled(true)
					}
					button.onClick( async (e) => {
						plugin.settings.noteAttachmentFolderLocation = 'note';
						await plugin.saveSettings();
						refresh();
					})
				})
			// TODO: This should be abstracted as a dom component
			// new Setting(container)
			// 	.setClass('ddc_ink_button-set')
			// 	.setName(`Where should Ink files be saved when created independantly?`)
			// 	// .setDesc(`The writing and drawing files will be saved into same location as other Obsidian attachments rather than the vault's root folder. The files will still be organised into the subfolders you specify below. You can change the default Obsidian attachment path in in the Files and links tab.`)
			// 	.addButton( (button) => {
			// 		button.setButtonText('Obsidian attachment folder')
			// 		button.setClass('ddc_ink_left-most')
			// 		if(plugin.settings.notelessAttachmentFolderLocation === 'obsidian') {
			// 			button.setCta()
			// 			button.setDisabled(true)
			// 		}
			// 		button.onClick( async (e) => {
			// 			plugin.settings.notelessAttachmentFolderLocation = 'obsidian';
			// 			await plugin.saveSettings();
			// 			refresh();
			// 		})
			// 	})
			// 	.addButton( (button) => {
			// 		button.setButtonText('Vault root')
			// 		button.setClass('ddc_ink_middle')
			// 		if(plugin.settings.notelessAttachmentFolderLocation === 'root') {
			// 			button.setCta()
			// 			button.setDisabled(true)
			// 		}
			// 		button.onClick( async (e) => {
			// 			plugin.settings.notelessAttachmentFolderLocation = 'root';
			// 			await plugin.saveSettings();
			// 			refresh();
			// 		})
			// 	})

			let inputSettingEl = new Setting(container)
				.setClass('ddc_ink_setting')
				.setName('手写文件子文件夹')
				.addText((textItem) => {
					textItem.setValue(plugin.settings.writingSubfolder.toString());
					textItem.setPlaceholder(DEFAULT_SETTINGS.writingSubfolder.toString());
					textItem.inputEl.addEventListener('blur', async (ev: FocusEvent) => {
						saveWritingFolder(textItem.getValue());
					})
					textItem.inputEl.addEventListener('keypress', async (ev: KeyboardEvent) => {
						if(ev.key === 'Enter') saveWritingFolder(textItem.getValue());
					})
				});
			inputSettingEl.settingEl.classList.add('ddc_ink_input-medium');

			inputSettingEl = new Setting(container)
				.setClass('ddc_ink_setting')
				.setName('绘图文件子文件夹')
				.addText((textItem) => {
					textItem.setValue(plugin.settings.drawingSubfolder.toString());
					textItem.setPlaceholder(DEFAULT_SETTINGS.drawingSubfolder.toString());
					textItem.inputEl.addEventListener('blur', async (ev: FocusEvent) => {
						saveDrawingFolder(textItem.getValue());
					})
					textItem.inputEl.addEventListener('keypress', async (ev: KeyboardEvent) => {
						if(ev.key === 'Enter') saveDrawingFolder(textItem.getValue());
					})
				});
			inputSettingEl.settingEl.classList.add('ddc_ink_input-medium');
		})


}

function insertDrawingSettings(containerEl: HTMLElement, plugin: InkPlugin, refresh: Function) {
	const sectionEl = containerEl.createDiv('ddc_ink_section ddc_ink_controls-section');
	sectionEl.createEl('h2', { text: '绘图' });
	sectionEl.createEl('p', { text: `编辑 Markdown 文件时，运行“新建绘图”命令即可嵌入绘图画布。` });

	new Setting(sectionEl)
		.setClass('ddc_ink_setting')
		.setName('非编辑状态显示绘图边框')

		.addToggle((toggle) => {
			toggle.setValue(plugin.settings.drawingFrameWhenLocked);
			toggle.onChange( async (value: boolean) => {
				plugin.settings.drawingFrameWhenLocked = value;
				await plugin.saveSettings();
				refresh();
			})
		});

	new Setting(sectionEl)
		.setClass('ddc_ink_setting')
		.setName('非编辑状态显示背景')

		.addToggle((toggle) => {
			toggle.setValue(plugin.settings.drawingBackgroundWhenLocked);
			toggle.onChange( async (value: boolean) => {
				plugin.settings.drawingBackgroundWhenLocked = value;
				await plugin.saveSettings();
				refresh();
			})
		});

}

function insertWritingSettings(containerEl: HTMLElement, plugin: InkPlugin, refresh: Function) {

	const saveWritingStrokeLimit = async (enteredValue: string) => {
		const value = parseInt(enteredValue) || DEFAULT_SETTINGS.writingStrokeLimit;
		plugin.settings.writingStrokeLimit = value;
		await plugin.saveSettings();
		refresh();
	}

	const sectionEl = containerEl.createDiv('ddc_ink_section ddc_ink_controls-section');
	sectionEl.createEl('h2', { text: '手写' });
	sectionEl.createEl('p', { text: `编辑 Markdown 文件时，运行“新建手写区域”命令即可嵌入触控笔手写区域。` });
	
	new Setting(sectionEl)
		.setClass('ddc_ink_setting')
		.setName('非编辑状态显示横线')

		.addToggle((toggle) => {
			toggle.setValue(plugin.settings.writingLinesWhenLocked);
			toggle.onChange( async (value: boolean) => {
				plugin.settings.writingLinesWhenLocked = value;
				await plugin.saveSettings();
				refresh();
			})
		});

	new Setting(sectionEl)
		.setClass('ddc_ink_setting')
		.setName('非编辑状态显示背景')

		.addToggle((toggle) => {
			toggle.setValue(plugin.settings.writingBackgroundWhenLocked);
			toggle.onChange( async (value: boolean) => {
				plugin.settings.writingBackgroundWhenLocked = value;
				await plugin.saveSettings();
				refresh();
			})
		});
	
	new Setting(sectionEl)
		.setClass('ddc_ink_setting')
		.setName('手写笔画显示上限')
		.setDesc(`单个嵌入中笔画过多会导致触控笔移动和屏幕笔迹之间出现延迟。达到该上限后，较早笔画会在编辑时临时隐藏，锁定嵌入后重新显示。如果感觉卡顿或笔迹锯齿明显，可以调低这个数值。`)

		.addText((textItem) => {
			textItem.setValue(plugin.settings.writingStrokeLimit.toString());
			textItem.setPlaceholder(DEFAULT_SETTINGS.writingStrokeLimit.toString());
			// TODO: Combine the blur and the enter into one abstracted and reusable function
			textItem.inputEl.addEventListener('blur', async (ev: FocusEvent) => {
				saveWritingStrokeLimit(textItem.getValue())
			})
			textItem.inputEl.addEventListener('keypress', async (ev: KeyboardEvent) => {
				if(ev.key === 'Enter') saveWritingStrokeLimit(textItem.getValue())
			})
		});
	insertWritingLimitations(sectionEl);
}

function insertWritingLimitations(containerEl: HTMLElement) {
	// const sectionEl = containerEl.createDiv('ddc_ink_section ddc_ink_current-limitations-section');
	// const accordion = sectionEl.createEl('details');
	// accordion.createEl('summary', { text: `Notable writing limitations (Expand for details)` });
	// accordion.createEl('p', { text: `Only the last 300 strokes will be visible while writing (Others will dissapear). This is because the plugin currently experiences lag while displaying long amounts of writing that degrades pen fluidity.` });
	// accordion.createEl('p', { text: `All your writing is still saved, however, and will appear in full whenever the embed is locked.` });
}

function insertPrereleaseWarning(containerEl: HTMLElement) {
	const sectionEl = containerEl.createDiv('ddc_ink_section ddc_ink_prerelease-warning-section');
	const accordion = sectionEl.createEl('details', {cls: 'warning'});
	accordion.createEl('summary', { text: `当前仍是实验阶段（展开详情）` });
	accordion.createEl('p', { text: `本地版本基于 Ink 功能做学习和二次实验，后续会继续替换性能敏感的手写路径。` });
	accordion.createEl('p', { text: `请在重要库中使用前做好备份，尤其是同步和跨设备使用场景。` });
}

function insertGenericWarning(containerEl: HTMLElement, text: string) {
	const sectionEl = containerEl.createDiv('ddc_ink_section ddc_ink_generic-warning-section');
	const warningEl = sectionEl.createDiv('warning');
	warningEl.createEl('p', {text});
}
