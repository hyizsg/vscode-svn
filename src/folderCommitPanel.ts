import * as vscode from 'vscode';
import { SvnService } from './svnService';
import { SvnDiffProvider } from './diffProvider';
import { CommitLogStorage } from './commitLogStorage';
import { SvnFilterService } from './filterService';
import { TemplateManager } from './templateManager';
import * as path from 'path';
import * as fs from 'fs';
import { AiService } from './aiService';

interface FileStatus {
    path: string;
    status: string;
    type: 'modified' | 'added' | 'deleted' | 'unversioned' | 'conflict' | 'missing';
    displayName: string;
    changelist?: string;
    locked?: boolean;
}

interface CommitPanelPersistentState {
    uncheckedFiles: string[];
    hiddenGroups: string[];
}

export class SvnFolderCommitPanel {
    public static currentPanel: SvnFolderCommitPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _fileStatuses: FileStatus[] = [];
    // 维护已知的 changelist 名称集（含空 changelist），以便无文件时也显示
    private _knownChangelists: Set<string> = new Set();
    private readonly aiService: AiService;
    private outputChannel: vscode.OutputChannel;
    private readonly filterService: SvnFilterService;
    private readonly templateManager: TemplateManager;
    private _filterStats: { totalFiles: number, filteredFiles: number, excludedFiles: number } = { totalFiles: 0, filteredFiles: 0, excludedFiles: 0 };

    // --- 持久化状态读写 ---
    private _getPersistentStateKey(): string {
        return `svnCommitPanel.state.${this.folderPath}`;
    }

    private _loadPersistentState(): CommitPanelPersistentState {
        const key = this._getPersistentStateKey();
        const raw = this.context.workspaceState.get<CommitPanelPersistentState>(key);
        return {
            uncheckedFiles: raw?.uncheckedFiles || [],
            hiddenGroups: raw?.hiddenGroups || []
        };
    }

    private _savePersistentState(state: Partial<CommitPanelPersistentState>): void {
        const key = this._getPersistentStateKey();
        const current = this._loadPersistentState();
        const merged: CommitPanelPersistentState = {
            uncheckedFiles: state.uncheckedFiles !== undefined ? state.uncheckedFiles : current.uncheckedFiles,
            hiddenGroups: state.hiddenGroups !== undefined ? state.hiddenGroups : current.hiddenGroups
        };
        this.context.workspaceState.update(key, merged);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly folderPath: string,
        private readonly svnService: SvnService,
        private readonly diffProvider: SvnDiffProvider,
        private readonly logStorage: CommitLogStorage,
        private readonly context: vscode.ExtensionContext
    ) {
        this._panel = panel;
        this.aiService = new AiService();
        this.filterService = new SvnFilterService();
        this.templateManager = new TemplateManager(extensionUri);
        this.outputChannel = vscode.window.createOutputChannel('SVN 文件夹提交');
        
        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setupMessageHandlers();
    }

    public static async createOrShow(
        extensionUri: vscode.Uri,
        folderPath: string,
        svnService: SvnService,
        diffProvider: SvnDiffProvider,
        logStorage: CommitLogStorage,
        context: vscode.ExtensionContext
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // 检查是否已存在面板
        if (SvnFolderCommitPanel.currentPanel) {
            // 比较文件夹路径，如果不同则关闭旧面板
            if (SvnFolderCommitPanel.currentPanel.folderPath !== folderPath) {
                console.log(`文件夹路径不同，关闭旧面板: ${SvnFolderCommitPanel.currentPanel.folderPath} -> ${folderPath}`);
                SvnFolderCommitPanel.currentPanel.dispose();
                // 注意：dispose() 方法会将 currentPanel 设置为 undefined
            } else {
                // 相同路径，直接显示现有面板（不指定 column，避免拉回主窗口）
                SvnFolderCommitPanel.currentPanel._panel.reveal(undefined, true);
                return;
            }
        }

        const panel = vscode.window.createWebviewPanel(
            'svnFolderCommit',
            '提交文件夹到SVN',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        // 将 webview 面板移到独立的悬浮窗口并最大化显示
        setTimeout(async () => {
            try {
                await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
                // 等待新窗口就绪后尝试最大化
                setTimeout(async () => {
                    try {
                        await vscode.commands.executeCommand('workbench.action.maximizeWindow');
                    } catch {
                        /* 当前版本不支持，静默忽略 */
                    }
                }, 300);
            } catch {
                /* 老版本不支持，静默忽略 */
            }
        }, 100);

        SvnFolderCommitPanel.currentPanel = new SvnFolderCommitPanel(
            panel,
            extensionUri,
            folderPath,
            svnService,
            diffProvider,
            logStorage,
            context
        );
    }

    private async _update() {
        const webview = this._panel.webview;
        this._panel.title = `提交文件夹到SVN: ${path.basename(this.folderPath)}`;
        
        // 获取文件状态
        await this._updateFileStatuses();
        
        // 生成HTML
        webview.html = await this._getHtmlForWebview();
    }

    private _getFilterInfo(): { totalFiles: number, filteredFiles: number, excludedFiles: number } {
        return this._filterStats;
    }

    private async _updateFileStatuses() {
        try {
            this.outputChannel.appendLine(`\n[_updateFileStatuses] 开始更新文件状态`);
            this.outputChannel.appendLine(`[_updateFileStatuses] 文件夹路径: ${this.folderPath}`);
            
            // 使用原生格式获取状态
            this.outputChannel.appendLine(`[_updateFileStatuses] 执行SVN status命令（忽略 svn:externals 外部链接）...`);
            // 添加 --ignore-externals 屏蔽 svn:externals 引用的外部目录（issue #19）
            const statusResult = await this.svnService.executeSvnCommand('status --ignore-externals', this.folderPath, false);
            console.log('SVN status result:', statusResult);
            this.outputChannel.appendLine(`[_updateFileStatuses] SVN status 原始输出长度: ${statusResult.length} 字符`);
            this.outputChannel.appendLine(`[_updateFileStatuses] SVN status 原始输出:\n${statusResult}`);

            // 检测 changelist 块内无修改的文件，自动从 SVN changelist 中移除
            const rawLines = statusResult.split('\n').map(line => line.replace(/[\t\r ]+$/, ''));
            const unmodifiedInChangelist: string[] = [];
            let parseChangelist: string | undefined = undefined;
            for (const line of rawLines) {
                if (!line.trim()) continue;
                const clMatch = line.match(/^---\s+Changelist\s+'(.+)'/);
                if (clMatch) {
                    parseChangelist = clMatch[1];
                    continue;
                }
                // 在 changelist 块内，首列和第二列均为空白才是真正的“无修改”
                // （首列空 + 第二列 M 表示仅属性修改，merge 后的 mergeinfo 改动）
                const col0Blank = (line[0] === ' ' || line[0] === '\t');
                const col1Blank = (line[1] === undefined || line[1] === ' ' || line[1] === '\t');
                if (parseChangelist && col0Blank && col1Blank) {
                    const filePath = line.trim();
                    if (filePath) {
                        const absolutePath = path.resolve(this.folderPath, filePath);
                        unmodifiedInChangelist.push(absolutePath);
                    }
                }
            }
            // 批量从 changelist 移除无修改文件
            if (unmodifiedInChangelist.length > 0) {
                this.outputChannel.appendLine(`[_updateFileStatuses] 发现 ${unmodifiedInChangelist.length} 个 changelist 内无修改文件，自动移除:`);
                unmodifiedInChangelist.forEach(f => this.outputChannel.appendLine(`  - ${f}`));
                try {
                    await this.svnService.removeFromChangelistBatch(unmodifiedInChangelist);
                } catch (err: any) {
                    this.outputChannel.appendLine(`[_updateFileStatuses] 移除 changelist 失败（非致命）: ${err.message}`);
                }
            }

            // 首先处理所有文件状态
            let currentChangelist: string | undefined = undefined;
            const allFileStatuses = statusResult
                .split('\n')
                // 仅去除行尾空白，保留行首空格以维持 SVN status 列对齐
                // （首列为空格表示“无修改”，不能被抹去，否则会与路径首字符错位产生“未知状态”幽灵行）
                .map(line => line.replace(/[\t\r ]+$/, ''))
                .filter(line => {
                    if (!line.trim()) return false;
                    // 过滤树冲突的详细信息行（可能有前导空格）
                    if (/^\s*>/.test(line)) return false;
                    // 过滤 svn:externals 提示行（issue #19）
                    if (line.startsWith('Performing status on external item')) return false;
                    // 过滤外部链接占位行（状态字符为 'X'）以及第7列为 'X' 的外部链接定义行
                    if (line[0] === 'X') return false;
                    if (line.length > 6 && line[6] === 'X') return false;
                    // 过滤 changelist 块内已加入但无任何修改的文件（首列和第二列均为空白）
                    // 例：svn status 在 changelist 块内会输出 "        path/to/clean.txt"
                    // 注意：首列空 + 第二列 M 表示仅属性修改（merge 后的 mergeinfo），不能过滤
                    const col0IsBlank = (line[0] === ' ' || line[0] === '\t');
                    const col1IsBlank = (line[1] === undefined || line[1] === ' ' || line[1] === '\t');
                    if (col0IsBlank && col1IsBlank) return false;
                    return true;
                })
                .map(line => {
                    // 检测 changelist 分隔行: --- Changelist 'name':
                    const changelistMatch = line.match(/^---\s+Changelist\s+'(.+)'/);
                    if (changelistMatch) {
                        currentChangelist = changelistMatch[1];
                        this.outputChannel.appendLine(`[_updateFileStatuses] 发现 changelist: "${currentChangelist}"`);
                        return null; // changelist 分隔行不生成文件记录
                    }
            
                    // SVN status 输出格式：
                    // 第1列：文件状态 (M:修改, A:新增, D:删除, ?:未版本控制, C:冲突, !:丢失等)
                    // 第2列：属性状态
                    // 第3列：锁定状态
                    // 第4列：历史标记（+表示有copy历史）
                    // 第5列：切换标记
                    // 第6列：锁定信息
                    // 第7列：冲突标记
                    // 第8列及之后：空格 + 文件路径
                    const status = line[0];
                    // 仅属性修改场景：首列空格 + 第二列 'M'（常见于 svn merge 后的目录 mergeinfo 改动）
                    // 这种情况应识别为 modified
                    const effectiveStatus = (status === ' ' && line[1] === 'M') ? 'M' : status;
                    // 跳过前面所有状态标志列和空格，提取真正的文件路径
                    // 匹配模式：第1个字符(状态) + 任意数量的空格/标志字符(+、空格等) + 文件路径
                    const match = line.match(/^.[ A-Z+*!~]* {2,}(.+)$/);
                    const filePath = match ? match[1] : line.replace(/^.\s+/, '').trim();
                    console.log('Processing line:', { status, filePath, changelist: currentChangelist });
                    this.outputChannel.appendLine(`[_updateFileStatuses] 处理行: "${line}" -> 状态: "${status}", 文件路径: "${filePath}", changelist: "${currentChangelist || ''}"`);
            
                    let type: 'modified' | 'added' | 'deleted' | 'unversioned' | 'conflict' | 'missing';
                    switch (effectiveStatus) {
                        case 'M':
                            type = 'modified';
                            break;
                        case 'A':
                            type = 'added';
                            break;
                        case 'D':
                            type = 'deleted';
                            break;
                        case 'C':
                            type = 'conflict';
                            break;
                        case '!':
                            type = 'missing';
                            break;
                        case '?':
                        default:
                            type = 'unversioned';
                    }
            
                    // 解析锁定列：第3列 'L'（工作副本锁定）或第6列 K/O/T/B（lock token）
                    const wcLocked = line.length > 2 && line[2] === 'L';
                    const lockTokenCh = line.length > 5 ? line[5] : ' ';
                    const tokenLocked = lockTokenCh === 'K' || lockTokenCh === 'O' || lockTokenCh === 'T' || lockTokenCh === 'B';
                    const locked = wcLocked || tokenLocked;
            
                    // 使用 path.resolve 获取绝对路径
                    const absolutePath = path.resolve(this.folderPath, filePath);
            
                    return {
                        path: absolutePath,
                        status: this._getStatusText(effectiveStatus),
                        type,
                        displayName: filePath, // 使用相对路径作为显示名称
                        changelist: currentChangelist,
                        locked
                    };
                })
                .filter(item => item !== null) as FileStatus[];

            // 应用过滤器排除不需要的文件
            this.outputChannel.appendLine(`[_updateFileStatuses] 开始应用过滤器，原始文件数量: ${allFileStatuses.length}`);
            
            // 先按文件类型分组统计
            const statusCounts = allFileStatuses.reduce((counts, file) => {
                counts[file.type] = (counts[file.type] || 0) + 1;
                return counts;
            }, {} as Record<string, number>);
            
            this.outputChannel.appendLine(`[_updateFileStatuses] 原始文件状态统计:`);
            Object.entries(statusCounts).forEach(([type, count]) => {
                this.outputChannel.appendLine(`  - ${type}: ${count} 个`);
            });
            
            const filteredFileStatuses = allFileStatuses.filter(fileStatus => {
                // 检查是否显示丢失的文件
                const config = vscode.workspace.getConfiguration('vscode-svn');
                const showMissingFiles = config.get<boolean>('showMissingFiles', true);
                
                // 如果是丢失文件且配置不显示丢失文件，则排除
                if (fileStatus.type === 'missing' && !showMissingFiles) {
                    this.outputChannel.appendLine(`[_updateFileStatuses] 丢失文件被配置排除: ${fileStatus.displayName} (${fileStatus.status})`);
                    return false;
                }
                
                // 检查文件是否应该被排除
                const shouldExclude = this.filterService.shouldExcludeFile(fileStatus.path, this.folderPath);
                if (shouldExclude) {
                    console.log(`文件被过滤器排除: ${fileStatus.displayName}`);
                    this.outputChannel.appendLine(`[_updateFileStatuses] 文件被过滤器排除: ${fileStatus.displayName} (${fileStatus.status}) - 类型: ${fileStatus.type}`);
                } else {
                    this.outputChannel.appendLine(`[_updateFileStatuses] 文件通过过滤器: ${fileStatus.displayName} (${fileStatus.status}) - 类型: ${fileStatus.type}`);
                }
                return !shouldExclude;
            });

            // 记录过滤结果
            const excludedCount = allFileStatuses.length - filteredFileStatuses.length;
            this._filterStats = {
                totalFiles: allFileStatuses.length,
                filteredFiles: filteredFileStatuses.length,
                excludedFiles: excludedCount
            };
            
            if (excludedCount > 0) {
                console.log(`过滤器排除了 ${excludedCount} 个文件`);
                this.outputChannel.appendLine(`过滤器排除了 ${excludedCount} 个文件，显示 ${filteredFileStatuses.length} 个文件`);
            }

            this._fileStatuses = filteredFileStatuses;
            // 将当前文件中出现的 changelist 加入已知集合（新建/删除操作会单独更新）
            this._fileStatuses.forEach(fs => { if (fs.changelist) this._knownChangelists.add(fs.changelist); });
            console.log('Processed and filtered file statuses:', this._fileStatuses);
            this.outputChannel.appendLine(`[_updateFileStatuses] 最终文件状态列表 (${this._fileStatuses.length} 个文件):`);
            this._fileStatuses.forEach((file, index) => {
                this.outputChannel.appendLine(`  ${index + 1}. ${file.displayName} (${file.status}) - ${file.type}`);
            });

            // 清理持久化状态中不再有修改的文件（已从 svn status 中消失）
            const currentPaths = new Set(this._fileStatuses.map(f => f.path));
            const persistState = this._loadPersistentState();
            const cleanedUnchecked = persistState.uncheckedFiles.filter(f => currentPaths.has(f));
            if (cleanedUnchecked.length !== persistState.uncheckedFiles.length) {
                this._savePersistentState({ uncheckedFiles: cleanedUnchecked });
            }
        } catch (error) {
            console.error('Error updating file statuses:', error);
            vscode.window.showErrorMessage(`更新文件状态失败: ${error}`);
            this._fileStatuses = [];
        }
    }

    private _getStatusText(status: string): string {
        switch (status) {
            case 'M': return '已修改';
            case 'A': return '新增';
            case 'D': return '已删除';
            case '?': return '未版本控制';
            case '!': return '丢失';
            case 'C': return '冲突';
            case 'X': return '外部定义';
            case 'I': return '已忽略';
            case '~': return '类型变更';
            case 'R': return '已替换';
            default: return `未知状态(${status})`;
        }
    }

    private async _showFileDiff(filePath: string) {
        // 查找文件状态
        const fileStatus = this._fileStatuses.find(f => f.path === filePath);
        if (fileStatus && fileStatus.type === 'modified') {
            // 修改状态：使用 VS Code 原生差异对比视图
            await this.diffProvider.showDiff(filePath);
        } else {
            // 其他状态（新增/删除/未版本控制）：直接打开文件
            const uri = vscode.Uri.file(filePath);
            try {
                await vscode.commands.executeCommand('vscode.open', uri);
            } catch (error: any) {
                this.outputChannel.appendLine(`[_showFileDiff] 打开文件失败: ${error.message}`);
            }
        }
    }

    /**
     * 创建提交输出面板（类似 update 面板）
     */
    private _createCommitOutputPanel(): vscode.WebviewPanel {
        const outputPanel = vscode.window.createWebviewPanel(
            'svnCommitOutput',
            `SVN提交: ${require('path').basename(this.folderPath)}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        outputPanel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SVN提交</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 10px 10px 16px 10px;
            box-sizing: border-box;
            height: 100vh;
            overflow: hidden;
        }
        .container {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
        .output-container {
            flex: 1;
            min-height: 0;
            padding: 10px;
            border: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editor-background);
            overflow: auto;
            white-space: pre-wrap;
            font-family: monospace;
            margin-bottom: 10px;
        }
        .button-container {
            display: flex;
            justify-content: flex-end;
            align-items: center;
            gap: 10px;
            flex-shrink: 0;
            padding-bottom: 4px;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 12px;
            min-width: 96px;
            height: 32px;
            box-sizing: border-box;
            cursor: pointer;
            font-size: inherit;
            line-height: 1;
            border-radius: 2px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        h2 {
            margin-top: 0;
            color: var(--vscode-foreground);
        }
        .file-info {
            margin-bottom: 10px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="container">
        <h2>SVN提交</h2>
        <div class="file-info">${this.folderPath}</div>
        <div class="output-container" id="outputContainer"></div>
        <div class="button-container">
            <button id="close-button" style="display:none;">关闭</button>
        </div>
    </div>
    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const outputContainer = document.getElementById('outputContainer');
            const closeButton = document.getElementById('close-button');
            closeButton.addEventListener('click', () => {
                vscode.postMessage({ command: 'close' });
            });
            window.addEventListener('message', event => {
                const msg = event.data;
                switch (msg.command) {
                    case 'appendOutput':
                        outputContainer.textContent += msg.text;
                        outputContainer.scrollTop = outputContainer.scrollHeight;
                        break;
                    case 'commitComplete':
                        closeButton.style.display = 'inline-block';
                        break;
                }
            });
        }());
    </script>
</body>
</html>`;

        outputPanel.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'close') {
                outputPanel.dispose();
            }
        });

        // 将面板移到独立窗口
        setTimeout(() => {
            vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => {});
        }, 100);

        return outputPanel;
    }

    private async _commitFiles(files: string[], message: string) {
        // 创建独立的提交输出面板（类似 update 面板）
        const outputPanel = this._createCommitOutputPanel();

        // 输出面板关闭时联动关闭提交面板
        outputPanel.onDidDispose(() => {
            try { this._panel.dispose(); } catch { /* ignore */ }
        });

        const appendOutput = (text: string) => {
            outputPanel.webview.postMessage({ command: 'appendOutput', text });
        };

        // 挂载实时输出回调，将 SVN 命令的 stdout/stderr 实时流到输出面板
        this.svnService.onCommandOutput = (data: string) => {
            appendOutput(data);
        };

        try {
            appendOutput(`开始提交 ${files.length} 个文件...\n`);

            if (files.length === 0) {
                throw new Error('请选择要提交的文件');
            }

            // 分类文件状态
            const unversionedFiles: string[] = [];
            const missingFiles: string[] = [];
            const regularFiles: string[] = [];

            files.forEach(file => {
                const fileStatus = this._fileStatuses.find(f => f.path === file);
                if (fileStatus?.type === 'unversioned') {
                    unversionedFiles.push(file);
                } else if (fileStatus?.type === 'missing') {
                    missingFiles.push(file);
                } else {
                    regularFiles.push(file);
                }
            });

            // 批量添加未版本控制的文件
            if (unversionedFiles.length > 0) {
                appendOutput(`添加 ${unversionedFiles.length} 个未版本控制的文件...\n`);
                await this._batchAddFiles(unversionedFiles);
            }

            // 批量标记丢失的文件为删除状态
            if (missingFiles.length > 0) {
                appendOutput(`标记删除 ${missingFiles.length} 个丢失文件...\n`);
                await this._batchRemoveFiles(missingFiles);
            }

            // 分离文件和目录
            const fileEntries = await Promise.all(files.map(async file => {
                const fileStatus = this._fileStatuses.find(f => f.path === file);
                if (fileStatus?.type === 'missing') {
                    return { path: file, isDirectory: false };
                }
                try {
                    const isDirectory = (await vscode.workspace.fs.stat(vscode.Uri.file(file))).type === vscode.FileType.Directory;
                    return { path: file, isDirectory };
                } catch (error) {
                    return { path: file, isDirectory: false };
                }
            }));

            const directories = fileEntries.filter(entry => entry.isDirectory).map(entry => entry.path);

            // 检测是否所有选中文件都在同一个 changelist 中
            const selectedChangelists = new Set<string | undefined>();
            files.forEach(file => {
                const fileStatus = this._fileStatuses.find(f => f.path === file);
                selectedChangelists.add(fileStatus?.changelist);
            });
            const uniqueChangelists = Array.from(selectedChangelists);
            const allInSameChangelist = uniqueChangelists.length === 1 && uniqueChangelists[0] !== undefined;

            // 执行提交
            appendOutput(`正在执行 SVN 提交...\n`);
            if (allInSameChangelist) {
                const changelistName = uniqueChangelists[0]!;
                await this.svnService.commitChangelist(this.folderPath, changelistName, message);
            } else {
                await this.svnService.commitFiles(files, message, this.folderPath);
            }

            // 保存提交日志
            this.logStorage.addLog(message, this.folderPath);

            appendOutput(`\n提交完成 (${files.length} 个文件)\n`);
            outputPanel.webview.postMessage({ command: 'commitComplete' });
            vscode.window.showInformationMessage('文件已成功提交到SVN');
        } catch (error: any) {
            appendOutput(`\n提交失败: ${error.message}\n`);
            outputPanel.webview.postMessage({ command: 'commitComplete' });
            vscode.window.showErrorMessage(`提交失败: ${error.message}`);
        } finally {
            // 取消实时输出回调
            this.svnService.onCommandOutput = undefined;
        }
    }

    private async _generateAICommitLog(): Promise<string> {
        try {
            // 获取选中的文件路径
            const selectedFilePaths = await new Promise<string[]>((resolve) => {
                const handler = this._panel.webview.onDidReceiveMessage(message => {
                    if (message.command === 'selectedFiles') {
                        handler.dispose();
                        resolve(message.files);
                    }
                });
                this._panel.webview.postMessage({ command: 'getSelectedFiles' });
            });

            if (!selectedFilePaths || selectedFilePaths.length === 0) {
                throw new Error('请选择要生成提交日志的文件');
            }

            // 获取所有选中文件的差异信息
            const fileStatusesAndDiffs = await Promise.all(
                selectedFilePaths.map(async (filePath) => {
                    const fileStatus = this._fileStatuses.find(f => f.path === filePath);
                    if (!fileStatus) {
                        return null;
                    }

                    // 对于新增和未版本控制的文件，不需要获取差异
                    if (fileStatus.type === 'added' || fileStatus.type === 'unversioned') {
                        return {
                            path: fileStatus.displayName,
                            status: fileStatus.status,
                            diff: `新文件: ${fileStatus.displayName}`
                        };
                    }

                    // 对于删除的文件和丢失的文件
                    if (fileStatus.type === 'deleted' || fileStatus.type === 'missing') {
                        return {
                            path: fileStatus.displayName,
                            status: fileStatus.status,
                            diff: `删除文件: ${fileStatus.displayName}`
                        };
                    }

                    // 获取文件差异
                    const diff = await this.diffProvider.getDiff(filePath);
                    return {
                        path: fileStatus.displayName,
                        status: fileStatus.status,
                        diff: diff
                    };
                })
            );

            // 过滤掉无效的结果
            const validDiffs = fileStatusesAndDiffs.filter(item => item !== null);

            if (validDiffs.length === 0) {
                throw new Error('没有可用的文件差异信息');
            }

            // 格式化差异信息
            const formattedDiffs = validDiffs.map(item => 
                `文件: ${item!.path} (${item!.status})\n${item!.diff}`
            ).join('\n\n');

            // 使用 AI 生成提交日志
            const commitMessage = await this.aiService.generateCommitMessage(formattedDiffs);

            this.outputChannel.appendLine(`[generateAICommitLog] 生成的提交日志: ${commitMessage}`);
            
            return commitMessage;
        } catch (error: any) {
            vscode.window.showErrorMessage(`生成AI提交日志失败: ${error.message}`);
            return '';
        }
    }

    private _setupMessageHandlers() {
        // 添加一个标志，表示 AI 生成是否正在进行中
        let isGeneratingAILog = false;

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'commit':
                        await this._commitFiles(message.files, message.message);
                        return;
                    case 'showDiff':
                        await this._showFileDiff(message.file);
                        return;
                    case 'generateAILog':
                        // 如果已经在生成中，则不再重复调用
                        if (isGeneratingAILog) {
                            this.outputChannel.appendLine(`[generateAILog] 已有 AI 生成任务正在进行中，忽略此次请求`);
                            return;
                        }

                        try {
                            isGeneratingAILog = true;
                            this._panel.webview.postMessage({ command: 'setGeneratingStatus', status: true });
                            
                            // 生成 AI 日志
                            const aiLog = await this._generateAICommitLog();
                            
                            // 应用前缀
                            if (aiLog) {
                                const messageWithPrefix = await this._applyPrefix(aiLog);
                                this._panel.webview.postMessage({ 
                                    command: 'setCommitMessage', 
                                    message: messageWithPrefix 
                                });
                            }
                        } catch (error: any) {
                            vscode.window.showErrorMessage(`生成 AI 提交日志失败: ${error.message}`);
                        } finally {
                            isGeneratingAILog = false;
                            this._panel.webview.postMessage({ command: 'setGeneratingStatus', status: false });
                        }
                        return;
                    case 'savePrefix':
                        // 保存前缀到历史记录
                        this.logStorage.addPrefix(message.prefix);
                        return;
                    case 'selectedFiles':
                        // 处理选中的文件列表
                        return;
                    case 'showSideBySideDiff':
                        // 查找文件状态
                        const fileStatus = this._fileStatuses.find(f => f.path === message.file);
                        if (fileStatus && fileStatus.type === 'modified') {
                            // 如果是修改状态，显示左右对比
                            await this.diffProvider.showDiff(message.file);
                        } else {
                            // 其他状态，直接打开文件
                            const uri = vscode.Uri.file(message.file);
                            try {
                                await vscode.commands.executeCommand('vscode.open', uri);
                            } catch (error: any) {
                                vscode.window.showErrorMessage(`打开文件失败: ${error.message}`);
                            }
                        }
                        return;
                    case 'revertFile':
                        await this._revertFile(message.file);
                        return;
                    case 'revertFiles':
                        await this._revertFiles(message.files || []);
                        return;
                    case 'deleteUnversionedFiles':
                        await this._deleteUnversionedFiles(message.files);
                        return;
                    case 'moveToChangelist':
                        await this._moveFilesToChangelist(message.files, message.targetChangelist);
                        return;
                    case 'promptNewChangelist': {
                        const files = message.files || [];
                        if (!files.length) {
                            return;
                        }
                        // 收集已有 changelist 名称，用于去重校验
                        const existing = new Set<string>();
                        this._fileStatuses.forEach(fs => { if (fs.changelist) existing.add(fs.changelist); });
                        this._knownChangelists.forEach(cl => existing.add(cl));
                        const name = await vscode.window.showInputBox({
                            prompt: '输入新的 Changelist 名称',
                            placeHolder: '例如：feature-xxx',
                            validateInput: v => {
                                const trimmed = (v || '').trim();
                                if (!trimmed) return '名称不能为空';
                                if (existing.has(trimmed)) return '该 Changelist 已存在';
                                return null;
                            }
                        });
                        if (name && name.trim()) {
                            await this._moveFilesToChangelist(files, name.trim());
                        }
                        return;
                    }
                    case 'deleteChangelist':
                        await this._deleteChangelist(message.changelist);
                        return;
                    case 'savePersistentState':
                        // 接收 webview 端发来的持久化状态更新
                        this._savePersistentState({
                            uncheckedFiles: message.uncheckedFiles,
                            hiddenGroups: message.hiddenGroups
                        });
                        return;
                    case 'closePanel':
                        this._panel.dispose();
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private async _deleteUnversionedFiles(files: string[]): Promise<void> {
        if (!files || files.length === 0) {
            vscode.window.showWarningMessage('请先勾选需要删除的 Unversioned 文件');
            return;
        }

        // 只允许删除 unversioned 类型文件（按前端勾选过滤）
        const unversionedPaths = new Set(
            this._fileStatuses.filter(f => f.type === 'unversioned').map(f => f.path)
        );
        const targets = files.filter(p => unversionedPaths.has(p));
        if (targets.length === 0) {
            vscode.window.showWarningMessage('勾选的文件中没有 Unversioned 文件');
            return;
        }

        const preview = targets.slice(0, 5).map(p => `  • ${p}`).join('\n');
        const more = targets.length > 5 ? `\n  …还有 ${targets.length - 5} 个` : '';
        const confirm = await vscode.window.showWarningMessage(
            `确认删除以下 ${targets.length} 个未版本控制的文件/文件夹？此操作不可恢复。\n\n${preview}${more}`,
            { modal: true },
            '删除'
        );
        if (confirm !== '删除') {
            return;
        }

        const failures: { file: string; error: string }[] = [];
        const successfulPaths: string[] = [];
        for (const target of targets) {
            try {
                // 检查文件/目录是否存在（可能已被 revert 操作移除）
                try {
                    await fs.promises.lstat(target);
                } catch {
                    // 文件不存在，视为已成功删除
                    successfulPaths.push(target);
                    this.outputChannel.appendLine(`[删除跳过] ${target}: 文件已不存在`);
                    continue;
                }
                const stat = await fs.promises.lstat(target);
                if (stat.isDirectory()) {
                    await fs.promises.rm(target, { recursive: true, force: true });
                } else {
                    await fs.promises.unlink(target);
                }
                successfulPaths.push(target);
                this.outputChannel.appendLine(`[删除成功] ${target}`);
            } catch (err: any) {
                const msg = err && err.message ? err.message : String(err);
                failures.push({ file: target, error: msg });
                this.outputChannel.appendLine(`[删除失败] ${target}: ${msg}`);
            }
        }
        const successCount = successfulPaths.length;

        if (failures.length === 0) {
            vscode.window.showInformationMessage(`已删除 ${successCount} 个未版本控制的文件/文件夹`);
        } else {
            vscode.window.showErrorMessage(
                `删除完成：成功 ${successCount} 个，失败 ${failures.length} 个。详见 OUTPUT 面板。`
            );
            this.outputChannel.show(true);
        }

        // 乐观更新本地 _fileStatuses，避免再次 svn status 访问
        if (successfulPaths.length > 0) {
            const removedSet = new Set(successfulPaths);
            this._fileStatuses = this._fileStatuses.filter(fs => !removedSet.has(fs.path));
        }

        // 直接重绘 webview，不重新执行 svn status
        this._panel.webview.html = await this._getHtmlForWebview();
    }

    /**
     * 拖拽：移动文件到指定 changelist（targetChangelist 为空表示移出到 Changes）
     * - 已纳入版本控制的文件直接切换 changelist
     * - Unversioned 文件会先 svn add 加入版本控制，再（若有目标）加入 changelist
     */
    private async _moveFilesToChangelist(files: string[], targetChangelist: string | null | undefined): Promise<void> {
        if (!files || files.length === 0) {
            return;
        }

        const fileMap = new Map(this._fileStatuses.map(f => [f.path, f] as [string, FileStatus]));
        const targets = files.filter(p => fileMap.has(p));
        if (targets.length === 0) {
            return;
        }

        // 过滤掉已经在目标 changelist 的已纳入版本控制文件（Unversioned 必须执行）
        const normalizedTarget = (targetChangelist && targetChangelist.trim()) ? targetChangelist.trim() : null;
        const toMove = targets.filter(p => {
            const f = fileMap.get(p)!;
            if (f.type === 'unversioned') return true; // unversioned 必须执行 add
            const current = f.changelist || null;
            return current !== normalizedTarget;
        });

        if (toMove.length === 0) {
            return;
        }

        const failures: { file: string; error: string }[] = [];
        const successfulTargets: string[] = [];
        let addedCount = 0;
        for (const target of toMove) {
            const f = fileMap.get(target)!;
            try {
                // Unversioned 文件先加入版本控制
                if (f.type === 'unversioned') {
                    await this.svnService.addFile(target);
                    addedCount++;
                    this.outputChannel.appendLine(`[svn add] ${target}`);
                }
                // 再执行 changelist 操作
                if (normalizedTarget) {
                    await this.svnService.addToChangelist(target, normalizedTarget);
                } else if (f.type !== 'unversioned') {
                    // 已纳入版本控制且目标是 Changes → 移出 changelist
                    await this.svnService.removeFromChangelist(target);
                }
                // 如果原本是 unversioned 且目标是 Changes，只执行了 svn add，无需再移出 changelist
                successfulTargets.push(target);
            } catch (err: any) {
                const msg = err && err.message ? err.message : String(err);
                failures.push({ file: target, error: msg });
                this.outputChannel.appendLine(`[Changelist 移动失败] ${target}: ${msg}`);
            }
        }
        const successCount = successfulTargets.length;

        // 乐观更新本地 _fileStatuses，避免再次 svn status 访问
        if (successCount > 0) {
            const targetSet = new Set(successfulTargets);
            this._fileStatuses = this._fileStatuses.map(fs => {
                if (!targetSet.has(fs.path)) return fs;
                if (fs.type === 'unversioned') {
                    // Unversioned → Added，同时更新 changelist
                    return {
                        ...fs,
                        type: 'added' as const,
                        status: this._getStatusText('A'),
                        changelist: normalizedTarget || undefined
                    };
                }
                return {
                    ...fs,
                    changelist: normalizedTarget || undefined
                };
            });
            // 登记新目标 changelist（包含新建）
            if (normalizedTarget) {
                this._knownChangelists.add(normalizedTarget);
            }
        }

        const targetLabel = normalizedTarget ? `changelist “${normalizedTarget}”` : 'Changes';
        const addInfo = addedCount > 0 ? `（其中 ${addedCount} 个 unversioned 文件已加入版本控制）` : '';
        if (failures.length === 0) {
            vscode.window.showInformationMessage(`已将 ${successCount} 个文件移动到 ${targetLabel}${addInfo}`);
        } else {
            vscode.window.showErrorMessage(
                `移动完成：成功 ${successCount} 个，失败 ${failures.length} 个。详见 OUTPUT 面板。`
            );
            this.outputChannel.show(true);
        }

        // 直接重绘 webview，不重新执行 svn status
        this._panel.webview.html = await this._getHtmlForWebview();
    }

    /**
     * 删除指定 changelist：将其中所有文件移入 Changes（即执行 removeFromChangelist），
     * 然后从本地已知 changelist 集合移除该名称。不调用 svn status，直接重绘。
     */
    private async _deleteChangelist(changelistName: string | undefined): Promise<void> {
        const name = (changelistName || '').trim();
        if (!name) {
            return;
        }

        const filesInCL = this._fileStatuses.filter(fs => fs.changelist === name);
        const confirm = await vscode.window.showWarningMessage(
            filesInCL.length > 0
                ? `确定删除 Changelist “${name}”？其中的 ${filesInCL.length} 个文件将被移回 Changes。`
                : `确定删除空 Changelist “${name}”？`,
            { modal: true },
            '删除'
        );
        if (confirm !== '删除') {
            return;
        }

        const failures: { file: string; error: string }[] = [];
        const successfulPaths: string[] = [];
        for (const f of filesInCL) {
            try {
                await this.svnService.removeFromChangelist(f.path);
                successfulPaths.push(f.path);
            } catch (err: any) {
                const msg = err && err.message ? err.message : String(err);
                failures.push({ file: f.path, error: msg });
                this.outputChannel.appendLine(`[删除 Changelist 失败] ${f.path}: ${msg}`);
            }
        }

        // 乐观更新本地文件：将成功移出的文件 changelist 清空
        if (successfulPaths.length > 0) {
            const pathSet = new Set(successfulPaths);
            this._fileStatuses = this._fileStatuses.map(fs =>
                pathSet.has(fs.path) ? { ...fs, changelist: undefined } : fs
            );
        }

        // 仅在全部移出成功（或原本就是空的）的情况下才移除已知集合
        if (failures.length === 0) {
            this._knownChangelists.delete(name);
            vscode.window.showInformationMessage(
                filesInCL.length > 0
                    ? `已删除 Changelist “${name}”，${filesInCL.length} 个文件已移回 Changes`
                    : `已删除空 Changelist “${name}”`
            );
        } else {
            vscode.window.showErrorMessage(
                `删除完成：成功移出 ${successfulPaths.length} 个，失败 ${failures.length} 个。Changelist 未完全移除，详见 OUTPUT 面板。`
            );
            this.outputChannel.show(true);
        }

        this._panel.webview.html = await this._getHtmlForWebview();
    }

    private async _applyPrefix(commitMessage: string): Promise<string> {
        // 获取当前前缀
        const prefix = await new Promise<string>((resolve) => {
            const handler = this._panel.webview.onDidReceiveMessage(msg => {
                if (msg.command === 'currentPrefix') {
                    handler.dispose();
                    resolve(msg.prefix);
                }
            });
            this._panel.webview.postMessage({ command: 'getCurrentPrefix' });
        });
        
        // 如果有前缀，添加到提交日志前面
        const finalMessage = prefix.trim() 
            ? `${prefix.trim()}\n${commitMessage}`
            : commitMessage;

        return finalMessage;
    }

    private async _getHtmlForWebview(): Promise<string> {
        try {
            // 准备模板变量
            const templateVariables = {
                PERSISTENT_STATE: JSON.stringify(this._loadPersistentState()),
                CHANGELIST_CHECKBOXES: this._renderChangelistCheckboxes(this._fileStatuses),
                FILE_LIST: this._renderFileList(this._fileStatuses),
                PREFIX_OPTIONS: this._renderHistoryOptions(),
                LAST_COMMIT_MESSAGE: this._getLastCommitMessage()
            };

            // 使用内联模板（CSS 和 JS 内嵌在 HTML 中）
            return await this.templateManager.loadInlineTemplate('folderCommitPanel', templateVariables);
        } catch (error) {
            console.error('加载模板失败，使用备用模板:', error);
            // 如果模板加载失败，返回一个简单的备用模板
            return this._getFallbackHtml();
        }
    }

    private _getFallbackHtml(): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
                <style>
                    body { padding: 20px; font-family: var(--vscode-font-family); }
                    .error { color: var(--vscode-errorForeground); }
                </style>
            </head>
            <body>
                <div class="error">
                    <h2>模板加载失败</h2>
                    <p>无法加载文件夹提交面板模板，请检查模板文件是否存在。</p>
                </div>
            </body>
            </html>
        `;
    }

    private _renderFileList(files: FileStatus[]): string {
        // 1. 分离三类文件：有 changelist 的、无 changelist 的版本控制文件、未版本控制文件
        const changelistGroups = new Map<string, FileStatus[]>();
        const changesFiles: FileStatus[] = [];
        const unversionedFiles: FileStatus[] = [];

        files.forEach(file => {
            if (file.type === 'unversioned') {
                unversionedFiles.push(file);
            } else if (file.changelist) {
                if (!changelistGroups.has(file.changelist)) {
                    changelistGroups.set(file.changelist, []);
                }
                changelistGroups.get(file.changelist)!.push(file);
            } else {
                changesFiles.push(file);
            }
        });

        let html = '';

        // 2. Changes 分组始终显示在最上面（即使为空）
        html += this._renderGroup('changes', 'Changes', changesFiles);

        // 3. changelist：合并"当前有文件的"与"已知的（可能为空）"，按名称排序
        const allChangelistNames = new Set<string>([
            ...changelistGroups.keys(),
            ...this._knownChangelists
        ]);
        const sortedChangelists = Array.from(allChangelistNames).sort();
        for (const changelist of sortedChangelists) {
            const groupFiles = changelistGroups.get(changelist) || [];
            html += this._renderGroup('changelist', changelist, groupFiles);
        }

        // 4. 未版本控制文件 → “Unversioned Files” 分组
        if (unversionedFiles.length > 0) {
            html += this._renderGroup('unversioned', 'Unversioned Files', unversionedFiles);
        }

        return html;
    }

    private _renderGroup(groupType: 'changelist' | 'changes' | 'unversioned', title: string, files: FileStatus[]): string {
        const groupChangelist = groupType === 'changelist' ? title : (groupType === 'changes' ? '__changes__' : '__unversioned__');
        const groupHtml = files.map(file => this._renderFileItem(file, groupChangelist)).join('');

        let icon = '📁';
        let cssClass = 'changelist-group';
        if (groupType === 'changes') {
            icon = '📝';
            cssClass = 'changelist-group group-changes';
        } else if (groupType === 'unversioned') {
            icon = '❓';
            cssClass = 'changelist-group group-unversioned';
        }

        const groupId = groupType === 'changelist' ? `cl-${title}` : groupType;

        // changelist 类型在 header 右侧展示删除按钮（样式与 file-item 的 .delete-button 保持一致）
        const deleteBtn = groupType === 'changelist'
            ? `<button class="delete-button changelist-delete" title="删除此 Changelist（文件会移入 Changes）">删除</button>`
            : '';

        return `
            <div class="${cssClass}" data-group-type="${groupType}" data-group-id="${groupId.replace(/"/g, '&quot;')}" data-changelist="${groupChangelist.replace(/"/g, '&quot;')}">
                <div class="changelist-header">
                    <span class="changelist-toggle" title="点击折叠/展开">▼</span>
                    <input type="checkbox" class="group-select-all" title="全选/取消全选此分组">
                    <span class="changelist-icon">${icon}</span>
                    <span class="changelist-name">${title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
                    <span class="changelist-count">(${files.length} 个文件)</span>
                    ${deleteBtn}
                </div>
                <div class="changelist-files">
                    ${groupHtml}
                </div>
            </div>
        `;
    }

    private _renderFileItem(file: FileStatus, changelistOverride?: string): string {
        // 转义文件路径中的特殊字符
        const escapedPath = file.path
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        const fileName = path.basename(file.displayName);
        const filePath = path.dirname(file.displayName);

        const escapedFileName = fileName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const escapedFilePath = filePath.replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // 根据状态设置不同的样式类
        let statusClass = file.type;
        if (file.status.includes('冲突')) {
            statusClass = 'conflict';
        } else if (file.status.includes('丢失')) {
            statusClass = 'missing';
        }

        // 确定是否显示恢复按钮（新增、已修改、已删除或丢失状态都显示）
        const showRevertButton = file.type === 'modified' || file.type === 'added' || file.type === 'deleted' || file.type === 'missing';
        // 未版本控制文件显示删除按钮
        const showDeleteButton = file.type === 'unversioned';
        // unversioned 文件也允许拖动（拖入 changelist/Changes 时会自动 svn add）
        const draggable = true;

        const changelistValue = changelistOverride || (file.changelist ? file.changelist.replace(/"/g, '&quot;') : '');

        return `
            <div class="file-item status-${statusClass}"
                 data-path="${escapedPath}"
                 data-type="${file.type}"
                 data-changelist="${changelistValue}"
                 data-locked="${file.locked ? 'true' : 'false'}"
                 ${draggable ? 'draggable="true"' : ''}>
                <span class="checkbox-cell">
                    <input type="checkbox" class="file-checkbox">
                </span>
                <span class="file-name" title="${escapedFileName}">${escapedFileName}${file.locked ? ' 🔒' : ''}</span>
                <span class="file-path" title="${escapedFilePath}">${escapedFilePath}</span>
                <span class="file-status" title="${file.status}${file.locked ? ' (已锁定)' : ''}">${file.status}${file.locked ? '（锁定）' : ''}</span>
                <span class="file-action">
                    ${file.type !== 'deleted' && file.type !== 'missing' ? `
                        <button class="diff-button" title="查看内联差异">差异</button>
                        <button class="side-by-side-button" title="${file.type === 'modified' ? '查看左右对比' : '打开文件'}">${file.type === 'modified' ? '对比' : '打开'}</button>
                    ` : ''}
                    ${showRevertButton ? `
                        <button class="revert-button" title="恢复文件修改">恢复</button>
                    ` : ''}
                    ${showDeleteButton ? `
                        <button class="delete-button" title="从磁盘彻底删除此文件/文件夹">删除</button>
                    ` : ''}
                </span>
            </div>
        `;
    }

    private _renderChangelistCheckboxes(files: FileStatus[]): string {
        const changelists = new Set<string>();
        let hasChanges = false;
        let hasUnversioned = false;
        files.forEach(file => {
            if (file.type === 'unversioned') { hasUnversioned = true; }
            else if (file.changelist) { changelists.add(file.changelist); }
            else { hasChanges = true; }
        });

        let html = '';

        // Changes 分组（始终显示）
        const changesCount = files.filter(f => f.type !== 'unversioned' && !f.changelist).length;
        html += `<label style="margin-left:12px;border-left:1px solid var(--vscode-panel-border,#444);padding-left:12px;">
            <input type="checkbox" class="changelist-filter-checkbox" data-group-value="__changes__" checked>
            Changes(${changesCount})
        </label>`;

        // 各个 changelist
        for (const cl of Array.from(changelists).sort()) {
            const count = files.filter(f => f.changelist === cl).length;
            html += `<label>
                <input type="checkbox" class="changelist-filter-checkbox" data-group-value="${cl.replace(/"/g, '&quot;')}" checked>
                ${cl.replace(/</g, '&lt;').replace(/>/g, '&gt;')}(${count})
            </label>`;
        }

        // Unversioned Files
        if (hasUnversioned) {
            const count = files.filter(f => f.type === 'unversioned').length;
            html += `<label>
                <input type="checkbox" class="changelist-filter-checkbox" data-group-value="__unversioned__" checked>
                Unversioned(${count})
            </label>`;
        }

        return html;
    }

    private _renderHistoryOptions(): string {
        const logs = this.logStorage.getLogs();
        return logs.map(log => {
            // 显示第一行作为选项文本，完整内容作为 value
            const firstLine = log.message.split('\n')[0].trim();
            const displayText = firstLine.length > 60 ? firstLine.substring(0, 60) + '...' : firstLine;
            const escapedValue = log.message.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<option value="${escapedValue}">${displayText}</option>`;
        }).join('');
    }

    private _getLastCommitMessage(): string {
        const logs = this.logStorage.getLogs();
        if (logs.length > 0) {
            return logs[0].message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        return '';
    }

    private _getHtmlForDiffView(filePath: string, diff: string): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    .diff-content {
                        font-family: monospace;
                        white-space: pre;
                        padding: 10px;
                    }
                    .diff-added { background-color: var(--vscode-diffEditor-insertedTextBackground); }
                    .diff-removed { background-color: var(--vscode-diffEditor-removedTextBackground); }
                </style>
            </head>
            <body>
                <h2>文件差异: ${path.basename(filePath)}</h2>
                <div class="diff-content">${this._formatDiff(diff)}</div>
            </body>
            </html>
        `;
    }

    private _formatDiff(diff: string): string {
        return diff
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .split('\n')
            .map(line => {
                if (line.startsWith('+')) {
                    return `<div class="diff-added">${line}</div>`;
                } else if (line.startsWith('-')) {
                    return `<div class="diff-removed">${line}</div>`;
                }
                return `<div>${line}</div>`;
            })
            .join('');
    }

    /**
     * 批量添加文件到SVN
     * @param files 要添加的文件路径数组
     */
    private async _batchAddFiles(files: string[]): Promise<void> {
        this.outputChannel.appendLine(`\n[_batchAddFiles] 开始批量添加操作`);
        this.outputChannel.appendLine(`[_batchAddFiles] 工作目录: ${this.folderPath}`);
        this.outputChannel.appendLine(`[_batchAddFiles] 要添加的文件数量: ${files.length}`);
        
        try {
            // 构建批量添加命令
            const workingDir = this.folderPath;
            this.outputChannel.appendLine(`[_batchAddFiles] 开始构建相对路径...`);
            
            const fileArgs = files.map((file, index) => {
                const relativePath = path.relative(workingDir, file);
                // 处理@符号转义
                const escapedPath = relativePath.includes('@') ? `${relativePath}@` : relativePath;
                const quotedPath = `"${escapedPath}"`;
                
                this.outputChannel.appendLine(`[_batchAddFiles] 文件 ${index + 1}: ${file}`);
                this.outputChannel.appendLine(`[_batchAddFiles]   -> 相对路径: ${relativePath}`);
                this.outputChannel.appendLine(`[_batchAddFiles]   -> 转义路径: ${escapedPath}`);
                this.outputChannel.appendLine(`[_batchAddFiles]   -> 最终参数: ${quotedPath}`);
                
                return quotedPath;
            }).join(' ');
            
            const command = `add ${fileArgs}`;
            this.outputChannel.appendLine(`[_batchAddFiles] 执行SVN命令: svn ${command}`);
            this.outputChannel.appendLine(`[_batchAddFiles] 工作目录: ${workingDir}`);
            
            await this.svnService.executeSvnCommand(command, workingDir);
            this.outputChannel.appendLine(`[_batchAddFiles] ✅ 批量添加成功: ${files.length} 个文件`);
        } catch (error: any) {
            // 如果批量添加失败，回退到逐个添加
            this.outputChannel.appendLine(`[_batchAddFiles] ❌ 批量添加失败，开始回退到逐个添加`);
            this.outputChannel.appendLine(`[_batchAddFiles] 批量添加错误: ${error.message}`);
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                try {
                    this.outputChannel.appendLine(`[_batchAddFiles] 逐个添加第 ${i + 1}/${files.length} 个文件: ${file}`);
                    await this.svnService.addFile(file);
                    this.outputChannel.appendLine(`[_batchAddFiles] 第 ${i + 1} 个文件添加成功`);
                } catch (addError: any) {
                    this.outputChannel.appendLine(`[_batchAddFiles] ❌ 第 ${i + 1} 个文件添加失败: ${file}`);
                    this.outputChannel.appendLine(`[_batchAddFiles] 错误信息: ${addError.message}`);
                    throw addError;
                }
            }
            this.outputChannel.appendLine(`[_batchAddFiles] ✅ 逐个添加完成: ${files.length} 个文件`);
        }
    }

    /**
     * 批量删除文件（标记为删除状态）
     * @param files 要删除的文件路径数组
     */
    private async _batchRemoveFiles(files: string[]): Promise<void> {
        this.outputChannel.appendLine(`\n[_batchRemoveFiles] 开始批量删除操作`);
        this.outputChannel.appendLine(`[_batchRemoveFiles] 工作目录: ${this.folderPath}`);
        this.outputChannel.appendLine(`[_batchRemoveFiles] 要删除的文件数量: ${files.length}`);
        
        try {
            // 构建批量删除命令
            const workingDir = this.folderPath;
            this.outputChannel.appendLine(`[_batchRemoveFiles] 开始构建相对路径...`);
            
            const fileArgs = files.map((file, index) => {
                const relativePath = path.relative(workingDir, file);
                // 处理@符号转义
                const escapedPath = relativePath.includes('@') ? `${relativePath}@` : relativePath;
                const quotedPath = `"${escapedPath}"`;
                
                this.outputChannel.appendLine(`[_batchRemoveFiles] 文件 ${index + 1}: ${file}`);
                this.outputChannel.appendLine(`[_batchRemoveFiles]   -> 相对路径: ${relativePath}`);
                this.outputChannel.appendLine(`[_batchRemoveFiles]   -> 转义路径: ${escapedPath}`);
                this.outputChannel.appendLine(`[_batchRemoveFiles]   -> 最终参数: ${quotedPath}`);
                
                return quotedPath;
            }).join(' ');
            
            const command = `remove ${fileArgs}`;
            this.outputChannel.appendLine(`[_batchRemoveFiles] 执行SVN命令: svn ${command}`);
            this.outputChannel.appendLine(`[_batchRemoveFiles] 工作目录: ${workingDir}`);
            
            await this.svnService.executeSvnCommand(command, workingDir);
            this.outputChannel.appendLine(`[_batchRemoveFiles] ✅ 批量删除成功: ${files.length} 个文件`);
        } catch (error: any) {
            // 如果批量删除失败，回退到逐个删除
            this.outputChannel.appendLine(`[_batchRemoveFiles] ❌ 批量删除失败，开始回退到逐个删除`);
            this.outputChannel.appendLine(`[_batchRemoveFiles] 批量删除错误: ${error.message}`);
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                try {
                    this.outputChannel.appendLine(`[_batchRemoveFiles] 逐个删除第 ${i + 1}/${files.length} 个文件: ${file}`);
                    await this.svnService.removeFile(file);
                    this.outputChannel.appendLine(`[_batchRemoveFiles] 第 ${i + 1} 个文件删除成功`);
                } catch (removeError: any) {
                    this.outputChannel.appendLine(`[_batchRemoveFiles] ❌ 第 ${i + 1} 个文件删除失败: ${file}`);
                    this.outputChannel.appendLine(`[_batchRemoveFiles] 错误信息: ${removeError.message}`);
                    throw removeError;
                }
            }
            this.outputChannel.appendLine(`[_batchRemoveFiles] ✅ 逐个删除完成: ${files.length} 个文件`);
        }
    }

    private async _revertFile(filePath: string): Promise<void> {
        try {
            const result = await vscode.window.showWarningMessage(
                '确定要恢复此文件的修改吗？',
                { modal: true, detail: '此操作不可撤销。' },
                '确定'
            );

            if (result === '确定') {
                // 记录 revert 前文件所属的 changelist，用于后续移除
                const targetFile = this._fileStatuses.find(f => f.path === filePath);
                const originalChangelist = targetFile?.changelist;
                const originalType = targetFile?.type;

                // 检测是否为目录（用于之后前缀清理子文件）
                let isDir = false;
                try { isDir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory(); } catch { /* ignore */ }

                await this.svnService.revertFile(filePath);

                // 仅对非 added 类型的文件调用 removeFromChangelist
                // added 文件 revert 后自动变 unversioned，svn 已自动解绑 changelist，再调会报错且浪费一次进程
                if (originalChangelist && originalType !== 'added') {
                    try {
                        await this.svnService.removeFromChangelist(filePath);
                        this.outputChannel.appendLine(`[revert] 已将文件从 changelist “${originalChangelist}” 中移除: ${filePath}`);
                    } catch (clErr: any) {
                        this.outputChannel.appendLine(`[revert] 移出 changelist 失败（可忽略）: ${clErr.message || clErr}`);
                    }
                }

                vscode.window.showInformationMessage(
                    originalChangelist
                        ? `文件已成功恢复，并从 changelist “${originalChangelist}” 中移除`
                        : '文件已成功恢复'
                );

                // 乐观更新：区分 added 的两种来源
                //  - 手动 svn add 的 (A)：revert 后磁盘仍在 → 保留为 unversioned
                //  - merge 带来的 (A +)：revert 后磁盘被删 → 直接移除
                // 其他类型（modified / deleted / missing）一律移除
                const dirPrefix = isDir ? (filePath.endsWith(path.sep) ? filePath : filePath + path.sep) : null;
                this._fileStatuses = this._fileStatuses.reduce<FileStatus[]>((acc, fsEntry) => {
                    if (fsEntry.path === filePath) {
                        if (originalType === 'added' && fs.existsSync(filePath)) {
                            acc.push({
                                ...fsEntry,
                                type: 'unversioned' as const,
                                status: this._getStatusText('?'),
                                changelist: undefined
                            });
                        }
                        return acc;
                    }
                    if (dirPrefix && fsEntry.path.startsWith(dirPrefix)) {
                        if (fsEntry.type === 'added' && fs.existsSync(fsEntry.path)) {
                            acc.push({
                                ...fsEntry,
                                type: 'unversioned' as const,
                                status: this._getStatusText('?'),
                                changelist: undefined
                            });
                        }
                        return acc;
                    }
                    acc.push(fsEntry);
                    return acc;
                }, []);

                // 直接重绘 webview，不重新执行 svn status
                this._panel.webview.html = await this._getHtmlForWebview();
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`恢复文件失败: ${error.message}`);
        }
    }

    private async _revertFiles(filePaths: string[]): Promise<void> {
        if (!filePaths || filePaths.length === 0) {
            return;
        }
        // 去重 + 且只保留在 _fileStatuses 中存在的文件
        const pathSet = new Set(filePaths);
        const targets = this._fileStatuses.filter(f => pathSet.has(f.path));
        if (targets.length === 0) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            targets.length === 1
                ? '确定要恢复此文件的修改吗？'
                : `确定要恢复选中的 ${targets.length} 个文件吗？`,
            { modal: true, detail: '此操作不可撤销。' },
            '确定'
        );
        if (confirm !== '确定') {
            return;
        }

        const startTime = Date.now();
        const failures: { file: string; error: string }[] = [];
        const successful: FileStatus[] = [];

        // 批量一次性传给 svn revert（仿 TortoiseSVN，svnService 内部已做路径去重/子路径剔除）
        // 注意：不再回退到逐个循环执行——那样会触发 N 次 svn 子进程，耗时数分钟
        try {
            await this.svnService.revertFiles(targets.map(f => f.path));
            successful.push(...targets);
        } catch (err: any) {
            const msg = err && err.message ? err.message : String(err);
            this.outputChannel.appendLine(`[revert] 批量恢复失败: ${msg}`);
            // 整批视为失败（不逐个重试，避免 N 次 svn 进程拖慢整体）
            for (const f of targets) {
                failures.push({ file: f.path, error: msg });
            }
        }

        // 批量移除 changelist：跳过 added 类型（svn 已自动解绑），一次 SVN 进程完成多文件
        const clTargets = successful.filter(f => f.changelist && f.type !== 'added');
        if (clTargets.length > 0) {
            try {
                await this.svnService.removeFromChangelistBatch(clTargets.map(f => f.path));
                this.outputChannel.appendLine(`[revert] 批量移出 changelist，共 ${clTargets.length} 个文件`);
            } catch (clErr: any) {
                this.outputChannel.appendLine(`[revert] 批量移出 changelist 失败（可忽略）: ${clErr.message || clErr}`);
            }
        }

        const elapsed = Date.now() - startTime;
        if (failures.length === 0) {
            vscode.window.showInformationMessage(`已成功恢复 ${successful.length} 个文件（耗时 ${elapsed}ms）`);
        } else {
            vscode.window.showErrorMessage(
                `恢复完成：成功 ${successful.length} 个，失败 ${failures.length} 个。详见 OUTPUT 面板。`
            );
            this.outputChannel.show(true);
        }

        // 乐观更新本地 _fileStatuses：精确命中 + 目录前缀清理子文件
        const successPathSet = new Set(successful.map(f => f.path));
        const typeMap = new Map(successful.map(f => [f.path, f.type]));

        // 收集 revert 成功的目录前缀（用于前缀匹配子文件）
        const dirPrefixes: string[] = [];
        for (const f of successful) {
            try {
                if (fs.existsSync(f.path) && fs.statSync(f.path).isDirectory()) {
                    dirPrefixes.push(f.path.endsWith(path.sep) ? f.path : f.path + path.sep);
                }
            } catch { /* ignore */ }
        }

        // 乐观更新：区分 added 的两种来源
        //  - 手动 svn add 的 (A)：revert 后磁盘仍在 → 保留为 unversioned
        //  - merge 带来的 (A +)：revert 后磁盘被删 → 直接移除
        // 其他类型（modified / deleted / missing）一律移除
        this._fileStatuses = this._fileStatuses.reduce<FileStatus[]>((acc, fsEntry) => {
            // 精确命中的文件
            if (successPathSet.has(fsEntry.path)) {
                if (typeMap.get(fsEntry.path) === 'added' && fs.existsSync(fsEntry.path)) {
                    acc.push({
                        ...fsEntry,
                        type: 'unversioned' as const,
                        status: this._getStatusText('?'),
                        changelist: undefined
                    });
                }
                return acc;
            }
            // 落入 revert 目录前缀的子条目
            if (dirPrefixes.some(prefix => fsEntry.path.startsWith(prefix))) {
                if (fsEntry.type === 'added' && fs.existsSync(fsEntry.path)) {
                    acc.push({
                        ...fsEntry,
                        type: 'unversioned' as const,
                        status: this._getStatusText('?'),
                        changelist: undefined
                    });
                }
                return acc;
            }
            acc.push(fsEntry);
            return acc;
        }, []);

        // 直接重绘 webview
        this._panel.webview.html = await this._getHtmlForWebview();
    }

    public dispose() {
        SvnFolderCommitPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
} 
