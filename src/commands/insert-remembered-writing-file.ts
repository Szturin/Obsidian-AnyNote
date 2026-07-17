import InkPlugin from "src/main";
import { Editor, Notice, TFile } from "obsidian";
import { buildWritingEmbed } from "src/utils/embed";
import { fetchLocally } from "src/utils/storage";
import { duplicateWritingFile } from "src/utils/rememberDrawingFile";
import { InsertCopiedFileModal } from "src/modals/confirmation-modal/insert-copied-file-modal";

//////////
//////////

const insertRememberedWritingFile = async (plugin: InkPlugin, editor: Editor) => {
    const v = plugin.app.vault;

    const existingFilePath = fetchLocally('rememberedWritingFile');
    if(!existingFilePath || typeof existingFilePath !== 'string') {
        new Notice('请先复制一个手写区域。');
        return;
    }

    const existingFileRef = v.getAbstractFileByPath(existingFilePath) as TFile;
    if(!(existingFileRef instanceof TFile)) {
        new Notice('无法插入：已复制的手写文件不存在。');
        return;
    }


    new InsertCopiedFileModal({
        plugin,
        filetype: 'writing',
        instanceAction: () => {
            let embedStr = buildWritingEmbed(existingFileRef.path);
            editor.replaceRange(embedStr, editor.getCursor());
        },
        duplicateAction: async () => {
            const activeFile = plugin.app.workspace.getActiveFile();
            const duplicatedFileRef = await duplicateWritingFile(plugin, existingFileRef, activeFile);
            if(!duplicatedFileRef) return;

            new Notice("手写文件已复制");
            let embedStr = buildWritingEmbed(duplicatedFileRef.path);
            editor.replaceRange(embedStr, editor.getCursor());
        },
        cancelAction: () => {
            new Notice('已取消插入。');
        }
    }).open();

}

export default insertRememberedWritingFile;
