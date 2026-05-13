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
        const startMerge = async () => {
            if (started) return;
            started = true;
            try {
                safePost({ command: 'started' });
                const result = await opts.svnService.merge(opts.folderPath, opts.sourceUrl, {
                    revisionRange: opts.revisionRange || undefined,
                    dryRun: opts.dryRun,
                    onProgress: (line: string) => {
                        safePost({ command: 'progress', line });
                    }
                });

                let conflicts: any[] = [];
                if (opts.onSuccess) {
                    try {
                        const conflictList = await opts.onSuccess();
                        if (Array.isArray(conflictList)) {
                            conflicts = conflictList.map((c: any) => ({
                                path: c.path,
                                displayName: c.displayName,
                                conflictType: c.conflictType
                            }));
                        }
                    } catch (e) {
                        console.error('合并后处理失败:', e);
                    }
                }

                safePost({
                    command: 'done',
                    success: true,
                    output: result,
                    conflicts,
                    dryRun: opts.dryRun
                });
            } catch (err: any) {
                let conflicts: any[] = [];
                if (!opts.dryRun) {
                    try {
                        const cl = await opts.svnService.getMergeConflicts(opts.folderPath);
                        conflicts = cl.map((c: any) => ({
                            path: c.path,
                            displayName: c.displayName,
                            conflictType: c.conflictType
                        }));
                    } catch {}
                }
                safePost({
                    command: 'done',
                    success: false,
                    output: err.message || String(err),
                    conflicts,
                    dryRun: opts.dryRun
                });
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
.status { padding: 6px 10px; border-radius: 4px; margin-bottom: 10px; font-size: 13px; }
.status.running { background: var(--vscode-editorWarning-background, #3a3d41); }
.status.success { background: var(--vscode-testing-iconPassed, #388a34); color: white; }
.status.error { background: var(--vscode-errorForeground, #f48771); color: white; }
.output { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); padding: 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; max-height: 60vh; overflow-y: auto; min-height: 200px; }
.conflicts { margin-top: 12px; border: 1px solid var(--vscode-errorForeground); border-radius: 4px; padding: 10px; }
.conflicts h3 { margin: 0 0 8px 0; font-size: 14px; color: var(--vscode-errorForeground); }
.conflict-item { padding: 4px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.actions { margin-top: 12px; display: flex; gap: 8px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; cursor: pointer; border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
</head><body>
<h2>${title}</h2>
<div id="status" class="status running">正在${actionLabel}...</div>
<div id="output" class="output"></div>
<div id="conflicts" class="conflicts" style="display:none;">
  <h3>冲突文件 <span id="conflictCount">0</span></h3>
  <div id="conflictList"></div>
</div>
<div id="actions" class="actions" style="display:none;">
  <button id="commitBtn" style="display:none;">打开提交面板</button>
  <button id="closeBtn" class="secondary">关闭</button>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const conflictsEl = document.getElementById('conflicts');
const conflictListEl = document.getElementById('conflictList');
const conflictCountEl = document.getElementById('conflictCount');
const actionsEl = document.getElementById('actions');
const commitBtn = document.getElementById('commitBtn');
const closeBtn = document.getElementById('closeBtn');

function escapeHtml(s) { return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

window.addEventListener('message', (event) => {
  const m = event.data;
  if (m.command === 'started') {
    outputEl.textContent = '';
  } else if (m.command === 'progress') {
    outputEl.textContent += m.line + '\\n';
    outputEl.scrollTop = outputEl.scrollHeight;
  } else if (m.command === 'done') {
    if (m.success) {
      statusEl.className = 'status success';
      statusEl.textContent = m.dryRun ? '预览完成' : '合并完成';
    } else {
      statusEl.className = 'status error';
      statusEl.textContent = m.dryRun ? '预览失败' : '合并失败';
    }
    if (m.output && !outputEl.textContent.trim()) {
      outputEl.textContent = m.output;
    }
    if (m.conflicts && m.conflicts.length > 0) {
      conflictsEl.style.display = '';
      conflictCountEl.textContent = m.conflicts.length;
      conflictListEl.innerHTML = m.conflicts.map(c =>
        '<div class="conflict-item">[' + escapeHtml(c.conflictType) + '] ' + escapeHtml(c.displayName) + '</div>'
      ).join('');
      commitBtn.style.display = '';
    } else if (m.success && !m.dryRun) {
      commitBtn.style.display = '';
    }
    actionsEl.style.display = '';
  }
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
