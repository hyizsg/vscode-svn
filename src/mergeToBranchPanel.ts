import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SvnService } from './svnService';

const STATE_KEY_LAST_TARGET = 'mergeToBranch.lastTargetPath';

/**
 * 合并到其他分支面板
 * 流程：当前工作副本（如 trunk） → 选择本地已 checkout 的目标分支工作副本（如 branch）
 *      → 列出未合并版本 → 选择若干版本 → 在目标副本里执行 svn merge -c rev1,rev2,...
 *      → 检测冲突（有则提示用户解决）→ 自动 svn commit
 */
export class MergeToBranchPanel {
    public static currentPanel: MergeToBranchPanel | undefined;
    public static readonly viewType = 'svnMergeToBranch';

    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private readonly svnService: SvnService;
    private readonly sourcePath: string;
    private sourceUrl: string = '';
    private targetPath: string = '';
    private disposables: vscode.Disposable[] = [];

    public static createOrShow(context: vscode.ExtensionContext, svnService: SvnService, sourcePath: string) {
        const column = vscode.ViewColumn.One;
        if (MergeToBranchPanel.currentPanel) {
            MergeToBranchPanel.currentPanel.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            MergeToBranchPanel.viewType,
            '合并到其他分支',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        MergeToBranchPanel.currentPanel = new MergeToBranchPanel(panel, context, svnService, sourcePath);
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, svnService: SvnService, sourcePath: string) {
        this.panel = panel;
        this.context = context;
        this.svnService = svnService;
        this.sourcePath = (() => {
            try { return fs.statSync(sourcePath).isDirectory() ? sourcePath : path.dirname(sourcePath); }
            catch { return sourcePath; }
        })();

        this.panel.webview.html = this.getHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                switch (msg.command) {
                    case 'ready': await this.handleReady(); return;
                    case 'browseTarget': await this.handleBrowseTarget(); return;
                    case 'useLastTarget': await this.handleUseLastTarget(msg.targetPath); return;
                    case 'loadEligible': await this.handleLoadEligible(msg.targetPath); return;
                    case 'startMerge': await this.handleStartMerge(msg.targetPath, msg.revs as number[], msg.message); return;
                    case 'resolveConflict': await this.handleResolveConflict(msg.filePath, msg.resolution); return;
                    case 'resolveAll': await this.handleResolveAll(msg.resolution); return;
                    case 'openMergeEditor': await this.handleOpenMergeEditor(msg.filePath); return;
                    case 'refreshConflicts': await this.refreshAndPostConflicts(); return;
                    case 'finalCommit': await this.handleFinalCommit(msg.message); return;
                    case 'close': this.panel.dispose(); return;
                }
            } catch (err: any) {
                this.post({ command: 'error', message: err?.message || String(err) });
            }
        }, null, this.disposables);

        setTimeout(() => {
            vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => {});
        }, 100);
    }

    public dispose() {
        MergeToBranchPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) { try { this.disposables.pop()?.dispose(); } catch { /* ignore */ } }
    }

    private post(msg: any) { try { this.panel.webview.postMessage(msg); } catch { /* ignore */ } }

    private async handleReady() {
        try {
            this.sourceUrl = await this.svnService.getWorkingCopyUrl(this.sourcePath);
        } catch (err: any) {
            this.post({ command: 'error', message: `读取当前分支 URL 失败：${err.message}` });
            return;
        }
        const lastTarget = this.context.globalState.get<string>(STATE_KEY_LAST_TARGET, '');
        let lastTargetValid: { path: string; url: string } | undefined;
        if (lastTarget) {
            try {
                if (fs.existsSync(lastTarget)) {
                    const url = await this.svnService.getWorkingCopyUrl(lastTarget);
                    if (url && url !== this.sourceUrl) {
                        lastTargetValid = { path: lastTarget, url };
                    }
                }
            } catch { /* ignore */ }
        }
        this.post({
            command: 'init',
            sourcePath: this.sourcePath,
            sourceUrl: this.sourceUrl,
            lastTarget: lastTargetValid
        });
    }

    private async handleBrowseTarget() {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            openLabel: '选择目标分支工作副本（已 checkout）',
            title: '选择目标分支工作副本'
        });
        if (!picked || picked.length === 0) return;
        const dir = picked[0].fsPath;
        let url = '';
        try { url = await this.svnService.getWorkingCopyUrl(dir); }
        catch { this.post({ command: 'browseTargetResult', ok: false, error: '该目录不是 SVN 工作副本' }); return; }
        if (this.sourceUrl && url === this.sourceUrl) {
            this.post({ command: 'browseTargetResult', ok: false, error: '目标分支与当前分支相同，无需合并' });
            return;
        }
        this.targetPath = dir;
        await this.context.globalState.update(STATE_KEY_LAST_TARGET, dir);
        this.post({ command: 'browseTargetResult', ok: true, targetPath: dir, targetUrl: url });
    }

    private async handleUseLastTarget(p: string) {
        if (!p || !fs.existsSync(p)) {
            this.post({ command: 'browseTargetResult', ok: false, error: '上次记录的路径已不存在' });
            return;
        }
        try {
            const url = await this.svnService.getWorkingCopyUrl(p);
            if (this.sourceUrl && url === this.sourceUrl) {
                this.post({ command: 'browseTargetResult', ok: false, error: '目标分支与当前分支相同' });
                return;
            }
            this.targetPath = p;
            this.post({ command: 'browseTargetResult', ok: true, targetPath: p, targetUrl: url });
        } catch (err: any) {
            this.post({ command: 'browseTargetResult', ok: false, error: err.message });
        }
    }

    private async handleLoadEligible(targetPath: string) {
        if (!targetPath) { this.post({ command: 'eligibleRevs', ok: false, error: '请先选择目标分支工作副本' }); return; }
        if (!this.sourceUrl) {
            try { this.sourceUrl = await this.svnService.getWorkingCopyUrl(this.sourcePath); }
            catch (e: any) { this.post({ command: 'eligibleRevs', ok: false, error: e.message }); return; }
        }
        try {
            // 并行获取：全量日志、已合并、未合并 【对齐 mergePanel】
            const [logEntries, mergedRevs, eligibleRevs] = await Promise.all([
                this.svnService.getLogEntries(this.sourceUrl, this.sourcePath, 1000),
                this.svnService.getMergedRevisions(targetPath, this.sourceUrl),
                this.svnService.getEligibleRevisions(targetPath, this.sourceUrl)
            ]);
            // 过滤：只保留 eligible 或 merged 的版本（排除分支创建点之前的不相关版本）
            const revs = logEntries
                .filter(e => eligibleRevs.has(e.revision) || mergedRevs.has(e.revision))
                .map(e => ({
                    revision: e.revision,
                    author: e.author,
                    date: e.date,
                    message: e.message,
                    merged: mergedRevs.has(e.revision),
                    eligible: eligibleRevs.has(e.revision)
                }));
            this.post({ command: 'eligibleRevs', ok: true, revs, sourceUrl: this.sourceUrl });
        } catch (err: any) {
            this.post({ command: 'eligibleRevs', ok: false, error: err.message });
        }
    }

    private async handleStartMerge(targetPath: string, revs: number[], message: string) {
        if (!targetPath) { this.post({ command: 'error', message: '请选择目标分支工作副本' }); return; }
        if (!revs || revs.length === 0) { this.post({ command: 'error', message: '请勾选至少一个版本' }); return; }
        if (!this.sourceUrl) {
            try { this.sourceUrl = await this.svnService.getWorkingCopyUrl(this.sourcePath); } catch { /* ignore */ }
        }
        this.targetPath = targetPath;
        await this.context.globalState.update(STATE_KEY_LAST_TARGET, targetPath);

        const range = revs.join(',');
        this.post({ command: 'phase', phase: 'merging' });
        this.post({ command: 'progress', text: `开始合并 ${revs.length} 个版本到 ${targetPath}\n源 URL: ${this.sourceUrl}\n` });

        try {
            await this.svnService.merge(targetPath, this.sourceUrl, {
                revisionRange: range,
                onProgress: (line) => this.post({ command: 'progress', text: line })
            });
        } catch (err: any) {
            this.post({ command: 'progress', text: `\n❌ 合并失败：${err.message}\n` });
            this.post({ command: 'phase', phase: 'error' });
            return;
        }

        await this.refreshAndPostConflicts();
        this.post({ command: 'mergeFinished', defaultMessage: this.buildDefaultMessage(revs, message) });
    }

    private buildDefaultMessage(revs: number[], userMessage: string): string {
        if (userMessage && userMessage.trim()) return userMessage;
        return `Merged from ${this.sourceUrl} r${revs.join(',r')}`;
    }

    private async refreshAndPostConflicts() {
        if (!this.targetPath) return;
        try {
            const list = await this.svnService.getMergeConflicts(this.targetPath);
            this.post({
                command: 'conflicts',
                items: list.map(c => ({ path: c.path, displayName: c.displayName, conflictType: c.conflictType }))
            });
        } catch (err: any) {
            this.post({ command: 'progress', text: `[冲突列表获取失败] ${err.message}\n` });
        }
    }

    private async handleResolveConflict(filePath: string, resolution: string) {
        try {
            await this.svnService.resolveMergeConflict(filePath, resolution as any);
            await this.refreshAndPostConflicts();
        } catch (err: any) { this.post({ command: 'error', message: err.message }); }
    }

    private async handleResolveAll(resolution: string) {
        try {
            const list = await this.svnService.getMergeConflicts(this.targetPath);
            const paths = list.map(c => c.path);
            if (paths.length === 0) { await this.refreshAndPostConflicts(); return; }
            const strategy: 'mine' | 'theirs' | 'working' =
                (resolution === 'mine-full') ? 'mine' :
                (resolution === 'theirs-full') ? 'theirs' : 'working';
            await this.svnService.resolveConflicts(paths, strategy);
            await this.refreshAndPostConflicts();
        } catch (err: any) { this.post({ command: 'error', message: err.message }); }
    }

    private async handleOpenMergeEditor(filePath: string) {
        try {
            const baseUri = vscode.Uri.file(`${filePath}.merge-left.r0`).with({ scheme: 'svn-merge-empty', query: 'BASE' });
            const mineUri = vscode.Uri.file(`${filePath}.mine`);
            const theirsUri = vscode.Uri.file(`${filePath}.r0`);
            const resultUri = vscode.Uri.file(filePath);
            try {
                await vscode.commands.executeCommand('_open.mergeEditor', { base: baseUri, input1: { uri: mineUri, title: '本地' }, input2: { uri: theirsUri, title: '合并方' }, output: resultUri });
                return;
            } catch { /* fallback */ }
            try { await vscode.commands.executeCommand('vscode.diff', mineUri, theirsUri, '本地 ↔ 合并方'); return; } catch { /* fallback */ }
            const doc = await vscode.workspace.openTextDocument(resultUri);
            await vscode.window.showTextDocument(doc);
        } catch (err: any) {
            this.post({ command: 'error', message: `无法打开合并编辑器：${err.message}` });
        }
    }

    private async handleFinalCommit(message: string) {
        if (!this.targetPath) return;
        try {
            const left = await this.svnService.getMergeConflicts(this.targetPath);
            if (left.length > 0) {
                this.post({ command: 'error', message: `还有 ${left.length} 个文件冲突未解决，无法提交` });
                return;
            }
        } catch { /* ignore */ }

        if (!message || !message.trim()) { this.post({ command: 'error', message: '请填写提交日志' }); return; }

        this.post({ command: 'phase', phase: 'committing' });
        this.post({ command: 'progress', text: `\n开始提交到 ${this.targetPath}\n` });
        try {
            await this.svnService.commit(this.targetPath, message);
            this.post({ command: 'progress', text: `✅ 提交成功\n` });
            this.post({ command: 'phase', phase: 'done' });
            vscode.window.showInformationMessage(`已合并并提交到 ${path.basename(this.targetPath)}`);
        } catch (err: any) {
            this.post({ command: 'progress', text: `❌ 提交失败：${err.message}\n` });
            this.post({ command: 'phase', phase: 'error' });
        }
    }

    private getHtml(): string {
        const nonce = String(Date.now());
        return /* html */ `<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8"><title>合并到其他分支</title>
<style>
:root{--bd:var(--vscode-panel-border,#333);--bg:var(--vscode-editor-background);--fg:var(--vscode-editor-foreground);--muted:var(--vscode-descriptionForeground,#888);--row-hover:var(--vscode-list-hoverBackground,rgba(255,255,255,.06));--row-sel:var(--vscode-list-activeSelectionBackground,rgba(0,122,204,.2));}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--fg);background:var(--bg);margin:0;padding:14px;}
h2{margin:0 0 12px;font-size:16px}
h3{margin:0 0 10px;font-size:14px}
.section{border:1px solid var(--bd);border-radius:4px;padding:12px 14px;margin:0 0 14px;background-color:var(--vscode-editor-inactiveSelectionBackground,rgba(255,255,255,.02));}
.row{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}
.row label{flex:0 0 auto;color:var(--muted);min-width:90px}
.row input[type=text],.row textarea,.text-input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--bd);padding:4px 6px;border-radius:2px;font-family:inherit;font-size:13px;}
textarea{min-height:60px;resize:vertical}
button,.btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 12px;border-radius:2px;cursor:pointer;font-size:13px}
button.secondary,.btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button:disabled{opacity:.5;cursor:not-allowed}
.path-readonly{flex:1;padding:4px 6px;border:1px dashed var(--bd);color:var(--muted);font-family:var(--vscode-editor-font-family,monospace);overflow-wrap:anywhere;font-size:11px}
.muted{color:var(--muted);font-size:12px}
.actions{display:flex;gap:8px;margin-top:10px}
.hide{display:none !important}

/* ===== Revision picker (mergePanel 风格) ===== */
.revision-filter-bar{display:flex;gap:12px;align-items:center;margin-bottom:8px}
.filter-input{flex:1}
.revision-list-container{border:1px solid var(--bd);border-radius:3px;overflow:hidden}
.revision-list-header{display:grid;grid-template-columns:30px 70px 110px 130px 1fr;gap:4px;padding:6px 8px;background-color:var(--vscode-editor-lineHighlightBackground,rgba(255,255,255,.04));font-size:11px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--bd);user-select:none}
.revision-list-body{max-height:340px;overflow-y:auto}
.revision-row{display:grid;grid-template-columns:30px 70px 110px 130px 1fr;gap:4px;padding:5px 8px;font-size:12px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer}
.revision-row:hover{background-color:var(--row-hover)}
.revision-row.selected{background-color:var(--row-sel)}
.revision-row.merged{opacity:.45;cursor:not-allowed}
.revision-row.merged:hover{background-color:transparent}
.revision-row.merged .rev-col-num::after{content:' ✓';color:var(--vscode-charts-green,#89d185);font-size:10px}
.revision-row.merged .rev-col-check input{cursor:not-allowed}
.revision-row .rev-col-check{display:flex;align-items:center;justify-content:center}
.rev-col-num{font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-textLink-foreground,#3794ff)}
.rev-col-author,.rev-col-date,.rev-col-msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rev-col-date{font-size:11px;color:var(--muted)}
.revision-empty{padding:20px;text-align:center;color:var(--muted);font-size:13px}
.revision-summary{padding:6px 8px;font-size:12px;color:var(--muted)}

#progress{background:var(--vscode-textCodeBlock-background);border:1px solid var(--bd);border-radius:2px;padding:8px;font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre-wrap;max-height:240px;overflow:auto}
.conflict-item{padding:6px;border-bottom:1px solid var(--bd)}
.conflict-item:last-child{border-bottom:none}
.conflict-buttons{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap}
.tag{display:inline-block;padding:1px 6px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:2px;font-size:11px;margin-right:6px}
</style>
</head><body>

<h2>合并到其他分支</h2>

<div class="section">
  <div class="row"><label>当前分支:</label><div class="path-readonly" id="srcPath">…</div></div>
  <div class="row"><label>当前 URL:</label><div class="path-readonly" id="srcUrl">…</div></div>
</div>

<div class="section">
  <h3>① 选择目标分支工作副本（已 checkout）</h3>
  <div class="row">
    <button id="btnBrowse">📁 选择目录…</button>
    <button id="btnUseLast" class="secondary hide">↻ 使用上次：<span id="lastTargetLabel"></span></button>
    <div class="path-readonly" id="tgtPath">未选择</div>
  </div>
  <div class="row muted" id="tgtUrl"></div>
</div>

<div class="section">
  <h3>② 选择要合并的版本（未合并到目标分支）</h3>
  <div class="row">
    <button id="btnLoad" class="secondary">🔄 加载未合并版本</button>
    <span class="muted" id="revHint">先选择目标分支</span>
  </div>
  <div class="revision-filter-bar hide" id="filterBar">
    <input type="text" id="revisionFilterInput" class="text-input filter-input" placeholder="过滤：输入作者、日志关键词、版本号…（空格 AND，+ OR）">
  </div>
  <div class="revision-list-container hide" id="revListContainer">
    <div class="revision-list-header">
      <span class="rev-col-check"><input type="checkbox" id="revSelectAll" title="全选/取消全选"></span>
      <span class="rev-col-num">版本</span>
      <span class="rev-col-author">作者</span>
      <span class="rev-col-date">日期</span>
      <span class="rev-col-msg">日志</span>
    </div>
    <div id="revisionListBody" class="revision-list-body"></div>
  </div>
  <div class="revision-summary" id="revisionSummary"></div>
</div>

<div class="section">
  <h3>③ 提交日志</h3>
  <div class="row"><textarea id="commitMsg" placeholder="留空则自动填入: Merged from URL r1,r2,..."></textarea></div>
</div>

<div class="actions">
  <button id="btnMerge" disabled>🚀 开始合并</button>
  <button id="btnCommit" class="hide">📤 解决冲突后提交</button>
  <button id="btnClose" class="secondary">关闭</button>
</div>

<div class="section hide" id="progressSection">
  <h3>执行日志</h3>
  <div id="progress"></div>
</div>

<div class="section hide" id="conflictSection">
  <h3>冲突文件 <button id="btnRefreshConflicts" class="secondary" style="float:right">🔄 刷新</button></h3>
  <div class="row">
    <button class="secondary" data-all="working">全部标记已解决</button>
    <button class="secondary" data-all="mine-full">全部使用本地</button>
    <button class="secondary" data-all="theirs-full">全部使用合并方</button>
  </div>
  <div id="conflictList"></div>
</div>

<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let targetPath = '';
  let phase = 'idle';
  let allRevisions = [];
  let selectedRevisions = new Set();

  function send(c,p={}){ vscode.postMessage(Object.assign({command:c},p)); }
  function appendLog(t){ const p=$('progress'); p.textContent += t; p.scrollTop=p.scrollHeight; $('progressSection').classList.remove('hide'); }
  function escapeHtml(s){ return String(s||'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c])); }
  function refreshMergeBtn(){ $('btnMerge').disabled = !targetPath || selectedRevisions.size===0 || phase==='merging' || phase==='committing'; }

  $('btnBrowse').addEventListener('click', ()=> send('browseTarget'));
  $('btnUseLast').addEventListener('click', ()=>{
    const p = $('btnUseLast').getAttribute('data-path') || '';
    if (p) send('useLastTarget',{ targetPath: p });
  });
  $('btnLoad').addEventListener('click', ()=>{
    if (!targetPath){ alert('请先选择目标分支工作副本'); return; }
    $('revHint').textContent='加载中…';
    $('revListContainer').classList.add('hide');
    $('filterBar').classList.add('hide');
    send('loadEligible',{ targetPath });
  });
  $('btnMerge').addEventListener('click', ()=>{
    const checked = Array.from(selectedRevisions).sort((a,b)=>a-b);
    if (checked.length===0) return;
    send('startMerge',{ targetPath, revs: checked, message: $('commitMsg').value });
  });
  $('btnCommit').addEventListener('click', ()=>{
    const msg = $('commitMsg').value.trim();
    if (!msg){ alert('请填写提交日志'); return; }
    send('finalCommit',{ message: msg });
  });
  $('btnClose').addEventListener('click', ()=> send('close'));
  $('btnRefreshConflicts').addEventListener('click', ()=> send('refreshConflicts'));
  document.querySelectorAll('button[data-all]').forEach(b=>{
    b.addEventListener('click', ()=> send('resolveAll',{ resolution: b.getAttribute('data-all') }));
  });
  $('revisionFilterInput').addEventListener('input', ()=> renderRevisions());
  $('revSelectAll').addEventListener('change', ()=>{
    const visible = getVisibleRevisions().filter(r=> !r.merged);
    if ($('revSelectAll').checked) visible.forEach(r=> selectedRevisions.add(r.revision));
    else visible.forEach(r=> selectedRevisions.delete(r.revision));
    renderRevisions();
  });

  function matchesFilter(rev, filterText){
    const s = ('r'+rev.revision+' '+rev.author+' '+rev.message+' '+rev.date).toLowerCase();
    const tokens = filterText.split(/\\s+/).filter(Boolean);
    const groups = []; let cur = [];
    for (let i=0;i<tokens.length;i++){
      const t = tokens[i];
      if (t === '+') continue;
      if (i>0 && tokens[i-1] === '+'){ cur.push(t); }
      else { if (cur.length>0) groups.push(cur); cur = [t]; }
    }
    if (cur.length>0) groups.push(cur);
    if (groups.length===0) return true;
    return groups.every(g => g.some(kw => s.includes(kw)));
  }

  function getVisibleRevisions(){
    const f = ($('revisionFilterInput').value||'').trim().toLowerCase();
    return allRevisions.filter(r => !f || matchesFilter(r, f));
  }

  function renderRevisions(){
    const body = $('revisionListBody');
    const filtered = getVisibleRevisions();
    if (allRevisions.length===0){
      body.innerHTML = '<div class="revision-empty">没有未合并的版本</div>';
      $('revisionSummary').textContent = '';
      $('revListContainer').classList.add('hide');
      $('filterBar').classList.add('hide');
      return;
    }
    $('revListContainer').classList.remove('hide');
    $('filterBar').classList.remove('hide');
    if (filtered.length===0){
      body.innerHTML = '<div class="revision-empty">无匹配的版本</div>';
    } else {
      let html = '';
      filtered.forEach(r=>{
        const isMerged = !!r.merged;
        const sel = !isMerged && selectedRevisions.has(r.revision);
        const cls = ['revision-row'];
        if (isMerged) cls.push('merged');
        if (sel) cls.push('selected');
        const dateStr = (r.date||'').split(/[T ]/).slice(0,2).join(' ').slice(0,16);
        const msg = escapeHtml(r.message).replace(/\n/g,' ');
        html += '<div class="'+cls.join(' ')+'" data-rev="'+r.revision+'" data-merged="'+(isMerged?'1':'0')+'">'
          + '<span class="rev-col-check"><input type="checkbox" '+(sel?'checked':'')+' '+(isMerged?'disabled':'')+'></span>'
          + '<span class="rev-col-num">r'+r.revision+'</span>'
          + '<span class="rev-col-author" title="'+escapeHtml(r.author)+'">'+escapeHtml(r.author)+'</span>'
          + '<span class="rev-col-date" title="'+escapeHtml(r.date)+'">'+escapeHtml(dateStr)+'</span>'
          + '<span class="rev-col-msg" title="'+msg+'">'+msg+'</span>'
          + '</div>';
      });
      body.innerHTML = html;
      body.querySelectorAll('.revision-row').forEach(row=>{
        const rev = parseInt(row.getAttribute('data-rev'),10);
        const isMerged = row.getAttribute('data-merged') === '1';
        if (isMerged) return; // 已合并不可选
        const cb = row.querySelector('input[type="checkbox"]');
        const toggle = (state)=>{
          if (state) selectedRevisions.add(rev); else selectedRevisions.delete(rev);
          cb.checked = state; row.classList.toggle('selected', state); refreshMergeBtn(); updateSummary(); updateSelectAll();
        };
        cb.addEventListener('click', e=> { e.stopPropagation(); toggle(cb.checked); });
        row.addEventListener('click', e=>{
          if (e.target===cb) return;
          toggle(!selectedRevisions.has(rev));
        });
      });
    }
    updateSummary(); updateSelectAll();
  }
  
  function updateSummary(){
    const total = allRevisions.filter(r=> !r.merged).length;
    const mergedCount = allRevisions.filter(r=> r.merged).length;
    const visible = getVisibleRevisions();
    const visibleEligible = visible.filter(r=> !r.merged).length;
    const sel = selectedRevisions.size;
    let txt = '可合并: '+total+' 个';
    if (mergedCount>0) txt += ' | 已合并: '+mergedCount+' 个';
    if (visible.length !== allRevisions.length) txt += '（过滤后可合并 '+visibleEligible+'）';
    txt += ' | 已选 '+sel+' 个';
    $('revisionSummary').textContent = txt;
  }
  
  function updateSelectAll(){
    const visible = getVisibleRevisions().filter(r=> !r.merged);
    if (visible.length===0){ $('revSelectAll').checked = false; return; }
    $('revSelectAll').checked = visible.every(r=> selectedRevisions.has(r.revision));
  }

  function renderConflicts(items){
    if (!items || items.length===0){
      $('conflictSection').classList.add('hide');
      if (phase==='mergeFinished' || phase==='conflicts'){
        $('btnCommit').classList.remove('hide');
        $('btnCommit').textContent = '📤 提交合并结果';
      }
      return;
    }
    $('conflictSection').classList.remove('hide');
    $('btnCommit').classList.remove('hide');
    $('btnCommit').textContent = '📤 解决全部冲突后提交（剩余 '+items.length+'）';
    $('conflictList').innerHTML = items.map(c=>
      '<div class="conflict-item" data-path="'+escapeHtml(c.path)+'">'
      +'<div><span class="tag">'+escapeHtml(c.conflictType||'text')+'</span>'+escapeHtml(c.displayName||c.path)+'</div>'
      +'<div class="conflict-buttons">'
      +'<button class="cf-merge">编辑冲突</button>'
      +'<button class="cf-btn" data-action="working">标记已解决</button>'
      +'<button class="cf-btn secondary" data-action="mine-full">使用本地</button>'
      +'<button class="cf-btn secondary" data-action="theirs-full">使用合并方</button>'
      +'</div></div>'
    ).join('');
    document.querySelectorAll('.conflict-item').forEach(item=>{
      const fp = item.getAttribute('data-path');
      const m = item.querySelector('.cf-merge');
      if (m) m.addEventListener('click', ()=> send('openMergeEditor',{ filePath: fp }));
      item.querySelectorAll('.cf-btn').forEach(b=>{
        b.addEventListener('click', ()=> send('resolveConflict',{ filePath: fp, resolution: b.getAttribute('data-action') }));
      });
    });
  }

  window.addEventListener('message', (ev)=>{
    const m = ev.data;
    switch(m.command){
      case 'init':
        $('srcPath').textContent = m.sourcePath;
        $('srcUrl').textContent = m.sourceUrl;
        if (m.lastTarget && m.lastTarget.path){
          $('btnUseLast').classList.remove('hide');
          $('btnUseLast').setAttribute('data-path', m.lastTarget.path);
          $('lastTargetLabel').textContent = (m.lastTarget.path||'').split(/[\\\\/]/).pop();
          $('btnUseLast').title = m.lastTarget.path;
        }
        break;
      case 'browseTargetResult':
        if (!m.ok){ alert(m.error); return; }
        targetPath = m.targetPath;
        $('tgtPath').textContent = m.targetPath;
        $('tgtUrl').textContent = m.targetUrl ? '目标 URL: ' + m.targetUrl : '';
        $('revHint').textContent = '点击"加载未合并版本"';
        // 清掉版本列表，避免误用旧分支的列表
        allRevisions = []; selectedRevisions.clear();
        $('revListContainer').classList.add('hide');
        $('filterBar').classList.add('hide');
        $('revisionSummary').textContent = '';
        refreshMergeBtn();
        break;
      case 'eligibleRevs':
        if (!m.ok){ $('revHint').textContent = '加载失败：' + m.error; return; }
        allRevisions = m.revs || [];
        selectedRevisions.clear();
        const eligibleCount = allRevisions.filter(r=> !r.merged).length;
        const mergedCount = allRevisions.filter(r=> r.merged).length;
        $('revHint').textContent = '可合并 '+eligibleCount+' 个、已合并 '+mergedCount+' 个';
        renderRevisions(); refreshMergeBtn();
        break;
      case 'phase':
        phase = m.phase;
        if (phase==='merging' || phase==='committing'){ $('btnMerge').disabled = true; }
        if (phase==='done'){ $('btnCommit').classList.add('hide'); $('btnMerge').disabled = true; }
        break;
      case 'progress':
        appendLog(m.text);
        break;
      case 'conflicts':
        if (m.items && m.items.length>0) phase='conflicts';
        renderConflicts(m.items||[]);
        break;
      case 'mergeFinished':
        phase = 'mergeFinished';
        if ($('commitMsg').value.trim()==='' && m.defaultMessage){ $('commitMsg').value = m.defaultMessage; }
        break;
      case 'error':
        appendLog('\\n[错误] ' + m.message + '\\n');
        alert(m.message);
        break;
    }
  });

  send('ready');
})();
</script>
</body></html>`;
    }
}

/**
 * 解析 svn log 文本输出
 */
function parseSvnLog(raw: string): Record<number, { author: string; date: string; msg: string }> {
    const map: Record<number, { author: string; date: string; msg: string }> = {};
    if (!raw) return map;
    const blocks = raw.split(/^-{20,}\s*$/m).map(s => s.trim()).filter(Boolean);
    for (const blk of blocks) {
        const m = blk.match(/^r(\d+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/);
        if (!m) continue;
        const rev = parseInt(m[1], 10);
        const author = m[2].trim();
        const date = m[3].trim();
        const lines = blk.split('\n');
        const msg = lines.slice(1).join('\n').trim();
        map[rev] = { author, date, msg };
    }
    return map;
}
