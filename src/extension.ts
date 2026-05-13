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
      { label: isZh ? '$(trash) SVN 删除'              : '$(trash) Delete',              command: 'vscode-svn.svnDelete',                needsUri: true }
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
    ['vscode-svn.addItem',                 'vscode-svn.addItem.zh']
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