import { Modal, Setting } from "obsidian";
import MyPlugin from "src/main";

////////
////////

export class ConfirmationModal extends Modal {
	title: string = '确认';
	message: string = '确定要继续吗？';
	cancelLabel: string = '取消';
	cancelAction: Function = () => {};	// REVIEW: Is this the best way to set a default nothing action on this parameter?
	confirmLabel: string = '确认';
	confirmAction: Function;

	constructor(options: {
		plugin: MyPlugin,
		title?: string,
		message?: string,
		cancelLabel?: string,
		cancelAction?: Function,
		confirmLabel?: string,
		confirmAction: Function,
	}) {
		super(options.plugin.app);
		this.title = options.title || this.title;
		this.message = options.message || this.message;
		this.cancelLabel = options.cancelLabel || this.cancelLabel;
		this.confirmLabel = options.confirmLabel || this.confirmLabel;
		this.cancelAction = options.cancelAction || this.cancelAction;
		this.confirmAction = options.confirmAction;
	}

	onOpen() {
		const {titleEl, contentEl} = this;

		titleEl.setText(this.title);
		contentEl.createEl('p', {text: this.message});
		
		new Setting(contentEl).addButton(cancelBtn => {
			cancelBtn.setClass('uo_button');
			cancelBtn.setButtonText(this.cancelLabel);
			cancelBtn.onClick( () => {
				this.close();
				this.cancelAction()
			})
		})
		.addButton( confirmBtn => {
			confirmBtn.setClass('uo_button');
			confirmBtn.setWarning();
			confirmBtn.setButtonText(this.confirmLabel);
			confirmBtn.onClick( () => {
				this.close();
				this.confirmAction()
			})
		})

	}

	onClose() {
		const {titleEl, contentEl} = this;
		titleEl.empty();
		contentEl.empty();
	}
}
