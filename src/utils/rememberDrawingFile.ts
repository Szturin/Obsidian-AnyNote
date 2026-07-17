import { Notice, TFile } from "obsidian";
import InkPlugin from "src/main";
import { saveLocally } from "./storage";
import { getNewTimestampedDrawingFilepath, getNewTimestampedWritingFilepath } from "./file-manipulation";


export const rememberDrawingFile = async (plugin: InkPlugin, existingFileRef: TFile) => {
    const v = plugin.app.vault;

    if (!(existingFileRef instanceof TFile)) {
        new Notice('没有找到可复制的文件');
        return;
    }

    saveLocally('rememberedDrawingFile', existingFileRef.path);
    new Notice(`绘图文件已复制。\n请在目标位置运行“插入已复制绘图”。`);
};

export const rememberWritingFile = async (plugin: InkPlugin, existingFileRef: TFile) => {
    const v = plugin.app.vault;

    if (!(existingFileRef instanceof TFile)) {
        new Notice('没有找到可复制的文件');
        return null;
    }

    saveLocally('rememberedWritingFile', existingFileRef.path);
    new Notice(`手写文件已复制。\n请在目标位置运行“插入已复制手写区域”。`);
};

export const duplicateDrawingFile = async (plugin: InkPlugin, existingFileRef: TFile, instigatingFile?: TFile | null): Promise<TFile | null> => {
    const v = plugin.app.vault;

    const newFilePath = await getNewTimestampedDrawingFilepath(plugin, instigatingFile);
    const newFile = await v.copy(existingFileRef, newFilePath);

    return newFile;
};

export const duplicateWritingFile = async (plugin: InkPlugin, existingFileRef: TFile, instigatingFile?: TFile | null): Promise<TFile | null> => {
    const v = plugin.app.vault;

    const newFilePath = await getNewTimestampedWritingFilepath(plugin, instigatingFile);
    const newFile = await v.copy(existingFileRef, newFilePath);

    return newFile;
};
