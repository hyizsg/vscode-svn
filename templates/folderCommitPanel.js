(function() {
    const vscode = acquireVsCodeApi();
    
    // 从状态中恢复或初始化
    const previousState = vscode.getState() || {
        selectedFiles: [],
        enabledTypes: ['modified', 'added', 'deleted', 'unversioned', 'missing'],
        selectedGroups: [],
        selectedExtensions: [],
        collapsedGroups: [],
        lockedOnly: false
    };

    let selectedFiles = new Set(previousState.selectedFiles);
    let enabledTypes = new Set(previousState.enabledTypes);
    let selectedGroups = new Set(previousState.selectedGroups);
    let selectedExtensions = new Set(previousState.selectedExtensions);
    let collapsedGroups = new Set(previousState.collapsedGroups);
    let lockedOnly = !!previousState.lockedOnly;

    // 行选择（右键、点击高亮用，不影响提交勾选）
    let activeFiles = new Set();
    let lastActivePath = null;

    // 保存状态的函数
    function saveState() {
        vscode.setState({
            selectedFiles: Array.from(selectedFiles),
            enabledTypes: Array.from(enabledTypes),
            selectedGroups: Array.from(selectedGroups),
            selectedExtensions: Array.from(selectedExtensions),
            collapsedGroups: Array.from(collapsedGroups),
            lockedOnly: lockedOnly
        });
    }
    
    // 在状态变化的地方调用 saveState
    function toggleFileType(type) {
        if (enabledTypes.has(type)) {
            enabledTypes.delete(type);
            document.getElementById(type + '-checkbox').checked = false;
        } else {
            enabledTypes.add(type);
            document.getElementById(type + '-checkbox').checked = true;
        }
        updateFileList();
        saveState();  // 保存状态
    }
    
    // 修改文件选择函数
    function toggleAllFiles(checked) {
        const visibleFiles = Array.from(document.querySelectorAll('.file-item'))
            .filter(item => item.style.display !== 'none')
            .map(item => item.getAttribute('data-path'));
        
        if (checked) {
            visibleFiles.forEach(path => selectedFiles.add(path));
        } else {
            visibleFiles.forEach(path => selectedFiles.delete(path));
        }
        updateCheckboxes();
        saveState();  // 保存状态
    }
    
    // 同样在文件项的点击事件中添加状态保存
    function initializeFileItemEvents() {
        document.querySelectorAll('.file-item').forEach(item => {
            const checkbox = item.querySelector('.file-checkbox');
            const diffButton = item.querySelector('.diff-button');
            const sideBySideButton = item.querySelector('.side-by-side-button');
            const revertButton = item.querySelector('.revert-button');
            const deleteButton = item.querySelector('.delete-button');
            const filePath = item.getAttribute('data-path');

            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    if (e.target.checked) {
                        selectedFiles.add(filePath);
                    } else {
                        selectedFiles.delete(filePath);
                    }
                    updateSelectAllCheckbox();
                    updateGroupSelectAllCheckboxes();
                    saveState();  // 保存状态
                });
            }

            if (diffButton) {
                diffButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showDiff(filePath);
                });
            }

            if (sideBySideButton) {
                sideBySideButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showSideBySideDiff(filePath);
                });
            }

            if (revertButton) {
                revertButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    revertFile(filePath);
                });
            }

            if (deleteButton) {
                deleteButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteUnversionedFiles([filePath]);
                });
            }

            // 双击文件项快速打开差异对比（issue #11）
            // 排除 checkbox / 操作按钮 / 链接等交互元素，避免误触发
            item.addEventListener('dblclick', (e) => {
                const target = e.target;
                if (target && target.closest && target.closest(
                    '.file-checkbox, .diff-button, .side-by-side-button, .revert-button, .delete-button, button, a, input'
                )) {
                    return;
                }
                // 防止双击选中文本造成视觉干扰
                if (window.getSelection) {
                    const sel = window.getSelection();
                    if (sel && sel.removeAllRanges) sel.removeAllRanges();
                }
                showDiff(filePath);
            });

            // 行选择（单选/Ctrl∨⌘+点击多选/Shift 区间选）
            item.addEventListener('mousedown', (e) => {
                // 右键由 contextmenu 事件处理，这里仅处理左键
                if (e.button !== 0) return;
                const target = e.target;
                if (target && target.closest && target.closest(
                    '.file-checkbox, .diff-button, .side-by-side-button, .revert-button, .delete-button, button, a, input'
                )) {
                    return;
                }
                applyRowSelection(filePath, e);
            });

            // 右键上下文菜单
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // 若右键的文件不在当前 active 中，先单选此文件
                if (!activeFiles.has(filePath)) {
                    activeFiles.clear();
                    activeFiles.add(filePath);
                    lastActivePath = filePath;
                    refreshActiveHighlights();
                }
                showContextMenu(e.clientX, e.clientY, filePath);
            });

            // 视觉提示：鼠标悬停时显示可双击
            item.style.cursor = item.style.cursor || 'default';
            item.title = item.title || '双击打开差异对比';
        });
    }
    
    function initializeExtensionFilter() {
        // 已合并到 group-filter，此处保留空函数避免报错
    }
    
    function initializeEventListeners() {
        // 类型过滤复选框
        document.getElementById('modified-checkbox').addEventListener('change', () => toggleFileType('modified'));
        document.getElementById('added-checkbox').addEventListener('change', () => toggleFileType('added'));
        document.getElementById('deleted-checkbox').addEventListener('change', () => toggleFileType('deleted'));
        document.getElementById('unversioned-checkbox').addEventListener('change', () => toggleFileType('unversioned'));
        document.getElementById('missing-checkbox').addEventListener('change', () => toggleFileType('missing'));
        // 仅锁定 复选框
        const lockedOnlyCb = document.getElementById('lockedOnly-checkbox');
        if (lockedOnlyCb) {
            lockedOnlyCb.checked = lockedOnly;
            lockedOnlyCb.addEventListener('change', () => {
                lockedOnly = lockedOnlyCb.checked;
                updateFileList();
                saveState();
            });
        }

        // 全选复选框
        document.getElementById('selectAll').addEventListener('change', (e) => toggleAllFiles(e.target.checked));

        // 历史提交记录选择
        document.getElementById('historySelect').addEventListener('change', selectHistoryLog);

        // 提交按钮
        document.getElementById('submitButton').addEventListener('click', submitCommit);
        document.getElementById('generateAIButton').addEventListener('click', generateAILog);

        // 分组筛选器
        initializeGroupFilter();

        // 初始化页面状态
        updateFileList();
        updateCheckboxes();

        // 首次加载时，默认全选所有可见文件
        if (previousState.selectedFiles.length === 0) {
            const allFiles = Array.from(document.querySelectorAll('.file-item'))
                .filter(item => item.style.display !== 'none')
                .map(item => item.getAttribute('data-path'));
            allFiles.forEach(path => selectedFiles.add(path));
            updateCheckboxes();
            saveState();
        }
    }

    function initializeGroupFilter() {
        const container = document.getElementById('groupTagsContainer');
        if (!container) return;

        // 如果没有保存过状态，默认全选
        const isFirstLoad = selectedGroups.size === 0 && selectedExtensions.size === 0;
        // 收集当前 DOM 中所有的筛选值，用于检测“新出现的标签”
        const currentGroupValues = new Set();
        const currentExtValues = new Set();
        container.querySelectorAll('.group-tag').forEach(tag => {
            const ft = tag.getAttribute('data-filter-type');
            if (ft === 'group') currentGroupValues.add(tag.getAttribute('data-group-value'));
            else if (ft === 'extension') currentExtValues.add(tag.getAttribute('data-extension'));
        });

        if (isFirstLoad) {
            container.querySelectorAll('.group-tag').forEach(tag => {
                const filterType = tag.getAttribute('data-filter-type');
                if (filterType === 'group') {
                    selectedGroups.add(tag.getAttribute('data-group-value'));
                } else if (filterType === 'extension') {
                    selectedExtensions.add(tag.getAttribute('data-extension'));
                }
                tag.classList.add('selected');
            });
            saveState();
        } else {
            // 非首次加载：对于 DOM 中新出现的标签默认选中
            // 包括特殊分组（__changes__ / __unversioned__）和新建/新发现的 changelist
            let mutated = false;
            container.querySelectorAll('.group-tag[data-filter-type="group"]').forEach(tag => {
                const val = tag.getAttribute('data-group-value');
                if (!selectedGroups.has(val)) {
                    selectedGroups.add(val);
                    mutated = true;
                }
            });
            if (mutated) saveState();
        }

        // 标签点击事件
        container.querySelectorAll('.group-tag').forEach(tag => {
            const filterType = tag.getAttribute('data-filter-type');

            // 恢复选中状态
            if (filterType === 'group') {
                const value = tag.getAttribute('data-group-value');
                if (selectedGroups.has(value)) { tag.classList.add('selected'); }
                else { tag.classList.remove('selected'); }
            } else if (filterType === 'extension') {
                const ext = tag.getAttribute('data-extension');
                if (selectedExtensions.has(ext)) { tag.classList.add('selected'); }
                else { tag.classList.remove('selected'); }
            }

            tag.addEventListener('click', () => {
                if (filterType === 'group') {
                    const value = tag.getAttribute('data-group-value');
                    if (selectedGroups.has(value)) {
                        selectedGroups.delete(value);
                        tag.classList.remove('selected');
                    } else {
                        selectedGroups.add(value);
                        tag.classList.add('selected');
                    }
                } else if (filterType === 'extension') {
                    const ext = tag.getAttribute('data-extension');
                    if (selectedExtensions.has(ext)) {
                        selectedExtensions.delete(ext);
                        tag.classList.remove('selected');
                    } else {
                        selectedExtensions.add(ext);
                        tag.classList.add('selected');
                    }
                }
                updateFileList();
                saveState();
            });
        });

        // 全选按钮
        const selectAllBtn = document.getElementById('selectAllGroups');
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', () => {
                container.querySelectorAll('.group-tag').forEach(tag => {
                    tag.classList.add('selected');
                    const ft = tag.getAttribute('data-filter-type');
                    if (ft === 'group') { selectedGroups.add(tag.getAttribute('data-group-value')); }
                    else if (ft === 'extension') { selectedExtensions.add(tag.getAttribute('data-extension')); }
                });
                updateFileList();
                saveState();
            });
        }

        // 清空按钮
        const clearAllBtn = document.getElementById('clearAllGroups');
        if (clearAllBtn) {
            clearAllBtn.addEventListener('click', () => {
                container.querySelectorAll('.group-tag').forEach(tag => {
                    tag.classList.remove('selected');
                });
                selectedGroups.clear();
                selectedExtensions.clear();
                updateFileList();
                saveState();
            });
        }
    }

    function updateFileList() {
        const fileItems = document.querySelectorAll('.file-item');
        let visibleCount = 0;

        fileItems.forEach(item => {
            const type = item.getAttribute('data-type');
            const fileName = item.querySelector('.file-name').textContent;
            const ext = fileName.includes('.') ?
                '.' + fileName.split('.').pop().toLowerCase() :
                '(无后缀)';
            const changelist = item.getAttribute('data-changelist') || '';

            const typeMatch = enabledTypes.has(type);
            const groupMatch = selectedGroups.has(changelist);
            const extensionMatch = selectedExtensions.size === 0 || selectedExtensions.has(ext);
            const lockedMatch = !lockedOnly || item.getAttribute('data-locked') === 'true';

            if (typeMatch && groupMatch && extensionMatch && lockedMatch) {
                item.style.display = '';
                visibleCount++;
            } else {
                item.style.display = 'none';
                const filePath = item.getAttribute('data-path');
                if (selectedFiles.has(filePath)) {
                    selectedFiles.delete(filePath);
                }
            }
        });

        // 隐藏空分组：Changes 和 changelist 始终显示（即使为空也保留作为拖拽靶区），unversioned 空时隐藏
        document.querySelectorAll('.changelist-group').forEach(group => {
            const visibleItems = group.querySelectorAll('.file-item');
            const hasVisible = Array.from(visibleItems).some(item => item.style.display !== 'none');
            const groupType = group.getAttribute('data-group-type');
            if (groupType === 'changes' || groupType === 'changelist') {
                group.style.display = '';
            } else {
                group.style.display = hasVisible ? '' : 'none';
            }
        });

        updateSelectAllCheckbox();
        updateGroupSelectAllCheckboxes();
    }

    function updateCheckboxes() {
        document.querySelectorAll('.file-item').forEach(item => {
            const filePath = item.getAttribute('data-path');
            const checkbox = item.querySelector('.file-checkbox');
            if (checkbox) {
                checkbox.checked = selectedFiles.has(filePath);
            }
        });
        updateSelectAllCheckbox();
        updateGroupSelectAllCheckboxes();
    }

    function updateSelectAllCheckbox() {
        const visibleFiles = Array.from(document.querySelectorAll('.file-item'))
            .filter(item => item.style.display !== 'none')
            .map(item => item.getAttribute('data-path'));
        
        const allChecked = visibleFiles.length > 0 && 
            visibleFiles.every(path => selectedFiles.has(path));
        
        const selectAllCheckbox = document.getElementById('selectAll');
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = allChecked;
            selectAllCheckbox.disabled = visibleFiles.length === 0;
        }
    }

    function updateGroupSelectAllCheckboxes() {
        document.querySelectorAll('.changelist-group').forEach(group => {
            const selectAllCb = group.querySelector('.group-select-all');
            if (!selectAllCb) return;
            const visibleFiles = Array.from(group.querySelectorAll('.file-item'))
                .filter(item => item.style.display !== 'none');
            if (visibleFiles.length === 0) { selectAllCb.checked = false; selectAllCb.indeterminate = false; return; }
            const allChecked = visibleFiles.every(item => selectedFiles.has(item.getAttribute('data-path')));
            const someChecked = visibleFiles.some(item => selectedFiles.has(item.getAttribute('data-path')));
            selectAllCb.checked = allChecked;
            selectAllCb.indeterminate = !allChecked && someChecked;
        });
    }

    function showDiff(filePath) {
        vscode.postMessage({ command: 'showDiff', file: filePath });
    }

    function showSideBySideDiff(filePath) {
        vscode.postMessage({ command: 'showSideBySideDiff', file: filePath });
    }

    function submitCommit() {
        const message = document.getElementById('commitMessage').value;
        if (!message) {
            vscode.postMessage({ 
                command: 'showError',
                text: '请输入提交信息'
            });
            return;
        }
        
        const selectedFilesList = Array.from(selectedFiles);
        if (selectedFilesList.length === 0) {
            vscode.postMessage({
                command: 'showError',
                text: '请选择要提交的文件'
            });
            return;
        }

        vscode.postMessage({
            command: 'commit',
            message: message,
            files: selectedFilesList
        });
    }

    function generateAILog() {
        vscode.postMessage({ command: 'generateAILog' });
    }

    function selectHistoryLog() {
        const select = document.getElementById('historySelect');
        const selectedValue = select.value;
        if (selectedValue) {
            document.getElementById('commitMessage').value = selectedValue;
        }
        select.selectedIndex = 0;
    }

    function revertFile(filePath) {
        vscode.postMessage({ command: 'revertFile', file: filePath });
    }

    function deleteUnversionedFiles(filePaths) {
        if (!filePaths || filePaths.length === 0) {
            return;
        }
        vscode.postMessage({ command: 'deleteUnversionedFiles', files: filePaths });
    }

    function revertFiles(filePaths) {
        if (!filePaths || filePaths.length === 0) return;
        if (filePaths.length === 1) {
            vscode.postMessage({ command: 'revertFile', file: filePaths[0] });
        } else {
            vscode.postMessage({ command: 'revertFiles', files: filePaths });
        }
    }

    // 按照动作过滤 active 文件（active 中可能包含不同类型）
    function getActivePathsByType(typeFilter) {
        return Array.from(document.querySelectorAll('.file-item'))
            .filter(el => activeFiles.has(el.getAttribute('data-path')))
            .filter(el => !typeFilter || typeFilter(el.getAttribute('data-type')))
            .map(el => el.getAttribute('data-path'));
    }

    // 在首屏可见列表中的序号（用于 Shift 区间选择）
    function getVisibleFilePaths() {
        return Array.from(document.querySelectorAll('.file-item'))
            .filter(el => el.style.display !== 'none')
            .map(el => el.getAttribute('data-path'));
    }

    function applyRowSelection(filePath, e) {
        const isCtrl = e.ctrlKey || e.metaKey;
        const isShift = e.shiftKey;
        if (isShift && lastActivePath && lastActivePath !== filePath) {
            const paths = getVisibleFilePaths();
            const a = paths.indexOf(lastActivePath);
            const b = paths.indexOf(filePath);
            if (a !== -1 && b !== -1) {
                const [s, t] = a < b ? [a, b] : [b, a];
                if (!isCtrl) activeFiles.clear();
                for (let i = s; i <= t; i++) activeFiles.add(paths[i]);
            }
        } else if (isCtrl) {
            if (activeFiles.has(filePath)) activeFiles.delete(filePath);
            else activeFiles.add(filePath);
            lastActivePath = filePath;
        } else {
            activeFiles.clear();
            activeFiles.add(filePath);
            lastActivePath = filePath;
        }
        refreshActiveHighlights();
    }

    function refreshActiveHighlights() {
        document.querySelectorAll('.file-item').forEach(el => {
            if (activeFiles.has(el.getAttribute('data-path'))) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });
    }

    function hideContextMenu() {
        const m = document.getElementById('fileContextMenu');
        if (m) m.remove();
    }

    function showContextMenu(x, y, anchorPath) {
        hideContextMenu();
        const activePaths = Array.from(activeFiles);
        if (activePaths.length === 0) return;

        // 收集每个选中文件的类型与当前 changelist
        const typeMap = new Map();
        const clMap = new Map();
        document.querySelectorAll('.file-item').forEach(el => {
            const p = el.getAttribute('data-path');
            typeMap.set(p, el.getAttribute('data-type'));
            // 从所在分组寻找 changelist：changelist 名 / __changes__ / __unversioned__
            const group = el.closest('.changelist-group');
            const groupType = group ? group.getAttribute('data-group-type') : null;
            const groupCL = group ? group.getAttribute('data-changelist') : null;
            let cl = null;
            if (groupType === 'changelist' && groupCL) cl = groupCL;
            clMap.set(p, cl); // changes/unversioned 为 null
        });
        const allUnversioned = activePaths.every(p => typeMap.get(p) === 'unversioned');
        const allVersioned = activePaths.every(p => typeMap.get(p) !== 'unversioned');
        const anchorType = typeMap.get(anchorPath);
        const anchorCanDiff = anchorType && anchorType !== 'deleted' && anchorType !== 'missing' && anchorType !== 'unversioned';

        // 收集所有现有 changelist（从页面上的分组节点）
        const allChangelists = Array.from(new Set(
            Array.from(document.querySelectorAll('.changelist-group[data-group-type="changelist"]'))
                .map(g => g.getAttribute('data-changelist'))
                .filter(Boolean)
        )).sort();

        // 选中文件当前的 changelist 集合
        const selectedCLs = new Set(activePaths.map(p => clMap.get(p)));
        const hasAnyCL = activePaths.some(p => !!clMap.get(p));
        // 若全部选中文件已在同一个 changelist X，则移动到 X 无意义
        const singleCL = selectedCLs.size === 1 ? Array.from(selectedCLs)[0] : null;

        const menu = document.createElement('div');
        menu.id = 'fileContextMenu';
        menu.className = 'context-menu';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        // 构造菜单项
        const items = [
            { key: 'diff', label: '查看差异', enabled: activePaths.length === 1 && anchorCanDiff },
            { key: 'revert', label: activePaths.length > 1 ? `恢复（${activePaths.length}）` : '恢复', enabled: allVersioned },
            { key: 'delete', label: activePaths.length > 1 ? `删除（${activePaths.length}）` : '删除', enabled: allUnversioned },
            { type: 'separator' }
        ];
        // 移动到已有 changelist
        allChangelists.forEach(cl => {
            if (cl === singleCL) return; // 已全部在该 changelist 中，跳过
            items.push({
                key: 'moveTo:' + cl,
                label: `移动到 “${cl}”`,
                enabled: true,
                action: () => moveToChangelist(activePaths, cl)
            });
        });
        // 移出到 Changes（选中文件中存在 changelist 的才有意义；unversioned 没有 changelist）
        if (hasAnyCL) {
            items.push({
                key: 'moveTo:__changes__',
                label: '移出到 Changes',
                enabled: true,
                action: () => moveToChangelist(activePaths, null)
            });
        }
        // 新建 Changelist
        items.push({
            key: 'newChangelist',
            label: '新建 Changelist…',
            enabled: true,
            action: () => {
                vscode.postMessage({ command: 'promptNewChangelist', files: activePaths });
            }
        });

        items.forEach(it => {
            if (it.type === 'separator') {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                menu.appendChild(sep);
                return;
            }
            const el = document.createElement('div');
            el.className = 'context-menu-item' + (it.enabled ? '' : ' disabled');
            el.textContent = it.label;
            if (it.enabled) {
                el.addEventListener('click', () => {
                    hideContextMenu();
                    if (it.action) { it.action(); return; }
                    if (it.key === 'diff') showDiff(anchorPath);
                    else if (it.key === 'revert') revertFiles(activePaths);
                    else if (it.key === 'delete') deleteUnversionedFiles(activePaths);
                });
            }
            menu.appendChild(el);
        });
        document.body.appendChild(menu);

        // 超过视窗边界时自动调整位置
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        if (rect.right > vw) menu.style.left = (vw - rect.width - 4) + 'px';
        if (rect.bottom > vh) menu.style.top = (vh - rect.height - 4) + 'px';
    }

    // 全局点击 / 滚动 / ESC 隐藏上下文菜单
    document.addEventListener('mousedown', (e) => {
        const m = document.getElementById('fileContextMenu');
        if (m && !m.contains(e.target)) hideContextMenu();
    });
    document.addEventListener('scroll', hideContextMenu, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

    /**
     * 发送拖拽移动消息
     * @param {string[]} filePaths 文件路径
     * @param {string|null} targetChangelist 目标 changelist 名称，null 表示移出到 Changes
     */
    function moveToChangelist(filePaths, targetChangelist) {
        if (!filePaths || filePaths.length === 0) {
            return;
        }
        vscode.postMessage({
            command: 'moveToChangelist',
            files: filePaths,
            targetChangelist: targetChangelist || null
        });
    }

    function updateExtensionFilter() {
        // 已合并到 TS 端 _renderGroupFilter，此处保留空函数避免报错
    }

    // 监听消息
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'setCommitMessage':
                const textarea = document.getElementById('commitMessage');
                const existing = textarea.value.trim();
                if (existing) {
                    textarea.value = existing + message.message;
                } else {
                    textarea.value = message.message;
                }
                break;
            case 'getSelectedFiles':
                vscode.postMessage({
                    command: 'selectedFiles',
                    files: Array.from(selectedFiles)
                });
                break;
            case 'getCurrentPrefix':
                vscode.postMessage({
                    command: 'currentPrefix',
                    prefix: ''
                });
                break;
            case 'setGeneratingStatus':
                const aiButton = document.getElementById('generateAIButton');
                if (message.status) {
                    aiButton.disabled = true;
                    aiButton.textContent = '生成中...';
                } else {
                    aiButton.disabled = false;
                    aiButton.textContent = '使用AI生成提交日志';
                }
                break;
        }
    });

    // 页面加载完成后初始化
    document.addEventListener('DOMContentLoaded', () => {
        initializeEventListeners();
        initializeFileItemEvents();
        initializeGroupCollapse();
        initializeGroupSelectAll();
        initializeChangelistDelete();
        initializeDragAndDrop();
        updateFileList();
        updateCheckboxes();
    });

    function initializeGroupCollapse() {
        document.querySelectorAll('.changelist-group').forEach(group => {
            const toggle = group.querySelector('.changelist-toggle');
            const groupId = group.getAttribute('data-group-id');

            if (!toggle || !groupId) return;

            // 恢复折叠状态
            if (collapsedGroups.has(groupId)) {
                group.classList.add('collapsed');
            }

            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const isCollapsed = group.classList.toggle('collapsed');
                if (isCollapsed) {
                    collapsedGroups.add(groupId);
                } else {
                    collapsedGroups.delete(groupId);
                }
                saveState();
            });
        });
    }

    function initializeGroupSelectAll() {
        document.querySelectorAll('.changelist-group').forEach(group => {
            const selectAllCb = group.querySelector('.group-select-all');
            if (!selectAllCb) return;

            selectAllCb.addEventListener('change', (e) => {
                e.stopPropagation();
                const checked = e.target.checked;
                const visibleFiles = Array.from(group.querySelectorAll('.file-item'))
                    .filter(item => item.style.display !== 'none');

                visibleFiles.forEach(item => {
                    const filePath = item.getAttribute('data-path');
                    const checkbox = item.querySelector('.file-checkbox');
                    if (checked) {
                        selectedFiles.add(filePath);
                        if (checkbox) checkbox.checked = true;
                    } else {
                        selectedFiles.delete(filePath);
                        if (checkbox) checkbox.checked = false;
                    }
                });

                updateSelectAllCheckbox();
                saveState();
            });
        });
    }

    /**
     * 绑定 changelist header 删除按钮事件
     * 点击后向 TS 发送 deleteChangelist 消息由后端弹模态对话框确认，文件将移入 Changes
     */
    function initializeChangelistDelete() {
        document.querySelectorAll('.changelist-group[data-group-type="changelist"]').forEach(group => {
            const btn = group.querySelector('.changelist-delete');
            if (!btn) return;
            const clName = group.getAttribute('data-changelist');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (!clName) return;
                vscode.postMessage({ command: 'deleteChangelist', changelist: clName });
            });
        });
    }

    function initializeBatchDelete() {
        document.querySelectorAll('.changelist-group[data-group-type="unversioned"]').forEach(group => {
            const btn = group.querySelector('.batch-delete-button');
            if (!btn) return;

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // 仅收集此分组中可见且已勾选的 unversioned 文件
                const items = Array.from(group.querySelectorAll('.file-item'))
                    .filter(item => item.style.display !== 'none')
                    .filter(item => item.getAttribute('data-type') === 'unversioned');

                const checkedPaths = items
                    .filter(item => {
                        const cb = item.querySelector('.file-checkbox');
                        return cb && cb.checked;
                    })
                    .map(item => item.getAttribute('data-path'));

                if (checkedPaths.length === 0) {
                    alert('请先在 Unversioned Files 分组中勾选要删除的文件');
                    return;
                }
                deleteUnversionedFiles(checkedPaths);
            });
        });
    }

    /**
     * 拖拽功能：支持将文件在 changelist / Changes 分组间移动
     * - 仅 data-type 非 unversioned 的文件可拖
     * - 不允许拖入 Unversioned Files 分组
     * - 若被拖的文件处于已勾选且勾选了多个同类型文件，则批量拖动
     */
    function initializeDragAndDrop() {
        // ---- 源端：file-item ----
        document.querySelectorAll('.file-item[draggable="true"]').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                const filePath = item.getAttribute('data-path');
                if (!filePath) return;

                // 多选拖动：如果当前项在行选中集（activeFiles）内，拖动所有 active 选中的文件
                // 勾选（selectedFiles）仅用于提交，不影响拖放
                let dragPaths;
                if (activeFiles.has(filePath)) {
                    dragPaths = Array.from(activeFiles);
                    if (dragPaths.length === 0) dragPaths = [filePath];
                } else {
                    dragPaths = [filePath];
                }

                e.dataTransfer.effectAllowed = 'move';
                try {
                    e.dataTransfer.setData('application/x-svn-files', JSON.stringify(dragPaths));
                    e.dataTransfer.setData('text/plain', dragPaths.join('\n'));
                } catch (err) {
                    // 忽略 setData 异常
                }
                item.classList.add('dragging');

                // 在 item 上存储，供 drop 时在同页面 fallback读取
                window.__svnDragPaths = dragPaths;
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                document.querySelectorAll('.changelist-group.drag-over, .changelist-group.drag-forbidden')
                    .forEach(g => g.classList.remove('drag-over', 'drag-forbidden'));
                window.__svnDragPaths = null;
            });
        });

        // ---- 目标端：分组容器 ----
        document.querySelectorAll('.changelist-group').forEach(group => {
            const groupType = group.getAttribute('data-group-type');

            group.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (groupType === 'unversioned') {
                    e.dataTransfer.dropEffect = 'none';
                    group.classList.add('drag-forbidden');
                    group.classList.remove('drag-over');
                } else {
                    e.dataTransfer.dropEffect = 'move';
                    group.classList.add('drag-over');
                    group.classList.remove('drag-forbidden');
                }
            });

            group.addEventListener('dragleave', (e) => {
                // 仅当离开的是分组本身时才清除（避免离开子元素时闪烁）
                if (e.target === group) {
                    group.classList.remove('drag-over', 'drag-forbidden');
                }
            });

            group.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                group.classList.remove('drag-over', 'drag-forbidden');

                if (groupType === 'unversioned') {
                    return; // 禁止拖入 Unversioned
                }

                // 解析拖拽数据
                let paths = [];
                try {
                    const raw = e.dataTransfer.getData('application/x-svn-files');
                    if (raw) paths = JSON.parse(raw);
                } catch (err) { /* ignore */ }
                if ((!paths || paths.length === 0) && window.__svnDragPaths) {
                    paths = window.__svnDragPaths;
                }
                if (!paths || paths.length === 0) return;

                // 计算目标 changelist：changelist 分组 → 该组名称；changes 分组 → null（移出）
                let targetChangelist = null;
                if (groupType === 'changelist') {
                    targetChangelist = group.getAttribute('data-changelist') || null;
                }
                moveToChangelist(paths, targetChangelist);
            });
        });
    }
})();
