(function() {
    const vscode = acquireVsCodeApi();
    const logList = document.getElementById('logList');
    const logDetails = document.getElementById('logDetails');
    const loading = document.getElementById('loading');
    const refreshButton = document.getElementById('refreshButton');
    const loadMoreButton = document.getElementById('loadMoreButton');
    const loadMoreControl = document.getElementById('loadMoreControl');
    const generatePatchButton = document.getElementById('generatePatchButton');
    const mergeOutputSection = document.getElementById('mergeOutputSection');
    const mergeOutput = document.getElementById('mergeOutput');
    const localRevisionInfo = document.getElementById('localRevisionInfo');
    const localRevisionNumber = document.getElementById('localRevisionNumber');
    
    // 筛选数量显示元素
    const logCountInfo = document.getElementById('logCountInfo');
    const logListHeader = document.getElementById('logListHeader');
    const logCountSummary = document.getElementById('logCountSummary');
    const logFilterStatus = document.getElementById('logFilterStatus');
    
    // 筛选表单元素
    const revisionFilter = document.getElementById('revisionFilter');
    const logFilterInput = document.getElementById('logFilterInput');
    const filterButton = document.getElementById('filterButton');
    const clearFilterButton = document.getElementById('clearFilterButton');
    const filterResult = document.getElementById('filterResult');
    
    // 日期筛选表单元素
    const dateFilterToggle = document.getElementById('dateFilterToggle');
    const revisionFilterSection = document.getElementById('revisionFilterSection');
    const dateFilterSection = document.getElementById('dateFilterSection');
    const startDateFilter = document.getElementById('startDateFilter');
    const endDateFilter = document.getElementById('endDateFilter');
    
    // 默认设置当前日期为结束日期，三天前为开始日期
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(today.getDate() - 3);
    
    // 格式化为 YYYY-MM-DD
    startDateFilter.value = threeDaysAgo.toISOString().split('T')[0];
    endDateFilter.value = today.toISOString().split('T')[0];
    
    // 日期筛选切换事件
    dateFilterToggle.addEventListener('change', () => {
        const useDate = dateFilterToggle.checked;
        revisionFilterSection.style.display = useDate ? 'none' : 'block';
        dateFilterSection.style.display = useDate ? 'block' : 'none';
        debugLog('切换筛选模式: ' + (useDate ? '日期筛选' : '修订版本筛选'));
    });
    
    // 存储目标路径信息
    let targetPath = '';
    let targetName = '';
    let isDirectory = false;
    let targetSvnRelativePath = '';
    
    // 存储"只显示相关文件"选项的状态，默认为true（勾选）
    let showRelatedFilesOnly = true;
    
    let selectedRevision = null;
    let selectedRevisions = new Set();
    let mergedRevisions = new Set();
    let eligibleRevisions = new Set();
    let logEntries = [];
    let currentHasMoreLogs = false;
    
    // 辅助函数：获取路径的最后一部分（文件名或目录名）
    function basename(path) {
        // 处理路径分隔符
        path = path.replace(/\\\\/g, '/');
        // 移除末尾的斜杠
        if (path.endsWith('/')) {
            path = path.slice(0, -1);
        }
        // 获取最后一部分
        const parts = path.split('/');
        return parts[parts.length - 1] || '';
    }
    
    // 调试日志函数
    function debugLog(message) {
        console.log('[SVN日志面板] ' + message);
        vscode.postMessage({
            command: 'debug',
            message: message
        });
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[character]));
    }

    function matchesLogFilter(entry, filterText) {
        const searchable = ('r' + entry.revision + ' ' + entry.author + ' ' + entry.message + ' ' + entry.date).toLowerCase();
        const tokens = filterText.split(/\s+/).filter(Boolean);
        const groups = [];
        let current = [];
        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];
            if (token === '+') continue;
            if (index > 0 && tokens[index - 1] === '+') {
                current.push(token);
            } else {
                if (current.length > 0) groups.push(current);
                current = [token];
            }
        }
        if (current.length > 0) groups.push(current);
        return groups.length === 0 || groups.every(group => group.some(keyword => searchable.includes(keyword)));
    }

    function getVisibleLogEntries() {
        const filterText = (logFilterInput.value || '').trim().toLowerCase();
        return logEntries.filter(entry => !filterText || matchesLogFilter(entry, filterText));
    }

    function selectedRevisionArray() {
        return Array.from(selectedRevisions).sort((left, right) => Number(left) - Number(right));
    }

    function syncSelectedRevisions() {
        vscode.postMessage({ command: 'selectRevisions', revisions: selectedRevisionArray() });
        showSelectedRevisionButtons();
    }
    
    // ========== 右键菜单工具函数 ==========
    let activeContextMenu = null;
    
    function closeContextMenu() {
        if (activeContextMenu) {
            activeContextMenu.remove();
            activeContextMenu = null;
        }
    }
    
    function createContextMenu(x, y, items) {
        closeContextMenu();
        const menu = document.createElement('div');
        menu.className = 'context-menu';
        
        items.forEach(item => {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                menu.appendChild(sep);
                return;
            }
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item' + (item.disabled ? ' disabled' : '');
            menuItem.innerHTML = '<span class="context-menu-icon">' + (item.icon || '') + '</span><span>' + item.label + '</span>';
            if (!item.disabled && item.action) {
                menuItem.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeContextMenu();
                    item.action();
                });
            }
            menu.appendChild(menuItem);
        });
        
        document.body.appendChild(menu);
        activeContextMenu = menu;
        
        // 调整位置防止超出视口
        const rect = menu.getBoundingClientRect();
        if (x + rect.width > window.innerWidth) {
            x = window.innerWidth - rect.width - 5;
        }
        if (y + rect.height > window.innerHeight) {
            y = window.innerHeight - rect.height - 5;
        }
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    }
    
    // 点击任意位置关闭右键菜单
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('contextmenu', closeContextMenu);
    
    // 更新日志数量显示
    function updateLogCountDisplay(count, isFiltered, hasMoreLogs, filterDescription) {
        debugLog('更新日志数量显示: count=' + count + ', isFiltered=' + isFiltered + ', hasMoreLogs=' + hasMoreLogs + ', filterDescription=' + (filterDescription || '无'));
        
        // 更新底部栏中的数量信息
        if (logCountInfo) {
            logCountInfo.textContent = '(显示: ' + count + ' 条)';
            logCountInfo.style.color = 'var(--vscode-descriptionForeground)';
        }
        
        // 更新日志列表头部信息
        if (logListHeader && logCountSummary && logFilterStatus) {
            if (count > 0) {
                logListHeader.style.display = 'block';
                
                // 设置数量摘要
                logCountSummary.textContent = '共 ' + count + ' 条日志记录';
                
                // 设置筛选状态
                if (isFiltered) {
                    let statusText = '🔍 筛选条件: ' + (filterDescription || '未知');
                    if (hasMoreLogs) {
                        statusText += ' (可加载更多历史记录)';
                    }
                    logFilterStatus.textContent = statusText;
                    logFilterStatus.style.color = 'var(--vscode-notificationsWarningIcon-foreground)';
                } else {
                    if (hasMoreLogs) {
                        logFilterStatus.textContent = '📄 显示最新记录 (可加载更多历史记录)';
                    } else {
                        logFilterStatus.textContent = '📄 显示全部记录';
                    }
                    logFilterStatus.style.color = 'var(--vscode-descriptionForeground)';
                }
            } else {
                logListHeader.style.display = 'none';
            }
        }
    }

    const FOOTER_BUTTONS = [
        'changeMergeTargetButton', 'mergeToBranchButton',
        'resolveMergeConflictsButton', 'commitMergeButton', 'retryCommitMergeButton',
        'generatePatchButton', 'cancelMergeButton', 'closeLogPanelButton'
    ];
    let mergeTargetInfo = null;
    let mergeRunning = false;

    function setFooterButtons(visibleIds) {
        const visible = new Set(visibleIds);
        FOOTER_BUTTONS.forEach(id => {
            const button = document.getElementById(id);
            if (!button) return;
            if (visible.has(id)) {
                button.style.display = button.classList.contains('two-line-button') ? 'inline-flex' : 'inline-block';
            } else {
                button.style.display = 'none';
            }
        });
    }

    function renderMergeTargetButton() {
        const button = document.getElementById('mergeToBranchButton');
        if (!button) return;
        const line1 = button.querySelector('.btn-line1');
        const line2 = button.querySelector('.btn-line2');
        const selectionText = selectedRevisions.size === 1
            ? 'r' + selectedRevisionArray()[0]
            : '已选 ' + selectedRevisions.size + ' 个版本';
        if (mergeTargetInfo) {
            line1.textContent = '合并到(' + mergeTargetInfo.dirName + ')';
            line2.textContent = mergeTargetInfo.branchName || '';
            button.title = '将 ' + selectionText + ' 合并到 ' + mergeTargetInfo.targetPath + ' 并自动提交';
        } else {
            line1.textContent = '合并到分支...';
            line2.textContent = '';
            button.title = '选择要合并到的分支目录，然后自动合并并提交选中版本';
        }
    }

    function showSelectedRevisionButtons() {
        const buttons = selectedRevisions.size > 0
            ? ['generatePatchButton', 'changeMergeTargetButton', 'mergeToBranchButton', 'closeLogPanelButton']
            : ['closeLogPanelButton'];
        setFooterButtons(buttons);
        renderMergeTargetButton();
        generatePatchButton.title = selectedRevisions.size > 1
            ? '根据已选 ' + selectedRevisions.size + ' 个版本生成最终 Lua patch'
            : '根据选中的日志版本生成 Lua patch';
    }

    function showMergeOutput(clearOutput) {
        mergeOutputSection.style.display = 'flex';
        document.body.classList.add('merging');
        if (clearOutput) {
            mergeOutput.textContent = '';
        }
    }

    function appendMergeOutput(text) {
        mergeOutput.textContent += text || '';
        mergeOutput.scrollTop = mergeOutput.scrollHeight;
    }

    function onMergeFinished(success, hasConflicts, commitFailed) {
        mergeRunning = false;
        if (success && hasConflicts) {
            setFooterButtons(['resolveMergeConflictsButton', 'commitMergeButton', 'closeLogPanelButton']);
        } else if (success) {
            setFooterButtons(['generatePatchButton', 'closeLogPanelButton']);
        } else if (commitFailed) {
            setFooterButtons(['retryCommitMergeButton', 'closeLogPanelButton']);
        } else {
            showSelectedRevisionButtons();
        }
    }
    
    debugLog('Webview脚本已初始化');
    
    // 存储本地修订版本号
    let localRevision = null;
    
    // 初始化
    window.addEventListener('message', event => {
        const message = event.data;
        debugLog('收到消息: ' + message.command);
        
        switch (message.command) {
            case 'setLoading':
                loading.style.display = message.value ? 'flex' : 'none';
                break;
            case 'updateLogList':
                logEntries = message.logEntries || [];
                currentHasMoreLogs = message.hasMoreLogs !== false;
                debugLog('收到日志条目: ' + logEntries.length + '条');

                if (message.hasOwnProperty('isDirectory')) {
                    isDirectory = message.isDirectory;
                    debugLog('更新isDirectory: ' + isDirectory);
                }

                if (message.targetSvnRelativePath) {
                    targetSvnRelativePath = message.targetSvnRelativePath;
                    debugLog('更新SVN相对路径: ' + targetSvnRelativePath);
                }

                selectedRevision = message.selectedRevision || null;
                selectedRevisions = new Set((message.selectedRevisions || []).map(String));
                renderLogList(getVisibleLogEntries(), message.isLoadingMore, currentHasMoreLogs);
                showSelectedRevisionButtons();
                break;
            case 'updateSvnRelativePath':
                targetSvnRelativePath = message.targetSvnRelativePath;
                debugLog('更新SVN相对路径: ' + targetSvnRelativePath);
                break;
            case 'updateIsDirectory':
                isDirectory = message.isDirectory;
                debugLog('更新isDirectory: ' + isDirectory);
                break;
            case 'updateTargetName':
                debugLog('更新目标路径名称: ' + message.targetName);
                targetName = message.targetName;
                break;
            case 'updateTargetPath':
                debugLog('更新目标路径: ' + message.targetPath);
                targetPath = message.targetPath;
                break;
            case 'showRevisionDetails':
                debugLog('显示修订版本详情: ' + message.revision);
                if (message.details && message.details.paths) {
                    debugLog('路径数量: ' + message.details.paths.length);
                } else {
                    debugLog('没有路径信息');
                }
                
                // 更新isDirectory状态
                if (message.hasOwnProperty('isDirectory')) {
                    isDirectory = message.isDirectory;
                    debugLog('更新isDirectory: ' + isDirectory);
                }
                
                // 更新SVN相对路径
                if (message.targetSvnRelativePath) {
                    targetSvnRelativePath = message.targetSvnRelativePath;
                    debugLog('更新SVN相对路径: ' + targetSvnRelativePath);
                }
                
                selectedRevision = message.revision;
                renderRevisionDetails(message.details);
                generatePatchButton.disabled = false;
                generatePatchButton.textContent = '生成 patch';
                if (!mergeRunning && !document.body.classList.contains('merging')) {
                    showSelectedRevisionButtons();
                }
                break;
            case 'mergeTargetInfo':
                mergeTargetInfo = message.info || null;
                renderMergeTargetButton();
                break;
            case 'mergeRevisionStatus':
                mergedRevisions = new Set((message.mergedRevisions || []).map(Number));
                eligibleRevisions = new Set((message.eligibleRevisions || []).map(Number));
                renderLogList(getVisibleLogEntries(), false, currentHasMoreLogs);
                break;
            case 'mergeStarted': {
                mergeRunning = true;
                showMergeOutput(message.clearOutput === true);
                setFooterButtons(['cancelMergeButton']);
                const cancelButton = document.getElementById('cancelMergeButton');
                cancelButton.disabled = false;
                cancelButton.textContent = '取消';
                break;
            }
            case 'appendMergeOutput':
                appendMergeOutput(message.text);
                break;
            case 'mergeFinished':
                onMergeFinished(message.success === true, message.hasConflicts === true, message.commitFailed === true);
                break;
            case 'patchGenerationStarted':
                generatePatchButton.disabled = true;
                generatePatchButton.textContent = '生成中...';
                break;
            case 'patchGenerationFinished':
                generatePatchButton.disabled = false;
                generatePatchButton.textContent = '生成 patch';
                break;
            case 'filterResult':
                debugLog('筛选结果: ' + message.count + ' 条记录');
                if (message.error) {
                    // 如果有错误信息，显示错误
                    filterResult.textContent = message.error;
                    filterResult.style.color = 'var(--vscode-errorForeground)';
                } else {
                    // 显示正常结果
                    filterResult.textContent = '找到 ' + message.count + ' 条记录';
                    filterResult.style.color = 'var(--vscode-descriptionForeground)';
                }
                break;
            case 'updateLocalRevision':
                localRevision = message.localRevision;
                debugLog('更新本地修订版本号: ' + localRevision);
                
                // 更新界面显示
                if (localRevision) {
                    localRevisionNumber.textContent = localRevision;
                    localRevisionInfo.style.display = 'flex';
                } else {
                    localRevisionInfo.style.display = 'none';
                }
                break;
            case 'updateLogCount':
                debugLog('更新日志数量信息: ' + message.count + ' 条记录');
                if (!(logFilterInput.value || '').trim()) {
                    updateLogCountDisplay(message.count, message.isFiltered, message.hasMoreLogs, message.filterDescription);
                }
                break;
            case 'aiAnalysisComplete':
                debugLog('AI分析完成');
                // 恢复AI分析按钮状态
                const aiAnalysisButton = document.getElementById('aiAnalysisButton');
                if (aiAnalysisButton) {
                    aiAnalysisButton.disabled = false;
                    aiAnalysisButton.textContent = '🤖 AI分析代码差异';
                }
                break;
        }
    });
    
    // 渲染日志列表（表格行式 + 右键菜单）
    function renderLogList(entries, isLoadingMore, hasMoreLogs) {
        debugLog('渲染日志列表' + (isLoadingMore ? '(加载更多)' : ''));
        const savedScrollTop = logList.scrollTop;
        const hasLoadedEntries = logEntries.length > 0;
        loadMoreControl.style.display = hasLoadedEntries && hasMoreLogs !== false ? 'inline-flex' : 'none';
        logCountInfo.textContent = '(显示: ' + entries.length + ' 条)';
        filterResult.textContent = entries.length === logEntries.length ? '' : '显示 ' + entries.length + ' / ' + logEntries.length + ' 条';

        if (!entries || entries.length === 0) {
            logList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📋</div>
                    <div>${hasLoadedEntries ? '无匹配的日志记录' : '没有找到日志记录'}</div>
                </div>
            `;
            return;
        }

        const allVisibleSelected = entries.every(entry => selectedRevisions.has(String(entry.revision)));
        let html = '<div class="log-list-columns"><span class="log-select-column"><input type="checkbox" id="selectAllLogs" title="全选/取消全选当前显示日志" ' + (allVisibleSelected ? 'checked' : '') + '></span><span>Revision</span><div class="col-meta"><span>Author</span><span>Date</span></div></div>';

        entries.forEach(entry => {
            const revision = String(entry.revision);
            const isActive = revision === selectedRevision;
            const isChecked = selectedRevisions.has(revision);
            const isNewerThanLocal = entry.isNewerThanLocal;
            const revisionNumber = Number(revision);
            const isMerged = mergedRevisions.has(revisionNumber);
            const isEligible = eligibleRevisions.has(revisionNumber);
            const msgPreview = escapeHtml((entry.message || '').replace(/\n/g, ' ').substring(0, 80));
            const newerBadge = isNewerThanLocal ? '<span class="revision-badge newer">未更新</span>' : '';
            const mergeBadge = isMerged
                ? '<span class="revision-badge merged">已合并</span>'
                : (isEligible ? '<span class="revision-badge eligible">未合并</span>' : '');

            html += '<div class="log-entry ' + (isActive ? 'active ' : '') + (isChecked ? 'selected ' : '') + (isNewerThanLocal ? 'newer-than-local' : '') + '" data-revision="' + escapeHtml(revision) + '" data-message="' + escapeHtml(entry.message) + '">' +
                '<div class="log-select-cell"><input type="checkbox" class="log-select-checkbox" ' + (isChecked ? 'checked' : '') + ' title="选择 r' + escapeHtml(revision) + '"></div>' +
                '<div class="log-revision-cell">r' + escapeHtml(revision) + newerBadge + mergeBadge + '</div>' +
                '<div class="log-meta-row"><span>' + escapeHtml(entry.author) + '</span><span>' + escapeHtml(entry.date) + '</span></div>' +
                '<div class="log-message-row" title="' + escapeHtml(entry.message) + '">' + msgPreview + '</div>' +
            '</div>';
        });

        logList.innerHTML = html;
        const selectAll = document.getElementById('selectAllLogs');
        selectAll.indeterminate = !allVisibleSelected && entries.some(entry => selectedRevisions.has(String(entry.revision)));
        selectAll.addEventListener('change', () => {
            entries.forEach(entry => {
                const revision = String(entry.revision);
                if (selectAll.checked) selectedRevisions.add(revision);
                else selectedRevisions.delete(revision);
            });
            syncSelectedRevisions();
            renderLogList(getVisibleLogEntries(), false, currentHasMoreLogs);
        });

        document.querySelectorAll('.log-entry').forEach(entryElement => {
            const checkbox = entryElement.querySelector('.log-select-checkbox');
            checkbox.addEventListener('click', event => {
                event.stopPropagation();
                const revision = entryElement.getAttribute('data-revision');
                if (checkbox.checked) selectedRevisions.add(revision);
                else selectedRevisions.delete(revision);
                syncSelectedRevisions();
                renderLogList(getVisibleLogEntries(), false, currentHasMoreLogs);
            });

            entryElement.addEventListener('click', () => {
                const revision = entryElement.getAttribute('data-revision');
                selectedRevision = revision;
                selectedRevisions.add(revision);
                debugLog('选择修订版本: ' + revision);
                vscode.postMessage({ command: 'selectRevision', revision, revisions: selectedRevisionArray() });
                renderLogList(getVisibleLogEntries(), false, currentHasMoreLogs);
                showSelectedRevisionButtons();
            });

            entryElement.addEventListener('contextmenu', event => {
                event.preventDefault();
                event.stopPropagation();
                const revision = entryElement.getAttribute('data-revision');
                const message = entryElement.getAttribute('data-message') || '';
                selectedRevision = revision;
                selectedRevisions.add(revision);
                vscode.postMessage({ command: 'selectRevision', revision, revisions: selectedRevisionArray() });
                renderLogList(getVisibleLogEntries(), false, currentHasMoreLogs);
                showSelectedRevisionButtons();

                createContextMenu(event.clientX, event.clientY, [
                    { icon: '📄', label: '与前一版本比较 (Show Changes)', action: () => vscode.postMessage({ command: 'viewRevisionDiff', revision }) },
                    { icon: '🔄', label: '与工作副本比较', action: () => vscode.postMessage({ command: 'compareWithWorkingCopy', revision }) },
                    { icon: '⬇️', label: '更新到此版本', action: () => vscode.postMessage({ command: 'updateToRevision', revision }) },
                    { icon: '↩️', label: '回滚此版本更改', action: () => vscode.postMessage({ command: 'revertToRevision', revision }) },
                    { separator: true },
                    { icon: '🌿', label: '从此版本创建分支/标签', action: () => vscode.postMessage({ command: 'createBranchFromRevision', revision }) },
                    { icon: '💾', label: '导出此版本 Diff', action: () => vscode.postMessage({ command: 'exportRevisionDiff', revision }) },
                    { separator: true },
                    { icon: '📝', label: '复制修订版本号', action: () => vscode.postMessage({ command: 'copyRevisionNumber', revision }) },
                    { icon: '📋', label: '复制提交信息', action: () => vscode.postMessage({ command: 'copyLogMessage', revision, message }) },
                    { icon: '📂', label: '浏览此版本仓库', action: () => vscode.postMessage({ command: 'browseRevisionRepo', revision }) },
                ]);
            });
        });

        if (isLoadingMore || savedScrollTop > 0) {
            logList.scrollTop = savedScrollTop;
        } else if (selectedRevision) {
            const activeEntry = document.querySelector('.log-entry[data-revision="' + selectedRevision + '"]');
            if (activeEntry) activeEntry.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
    
    // 渲染修订版本详情
    function renderRevisionDetails(details) {
        debugLog('开始渲染修订版本详情');
        if (!details) {
            debugLog('没有详情数据');
            logDetails.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📝</div>
                    <div>请选择一个日志条目查看详情</div>
                </div>
            `;
            return;
        }
        
        // 创建详情内容容器
        let html = `<div class="detail-content-container">`;
        
        // 添加详情头部，包含版本对比信息
        const isNewerThanLocal = details.isNewerThanLocal;
        const versionCompareInfo = localRevision && details.revision ? 
            (isNewerThanLocal ? 
                `<span style="color: #ff9800; font-weight: bold;">此版本 (r${details.revision}) 尚未更新到本地 (r${localRevision})</span>` : 
                `<span>此版本 (r${details.revision}) 已包含在本地版本 (r${localRevision}) 中</span>`) : 
            '';
        
        html += `
            <div class="detail-header">
                <div class="detail-title">修订版本 ${details.revision}</div>
                <div class="detail-info">
                    <span>作者: ${details.author}</span>
                    <span>日期: ${details.date}</span>
                </div>
                ${versionCompareInfo ? `<div style="margin-top: 5px;">${versionCompareInfo}</div>` : ''}
                <div class="detail-actions" style="margin-top: 10px;">
                    <button id="aiAnalysisButton" class="ai-analysis-button" data-revision="${details.revision}">
                        🤖 AI分析代码差异
                    </button>
                </div>
            </div>
            <div class="detail-message">${details.message}</div>
        `;
        
        // 添加文件列表
        if (details.paths && details.paths.length > 0) {
            debugLog('开始渲染文件列表，文件数量: ' + details.paths.length);
            
            html += `
                <div class="file-list-container">
                    <div class="file-list-header">
                        <div class="file-list-title-container">
                            <span class="file-list-title">变更文件列表</span>
                            <span class="file-count">共 ${details.paths.length} 个文件</span>
                        </div>
                        <div class="file-list-filter">
                            <label class="filter-label">
                                <input type="checkbox" id="showRelatedFilesOnly" class="filter-checkbox" checked="${showRelatedFilesOnly}" />
                                <span>只显示相关文件</span>
                            </label>
                        </div>
                    </div>
                    <div class="path-list-header">
                        <div class="path-action">操作</div>
                        <div class="path-filename">文件名</div>
                        <div class="path-filepath">相对路径</div>
                        <div class="path-detail">操作</div>
                    </div>
            `;
            
            details.paths.forEach((path, index) => {
                let actionLabel = '';
                switch (path.action) {
                    case 'A': actionLabel = '添加'; break;
                    case 'M': actionLabel = '修改'; break;
                    case 'D': actionLabel = '删除'; break;
                    case 'R': actionLabel = '替换'; break;
                    default: actionLabel = path.action;
                }
                
                // 获取文件名和相对路径
                const filePath = path.path;
                const fileName = filePath.split('/').pop();
                const relativePath = filePath;
                
                debugLog(`文件 #${index + 1}: ${fileName}, 操作: ${path.action}`);
                
                // 根据调用方式（文件夹或文件）对路径或文件名进行高亮
                let fileNameHtml = fileName;
                let relativePathHtml = relativePath;
                
                // 如果是通过文件夹方式呼出的，高亮路径
                if (isDirectory) {
                    // 检查文件路径是否与文件夹的SVN相对路径一致
                    if (targetSvnRelativePath && relativePath === targetSvnRelativePath) {
                        // 如果完全一致，整个路径高亮
                        relativePathHtml = '<span class="highlight">' + relativePath + '</span>';
                        debugLog('完全匹配，高亮整个路径: ' + relativePath);
                        path.isRelated = true;
                    } 
                    // 检查文件路径是否包含文件夹的SVN相对路径
                    else if (targetSvnRelativePath && relativePath.includes(targetSvnRelativePath)) {
                        // 高亮匹配的部分
                        relativePathHtml = relativePath.replace(
                            targetSvnRelativePath,
                            '<span class="highlight">' + targetSvnRelativePath + '</span>'
                        );
                        debugLog('部分匹配，高亮SVN相对路径: ' + targetSvnRelativePath + ' 在路径: ' + relativePath);
                        path.isRelated = true;
                    }
                    // 如果没有匹配到SVN相对路径，使用原来的高亮逻辑
                    else {
                        // 检查SVN路径是否包含目标文件夹路径的一部分
                        let relativeDirPath = '';
                        
                        // 如果是以/trunk/开头的SVN路径
                        if (relativePath.startsWith('/trunk/')) {
                            // 提取/trunk/之后的部分
                            const trunkPath = relativePath.substring('/trunk/'.length);
                            
                            // 检查目标路径中是否包含这部分
                            const targetDirName = basename(targetPath);
                            
                            // 尝试在路径中查找目标目录名
                            if (trunkPath.includes(targetDirName)) {
                                // 构建正则表达式，匹配目录名及其前后的路径分隔符
                                const dirRegex = new RegExp('(^|/)' + targetDirName + '(/|$)', 'g');
                                
                                // 替换匹配的部分，添加高亮
                                relativePathHtml = relativePath.replace(
                                    dirRegex,
                                    function(match, p1, p2) { 
                                        return p1 + '<span class="highlight">' + targetDirName + '</span>' + p2; 
                                    }
                                );
                                
                                debugLog('高亮目录: ' + targetDirName + ' 在路径: ' + relativePath);
                                path.isRelated = true;
                            } else {
                                // 如果找不到精确匹配，尝试高亮包含目标目录名的部分路径
                                const pathParts = trunkPath.split('/');
                                for (let i = 0; i < pathParts.length; i++) {
                                    if (pathParts[i] === targetDirName) {
                                        // 构建要高亮的路径部分
                                        const highlightPath = pathParts.slice(0, i + 1).join('/');
                                        
                                        // 在相对路径中高亮这部分
                                        relativePathHtml = relativePath.replace(
                                            highlightPath,
                                            '<span class="highlight">' + highlightPath + '</span>'
                                        );
                                        
                                        debugLog('高亮路径部分: ' + highlightPath + ' 在路径: ' + relativePath);
                                        path.isRelated = true;
                                        break;
                                    }
                                }
                            }
                        } else {
                            // 对于其他格式的路径，尝试简单匹配目标目录名
                            const targetDirName = basename(targetPath);
                            
                            if (relativePath.includes(targetDirName)) {
                                relativePathHtml = relativePath.replace(
                                    new RegExp('(^|/)' + targetDirName + '(/|$)', 'g'),
                                    function(match, p1, p2) { 
                                        return p1 + '<span class="highlight">' + targetDirName + '</span>' + p2; 
                                    }
                                );
                                
                                debugLog('高亮目录名: ' + targetDirName + ' 在路径: ' + relativePath);
                                path.isRelated = true;
                            }
                        }
                    }
                } 
                // 如果是通过文件方式呼出的，高亮文件名
                else {
                    // 检查文件名是否与目标文件名匹配
                    if (fileName === targetName) {
                        fileNameHtml = '<span class="highlight">' + fileName + '</span>';
                        debugLog('高亮文件名: ' + fileName);
                        path.isRelated = true;
                    }
                    
                    // 在文件模式下，不使用相对路径匹配逻辑，保持相对路径原样
                    debugLog('文件模式，不高亮相对路径');
                }
                
                // 只有修改和添加的文件才能查看差异
                const canViewDiff = path.action === 'M' || path.action === 'A';
                
                html += `
                    <div class="path-item" data-related="${path.isRelated ? 'true' : 'false'}">
                        <div class="path-action ${path.action}" title="${actionLabel}">${path.action}</div>
                        <div class="path-filename" title="${fileName}">${fileNameHtml}</div>
                        <div class="path-filepath" title="${relativePath}">${relativePathHtml}</div>
                        <div class="path-detail">
                            ${canViewDiff ? 
                                `<button class="detail-button" data-path="${path.path}" data-revision="${details.revision}">显示差异</button>` : 
                                `<button class="detail-button" disabled>显示差异</button>`
                            }
                        </div>
                    </div>
                `;
            });
            
            html += `</div>`; // 关闭file-list-container
        } else {
            debugLog('没有文件列表数据');
            html += `
                <div class="file-list-container">
                    <div class="empty-state">
                        <div class="empty-icon">📂</div>
                        <div>没有找到变更文件</div>
                    </div>
                </div>
            `;
        }
        
        html += `</div>`; // 关闭detail-content-container
        
        logDetails.innerHTML = html;
        debugLog('详情内容渲染完成');
        
        // 添加详细按钮点击事件 + 文件列表右键菜单
        document.querySelectorAll('.detail-button:not([disabled])').forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation();
                const path = button.getAttribute('data-path');
                const revision = button.getAttribute('data-revision');
                debugLog('点击显示差异按钮: 路径=' + path + ', 修订版本=' + revision);
                vscode.postMessage({ command: 'viewFileDiff', path: path, revision: revision });
            });
        });
        
        // 文件列表右键菜单
        document.querySelectorAll('.path-item').forEach(item => {
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const filepathEl = item.querySelector('.path-filepath');
                const actionEl = item.querySelector('.path-action');
                const filePath = filepathEl ? (filepathEl.getAttribute('title') || filepathEl.textContent.trim()) : '';
                const action = actionEl ? actionEl.textContent.trim() : '';
                const revision = details.revision;
                const canDiff = (action === 'M' || action === 'A');
                
                createContextMenu(e.clientX, e.clientY, [
                    { icon: '📄', label: '显示差异', disabled: !canDiff, action: () => vscode.postMessage({ command: 'viewFileDiff', path: filePath, revision: revision }) },
                    { icon: '🔄', label: '与工作副本比较', action: () => vscode.postMessage({ command: 'compareFileWithWorking', path: filePath, revision: revision }) },
                    { icon: '👁️', label: '查看此版本文件', action: () => vscode.postMessage({ command: 'viewFileAtRevision', path: filePath, revision: revision }) },
                    { icon: '👤', label: 'Blame（注释）', action: () => vscode.postMessage({ command: 'blameFileAtRevision', path: filePath, revision: revision }) },
                    { icon: '📜', label: '查看文件日志', action: () => vscode.postMessage({ command: 'showFileLog', path: filePath }) },
                    { separator: true },
                    { icon: '📋', label: '复制文件路径', action: () => vscode.postMessage({ command: 'copyFilePath', path: filePath }) },
                    { icon: '📁', label: '在文件管理器中打开', action: () => vscode.postMessage({ command: 'openInExplorer', path: filePath }) },
                ]);
            });
        });
        
        // 添加AI分析按钮点击事件
        const aiAnalysisButton = document.getElementById('aiAnalysisButton');
        if (aiAnalysisButton) {
            aiAnalysisButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const revision = aiAnalysisButton.getAttribute('data-revision');
                debugLog('点击AI分析按钮: 修订版本=' + revision);
                
                // 获取当前显示的文件列表
                const visibleFiles = [];
                const pathItems = document.querySelectorAll('.path-item');
                
                pathItems.forEach(item => {
                    // 检查文件项是否可见（display不为none）
                    if (item.style.display !== 'none') {
                        // 从DOM中提取文件信息
                        const actionElement = item.querySelector('.path-action');
                        const filepathElement = item.querySelector('.path-filepath');
                        
                        if (actionElement && filepathElement) {
                            const action = actionElement.textContent.trim();
                            const path = filepathElement.getAttribute('title') || filepathElement.textContent.trim();
                            
                            // 移除HTML标签，获取纯文本路径
                            const cleanPath = path.replace(/<[^>]*>/g, '');
                            
                            visibleFiles.push({
                                action: action,
                                path: cleanPath
                            });
                        }
                    }
                });
                
                debugLog('当前显示的文件数量: ' + visibleFiles.length);
                
                // 禁用按钮并显示加载状态
                aiAnalysisButton.disabled = true;
                aiAnalysisButton.textContent = '🔄 AI分析中...';
                
                // 发送包含可见文件列表的消息
                vscode.postMessage({
                    command: 'analyzeRevisionWithAIFiltered',
                    revision: revision,
                    visibleFiles: visibleFiles
                });
            });
        }
        
        // 添加"只显示相关文件"复选框的点击事件
        const showRelatedFilesOnlyCheckbox = document.getElementById('showRelatedFilesOnly');
        if (showRelatedFilesOnlyCheckbox) {
            // 设置复选框的初始状态
            showRelatedFilesOnlyCheckbox.checked = showRelatedFilesOnly;
            
            showRelatedFilesOnlyCheckbox.addEventListener('change', () => {
                const isChecked = showRelatedFilesOnlyCheckbox.checked;
                debugLog('只显示相关文件复选框状态: ' + isChecked);
                
                // 更新全局变量，保持状态
                showRelatedFilesOnly = isChecked;
                
                // 获取所有文件项
                const pathItems = document.querySelectorAll('.path-item');
                
                // 根据复选框状态显示或隐藏文件项
                pathItems.forEach(item => {
                    const isRelated = item.getAttribute('data-related') === 'true';
                    
                    if (isChecked) {
                        // 如果勾选了复选框，只显示相关文件
                        item.style.display = isRelated ? '' : 'none';
                    } else {
                        // 如果取消勾选，显示所有文件
                        item.style.display = '';
                    }
                });
                
                // 更新文件计数
                const fileCount = document.querySelector('.file-count');
                if (fileCount) {
                    const totalFiles = details.paths.length;
                    const visibleFiles = isChecked 
                        ? Array.from(pathItems).filter(item => item.getAttribute('data-related') === 'true').length 
                        : totalFiles;
                    
                    fileCount.textContent = '共 ' + totalFiles + ' 个文件' + (isChecked ? '，显示 ' + visibleFiles + ' 个相关文件' : '');
                }
            });
            
            // 自动触发一次过滤，应用当前的过滤状态
            if (showRelatedFilesOnly) {
                // 获取所有文件项
                const pathItems = document.querySelectorAll('.path-item');
                
                // 根据复选框状态显示或隐藏文件项
                pathItems.forEach(item => {
                    const isRelated = item.getAttribute('data-related') === 'true';
                    item.style.display = isRelated ? '' : 'none';
                });
                
                // 更新文件计数
                const fileCount = document.querySelector('.file-count');
                if (fileCount) {
                    const totalFiles = details.paths.length;
                    const visibleFiles = Array.from(pathItems).filter(item => item.getAttribute('data-related') === 'true').length;
                    
                    fileCount.textContent = '共 ' + totalFiles + ' 个文件，显示 ' + visibleFiles + ' 个相关文件';
                }
            }
        }
    }
    
    // 筛选按钮点击事件
    filterButton.addEventListener('click', () => {
        const useDate = dateFilterToggle.checked;
        const revision = revisionFilter.value.trim();
        const startDate = startDateFilter.value.trim();
        const endDate = endDateFilter.value.trim();

        if (!useDate && !revision) {
            filterResult.textContent = '请输入修订版本范围，或直接使用关键词过滤';
            return;
        }

        vscode.postMessage({
            command: 'filterLogs',
            revision,
            author: '',
            content: '',
            startDate,
            endDate,
            useDate
        });
    });

    logFilterInput.addEventListener('input', () => {
        renderLogList(getVisibleLogEntries(), false, currentHasMoreLogs);
    });

    clearFilterButton.addEventListener('click', () => {
        debugLog('清除筛选条件');
        revisionFilter.value = '';
        logFilterInput.value = '';
        startDateFilter.value = threeDaysAgo.toISOString().split('T')[0];
        endDateFilter.value = today.toISOString().split('T')[0];
        dateFilterToggle.checked = false;
        revisionFilterSection.style.display = 'block';
        dateFilterSection.style.display = 'none';
        filterResult.textContent = '';
        vscode.postMessage({ command: 'refresh' });
    });

    revisionFilter.addEventListener('keypress', event => {
        if (event.key === 'Enter') filterButton.click();
    });
    
    // 刷新按钮事件
    refreshButton.addEventListener('click', () => {
        debugLog('点击刷新按钮');
        vscode.postMessage({
            command: 'refresh'
        });
    });

    loadMoreButton.addEventListener('click', () => {
        debugLog('点击加载更多按钮');
        vscode.postMessage({ command: 'loadMoreLogs', limit: 100 });
    });

    generatePatchButton.addEventListener('click', () => {
        if (selectedRevisions.size === 0 || generatePatchButton.disabled) return;
        generatePatchButton.disabled = true;
        generatePatchButton.textContent = '生成中...';
        vscode.postMessage({ command: 'generatePatch', revisions: selectedRevisionArray() });
    });

    document.getElementById('changeMergeTargetButton').addEventListener('click', () => {
        vscode.postMessage({ command: 'chooseMergeTarget' });
    });

    document.getElementById('mergeToBranchButton').addEventListener('click', () => {
        vscode.postMessage({ command: 'mergeToBranch', revisions: selectedRevisionArray() });
    });

    document.getElementById('resolveMergeConflictsButton').addEventListener('click', () => {
        vscode.postMessage({ command: 'openMergeConflicts' });
    });

    document.getElementById('commitMergeButton').addEventListener('click', () => {
        vscode.postMessage({ command: 'commitMerge' });
    });

    document.getElementById('retryCommitMergeButton').addEventListener('click', () => {
        vscode.postMessage({ command: 'commitMerge' });
    });

    document.getElementById('cancelMergeButton').addEventListener('click', event => {
        event.currentTarget.disabled = true;
        event.currentTarget.textContent = '取消中...';
        vscode.postMessage({ command: 'cancelMerge' });
    });

    document.getElementById('closeLogPanelButton').addEventListener('click', () => {
        vscode.postMessage({ command: 'closePanel' });
    });

    showSelectedRevisionButtons();
})();
