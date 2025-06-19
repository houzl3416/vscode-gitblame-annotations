import path from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { Blame, Change, getBlames, getChanges, getEmptyTree, getFileStatus, getGitRepository, getParentCommitId } from './git';


// 全局状态
const fileBlameStates = new Map<string, boolean>();
const fileDecorations = new Map<string, {
    decorationType: vscode.TextEditorDecorationType | undefined,
    decorationOptions: vscode.DecorationOptions[] | undefined,
    hoverProvider: vscode.Disposable | undefined,
    blames: Blame[] | undefined,
    lineBlames: Map<number, Blame> | undefined,
}>();
const MaxTitleWidth = 25;

/**
 * 激活插件
 */
export function activate(context: vscode.ExtensionContext) {
    registerCommands(context);
    registerListeners(context);
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        updateMenuContext(editor.document);
    }
}

/**
 * 卸载插件
 */
export function deactivate() {
    for (const [_, decorations] of fileDecorations) {
        decorations.decorationType?.dispose();
        decorations.hoverProvider?.dispose();
    }
    fileDecorations.clear();
    fileBlameStates.clear();
}


/**
 * 注册命令
 */
function registerCommands(context: vscode.ExtensionContext) {

    // Toggle blame annotations
    const toggleCommand = vscode.commands.registerCommand('git.blame.toggle', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const document = editor.document;
            const documentUri = document.uri.toString();
            const fileBlameState = fileBlameStates.get(documentUri) || false;
            if (!fileBlameState) {
                const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === documentUri);
                const successed = await showDecorations(editors);
                if (successed) {
                    updateMenuContext(document, true);
                }
            } else {
                const successed = await hideDecorations(document);
                if (successed) {
                    updateMenuContext(document, false);
                }
            }
        }
    });

    // Show blame annotations
    const showCommand = vscode.commands.registerCommand('git.blame.show', async (event?: any) => {
        const documentUri = (event?.uri || vscode.window.activeTextEditor?.document.uri)?.toString() || "";
        if (documentUri) {
            const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === documentUri);
            if (editors.length > 0) {
                const successed = await showDecorations(editors);
                if (successed) {
                    updateMenuContext(editors[0].document, true);
                }
            }
        }
    });

    // Hide blame annotations
    const hideCommand = vscode.commands.registerCommand('git.blame.hide', async (event?: any) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const successed = await hideDecorations(editor.document);
            if (successed) {
                updateMenuContext(editor.document, false);
            }
        }
    });

    // View commit details
    const viewCommitCommand = vscode.commands.registerCommand('git.blame.viewCommit', async (commitId: string, summary: string = "", fileName: string = "") => {
        if (fileName) {
            const repositoryRoot = await getGitRepository(fileName);
            const title = `${commitId.substring(0, 7)} ${summary ? `- ${summary.substring(0, 20)}` : ""}`;
            let parentCommitId = await getParentCommitId(repositoryRoot, commitId);
            if (!parentCommitId) {
                parentCommitId = await getEmptyTree(repositoryRoot);
            }
            const multiDiffSourceUri = Uri.from({ scheme: 'scm-history-item', path: `${repositoryRoot}/${parentCommitId}..${commitId}` });
            const changes = await getChanges(repositoryRoot, parentCommitId, commitId);
            const resources = changes.map(c => toMultiFileDiffEditorUris(c, parentCommitId, commitId));

            await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', { multiDiffSourceUri, title, resources });
        }
    });
    context.subscriptions.push(toggleCommand, showCommand, hideCommand, viewCommitCommand);
}

/**
 * 注册事件
 */
function registerListeners(context: vscode.ExtensionContext) {

    // Editor Change
    const editorChangeSubscription = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            updateMenuContext(editor.document);
        }
    });

    // Visible Editor Change
    const visibleEditorChangeSubscription = vscode.window.onDidChangeVisibleTextEditors(editors => {
        for (const editor of editors) {
            const fileBlameState = fileBlameStates.get(editor.document.uri.toString());
            if (fileBlameState) {
                showDecorations([editor]);
            }
        }
    });

    // Document Close
    const closeDocumentSubscription = vscode.workspace.onDidCloseTextDocument(document => {
        const documentUri = document.uri.toString();
        fileBlameStates.delete(documentUri);
        const decorations = fileDecorations.get(documentUri);
        if (decorations) {
            fileDecorations.delete(documentUri);
            decorations.decorationType?.dispose();
            decorations.hoverProvider?.dispose();
        }
    });

    // Document Save
    const saveDocumentSubscription = vscode.workspace.onDidSaveTextDocument(async document => {
        const documentUri = document.uri.toString();
        const fileBlameState = fileBlameStates.get(documentUri);
        if (fileBlameState) {
            const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === documentUri);
            if (editors.length > 0) {
                await showDecorations(editors, true);
            }
        }
    });

    // Document change
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(async (event) => {
        const documentUri = event.document.uri.toString();
        const isNeedUpdate = event.contentChanges.length > 0 && fileBlameStates.get(documentUri);
        if (isNeedUpdate) {
            const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === documentUri);
            if (editors.length > 0) {
                await updateDecorationsOnChange(editors, event);
            }
        }
    });

    context.subscriptions.push(editorChangeSubscription, visibleEditorChangeSubscription, closeDocumentSubscription, saveDocumentSubscription, changeDocumentSubscription);
}

/**
 * 显示装饰器
 */
async function showDecorations(editors: vscode.TextEditor[], reload: boolean = false): Promise<boolean> {
    const document = editors[0].document;
    const documentUri = document.uri.toString();
    let decorations = fileDecorations.get(documentUri);

    // Skip diff editor
    if (document.uri.scheme !== 'file') {
        return false;
    }

    // Use cache
    if (!reload && decorations && decorations.decorationType && decorations.decorationOptions) {
        for (const editor of editors) {
            editor.setDecorations(decorations.decorationType, decorations.decorationOptions);
        }
        fileBlameStates.set(documentUri, true);
        return true;
    }

    if (!decorations) {
        decorations = {
            decorationType: undefined,
            decorationOptions: undefined,
            hoverProvider: undefined,
            blames: undefined,
            lineBlames: undefined,
        }
    }
    fileDecorations.set(documentUri, decorations);

    try {
        // Blames
        let blames = await getBlames(path.dirname(document.fileName), document.fileName);

        // --- Calculate and attach relativeAgeInFile ---
        let minTimestamp = Infinity;
        let maxTimestamp = 0;
        let hasCommits = false;

        for (const blame of blames) {
            if (blame.commited && blame.timestamp > 0) {
                hasCommits = true;
                if (blame.timestamp < minTimestamp) {
                    minTimestamp = blame.timestamp;
                }
                if (blame.timestamp > maxTimestamp) {
                    maxTimestamp = blame.timestamp;
                }
            }
        }

        if (hasCommits) {
            for (const blame of blames) {
                if (blame.commited && blame.timestamp > 0) {
                    if (minTimestamp === maxTimestamp) {
                        blame.relativeAgeInFile = 1.0; // All are effectively the 'newest' (or 'only')
                    } else {
                        blame.relativeAgeInFile = (blame.timestamp - minTimestamp) / (maxTimestamp - minTimestamp);
                    }
                } else {
                    blame.relativeAgeInFile = undefined;
                }
            }
        } else {
            for (const blame of blames) {
                blame.relativeAgeInFile = undefined;
            }
        }
        // --- End of relativeAgeInFile calculation ---

        // Fill lines not covered by git blame (e.g. new, uncommitted lines)
        // These will also get relativeAgeInFile = undefined by the logic above if processed
        // after being added, or explicitly if added before the loop.
        // For simplicity, let's ensure they are added before the relativeAge calculation loop.
        // This part is tricky because blames from getBlames might not cover all lines.
        // Let's refine: create a full list of blames first, then calculate relative age.

        const allBlames: Blame[] = new Array(document.lineCount);
        blames.forEach(b => { // Populate from actual blames
            if (b.line > 0 && b.line <= document.lineCount) {
                 // git blame lines are 1-indexed, array is 0-indexed
                allBlames[b.line -1] = b;
            }
        });

        for (let i = 0; i < document.lineCount; i++) {
            if (!allBlames[i]) { // If no blame info for this line (e.g. uncommitted)
                allBlames[i] = buildUncommitBlame(i + 1);
            }
        }
        blames = allBlames; // Replace original blames with the full list

        // Recalculate min/max and relative ages on the *complete* blames array
        minTimestamp = Infinity;
        maxTimestamp = 0;
        hasCommits = false;
        for (const blame of blames) {
            if (blame.commited && blame.timestamp > 0) {
                hasCommits = true;
                if (blame.timestamp < minTimestamp) minTimestamp = blame.timestamp;
                if (blame.timestamp > maxTimestamp) maxTimestamp = blame.timestamp;
            }
        }

        for (const blame of blames) {
            if (blame.commited && blame.timestamp > 0 && hasCommits) {
                if (minTimestamp === maxTimestamp) {
                    blame.relativeAgeInFile = 1.0;
                } else {
                    blame.relativeAgeInFile = (blame.timestamp - minTimestamp) / (maxTimestamp - minTimestamp);
                }
            } else {
                blame.relativeAgeInFile = undefined; // Ensure uncommitted lines have this as undefined
            }
        }
        // --- End of refined relativeAgeInFile calculation ---


        // Decorations
        if (!decorations.decorationType) {
            decorations.decorationType = vscode.window.createTextEditorDecorationType({});
        }
        decorations.decorationOptions = buildDecorationOptions(blames);
        for (const editor of editors) {
            editor.setDecorations(decorations.decorationType, decorations.decorationOptions);
        }
        decorations.blames = blames;
        decorations.lineBlames = new Map(blames.map((blame, index) => [index, blame]));
        decorations.hoverProvider?.dispose();
        decorations.hoverProvider = vscode.languages.registerHoverProvider(
            { scheme: 'file', pattern: document.fileName },
            {
                provideHover(document: vscode.TextDocument, position: vscode.Position) {
                    if (position.character > 0) {
                        return undefined;
                    }
                    const blame = fileDecorations.get(documentUri)?.lineBlames?.get(position.line);
                    if (blame && blame.commited) {
                        const date = new Date(blame.timestamp * 1000);
                        const dateText = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

                        const content = new vscode.MarkdownString();
                        content.appendMarkdown(`commit: [${blame.commit}](command:git.blame.viewCommit?${encodeURIComponent(JSON.stringify([blame.commit, blame.summary, document.fileName]))})  \n`);
                        content.appendMarkdown(`Author: ${blame.author}  \n`);
                        content.appendMarkdown(`Date: ${dateText}  \n`);
                        if (blame.summary) {
                            content.appendMarkdown(`\n\n${blame.summary}`);
                        }
                        content.isTrusted = true;
                        return new vscode.Hover(content);
                    }
                }
            }
        );
        fileBlameStates.set(documentUri, true);
        return true;
    } catch (error: any) {
        vscode.window.showErrorMessage(`${error.message}`);
        return false;
    }
}



/**
 * 隐藏装饰器
 */
async function hideDecorations(document: vscode.TextDocument): Promise<boolean> {
    const documentUri = document.uri.toString();
    fileBlameStates.set(documentUri, false);
    let decorations = fileDecorations.get(documentUri);
    if (decorations) {
        fileDecorations.delete(documentUri);
        decorations.decorationType?.dispose();
        decorations.hoverProvider?.dispose();
        return true;
    }
    return false;
}

/**
 * 更新装饰器
 */
async function updateDecorationsOnChange(editors: vscode.TextEditor[], event: vscode.TextDocumentChangeEvent) {
    const documentUri = editors[0].document.uri.toString();
    const decorations = fileDecorations.get(documentUri);
    if (!decorations || !decorations.decorationType) {
        return;
    }
    const blames = fileDecorations.get(documentUri)?.blames;
    if (!blames) {
        return;
    }

    // resolve changes
    let shouldUpdate = false;
    for (const change of event.contentChanges) {
        const { addedLines, deletedLines, modifiedLines } = resolveChange(change);
        if (addedLines.length === 0 && deletedLines.length === 0 && modifiedLines.length === 0) {
            continue;
        }
        if (modifiedLines.length > 0) {
            for (let i = 0; i < modifiedLines.length; i++) {
                if (blames[modifiedLines[i]].commited) {
                    blames[modifiedLines[i]].commit = '0000000000000000000000000000000000000000';
                    blames[modifiedLines[i]].commited = false;
                    shouldUpdate = true;
                }
            }
        }
        if (deletedLines.length > 0) {
            shouldUpdate = true;
            for (let i = deletedLines.length - 1; i >= 0; i--) {
                blames.splice(deletedLines[i], 1);
            }
        }
        if (addedLines.length > 0) {
            shouldUpdate = true;
            for (let i = 0; i < addedLines.length; i++) {
                blames.splice(addedLines[i], 0, buildUncommitBlame(addedLines[i] + 1));
            }
        }
    }
    if (!shouldUpdate) {
        return;
    }

    // update decorations
    decorations.decorationOptions = buildDecorationOptions(blames);
    for (const editor of editors) {
        editor.setDecorations(decorations.decorationType, decorations.decorationOptions);
    }
    decorations.blames = blames;
    decorations.lineBlames = new Map(blames.map((blame, index) => [index, blame]));
}


/**
 * 更新上下文菜单
 */
async function updateMenuContext(document: vscode.TextDocument, currentState: boolean | undefined = undefined) {
    // Skip diff editor
    if (document.uri.scheme !== 'file') {
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', false);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', false);
        return;
    }

    if (currentState !== undefined) {
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', !currentState);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', currentState);
        return;
    }

    try {
        // check file tracked
        const fileStatus = await getFileStatus(path.dirname(document.fileName), document.fileName);
        const isTracked = fileStatus !== "untracked" && fileStatus !== "index_add";
        if (!isTracked) {
            vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', false);
            vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', false);
            return;
        }
        // check file blame state
        const fileBlameState = fileBlameStates.get(document.uri.toString());
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', !fileBlameState);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', fileBlameState);
    } catch (error) {
        // check git repository
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', false);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', false);
    }

}

function buildDecorationOptions(blames: Blame[]): vscode.DecorationOptions[] {
    const maxWidth = fillTitles(blames);
    if (maxWidth <= 0) {
        return []
    }

    const decorationOptions: vscode.DecorationOptions[] = [];
    // Update the type of colorsMap to store CommitColorInfo
    const colorsMap = new Map<string, CommitColorInfo>();
    blames.forEach((blame, index) => {
        let colorInfo = colorsMap.get(blame.commit);
        if (!colorInfo) {
            colorInfo = getCommitColor(blame.commit, blame.timestamp);
            colorsMap.set(blame.commit, colorInfo);
        }
        const range = new vscode.Range(
            new vscode.Position(index, 0),
            new vscode.Position(index, 0)
        );
        decorationOptions.push({
            range,
            renderOptions: {
                before: {
                    contentText: `\u2007${blame.title}\u2007`,
                    // color property is removed from here, will be set in light/dark sections
                    margin: '0 1ch 0 0',
                    width: `${maxWidth + 2}ch`,
                    fontWeight: 'normal',
                    fontStyle: 'normal',
                },
                light: {
                    before: {
                        backgroundColor: colorInfo.lightColor,
                        color: colorInfo.lightThemeTextColor // Dynamically set text color
                    }
                },
                dark: {
                    before: {
                        backgroundColor: colorInfo.darkColor,
                        color: colorInfo.darkThemeTextColor // Dynamically set text color
                    }
                }
            }
        });
    });
    return decorationOptions;
}


function fillTitles(blames: Blame[]): number {
    let maxWidth = 0;
    const textWidths = new Map<string, { width: number, widths: number[] }>();
    blames.forEach(line => {
        if (line.commited) {
            const date = new Date(line.timestamp * 1000);
            const dateText = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
            line.title = `${dateText} ${line.author}`;
        } else {
            line.title = '';
        }

        // calculate title width
        if (!textWidths.has(line.commit)) {
            const { width, widths } = getTextWidth(line.title);
            textWidths.set(line.commit, { width, widths });
            if (width > maxWidth) {
                maxWidth = width;
            }
        }
    });

    if (maxWidth > MaxTitleWidth) {
        maxWidth = MaxTitleWidth;
        // trancate title
        blames.forEach(line => {
            const { width, widths } = textWidths.get(line.commit) || { width: 0, widths: [] };
            if (width > maxWidth) {
                line.title = trancateText(line.title, maxWidth - 1, widths) + "…";
            }
        });
    }

    return maxWidth;
}

// ------------------------------------------------------------
// utils
// ------------------------------------------------------------

function toMultiFileDiffEditorUris(change: Change, originalRef: string, modifiedRef: string): { originalUri: Uri | undefined; modifiedUri: Uri | undefined } {
    switch (change.status) {
        case "index_added":
            return {
                originalUri: undefined,
                modifiedUri: toGitUri(change.uri, modifiedRef)
            };
        case "deleted":
            return {
                originalUri: toGitUri(change.uri, originalRef),
                modifiedUri: undefined
            };
        case "index_renamed":
            return {
                originalUri: toGitUri(change.originalUri, originalRef),
                modifiedUri: toGitUri(change.uri, modifiedRef)
            };
        default:
            return {
                originalUri: toGitUri(change.uri, originalRef),
                modifiedUri: toGitUri(change.uri, modifiedRef)
            };
    }
}

function toGitUri(uri: Uri, ref: string, options: { submoduleOf?: string, replaceFileExtension?: boolean, scheme?: string } = {}): Uri {
    const params = {
        path: uri.fsPath,
        submoduleOf: "",
        ref
    };

    if (options.submoduleOf) {
        params.submoduleOf = options.submoduleOf;
    }

    let path = uri.path;

    if (options.replaceFileExtension) {
        path = `${path}.git`;
    } else if (options.submoduleOf) {
        path = `${path}.diff`;
    }

    return uri.with({ scheme: options.scheme ?? 'git', path, query: JSON.stringify(params) });
}


function getTextWidth(text: string): { width: number, widths: number[] } {
    let width = 0;
    const widths = [];
    for (const char of text) {
        const w = getCharacterWidth(char);
        widths.push(w);
        width += w;
    }
    return { width, widths };
}


function getCharacterWidth(char: string): number {
    const code = char.charCodeAt(0);

    // 东亚文字 (中文、日文、韩文等)
    if ((code >= 0x3000 && code <= 0x9FFF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0xF900 && code <= 0xFAFF) ||
        (code >= 0xFF00 && code <= 0xFFEF)) {
        return 2;
    }

    // 表情符号和特殊符号
    if (code >= 0x1F300 && code <= 0x1F9FF) {
        return 2;
    }

    // 组合字符标记
    if (code >= 0x0300 && code <= 0x036F) {
        return 0;
    }

    return 1;
}

function trancateText(text: string, maxWidth: number, widths: number[]): string {
    let truncatedText = '';
    let currentWidth = 0;

    for (let i = 0; i < widths.length; i++) {
        if (currentWidth + widths[i] <= maxWidth) {
            truncatedText += text[i];
            currentWidth += widths[i];
        } else {
            break;
        }
    }
    return truncatedText;
}

function hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const character = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + character;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

function parseHsl(hslStr: string): [number, number, number] | null {
    const match = hslStr.match(/hsl\((\d+),\s*([\d.]+)%,\s*([\d.]+)%\)/);
    if (match) {
        return [parseInt(match[1]), parseFloat(match[2]), parseFloat(match[3])];
    }
    return null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    s /= 100;
    l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) =>
        l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [255 * f(0), 255 * f(8), 255 * f(4)];
}

function calculateLuminance(hslColorStr: string): number {
    const hsl = parseHsl(hslColorStr);
    if (!hsl) return 0;

    const [r, g, b] = hslToRgb(hsl[0], hsl[1], hsl[2]);

    const r_lin = r / 255;
    const g_lin = g / 255;
    const b_lin = b / 255;

    return 0.2126 * r_lin + 0.7152 * g_lin + 0.0722 * b_lin;
}

// Interface for the return type of getCommitColor
interface CommitColorInfo {
    lightColor: string;
    darkColor: string;
    lightThemeTextColor: string;
    darkThemeTextColor: string;
}

// Helper function for interpolation
function interpolate(startValue: number, endValue: number, factor: number): number {
    factor = Math.max(0, Math.min(1, factor)); // Clamp factor to [0, 1]
    return startValue + (endValue - startValue) * factor;
}

function interpolateHue(h1: number, h2: number, factor: number): number {
    const diff = Math.abs(h1 - h2);
    if (diff > 180) { // Interpolate the shorter way
        if (h1 > h2) {
            h1 -= 360;
        } else {
            h2 -= 360;
        }
    }
    let hue = h1 + (h2 - h1) * factor;
    if (hue < 0) hue += 360;
    return Math.round(hue % 360);
}

const GRADIENT_CONFIG = {
    NEWEST_DARK: { h: 45, s: 90, l: 40 },
    NEWEST_LIGHT: { h: 45, s: 90, l: 75 },
    OLDEST_DARK: { h: 240, s: 20, l: 20 },
    OLDEST_LIGHT: { h: 240, s: 30, l: 90 },
    UNCOMMITTED_DARK_BG: "hsl(0, 0%, 22%)", // Slightly off-black for dark themes
    UNCOMMITTED_LIGHT_BG: "hsl(0, 0%, 92%)", // Slightly off-white for light themes
};

function getCommitColor(commit: string, relativeAgeInFile?: number): CommitColorInfo {
    let finalDarkBgColor: string;
    let finalLightBgColor: string;

    if (relativeAgeInFile === undefined || relativeAgeInFile < 0 || relativeAgeInFile > 1) {
        // Handle uncommitted or lines where relative age is not applicable
        finalDarkBgColor = GRADIENT_CONFIG.UNCOMMITTED_DARK_BG;
        finalLightBgColor = GRADIENT_CONFIG.UNCOMMITTED_LIGHT_BG;
    } else {
        // Interpolate for Dark Theme
        const h_dark = interpolateHue(GRADIENT_CONFIG.OLDEST_DARK.h, GRADIENT_CONFIG.NEWEST_DARK.h, relativeAgeInFile);
        const s_dark = interpolate(GRADIENT_CONFIG.OLDEST_DARK.s, GRADIENT_CONFIG.NEWEST_DARK.s, relativeAgeInFile);
        const l_dark = interpolate(GRADIENT_CONFIG.OLDEST_DARK.l, GRADIENT_CONFIG.NEWEST_DARK.l, relativeAgeInFile);
        finalDarkBgColor = `hsl(${h_dark.toFixed(0)}, ${s_dark.toFixed(0)}%, ${l_dark.toFixed(0)}%)`;

        // Interpolate for Light Theme
        const h_light = interpolateHue(GRADIENT_CONFIG.OLDEST_LIGHT.h, GRADIENT_CONFIG.NEWEST_LIGHT.h, relativeAgeInFile);
        const s_light = interpolate(GRADIENT_CONFIG.OLDEST_LIGHT.s, GRADIENT_CONFIG.NEWEST_LIGHT.s, relativeAgeInFile);
        const l_light = interpolate(GRADIENT_CONFIG.OLDEST_LIGHT.l, GRADIENT_CONFIG.NEWEST_LIGHT.l, relativeAgeInFile);
        finalLightBgColor = `hsl(${h_light.toFixed(0)}, ${s_light.toFixed(0)}%, ${l_light.toFixed(0)}%)`;
    }

    const luminanceDarkBg = calculateLuminance(finalDarkBgColor);
    const luminanceLightBg = calculateLuminance(finalLightBgColor);

    const darkThemeTextColor = luminanceDarkBg < 0.45 ? '#FFFFFF' : '#000000';
    const lightThemeTextColor = luminanceLightBg < 0.45 ? '#FFFFFF' : '#000000';

    return {
        lightColor: finalLightBgColor,
        darkColor: finalDarkBgColor,
        lightThemeTextColor: lightThemeTextColor,
        darkThemeTextColor: darkThemeTextColor,
    };
}

function buildUncommitBlame(line: number): Blame {
    return {
        line: line,
        commit: '0000000000000000000000000000000000000000',
        author: '',
        mail: '',
        timestamp: 0,
        summary: '',
        commited: false,
        title: '',
    }
}


function resolveChange(change: vscode.TextDocumentContentChangeEvent) {
    const addedLines = [];
    const deletedLines = [];
    const modifiedLines = [];
    const changeText = change.text;
    const startLine = change.range.start.line;
    const endLine = change.range.end.line;
    const startLineCharacter = change.range.start.character;

    if (changeText.length === 0) {
        // delete characters
        const diffLine = endLine - startLine;
        if (diffLine === 1) {
            deletedLines.push(startLine + 1);
        } else if (diffLine > 1) {
            const start = startLineCharacter > 0 ? startLine + 1 : startLine;
            const end = start + diffLine - 1;
            for (let i = start; i <= end; i++) {
                deletedLines.push(i);
            }
        } else if (diffLine === 0) {
            modifiedLines.push(startLine);
        }
    } else {
        const trimedChangeText = changeText.replace(/ +$/, '');
        if (trimedChangeText === '\n' || trimedChangeText === '\r\n') {
            // add a new line
            addedLines.push(startLineCharacter > 0 ? startLine + 1 : startLine);
        } else {
            // add or modify characters
            const crossLines = endLine - startLine + 1;
            const textLines = changeText.split(/\r?\n/).length;
            const diff = textLines - crossLines;
            if (diff > 0) {
                // modify lines
                for (let i = startLine; i <= endLine; i++) {
                    modifiedLines.push(i);
                }
                // add lines
                const start = endLine + 1;
                const end = endLine + diff;
                for (let i = start; i <= end; i++) {
                    addedLines.push(i);
                }
            } else if (diff < 0) {
                // modify lines
                for (let i = startLine; i <= endLine + diff; i++) {
                    modifiedLines.push(i);
                }
                // delete lines
                const start = endLine + diff + 1;
                const end = endLine;
                for (let i = start; i <= end; i++) {
                    deletedLines.push(i);
                }
            } else if (diff === 0) {
                // modify lines
                for (let i = startLine; i <= endLine; i++) {
                    modifiedLines.push(i);
                }
            }
        }
    }
    return { addedLines, deletedLines, modifiedLines };
}