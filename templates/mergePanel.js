(function () {
    const vscode = acquireVsCodeApi();

    // DOM 元素
    const branchSelect = document.getElementById('branchSelect');
    const refreshBtn = document.getElementById('refreshBranches');
    const manualUrl = document.getElementById('manualUrl');
    const selectModeDiv = document.getElementById('selectMode');
    const manualModeDiv = document.getElementById('manualMode');
    const revisionPicker = document.getElementById('revisionPicker');
    const revisionFilterInput = document.getElementById('revisionFilterInput');
    const hideMergedCheckbox = document.getElementById('hideMerged');
    const revSelectAll = document.getElementById('revSelectAll');
    const revisionListBody = document.getElementById('revisionListBody');
    const revisionSummary = document.getElementById('revisionSummary');
    const dryRunBtn = document.getElementById('dryRunBtn');
    const mergeBtn = document.getElementById('mergeBtn');
    const mergeStatus = document.getElementById('mergeStatus');
    const resultSection = document.getElementById('resultSection');
    const mergeOutput = document.getElementById('mergeOutput');
    const conflictSection = document.getElementById('conflictSection');
    const conflictCount = document.getElementById('conflictCount');
    const conflictList = document.getElementById('conflictList');
    const openCommitBtn = document.getElementById('openCommitBtn');

    // 状态
    let allRevisions = []; // { revision, author, date, message, merged, eligible }
    let selectedRevisions = new Set(); // 用户选中的版本号
    let lastClickedRev = null; // 最后一次点击的版本号，用于 shift 多选

    // 初始化
    document.addEventListener('DOMContentLoaded', () => {
        setupSourceModeToggle();
        setupRevisionModeToggle();
        setupBranchChangeHandler();
        setupFilterHandlers();
        setupButtons();
        vscode.postMessage({ command: 'listBranches' });
    });

    // 源模式切换
    function setupSourceModeToggle() {
        document.querySelectorAll('input[name="sourceMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (e.target.value === 'select') {
                    selectModeDiv.style.display = '';
                    manualModeDiv.style.display = 'none';
                } else {
                    selectModeDiv.style.display = 'none';
                    manualModeDiv.style.display = '';
                }
            });
        });
    }

    // 版本选择模式切换
    function setupRevisionModeToggle() {
        document.querySelectorAll('input[name="revisionMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                revisionPicker.style.display = e.target.value === 'pick' ? '' : 'none';
            });
        });
    }

    // 分支切换时加载版本日志
    function setupBranchChangeHandler() {
        branchSelect.addEventListener('change', () => {
            const sourceUrl = branchSelect.value;
            if (sourceUrl) {
                localStorage.setItem('svn-merge-last-branch', sourceUrl);
                loadRevisionsForSource(sourceUrl);
            } else {
                clearRevisionList();
            }
        });
        // 手动输入时，失去焦点加载
        manualUrl.addEventListener('blur', () => {
            const url = (manualUrl.value || '').trim();
            if (url) {
                loadRevisionsForSource(url);
            }
        });
    }

    function loadRevisionsForSource(sourceUrl) {
        allRevisions = [];
        selectedRevisions.clear();
        revisionListBody.innerHTML = '<div class="revision-empty">正在加载版本日志...</div>';
        revisionSummary.textContent = '';
        vscode.postMessage({ command: 'loadRevisions', sourceUrl });
    }

    function clearRevisionList() {
        allRevisions = [];
        selectedRevisions.clear();
        revisionListBody.innerHTML = '<div class="revision-empty">请先选择合并源分支</div>';
        revisionSummary.textContent = '';
    }

    // 过滤处理
    function setupFilterHandlers() {
        revisionFilterInput.addEventListener('input', () => renderRevisionList());
        hideMergedCheckbox.addEventListener('change', () => renderRevisionList());
        revSelectAll.addEventListener('change', () => {
            const visible = getVisibleEligibleRevisions();
            if (revSelectAll.checked) {
                visible.forEach(r => selectedRevisions.add(r.revision));
            } else {
                visible.forEach(r => selectedRevisions.delete(r.revision));
            }
            renderRevisionList();
        });
    }

    // 按钮事件
    function setupButtons() {
        refreshBtn.addEventListener('click', () => {
            branchSelect.innerHTML = '<option value="">-- 加载中... --</option>';
            vscode.postMessage({ command: 'listBranches' });
        });

        dryRunBtn.addEventListener('click', () => {
            const sourceUrl = getSourceUrl();
            if (!sourceUrl) { setStatus('请选择或输入合并源', 'error'); return; }
            const revisionRange = getRevisionRange();
            vscode.postMessage({ command: 'dryRun', sourceUrl, revisionRange });
        });

        mergeBtn.addEventListener('click', () => {
            const sourceUrl = getSourceUrl();
            if (!sourceUrl) { setStatus('请选择或输入合并源', 'error'); return; }
            const revisionRange = getRevisionRange();
            const revisionDetails = getRevisionDetails();
            vscode.postMessage({ command: 'merge', sourceUrl, revisionRange, revisionDetails });
        });

        openCommitBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'openCommitPanel' });
        });
    }

    function getSourceUrl() {
        const mode = document.querySelector('input[name="sourceMode"]:checked').value;
        if (mode === 'select') return branchSelect.value || '';
        return (manualUrl.value || '').trim();
    }

    // 获取版本范围：根据模式
    function getRevisionRange() {
        const mode = document.querySelector('input[name="revisionMode"]:checked').value;
        if (mode === 'all') return ''; // 合并全部

        // 手动选择版本模式：输出选中的版本号列表（逗号分隔）供 -c 参数使用
        if (selectedRevisions.size === 0) return '';
        const sorted = Array.from(selectedRevisions).sort((a, b) => a - b);
        return sorted.join(',');
    }

    // 获取选中版本的详细信息（版本号 + 提交日志），用于生成合并提交记录
    function getRevisionDetails() {
        const mode = document.querySelector('input[name="revisionMode"]:checked').value;
        if (mode === 'all') return null;
        if (selectedRevisions.size === 0) return null;

        const sorted = Array.from(selectedRevisions).sort((a, b) => a - b);
        return sorted.map(rev => {
            const entry = allRevisions.find(r => r.revision === rev);
            return {
                revision: rev,
                message: entry ? entry.message : ''
            };
        });
    }

    function setStatus(text, type) {
        mergeStatus.textContent = text;
        mergeStatus.className = 'merge-status ' + (type || '');
    }

    function setButtonsDisabled(disabled) {
        dryRunBtn.disabled = disabled;
        mergeBtn.disabled = disabled;
    }

    // 获取当前过滤后的可选版本
    function getVisibleEligibleRevisions() {
        const filterText = (revisionFilterInput.value || '').trim().toLowerCase();
        const hideMerged = hideMergedCheckbox.checked;
        return allRevisions.filter(r => {
            if (hideMerged && r.merged) return false;
            if (r.merged) return false; // 全选只考虑可选的
            if (!filterText) return true;
            return matchesFilter(r, filterText);
        });
    }

    function matchesFilter(rev, filterText) {
        const searchStr = `r${rev.revision} ${rev.author} ${rev.message} ${rev.date}`.toLowerCase();
        // 过滤语法：空格为 AND，+ 为 OR（优先级高于 AND）
        // 例如 "zz1 + zz2 6.0 + 6.1" 解析为 (zz1 OR zz2) AND (6.0 OR 6.1)
        // 先按空格拆分（保留 + 号），然后将相邻的 token 用 + 连接的合并为 OR 组
        const tokens = filterText.split(/\s+/).filter(Boolean);
        // 将 tokens 分组：用 + 号连接相邻项组成 OR 组
        const groups = []; // 每个 group 是一个 OR 数组
        let current = [];
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t === '+') {
                // + 号前后有空格的情况，下一个 token 加入当前 OR 组
                continue;
            }
            // 检查前一个 token 是否是 +，如果是则当前 token 加入同一个 OR 组
            if (i > 0 && tokens[i - 1] === '+') {
                current.push(t);
            } else {
                // 检查下一个 token 是否是 +，如果当前组非空先推入
                if (current.length > 0) {
                    groups.push(current);
                }
                current = [t];
            }
        }
        if (current.length > 0) groups.push(current);
        if (groups.length === 0) return true;
        // AND 逻辑：每个 group 内任一匹配即可（OR），所有 group 必须满足（AND）
        return groups.every(orGroup => orGroup.some(kw => searchStr.includes(kw)));
    }

    // 渲染版本列表
    function renderRevisionList() {
        const filterText = (revisionFilterInput.value || '').trim().toLowerCase();
        const hideMerged = hideMergedCheckbox.checked;

        const filtered = allRevisions.filter(r => {
            if (hideMerged && r.merged) return false;
            if (!filterText) return true;
            return matchesFilter(r, filterText);
        });

        if (filtered.length === 0) {
            revisionListBody.innerHTML = '<div class="revision-empty">无匹配的版本</div>';
            updateSummary();
            return;
        }

        let html = '';
        filtered.forEach(r => {
            const isMerged = r.merged;
            const isSelected = selectedRevisions.has(r.revision);
            const rowClass = ['revision-row'];
            if (isMerged) rowClass.push('merged');
            if (isSelected) rowClass.push('selected');
            const dateStr = formatDate(r.date);
            const msgEscaped = escapeHtml(r.message).replace(/\n/g, ' ');

            html += `<div class="${rowClass.join(' ')}" data-rev="${r.revision}" data-merged="${isMerged ? '1' : '0'}">
                <span class="rev-col-check"><input type="checkbox" ${isSelected ? 'checked' : ''} ${isMerged ? 'disabled' : ''}></span>
                <span class="rev-col-num">r${r.revision}</span>
                <span class="rev-col-author" title="${escapeHtml(r.author)}">${escapeHtml(r.author)}</span>
                <span class="rev-col-date" title="${escapeHtml(r.date)}">${dateStr}</span>
                <span class="rev-col-msg" title="${msgEscaped}">${msgEscaped}</span>
            </div>`;
        });

        revisionListBody.innerHTML = html;

        // 绑定行点击
        revisionListBody.querySelectorAll('.revision-row').forEach(row => {
            const rev = parseInt(row.getAttribute('data-rev'), 10);
            const isMerged = row.getAttribute('data-merged') === '1';
            if (isMerged) return; // 已合并不可选

            const cb = row.querySelector('input[type="checkbox"]');

            const handleClick = (e, fromCheckbox) => {
                const isShift = e.shiftKey;
                // 计算目标状态
                let targetChecked;
                if (fromCheckbox) {
                    targetChecked = cb.checked;
                } else {
                    targetChecked = !cb.checked;
                    cb.checked = targetChecked;
                }

                if (isShift && lastClickedRev !== null && lastClickedRev !== rev) {
                    // Shift 多选：从 lastClickedRev 到 rev 的所有可选版本都设为 targetChecked
                    applyShiftRange(lastClickedRev, rev, targetChecked);
                } else {
                    toggleRevision(rev, targetChecked);
                }
                lastClickedRev = rev;
            };

            row.addEventListener('click', (e) => {
                if (e.target === cb) return; // checkbox 自身处理
                handleClick(e, false);
            });
            cb.addEventListener('click', (e) => {
                // checkbox 点击，此时 cb.checked 已经是新值
                handleClick(e, true);
                e.stopPropagation();
            });
        });

        updateSummary();
        updateSelectAllState();
    }

    function toggleRevision(rev, checked) {
        if (checked) selectedRevisions.add(rev);
        else selectedRevisions.delete(rev);
        // 更新行样式
        const row = revisionListBody.querySelector(`[data-rev="${rev}"]`);
        if (row) {
            row.classList.toggle('selected', checked);
        }
        updateSummary();
        updateSelectAllState();
    }

    // Shift 多选：根据当前可见过滤后的版本列表，对 fromRev 和 toRev 之间的所有可选版本设置选中状态
    function applyShiftRange(fromRev, toRev, checked) {
        const visible = getVisibleEligibleRevisions();
        const fromIdx = visible.findIndex(r => r.revision === fromRev);
        const toIdx = visible.findIndex(r => r.revision === toRev);
        if (fromIdx === -1 || toIdx === -1) {
            // 找不到基准项，退化为单选
            toggleRevision(toRev, checked);
            return;
        }
        const start = Math.min(fromIdx, toIdx);
        const end = Math.max(fromIdx, toIdx);
        for (let i = start; i <= end; i++) {
            const r = visible[i];
            if (checked) selectedRevisions.add(r.revision);
            else selectedRevisions.delete(r.revision);
        }
        // 重新渲染以更新所有 checkbox
        renderRevisionList();
    }

    function updateSelectAllState() {
        const visible = getVisibleEligibleRevisions();
        if (visible.length === 0) {
            revSelectAll.checked = false;
            revSelectAll.indeterminate = false;
            return;
        }
        const allChecked = visible.every(r => selectedRevisions.has(r.revision));
        const someChecked = visible.some(r => selectedRevisions.has(r.revision));
        revSelectAll.checked = allChecked;
        revSelectAll.indeterminate = !allChecked && someChecked;
    }

    function updateSummary() {
        const total = allRevisions.filter(r => !r.merged).length;
        const selected = selectedRevisions.size;
        const merged = allRevisions.filter(r => r.merged).length;
        revisionSummary.textContent = `可合并: ${total} 个版本 | 已合并: ${merged} 个 | 已选择: ${selected} 个`;
    }

    function formatDate(isoDate) {
        if (!isoDate) return '';
        try {
            const d = new Date(isoDate);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const h = String(d.getHours()).padStart(2, '0');
            const min = String(d.getMinutes()).padStart(2, '0');
            return `${y}-${m}-${day} ${h}:${min}`;
        } catch { return isoDate.substring(0, 16); }
    }

    // 渲染分支列表
    function renderBranchList(branches, currentUrl) {
        branchSelect.innerHTML = '';
        if (branches.length === 0) {
            branchSelect.innerHTML = '<option value="">-- 未找到分支 --</option>';
            return;
        }
        branchSelect.innerHTML = '<option value="">-- 请选择合并源分支 --</option>';
        const groups = { trunk: [], branch: [], tag: [] };
        branches.forEach(b => {
            if (groups[b.type]) groups[b.type].push(b);
            else groups.branch.push(b);
        });

        // 倒序显示
        groups.branch.reverse();

        // Tags 排序：数字开头的倒序在前，非数字开头的放最后
        const tagDigit = groups.tag.filter(t => /^tags\/\d/.test(t.name));
        const tagNonDigit = groups.tag.filter(t => !/^tags\/\d/.test(t.name));
        tagDigit.reverse();
        tagNonDigit.reverse();
        groups.tag = [...tagDigit, ...tagNonDigit];

        function addGroup(label, items) {
            if (items.length === 0) return;
            const optgroup = document.createElement('optgroup');
            optgroup.label = label;
            items.forEach(item => {
                const opt = document.createElement('option');
                opt.value = item.url;
                opt.textContent = item.name;
                if (currentUrl && item.url === currentUrl) {
                    opt.textContent += ' (当前)';
                    opt.disabled = true;
                }
                optgroup.appendChild(opt);
            });
            branchSelect.appendChild(optgroup);
        }

        addGroup('Trunk', groups.trunk);
        addGroup('Branches', groups.branch);
        addGroup('Tags', groups.tag);

        // 恢复上次选择的分支
        const lastBranch = localStorage.getItem('svn-merge-last-branch') || '';
        if (lastBranch && branchSelect.querySelector(`option[value="${CSS.escape(lastBranch)}"]`)) {
            branchSelect.value = lastBranch;
            // 自动加载版本
            if (lastBranch) {
                loadRevisionsForSource(lastBranch);
            }
        }
    }

    // 渲染冲突列表
    function renderConflicts(conflicts) {
        if (!conflicts || conflicts.length === 0) {
            conflictSection.style.display = 'none';
            openCommitBtn.style.display = '';
            return;
        }
        conflictSection.style.display = '';
        conflictCount.textContent = conflicts.length;
        conflictList.innerHTML = '';
        openCommitBtn.style.display = 'none';

        conflicts.forEach(c => {
            const div = document.createElement('div');
            div.className = 'conflict-item';
            div.innerHTML = `
                <span class="conflict-icon">C</span>
                <span class="conflict-path" title="${escapeHtml(c.path)}">${escapeHtml(c.displayName)}</span>
                <span class="conflict-type">${c.conflictType}</span>
                <span class="conflict-resolve-btns">
                    <button class="btn btn-secondary" data-action="working" data-path="${escapeHtml(c.path)}">使用工作副本</button>
                    <button class="btn btn-secondary" data-action="mine-full" data-path="${escapeHtml(c.path)}">使用本地</button>
                    <button class="btn btn-secondary" data-action="theirs-full" data-path="${escapeHtml(c.path)}">使用合并方</button>
                </span>
            `;
            div.querySelectorAll('[data-action]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const action = btn.getAttribute('data-action');
                    const filePath = btn.getAttribute('data-path');
                    vscode.postMessage({ command: 'resolveConflict', filePath, resolution: action });
                    div.classList.add('resolved');
                    div.querySelectorAll('[data-action]').forEach(b => b.disabled = true);
                });
            });
            conflictList.appendChild(div);
        });
    }

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 监听后端消息
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.command) {
            case 'branchList':
                renderBranchList(msg.branches || [], msg.currentUrl);
                break;
            case 'revisionsLoading':
                revisionListBody.innerHTML = '<div class="revision-empty">正在加载版本日志...</div>';
                revisionSummary.textContent = '';
                break;
            case 'revisionList':
                allRevisions = msg.revisions || [];
                selectedRevisions.clear();
                renderRevisionList();
                break;
            case 'mergeStarted':
                setStatus('正在执行合并...', 'loading');
                setButtonsDisabled(true);
                resultSection.style.display = '';
                mergeOutput.textContent = '';
                conflictSection.style.display = 'none';
                break;
            case 'dryRunStarted':
                setStatus('正在预览合并...', 'loading');
                setButtonsDisabled(true);
                resultSection.style.display = '';
                mergeOutput.textContent = '';
                break;
            case 'mergeProgress':
                mergeOutput.textContent += msg.line + '\n';
                mergeOutput.scrollTop = mergeOutput.scrollHeight;
                break;
            case 'mergeResult':
                setButtonsDisabled(false);
                resultSection.style.display = '';
                mergeOutput.textContent = msg.output || '(无输出)';
                if (msg.success) {
                    setStatus('合并完成', 'success');
                } else {
                    setStatus('合并遇到问题', 'error');
                }
                renderConflicts(msg.conflicts);
                if (!msg.conflicts || msg.conflicts.length === 0) {
                    openCommitBtn.style.display = '';
                }
                break;
            case 'dryRunResult':
                setButtonsDisabled(false);
                resultSection.style.display = '';
                mergeOutput.textContent = msg.output || '(无变更)';
                setStatus('预览完成', 'success');
                break;
            case 'conflictList':
                renderConflicts(msg.conflicts);
                if (!msg.conflicts || msg.conflicts.length === 0) {
                    setStatus('所有冲突已解决', 'success');
                    openCommitBtn.style.display = '';
                }
                break;
            case 'error':
                setStatus(msg.message, 'error');
                setButtonsDisabled(false);
                break;
        }
    });
})();
