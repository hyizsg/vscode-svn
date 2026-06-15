import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SvnService } from './svnService';

/**
 * SVN更新面板
 */
export class SvnUpdatePanel {
  public static currentPanel: SvnUpdatePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly fsPath: string;
  private readonly svnService: SvnService;
  private disposables: vscode.Disposable[] = [];
  private updateOutput: string = '';
  private isUpdating: boolean = false;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    fsPath: string,
    svnService: SvnService
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.fsPath = fsPath;
    this.svnService = svnService;

    // 设置WebView内容
    this.update();

    // 当面板关闭时清理资源
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // 处理来自WebView的消息
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'startUpdate':
            await this.startUpdate();
            return;
          case 'close':
            this.panel.dispose();
            return;
          case 'resolveConflict':
            await this.handleResolveConflict(message.filePath, message.resolution);
            return;
          case 'resolveAllConflicts':
            await this.handleResolveAllConflicts(message.resolution);
            return;
          case 'refreshConflicts':
            await this.refreshAndPostConflicts({ refreshed: true });
            return;
          case 'openMergeEditor':
            await this.handleOpenMergeEditor(message.filePath);
            return;
          case 'openCommitPanel':
            vscode.commands.executeCommand('vscode-svn.uploadFolder', vscode.Uri.file(this.getStatusBaseDir()));
            this.panel.dispose();
            return;
        }
      },
      null,
      this.disposables
    );
  }

  /**
   * 冲突扫描的基准目录：如果 fsPath 是文件就取父目录
   */
  private getStatusBaseDir(): string {
    try {
      return fs.statSync(this.fsPath).isDirectory() ? this.fsPath : path.dirname(this.fsPath);
    } catch {
      return this.fsPath;
    }
  }

  /**
   * 重新扫描冲突并推送到 webview
   */
  private async refreshAndPostConflicts(extra?: any): Promise<void> {
    try {
      const baseDir = this.getStatusBaseDir();
      const list = await this.svnService.getMergeConflicts(baseDir);
      this.panel.webview.postMessage({
        command: 'conflictsUpdated',
        conflicts: list.map(c => ({ path: c.path, displayName: c.displayName, conflictType: c.conflictType })),
        ...(extra || {})
      });
    } catch (err: any) {
      this.panel.webview.postMessage({ command: 'resolveError', error: err.message });
    }
  }

  private toBatchStrategy(resolution: string): 'mine' | 'theirs' | 'working' {
    if (resolution === 'mine-full') return 'mine';
    if (resolution === 'theirs-full') return 'theirs';
    return 'working';
  }

  private async handleResolveConflict(filePath: string, resolution: 'working' | 'mine-full' | 'theirs-full'): Promise<void> {
    try {
      await this.svnService.resolveMergeConflict(filePath, resolution);
      await this.refreshAndPostConflicts({ resolvedFile: filePath });
    } catch (err: any) {
      this.panel.webview.postMessage({ command: 'resolveError', filePath, error: err.message });
    }
  }

  private async handleResolveAllConflicts(resolution: string): Promise<void> {
    try {
      const baseDir = this.getStatusBaseDir();
      const list = await this.svnService.getMergeConflicts(baseDir);
      const filePaths = list.map(c => c.path);
      if (filePaths.length === 0) {
        this.panel.webview.postMessage({ command: 'conflictsUpdated', conflicts: [], resolvedAll: true });
        return;
      }
      await this.svnService.resolveConflicts(
        filePaths,
        this.toBatchStrategy(resolution),
        (currentFile: string, progress: number) => {
          this.panel.webview.postMessage({ command: 'resolveProgress', currentFile, progress });
        }
      );
      await this.refreshAndPostConflicts({ resolvedAll: true });
    } catch (err: any) {
      this.panel.webview.postMessage({ command: 'resolveError', error: err.message });
    }
  }

  private async handleOpenMergeEditor(filePath: string): Promise<void> {
    try {
      const files = await this.svnService.getMergeConflictFiles(filePath);
      const baseUri = files.base ? vscode.Uri.file(files.base) : undefined;
      const mineUri = files.mine ? vscode.Uri.file(files.mine) : undefined;
      const theirsUri = files.theirs ? vscode.Uri.file(files.theirs) : undefined;
      const outputUri = vscode.Uri.file(filePath);

      if (baseUri && mineUri && theirsUri) {
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
          try {
            await vscode.commands.executeCommand(
              'vscode.diff', mineUri, theirsUri,
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
            this.panel.webview.postMessage({ command: 'resolveError', filePath, error: `打开三向合并失败: ${diffErr.message}` });
            return;
          }
        }
      }
      // 临时文件不齐：退回手动编辑模式
      const doc = await vscode.workspace.openTextDocument(outputUri);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showWarningMessage(
        `未找全 base/mine/theirs 临时文件，已退回为单文件编辑模式。请去除冲突标记后点“标记已解决”。`
      );
    } catch (err: any) {
      this.panel.webview.postMessage({ command: 'resolveError', filePath, error: `打开三向合并失败: ${err.message}` });
    }
  }

  /**
   * 创建或显示更新面板
   */
  public static async createOrShow(
    extensionUri: vscode.Uri,
    fsPath: string,
    svnService: SvnService
  ): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // 如果已经有面板，则显示它
    if (SvnUpdatePanel.currentPanel) {
      SvnUpdatePanel.currentPanel.panel.reveal(undefined, true);
      return;
    }

    // 否则，创建一个新面板
    const panel = vscode.window.createWebviewPanel(
      'svnUpdate',
      `SVN更新: ${path.basename(fsPath)}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true
      }
    );

    // 将 webview 面板移到独立的悬浮窗口
    setTimeout(() => {
      vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => { /* 老版本不支持，静默忽略 */ });
    }, 100);

    SvnUpdatePanel.currentPanel = new SvnUpdatePanel(
      panel,
      extensionUri,
      fsPath,
      svnService
    );

    // 自动开始更新
    await SvnUpdatePanel.currentPanel.startUpdate();
  }

  /**
   * 开始更新
   */
  private async startUpdate() {
    if (this.isUpdating) {
      return;
    }

    this.isUpdating = true;
    this.updateOutput = '';
    // 通知 webview 更新开始
    this.panel.webview.postMessage({ command: 'updateStart' });

    // 挂载实时输出回调
    this.svnService.onCommandOutput = (data: string) => {
      const formatted = this.formatUpdateLine(data);
      this.updateOutput += formatted;
      this.panel.webview.postMessage({ command: 'appendOutput', text: formatted });
    };

    try {
      // 执行SVN更新命令
      const updateResult = await this.svnService.executeSvnCommand('update', this.fsPath);
      
      // 如果实时回调没有捕获到内容（某些情况下 stdout 可能为空），用最终结果补充
      if (!this.updateOutput && updateResult) {
        const formatted = this.formatUpdateOutput(updateResult);
        this.updateOutput = formatted;
        this.panel.webview.postMessage({ command: 'appendOutput', text: formatted });
      }
      
      // 通知完成
      this.panel.webview.postMessage({ command: 'updateComplete', success: true });
      vscode.window.showInformationMessage(`SVN更新完成`);
      // 扫描冲突
      await this.refreshAndPostConflicts();
    } catch (error: any) {
      const errMsg = `更新失败: ${error.message}\n`;
      this.updateOutput += errMsg;
      this.panel.webview.postMessage({ command: 'appendOutput', text: errMsg });
      this.panel.webview.postMessage({ command: 'updateComplete', success: false });
      vscode.window.showErrorMessage(`SVN更新失败: ${error.message}`);
      // 即使失败也可能有部分冲突产生，尝试扫描
      await this.refreshAndPostConflicts();
    } finally {
      this.isUpdating = false;
      this.svnService.onCommandOutput = undefined;
    }
  }

  /**
   * 格式化单行实时输出
   */
  private formatUpdateLine(data: string): string {
    let result = '';
    const lines = data.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^[A-Z]\s+/.test(trimmed)) {
        const action = trimmed.charAt(0);
        const filePath = trimmed.substring(1).trim();
        let actionText = '';
        switch (action) {
          case 'A': actionText = '添加'; break;
          case 'D': actionText = '删除'; break;
          case 'U': actionText = '更新'; break;
          case 'C': actionText = '冲突'; break;
          case 'G': actionText = '合并'; break;
          case 'E': actionText = '已存在'; break;
          case 'R': actionText = '替换'; break;
          default: actionText = action;
        }
        result += `[${actionText}] ${filePath}\n`;
      } else {
        result += `${trimmed}\n`;
      }
    }
    return result;
  }

  /**
   * 格式化更新输出
   */
  private formatUpdateOutput(output: string): string {
    // 如果输出为空，返回默认消息
    if (!output || output.trim() === '') {
      return '更新完成，没有文件被更新。';
    }

    // 处理输出
    let formattedOutput = '更新结果:\n\n';
    
    // 按行分割输出
    const lines = output.split('\n');
    
    // 处理每一行
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine === '') {
        continue;
      }
      
      // 检查是否是更新行（通常以字母+空格开头，如"A "、"U "等）
      if (/^[A-Z]\s+/.test(trimmedLine)) {
        const action = trimmedLine.charAt(0);
        const filePath = trimmedLine.substring(1).trim();
        
        let actionText = '';
        switch (action) {
          case 'A': actionText = '添加'; break;
          case 'D': actionText = '删除'; break;
          case 'U': actionText = '更新'; break;
          case 'C': actionText = '冲突'; break;
          case 'G': actionText = '合并'; break;
          case 'E': actionText = '已存在'; break;
          case 'R': actionText = '替换'; break;
          default: actionText = action;
        }
        
        formattedOutput += `[${actionText}] ${filePath}\n`;
      } else {
        // 其他行直接添加
        formattedOutput += `${trimmedLine}\n`;
      }
    }
    
    return formattedOutput;
  }

  /**
   * 更新WebView内容
   */
  private update() {
    this.panel.title = `SVN更新: ${path.basename(this.fsPath)}`;
    this.updateWebview();
  }

  /**
   * 更新WebView内容
   */
  private updateWebview() {
    const webview = this.panel.webview;
    webview.html = this.getHtmlForWebview();
  }

  /**
   * 获取WebView的HTML内容
   */
  private getHtmlForWebview(): string {
    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SVN更新</title>
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
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        h2 {
          margin-top: 0;
          color: var(--vscode-foreground);
        }
        .file-info {
          margin-bottom: 10px;
          color: var(--vscode-descriptionForeground);
        }
        .conflicts {
          margin: 10px 0;
          border: 1px solid var(--vscode-errorForeground);
          border-radius: 4px;
          padding: 10px;
          flex-shrink: 0;
          max-height: 40vh;
          overflow-y: auto;
        }
        .conflicts-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 10px;
          flex-wrap: wrap;
        }
        .conflicts-header h3 {
          margin: 0;
          font-size: 14px;
          color: var(--vscode-errorForeground);
        }
        .conflicts-batch { display: flex; gap: 6px; flex-wrap: wrap; }
        .conflict-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 6px 8px;
          border-bottom: 1px solid var(--vscode-panel-border);
          flex-wrap: wrap;
        }
        .conflict-item:last-child { border-bottom: none; }
        .conflict-item.resolving { opacity: 0.6; }
        .conflict-meta {
          font-family: monospace;
          font-size: 12px;
          flex: 1 1 auto;
          word-break: break-all;
        }
        .conflict-type-tag {
          display: inline-block;
          padding: 1px 6px;
          border-radius: 8px;
          font-size: 11px;
          margin-right: 6px;
          background: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground);
        }
        .conflict-buttons { display: flex; gap: 4px; flex-wrap: wrap; }
        .conflict-buttons button {
          min-width: auto;
          height: auto;
          padding: 4px 10px;
          font-size: 12px;
        }
        button.secondary {
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover:not(:disabled) {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        .resolve-progress {
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
          margin-bottom: 8px;
          padding: 4px 8px;
          background: var(--vscode-input-background);
          border-radius: 3px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>SVN更新</h2>
        <div class="file-info">${this.fsPath}</div>
        <div class="output-container" id="outputContainer">${this.updateOutput || ''}</div>

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

        <div class="button-container">
          <button id="commit-button" style="display:none;">打开提交面板</button>
          <button id="update-button" class="update-button" ${this.isUpdating ? 'disabled' : ''}>
            ${this.isUpdating ? '正在更新...' : '重新更新'}
          </button>
          <button id="close-button">关闭</button>
        </div>
      </div>

      <script>
        (function() {
          const vscode = acquireVsCodeApi();
          const outputContainer = document.getElementById('outputContainer');
          const updateButton = document.getElementById('update-button');
          const closeButton = document.getElementById('close-button');
          const commitButton = document.getElementById('commit-button');
          const conflictsEl = document.getElementById('conflicts');
          const conflictListEl = document.getElementById('conflictList');
          const conflictCountEl = document.getElementById('conflictCount');
          const resolveProgressEl = document.getElementById('resolveProgress');
          const resolveAllMineBtn = document.getElementById('resolveAllMineBtn');
          const resolveAllTheirsBtn = document.getElementById('resolveAllTheirsBtn');
          const refreshConflictsBtn = document.getElementById('refreshConflictsBtn');

          function escapeHtml(s) {
            return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
          }
          function typeLabel(t) {
            return t === 'tree' ? '树冲突' : t === 'property' ? '属性冲突' : '文本冲突';
          }
          function setBatchDisabled(disabled) {
            resolveAllMineBtn.disabled = disabled;
            resolveAllTheirsBtn.disabled = disabled;
            refreshConflictsBtn.disabled = disabled;
          }
          function renderConflicts(conflicts) {
            if (!conflicts || conflicts.length === 0) {
              conflictsEl.style.display = 'none';
              commitButton.style.display = '';
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
            commitButton.style.display = 'none';
          }

          // 更新按钮点击事件
          updateButton.addEventListener('click', () => {
            updateButton.disabled = true;
            updateButton.textContent = '正在更新...';
            vscode.postMessage({ command: 'startUpdate' });
          });
          // 关闭按钮点击事件
          closeButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'close' });
          });
          // 提交按钮点击事件
          commitButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'openCommitPanel' });
          });
          // 批量解决 / 重新检测
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

          // 监听来自扩展的消息
          window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
              case 'updateStart':
                outputContainer.textContent = '';
                updateButton.disabled = true;
                updateButton.textContent = '正在更新...';
                conflictsEl.style.display = 'none';
                commitButton.style.display = 'none';
                break;
              case 'appendOutput':
                outputContainer.textContent += msg.text;
                outputContainer.scrollTop = outputContainer.scrollHeight;
                break;
              case 'updateComplete':
                updateButton.disabled = false;
                updateButton.textContent = '重新更新';
                break;
              case 'conflictsUpdated':
                setBatchDisabled(false);
                resolveProgressEl.style.display = 'none';
                renderConflicts(msg.conflicts);
                break;
              case 'resolveProgress':
                resolveProgressEl.style.display = '';
                resolveProgressEl.textContent = '正在解决 (' + (msg.progress || 0) + '%): ' + (msg.currentFile || '');
                break;
              case 'resolveError':
                setBatchDisabled(false);
                resolveProgressEl.style.display = '';
                resolveProgressEl.textContent = '错误: ' + (msg.error || '');
                if (msg.filePath) {
                  const item = conflictListEl.querySelector('[data-path="' + (msg.filePath || '').replace(/"/g, '\\"') + '"]');
                  if (item) {
                    item.classList.remove('resolving');
                    item.querySelectorAll('.cf-btn').forEach(b => b.disabled = false);
                  }
                }
                break;
            }
          });
        }());
      </script>
    </body>
    </html>`;
  }

  /**
   * 释放资源
   */
  private dispose() {
    SvnUpdatePanel.currentPanel = undefined;

    // 清理资源
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
} 