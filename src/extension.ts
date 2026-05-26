import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SvnService } from './svnService';
import { SvnDiffProvider } from './diffProvider';
import { SvnCommitPanel } from './commitPanel';
import { SvnUpdatePanel } from './updatePanel';
import { CommitLogStorage } from './commitLogStorage';
import { SvnFolderCommitPanel } from './folderCommitPanel';
import { SvnLogPanel } from './svnLogPanel';
import { SvnFilterService } from './filterService';
import { AiCacheService } from './aiCacheService';
import { AiService } from './aiService';
import { SvnCheckoutPanel } from './checkoutPanel';
import { SvnCheckoutConfigPanel } from './checkoutConfigPanel';
import { SvnAuthService } from './svnAuthService';
import { SvnAuthDialog } from './svnAuthDialog';
import { SvnConflictPanel } from './conflictPanel';
import { SvnMergePanel } from './mergePanel';

// SVN服务实例
let svnService: SvnService;
let diffProvider: SvnDiffProvider;
let logStorage: CommitLogStorage;
let filterService: SvnFilterService;
// 扩展根 URI，webview 面板加载本地资源时使用
let extensionRootUri: vscode.Uri;
// blame 临时文件路径 -> 行级 blame 元数据索引，供点击监听器使用
type BlameLineInfo = { rev: string; author: string; content: string };
type BlameLogInfo = { author: string; date: string; msg: string };
const blameContextMap = new Map<string, { lines: BlameLineInfo[]; logMap: Map<string, BlameLogInfo> }>();

/**
 * 上传文件到SVN
 * @param filePath 文件路径
 */
async function uploadFileToSvn(filePath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 获取文件状态
    const status = await svnService.getFileStatus(filePath);
    
    // 如果文件未在版本控制下，先添加到SVN
    if (status === '未版本控制') {
      await svnService.addFile(filePath);
      vscode.window.showInformationMessage(`文件已添加到SVN`);
    }
    
    // 提交文件
    const commitMessage = await vscode.window.showInputBox({
      prompt: '请输入提交信息',
      placeHolder: '描述您所做的更改'
    });
    
    if (commitMessage === undefined) {
      // 用户取消了操作
      return;
    }
    
    await svnService.commit(filePath, commitMessage);
    vscode.window.showInformationMessage(`文件已成功上传到SVN`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN上传失败: ${error.message}`);
  }
}

/**
 * 上传文件夹到SVN
 * @param folderPath 文件夹路径
 */
async function uploadFolderToSvn(folderPath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中。');
      return;
    }

    // 检查文件夹是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(folderPath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件夹不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );

      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(folderPath)) {
          vscode.window.showErrorMessage('文件夹仍不在SVN工作副本中，请检查设置的路径是否正确。');
          return;
        }
      } else {
        return;
      }
    }

    // 显示文件夹提交面板
    await SvnFolderCommitPanel.createOrShow(
      vscode.extensions.getExtension('vscode-svn')?.extensionUri || vscode.Uri.file(__dirname),
      folderPath,
      svnService,
      diffProvider,
      logStorage
    );
  } catch (error: any) {
    vscode.window.showErrorMessage('上传文件夹到SVN失败: ' + error.message);
  }
}

// 新UI界面和用户交互的占位函数
async function showFolderStatusUI(folderPath: string, fileStatuses: string[]): Promise<void> {
  // 需要实现显示文件夹状态的UI界面
  return Promise.resolve();
}

async function getUserCommitChoices(): Promise<{ selectedFiles: string[], commitMessage: string }> {
  // 需要实现获取用户的文件选择和提交信息的功能
  return Promise.resolve({ selectedFiles: [], commitMessage: '' });
}

/**
 * 提交文件到SVN（显示差异）
 * @param filePath 文件路径
 */
async function commitFileWithDiff(filePath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 获取文件状态
    const status = await svnService.getFileStatus(filePath);
    
    // 如果文件未在版本控制下，先添加到SVN
    if (status === '未版本控制') {
      const addToSvn = await vscode.window.showQuickPick(['是', '否'], {
        placeHolder: '文件未在SVN版本控制下，是否添加到SVN？'
      });
      
      if (addToSvn === '是') {
        await svnService.addFile(filePath);
        vscode.window.showInformationMessage(`文件已添加到SVN`);
      } else {
        return;
      }
    }
    
    // 显示提交面板
    await SvnCommitPanel.createOrShow(
      vscode.extensions.getExtension('vscode-svn')?.extensionUri || vscode.Uri.file(__dirname),
      filePath,
      svnService,
      diffProvider,
      logStorage
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN操作失败: ${error.message}`);
  }
}

/**
 * 设置SVN工作副本根目录
 * @param folderUri 文件夹URI（可选）
 */
async function setSvnWorkingCopyRoot(folderUri?: vscode.Uri): Promise<void> {
  try {
    let svnRootPath: string | undefined;
    
    // 如果没有提供文件夹URI，则让用户选择
    if (!folderUri) {
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '选择SVN工作副本根目录',
        title: '选择包含.svn目录的SVN工作副本根目录'
      });
      
      if (!folders || folders.length === 0) {
        return;
      }
      
      svnRootPath = folders[0].fsPath;
    } else {
      svnRootPath = folderUri.fsPath;
    }
    
    // 设置自定义SVN工作副本路径
    const success = await svnService.setCustomSvnRoot(svnRootPath);
    
    if (success) {
      vscode.window.showInformationMessage(`已成功设置SVN工作副本路径: ${svnRootPath}`);
    } else {
      vscode.window.showErrorMessage(`设置SVN工作副本路径失败，请确保选择的目录是有效的SVN工作副本（包含.svn目录）`);
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`设置SVN工作副本路径失败: ${error.message}`);
  }
}

/**
 * 清除SVN工作副本根目录设置
 */
async function clearSvnWorkingCopyRoot(): Promise<void> {
  try {
    await svnService.clearCustomSvnRoot();
    vscode.window.showInformationMessage('已清除SVN工作副本路径设置');
  } catch (error: any) {
    vscode.window.showErrorMessage(`清除SVN工作副本路径设置失败: ${error.message}`);
  }
}

/**
 * 更新文件
 * @param filePath 文件路径
 */
async function updateFile(filePath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 检查文件是否有本地修改
    const status = await svnService.getFileStatus(filePath);
    if (status !== '无修改' && status !== '未知状态') {
      const result = await vscode.window.showWarningMessage(
        `文件有本地修改 (${status})，更新可能会导致冲突。是否继续？`,
        '继续',
        '取消'
      );
      
      if (result !== '继续') {
        return;
      }
    }
    
    // 更新文件
    await svnService.update(filePath);
    vscode.window.showInformationMessage(`文件已成功更新`);
    
    // 刷新编辑器内容
    const documents = vscode.workspace.textDocuments;
    for (const doc of documents) {
      if (doc.uri.fsPath === filePath) {
        // 如果文件已打开，重新加载内容
        const edit = new vscode.WorkspaceEdit();
        const content = await vscode.workspace.fs.readFile(doc.uri);
        const text = Buffer.from(content).toString('utf8');
        
        edit.replace(
          doc.uri,
          new vscode.Range(
            new vscode.Position(0, 0),
            doc.lineAt(doc.lineCount - 1).range.end
          ),
          text
        );
        
        await vscode.workspace.applyEdit(edit);
        break;
      }
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN更新失败: ${error.message}`);
  }
}

/**
 * 更新目录或工作区
 * @param fsPath 文件系统路径
 */
async function updateDirectory(fsPath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查目录是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(fsPath)) {
      const result = await vscode.window.showErrorMessage(
        '该目录不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(fsPath)) {
          vscode.window.showErrorMessage('目录仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 显示更新面板
    await SvnUpdatePanel.createOrShow(
      vscode.extensions.getExtension('vscode-svn')?.extensionUri || vscode.Uri.file(__dirname),
      fsPath,
      svnService
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN更新失败: ${error.message}`);
  }
}

/**
 * 恢复文件到版本库状态
 * @param filePath 文件路径
 */
async function revertFile(filePath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }

    // 获取文件状态
    const status = await svnService.getFileStatus(filePath);
    
    // 如果文件未修改，提示用户
    if (status === '正常') {
      vscode.window.showInformationMessage('文件未修改，无需恢复');
      return;
    }

    // 确认是否要恢复文件
    const confirm = await vscode.window.showWarningMessage(
      '确定要恢复文件到版本库状态吗？这将丢失所有本地修改。',
      '确定',
      '取消'
    );

    if (confirm !== '确定') {
      return;
    }

    // 恢复文件
    await svnService.revertFile(filePath);
    vscode.window.showInformationMessage('文件已成功恢复到版本库状态');
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN操作失败: ${error.message}`);
  }
}

/**
 * 恢复文件夹到版本库状态
 * @param folderPath 文件夹路径
 */
async function revertFolder(folderPath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件夹是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(folderPath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件夹不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(folderPath)) {
          vscode.window.showErrorMessage('文件夹仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }

    // 确认是否要恢复文件夹
    const confirm = await vscode.window.showWarningMessage(
      `确定要恢复文件夹 "${path.basename(folderPath)}" 及其所有子文件和子文件夹到版本库状态吗？这将丢失所有本地修改，此操作不可撤销。`,
      { modal: true },
      '确定',
      '取消'
    );

    if (confirm !== '确定') {
      return;
    }

    // 恢复文件夹
    await svnService.revertFolder(folderPath);
    vscode.window.showInformationMessage('文件夹已成功恢复到版本库状态');
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN操作失败: ${error.message}`);
  }
}

/**
 * 查看SVN日志
 * @param fsPath 文件或文件夹路径
 */
async function viewSvnLog(fsPath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中（详细信息可查看输出面板 “SVN”）');
      return;
    }
    
    // 检查路径是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(fsPath)) {
      const result = await vscode.window.showErrorMessage(
        `该路径不在SVN工作副本中: ${fsPath}`,
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(fsPath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 打开SVN日志面板
    await SvnLogPanel.createOrShow(vscode.Uri.file(__dirname), fsPath, svnService);
  } catch (error: any) {
    vscode.window.showErrorMessage(`查看SVN日志失败: ${error.message}`);
  }
}

/**
 * 显示文件或文件夹的本地修订版本号
 * @param fsPath 文件或文件夹路径
 */
async function showLocalRevision(fsPath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(fsPath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(fsPath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 获取SVN信息
    try {
      // 使用SVN info命令获取版本信息
      const infoCommand = `info --xml "${fsPath}"`;
      const infoXml = await svnService.executeSvnCommand(infoCommand, require('path').dirname(fsPath), false);
      
      // 从XML中提取版本号
      const revisionMatch = /<commit\s+revision="([^"]+)">/.exec(infoXml) || 
                           /<entry\s+[^>]*?revision="([^"]+)"/.exec(infoXml);
      
      if (revisionMatch && revisionMatch[1]) {
        const localRevision = revisionMatch[1];
        
        // 显示本地版本号
        vscode.window.showInformationMessage(`本地修订版本号: ${localRevision}`);
      } else {
        vscode.window.showInformationMessage('未能获取本地修订版本号');
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`获取SVN信息失败: ${error.message}`);
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN操作失败: ${error.message}`);
  }
}

/**
 * 配置过滤规则
 */
async function configureFilter(): Promise<void> {
  try {
    const config = filterService.getExcludeConfig();
    
    // 显示配置选项
    const option = await vscode.window.showQuickPick([
      '配置排除文件模式',
      '配置排除文件夹',
      '查看当前配置',
      '重置为默认配置'
    ], {
      placeHolder: '选择要配置的选项'
    });
    
    if (!option) {
      return;
    }
    
    switch (option) {
      case '配置排除文件模式':
        await configureExcludeFiles();
        break;
      case '配置排除文件夹':
        await configureExcludeFolders();
        break;
      case '查看当前配置':
        filterService.showExcludeInfo();
        break;
      case '重置为默认配置':
        await resetFilterConfig();
        break;
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`配置过滤规则失败: ${error.message}`);
  }
}

/**
 * 配置排除文件模式
 */
async function configureExcludeFiles(): Promise<void> {
  const config = filterService.getExcludeConfig();
  const currentFiles = config.files.join(', ');
  
  const input = await vscode.window.showInputBox({
    prompt: '输入要排除的文件模式（支持glob模式，用逗号分隔）',
    value: currentFiles,
    placeHolder: '例如: *.log, *.tmp, node_modules, .DS_Store'
  });
  
  if (input !== undefined) {
    const files = input.split(',').map(f => f.trim()).filter(f => f.length > 0);
    await filterService.updateExcludeConfig(files, config.folders);
    vscode.window.showInformationMessage('文件排除模式已更新');
  }
}

/**
 * 配置排除文件夹
 */
async function configureExcludeFolders(): Promise<void> {
  const config = filterService.getExcludeConfig();
  const currentFolders = config.folders.join(', ');
  
  const input = await vscode.window.showInputBox({
    prompt: '输入要排除的文件夹名称（用逗号分隔）',
    value: currentFolders,
    placeHolder: '例如: node_modules, .git, .vscode, dist, build'
  });
  
  if (input !== undefined) {
    const folders = input.split(',').map(f => f.trim()).filter(f => f.length > 0);
    await filterService.updateExcludeConfig(config.files, folders);
    vscode.window.showInformationMessage('文件夹排除列表已更新');
  }
}

/**
 * 重置过滤配置为默认值
 */
async function resetFilterConfig(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    '确定要重置过滤配置为默认值吗？',
    '确定',
    '取消'
  );
  
  if (confirm === '确定') {
    const defaultFiles = ['*.log', '*.tmp', 'node_modules', '.DS_Store', 'Thumbs.db'];
    const defaultFolders = ['node_modules', '.git', '.vscode', 'dist', 'build', 'out', 'target'];
    
    await filterService.updateExcludeConfig(defaultFiles, defaultFolders);
    vscode.window.showInformationMessage('过滤配置已重置为默认值');
  }
}

/**
 * 显示过滤信息
 */
async function showFilterInfo(): Promise<void> {
  filterService.showExcludeInfo();
}

/**
 * 显示AI缓存统计信息
 */
async function showAICacheStats(): Promise<void> {
  try {
    const cacheService = AiCacheService.getInstance();
    const stats = cacheService.getCacheStats();
    
    const message = `AI缓存统计信息:
    
📊 缓存条目数: ${stats.totalEntries}
💾 缓存文件大小: ${stats.cacheSize}
📅 最旧条目: ${stats.oldestEntry}
📅 最新条目: ${stats.newestEntry}

缓存位置: ~/.vscode-svn-ai-cache/
过期时间: 30天`;
    
    const action = await vscode.window.showInformationMessage(
      message,
      '清理过期缓存',
      '清空所有缓存',
      '关闭'
    );
    
    if (action === '清理过期缓存') {
      await cleanExpiredAICache();
    } else if (action === '清空所有缓存') {
      await clearAICache();
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`获取缓存统计失败: ${error.message}`);
  }
}

/**
 * 清空AI缓存
 */
async function clearAICache(): Promise<void> {
  try {
    const confirm = await vscode.window.showWarningMessage(
      '确定要清空所有AI分析缓存吗？这将删除所有已保存的分析结果。',
      '确定',
      '取消'
    );
    
    if (confirm === '确定') {
      const cacheService = AiCacheService.getInstance();
      cacheService.clearAllCache();
      vscode.window.showInformationMessage('AI缓存已清空');
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`清空缓存失败: ${error.message}`);
  }
}

/**
 * 清理过期AI缓存
 */
async function cleanExpiredAICache(): Promise<void> {
  try {
    const cacheService = AiCacheService.getInstance();
    const removedCount = cacheService.cleanExpiredCache();
    
    if (removedCount > 0) {
      vscode.window.showInformationMessage(`已清理 ${removedCount} 条过期缓存记录`);
    } else {
      vscode.window.showInformationMessage('没有发现过期的缓存记录');
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`清理过期缓存失败: ${error.message}`);
  }
}

/**
 * 配置AI服务
 */
async function configureAI(): Promise<void> {
  try {
    // 使用AI服务类的配置引导功能
    const aiService = new AiService();
    const result = await aiService.configureAI();
    
    if (result) {
      vscode.window.showInformationMessage(
        '🎉 AI服务配置完成！\n\n现在可以使用AI功能生成SVN提交日志了。',
        { modal: true }
      );
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`❌ 配置AI服务失败: ${error.message}`);
  }
}

/**
 * SVN检出功能
 * @param folderUri 文件夹URI（可选）
 */
async function checkoutFromSvn(folderUri?: vscode.Uri): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }

    // 确定检出目标目录
    let targetDirectory: string;
    if (folderUri) {
      targetDirectory = folderUri.fsPath;
    } else {
      // 如果没有选择文件夹，使用当前工作区
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        targetDirectory = vscode.workspace.workspaceFolders[0].uri.fsPath;
      } else {
        vscode.window.showErrorMessage('请选择一个文件夹或打开工作区');
        return;
      }
    }

    // 显示检出配置面板
    await SvnCheckoutConfigPanel.createOrShow(
      vscode.extensions.getExtension('vscode-svn')?.extensionUri || vscode.Uri.file(__dirname),
      targetDirectory,
      svnService
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN检出失败: ${error.message}`);
  }
}

// ===================== 新增功能处理函数：Export / Import / Patch / Properties / Ignore / Copy / Move / Relocate / Branch&Tag / Repo Browser =====================

/**
 * SVN Export：导出干净副本（不含 .svn）
 */
async function svnExport(srcUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具');
      return;
    }
    let sourcePath: string | undefined = srcUri?.fsPath;
    if (!sourcePath) {
      const fromUrl = await vscode.window.showQuickPick(
        [
          { label: '从本地工作副本导出', value: 'local' },
          { label: '从远程 URL 导出', value: 'url' }
        ],
        { placeHolder: '选择导出源' }
      );
      if (!fromUrl) return;
      if (fromUrl.value === 'url') {
        const url = await vscode.window.showInputBox({ prompt: '输入仓库 URL', placeHolder: 'http://svn.example.com/svn/repo/trunk' });
        if (!url) return;
        sourcePath = url.trim();
      } else {
        if (!vscode.workspace.workspaceFolders?.length) {
          vscode.window.showErrorMessage('没有打开的工作区');
          return;
        }
        sourcePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      }
    }
    const targets = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择导出目录'
    });
    if (!targets || targets.length === 0) return;
    const targetDir = targets[0].fsPath;
    const baseName = /^[a-z]+:\/\//i.test(sourcePath) ? path.basename(sourcePath) : path.basename(sourcePath);
    const exportTo = path.join(targetDir, baseName);

    const revision = await vscode.window.showInputBox({
      prompt: '输入修订版本（可选，默认 HEAD）',
      placeHolder: '例如 1234 或留空使用 HEAD'
    });
    if (revision === undefined) return;

    const force = fs.existsSync(exportTo);
    if (force) {
      const ok = await vscode.window.showWarningMessage(`目标 ${exportTo} 已存在，是否强制覆盖？`, { modal: true }, '强制覆盖');
      if (ok !== '强制覆盖') return;
    }

    await svnService.exportPath(sourcePath, exportTo, revision.trim() || undefined, force);
    vscode.window.showInformationMessage(`SVN Export 完成: ${exportTo}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN Export 失败: ${error.message}`);
  }
}

/**
 * SVN Import：导入本地目录到仓库
 */
async function svnImport(folderUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具');
      return;
    }
    let localPath = folderUri?.fsPath;
    if (!localPath) {
      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '选择要导入的本地目录'
      });
      if (!picks || picks.length === 0) return;
      localPath = picks[0].fsPath;
    }
    const repoUrl = await vscode.window.showInputBox({
      prompt: '输入目标仓库 URL',
      placeHolder: 'http://svn.example.com/svn/repo/path/to/import'
    });
    if (!repoUrl) return;
    const message = await vscode.window.showInputBox({
      prompt: '输入提交信息',
      placeHolder: 'Initial import',
      validateInput: v => v.trim().length === 0 ? '提交信息不能为空' : null
    });
    if (!message) return;
    await svnService.importPath(localPath, repoUrl.trim(), message);
    vscode.window.showInformationMessage(`SVN Import 完成: ${repoUrl}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN Import 失败: ${error.message}`);
  }
}

/**
 * 创建 Patch
 */
async function svnCreatePatch(targetUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具');
      return;
    }
    let workPath = targetUri?.fsPath;
    if (!workPath) {
      if (vscode.window.activeTextEditor) {
        workPath = vscode.window.activeTextEditor.document.uri.fsPath;
      } else if (vscode.workspace.workspaceFolders?.length) {
        workPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      }
    }
    if (!workPath) {
      vscode.window.showErrorMessage('请选择文件或目录');
      return;
    }
    if (!await svnService.isInWorkingCopy(workPath)) {
      vscode.window.showErrorMessage('不在SVN工作副本中');
      return;
    }
    const defaultName = `${path.basename(workPath)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.patch`;
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)),
      filters: { 'Patch Files': ['patch', 'diff'], 'All Files': ['*'] },
      saveLabel: '保存 Patch 文件'
    });
    if (!saveUri) return;
    await svnService.createPatch(workPath, saveUri.fsPath);
    const open = await vscode.window.showInformationMessage(`Patch 已创建: ${saveUri.fsPath}`, '打开文件');
    if (open === '打开文件') {
      const doc = await vscode.workspace.openTextDocument(saveUri);
      await vscode.window.showTextDocument(doc);
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`创建 Patch 失败: ${error.message}`);
  }
}

/**
 * 应用 Patch
 */
async function svnApplyPatch(folderUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具');
      return;
    }
    let workPath = folderUri?.fsPath;
    if (!workPath && vscode.workspace.workspaceFolders?.length) {
      workPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    if (!workPath) {
      vscode.window.showErrorMessage('请选择目录');
      return;
    }
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: '选择 Patch 文件',
      filters: { 'Patch Files': ['patch', 'diff'], 'All Files': ['*'] }
    });
    if (!picks || picks.length === 0) return;
    await svnService.applyPatch(workPath, picks[0].fsPath);
    vscode.window.showInformationMessage(`Patch 应用完成`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`应用 Patch 失败: ${error.message}`);
  }
}

/**
 * 属性管理
 */
async function svnManageProperties(targetUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具');
      return;
    }
    let target = targetUri?.fsPath;
    if (!target) {
      if (vscode.window.activeTextEditor) target = vscode.window.activeTextEditor.document.uri.fsPath;
      else if (vscode.workspace.workspaceFolders?.length) target = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    if (!target) { vscode.window.showErrorMessage('请选择文件或目录'); return; }
    if (!await svnService.isInWorkingCopy(target)) { vscode.window.showErrorMessage('不在SVN工作副本中'); return; }

    while (true) {
      const props = await svnService.propList(target);
      type PropItem = vscode.QuickPickItem & { action?: string; propName?: string };
      const items: PropItem[] = [
        { label: '$(add) 添加属性…', description: '设置新属性名与值', action: 'add' },
        { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
        ...props.map<PropItem>(p => ({
          label: `$(symbol-property) ${p.name}`,
          description: p.value.length > 80 ? p.value.slice(0, 80) + '…' : p.value,
          propName: p.name,
          action: 'edit'
        }))
      ];
      if (props.length === 0) {
        items.push({ label: '(当前没有属性)', description: target } as any);
      }
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `${path.basename(target)} 的属性（选择属性查看/编辑）`,
        matchOnDescription: true
      });
      if (!picked) return;
      if (picked.action === 'add') {
        const name = await vscode.window.showInputBox({ prompt: '属性名（例如 svn:ignore、svn:eol-style）' });
        if (!name) continue;
        const value = await vscode.window.showInputBox({ prompt: `${name} 的值`, placeHolder: '多行请使用 \\n' });
        if (value === undefined) continue;
        await svnService.propSet(target, name.trim(), value.replace(/\\n/g, '\n'));
        vscode.window.showInformationMessage(`已设置属性 ${name}`);
      } else if (picked.action === 'edit' && picked.propName) {
        const op = await vscode.window.showQuickPick(
          [
            { label: '$(edit) 修改值', value: 'edit' },
            { label: '$(eye) 查看完整值', value: 'view' },
            { label: '$(trash) 删除属性', value: 'delete' }
          ],
          { placeHolder: `${picked.propName} 操作` }
        );
        if (!op) continue;
        if (op.value === 'view') {
          const v = await svnService.propGet(target, picked.propName);
          const doc = await vscode.workspace.openTextDocument({ content: v, language: 'plaintext' });
          await vscode.window.showTextDocument(doc);
        } else if (op.value === 'edit') {
          const current = await svnService.propGet(target, picked.propName);
          const newVal = await vscode.window.showInputBox({
            prompt: `修改 ${picked.propName}`,
            value: current.replace(/\n/g, '\\n'),
            placeHolder: '多行请使用 \\n'
          });
          if (newVal === undefined) continue;
          await svnService.propSet(target, picked.propName, newVal.replace(/\\n/g, '\n'));
          vscode.window.showInformationMessage(`属性 ${picked.propName} 已更新`);
        } else if (op.value === 'delete') {
          const ok = await vscode.window.showWarningMessage(`确认删除属性 ${picked.propName}？`, { modal: true }, '确认删除');
          if (ok !== '确认删除') continue;
          await svnService.propDel(target, picked.propName);
          vscode.window.showInformationMessage(`属性 ${picked.propName} 已删除`);
        }
      }
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`属性管理失败: ${error.message}`);
  }
}

/**
 * 添加到 svn:ignore
 */
async function svnAddIgnore(itemUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具');
      return;
    }
    let target = itemUri?.fsPath;
    if (!target && vscode.window.activeTextEditor) target = vscode.window.activeTextEditor.document.uri.fsPath;
    if (!target) { vscode.window.showErrorMessage('请选择文件或目录'); return; }
    const stat = fs.statSync(target);
    const parentDir = stat.isDirectory() ? path.dirname(target) : path.dirname(target);
    const baseName = path.basename(target);
    if (!await svnService.isInWorkingCopy(parentDir)) { vscode.window.showErrorMessage('父目录不在SVN工作副本中'); return; }
    const pattern = await vscode.window.showInputBox({
      prompt: `添加到 ${parentDir} 的 svn:ignore`,
      value: baseName,
      placeHolder: '可使用 glob，例如 *.log'
    });
    if (!pattern) return;
    await svnService.addIgnore(parentDir, pattern.trim());
    vscode.window.showInformationMessage(`已添加到 svn:ignore: ${pattern}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`添加到 svn:ignore 失败: ${error.message}`);
  }
}

/**
 * SVN Copy
 */
async function svnCopyPath(srcUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) { vscode.window.showErrorMessage('未检测到SVN命令行工具'); return; }
    let src = srcUri?.fsPath;
    if (!src && vscode.window.activeTextEditor) src = vscode.window.activeTextEditor.document.uri.fsPath;
    if (!src) { vscode.window.showErrorMessage('请选择源文件/目录'); return; }
    if (!await svnService.isInWorkingCopy(src)) { vscode.window.showErrorMessage('源不在SVN工作副本中'); return; }
    const stat = fs.statSync(src);
    const dst = await vscode.window.showInputBox({
      prompt: 'SVN Copy 目标路径',
      value: src + (stat.isDirectory() ? '-copy' : '.copy'),
      placeHolder: '本地路径或 svn URL'
    });
    if (!dst) return;
    await svnService.copyPath(src, dst.trim());
    vscode.window.showInformationMessage(`SVN Copy 完成: ${dst}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN Copy 失败: ${error.message}`);
  }
}

/**
 * SVN Move / Rename
 */
async function svnMovePath(srcUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) { vscode.window.showErrorMessage('未检测到SVN命令行工具'); return; }
    let src = srcUri?.fsPath;
    if (!src && vscode.window.activeTextEditor) src = vscode.window.activeTextEditor.document.uri.fsPath;
    if (!src) { vscode.window.showErrorMessage('请选择源文件/目录'); return; }
    if (!await svnService.isInWorkingCopy(src)) { vscode.window.showErrorMessage('源不在SVN工作副本中'); return; }
    const op = await vscode.window.showQuickPick(
      [
        { label: '$(edit) 重命名（同目录）', value: 'rename' },
        { label: '$(arrow-right) 移动到其他路径', value: 'move' }
      ],
      { placeHolder: '选择操作' }
    );
    if (!op) return;
    let dst: string | undefined;
    if (op.value === 'rename') {
      const newName = await vscode.window.showInputBox({ prompt: '新名称', value: path.basename(src) });
      if (!newName) return;
      dst = path.join(path.dirname(src), newName.trim());
    } else {
      dst = await vscode.window.showInputBox({ prompt: '目标路径', value: src, placeHolder: '完整路径或 URL' });
      if (!dst) return;
    }
    await svnService.movePath(src, dst.trim());
    vscode.window.showInformationMessage(`SVN Move 完成: ${dst}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN Move 失败: ${error.message}`);
  }
}

/**
 * SVN Relocate
 */
async function svnRelocate(folderUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) { vscode.window.showErrorMessage('未检测到SVN命令行工具'); return; }
    let folder = folderUri?.fsPath;
    if (!folder && vscode.workspace.workspaceFolders?.length) folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    if (!folder) { vscode.window.showErrorMessage('请选择目录'); return; }
    if (!await svnService.isInWorkingCopy(folder)) { vscode.window.showErrorMessage('不在SVN工作副本中'); return; }
    const currentUrl = await svnService.getCurrentUrl(folder);
    const newUrl = await vscode.window.showInputBox({
      prompt: '输入新 URL',
      value: currentUrl,
      placeHolder: '例如 https://new-server.example.com/svn/repo/trunk'
    });
    if (!newUrl || newUrl.trim() === currentUrl) return;
    const ok = await vscode.window.showWarningMessage(
      `将工作副本重定位：\n从: ${currentUrl}\n到: ${newUrl}`,
      { modal: true }, '确认'
    );
    if (ok !== '确认') return;
    await svnService.relocate(folder, newUrl.trim());
    vscode.window.showInformationMessage('SVN Relocate 完成');
  } catch (error: any) {
    vscode.window.showErrorMessage(`Relocate 失败: ${error.message}`);
  }
}

/**
 * 创建分支 / Tag
 */
async function svnCreateBranchTag(folderUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) { vscode.window.showErrorMessage('未检测到SVN命令行工具'); return; }
    let folder = folderUri?.fsPath;
    if (!folder && vscode.workspace.workspaceFolders?.length) folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    if (!folder) { vscode.window.showErrorMessage('请选择目录'); return; }
    if (!await svnService.isInWorkingCopy(folder)) { vscode.window.showErrorMessage('不在SVN工作副本中'); return; }

    const kindPick = await vscode.window.showQuickPick(
      [
        { label: '$(repo-forked) 创建分支 (Branch)', value: 'branches' },
        { label: '$(tag) 创建标签 (Tag)', value: 'tags' }
      ],
      { placeHolder: '选择创建类型' }
    );
    if (!kindPick) return;

    const repoRoot = await svnService.getRepoRoot(folder);
    const currentUrl = await svnService.getCurrentUrl(folder);

    const name = await vscode.window.showInputBox({
      prompt: kindPick.value === 'branches' ? '分支名称' : 'Tag 名称',
      placeHolder: '例如 v1.0.0 或 feature-x',
      validateInput: v => v.trim().length === 0 ? '名称不能为空' : null
    });
    if (!name) return;

    const dstUrl = `${repoRoot.replace(/\/$/, '')}/${kindPick.value}/${name.trim()}`;

    const srcChoice = await vscode.window.showQuickPick(
      [
        { label: '从当前 URL 创建', description: currentUrl, value: 'current' },
        { label: '从 HEAD 主干创建', description: `${repoRoot.replace(/\/$/, '')}/trunk`, value: 'trunk' },
        { label: '自定义源 URL…', value: 'custom' }
      ],
      { placeHolder: '选择源' }
    );
    if (!srcChoice) return;
    let srcUrl = currentUrl;
    if (srcChoice.value === 'trunk') srcUrl = `${repoRoot.replace(/\/$/, '')}/trunk`;
    else if (srcChoice.value === 'custom') {
      const v = await vscode.window.showInputBox({ prompt: '输入源 URL', value: currentUrl });
      if (!v) return;
      srcUrl = v.trim();
    }

    const message = await vscode.window.showInputBox({
      prompt: '提交信息',
      value: kindPick.value === 'branches' ? `Create branch ${name}` : `Create tag ${name}`,
      validateInput: v => v.trim().length === 0 ? '不能为空' : null
    });
    if (!message) return;

    await svnService.createBranchOrTag(folder, srcUrl, dstUrl, message);
    vscode.window.showInformationMessage(`已创建: ${dstUrl}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`创建分支/Tag 失败: ${error.message}`);
  }
}

/**
 * 仓库浏览器：快速浏览 SVN 仓库目录结构
 */
async function svnRepoBrowser(folderUri?: vscode.Uri): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) { vscode.window.showErrorMessage('未检测到SVN命令行工具'); return; }
    let startUrl: string | undefined;
    let folder = folderUri?.fsPath;
    if (!folder && vscode.workspace.workspaceFolders?.length) folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    if (folder && await svnService.isInWorkingCopy(folder)) {
      try {
        startUrl = await svnService.getRepoRoot(folder);
      } catch { /* ignore */ }
    }
    if (!startUrl) {
      const v = await vscode.window.showInputBox({ prompt: '输入仓库 URL', placeHolder: 'http://svn.example.com/svn/repo' });
      if (!v) return;
      startUrl = v.trim();
    }

    let currentUrl = startUrl;
    while (true) {
      let entries: string[] = [];
      try {
        entries = await svnService.listRepo(currentUrl);
      } catch (error: any) {
        vscode.window.showErrorMessage(`列出失败: ${error.message}`);
        return;
      }
      type Item = vscode.QuickPickItem & { value: string; isDir?: boolean; isUp?: boolean; action?: string };
      const items: Item[] = [];
      // 返回上级
      if (currentUrl.replace(/\/$/, '') !== startUrl.replace(/\/$/, '')) {
        items.push({ label: '$(arrow-up) ..  返回上一级', value: '..', isUp: true });
      }
      // 操作
      items.push({ label: '$(file-directory) 使用当前路径检出…', value: currentUrl, action: 'checkout' });
      items.push({ label: '$(history) 查看当前路径日志…', value: currentUrl, action: 'log' });
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator } as any);
      for (const entry of entries) {
        const isDir = entry.endsWith('/');
        items.push({
          label: (isDir ? '$(folder) ' : '$(file) ') + entry,
          value: entry,
          isDir
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: currentUrl,
        matchOnDescription: true
      });
      if (!picked) return;
      if (picked.isUp) {
        currentUrl = currentUrl.replace(/\/$/, '').replace(/\/[^/]+$/, '');
        continue;
      }
      if (picked.action === 'checkout') {
        await vscode.commands.executeCommand('vscode-svn.checkout');
        return;
      }
      if (picked.action === 'log') {
        vscode.env.clipboard.writeText(currentUrl);
        vscode.window.showInformationMessage(`URL 已复制到剪贴板: ${currentUrl}`);
        return;
      }
      if (picked.isDir) {
        currentUrl = `${currentUrl.replace(/\/$/, '')}/${picked.value.replace(/\/$/, '')}`;
        continue;
      }
      // 文件：提供复制 URL、查看内容选项
      const fileOp = await vscode.window.showQuickPick(
        [
          { label: '$(clippy) 复制 URL', value: 'copy' },
          { label: '$(eye) 查看文件内容（svn cat）', value: 'cat' }
        ],
        { placeHolder: `文件: ${picked.value}` }
      );
      if (!fileOp) continue;
      const fileUrl = `${currentUrl.replace(/\/$/, '')}/${picked.value}`;
      if (fileOp.value === 'copy') {
        await vscode.env.clipboard.writeText(fileUrl);
        vscode.window.showInformationMessage(`已复制: ${fileUrl}`);
      } else if (fileOp.value === 'cat') {
        try {
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.tmpdir();
          const content = await svnService.executeSvnCommand(`cat "${fileUrl}"`, cwd);
          const doc = await vscode.workspace.openTextDocument({ content, language: 'plaintext' });
          await vscode.window.showTextDocument(doc);
        } catch (e: any) {
          vscode.window.showErrorMessage(`查看失败: ${e.message}`);
        }
      }
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`仓库浏览失败: ${error.message}`);
  }
}

/**
 * 锁定文件（svn lock）
 * @param filePath 文件路径
 */
async function lockFile(filePath: string): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }

    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );

      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }

    // 检查文件状态：未版本控制的文件无法锁定
    const status = await svnService.getFileStatus(filePath);
    if (status === '未版本控制') {
      vscode.window.showErrorMessage('文件尚未加入SVN版本控制，无法锁定');
      return;
    }

    // 提示是否检查远程锁定状态（只读检测，不阻塞流程）
    let alreadyLockedByOther = false;
    try {
      const lockInfo = await svnService.getLockInfo(filePath);
      if (lockInfo.locked) {
        alreadyLockedByOther = true;
        const lockMsg = `文件当前已被锁定。\n锁定者: ${lockInfo.owner || '未知'}` +
          (lockInfo.comment ? `\n备注: ${lockInfo.comment}` : '') +
          (lockInfo.created ? `\n时间: ${lockInfo.created}` : '');
        const choice = await vscode.window.showWarningMessage(
          lockMsg,
          { modal: true },
          '强制锁定（夺取）',
          '取消'
        );
        if (choice !== '强制锁定（夺取）') {
          return;
        }
      }
    } catch (error: any) {
      // 远程检测失败不阻塞操作，仅提示
      vscode.window.showWarningMessage(`无法检测远程锁定状态：${error.message}，将继续尝试锁定`);
    }

    // 询问锁定备注
    const lockMessage = await vscode.window.showInputBox({
      prompt: '请输入锁定备注（可选）',
      placeHolder: '描述锁定该文件的原因，便于团队成员了解'
    });

    // 用户按 ESC 取消
    if (lockMessage === undefined) {
      return;
    }

    await svnService.lockFile(filePath, lockMessage, alreadyLockedByOther);
    vscode.window.showInformationMessage(`文件已成功锁定: ${path.basename(filePath)}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN锁定失败: ${error.message}`);
  }
}

/**
 * 解锁文件（svn unlock）
 * @param filePath 文件路径
 */
async function unlockFile(filePath: string): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }

    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );

      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }

    // 检测锁定状态：判断是否需要强制解锁
    let needForce = false;
    try {
      const lockInfo = await svnService.getLockInfo(filePath);
      if (!lockInfo.locked) {
        vscode.window.showInformationMessage('该文件当前未被锁定，无需解锁');
        return;
      }

      // 如果锁的拥有者并非当前用户，提示是否强制解锁
      if (lockInfo.isCurrentUser === false) {
        const lockMsg = `该文件被其他用户锁定。\n锁定者: ${lockInfo.owner || '未知'}` +
          (lockInfo.comment ? `\n备注: ${lockInfo.comment}` : '') +
          (lockInfo.created ? `\n时间: ${lockInfo.created}` : '') +
          '\n\n是否强制解除该锁？';
        const choice = await vscode.window.showWarningMessage(
          lockMsg,
          { modal: true },
          '强制解锁',
          '取消'
        );
        if (choice !== '强制解锁') {
          return;
        }
        needForce = true;
      }
    } catch (error: any) {
      // 检测失败仅提示，不阻塞解锁尝试
      vscode.window.showWarningMessage(`无法检测远程锁定状态：${error.message}，将继续尝试解锁`);
    }

    await svnService.unlockFile(filePath, needForce);
    vscode.window.showInformationMessage(`文件已成功解锁: ${path.basename(filePath)}`);
  } catch (error: any) {
    // 当锁不属于当前用户时 svn 会报错，自动提示是否强制解锁
    const msg: string = error?.message || '';
    if (/locked by|is not locked|410|not locked in this working copy/i.test(msg)) {
      const choice = await vscode.window.showWarningMessage(
        `解锁失败：${msg}\n\n是否尝试强制解锁？`,
        { modal: true },
        '强制解锁',
        '取消'
      );
      if (choice === '强制解锁') {
        try {
          await svnService.unlockFile(filePath, true);
          vscode.window.showInformationMessage(`文件已成功强制解锁: ${path.basename(filePath)}`);
          return;
        } catch (err2: any) {
          vscode.window.showErrorMessage(`SVN强制解锁失败: ${err2.message}`);
          return;
        }
      }
      return;
    }
    vscode.window.showErrorMessage(`SVN解锁失败: ${error.message}`);
  }
}

/**
 * 显示文件的锁定信息
 * @param filePath 文件路径
 */
async function showLockInfo(filePath: string): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }

    if (!await svnService.isInWorkingCopy(filePath)) {
      vscode.window.showErrorMessage('该文件不在SVN工作副本中');
      return;
    }

    const lockInfo = await svnService.getLockInfo(filePath);
    if (!lockInfo.locked) {
      vscode.window.showInformationMessage(`文件 "${path.basename(filePath)}" 当前未被锁定`);
      return;
    }

    const detail = [
      `文件: ${path.basename(filePath)}`,
      `锁定者: ${lockInfo.owner || '未知'}`,
      lockInfo.created ? `锁定时间: ${lockInfo.created}` : '',
      lockInfo.comment ? `锁定备注: ${lockInfo.comment}` : '',
      lockInfo.isCurrentUser !== undefined
        ? `锁定者${lockInfo.isCurrentUser ? '是' : '不是'}当前用户`
        : ''
    ].filter(Boolean).join('\n');

    const action = await vscode.window.showInformationMessage(
      detail,
      { modal: true },
      '解锁此文件',
      '关闭'
    );
    if (action === '解锁此文件') {
      await unlockFile(filePath);
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`获取锁定信息失败: ${error.message}`);
  }
}

/**
 * 将文件添加到 Changelist
 * @param filePath 文件路径
 */
async function addFileToChangelist(filePath: string): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }

    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }

    // 检查文件状态
    const status = await svnService.getFileStatus(filePath);
    if (status === '正常' || status === '未知状态') {
      vscode.window.showInformationMessage('文件没有修改，无需添加到 changelist');
      return;
    }

    // 获取已有的 changelist
    const cwd = path.dirname(filePath);
    const existingChangelists = await svnService.getChangelists(cwd);

    // 让用户选择或输入 changelist 名称
    const quickPickItems = [
      ...existingChangelists.map(name => ({ label: name, description: '现有 changelist' })),
      { label: '$(add) 新建 changelist...', description: '创建新的 changelist' }
    ];

    const selected = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder: '选择或创建 changelist'
    });

    if (!selected) {
      return;
    }

    let changelistName: string;
    if (selected.label === '$(add) 新建 changelist...') {
      const input = await vscode.window.showInputBox({
        prompt: '请输入新的 changelist 名称',
        placeHolder: '例如: feature-login, bugfix-123',
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'changelist 名称不能为空';
          }
          if (value.includes('"') || value.includes('\'')) {
            return 'changelist 名称不能包含引号';
          }
          return null;
        }
      });
      if (!input) {
        return;
      }
      changelistName = input.trim();
    } else {
      changelistName = selected.label;
    }

    await svnService.addToChangelist(filePath, changelistName);
    vscode.window.showInformationMessage(`文件已添加到 changelist "${changelistName}"`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`添加到 changelist 失败: ${error.message}`);
  }
}

/**
 * 将文件从 Changelist 中移除
 * @param filePath 文件路径
 */
async function removeFileFromChangelist(filePath: string): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }

    if (!await svnService.isInWorkingCopy(filePath)) {
      vscode.window.showErrorMessage('该文件不在SVN工作副本中');
      return;
    }

    const currentChangelist = await svnService.getFileChangelist(filePath);
    if (!currentChangelist) {
      vscode.window.showInformationMessage('该文件不在任何 changelist 中');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `确定将文件从 changelist "${currentChangelist}" 中移除？`,
      '确定',
      '取消'
    );

    if (confirm !== '确定') {
      return;
    }

    await svnService.removeFromChangelist(filePath);
    vscode.window.showInformationMessage('文件已从 changelist 中移除');
  } catch (error: any) {
    vscode.window.showErrorMessage(`从 changelist 移除失败: ${error.message}`);
  }
}

/**
 * 查看并管理 Changelist
 */
async function manageChangelists(): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }

    // 获取工作区路径
    let basePath: string;
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      basePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    } else {
      vscode.window.showErrorMessage('没有打开的工作区');
      return;
    }

    if (!await svnService.isInWorkingCopy(basePath)) {
      const result = await vscode.window.showErrorMessage(
        '当前工作区不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
      }
      return;
    }

    const changelists = await svnService.getChangelists(basePath);
    if (changelists.length === 0) {
      vscode.window.showInformationMessage('当前工作区没有 changelist');
      return;
    }

    // 显示 changelist 选择
    const items = changelists.map(name => {
      return {
        label: name,
        description: '点击查看文件列表'
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要查看或提交的 changelist'
    });

    if (!selected) {
      return;
    }

    const changelistName = selected.label;
    const files = await svnService.getChangelistFiles(basePath, changelistName);

    if (files.length === 0) {
      vscode.window.showInformationMessage(`changelist "${changelistName}" 中没有文件`);
      return;
    }

    // 显示文件列表和操作选项
    const action = await vscode.window.showInformationMessage(
      `changelist "${changelistName}" 包含 ${files.length} 个文件:\n${files.slice(0, 10).join('\n')}${files.length > 10 ? '\n...' : ''}`,
      { modal: true },
      '提交此 changelist',
      '关闭'
    );

    if (action === '提交此 changelist') {
      const message = await vscode.window.showInputBox({
        prompt: '请输入提交信息',
        placeHolder: '描述 changelist 的更改内容'
      });

      if (message === undefined || message.trim().length === 0) {
        return;
      }

      await svnService.commitChangelist(basePath, changelistName, message.trim());
      vscode.window.showInformationMessage(`changelist "${changelistName}" 提交成功！`);
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`管理 changelist 失败: ${error.message}`);
  }
}

/**
 * 扫描并解决冲突
 * @param folderUri 文件夹URI（可选）
 */
async function scanAndResolveConflicts(folderUri?: vscode.Uri): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }

    // 确定文件夹路径
    let folderPath: string;
    if (folderUri) {
      folderPath = folderUri.fsPath;
    } else {
      // 如果没有选择文件夹，使用当前工作区
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      } else {
        vscode.window.showErrorMessage('请选择一个文件夹或打开工作区');
        return;
      }
    }

    // 检查文件夹是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(folderPath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件夹不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );

      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(folderPath)) {
          vscode.window.showErrorMessage('文件夹仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }

    // 显示冲突处理面板
    await SvnConflictPanel.createOrShow(
      vscode.extensions.getExtension('vscode-svn')?.extensionUri || vscode.Uri.file(__dirname),
      folderPath,
      svnService
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(`扫描冲突失败: ${error.message}`);
  }
}

/**
 * 文件 Diff：打开 VS Code 左右对比视图
 */
async function svnDiffFile(filePath: string): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到 SVN 命令行工具');
      return;
    }
    await diffProvider.showDiff(filePath);
  } catch (error: any) {
    vscode.window.showErrorMessage(`查看差异失败: ${error.message}`);
  }
}

/**
 * 文件 Blame：使用 VS Code 原生编辑器 + TextEditorDecoration。
 * 语法高亮 100% 与编辑器一致（就是编辑器），
 * blame 元数据以 gutter 彩条 + 行末小字 + hover log 的方式覆盖。
 */
async function svnBlameFile(filePath: string): Promise<void> {
  try {
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到 SVN 命令行工具');
      return;
    }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `SVN Blame: ${path.basename(filePath)}`,
      cancellable: false
    }, async () => {
      const cwd = path.dirname(filePath);
      const fileName = path.basename(filePath);

      // 1. 获取 blame 数据（每行 rev / author / content）
      const blameRaw = await svnService.executeSvnCommand(`blame "${fileName}"`, cwd);
      const blameLines = parseBlameLinesForDeco(blameRaw);
      if (blameLines.length === 0) {
        vscode.window.showWarningMessage('blame 输出为空，无法显示 Blame');
        return;
      }

      // 2. 获取 log --xml（rev -> author/date/msg）用于 hover
      let logXml = '';
      try {
        logXml = await svnService.executeSvnCommand(`log --xml "${fileName}"`, cwd, true);
      } catch { /* ignore */ }
      const logMap = parseBlameLogXmlForDeco(logXml);

      // 3. 把 blame 的行内容（BASE 版本）写入临时文件，保留原扩展名让编辑器自动高亮
      const ext = path.extname(fileName);
      const baseName = path.basename(fileName, ext) || fileName;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svn-blame-'));
      const tmpFile = path.join(tmpDir, `${baseName}.blame${ext}`);
      const fileContent = blameLines.map(l => l.content).join('\n');
      fs.writeFileSync(tmpFile, fileContent, 'utf8');

      // 4. 以原生编辑器打开临时文件
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpFile));
      const editor = await vscode.window.showTextDocument(doc, { preview: false });

      // 把 blame 元数据注册进全局表，供鼠标点击监听器读取
      blameContextMap.set(tmpFile, { lines: blameLines, logMap });

      // 5. 按 rev 聚合行号，每个 rev 创建一个 DecorationType（gutterIconPath 在类型级别）
      const revToLineIdx = new Map<string, number[]>();
      blameLines.forEach((l, i) => {
        const arr = revToLineIdx.get(l.rev) || [];
        arr.push(i);
        revToLineIdx.set(l.rev, arr);
      });

      const decorationTypes: vscode.TextEditorDecorationType[] = [];

      // 计算最大 rev / author 宽度，用于 padEnd 对齐（代码字体等宽）
      let maxRevLen = 0;
      let maxAuthorLen = 0;
      blameLines.forEach(l => {
        const info = logMap.get(l.rev);
        const a = (info && info.author) ? info.author : l.author;
        if (l.rev.length > maxRevLen) maxRevLen = l.rev.length;
        if (a.length > maxAuthorLen) maxAuthorLen = a.length;
      });

      revToLineIdx.forEach((lineNums, rev) => {
        const color = hslForRev(rev);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3" height="18"><rect width="3" height="18" fill="${color}"/></svg>`;
        const iconUri = vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
        const deco = vscode.window.createTextEditorDecorationType({
          gutterIconPath: iconUri,
          gutterIconSize: 'contain',
          overviewRulerColor: color,
          overviewRulerLane: vscode.OverviewRulerLane.Left,
          isWholeLine: false
        });
        const options: vscode.DecorationOptions[] = lineNums.map(i => {
          const info = logMap.get(rev);
          const author = (info && info.author) ? info.author : blameLines[i].author;
          // before: 仅显示版本号 + 作者（点击行首看完整 log），padEnd 对齐
          const prefix = `r${rev.padEnd(maxRevLen)}  ${author.padEnd(maxAuthorLen)} │ `;
          return {
            range: new vscode.Range(i, 0, i, 0),
            // 不设 hoverMessage：VS Code 的 hover 会等待所有 provider（包括语言服务），容易卡在"加载中"
            renderOptions: {
              before: {
                contentText: prefix,
                color: 'rgba(200,200,200,0.85)',
                fontStyle: 'italic',
                margin: '0 0 0 0'
              }
            }
          };
        });
        editor.setDecorations(deco, options);
        decorationTypes.push(deco);
      });

      // 6. 文档关闭时清理：decorations dispose + 临时文件删除 + blame 上下文解绑
      const watchDispose = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
        if (closedDoc.uri.fsPath === tmpFile) {
          decorationTypes.forEach(d => d.dispose());
          blameContextMap.delete(tmpFile);
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
          try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
          watchDispose.dispose();
        }
      });
    });
  } catch (error: any) {
    vscode.window.showErrorMessage(`打开 Blame 失败: ${error.message}`);
  }
}

function parseBlameLinesForDeco(raw: string): Array<{ rev: string; author: string; content: string }> {
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map(line => {
    const m = /^\s*([\d-]+)\s+(\S+)\s?(.*)$/.exec(line);
    if (m) return { rev: m[1], author: m[2], content: m[3] };
    return { rev: '-', author: '-', content: line };
  });
}

function parseBlameLogXmlForDeco(xml: string): Map<string, { author: string; date: string; msg: string }> {
  const map = new Map<string, { author: string; date: string; msg: string }>();
  if (!xml) return map;
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const entryRe = /<logentry\s+revision="(\d+)">([\s\S]*?)<\/logentry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const rev = m[1];
    const body = m[2];
    const am = /<author>([\s\S]*?)<\/author>/.exec(body);
    const dm = /<date>([\s\S]*?)<\/date>/.exec(body);
    const mm = /<msg>([\s\S]*?)<\/msg>/.exec(body);
    map.set(rev, {
      author: decode(am ? am[1] : ''),
      date: decode(dm ? dm[1] : ''),
      msg: decode(mm ? mm[1] : '')
    });
  }
  return map;
}

function hslForRev(rev: string): string {
  if (!rev || rev === '-') return 'transparent';
  let h = 0;
  for (let i = 0; i < rev.length; i++) h = ((h << 5) - h + rev.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 55%, 48%)`;
}

function escapeMd(s: string): string {
  return (s || '').replace(/[\\`*_{}\[\]()#+\-!>|]/g, '\\$&');
}

/**
 * 单文件解决冲突：选择策略
 */
async function svnResolveFile(filePath: string): Promise<void> {
  const choice = await vscode.window.showQuickPick([
    { label: '标记已解决（使用当前工作副本）', description: '--accept working', value: 'working' },
    { label: '使用本地版本', description: '--accept mine-full', value: 'mine' },
    { label: '使用服务器版本', description: '--accept theirs-full', value: 'theirs' }
  ], { placeHolder: '选择冲突解决策略' });
  if (!choice) return;
  try {
    await svnService.resolveConflict(filePath, choice.value as any);
    vscode.window.showInformationMessage('冲突已解决');
  } catch (error: any) {
    vscode.window.showErrorMessage(`解决冲突失败: ${error.message}`);
  }
}

/**
 * svn delete（文件/目录）
 */
async function svnDeleteItem(itemPath: string): Promise<void> {
  const name = path.basename(itemPath);
  const confirm = await vscode.window.showWarningMessage(
    `确认执行 svn delete 于 "${name}"？\n此操作将从 SVN 标记为删除并移除本地文件（未提交前可通过 Revert 恢复）。`,
    { modal: true }, '确认删除'
  );
  if (confirm !== '确认删除') return;
  try {
    const cwd = path.dirname(itemPath);
    await svnService.executeSvnCommand(`delete "${name}" --force`, cwd);
    vscode.window.showInformationMessage(`已删除: ${name}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`svn delete 失败: ${error.message}`);
  }
}

/**
 * svn cleanup（目录）
 */
async function svnCleanupFolder(folderPath: string): Promise<void> {
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `SVN Clean up: ${path.basename(folderPath)}`,
      cancellable: false
    }, async () => {
      await svnService.executeSvnCommand('cleanup', folderPath);
    });
    vscode.window.showInformationMessage('Clean up 完成');
  } catch (error: any) {
    vscode.window.showErrorMessage(`svn cleanup 失败: ${error.message}`);
  }
}

/**
 * svn switch（目录）
 */
async function svnSwitchFolder(folderPath: string): Promise<void> {
  let currentUrl = '';
  try {
    const info = await svnService.executeSvnCommand('info --xml', folderPath, true);
    const m = /<url>([\s\S]*?)<\/url>/.exec(info);
    if (m) currentUrl = m[1].trim();
  } catch { /* ignore */ }

  const url = await vscode.window.showInputBox({
    prompt: '输入目标 SVN URL（Switch 到分支或 tag）',
    value: currentUrl,
    placeHolder: 'svn://... 或 http(s)://...',
    ignoreFocusOut: true
  });
  if (!url) return;

  const rev = await vscode.window.showInputBox({
    prompt: '输入目标版本（留空默认 HEAD）',
    value: 'HEAD',
    ignoreFocusOut: true
  });
  if (rev === undefined) return;

  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `SVN Switch 到 ${url}@${rev || 'HEAD'}`,
      cancellable: false
    }, async () => {
      const revArg = rev && rev.trim() ? ` -r ${rev.trim()}` : '';
      await svnService.executeSvnCommand(`switch "${url}"${revArg}`, folderPath);
    });
    vscode.window.showInformationMessage('Switch 完成');
  } catch (error: any) {
    vscode.window.showErrorMessage(`svn switch 失败: ${error.message}`);
  }
}

/**
 * svn add（文件/目录）
 */
async function svnAddItem(itemPath: string): Promise<void> {
  try {
    const cwd = path.dirname(itemPath);
    const name = path.basename(itemPath);
    const result = await svnService.executeSvnCommand(`add "${name}" --force`, cwd);
    const lines = (result || '').split(/\r?\n/).filter(l => l.trim()).length;
    vscode.window.showInformationMessage(`已执行 svn add：${lines} 项新增（${name}）`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`svn add 失败: ${error.message}`);
  }
}

// ===================== Update to Revision =====================
async function svnUpdateToRevision(uri?: vscode.Uri): Promise<void> {
  let fsPath: string | undefined;
  if (uri) fsPath = uri.fsPath;
  else {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) fsPath = activeEditor.document.uri.fsPath;
    else if (vscode.workspace.workspaceFolders?.length) fsPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  if (!fsPath) { vscode.window.showErrorMessage('请选择文件或目录'); return; }
  const revision = await vscode.window.showInputBox({
    prompt: '输入目标版本号（例如: 12345 或 HEAD）',
    placeHolder: 'HEAD',
    value: 'HEAD',
    ignoreFocusOut: true
  });
  if (!revision) return;
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `SVN Update to r${revision}...`,
      cancellable: false
    }, async () => {
      await svnService.updateToRevision(fsPath!, revision.trim());
    });
    vscode.window.showInformationMessage(`已更新到版本 r${revision}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Update to Revision 失败: ${error.message}`);
  }
}

// ===================== Check for Modifications =====================
async function svnCheckForModifications(uri?: vscode.Uri): Promise<void> {
  let folderPath: string | undefined;
  if (uri) folderPath = uri.fsPath;
  else if (vscode.workspace.workspaceFolders?.length) folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  if (!folderPath) { vscode.window.showErrorMessage('请打开工作区'); return; }
  let entries: Array<{filePath: string; status: string; char: string}> = [];
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '正在扫描修改状态...',
    cancellable: false
  }, async () => {
    entries = await svnService.getStatusList(folderPath!);
  });
  if (entries.length === 0) {
    vscode.window.showInformationMessage('没有发现修改的文件（工作副本是最新状态）');
    return;
  }
  const charIcon: Record<string, string> = {
    'M': '$(edit)', 'A': '$(add)', 'D': '$(trash)', 'C': '$(warning)',
    '?': '$(question)', '!': '$(alert)', 'R': '$(replace-all)', '~': '$(diff-modified)'
  };
  const items = entries.map(e => ({
    label: `${charIcon[e.char] || '$(circle-outline)'} ${path.basename(e.filePath)}`,
    description: path.relative(folderPath!, e.filePath),
    detail: e.status,
    filePath: e.filePath,
    char: e.char
  }));
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `发现 ${entries.length} 个修改文件 — 选择文件执行操作`,
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!selected) return;
  const fileUri = vscode.Uri.file(selected.filePath);
  const actions: Array<{label: string; command: string}> = [
    { label: '$(diff) 查看 Diff', command: 'vscode-svn.diff' },
    { label: '$(discard) Revert', command: 'vscode-svn.revertFile' },
    { label: '$(history) 查看日志', command: 'vscode-svn.viewLog' }
  ];
  if (selected.char === 'M' || selected.char === 'A') {
    actions.unshift({ label: '$(cloud-upload) Commit', command: 'vscode-svn.commitFile' });
  }
  const action = await vscode.window.showQuickPick(actions.map(a => a.label), {
    placeHolder: `对 ${path.basename(selected.filePath)} 执行操作`
  });
  if (!action) return;
  const found = actions.find(a => a.label === action);
  if (found) await vscode.commands.executeCommand(found.command, fileUri);
}

// ===================== Diff with Revision =====================
async function svnDiffWithRevision(uri?: vscode.Uri): Promise<void> {
  let fsPath: string | undefined;
  if (uri) fsPath = uri.fsPath;
  else {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) fsPath = activeEditor.document.uri.fsPath;
  }
  if (!fsPath) { vscode.window.showErrorMessage('请选择文件'); return; }
  const mode = await vscode.window.showQuickPick([
    { label: '$(diff) 与指定版本比较', value: 'single' },
    { label: '$(diff-multiple) 比较两个版本之间', value: 'range' }
  ], { placeHolder: '选择比较模式' });
  if (!mode) return;
  const rev1 = await vscode.window.showInputBox({
    prompt: mode.value === 'range' ? '输入起始版本号（旧版本）' : '输入要比较的版本号',
    placeHolder: 'BASE 或数字版本号',
    ignoreFocusOut: true
  });
  if (rev1 === undefined) return;
  let rev2: string | undefined;
  if (mode.value === 'range') {
    rev2 = await vscode.window.showInputBox({
      prompt: '输入结束版本号（新版本）',
      placeHolder: 'HEAD 或数字版本号',
      value: 'HEAD',
      ignoreFocusOut: true
    });
    if (rev2 === undefined) return;
  }
  try {
    const diffContent = await svnService.diffWithRevision(fsPath, rev1 || 'BASE', rev2);
    if (!diffContent.trim()) {
      vscode.window.showInformationMessage('没有差异');
      return;
    }
    const tmpFile = path.join(os.tmpdir(), `svn-diff-r${rev1}${rev2 ? '-r' + rev2 : ''}-${Date.now()}.diff`);
    fs.writeFileSync(tmpFile, diffContent, 'utf8');
    const doc = await vscode.workspace.openTextDocument(tmpFile);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (error: any) {
    vscode.window.showErrorMessage(`Diff with Revision 失败: ${error.message}`);
  }
}

// ===================== Rollback (Reverse Merge) =====================
async function svnRollback(uri?: vscode.Uri): Promise<void> {
  let folderPath: string | undefined;
  if (uri) {
    try {
      const stat = fs.statSync(uri.fsPath);
      folderPath = stat.isDirectory() ? uri.fsPath : path.dirname(uri.fsPath);
    } catch { folderPath = path.dirname(uri.fsPath); }
  } else if (vscode.workspace.workspaceFolders?.length) {
    folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  if (!folderPath) { vscode.window.showErrorMessage('请选择目录'); return; }
  const revision = await vscode.window.showInputBox({
    prompt: '输入要回滚的版本号（将执行反向合并，撤销该版本引入的所有更改）',
    placeHolder: '例如: 12345',
    ignoreFocusOut: true,
    validateInput: v => v && /^\d+$/.test(v.trim()) ? null : '请输入纯数字版本号'
  });
  if (!revision) return;
  const confirm = await vscode.window.showWarningMessage(
    `确认要反向合并（回滚）版本 r${revision} 的所有更改吗？\n这会修改工作副本，需要再次提交才能生效。`,
    { modal: true }, '确认回滚', '取消'
  );
  if (confirm !== '确认回滚') return;
  try {
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `SVN Rollback r${revision}...`,
      cancellable: false
    }, async () => {
      return await svnService.rollbackRevision(folderPath!, revision.trim());
    });
    const lines = result.split('\n').filter(l => l.trim()).length;
    const choice = await vscode.window.showInformationMessage(
      `反向合并完成，${lines} 项文件已变更。请检查后提交以完成回滚。`,
      '立即提交', '稍后'
    );
    if (choice === '立即提交') {
      await vscode.commands.executeCommand('vscode-svn.uploadFolder', vscode.Uri.file(folderPath));
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`Rollback 失败: ${error.message}`);
  }
}

// ===================== SVN Cat / Show at Revision =====================
async function svnCatFile(uri?: vscode.Uri): Promise<void> {
  let fsPath: string | undefined;
  if (uri) fsPath = uri.fsPath;
  else {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) fsPath = activeEditor.document.uri.fsPath;
  }
  if (!fsPath) { vscode.window.showErrorMessage('请选择文件'); return; }
  const revision = await vscode.window.showInputBox({
    prompt: '输入要查看的版本号',
    placeHolder: 'HEAD 或数字版本号',
    value: 'HEAD',
    ignoreFocusOut: true
  });
  if (!revision) return;
  try {
    const content = await svnService.catFile(fsPath, revision.trim() || 'HEAD');
    const ext = path.extname(fsPath);
    const tmpFile = path.join(os.tmpdir(), `svn-cat-r${revision}-${path.basename(fsPath, ext)}${ext}`);
    fs.writeFileSync(tmpFile, content, 'utf8');
    const doc = await vscode.workspace.openTextDocument(tmpFile);
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  } catch (error: any) {
    vscode.window.showErrorMessage(`查看历史版本失败: ${error.message}`);
  }
}

// ===================== Copy URL to Clipboard =====================
async function svnCopyUrl(uri?: vscode.Uri): Promise<void> {
  let fsPath: string | undefined;
  if (uri) fsPath = uri.fsPath;
  else {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) fsPath = activeEditor.document.uri.fsPath;
    else if (vscode.workspace.workspaceFolders?.length) fsPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  if (!fsPath) { vscode.window.showErrorMessage('请选择文件或目录'); return; }
  try {
    const url = await svnService.getFileUrl(fsPath);
    await vscode.env.clipboard.writeText(url);
    vscode.window.showInformationMessage(`SVN URL 已复制: ${url}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`获取 SVN URL 失败: ${error.message}`);
  }
}

// ===================== Manage Externals =====================
async function svnManageExternals(uri?: vscode.Uri): Promise<void> {
  let dirPath: string | undefined;
  if (uri) {
    try {
      const stat = fs.statSync(uri.fsPath);
      dirPath = stat.isDirectory() ? uri.fsPath : path.dirname(uri.fsPath);
    } catch { dirPath = uri ? path.dirname(uri.fsPath) : undefined; }
  } else if (vscode.workspace.workspaceFolders?.length) {
    dirPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  if (!dirPath) { vscode.window.showErrorMessage('请选择目录'); return; }
  let current = '';
  try { current = await svnService.getExternals(dirPath); } catch { /* none */ }
  const action = await vscode.window.showQuickPick([
    { label: '$(eye) 查看 svn:externals', value: 'view' },
    { label: '$(edit) 编辑 svn:externals', value: 'edit' },
    { label: '$(trash) 清除 svn:externals', value: 'clear' }
  ], { placeHolder: `svn:externals — ${path.basename(dirPath)}` });
  if (!action) return;
  if (action.value === 'view') {
    if (!current) { vscode.window.showInformationMessage('该目录没有设置 svn:externals'); }
    else { vscode.window.showInformationMessage(`svn:externals:\n${current}`, { modal: true }); }
    return;
  }
  if (action.value === 'clear') {
    const confirm = await vscode.window.showWarningMessage('确认清除 svn:externals 属性？', { modal: true }, '确认');
    if (confirm !== '确认') return;
    try {
      await svnService.executeSvnCommand('propdel svn:externals .', dirPath);
      vscode.window.showInformationMessage('已清除 svn:externals');
    } catch (e: any) { vscode.window.showErrorMessage(`清除失败: ${e.message}`); }
    return;
  }
  // edit
  const newValue = await vscode.window.showInputBox({
    prompt: '输入 svn:externals（格式: URL local_path，每行一条）',
    value: current,
    ignoreFocusOut: true,
    placeHolder: 'svn://repo/common/lib lib'
  });
  if (newValue === undefined) return;
  try {
    await svnService.setExternals(dirPath, newValue);
    vscode.window.showInformationMessage('svn:externals 已更新');
  } catch (e: any) { vscode.window.showErrorMessage(`设置失败: ${e.message}`); }
}

// ===================== Sparse Checkout =====================
async function svnSparseCheckout(): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: '输入 SVN 仓库 URL',
    placeHolder: 'svn://... 或 http(s)://...',
    ignoreFocusOut: true
  });
  if (!url) return;
  const depth = await vscode.window.showQuickPick([
    { label: 'empty — 仅检出根目录（不含文件）', value: 'empty' },
    { label: 'files — 仅检出根目录下的文件', value: 'files' },
    { label: 'immediates — 检出直接子目录（不递归）', value: 'immediates' },
    { label: 'infinity — 完整检出（默认）', value: 'infinity' }
  ], { placeHolder: '选择检出深度' });
  if (!depth) return;
  const targetFolder = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '选择检出目标目录'
  });
  if (!targetFolder || targetFolder.length === 0) return;
  const targetDir = targetFolder[0].fsPath;
  const folderName = await vscode.window.showInputBox({
    prompt: '输入检出后的子文件夹名称（留空使用 URL 最后一段）',
    value: url.split('/').filter(p => p).pop() || 'svn_checkout',
    ignoreFocusOut: true
  });
  if (folderName === undefined) return;
  const finalTarget = path.join(targetDir, folderName || 'svn_checkout');
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `SVN Sparse Checkout (${depth.value})...`,
    cancellable: false
  }, async () => {
    const result = await svnService.sparseCheckout(url, finalTarget, depth.value);
    if (result.success) {
      const choice = await vscode.window.showInformationMessage(
        `Sparse Checkout 完成：${finalTarget}`,
        '打开目录'
      );
      if (choice === '打开目录') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(finalTarget), { forceNewWindow: false });
      }
    } else {
      vscode.window.showErrorMessage(`Sparse Checkout 失败: ${result.message}`);
    }
  });
}

// ===================== Remove from Ignore =====================
async function svnRemoveIgnore(uri?: vscode.Uri): Promise<void> {
  let fsPath: string | undefined;
  if (uri) fsPath = uri.fsPath;
  if (!fsPath) { vscode.window.showErrorMessage('请选择文件或目录'); return; }
  const parentDir = path.dirname(fsPath);
  const name = path.basename(fsPath);
  const pattern = await vscode.window.showInputBox({
    prompt: '输入要从 svn:ignore 中移除的 pattern',
    value: name,
    ignoreFocusOut: true
  });
  if (!pattern) return;
  try {
    await svnService.removeIgnore(parentDir, pattern);
    vscode.window.showInformationMessage(`已从 svn:ignore 中移除: ${pattern}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`移除 ignore 失败: ${error.message}`);
  }
}

// ===================== Quick Set File Properties =====================
async function svnQuickSetFileProps(uri?: vscode.Uri): Promise<void> {
  let fsPath: string | undefined;
  if (uri) fsPath = uri.fsPath;
  else {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) fsPath = activeEditor.document.uri.fsPath;
  }
  if (!fsPath) { vscode.window.showErrorMessage('请选择文件'); return; }
  try {
    const stat = fs.statSync(fsPath);
    if (stat.isDirectory()) { vscode.window.showErrorMessage('此功能仅适用于文件'); return; }
  } catch { vscode.window.showErrorMessage('文件不存在'); return; }
  const prop = await vscode.window.showQuickPick([
    { label: '$(file-binary) 标记为二进制文件', prop: 'svn:mime-type', value: 'application/octet-stream' },
    { label: '$(file-code) 标记为文本文件', prop: 'svn:mime-type', value: 'text/plain' },
    { label: '$(symbol-property) 设置行尾风格 (svn:eol-style)', prop: 'svn:eol-style', value: '' },
    { label: '$(tag) 设置关键字替换 (svn:keywords)', prop: 'svn:keywords', value: '' },
    { label: '$(lock) 设置 svn:needs-lock', prop: 'svn:needs-lock', value: '*' }
  ], { placeHolder: `快速设置文件属性 — ${path.basename(fsPath)}` });
  if (!prop) return;
  let value = prop.value;
  if (!value) {
    if (prop.prop === 'svn:eol-style') {
      const eol = await vscode.window.showQuickPick(['native', 'LF', 'CRLF', 'CR'], { placeHolder: '选择行尾风格' });
      if (!eol) return;
      value = eol;
    } else if (prop.prop === 'svn:keywords') {
      const kw = await vscode.window.showInputBox({
        prompt: '输入关键字（空格分隔: Id Author Date Rev URL HeadURL）',
        value: 'Id Author Date Rev',
        ignoreFocusOut: true
      });
      if (kw === undefined) return;
      value = kw;
    }
  }
  try {
    await svnService.propSet(fsPath, prop.prop, value);
    vscode.window.showInformationMessage(`已设置 ${prop.prop} = ${value}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`设置属性失败: ${error.message}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('VSCode SVN 扩展已激活');
  
  // 初始化SVN服务
  svnService = new SvnService(context);
  diffProvider = new SvnDiffProvider(svnService);
  logStorage = new CommitLogStorage(context);
  filterService = new SvnFilterService();
  extensionRootUri = context.extensionUri;
  // AI缓存服务使用单例模式，无需在此初始化

  // 全局监听：在 blame 临时文件中鼠标点击行首（before 装饰區）触发 hover 浮层显示 log 详情
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(async e => {
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
      const fsPath = e.textEditor.document.uri.fsPath;
      if (!blameContextMap.has(fsPath)) return;
      const sel = e.selections[0];
      if (!sel.isEmpty) return;
      if (sel.active.character !== 0) return; // 仅在行首（before 伪元素）点击时触发
      // 触发编辑器 hover 命令，浮层在点击位置展示（内容由下面的 hoverProvider 提供）
      await vscode.commands.executeCommand('editor.action.showHover');
    })
  );

  // 仅对 blame 临时文件生效的 hoverProvider：同步返回 blame 信息，避免"加载中"
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      provideHover(doc, pos) {
        const ctx = blameContextMap.get(doc.uri.fsPath);
        if (!ctx) return undefined;
        const blame = ctx.lines[pos.line];
        if (!blame) return undefined;
        const info = ctx.logMap.get(blame.rev);
        const dateStr = info && info.date ? info.date.split('T')[0] : '';
        const author = (info && info.author) ? info.author : blame.author;
        const msg = (info && info.msg) ? info.msg : '(无 log 信息)';
        const md = new vscode.MarkdownString();
        md.isTrusted = false;
        md.supportHtml = false;
        md.appendMarkdown(`**r${blame.rev}** · ${author} · ${dateStr}\n\n`);
        // commit message 保留换行（markdown 硬换行）
        const normalized = msg.replace(/\r\n/g, '\n'); // 保留换行（markdown 硬换行）
        const escapedMsg = normalized.split('\n').join('  \n');
        md.appendMarkdown(escapedMsg);
        return new vscode.Hover(md);
      }
    })
  );
  
  // 注册上传文件命令
  const uploadFileCommand = vscode.commands.registerCommand('vscode-svn.uploadFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能上传本地文件');
      return;
    }
    
    await uploadFileToSvn(fileUri.fsPath);
  });
  
  // 注册上传文件夹命令
  const uploadFolderCommand = vscode.commands.registerCommand('vscode-svn.uploadFolder', async (folderUri?: vscode.Uri) => {
    if (!folderUri) {
      // 如果没有通过右键菜单选择文件夹，则使用当前工作区文件夹
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        folderUri = vscode.workspace.workspaceFolders[0].uri;
      } else {
        vscode.window.showErrorMessage('没有打开的工作区');
        return;
      }
    }
    
    if (folderUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能上传本地文件夹');
      return;
    }
    
    await uploadFolderToSvn(folderUri.fsPath);
  });
  
  // 注册提交文件命令（显示差异）
  const commitFileCommand = vscode.commands.registerCommand('vscode-svn.commitFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能提交本地文件');
      return;
    }
    
    await commitFileWithDiff(fileUri.fsPath);
  });
  
  // 注册设置SVN工作副本路径命令
  const setSvnRootCommand = vscode.commands.registerCommand('vscode-svn.setSvnRoot', async (folderUri?: vscode.Uri) => {
    await setSvnWorkingCopyRoot(folderUri);
  });
  
  // 注册清除SVN工作副本路径命令
  const clearSvnRootCommand = vscode.commands.registerCommand('vscode-svn.clearSvnRoot', async () => {
    await clearSvnWorkingCopyRoot();
  });
  
  // 注册更新文件命令
  const updateFileCommand = vscode.commands.registerCommand('vscode-svn.updateFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能更新本地文件');
      return;
    }
    
    await updateFile(fileUri.fsPath);
  });
  
  // 注册更新目录命令
  const updateDirectoryCommand = vscode.commands.registerCommand('vscode-svn.updateDirectory', async (folderUri?: vscode.Uri) => {
    if (!folderUri) {
      // 如果没有通过右键菜单选择文件夹，则使用当前工作区文件夹
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        folderUri = vscode.workspace.workspaceFolders[0].uri;
      } else {
        vscode.window.showErrorMessage('没有打开的工作区');
        return;
      }
    }
    
    if (folderUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能更新本地文件夹');
      return;
    }
    
    await updateDirectory(folderUri.fsPath);
  });
  
  // 注册更新工作区命令
  const updateWorkspaceCommand = vscode.commands.registerCommand('vscode-svn.updateWorkspace', async () => {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return;
    }
    
    // 使用第一个工作区文件夹
    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    
    if (workspaceFolder.uri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能更新本地工作区');
      return;
    }
    
    await updateDirectory(workspaceFolder.uri.fsPath);
  });
  
  // 注册恢复文件命令
  const revertFileCommand = vscode.commands.registerCommand('vscode-svn.revertFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能恢复本地文件');
      return;
    }
    
    await revertFile(fileUri.fsPath);
  });

  // 注册恢复文件夹命令
  const revertFolderCommand = vscode.commands.registerCommand('vscode-svn.revertFolder', async (folderUri?: vscode.Uri) => {
    if (!folderUri) {
      // 如果没有通过右键菜单选择文件夹，则使用当前工作区文件夹
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        folderUri = vscode.workspace.workspaceFolders[0].uri;
      } else {
        vscode.window.showErrorMessage('没有打开的工作区');
        return;
      }
    }
    
    if (folderUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能恢复本地文件夹');
      return;
    }
    
    await revertFolder(folderUri.fsPath);
  });
  
  // 注册查看SVN日志命令
  const viewLogCommand = vscode.commands.registerCommand('vscode-svn.viewLog', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，先尝试当前活动编辑器，再回退到工作区根目录
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        fileUri = vscode.workspace.workspaceFolders[0].uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件或文件夹');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能查看本地文件或文件夹的SVN日志');
      return;
    }
    
    await viewSvnLog(fileUri.fsPath);
  });
  
  // 注册显示本地修订版本号命令
  const showLocalRevisionCommand = vscode.commands.registerCommand('vscode-svn.showLocalRevision', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件或文件夹');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能查看本地文件或文件夹的本地修订版本号');
      return;
    }
    
    await showLocalRevision(fileUri.fsPath);
  });
  
  // 注册配置过滤规则命令
  const configureFilterCommand = vscode.commands.registerCommand('vscode-svn.configureFilter', async () => {
    await configureFilter();
  });
  
  // 注册显示过滤信息命令
  const showFilterInfoCommand = vscode.commands.registerCommand('vscode-svn.showFilterInfo', async () => {
    await showFilterInfo();
  });
  
  // 注册显示AI缓存统计命令
  const showAICacheStatsCommand = vscode.commands.registerCommand('vscode-svn.showAICacheStats', async () => {
    await showAICacheStats();
  });
  
  // 注册清空AI缓存命令
  const clearAICacheCommand = vscode.commands.registerCommand('vscode-svn.clearAICache', async () => {
    await clearAICache();
  });
  
  // 注册清理过期AI缓存命令
  const cleanExpiredAICacheCommand = vscode.commands.registerCommand('vscode-svn.cleanExpiredAICache', async () => {
    await cleanExpiredAICache();
  });
  
  // 注册配置AI服务命令
  const configureAICommand = vscode.commands.registerCommand('vscode-svn.configureAI', async () => {
    await configureAI();
  });
  
  // 注册SVN检出命令
  const checkoutCommand = vscode.commands.registerCommand('vscode-svn.checkout', async (folderUri?: vscode.Uri) => {
    await checkoutFromSvn(folderUri);
  });

  // 认证管理命令
  const manageCredentialsCommand = vscode.commands.registerCommand('vscode-svn.manageCredentials', async () => {
    await manageCredentials(context);
  });

  const clearCredentialsCommand = vscode.commands.registerCommand('vscode-svn.clearCredentials', async () => {
    await clearCredentials(context);
  });

  // 注册扫描并解决冲突命令
  const scanAndResolveConflictsCommand = vscode.commands.registerCommand('vscode-svn.scanAndResolveConflicts', async (folderUri?: vscode.Uri) => {
    await scanAndResolveConflicts(folderUri);
  });

  // 注册锁定文件命令
  const lockFileCommand = vscode.commands.registerCommand('vscode-svn.lockFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能锁定本地文件');
      return;
    }
    await lockFile(fileUri.fsPath);
  });

  // 注册解锁文件命令
  const unlockFileCommand = vscode.commands.registerCommand('vscode-svn.unlockFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能解锁本地文件');
      return;
    }
    await unlockFile(fileUri.fsPath);
  });

  // 注册查看锁定信息命令
  const showLockInfoCommand = vscode.commands.registerCommand('vscode-svn.showLockInfo', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能查看本地文件的锁定信息');
      return;
    }
    await showLockInfo(fileUri.fsPath);
  });

  // 注册添加到 Changelist 命令
  const addToChangelistCommand = vscode.commands.registerCommand('vscode-svn.addToChangelist', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能对本地文件执行此操作');
      return;
    }
    await addFileToChangelist(fileUri.fsPath);
  });

  // 注册从 Changelist 移除命令
  const removeFromChangelistCommand = vscode.commands.registerCommand('vscode-svn.removeFromChangelist', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能对本地文件执行此操作');
      return;
    }
    await removeFileFromChangelist(fileUri.fsPath);
  });

  // 注册管理 Changelist 命令
  const manageChangelistsCommand = vscode.commands.registerCommand('vscode-svn.manageChangelists', async () => {
    await manageChangelists();
  });

  // 注册分支合并命令
  const mergeBranchCommand = vscode.commands.registerCommand('vscode-svn.mergeBranch', async (folderUri?: vscode.Uri) => {
    try {
      let folderPath: string | undefined;
      if (folderUri) {
        folderPath = folderUri.fsPath;
      } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      }
      if (!folderPath) {
        vscode.window.showErrorMessage('请在资源管理器中右键文件夹或打开工作区');
        return;
      }
      SvnMergePanel.show(context, svnService, folderPath, logStorage);
    } catch (error: any) {
      vscode.window.showErrorMessage(`打开分支合并面板失败: ${error.message}`);
    }
  });

  // —— 新增右键菜单命令 ——
  const diffCommand = vscode.commands.registerCommand('vscode-svn.diff', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) fileUri = activeEditor.document.uri;
    }
    if (!fileUri || fileUri.scheme !== 'file') { vscode.window.showErrorMessage('请选择文件'); return; }
    await svnDiffFile(fileUri.fsPath);
  });

  const blameCommand = vscode.commands.registerCommand('vscode-svn.blame', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) fileUri = activeEditor.document.uri;
    }
    if (!fileUri || fileUri.scheme !== 'file') { vscode.window.showErrorMessage('请选择文件'); return; }
    await svnBlameFile(fileUri.fsPath);
  });

  const resolveFileCommand = vscode.commands.registerCommand('vscode-svn.resolveFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) fileUri = activeEditor.document.uri;
    }
    if (!fileUri || fileUri.scheme !== 'file') { vscode.window.showErrorMessage('请选择文件'); return; }
    await svnResolveFile(fileUri.fsPath);
  });

  const svnDeleteCommand = vscode.commands.registerCommand('vscode-svn.svnDelete', async (itemUri?: vscode.Uri) => {
    if (!itemUri) {
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        itemUri = vscode.workspace.workspaceFolders[0].uri;
      } else {
        vscode.window.showErrorMessage('请在资源管理器右键文件或目录');
        return;
      }
    }
    if (itemUri.scheme !== 'file') { vscode.window.showErrorMessage('只能对本地文件/目录执行此操作'); return; }
    await svnDeleteItem(itemUri.fsPath);
  });

  const cleanupCommand = vscode.commands.registerCommand('vscode-svn.cleanup', async (folderUri?: vscode.Uri) => {
    let folderPath: string | undefined;
    if (folderUri) folderPath = folderUri.fsPath;
    else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    if (!folderPath) { vscode.window.showErrorMessage('请选择目录'); return; }
    await svnCleanupFolder(folderPath);
  });

  const switchCommand = vscode.commands.registerCommand('vscode-svn.switch', async (folderUri?: vscode.Uri) => {
    let folderPath: string | undefined;
    if (folderUri) folderPath = folderUri.fsPath;
    else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    if (!folderPath) { vscode.window.showErrorMessage('请选择目录'); return; }
    await svnSwitchFolder(folderPath);
  });

  const addItemCommand = vscode.commands.registerCommand('vscode-svn.addItem', async (itemUri?: vscode.Uri) => {
    if (!itemUri) {
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        itemUri = vscode.workspace.workspaceFolders[0].uri;
      } else {
        vscode.window.showErrorMessage('请在资源管理器右键项');
        return;
      }
    }
    if (itemUri.scheme !== 'file') { vscode.window.showErrorMessage('只能对本地文件/目录执行此操作'); return; }
    await svnAddItem(itemUri.fsPath);
  });

  // ============ 新增命令注册 ============
  const svnExportCommand = vscode.commands.registerCommand('vscode-svn.export', async (uri?: vscode.Uri) => {
    await svnExport(uri);
  });
  const svnImportCommand = vscode.commands.registerCommand('vscode-svn.import', async (uri?: vscode.Uri) => {
    await svnImport(uri);
  });
  const svnCreatePatchCommand = vscode.commands.registerCommand('vscode-svn.createPatch', async (uri?: vscode.Uri) => {
    await svnCreatePatch(uri);
  });
  const svnApplyPatchCommand = vscode.commands.registerCommand('vscode-svn.applyPatch', async (uri?: vscode.Uri) => {
    await svnApplyPatch(uri);
  });
  const svnManagePropertiesCommand = vscode.commands.registerCommand('vscode-svn.manageProperties', async (uri?: vscode.Uri) => {
    await svnManageProperties(uri);
  });
  const svnAddIgnoreCommand = vscode.commands.registerCommand('vscode-svn.addIgnore', async (uri?: vscode.Uri) => {
    await svnAddIgnore(uri);
  });
  const svnCopyPathCommand = vscode.commands.registerCommand('vscode-svn.copyPath', async (uri?: vscode.Uri) => {
    await svnCopyPath(uri);
  });
  const svnMovePathCommand = vscode.commands.registerCommand('vscode-svn.movePath', async (uri?: vscode.Uri) => {
    await svnMovePath(uri);
  });
  const svnRelocateCommand = vscode.commands.registerCommand('vscode-svn.relocate', async (uri?: vscode.Uri) => {
    await svnRelocate(uri);
  });
  const svnCreateBranchTagCommand = vscode.commands.registerCommand('vscode-svn.createBranchTag', async (uri?: vscode.Uri) => {
    await svnCreateBranchTag(uri);
  });
  const svnRepoBrowserCommand = vscode.commands.registerCommand('vscode-svn.repoBrowser', async (uri?: vscode.Uri) => {
    await svnRepoBrowser(uri);
  });

  // ============ 第二批新增命令注册 ============
  const svnUpdateToRevisionCommand = vscode.commands.registerCommand('vscode-svn.updateToRevision', async (uri?: vscode.Uri) => {
    await svnUpdateToRevision(uri);
  });
  const svnCheckForModificationsCommand = vscode.commands.registerCommand('vscode-svn.checkForModifications', async (uri?: vscode.Uri) => {
    await svnCheckForModifications(uri);
  });
  const svnDiffWithRevisionCommand = vscode.commands.registerCommand('vscode-svn.diffWithRevision', async (uri?: vscode.Uri) => {
    await svnDiffWithRevision(uri);
  });
  const svnRollbackCommand = vscode.commands.registerCommand('vscode-svn.rollback', async (uri?: vscode.Uri) => {
    await svnRollback(uri);
  });
  const svnCatFileCommand = vscode.commands.registerCommand('vscode-svn.catFile', async (uri?: vscode.Uri) => {
    await svnCatFile(uri);
  });
  const svnCopyUrlCommand = vscode.commands.registerCommand('vscode-svn.copyUrl', async (uri?: vscode.Uri) => {
    await svnCopyUrl(uri);
  });
  const svnManageExternalsCommand = vscode.commands.registerCommand('vscode-svn.manageExternals', async (uri?: vscode.Uri) => {
    await svnManageExternals(uri);
  });
  const svnSparseCheckoutCommand = vscode.commands.registerCommand('vscode-svn.sparseCheckout', async () => {
    await svnSparseCheckout();
  });
  const svnRemoveIgnoreCommand = vscode.commands.registerCommand('vscode-svn.removeIgnore', async (uri?: vscode.Uri) => {
    await svnRemoveIgnore(uri);
  });
  const svnQuickSetFilePropsCommand = vscode.commands.registerCommand('vscode-svn.quickSetProps', async (uri?: vscode.Uri) => {
    await svnQuickSetFileProps(uri);
  });


  // 底部状态栏 “SVN” 快捷入口：点击弹出目录级 SVN 命令面板
  const showRootMenuCommand = vscode.commands.registerCommand('vscode-svn.showRootMenu', async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return;
    }
    let targetUri: vscode.Uri;
    if (folders.length === 1) {
      targetUri = folders[0].uri;
    } else {
      const picked = await vscode.window.showQuickPick(
        folders.map(f => ({ label: f.name, description: f.uri.fsPath, uri: f.uri })),
        { placeHolder: '选择要操作的工作区文件夹' }
      );
      if (!picked) return;
      targetUri = picked.uri;
    }

    const lang = vscode.workspace.getConfiguration('vscode-svn').get<string>('language', 'en');
    const isZh = lang === 'zh';
    type Action = { label: string; description?: string; command: string; needsUri: boolean };
    const actions: Action[] = [
      { label: isZh ? '$(sync) 更新目录'          : '$(sync) SVN Update',         command: 'vscode-svn.updateDirectory',          needsUri: true },
      { label: isZh ? '$(cloud-upload) 提交目录'  : '$(cloud-upload) SVN Commit...', command: 'vscode-svn.uploadFolder',          needsUri: true },
      { label: isZh ? '$(history) 查看日志'        : '$(history) Show log',         command: 'vscode-svn.viewLog',                  needsUri: true },
      { label: isZh ? '$(warning) 扫描并解决冲突' : '$(warning) Resolve...',     command: 'vscode-svn.scanAndResolveConflicts',  needsUri: true },
      { label: isZh ? '$(discard) 恢复目录'        : '$(discard) Revert...',         command: 'vscode-svn.revertFolder',             needsUri: true },
      { label: isZh ? '$(tools) 清理'                  : '$(tools) Clean up...',         command: 'vscode-svn.cleanup',                  needsUri: true },
      { label: isZh ? '$(repo-forked) 切换'            : '$(repo-forked) Switch...',     command: 'vscode-svn.switch',                   needsUri: true },
      { label: isZh ? '$(git-merge) 合并分支'    : '$(git-merge) Merge...',        command: 'vscode-svn.mergeBranch',              needsUri: true },
      { label: isZh ? '$(add) 添加'                    : '$(add) Add...',                command: 'vscode-svn.addItem',                  needsUri: true },
      { label: isZh ? '$(trash) SVN 删除'              : '$(trash) Delete',              command: 'vscode-svn.svnDelete',                needsUri: true },
      { label: isZh ? '$(file-zip) 导出 (Export)'        : '$(file-zip) Export...',         command: 'vscode-svn.export',                   needsUri: true },
      { label: isZh ? '$(diff) 创建 Patch'              : '$(diff) Create Patch...',       command: 'vscode-svn.createPatch',              needsUri: true },
      { label: isZh ? '$(diff-added) 应用 Patch'        : '$(diff-added) Apply Patch...',  command: 'vscode-svn.applyPatch',               needsUri: true },
      { label: isZh ? '$(list-unordered) 属性管理'      : '$(list-unordered) Properties...', command: 'vscode-svn.manageProperties',      needsUri: true },
      { label: isZh ? '$(repo-forked) 创建分支/Tag'     : '$(repo-forked) Branch/Tag...', command: 'vscode-svn.createBranchTag',         needsUri: true },
      { label: isZh ? '$(link) 重定位 (Relocate)'    : '$(link) Relocate...',           command: 'vscode-svn.relocate',                 needsUri: true },
      { label: isZh ? '$(remote) 仓库浏览器'        : '$(remote) Repo Browser...',     command: 'vscode-svn.repoBrowser',              needsUri: true },
      { label: isZh ? '$(cloud-upload) 导入 (Import)'    : '$(cloud-upload) Import...',     command: 'vscode-svn.import',                   needsUri: false },
      { label: isZh ? '$(sync) 更新到指定版本'  : '$(sync) Update to Revision...',  command: 'vscode-svn.updateToRevision',          needsUri: true },
      { label: isZh ? '$(search) 查看修改状态'  : '$(search) Check for Modifications',command: 'vscode-svn.checkForModifications',     needsUri: true },
      { label: isZh ? '$(diff) 与版本比较'      : '$(diff) Diff with Revision...',    command: 'vscode-svn.diffWithRevision',          needsUri: true },
      { label: isZh ? '$(history) 回滚某版本'    : '$(history) Rollback Revision...',  command: 'vscode-svn.rollback',                  needsUri: true },
      { label: isZh ? '$(eye) 查看历史版本'  : '$(eye) Show at Revision (cat)...',  command: 'vscode-svn.catFile',                  needsUri: false },
      { label: isZh ? '$(clippy) 复制 SVN URL'           : '$(clippy) Copy SVN URL',            command: 'vscode-svn.copyUrl',                   needsUri: true },
      { label: isZh ? '$(references) Externals 管理'  : '$(references) Manage Externals...', command: 'vscode-svn.manageExternals',           needsUri: true },
      { label: isZh ? '$(folder) 稀疏检出'          : '$(folder) Sparse Checkout...',      command: 'vscode-svn.sparseCheckout',            needsUri: false }
    ];
    const picked = await vscode.window.showQuickPick(actions, { placeHolder: isZh ? 'SVN 目录操作' : 'SVN directory actions' });
    if (!picked) return;
    await vscode.commands.executeCommand(picked.command, picked.needsUri ? targetUri : undefined);
  });

  // 在状态栏右侧加一个 SVN 按钮，点击调用上面的 QuickPick
  const svnStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  svnStatusBarItem.text = '$(source-control) SVN';
  svnStatusBarItem.tooltip = '打开 SVN 目录操作菜单';
  svnStatusBarItem.command = 'vscode-svn.showRootMenu';
  svnStatusBarItem.show();

  // 中文别名命令：用于右键菜单展示中文标题，内部转发到原英文命令
  const zhAliasPairs: [string, string][] = [
    ['vscode-svn.updateDirectory',         'vscode-svn.updateDirectory.zh'],
    ['vscode-svn.uploadFolder',            'vscode-svn.uploadFolder.zh'],
    ['vscode-svn.updateFile',              'vscode-svn.updateFile.zh'],
    ['vscode-svn.commitFile',              'vscode-svn.commitFile.zh'],
    ['vscode-svn.diff',                    'vscode-svn.diff.zh'],
    ['vscode-svn.viewLog',                 'vscode-svn.viewLog.zh'],
    ['vscode-svn.resolveFile',             'vscode-svn.resolveFile.zh'],
    ['vscode-svn.svnDelete',               'vscode-svn.svnDelete.zh'],
    ['vscode-svn.revertFile',              'vscode-svn.revertFile.zh'],
    ['vscode-svn.revertFolder',            'vscode-svn.revertFolder.zh'],
    ['vscode-svn.blame',                   'vscode-svn.blame.zh'],
    ['vscode-svn.scanAndResolveConflicts', 'vscode-svn.scanAndResolveConflicts.zh'],
    ['vscode-svn.cleanup',                 'vscode-svn.cleanup.zh'],
    ['vscode-svn.switch',                  'vscode-svn.switch.zh'],
    ['vscode-svn.mergeBranch',             'vscode-svn.mergeBranch.zh'],
    ['vscode-svn.addItem',                 'vscode-svn.addItem.zh'],
    ['vscode-svn.lockFile',                'vscode-svn.lockFile.zh'],
    ['vscode-svn.unlockFile',              'vscode-svn.unlockFile.zh'],
    ['vscode-svn.export',                  'vscode-svn.export.zh'],
    ['vscode-svn.import',                  'vscode-svn.import.zh'],
    ['vscode-svn.createPatch',             'vscode-svn.createPatch.zh'],
    ['vscode-svn.applyPatch',              'vscode-svn.applyPatch.zh'],
    ['vscode-svn.manageProperties',        'vscode-svn.manageProperties.zh'],
    ['vscode-svn.addIgnore',               'vscode-svn.addIgnore.zh'],
    ['vscode-svn.copyPath',                'vscode-svn.copyPath.zh'],
    ['vscode-svn.movePath',                'vscode-svn.movePath.zh'],
    ['vscode-svn.relocate',                'vscode-svn.relocate.zh'],
    ['vscode-svn.createBranchTag',         'vscode-svn.createBranchTag.zh'],
    ['vscode-svn.repoBrowser',             'vscode-svn.repoBrowser.zh'],
    ['vscode-svn.updateToRevision',        'vscode-svn.updateToRevision.zh'],
    ['vscode-svn.checkForModifications',   'vscode-svn.checkForModifications.zh'],
    ['vscode-svn.diffWithRevision',        'vscode-svn.diffWithRevision.zh'],
    ['vscode-svn.rollback',                'vscode-svn.rollback.zh'],
    ['vscode-svn.catFile',                 'vscode-svn.catFile.zh'],
    ['vscode-svn.copyUrl',                 'vscode-svn.copyUrl.zh'],
    ['vscode-svn.manageExternals',         'vscode-svn.manageExternals.zh'],
    ['vscode-svn.sparseCheckout',          'vscode-svn.sparseCheckout.zh'],
    ['vscode-svn.removeIgnore',            'vscode-svn.removeIgnore.zh'],
    ['vscode-svn.quickSetProps',           'vscode-svn.quickSetProps.zh']
  ];
  const zhAliasDisposables = zhAliasPairs.map(([origin, alias]) =>
    vscode.commands.registerCommand(alias, (...args: any[]) => vscode.commands.executeCommand(origin, ...args))
  );

  context.subscriptions.push(
    uploadFileCommand,
    uploadFolderCommand,
    commitFileCommand,
    setSvnRootCommand,
    clearSvnRootCommand,
    updateFileCommand,
    updateDirectoryCommand,
    updateWorkspaceCommand,
    revertFileCommand,
    revertFolderCommand,
    viewLogCommand,
    showLocalRevisionCommand,
    configureFilterCommand,
    showFilterInfoCommand,
    showAICacheStatsCommand,
    clearAICacheCommand,
    cleanExpiredAICacheCommand,
    configureAICommand,
    checkoutCommand,
    manageCredentialsCommand,
    clearCredentialsCommand,
    scanAndResolveConflictsCommand,
    lockFileCommand,
    unlockFileCommand,
    showLockInfoCommand,
    addToChangelistCommand,
    removeFromChangelistCommand,
    manageChangelistsCommand,
    mergeBranchCommand,
    diffCommand,
    blameCommand,
    resolveFileCommand,
    svnDeleteCommand,
    cleanupCommand,
    switchCommand,
    addItemCommand,
    svnExportCommand,
    svnImportCommand,
    svnCreatePatchCommand,
    svnApplyPatchCommand,
    svnManagePropertiesCommand,
    svnAddIgnoreCommand,
    svnCopyPathCommand,
    svnMovePathCommand,
    svnRelocateCommand,
    svnCreateBranchTagCommand,
    svnRepoBrowserCommand,
    svnUpdateToRevisionCommand,
    svnCheckForModificationsCommand,
    svnDiffWithRevisionCommand,
    svnRollbackCommand,
    svnCatFileCommand,
    svnCopyUrlCommand,
    svnManageExternalsCommand,
    svnSparseCheckoutCommand,
    svnRemoveIgnoreCommand,
    svnQuickSetFilePropsCommand,
    showRootMenuCommand,
    svnStatusBarItem,
    ...zhAliasDisposables
  );
}

/**
 * 管理SVN认证信息
 */
async function manageCredentials(context: vscode.ExtensionContext): Promise<void> {
  try {
    const authService = new SvnAuthService(context);
    const credentials = await authService.getAllCredentials();
    
    // 创建认证管理面板
    const panel = SvnAuthDialog.createAuthManagementPanel(
      context.extensionUri,
      credentials
    );
    
    // 处理来自webview的消息
    panel.webview.onDidReceiveMessage(async message => {
      switch (message.command) {
        case 'testCredential':
          try {
            const credential = credentials[message.url];
            if (credential) {
              const result = await authService.validateCredential(
                message.url,
                credential.username,
                credential.password
              );
              
              panel.webview.postMessage({
                command: 'testResult',
                url: message.url,
                success: result.valid,
                message: result.valid ? '认证信息有效' : result.error
              });
            }
          } catch (error: any) {
            panel.webview.postMessage({
              command: 'testResult',
              url: message.url,
              success: false,
              message: `测试失败: ${error.message}`
            });
          }
          break;
          
        case 'deleteCredential':
          try {
            await authService.removeCredential(message.url);
            vscode.window.showInformationMessage('认证信息已删除');
            // 刷新面板
            const updatedCredentials = await authService.getAllCredentials();
            panel.webview.html = SvnAuthDialog.createAuthManagementPanel(
              context.extensionUri,
              updatedCredentials
            ).webview.html;
          } catch (error: any) {
            vscode.window.showErrorMessage(`删除失败: ${error.message}`);
          }
          break;
          
        case 'clearAllCredentials':
          try {
            await authService.clearAllCredentials();
            vscode.window.showInformationMessage('所有认证信息已清除');
            // 刷新面板
            panel.webview.html = SvnAuthDialog.createAuthManagementPanel(
              context.extensionUri,
              {}
            ).webview.html;
          } catch (error: any) {
            vscode.window.showErrorMessage(`清除失败: ${error.message}`);
          }
          break;
          
        case 'addCredential':
          // 显示添加认证信息对话框
          const authResult = await SvnAuthDialog.showAuthDialog('手动添加');
          if (authResult) {
            const url = await vscode.window.showInputBox({
              prompt: '请输入SVN仓库URL',
              placeHolder: 'http://svn.example.com/repo',
              validateInput: (value) => {
                if (!value || value.trim() === '') {
                  return 'URL不能为空';
                }
                return null;
              }
            });
            
            if (url) {
              try {
                await authService.saveCredential(
                  url.trim(),
                  authResult.username,
                  authResult.password,
                  '手动添加'
                );
                vscode.window.showInformationMessage('认证信息已保存');
                // 刷新面板
                const updatedCredentials = await authService.getAllCredentials();
                panel.webview.html = SvnAuthDialog.createAuthManagementPanel(
                  context.extensionUri,
                  updatedCredentials
                ).webview.html;
              } catch (error: any) {
                vscode.window.showErrorMessage(`保存失败: ${error.message}`);
              }
            }
          }
          break;
          
        case 'refreshCredentials':
          // 刷新认证信息列表
          const refreshedCredentials = await authService.getAllCredentials();
          panel.webview.html = SvnAuthDialog.createAuthManagementPanel(
            context.extensionUri,
            refreshedCredentials
          ).webview.html;
          break;
      }
    });
    
  } catch (error: any) {
    vscode.window.showErrorMessage(`打开认证管理面板失败: ${error.message}`);
  }
}

/**
 * 清除所有SVN认证信息
 */
async function clearCredentials(context: vscode.ExtensionContext): Promise<void> {
  try {
    const choice = await vscode.window.showWarningMessage(
      '确认清除所有保存的SVN认证信息？此操作不可恢复！',
      '确认清除',
      '取消'
    );
    
    if (choice === '确认清除') {
      const authService = new SvnAuthService(context);
      await authService.clearAllCredentials();
      vscode.window.showInformationMessage('所有SVN认证信息已清除');
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`清除认证信息失败: ${error.message}`);
  }
}

export function deactivate() {
  console.log('VSCode SVN 扩展已停用');
  
  // 释放AI缓存服务单例
  AiCacheService.destroyInstance();
} 