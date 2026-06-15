import * as vscode from 'vscode';
import * as path from 'path';
import { SvnService } from './svnService';
import { TemplateManager } from './templateManager';
import { CommitLogStorage } from './commitLogStorage';

/**
 * SVN 分支合并面板
 */
export class SvnMergePanel {
    private static currentPanel: SvnMergePanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly svnService: SvnService;
    private readonly templateManager: TemplateManager;
    private readonly folderPath: string;
    private readonly outputChannel: vscode.OutputChannel;
    private readonly logStorage: CommitLogStorage;
    private _disposables: vscode.Disposable[] = [];

    // 面板状态
    private _repoRootUrl: string = '';
    private _workingCopyUrl: string = '';

    public static show(
        context: vscode.ExtensionContext,
        svnService: SvnService,
        folderPath: string,
        logStorage: CommitLogStorage
    ): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SvnMergePanel.currentPanel) {
            SvnMergePanel.currentPanel._panel.reveal(undefined, true);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'svnMerge',
            'SVN 分支合并',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // 将 webview 面板移到独立的悬浮窗口
        setTimeout(() => {
            vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => { /* 老版本不支持，静默忽略 */ });
        }, 100);

        SvnMergePanel.currentPanel = new SvnMergePanel(panel, context, svnService, folderPath, logStorage);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        svnService: SvnService,
        folderPath: string,
        logStorage: CommitLogStorage
    ) {
        this._panel = panel;
        this.svnService = svnService;
        this.folderPath = folderPath;
        this.logStorage = logStorage;
        this.templateManager = new TemplateManager(context.extensionUri);
        this.outputChannel = vscode.window.createOutputChannel('SVN Merge');

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setupMessageHandlers();
        this._initPanel();
    }

    private async _initPanel(): Promise<void> {
        try {
            this._repoRootUrl = await this.svnService.getRepositoryRootUrlFromInfo(this.folderPath);
            this._workingCopyUrl = await this.svnService.getWorkingCopyUrl(this.folderPath);
        } catch (err: any) {
            vscode.window.showErrorMessage(`获取 SVN 仓库信息失败: ${err.message}`);
        }
        this._panel.webview.html = await this._getHtmlForWebview();
    }

    private async _getHtmlForWebview(): Promise<string> {
        try {
            const variables = {
                REPO_ROOT_URL: this._repoRootUrl,
                WORKING_COPY_URL: this._workingCopyUrl,
                FOLDER_PATH: this.folderPath
            };
            return await this.templateManager.loadInlineTemplate('mergePanel', variables);
        } catch (error) {
            console.error('加载合并面板模板失败:', error);
            return this._getFallbackHtml();
        }
    }

    private _getFallbackHtml(): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
            <style>body{padding:20px;font-family:var(--vscode-font-family);}.error{color:var(--vscode-errorForeground);}</style>
            </head><body><div class="error"><h2>模板加载失败</h2><p>无法加载合并面板模板。</p></div></body></html>`;
    }

    private _setupMessageHandlers(): void {
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'listBranches':
                        await this._handleListBranches();
                        return;
                    case 'loadRevisions':
                        await this._handleLoadRevisions(message);
                        return;
                    case 'merge':
                        await this._handleMerge(message);
                        return;
                    case 'dryRun':
                        await this._handleDryRun(message);
                        return;
                    case 'getConflicts':
                        await this._handleGetConflicts();
                        return;
                    case 'resolveConflict':
                        await this._handleResolveConflict(message);
                        return;
                    case 'openCommitPanel':
                        vscode.commands.executeCommand('vscode-svn.uploadFolder',
                            vscode.Uri.file(this.folderPath));
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    /**
     * 从工作副本 URL 推断项目根 URL
     * 例如 http://svn/repo/client/trunk -> http://svn/repo/client
     * 例如 http://svn/repo/client/tags/7.0 -> http://svn/repo/client
     * 例如 http://svn/repo/client/branches/dev -> http://svn/repo/client
     */
    private _inferProjectRoot(): string {
        const url = this._workingCopyUrl;
        // 尝试匹配 trunk/tags/xxx/branches/xxx
        const patterns = [
            /\/trunk(\/.*)?$/,
            /\/tags\/[^\/]+(\/.*)?$/,
            /\/branches\/[^\/]+(\/.*)?$/
        ];
        for (const p of patterns) {
            if (p.test(url)) {
                return url.replace(p, '');
            }
        }
        // 无法推断，回退到 repo root
        return this._repoRootUrl;
    }

    /**
     * 分支发现逻辑：
     * 适配结构 xxx/trunk + xxx/tags/分支1,分支2
     * 同时兼容标准 branches/ 结构
     */
    private async _handleListBranches(): Promise<void> {
        try {
            const projectRoot = this._inferProjectRoot();
            const branches: { name: string; url: string; type: string }[] = [];

            // 1. 检测 trunk
            const trunkUrl = `${projectRoot}/trunk`;
            const trunkLs = await this.svnService.listRemoteDir(trunkUrl, this.folderPath);
            if (trunkLs.length > 0) {
                branches.push({ name: 'trunk', url: trunkUrl, type: 'trunk' });
            }

            // 2. 检测 branches/（标准结构）
            const branchesUrl = `${projectRoot}/branches`;
            const branchList = await this.svnService.listRemoteDir(branchesUrl, this.folderPath);
            for (const b of branchList) {
                branches.push({ name: `branches/${b}`, url: `${branchesUrl}/${b}`, type: 'branch' });
            }

            // 3. 检测 tags/
            const tagsUrl = `${projectRoot}/tags`;
            const tagList = await this.svnService.listRemoteDir(tagsUrl, this.folderPath);
            for (const t of tagList) {
                branches.push({ name: `tags/${t}`, url: `${tagsUrl}/${t}`, type: 'tag' });
            }

            this._panel.webview.postMessage({
                command: 'branchList',
                branches,
                currentUrl: this._workingCopyUrl
            });
        } catch (err: any) {
            this._panel.webview.postMessage({
                command: 'error',
                message: `获取分支列表失败: ${err.message}`
            });
        }
    }

    /**
     * 加载选中分支的版本日志 + 合并状态信息
     */
    private async _handleLoadRevisions(message: any): Promise<void> {
        const { sourceUrl } = message;
        if (!sourceUrl) {
            this._panel.webview.postMessage({ command: 'error', message: '请先选择合并源分支' });
            return;
        }

        try {
            this._panel.webview.postMessage({ command: 'revisionsLoading' });

            // 并行获取：日志、已合并版本、可合并版本
            const [logEntries, mergedRevs, eligibleRevs] = await Promise.all([
                this.svnService.getLogEntries(sourceUrl, this.folderPath, 1000),
                this.svnService.getMergedRevisions(this.folderPath, sourceUrl),
                this.svnService.getEligibleRevisions(this.folderPath, sourceUrl)
            ]);

            // 过滤：只显示 eligible + merged 的版本（排除分支创建点之前的）
            const visibleRevisions = logEntries
                .filter(entry => eligibleRevs.has(entry.revision) || mergedRevs.has(entry.revision))
                .map(entry => ({
                    revision: entry.revision,
                    author: entry.author,
                    date: entry.date,
                    message: entry.message,
                    merged: mergedRevs.has(entry.revision),
                    eligible: eligibleRevs.has(entry.revision)
                }));

            this._panel.webview.postMessage({
                command: 'revisionList',
                revisions: visibleRevisions
            });
        } catch (err: any) {
            this._panel.webview.postMessage({
                command: 'error',
                message: `加载版本日志失败: ${err.message}`
            });
        }
    }

    private async _handleMerge(message: any): Promise<void> {
        const { sourceUrl, revisionRange, revisionDetails } = message;
        if (!sourceUrl) {
            this._panel.webview.postMessage({ command: 'error', message: '请指定合并源' });
            return;
        }

        // 执行合并：关闭当前面板，打开新的进度面板展示执行过程
        const svnService = this.svnService;
        const folderPath = this.folderPath;
        const logStorage = this.logStorage;
        const saveLog = (rr: string, rd: any) => this._saveMergeCommitLog(sourceUrl, rr, rd);

        // 先关闭当前面板
        this._panel.dispose();

        // 打开进度面板执行合并
        SvnMergePanel._runInProgressPanel({
            title: 'SVN 合并执行',
            svnService,
            folderPath,
            sourceUrl,
            revisionRange,
            dryRun: false,
            onSuccess: async () => {
                saveLog(revisionRange, revisionDetails);
                return await svnService.getMergeConflicts(folderPath);
            }
        });
    }

    private async _handleDryRun(message: any): Promise<void> {
        const { sourceUrl, revisionRange } = message;
        if (!sourceUrl) {
            this._panel.webview.postMessage({ command: 'error', message: '请指定合并源' });
            return;
        }

        // 预览：不关闭当前面板，直接打开新的进度面板展示执行过程
        SvnMergePanel._runInProgressPanel({
            title: 'SVN 合并预览',
            svnService: this.svnService,
            folderPath: this.folderPath,
            sourceUrl,
            revisionRange,
            dryRun: true
        });
    }

    /**
     * 在新的进度面板中流式执行合并操作
     */
    private static _runInProgressPanel(opts: {
        title: string;
        svnService: SvnService;
        folderPath: string;
        sourceUrl: string;
        revisionRange: string;
        dryRun: boolean;
        onSuccess?: () => Promise<any>;
    }): void {
        const panel = vscode.window.createWebviewPanel(
            'svnMergeProgress',
            opts.title,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        // 将 webview 面板移到独立的悬浮窗口
        setTimeout(() => {
            vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => { /* 老版本不支持，静默忽略 */ });
        }, 100);
        panel.webview.html = SvnMergePanel._getProgressPanelHtml(opts.title, opts.dryRun);

        let disposed = false;
        panel.onDidDispose(() => { disposed = true; });
        const safePost = (msg: any) => {
            if (!disposed) {
                panel.webview.postMessage(msg);
            }
        };

        // 消息处理：ready 握手、关闭、打开提交面板
        let started = false;
        // 队列驱动状态：逐 revision 合并，遇冲突时暂停等待解决
        let queueResume: (() => void) | null = null;
        let queueAborted = false;
        let queueWaiting = false;

        const startMerge = async () => {
            if (started) return;
            started = true;
            safePost({ command: 'started' });

            // dryRun 保持一次性预览，不走队列
            if (opts.dryRun) {
                try {
                    const result = await opts.svnService.merge(opts.folderPath, opts.sourceUrl, {
                        revisionRange: opts.revisionRange || undefined,
                        dryRun: true,
                        onProgress: (line: string) => safePost({ command: 'progress', line })
                    });
                    safePost({ command: 'done', success: true, output: result, conflicts: [], dryRun: true });
                } catch (err: any) {
                    safePost({ command: 'done', success: false, output: err.message || String(err), conflicts: [], dryRun: true });
                }
                return;
            }

            // 解析 revision 列表：'r1,r2,r3' → ['1','2','3']；空串表示全量合并
            let revs: string[] = (opts.revisionRange || '')
                .split(',')
                .map(s => s.trim().replace(/^r/i, ''))
                .filter(Boolean);

            // 全量合并模式：先拿可合并 revision 列表，逐个处理以支持中途冲突恢复
            if (revs.length === 0) {
                try {
                    safePost({ command: 'progress', line: '[队列] 获取可合并 revision 列表...' });
                    const set = await opts.svnService.getEligibleRevisions(opts.folderPath, opts.sourceUrl);
                    revs = Array.from(set).sort((a, b) => a - b).map(r => String(r));
                    safePost({ command: 'progress', line: `[队列] 共 ${revs.length} 个可合并 revision` });
                } catch (err: any) {
                    safePost({ command: 'progress', line: `[队列] 获取 eligible revisions 失败: ${err.message || err}，退回为一次性全量合并` });
                    revs = [];
                }
                if (revs.length === 0) {
                    // 退化：一次性 svn merge。遇冲突后进入交互解决但不会继续后续 revision
                    try {
                        const result = await opts.svnService.merge(opts.folderPath, opts.sourceUrl, {
                            onProgress: (line: string) => safePost({ command: 'progress', line })
                        });
                        if (opts.onSuccess) { try { await opts.onSuccess(); } catch (e) { console.error(e); } }
                        const cl = await opts.svnService.getMergeConflicts(opts.folderPath);
                        safePost({
                            command: 'done', success: true, output: result,
                            conflicts: cl.map(c => ({ path: c.path, displayName: c.displayName, conflictType: c.conflictType }))
                        });
                    } catch (err: any) {
                        const cl = await opts.svnService.getMergeConflicts(opts.folderPath);
                        safePost({
                            command: 'done', success: false, output: err.message || String(err),
                            conflicts: cl.map(c => ({ path: c.path, displayName: c.displayName, conflictType: c.conflictType }))
                        });
                    }
                    return;
                }
            }

            safePost({ command: 'queueInfo', total: revs.length, revisions: revs });
            let aggregateOutput = '';

            for (let i = 0; i < revs.length; i++) {
                if (queueAborted) break;
                const rev = revs[i];
                safePost({ command: 'queueProgress', index: i, total: revs.length, currentRev: rev });
                safePost({ command: 'progress', line: `\n========== 合并 r${rev}  (${i + 1}/${revs.length}) ==========` });

                let mergeFailedHard = false;
                let mergeErrMsg = '';
                try {
                    const result = await opts.svnService.merge(opts.folderPath, opts.sourceUrl, {
                        revisionRange: rev,
                        onProgress: (line: string) => safePost({ command: 'progress', line })
                    });
                    aggregateOutput += result + '\n';
                } catch (err: any) {
                    mergeFailedHard = true;
                    mergeErrMsg = err.message || String(err);
                    safePost({ command: 'progress', line: `[警告] r${rev} 合并报错: ${mergeErrMsg}` });
                }

                // 检查冲突
                const cl = await opts.svnService.getMergeConflicts(opts.folderPath);
                if (cl.length > 0) {
                    queueWaiting = true;
                    safePost({
                        command: 'queuePaused',
                        index: i,
                        total: revs.length,
                        currentRev: rev,
                        conflicts: cl.map(c => ({ path: c.path, displayName: c.displayName, conflictType: c.conflictType }))
                    });
                    // 等待 resume：冲突全部解决后 refreshAndPostConflicts 会唯醒；或用户点 abortQueue
                    await new Promise<void>(resolve => { queueResume = resolve; });
                    queueResume = null;
                    queueWaiting = false;
                    if (queueAborted) break;
                } else if (mergeFailedHard) {
                    // 无冲突但 merge 硬错（网络、权限、URL 错误等）：停止队列
                    safePost({
                        command: 'done', success: false,
                        output: aggregateOutput + `\n合并 r${rev} 失败且未检测到冲突：${mergeErrMsg}`,
                        conflicts: []
                    });
                    return;
                }
            }

            if (queueAborted) {
                const remaining = await opts.svnService.getMergeConflicts(opts.folderPath);
                safePost({
                    command: 'done', success: false,
                    output: aggregateOutput + '\n用户已取消剩余合并。',
                    conflicts: remaining.map(c => ({ path: c.path, displayName: c.displayName, conflictType: c.conflictType }))
                });
                return;
            }

            // 所有 revision 完成
            if (opts.onSuccess) {
                try { await opts.onSuccess(); } catch (e) { console.error('合并后处理失败:', e); }
            }
            const finalConflicts = await opts.svnService.getMergeConflicts(opts.folderPath);
            safePost({
                command: 'done', success: true, output: aggregateOutput,
                conflicts: finalConflicts.map(c => ({ path: c.path, displayName: c.displayName, conflictType: c.conflictType }))
            });
        };

        // 把进度面板的 resolution(mine-full/theirs-full/working) 转换为 resolveConflicts 接受的 strategy
        const toBatchStrategy = (resolution: string): 'mine' | 'theirs' | 'working' => {
            if (resolution === 'mine-full') return 'mine';
            if (resolution === 'theirs-full') return 'theirs';
            return 'working';
        };

        const refreshAndPostConflicts = async (extra?: any) => {
            try {
                const cl = await opts.svnService.getMergeConflicts(opts.folderPath);
                safePost({
                    command: 'conflictsUpdated',
                    conflicts: cl.map((c: any) => ({
                        path: c.path,
                        displayName: c.displayName,
                        conflictType: c.conflictType
                    })),
                    queueWaiting,
                    ...(extra || {})
                });
                // 队列暂停中、剩余冲突为 0、存在唯醒函数 → 自动继续下一个 revision
                if (queueWaiting && cl.length === 0 && queueResume) {
                    safePost({ command: 'progress', line: '[队列] 冲突全部解决，继续下一个 revision...' });
                    const r = queueResume; queueResume = null;
                    r();
                }
            } catch (err: any) {
                safePost({ command: 'resolveError', error: err.message });
            }
        };

        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'ready') {
                // webview 脚本已就绪，开始执行
                startMerge();
            } else if (msg.command === 'close') {
                panel.dispose();
            } else if (msg.command === 'openCommitPanel') {
                vscode.commands.executeCommand('vscode-svn.uploadFolder',
                    vscode.Uri.file(opts.folderPath));
                panel.dispose();
            } else if (msg.command === 'resolveConflict') {
                const { filePath, resolution } = msg;
                try {
                    await opts.svnService.resolveMergeConflict(filePath, resolution);
                    await refreshAndPostConflicts({ resolvedFile: filePath });
                } catch (err: any) {
                    safePost({ command: 'resolveError', filePath, error: err.message });
                }
            } else if (msg.command === 'resolveAllConflicts') {
                const { resolution } = msg;
                try {
                    const cl = await opts.svnService.getMergeConflicts(opts.folderPath);
                    const filePaths = cl.map((c: any) => c.path);
                    if (filePaths.length === 0) {
                        safePost({ command: 'conflictsUpdated', conflicts: [], resolvedAll: true });
                        return;
                    }
                    await opts.svnService.resolveConflicts(
                        filePaths,
                        toBatchStrategy(resolution),
                        (currentFile: string, progress: number) => {
                            safePost({ command: 'resolveProgress', currentFile, progress });
                        }
                    );
                    await refreshAndPostConflicts({ resolvedAll: true });
                } catch (err: any) {
                    safePost({ command: 'resolveError', error: err.message });
                }
            } else if (msg.command === 'refreshConflicts') {
                await refreshAndPostConflicts({ refreshed: true });
            } else if (msg.command === 'openConflictFile') {
                const { filePath } = msg;
                try {
                    const uri = vscode.Uri.file(filePath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc, { preview: false });
                    vscode.window.showInformationMessage(
                        `已打开 ${path.basename(filePath)}，请手动去除冲突标记（<<<<<<< / ======= / >>>>>>>）并保存，然后点本项“标记已解决”即可。`
                    );
                } catch (err: any) {
                    safePost({ command: 'resolveError', filePath, error: `打开文件失败: ${err.message}` });
                }
            } else if (msg.command === 'openMergeEditor') {
                const { filePath } = msg;
                try {
                    const files = await opts.svnService.getMergeConflictFiles(filePath);
                    const baseUri = files.base ? vscode.Uri.file(files.base) : undefined;
                    const mineUri = files.mine ? vscode.Uri.file(files.mine) : undefined;
                    const theirsUri = files.theirs ? vscode.Uri.file(files.theirs) : undefined;
                    const outputUri = vscode.Uri.file(filePath);

                    if (baseUri && mineUri && theirsUri) {
                        // 尝试调用 VS Code Merge Editor（`_open.mergeEditor` 为内部命令，VS Code 1.69+ 可用）
                        try {
                            await vscode.commands.executeCommand('_open.mergeEditor', {
                                base: baseUri,
                                input1: { uri: mineUri, title: '本地（Mine）', description: '工作副本修改' },
                                input2: { uri: theirsUri, title: '合并方（Theirs）', description: '即将合入的版本' },
                                output: outputUri
                            });
                            vscode.window.showInformationMessage(
                                `已打开三向合并编辑器: ${path.basename(filePath)}。编辑完成后请保存输出文件，然后点本项“标记已解决”即可。`
                            );
                            return;
                        } catch (mergeErr: any) {
                            // Merge Editor 不可用：回退双窗口 diff + 打开主文件
                            try {
                                await vscode.commands.executeCommand(
                                    'vscode.diff',
                                    mineUri,
                                    theirsUri,
                                    `${path.basename(filePath)}: 本地 ↔ 合并方`,
                                    { preview: false }
                                );
                                const doc2 = await vscode.workspace.openTextDocument(outputUri);
                                await vscode.window.showTextDocument(doc2, { preview: false, viewColumn: vscode.ViewColumn.Beside });
                                vscode.window.showWarningMessage(
                                    `Merge Editor 不可用，已回退为双窗对比 + 手动编辑。原因: ${mergeErr.message || mergeErr}`
                                );
                                return;
                            } catch (diffErr: any) {
                                safePost({ command: 'resolveError', filePath, error: `打开三向合并失败: ${diffErr.message}` });
                                return;
                            }
                        }
                    }

                    // 临时文件不齐：退回手动编辑模式
                    const doc = await vscode.workspace.openTextDocument(outputUri);
                    await vscode.window.showTextDocument(doc, { preview: false });
                    vscode.window.showWarningMessage(
                        `未找全 base/mine/theirs 临时文件（可能为非文本冲突或临时文件已被清理），已退回为单文件编辑模式。请去除冲突标记后点“标记已解决”。`
                    );
                } catch (err: any) {
                    safePost({ command: 'resolveError', filePath, error: `打开三向合并失败: ${err.message}` });
                }
            } else if (msg.command === 'abortQueue') {
                // 用户主动取消剩余合并
                queueAborted = true;
                if (queueResume) {
                    const r = queueResume; queueResume = null;
                    r();
                }
            } else if (msg.command === 'continueQueue') {
                // 用户手动点“继续”：仅在冲突完全解决后生效
                try {
                    const cl = await opts.svnService.getMergeConflicts(opts.folderPath);
                    if (cl.length === 0 && queueResume) {
                        const r = queueResume; queueResume = null;
                        r();
                    } else if (cl.length > 0) {
                        safePost({ command: 'resolveError', error: `剩余 ${cl.length} 个冲突未解决，无法继续。` });
                    }
                } catch (err: any) {
                    safePost({ command: 'resolveError', error: err.message });
                }
            }
        });

        // 兆尼回退：如果 3 秒内 webview 未发送 ready（例如老版本缓存），也主动启动
        setTimeout(() => {
            if (!started && !disposed) {
                startMerge();
            }
        }, 3000);
    }

    private static _getNonce(): string {
        let text = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return text;
    }

    private static _getProgressPanelHtml(title: string, dryRun: boolean): string {
        const actionLabel = dryRun ? '预览' : '执行合并';
        const nonce = SvnMergePanel._getNonce();
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; margin: 0; }
h2 { margin: 0 0 12px 0; font-size: 16px; }
h3 { margin: 0; font-size: 14px; color: var(--vscode-errorForeground); }
.status { padding: 6px 10px; border-radius: 4px; margin-bottom: 10px; font-size: 13px; }
.status.running { background: var(--vscode-editorWarning-background, #3a3d41); }
.status.success { background: var(--vscode-testing-iconPassed, #388a34); color: white; }
.status.error { background: var(--vscode-errorForeground, #f48771); color: white; }
.output { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); padding: 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; max-height: 40vh; overflow-y: auto; min-height: 160px; }
.conflicts { margin-top: 12px; border: 1px solid var(--vscode-errorForeground); border-radius: 4px; padding: 10px; }
.conflicts-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.conflicts-batch { display: flex; gap: 6px; flex-wrap: wrap; }
.conflict-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
.conflict-item:last-child { border-bottom: none; }
.conflict-item.resolving { opacity: 0.6; }
.conflict-item.resolved { opacity: 0.4; text-decoration: line-through; }
.conflict-meta { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; flex: 1 1 auto; word-break: break-all; }
.conflict-type-tag { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 11px; margin-right: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.conflict-buttons { display: flex; gap: 4px; flex-wrap: wrap; }
.resolve-progress { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; padding: 4px 8px; background: var(--vscode-input-background); border-radius: 3px; }
.queue-bar { display: none; align-items: center; gap: 10px; padding: 6px 10px; margin-bottom: 8px; border-radius: 4px; background: var(--vscode-editorWidget-background, #2d2d30); border: 1px solid var(--vscode-panel-border); font-size: 12px; flex-wrap: wrap; }
.queue-bar.active { display: flex; }
.queue-bar.paused { border-color: var(--vscode-errorForeground); }
.queue-progress-text { flex: 1 1 auto; }
.queue-progress-track { flex: 1 1 200px; height: 6px; background: var(--vscode-input-background); border-radius: 3px; overflow: hidden; min-width: 120px; }
.queue-progress-fill { height: 100%; background: var(--vscode-progressBar-background, #0e70c0); transition: width 0.2s ease; width: 0%; }
.actions { margin-top: 12px; display: flex; gap: 8px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 2px; font-size: 12px; }
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head><body>
<h2>${title}</h2>
<div id="status" class="status running">正在${actionLabel}...</div>
<div id="queueBar" class="queue-bar">
  <span id="queueProgressText" class="queue-progress-text">准备中...</span>
  <div class="queue-progress-track"><div id="queueProgressFill" class="queue-progress-fill"></div></div>
  <button id="abortQueueBtn" class="secondary" style="display:none;">取消剩余合并</button>
</div>
<div id="output" class="output"></div>
<div id="conflicts" class="conflicts" style="display:none;">
  <div class="conflicts-header">
    <h3>冲突文件 (<span id="conflictCount">0</span>)</h3>
    <div class="conflicts-batch">
      <button id="resolveAllMineBtn" class="secondary">全部使用本地</button>
      <button id="resolveAllTheirsBtn" class="secondary">全部使用合并方</button>
      <button id="refreshConflictsBtn" class="secondary">重新检测</button>
    </div>
  </div>
  <div id="resolveProgress" class="resolve-progress" style="display:none;"></div>
  <div id="conflictList"></div>
</div>
<div id="actions" class="actions" style="display:none;">
  <button id="commitBtn" style="display:none;">打开提交面板</button>
  <button id="closeBtn" class="secondary">关闭</button>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const dryRun = ${dryRun ? 'true' : 'false'};
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const conflictsEl = document.getElementById('conflicts');
const conflictListEl = document.getElementById('conflictList');
const conflictCountEl = document.getElementById('conflictCount');
const resolveProgressEl = document.getElementById('resolveProgress');
const resolveAllMineBtn = document.getElementById('resolveAllMineBtn');
const resolveAllTheirsBtn = document.getElementById('resolveAllTheirsBtn');
const refreshConflictsBtn = document.getElementById('refreshConflictsBtn');
const queueBarEl = document.getElementById('queueBar');
const queueProgressTextEl = document.getElementById('queueProgressText');
const queueProgressFillEl = document.getElementById('queueProgressFill');
const abortQueueBtn = document.getElementById('abortQueueBtn');
let queueTotal = 0;
let queueDoneCount = 0;
let queuePaused = false;
const actionsEl = document.getElementById('actions');
const commitBtn = document.getElementById('commitBtn');
const closeBtn = document.getElementById('closeBtn');

function escapeHtml(s) { return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function typeLabel(t) { return t === 'tree' ? '树冲突' : t === 'property' ? '属性冲突' : '文本冲突'; }
function setBatchDisabled(disabled) {
  resolveAllMineBtn.disabled = disabled;
  resolveAllTheirsBtn.disabled = disabled;
  refreshConflictsBtn.disabled = disabled;
}

function renderConflicts(conflicts) {
  if (!conflicts || conflicts.length === 0) {
    conflictsEl.style.display = 'none';
    if (!dryRun) commitBtn.style.display = '';
    return;
  }
  conflictsEl.style.display = '';
  conflictCountEl.textContent = conflicts.length;
  conflictListEl.innerHTML = conflicts.map(c =>
    '<div class="conflict-item" data-path="' + escapeHtml(c.path) + '">' +
      '<div class="conflict-meta"><span class="conflict-type-tag">' + escapeHtml(typeLabel(c.conflictType)) + '</span>' + escapeHtml(c.displayName) + '</div>' +
      '<div class="conflict-buttons">' +
        '<button class="cf-merge-btn" title="打开三向合并编辑器手动修改冲突">编辑冲突</button>' +
        '<button class="cf-btn" data-action="working" title="将当前工作副本（已去除冲突标记）标记为已解决">标记已解决</button>' +
        '<button class="secondary cf-btn" data-action="mine-full" title="使用本地版本，完全放弃合入的修改">使用本地</button>' +
        '<button class="secondary cf-btn" data-action="theirs-full" title="使用合入版本，完全放弃本地修改">使用合并方</button>' +
      '</div>' +
    '</div>'
  ).join('');
  conflictListEl.querySelectorAll('.cf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.conflict-item');
      const filePath = item.getAttribute('data-path');
      const action = btn.getAttribute('data-action');
      item.querySelectorAll('.cf-btn').forEach(b => b.disabled = true);
      item.classList.add('resolving');
      vscode.postMessage({ command: 'resolveConflict', filePath: filePath, resolution: action });
    });
  });
  conflictListEl.querySelectorAll('.cf-merge-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.conflict-item');
      const filePath = item.getAttribute('data-path');
      vscode.postMessage({ command: 'openMergeEditor', filePath: filePath });
    });
  });
  commitBtn.style.display = 'none';
}

window.addEventListener('message', (event) => {
  const m = event.data;
  if (m.command === 'started') {
    outputEl.textContent = '';
  } else if (m.command === 'progress') {
    outputEl.textContent += m.line + '\\n';
    outputEl.scrollTop = outputEl.scrollHeight;
  } else if (m.command === 'queueInfo') {
    queueTotal = m.total || 0;
    queueDoneCount = 0;
    queuePaused = false;
    if (queueTotal > 1) {
      queueBarEl.classList.add('active');
      queueBarEl.classList.remove('paused');
      abortQueueBtn.style.display = '';
      queueProgressTextEl.textContent = '队列合并：共 ' + queueTotal + ' 个 revision';
      queueProgressFillEl.style.width = '0%';
    }
  } else if (m.command === 'queueProgress') {
    queueDoneCount = m.index || 0;
    queuePaused = false;
    queueBarEl.classList.remove('paused');
    if (queueTotal > 1) {
      queueBarEl.classList.add('active');
      abortQueueBtn.style.display = '';
      const pct = Math.round((queueDoneCount / queueTotal) * 100);
      queueProgressFillEl.style.width = pct + '%';
      queueProgressTextEl.textContent = '正在合并 r' + (m.currentRev || '?') + '  (' + (queueDoneCount + 1) + '/' + queueTotal + ')';
    }
  } else if (m.command === 'queuePaused') {
    queuePaused = true;
    queueBarEl.classList.add('active', 'paused');
    abortQueueBtn.style.display = '';
    queueProgressTextEl.textContent = '⏸ r' + (m.currentRev || '?') + ' 冲突待解决（' + (m.conflicts ? m.conflicts.length : 0) + ' 个）——解决完后会自动继续下一个 revision';
    // 同步渲染冲突列表，让用户可以逐项解决
    renderConflicts(m.conflicts || []);
    setBatchDisabled(false);
    resolveProgressEl.style.display = 'none';
  } else if (m.command === 'done') {
    if (m.success) {
      statusEl.className = 'status success';
      statusEl.textContent = m.dryRun ? '预览完成' : '合并完成';
    } else {
      statusEl.className = 'status error';
      statusEl.textContent = m.dryRun ? '预览失败' : '合并失败';
    }
    // 队列结束：隐藏进度条
    queueBarEl.classList.remove('active', 'paused');
    abortQueueBtn.style.display = 'none';
    if (m.output && !outputEl.textContent.trim()) {
      outputEl.textContent = m.output;
    }
    renderConflicts(m.conflicts);
    if ((!m.conflicts || m.conflicts.length === 0) && m.success && !m.dryRun) {
      commitBtn.style.display = '';
    }
    actionsEl.style.display = '';
  } else if (m.command === 'conflictsUpdated') {
    setBatchDisabled(false);
    resolveProgressEl.style.display = 'none';
    renderConflicts(m.conflicts);
    // 队列暂停中且冲突全部解决：提示即将继续
    if (queuePaused && (!m.conflicts || m.conflicts.length === 0)) {
      queuePaused = false;
      queueBarEl.classList.remove('paused');
      queueProgressTextEl.textContent = '冲突已解决，正在继续合并下一个 revision...';
    }
    if (!m.conflicts || m.conflicts.length === 0) {
      // 只有在队列已结束（queueBar 不再 active）时才切换为“完成”
      if (!queueBarEl.classList.contains('active')) {
        statusEl.className = 'status success';
        statusEl.textContent = '所有冲突已解决';
        if (!dryRun) commitBtn.style.display = '';
      }
    }
  } else if (m.command === 'resolveProgress') {
    resolveProgressEl.style.display = '';
    resolveProgressEl.textContent = '正在解决 (' + (m.progress || 0) + '%): ' + (m.currentFile || '');
  } else if (m.command === 'resolveError') {
    setBatchDisabled(false);
    resolveProgressEl.style.display = '';
    resolveProgressEl.textContent = '错误: ' + (m.error || '');
    if (m.filePath) {
      const item = conflictListEl.querySelector('[data-path="' + (m.filePath || '').replace(/"/g, '\\"') + '"]');
      if (item) {
        item.classList.remove('resolving');
        item.querySelectorAll('.cf-btn').forEach(b => b.disabled = false);
      }
    }
  }
});

resolveAllMineBtn.addEventListener('click', () => {
  setBatchDisabled(true);
  resolveProgressEl.style.display = '';
  resolveProgressEl.textContent = '正在批量解决...';
  vscode.postMessage({ command: 'resolveAllConflicts', resolution: 'mine-full' });
});
resolveAllTheirsBtn.addEventListener('click', () => {
  setBatchDisabled(true);
  resolveProgressEl.style.display = '';
  resolveProgressEl.textContent = '正在批量解决...';
  vscode.postMessage({ command: 'resolveAllConflicts', resolution: 'theirs-full' });
});
refreshConflictsBtn.addEventListener('click', () => {
  setBatchDisabled(true);
  resolveProgressEl.style.display = '';
  resolveProgressEl.textContent = '重新检测冲突...';
  vscode.postMessage({ command: 'refreshConflicts' });
});
abortQueueBtn.addEventListener('click', () => {
  if (!confirm('确定取消后续 revision 的合并吗？已合并的 revision 不会被回滚。')) return;
  abortQueueBtn.disabled = true;
  queueProgressTextEl.textContent = '正在取消剩余合并...';
  vscode.postMessage({ command: 'abortQueue' });
});

commitBtn.addEventListener('click', () => vscode.postMessage({ command: 'openCommitPanel' }));
closeBtn.addEventListener('click', () => vscode.postMessage({ command: 'close' }));

// 通知 extension webview 脚本已就绪，可以开始发送消息
vscode.postMessage({ command: 'ready' });
</script>
</body></html>`;
    }

    /**
     * 将合并结果保存为提交历史记录
     */
    private _saveMergeCommitLog(
        sourceUrl: string,
        revisionRange: string,
        revisionDetails?: Array<{ revision: number; message: string }>
    ): void {
        try {
            // 提取源分支简短名称（如 client/trunk 或 tags/7.0.99）
            const projectRoot = this._inferProjectRoot();
            let branchName = sourceUrl;
            if (sourceUrl.startsWith(projectRoot)) {
                branchName = sourceUrl.substring(projectRoot.length + 1); // 去掉前面的 projectRoot/
            }

            let commitMessage = '';

            if (revisionDetails && revisionDetails.length > 0) {
                // 有详细版本信息：格式化为带日志的合并记录
                const revNums = revisionDetails.map(d => d.revision).join(', ');
                commitMessage = `Merged revision(s) ${revNums} from ${branchName}:\n`;
                commitMessage += revisionDetails
                    .map(d => `${d.message}`)
                    .join('\n........\n');
            } else if (revisionRange) {
                // 有版本范围但无详细信息
                commitMessage = `Merged revision(s) ${revisionRange} from ${branchName}`;
            } else {
                // 全量合并
                commitMessage = `Merged all eligible revisions from ${branchName}`;
            }

            this.logStorage.addLog(commitMessage, this.folderPath);
        } catch (err) {
            // 保存失败不影响合并流程
            console.error('保存合并提交日志失败:', err);
        }
    }

    private async _handleGetConflicts(): Promise<void> {
        const conflicts = await this.svnService.getMergeConflicts(this.folderPath);
        this._panel.webview.postMessage({
            command: 'conflictList',
            conflicts: conflicts.map(c => ({
                path: c.path,
                displayName: c.displayName,
                conflictType: c.conflictType
            }))
        });
    }

    private async _handleResolveConflict(message: any): Promise<void> {
        const { filePath, resolution } = message;
        try {
            await this.svnService.resolveMergeConflict(filePath, resolution);
            vscode.window.showInformationMessage(`已解决冲突: ${path.basename(filePath)}`);
            await this._handleGetConflicts();
        } catch (err: any) {
            vscode.window.showErrorMessage(`解决冲突失败: ${err.message}`);
        }
    }

    private dispose(): void {
        SvnMergePanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }
}
