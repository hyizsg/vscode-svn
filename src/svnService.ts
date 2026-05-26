import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import { SvnFilterService } from './filterService';
import { SvnAuthService } from './svnAuthService';
import { SvnAuthDialog } from './svnAuthDialog';

const exec = promisify(cp.exec);
const fsExists = promisify(fs.exists);

interface SvnStatus {
  status: string;
  filePath: string;
}

/**
 * 冲突文件信息
 */
export interface ConflictFile {
  path: string;
  displayName: string;
  conflictType: 'text' | 'tree' | 'property';
  status: string;
}

/**
 * 冲突详情
 */
export interface ConflictDetails {
  filePath: string;
  conflictType: 'text' | 'tree' | 'property';
  mineContent?: string;
  theirsContent?: string;
  baseContent?: string;
  workingContent?: string;
  conflictMarkers?: Array<{
    start: number;
    end: number;
    type: 'mine' | 'theirs' | 'both';
  }>;
}

/**
 * SVN服务类，负责执行SVN命令和管理SVN工作副本
 */
export class SvnService {
  // 存储自定义SVN工作副本路径
  private customSvnRoot: string | undefined;
  private outputChannel: vscode.OutputChannel;
  private filterService: SvnFilterService;
  private _workingCopyPath: string | undefined;
  private authService: SvnAuthService | undefined;

  constructor(context?: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('SVN');
    this.filterService = new SvnFilterService();
    if (context) {
      this.authService = new SvnAuthService(context);
    }
  }

  /**
   * 获取编码配置
   * @returns 编码配置对象
   */
  private getEncodingConfig() {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    return {
      defaultFileEncoding: config.get<string>('defaultFileEncoding', 'auto'),
      forceUtf8Output: config.get<boolean>('forceUtf8Output', true),
      enableEncodingDetection: config.get<boolean>('enableEncodingDetection', true),
      encodingFallbacks: config.get<string[]>('encodingFallbacks', ['utf8', 'gbk', 'gb2312', 'big5']),
      showEncodingInfo: config.get<boolean>('showEncodingInfo', false)
    };
  }

  /**
   * 检测文件编码
   * @param filePath 文件路径
   * @returns 编码类型
   */
  private detectFileEncoding(filePath: string): string {
    const config = this.getEncodingConfig();
    
    // 如果禁用了编码检测，直接使用默认编码
    if (!config.enableEncodingDetection) {
      return config.defaultFileEncoding === 'auto' ? 'utf8' : config.defaultFileEncoding;
    }
    
    // 如果指定了非auto编码，直接使用
    if (config.defaultFileEncoding !== 'auto') {
      this.outputChannel.appendLine(`[detectFileEncoding] 使用配置的默认编码: ${config.defaultFileEncoding}`);
      return config.defaultFileEncoding;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      
      // 检测BOM
      if (buffer.length >= 3) {
        if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
          return 'utf8-bom';
        }
      }
      
      if (buffer.length >= 2) {
        if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
          return 'utf16le';
        }
        if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
          return 'utf16be';
        }
      }
      
      // 尝试解析为UTF-8
      try {
        const text = buffer.toString('utf8');
        // 检查是否包含无效字符
        if (text.includes('\uFFFD')) {
          // 可能是其他编码，尝试检测
          return this.detectChineseEncoding(buffer);
        }
        return 'utf8';
      } catch {
        return this.detectChineseEncoding(buffer);
      }
    } catch (error) {
      this.outputChannel.appendLine(`[detectFileEncoding] 检测文件编码失败: ${error}`);
      return 'utf8'; // 默认使用UTF-8
    }
  }

  /**
   * 检测中文编码
   * @param buffer 文件缓冲区
   * @returns 编码类型
   */
  private detectChineseEncoding(buffer: Buffer): string {
    const config = this.getEncodingConfig();
    
    try {
      // 使用配置的备用编码列表
      const encodings = config.encodingFallbacks;
      
      for (const encoding of encodings) {
        try {
          // 使用iconv-lite库进行编码检测和转换（如果可用）
          const text = buffer.toString(encoding as BufferEncoding);
          
          // 检查是否包含常见中文字符
          const chineseRegex = /[\u4e00-\u9fff]/;
          if (chineseRegex.test(text) && !text.includes('\uFFFD')) {
            this.outputChannel.appendLine(`[detectChineseEncoding] 检测到编码: ${encoding}`);
            return encoding;
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      this.outputChannel.appendLine(`[detectChineseEncoding] 编码检测失败: ${error}`);
    }
    
    return 'utf8'; // 默认返回UTF-8
  }

  /**
   * 转换文本编码为UTF-8
   * @param text 原始文本
   * @param sourceEncoding 源编码
   * @returns UTF-8编码的文本
   */
  private convertToUtf8(text: string, sourceEncoding: string): string {
    try {
      if (sourceEncoding === 'utf8' || sourceEncoding === 'utf8-bom') {
        return text;
      }
      
      // 对于非UTF-8编码，尝试重新编码
      const buffer = Buffer.from(text, sourceEncoding as BufferEncoding);
      return buffer.toString('utf8');
    } catch (error) {
      this.outputChannel.appendLine(`[convertToUtf8] 编码转换失败: ${error}`);
      return text; // 转换失败时返回原文本
    }
  }

  /**
   * 获取增强的环境变量配置
   * @returns 环境变量对象
   */
  private getEnhancedEnvironment(): NodeJS.ProcessEnv {
    const platform = os.platform();
    const baseEnv = { ...process.env };
    const config = this.getEncodingConfig();
    
    // 如果启用了强制UTF-8输出，设置相应的环境变量
    let utf8Env: Record<string, string> = {};
    
    if (config.forceUtf8Output) {
      // 基础UTF-8环境变量
      utf8Env = {
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        LC_CTYPE: 'en_US.UTF-8',
        LC_MESSAGES: 'en_US.UTF-8',
        LANGUAGE: 'en_US.UTF-8',
        SVN_EDITOR: 'echo'  // 避免交互式编辑器
      };
      
      // 根据平台添加特定配置
      if (platform === 'win32') {
        // Windows特定配置
        Object.assign(utf8Env, {
          PYTHONIOENCODING: 'utf-8',
          // 设置代码页为UTF-8
          CHCP: '65001'
        });
      } else if (platform === 'darwin') {
        // macOS特定配置
        Object.assign(utf8Env, {
          LC_COLLATE: 'en_US.UTF-8',
          LC_MONETARY: 'en_US.UTF-8',
          LC_NUMERIC: 'en_US.UTF-8',
          LC_TIME: 'en_US.UTF-8'
        });
      }
    } else {
      // 如果没有强制UTF-8输出，只设置基本的编辑器配置
      utf8Env = {
        SVN_EDITOR: 'echo'  // 避免交互式编辑器
      };
      
      this.outputChannel.appendLine(`[getEnhancedEnvironment] 强制UTF-8输出已禁用，使用系统默认编码`);
    }
    
    // 合并环境变量
    return Object.assign(baseEnv, utf8Env);
  }

  /**
   * 执行SVN命令
   * @param command SVN命令
   * @param path 工作目录
   * @param useXml 是否使用XML输出
   * @returns 命令执行结果
   */
  public async executeSvnCommand(command: string, path: string, useXml: boolean = false): Promise<string> {
    return this.executeSvnCommandWithAuth(command, path, useXml);
  }

  /**
   * 执行SVN命令（支持认证重试）
   * @param command SVN命令
   * @param path 工作目录
   * @param useXml 是否使用XML输出
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @returns 命令执行结果
   */
  private async executeSvnCommandWithAuth(
    command: string, 
    path: string, 
    useXml: boolean = false,
    username?: string,
    password?: string
  ): Promise<string> {
    try {
      this.outputChannel.appendLine(`\n[executeSvnCommand] 执行SVN命令: svn ${command}`);
      this.outputChannel.appendLine(`[executeSvnCommand] 工作目录: ${path}`);
      
      // 步骤1: 首先尝试系统默认认证
      if (!username && !password) {
        try {
          return await this._executeCommand(command, path, useXml);
        } catch (error: any) {
          // 检查是否是认证失败
          if (this._isAuthenticationError(error)) {
            this.outputChannel.appendLine(`[executeSvnCommand] 系统默认认证失败，尝试获取保存的认证信息`);
            
            // 步骤2: 尝试使用保存的认证信息
            if (this.authService) {
              const repoUrl = await this.authService.getRepositoryRootUrl(path);
              if (repoUrl) {
                const savedCredential = await this.authService.getCredential(repoUrl);
                if (savedCredential) {
                  this.outputChannel.appendLine(`[executeSvnCommand] 找到保存的认证信息，用户名: ${savedCredential.username}`);
                  try {
                    const result = await this._executeCommand(command, path, useXml, savedCredential.username, savedCredential.password);
                    // 更新最后使用时间
                    await this.authService.updateLastUsed(repoUrl);
                    return result;
                  } catch (authError: any) {
                    if (this._isAuthenticationError(authError)) {
                      this.outputChannel.appendLine(`[executeSvnCommand] 保存的认证信息已失效，需要重新输入`);
                      // 删除失效的认证信息
                      await this.authService.removeCredential(repoUrl);
                    } else {
                      throw authError; // 不是认证错误，直接抛出
                    }
                  }
                }
              }
              
              // 步骤3: 提示用户输入认证信息
              if (this.authService.getDefaultAuthPrompt()) {
                const authResult = await SvnAuthDialog.showAuthDialog(repoUrl || path);
                if (authResult) {
                  try {
                    const result = await this._executeCommand(command, path, useXml, authResult.username, authResult.password);
                    
                    // 保存认证信息（如果用户选择保存）
                    if (authResult.saveCredentials && repoUrl && this.authService.getAutoSaveCredentials()) {
                      await this.authService.saveCredential(repoUrl, authResult.username, authResult.password);
                      SvnAuthDialog.showAuthSuccessMessage(repoUrl, authResult.username, true);
                    } else {
                      SvnAuthDialog.showAuthSuccessMessage(repoUrl || path, authResult.username, false);
                    }
                    
                    return result;
                  } catch (finalError: any) {
                    if (this._isAuthenticationError(finalError)) {
                      SvnAuthDialog.showAuthFailureMessage(repoUrl || path, '用户名或密码错误');
                    }
                    throw finalError;
                  }
                } else {
                  throw new Error('用户取消了认证操作');
                }
              }
            }
          }
          throw error; // 不是认证错误或无法处理，直接抛出原错误
        }
      } else {
        // 如果已经提供了用户名密码，直接使用
        return await this._executeCommand(command, path, useXml, username, password);
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[executeSvnCommand] 捕获到异常: ${error.message}`);
      throw error;
    }
  }

  /**
   * 实际执行SVN命令的内部方法
   */
  private async _executeCommand(
    command: string, 
    path: string, 
    useXml: boolean = false,
    username?: string,
    password?: string
  ): Promise<string> {
    // 获取增强的环境变量配置
    const env = this.getEnhancedEnvironment();
    
    this.outputChannel.appendLine(`[_executeCommand] 设置编码环境变量: LANG=${env.LANG}, LC_ALL=${env.LC_ALL}`);
    
    // 根据 useXml 参数决定是否添加 --xml 标志
    let xmlFlag = '';
    if (useXml) {
      xmlFlag = '--xml';
      this.outputChannel.appendLine(`[_executeCommand] 添加XML输出标志: ${xmlFlag}`);
    }
    
    // 对于diff命令，添加特殊处理以支持各种编码
    if (command.includes('diff')) {
      if (!command.includes('--force')) {
        command = `${command} --force`;
      }
      // 添加编码相关参数
      if (!command.includes('--internal-diff')) {
        command = `${command} --internal-diff`;
      }
      this.outputChannel.appendLine(`[_executeCommand] 为diff命令添加编码支持参数`);
    }
    
    // 对于log命令，确保使用UTF-8输出
    if (command.includes('log')) {
      if (!command.includes('--xml') && useXml) {
        // XML输出时已经包含编码信息
      }
    }
    
    // 构建完整命令，包含认证信息
    let finalCommand = `svn ${command} ${xmlFlag}`.trim();
    if (username && password) {
      finalCommand += ` --username "${username}" --password "${password}" --non-interactive --trust-server-cert`;
      this.outputChannel.appendLine(`[_executeCommand] 使用认证信息，用户名: ${username}`);
    }
    
    this.outputChannel.appendLine(`[_executeCommand] 最终命令: ${finalCommand.replace(/ --password "[^"]*"/, ' --password "***"')}`);
    
    // 执行命令
    this.outputChannel.appendLine(`[_executeCommand] 开始执行命令...`);
    return new Promise<string>((resolve, reject) => {
      const svnProcess = cp.exec(
        finalCommand, 
        { 
          cwd: path, 
          env,
          maxBuffer: 50 * 1024 * 1024, // 增加缓冲区大小到50MB
          encoding: 'utf8' as BufferEncoding  // 显式指定编码
        },
        (error, stdout, stderr) => {
          if (error) {
            this.outputChannel.appendLine(`[_executeCommand] 命令执行失败，错误码: ${error.code}`);
            if (stderr) {
              // 尝试编码转换
              const convertedStderr = this.processCommandOutput(stderr);
              this.outputChannel.appendLine(`[_executeCommand] 错误输出: ${convertedStderr}`);
              reject(new Error(`SVN错误: ${convertedStderr}`));
            } else {
              this.outputChannel.appendLine(`[_executeCommand] 错误信息: ${error.message}`);
              reject(error);
            }
          } else {
            // 处理输出编码
            const processedOutput = this.processCommandOutput(stdout);
            
            this.outputChannel.appendLine(`[_executeCommand] 命令执行成功，输出长度: ${processedOutput.length} 字节`);
            if (processedOutput.length < 1000) {
              this.outputChannel.appendLine(`[_executeCommand] 输出内容: ${processedOutput.replace(/\n/g, '\\n')}`);
            } else {
              this.outputChannel.appendLine(`[_executeCommand] 输出内容前1000个字符: ${processedOutput.substring(0, 1000).replace(/\n/g, '\\n')}...`);
            }
            resolve(processedOutput);
          }
        }
      );
      
      // 处理实时输出
      if (svnProcess.stdout) {
        svnProcess.stdout.on('data', (data) => {
          const processedData = this.processCommandOutput(data.toString());
          this.outputChannel.appendLine(`[_executeCommand] 命令输出: ${processedData.replace(/\n/g, '\\n')}`);
        });
      }
      
      if (svnProcess.stderr) {
        svnProcess.stderr.on('data', (data) => {
          const processedData = this.processCommandOutput(data.toString());
          this.outputChannel.appendLine(`[_executeCommand] 错误输出: ${processedData.replace(/\n/g, '\\n')}`);
        });
      }
    });
  }

  /**
   * 检查是否是认证失败错误
   */
  private _isAuthenticationError(error: any): boolean {
    const errorMessage = error.message || error.toString();
    return errorMessage.includes('E170001') || 
           errorMessage.includes('Authentication failed') ||
           errorMessage.includes('authentication failed') ||
           errorMessage.includes('认证失败') ||
           errorMessage.includes('用户名或密码') ||
           errorMessage.includes('Authorization failed');
  }

  /**
   * 处理命令输出的编码
   * @param output 原始输出
   * @returns 处理后的输出
   */
  private processCommandOutput(output: string): string {
    try {
      // 检查是否包含乱码字符
      if (output.includes('\uFFFD') || this.hasGarbledText(output)) {
        this.outputChannel.appendLine(`[processCommandOutput] 检测到可能的编码问题，尝试修复`);
        
        // 尝试不同的编码解析
        return this.fixEncodingIssues(output);
      }
      
      return output;
    } catch (error) {
      this.outputChannel.appendLine(`[processCommandOutput] 处理输出编码失败: ${error}`);
      return output; // 处理失败时返回原输出
    }
  }

  /**
   * 检测是否包含乱码文本
   * @param text 文本内容
   * @returns 是否包含乱码
   */
  private hasGarbledText(text: string): boolean {
    // 检测常见的乱码模式
    const garbledPatterns = [
      /[\u00C0-\u00FF]{2,}/,  // 连续的扩展ASCII字符
      /\?{2,}/,              // 连续的问号
      /\uFFFD/,              // 替换字符
      /[\u0080-\u00FF]{3,}/  // 连续的高位字符
    ];
    
    return garbledPatterns.some(pattern => pattern.test(text));
  }

  /**
   * 修复编码问题
   * @param text 有问题的文本
   * @returns 修复后的文本
   */
  private fixEncodingIssues(text: string): string {
    try {
      // 尝试将文本重新编码
      const buffer = Buffer.from(text, 'latin1');
      
      // 尝试不同的编码
      const encodings = ['utf8', 'gbk', 'gb2312', 'big5'];
      
      for (const encoding of encodings) {
        try {
          const decoded = buffer.toString(encoding as BufferEncoding);
          
          // 检查解码结果是否包含中文字符且没有乱码
          if (/[\u4e00-\u9fff]/.test(decoded) && !decoded.includes('\uFFFD')) {
            this.outputChannel.appendLine(`[fixEncodingIssues] 使用编码 ${encoding} 成功修复`);
            return decoded;
          }
        } catch {
          continue;
        }
      }
      
      // 如果所有编码都失败，返回原文本
      this.outputChannel.appendLine(`[fixEncodingIssues] 无法修复编码问题，返回原文本`);
      return text;
    } catch (error) {
      this.outputChannel.appendLine(`[fixEncodingIssues] 修复编码失败: ${error}`);
      return text;
    }
  }

  /**
   * 检查SVN是否已安装
   * @returns 是否已安装
   */
  public async isSvnInstalled(): Promise<boolean> {
    try {
      // 使用增强环境变量执行 svn --version，避免在 macOS 上 extension host
      // 的 PATH 缺少 /opt/homebrew/bin、/usr/local/bin 等导致的误判
      const env = this.getEnhancedEnvironment();
      await exec('svn --version --quiet', { env });
      return true;
    } catch (error: any) {
      this.outputChannel.appendLine(`[isSvnInstalled] 检测 svn 命令失败: ${error && error.message ? error.message : error}`);
      this.outputChannel.appendLine(`[isSvnInstalled] 当前 PATH=${process.env.PATH || ''}`);
      return false;
    }
  }

  /**
   * 设置自定义SVN工作副本路径
   * @param svnRootPath SVN工作副本根目录路径
   * @returns 是否设置成功
   */
  public async setCustomSvnRoot(svnRootPath: string): Promise<boolean> {
    // 检查路径是否存在
    if (!await fsExists(svnRootPath)) {
      return false;
    }

    // 检查是否包含.svn目录
    const svnDirPath = path.join(svnRootPath, '.svn');
    if (!await fsExists(svnDirPath)) {
      return false;
    }

    // 设置自定义SVN工作副本路径
    this.customSvnRoot = svnRootPath;
    
    // 保存到配置中，以便在会话之间保持
    await vscode.workspace.getConfiguration('vscode-svn').update('customSvnRoot', svnRootPath, vscode.ConfigurationTarget.Workspace);
    
    return true;
  }

  /**
   * 获取自定义SVN工作副本路径
   * @returns SVN工作副本根目录路径
   */
  public getCustomSvnRoot(): string | undefined {
    if (!this.customSvnRoot) {
      // 从配置中读取
      this.customSvnRoot = vscode.workspace.getConfiguration('vscode-svn').get<string>('customSvnRoot');
    }
    return this.customSvnRoot;
  }

  /**
   * 清除自定义SVN工作副本路径
   */
  public async clearCustomSvnRoot(): Promise<void> {
    this.customSvnRoot = undefined;
    await vscode.workspace.getConfiguration('vscode-svn').update('customSvnRoot', undefined, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * 检查路径是否在SVN工作副本中
   * @param fsPath 文件系统路径
   * @returns 是否在SVN工作副本中
   */
  public async isInWorkingCopy(fsPath: string): Promise<boolean> {
    try {
      // 首先尝试直接使用svn info命令
      try {
        // 关键修复：executeSvnCommand 的第二个参数是 cwd（工作目录），
        // 之前直接把 fsPath 传过去，当 fsPath 是文件时会被 cp.exec 当作 cwd，
        // 触发 ENOTDIR，导致永远返回 false。
        // 这里统一以路径所在目录作为 cwd，把目标路径作为 svn info 的参数。
        let stat: fs.Stats | undefined;
        try {
          stat = fs.statSync(fsPath);
        } catch {
          // 路径不存在或无法访问
          return false;
        }
        const cwd = stat.isDirectory() ? fsPath : path.dirname(fsPath);
        const target = stat.isDirectory() ? '.' : path.basename(fsPath);
        // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
        const escapedTarget = target.includes('@') ? `${target}@` : target;

        await this.executeSvnCommand(`info "${escapedTarget}"`, cwd);
        return true;
      } catch (error: any) {
        this.outputChannel.appendLine(`[isInWorkingCopy] 直接检查失败: ${error && error.message ? error.message : error}`);
        // 如果直接检查失败，并且有自定义SVN根目录，则使用自定义根目录
        if (this.getCustomSvnRoot()) {
          // 获取相对于自定义SVN根目录的路径
          const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
          // 如果路径以..开头，说明文件不在SVN根目录下
          if (relativePath.startsWith('..')) {
            return false;
          }
          
          // 特殊处理：如果相对路径包含@符号，需要在路径后添加额外的@来转义
          let escapedPath = relativePath;
          if (relativePath.includes('@')) {
            escapedPath = `${relativePath}@`;
          }
          
          // 尝试在自定义SVN根目录下执行svn info命令
          try {
            await this.executeSvnCommand(`info "${escapedPath}"`, this.getCustomSvnRoot()!);
            return true;
          } catch (error) {
            return false;
          }
        }
        return false;
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取文件状态
   * @param filePath 文件路径
   * @returns 文件状态
   */
  public async getFileStatus(filePath: string): Promise<string> {
    try {
      let cwd = path.dirname(filePath);
      let fileName = path.basename(filePath);
      
      this.outputChannel.appendLine(`[getFileStatus] 获取文件状态: ${filePath}`);
      
      // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }
      
      // 如果有自定义SVN根目录，并且直接检查失败，则使用自定义根目录
      if (this.getCustomSvnRoot()) {
        try {
          const result = await this.executeSvnCommand(`status "${fileName}"`, cwd);
          if (result) {
            // 如果直接检查成功，使用直接结果
            this.outputChannel.appendLine(`[getFileStatus] 直接检查成功，状态结果: ${result.substring(0, 100).replace(/\n/g, '\\n')}`);
            return this.parseStatusCode(result);
          }
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
          if (!relativePath.startsWith('..')) {
            cwd = this.getCustomSvnRoot()!;
            fileName = relativePath;
            // 如果相对路径包含@符号，也需要转义
            if (needsEscaping && !fileName.endsWith('@')) {
              fileName = `${fileName}@`;
            }
          }
        }
      }
      
      const result = await this.executeSvnCommand(`status "${fileName}"`, cwd);
      this.outputChannel.appendLine(`[getFileStatus] 状态结果: ${result.substring(0, 100).replace(/\n/g, '\\n')}`);
      return this.parseStatusCode(result);
    } catch (error: any) {
      this.outputChannel.appendLine(`[getFileStatus] 获取状态失败: ${error.message}`);
      return '未知状态';
    }
  }

  /**
   * 解析SVN状态码
   * @param statusResult SVN状态命令结果
   * @returns 状态描述
   */
  private parseStatusCode(statusResult: string): string {
    this.outputChannel.appendLine(`[parseStatusCode] 解析状态码: ${statusResult.substring(0, 100).replace(/\n/g, '\\n')}`);
    
    if (statusResult.trim() === '') {
      return '无修改';
    }
    
    // 检查是否是XML格式的输出
    if (statusResult.includes('<?xml') && statusResult.includes('<wc-status')) {
      // 解析XML格式的状态
      const itemMatch = statusResult.match(/item="([^"]+)"/);
      if (itemMatch && itemMatch[1]) {
        const statusCode = itemMatch[1];
        this.outputChannel.appendLine(`[parseStatusCode] 从XML中提取的状态码: ${statusCode}`);
        
        switch (statusCode) {
          case 'modified': return '已修改';
          case 'added': return '已添加';
          case 'deleted': return '已删除';
          case 'replaced': return '已替换';
          case 'conflicted': return '冲突';
          case 'unversioned': return '未版本控制';
          case 'missing': return '丢失';
          case 'ignored': return '已忽略';
          case 'obstructed': return '类型变更';
          default: return `未知状态(${statusCode})`;
        }
      }
    }
    
    // 如果不是XML格式或无法解析XML，则使用原来的方式解析
    const statusCode = statusResult.trim().charAt(0);
    this.outputChannel.appendLine(`[parseStatusCode] 使用第一个字符作为状态码: ${statusCode}`);
    
    switch (statusCode) {
      case 'M': return '已修改';
      case 'A': return '已添加';
      case 'D': return '已删除';
      case 'R': return '已替换';
      case 'C': return '冲突';
      case '?': return '未版本控制';
      case '!': return '丢失';
      case 'I': return '已忽略';
      case '~': return '类型变更';
      default: return `未知状态(${statusCode})`;
    }
  }

  /**
   * 添加文件到SVN
   * @param filePath 文件路径
   */
  public async addFile(filePath: string): Promise<void> {
    // 检查文件是否应该被排除
    if (this.filterService.shouldExcludeFile(filePath)) {
      vscode.window.showWarningMessage(`文件 ${path.basename(filePath)} 在排除列表中，已跳过添加`);
      return;
    }
    
    let cwd = path.dirname(filePath);
    let fileName = path.basename(filePath);
    
    // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
    // 因为在SVN中@符号用于指定版本号
    const needsEscaping = fileName.includes('@');
    if (needsEscaping) {
      fileName = `${fileName}@`;
    }
    
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        const infoCommand = needsEscaping ? `info "${fileName}"` : `info "${fileName}"`;
        await this.executeSvnCommand(infoCommand, cwd);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
        if (!relativePath.startsWith('..')) {
          cwd = this.getCustomSvnRoot()!;
          fileName = relativePath;
          // 如果相对路径包含@符号，也需要转义
          if (needsEscaping && !fileName.endsWith('@')) {
            fileName = `${fileName}@`;
          }
        }
      }
    }
    
    await this.executeSvnCommand(`add "${fileName}"`, cwd);
  }

  /**
   * 删除文件
   * @param filePath 文件路径
   */
  public async removeFile(filePath: string): Promise<void> {
    let cwd = path.dirname(filePath);
    let fileName = path.basename(filePath);
    
    // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
    // 因为在SVN中@符号用于指定版本号
    const needsEscaping = fileName.includes('@');
    if (needsEscaping) {
      fileName = `${fileName}@`;
    }
    
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        const infoCommand = needsEscaping ? `info "${fileName}"` : `info "${fileName}"`;
        await this.executeSvnCommand(infoCommand, cwd);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
        if (!relativePath.startsWith('..')) {
          cwd = this.getCustomSvnRoot()!;
          fileName = relativePath;
          // 如果相对路径包含@符号，也需要转义
          if (needsEscaping && !fileName.endsWith('@')) {
            fileName = `${fileName}@`;
          }
        }
      }
    }
    
    await this.executeSvnCommand(`remove "${fileName}"`, cwd);
  }

  /**
   * 确保输出面板可见并为新操作做准备
   * @param title 操作标题
   * @private
   */
  private showOutputChannel(title: string): void {
    this.outputChannel.clear();
    this.outputChannel.show(true); // true参数表示聚焦到输出面板
    this.outputChannel.appendLine(`========== ${title}开始 ==========`);
    this.outputChannel.appendLine(`时间: ${new Date().toLocaleString()}`);
    this.outputChannel.appendLine('--------------------------------------');
  }

  /**
   * 提交文件或文件夹
   * @param fsPath 文件系统路径
   * @param message 提交信息
   */
  public async commit(fsPath: string, message: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN提交操作');
    this.outputChannel.appendLine(`提交路径: ${fsPath}`);
    this.outputChannel.appendLine(`提交信息: ${message}`);
    
    // 检查文件是否应该被排除
    if (this.filterService.shouldExcludeFile(fsPath)) {
      this.outputChannel.appendLine(`文件 ${fsPath} 被过滤器排除，跳过提交操作`);
      this.outputChannel.appendLine('========== SVN提交操作跳过 ==========');
      vscode.window.showWarningMessage(`文件 ${path.basename(fsPath)} 在排除列表中，已跳过提交`);
      return;
    }
    
    try {
      const isDirectory = (await vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).type === vscode.FileType.Directory;
      
      this.outputChannel.appendLine('正在检查文件状态...');
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', fsPath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
          if (!relativePath.startsWith('..')) {
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${this.getCustomSvnRoot()!}`);
            this.outputChannel.appendLine(`相对路径: ${relativePath}`);
            this.outputChannel.appendLine('正在提交文件...');
            
            // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            if (isDirectory) {
              const result = await this.executeSvnCommand(`commit "${escapedPath}" -m "${message}"`, this.getCustomSvnRoot()!);
              this.outputChannel.appendLine(result);
              this.outputChannel.appendLine('========== SVN提交操作完成 ==========');
              return;
            } else {
              const result = await this.executeSvnCommand(`commit "${escapedPath}" -m "${message}"`, this.getCustomSvnRoot()!);
              this.outputChannel.appendLine(result);
              this.outputChannel.appendLine('========== SVN提交操作完成 ==========');
              return;
            }
          }
        }
      }
      
      this.outputChannel.appendLine('正在提交文件...');
      if (isDirectory) {
        const result = await this.executeSvnCommand(`commit -m "${message}"`, fsPath);
        this.outputChannel.appendLine(result);
      } else {
        const cwd = path.dirname(fsPath);
        let fileName = path.basename(fsPath);
        
        // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
        if (fileName.includes('@')) {
          fileName = `${fileName}@`;
        }
        
        this.outputChannel.appendLine(`工作目录: ${cwd}`);
        this.outputChannel.appendLine(`文件名: ${fileName}`);
        const result = await this.executeSvnCommand(`commit "${fileName}" -m "${message}"`, cwd);
        this.outputChannel.appendLine(result);
      }
      
      this.outputChannel.appendLine('========== SVN提交操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN提交操作失败 ==========');
      
      // 检查是否是"out of date"错误
      if (this.isOutOfDateError(error.message)) {
        await this.handleOutOfDateError(fsPath, message);
        return; // 如果用户选择了处理，则不再抛出错误
      }
      
      throw error;
    }
  }

  /**
   * 更新工作副本
   * @param fsPath 文件系统路径
   */
  public async update(fsPath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN更新操作');
    this.outputChannel.appendLine(`更新路径: ${fsPath}`);
    
    // 检查文件或文件夹是否应该被排除
    const isDirectory = (await vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).type === vscode.FileType.Directory;
    if ((isDirectory && this.filterService.shouldExcludeFolder(fsPath)) || 
        (!isDirectory && this.filterService.shouldExcludeFile(fsPath))) {
      this.outputChannel.appendLine(`路径 ${fsPath} 被过滤器排除，跳过更新操作`);
      this.outputChannel.appendLine('========== SVN更新操作跳过 ==========');
      vscode.window.showWarningMessage(`${isDirectory ? '文件夹' : '文件'} ${path.basename(fsPath)} 在排除列表中，已跳过更新`);
      return;
    }
    
    try {
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', fsPath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
          if (!relativePath.startsWith('..')) {
            // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${this.getCustomSvnRoot()!}`);
            this.outputChannel.appendLine(`相对路径: ${escapedPath}`);
            const result = await this.executeSvnCommand(`update "${escapedPath}"`, this.getCustomSvnRoot()!);
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN更新操作完成 ==========');
            return;
          }
        }
      }
      
      // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
      let targetPath = fsPath;
      if (fsPath.includes('@') && !isDirectory) { // 只对文件应用转义，目录更新通常不需要指定路径
        targetPath = `${fsPath}@`;
        this.outputChannel.appendLine(`转义路径: ${targetPath}`);
      }
      
      this.outputChannel.appendLine('正在更新工作副本...');
      const updateCommand = isDirectory ? 'update' : `update "${targetPath}"`;
      const workingDir = isDirectory ? fsPath : path.dirname(fsPath);
      const result = await this.executeSvnCommand(updateCommand, workingDir);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN更新操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN更新操作失败 ==========');
      throw error;
    }
  }

  /**
   * 恢复文件到版本库状态
   * @param filePath 文件路径
   */
  public async revertFile(filePath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN恢复操作');
    this.outputChannel.appendLine(`恢复文件: ${filePath}`);
    
    try {
      this.outputChannel.appendLine('正在恢复文件到版本库状态...');
      
      // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
      let targetPath = filePath;
      const fileName = path.basename(filePath);
      if (fileName.includes('@')) {
        targetPath = `${filePath}@`;
      }
      
      // 确定工作目录：向上遍历找到存在的父目录（避免 cwd 不存在导致 ENOENT）
      let cwd = path.dirname(filePath);
      while (cwd && cwd !== path.dirname(cwd)) {
        if (fs.existsSync(cwd)) break;
        cwd = path.dirname(cwd);
      }
      
      try {
        const result = await this.executeSvnCommand(`revert "${targetPath}"`, cwd);
        this.outputChannel.appendLine(result);
      } catch (firstErr: any) {
        // E155038: 目录包含子文件，需要 --depth infinity
        if (firstErr.message && firstErr.message.includes('E155038')) {
          this.outputChannel.appendLine('[revertFile] 目标是目录，使用 --depth infinity 递归恢复...');
          const result = await this.executeSvnCommand(`revert --depth infinity "${targetPath}"`, cwd);
          this.outputChannel.appendLine(result);
        // E155010: 节点未找到，尝试相对路径
        } else if (firstErr.message && firstErr.message.includes('E155010')) {
          this.outputChannel.appendLine('[revertFile] 绝对路径失败，尝试使用相对路径...');
          const wcRoot = this._findWorkingCopyRoot(cwd);
          if (wcRoot) {
            const relativePath = path.relative(wcRoot, targetPath);
            this.outputChannel.appendLine(`[revertFile] 工作副本根: ${wcRoot}, 相对路径: ${relativePath}`);
            const result = await this.executeSvnCommand(`revert "${relativePath}"`, wcRoot);
            this.outputChannel.appendLine(result);
          } else {
            throw firstErr;
          }
        } else {
          throw firstErr;
        }
      }
      this.outputChannel.appendLine('========== SVN恢复操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN恢复操作失败 ==========');
      throw new Error(`恢复文件失败: ${error.message}`);
    }
  }

  /**
   * 批量恢复文件到版本库状态（仿 TortoiseSVN：--targets 文件 + 路径去重）
   * - 按深度升序排序后剔除被祖先目录覆盖的子路径（否则父 revert 后子路径会报 E155010）
   * - 用临时 --targets 文件传入，避免命令行长度限制
   * - --depth infinity 让目录级 revert 递归生效
   * @param filePaths 文件路径数组
   */
  public async revertFiles(filePaths: string[]): Promise<void> {
    if (!filePaths || filePaths.length === 0) return;
    this.showOutputChannel('SVN批量恢复操作');
    this.outputChannel.appendLine(`批量恢复 ${filePaths.length} 个文件`);

    let tmpFile: string | null = null;
    try {
      // 1. 路径规范化 + 去重
      const normalized = Array.from(new Set(
        filePaths.map(fp => path.normalize(fp))
      ));

      // 2. 按路径长度升序排序 → 祖先在前
      normalized.sort((a, b) => a.length - b.length);

      // 3. 剔除被已存在祖先覆盖的子路径（关键：避免父 revert 后子路径 E155010）
      const roots: string[] = [];
      for (const p of normalized) {
        const covered = roots.some(root => {
          const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
          return p === root || p.startsWith(rootWithSep);
        });
        if (!covered) {
          roots.push(p);
        }
      }
      this.outputChannel.appendLine(`[revertFiles] 原 ${filePaths.length} 个路径去重/剔除子路径后剩 ${roots.length} 个顶级节点`);

      // 4. 处理文件名包含 @ 的特殊转义
      const targets = roots.map(fp => {
        const fileName = path.basename(fp);
        return fileName.includes('@') ? `${fp}@` : fp;
      });

      // 5. 确定工作目录：向上遍历找到存在的父目录
      let cwd = path.dirname(roots[0]);
      while (cwd && cwd !== path.dirname(cwd)) {
        if (fs.existsSync(cwd)) break;
        cwd = path.dirname(cwd);
      }

      // 6. 写 --targets 临时文件（每行一个路径，避免命令行长度限制）
      tmpFile = path.join(os.tmpdir(), `svn-revert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.writeFileSync(tmpFile, targets.join('\n'), 'utf8');

      try {
        const result = await this.executeSvnCommand(`revert --depth infinity --targets "${tmpFile}"`, cwd);
        this.outputChannel.appendLine(result);
      } catch (firstErr: any) {
        // E155010: 节点未找到，尝试从工作副本根使用相对路径再 targets 一次
        if (firstErr.message && firstErr.message.includes('E155010')) {
          this.outputChannel.appendLine('[revertFiles] 绝对路径失败，尝试使用相对路径...');
          const wcRoot = this._findWorkingCopyRoot(cwd);
          if (wcRoot) {
            const relTargets = targets.map(t => path.relative(wcRoot, t));
            fs.writeFileSync(tmpFile, relTargets.join('\n'), 'utf8');
            this.outputChannel.appendLine(`[revertFiles] 工作副本根: ${wcRoot}`);
            const result = await this.executeSvnCommand(`revert --depth infinity --targets "${tmpFile}"`, wcRoot);
            this.outputChannel.appendLine(result);
          } else {
            throw firstErr;
          }
        } else {
          throw firstErr;
        }
      }
      this.outputChannel.appendLine('========== SVN批量恢复操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN批量恢复操作失败 ==========');
      throw new Error(`批量恢复失败: ${error.message}`);
    } finally {
      if (tmpFile) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    }
  }

  /**
   * 批量将多个文件从 changelist 中移除（一次 SVN 进程）
   * 仿 TortoiseSVN 使用 --targets 文件：安全处理长参数与特殊字符
   */
  public async removeFromChangelistBatch(filePaths: string[]): Promise<void> {
    if (!filePaths || filePaths.length === 0) return;
    this.showOutputChannel('SVN Changelist 批量移除');
    this.outputChannel.appendLine(`批量将 ${filePaths.length} 个文件从 changelist 移除`);

    let tmpFile: string | null = null;
    try {
      // 处理 @ 转义
      const targets = filePaths.map(fp => {
        const fileName = path.basename(fp);
        return fileName.includes('@') ? `${fp}@` : fp;
      });

      // 确定工作目录：以第一个文件的父目录为基向上寻存在路径
      let cwd = path.dirname(filePaths[0]);
      while (cwd && cwd !== path.dirname(cwd)) {
        if (fs.existsSync(cwd)) break;
        cwd = path.dirname(cwd);
      }

      // 使用 --targets 文件避免命令行长度限制
      tmpFile = path.join(os.tmpdir(), `svn-cl-remove-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.writeFileSync(tmpFile, targets.join('\n'), 'utf8');

      try {
        const result = await this.executeSvnCommand(`changelist --remove --targets "${tmpFile}"`, cwd);
        this.outputChannel.appendLine(result);
      } catch (clErr: any) {
        // 部分文件已不在 changelist 中时 svn 会非 0 退出，但已处理的文件仍然生效，在批量场景下容忍
        this.outputChannel.appendLine(`[changelist --remove] 部分文件可能已不在 changelist 中，忽略：${clErr.message || clErr}`);
      }
      this.outputChannel.appendLine('========== SVN Changelist 批量移除完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN Changelist 批量移除失败 ==========');
      // 不抑制抛出，但考虑 revert 后 changelist 清理是副作用，不应让整体操作失败
      throw new Error(`批量移出 changelist 失败: ${error.message}`);
    } finally {
      if (tmpFile) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    }
  }

  /**
   * 向上查找 SVN 工作副本根目录（包含 .svn 的最顶层目录）
   */
  private _findWorkingCopyRoot(startDir: string): string | null {
    let dir = startDir;
    let lastSvnDir: string | null = null;
    while (dir && dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.svn'))) {
        lastSvnDir = dir;
      }
      dir = path.dirname(dir);
    }
    return lastSvnDir;
  }

  /**
   * 恢复文件夹到版本库状态（递归恢复）
   * @param folderPath 文件夹路径
   */
  public async revertFolder(folderPath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN文件夹恢复操作');
    this.outputChannel.appendLine(`恢复文件夹: ${folderPath}`);
    
    // 检查文件夹是否应该被排除
    if (this.filterService.shouldExcludeFolder(folderPath)) {
      this.outputChannel.appendLine(`文件夹 ${folderPath} 被过滤器排除，跳过恢复操作`);
      this.outputChannel.appendLine('========== SVN文件夹恢复操作跳过 ==========');
      vscode.window.showWarningMessage(`文件夹 ${path.basename(folderPath)} 在排除列表中，已跳过恢复`);
      return;
    }
    
    try {
      let workingDir = folderPath;
      let targetPath = '.';
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', folderPath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, folderPath);
          if (!relativePath.startsWith('..')) {
            workingDir = this.getCustomSvnRoot()!;
            targetPath = relativePath || '.';
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${workingDir}`);
            this.outputChannel.appendLine(`相对路径: ${targetPath}`);
          }
        }
      }
      
      this.outputChannel.appendLine('正在恢复文件夹到版本库状态（递归）...');
      this.outputChannel.appendLine(`工作目录: ${workingDir}`);
      this.outputChannel.appendLine(`目标路径: ${targetPath}`);
      
      // 使用 -R 参数进行递归恢复
      const result = await this.executeSvnCommand(`revert -R "${targetPath}"`, workingDir);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN文件夹恢复操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN文件夹恢复操作失败 ==========');
      throw new Error(`恢复文件夹失败: ${error.message}`);
    }
  }

  /**
   * 获取文件日志
   * @param filePath 文件路径
   * @param limit 限制条数
   * @returns 日志信息
   */
  public async getLog(filePath: string, limit: number = 10): Promise<string> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN日志查询');
    this.outputChannel.appendLine(`文件路径: ${filePath}`);
    this.outputChannel.appendLine(`限制条数: ${limit}`);
    
    try {
      let cwd = path.dirname(filePath);
      let fileName = path.basename(filePath);
      
      this.outputChannel.appendLine(`工作目录: ${cwd}`);
      this.outputChannel.appendLine(`文件名: ${fileName}`);
      
      // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          const infoCommand = needsEscaping ? `info "${fileName}"` : `info "${fileName}"`;
          await this.executeSvnCommand(infoCommand, cwd);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
          if (!relativePath.startsWith('..')) {
            cwd = this.getCustomSvnRoot()!;
            fileName = relativePath;
            // 如果相对路径包含@符号，也需要转义
            if (needsEscaping && !fileName.endsWith('@')) {
              fileName = `${fileName}@`;
            }
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${cwd}`);
            this.outputChannel.appendLine(`相对路径: ${fileName}`);
          }
        }
      }
      
      this.outputChannel.appendLine('正在获取日志...');
      const result = await this.executeSvnCommand(`log "${fileName}" -l ${limit}`, cwd);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN日志查询完成 ==========');
      
      return result;
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN日志查询失败 ==========');
      throw error;
    }
  }

  /**
   * 一次性提交多个文件
   * @param files 文件路径数组
   * @param message 提交信息
   * @param basePath 基础路径（用于确定工作目录）
   */
  public async commitFiles(files: string[], message: string, basePath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN批量提交操作');
    this.outputChannel.appendLine(`基础路径: ${basePath}`);
    this.outputChannel.appendLine(`提交信息: ${message}`);
    this.outputChannel.appendLine(`原始文件数量: ${files.length}`);
    
    // 应用过滤器
    const filteredFiles = this.filterService.filterFiles(files, basePath);
    const excludedFiles = files.filter(file => !filteredFiles.includes(file));
    
    this.outputChannel.appendLine(`过滤后文件数量: ${filteredFiles.length}`);
    if (excludedFiles.length > 0) {
      this.outputChannel.appendLine('被排除的文件:');
      excludedFiles.forEach((file, index) => {
        this.outputChannel.appendLine(`  ${index + 1}. ${file} (已排除)`);
      });
    }
    
    this.outputChannel.appendLine('要提交的文件列表:');
    filteredFiles.forEach((file, index) => {
      this.outputChannel.appendLine(`  ${index + 1}. ${file}`);
    });
    
    try {
      if (filteredFiles.length === 0) {
        throw new Error('没有可提交的文件（所有文件都被过滤器排除）');
      }
      
      // 检查是否使用自定义SVN根目录
      let workingDir = basePath;
      let fileArgs = '';
      
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', basePath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          workingDir = this.getCustomSvnRoot()!;
          
          this.outputChannel.appendLine(`使用自定义SVN根目录: ${workingDir}`);
          this.outputChannel.appendLine('正在处理文件路径...');
          
          // 构建相对路径参数
          fileArgs = filteredFiles.map(file => {
            const relativePath = path.relative(this.getCustomSvnRoot()!, file);
            if (relativePath.startsWith('..')) {
              throw new Error(`文件 ${file} 不在SVN工作副本中`);
            }
            
            // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            this.outputChannel.appendLine(`  ${file} -> ${escapedPath}`);
            return `"${escapedPath}"`;
          }).join(' ');
        }
      }
      
      // 如果没有使用自定义SVN根目录，或者检查成功
      if (fileArgs === '') {
        this.outputChannel.appendLine('正在处理文件路径...');
        
        // 构建文件参数
        fileArgs = filteredFiles.map(file => {
          // 如果文件在基础路径下，使用相对路径
          if (file.startsWith(workingDir)) {
            const relativePath = path.relative(workingDir, file);
            
            // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            this.outputChannel.appendLine(`  ${file} -> ${escapedPath}`);
            return `"${escapedPath}"`;
          }
          
          // 否则使用绝对路径
          // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
          let escapedPath = file;
          if (file.includes('@')) {
            escapedPath = `${file}@`;
          }
          
          this.outputChannel.appendLine(`  ${file} -> ${escapedPath} (绝对路径)`);
          return `"${escapedPath}"`;
        }).join(' ');
      }
      
      this.outputChannel.appendLine(`工作目录: ${workingDir}`);
      
      // 执行提交命令
      this.outputChannel.appendLine('正在提交文件...');
      const result = await this.executeSvnCommand(`commit ${fileArgs} -m "${message}"`, workingDir);
      this.outputChannel.appendLine(result);
      
      this.outputChannel.appendLine('========== SVN批量提交操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN批量提交操作失败 ==========');
      
      // 检查是否是"out of date"错误
      if (this.isOutOfDateError(error.message)) {
        await this.handleOutOfDateError(basePath, message, filteredFiles);
        return; // 如果用户选择了处理，则不再抛出错误
      }
      
      throw error;
    }
  }

  /**
   * 检查是否是"out of date"错误
   * @param errorMessage 错误消息
   * @returns 是否是"out of date"错误
   */
  private isOutOfDateError(errorMessage: string): boolean {
    return errorMessage.includes('out of date') || 
           errorMessage.includes('E155011') || 
           errorMessage.includes('E170004');
  }

  /**
   * 处理"out of date"错误
   * @param fsPath 文件系统路径
   * @param message 提交信息
   * @param files 可选的文件列表（用于批量提交）
   */
  private async handleOutOfDateError(fsPath: string, message: string, files?: string[]): Promise<void> {
    const result = await vscode.window.showWarningMessage(
      'SVN提交失败：工作副本版本过时，需要先更新到最新版本后再提交',
      {
        modal: true,
        detail: '这通常发生在其他人已经提交了对相同文件或文件夹的修改。\n\n建议先更新工作副本到最新版本，然后再重新提交。'
      },
      '自动更新并重试提交',
      '仅更新不重试',
      '取消'
    );

    if (result === '自动更新并重试提交') {
      try {
        // 先更新工作副本
        await this.update(fsPath);
        
        // 显示更新成功提示
        vscode.window.showInformationMessage('工作副本已更新到最新版本');
        
        // 询问是否继续提交
        const continueResult = await vscode.window.showInformationMessage(
          '工作副本已更新完成，是否继续提交？',
          '继续提交',
          '取消'
        );
        
        if (continueResult === '继续提交') {
          // 重新尝试提交
          if (files && files.length > 0) {
            // 批量提交
            await this.commitFiles(files, message, fsPath);
          } else {
            // 单文件提交
            await this.commit(fsPath, message);
          }
          
          vscode.window.showInformationMessage('提交成功！');
        }
      } catch (updateError: any) {
        vscode.window.showErrorMessage(`更新失败: ${updateError.message}`);
        throw updateError;
      }
    } else if (result === '仅更新不重试') {
      try {
        await this.update(fsPath);
        vscode.window.showInformationMessage('工作副本已更新到最新版本，请手动重新提交');
      } catch (updateError: any) {
        vscode.window.showErrorMessage(`更新失败: ${updateError.message}`);
        throw updateError;
      }
    } else {
      // 用户选择取消，抛出原始错误
      throw new Error('SVN提交失败：工作副本版本过时，需要先更新');
    }
  }

  /**
   * 测试SVN连接
   * @param svnUrl SVN地址
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @returns 连接测试结果
   */
  public async testConnection(svnUrl: string, username?: string, password?: string): Promise<{ success: boolean; message: string }> {
    this.outputChannel.appendLine(`\n[testConnection] 测试SVN连接: ${svnUrl}`);
    
    try {
      // 记录认证信息
      if (username && password) {
        this.outputChannel.appendLine(`[testConnection] 使用自定义认证信息，用户名: ${username}`);
      } else {
        this.outputChannel.appendLine(`[testConnection] 使用默认认证信息`);
      }
      
      // 构建参数数组
      const args = ['info', svnUrl];
      if (username && password) {
        args.push('--username', username, '--password', password);
      }
      args.push('--non-interactive', '--trust-server-cert');
      
      this.outputChannel.appendLine(`[testConnection] 执行参数: ${JSON.stringify(args)}`);
      
      // 获取增强的环境变量配置
      const env = this.getEnhancedEnvironment();
      
      const result = await new Promise<string>((resolve, reject) => {
        const svnProcess = cp.spawn('svn', args, {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        
        svnProcess.stdout?.on('data', (data) => {
          stdout += data.toString();
        });
        
        svnProcess.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        
        svnProcess.on('close', (code) => {
          if (code === 0) {
            const processedOutput = this.processCommandOutput(stdout);
            this.outputChannel.appendLine(`[testConnection] 连接测试成功`);
            resolve(processedOutput);
          } else {
            const convertedStderr = this.processCommandOutput(stderr);
            this.outputChannel.appendLine(`[testConnection] 命令执行失败，代码: ${code}`);
            this.outputChannel.appendLine(`[testConnection] 错误输出: ${convertedStderr}`);
            reject(new Error(convertedStderr));
          }
        });
        
        svnProcess.on('error', (error) => {
          this.outputChannel.appendLine(`[testConnection] 进程错误: ${error.message}`);
          reject(error);
        });
        
        // 30秒超时
        setTimeout(() => {
          svnProcess.kill();
          reject(new Error('连接超时'));
        }, 30000);
      });
      
      // 解析结果，提取有用信息
      const lines = result.split('\n');
      let repoInfo = '';
      
      for (const line of lines) {
        if (line.includes('Repository Root:') || line.includes('仓库根:')) {
          repoInfo += line.trim() + '\n';
        } else if (line.includes('Revision:') || line.includes('修订版本:')) {
          repoInfo += line.trim() + '\n';
        } else if (line.includes('Last Changed Date:') || line.includes('最后修改日期:')) {
          repoInfo += line.trim() + '\n';
        }
      }
      
      return {
        success: true,
        message: repoInfo || '连接成功，仓库可访问'
      };
    } catch (error: any) {
      this.outputChannel.appendLine(`[testConnection] 连接测试失败: ${error.message}`);
      
      // 分析错误类型并提供友好的错误信息
      let friendlyMessage = error.message;
      
      if (error.message.includes('E170001') || error.message.includes('Authentication failed')) {
        friendlyMessage = '认证失败：用户名或密码错误';
      } else if (error.message.includes('E170013') || error.message.includes('Unable to connect')) {
        friendlyMessage = '无法连接到SVN服务器：请检查网络连接和服务器地址';
      } else if (error.message.includes('E200014') || error.message.includes('Not found')) {
        friendlyMessage = 'SVN地址不存在：请检查仓库地址是否正确';
      } else if (error.message.includes('timeout')) {
        friendlyMessage = '连接超时：服务器响应时间过长，请检查网络连接';
      } else if (error.message.includes('certificate')) {
        friendlyMessage = 'SSL证书错误：服务器证书验证失败';
      }
      
      return {
        success: false,
        message: friendlyMessage
      };
    }
  }

  /**
   * 获取SVN仓库中的文件总数
   * @param svnUrl SVN仓库地址
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @returns 文件总数，失败时返回-1
   */
  public async getRepositoryFileCount(
    svnUrl: string,
    username?: string,
    password?: string
  ): Promise<number> {
    try {
      this.outputChannel.appendLine(`[getFileCount] 正在获取仓库文件总数: ${svnUrl}`);
      
      // 获取增强的环境变量配置
      const env = this.getEnhancedEnvironment();
      
      return await new Promise<number>((resolve) => {
        // 构建命令参数
        const args = ['list', '-R', svnUrl];
        if (username && password) {
          args.push('--username', username, '--password', password);
        }
        args.push('--non-interactive', '--trust-server-cert');
        
        this.outputChannel.appendLine(`[getFileCount] 执行命令参数: ${JSON.stringify(args)}`);
        
        // 执行SVN list命令
        const svnProcess = cp.spawn('svn', args, {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let outputBuffer = '';
        let errorBuffer = '';
        
        // 处理标准输出
        svnProcess.stdout?.on('data', (data) => {
          const output = this.processCommandOutput(data.toString());
          outputBuffer += output;
        });
        
        // 处理错误输出
        svnProcess.stderr?.on('data', (data) => {
          const error = this.processCommandOutput(data.toString());
          errorBuffer += error;
        });
        
        // 处理进程退出
        svnProcess.on('close', (code) => {
          if (code === 0) {
            // 成功获取列表，统计文件数量
            const lines = outputBuffer.split('\n').filter(line => line.trim() !== '');
            // 过滤掉目录（以/结尾的条目）
            const fileCount = lines.filter(line => !line.endsWith('/')).length;
            
            this.outputChannel.appendLine(`[getFileCount] 成功获取文件总数: ${fileCount}`);
            resolve(fileCount);
          } else {
            // 获取失败
            this.outputChannel.appendLine(`[getFileCount] 获取文件总数失败: ${errorBuffer}`);
            resolve(-1);
          }
        });
        
        // 处理进程错误
        svnProcess.on('error', (error) => {
          this.outputChannel.appendLine(`[getFileCount] 进程错误: ${error.message}`);
          resolve(-1);
        });
        
        // 设置超时（2分钟）
        setTimeout(() => {
          svnProcess.kill();
          this.outputChannel.appendLine('[getFileCount] 获取文件总数超时');
          resolve(-1);
        }, 2 * 60 * 1000); // 2分钟超时
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[getFileCount] 获取文件总数异常: ${error.message}`);
      return -1;
    }
  }

  /**
   * 执行SVN检出操作
   * @param svnUrl SVN地址
   * @param targetDirectory 目标目录
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @param progressCallback 进度回调函数
   * @returns 检出操作结果
   */
  public async checkout(
    svnUrl: string, 
    targetDirectory: string, 
    username?: string, 
    password?: string,
    progressCallback?: (message: string, progress?: number) => void
  ): Promise<{ success: boolean; message: string }> {
    this.showOutputChannel('SVN检出操作');
    this.outputChannel.appendLine(`SVN地址: ${svnUrl}`);
    this.outputChannel.appendLine(`目标目录: ${targetDirectory}`);
    
    try {
      // 检查目标目录是否存在，如果不存在则创建
      if (!await fsExists(targetDirectory)) {
        await fs.promises.mkdir(targetDirectory, { recursive: true });
        this.outputChannel.appendLine(`创建目标目录: ${targetDirectory}`);
      }
      
      // 检查目标目录是否为空（或只包含.svn目录）
      const files = await fs.promises.readdir(targetDirectory);
      const nonSvnFiles = files.filter(file => file !== '.svn');
      
      if (nonSvnFiles.length > 0) {
        this.outputChannel.appendLine(`警告: 目标目录不为空，包含 ${nonSvnFiles.length} 个文件/文件夹`);
        // 这里可以选择是否继续，但通常SVN checkout可以在非空目录中进行
      }
      
      // 记录认证信息
      if (username && password) {
        this.outputChannel.appendLine(`使用自定义认证信息，用户名: ${username}`);
      } else {
        this.outputChannel.appendLine(`使用默认认证信息`);
      }
      
      // 先获取文件总数，用于准确计算进度
      let totalFileCount = -1;
      if (progressCallback) {
        progressCallback('正在连接SVN服务器...', 5);
        progressCallback('正在获取仓库文件信息...', 10);
        
        totalFileCount = await this.getRepositoryFileCount(svnUrl, username, password);
        if (totalFileCount > 0) {
          this.outputChannel.appendLine(`仓库包含 ${totalFileCount} 个文件`);
          progressCallback(`发现 ${totalFileCount} 个文件，准备开始检出...`, 15);
        } else {
          this.outputChannel.appendLine(`无法获取文件总数，将使用传统进度计算方式`);
          progressCallback('准备开始检出...', 15);
        }
      }
      
      // 获取增强的环境变量配置
      const env = this.getEnhancedEnvironment();
      
      return await new Promise<{ success: boolean; message: string }>((resolve, reject) => {
        // 正确解析命令参数，避免引号问题
        const args = ['checkout', svnUrl, targetDirectory];
        if (username && password) {
          args.push('--username', username, '--password', password);
        }
        args.push('--non-interactive', '--trust-server-cert');
        
        this.outputChannel.appendLine(`[checkout] 实际执行参数: ${JSON.stringify(args)}`);
        
        const svnProcess = cp.spawn('svn', args, {
          cwd: path.dirname(targetDirectory),
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let outputBuffer = '';
        let errorBuffer = '';
        let currentProgress = 15;  // 从15%开始，因为前面已经完成了文件总数获取
        let checkedOutFileCount = 0;  // 已检出的文件数量
        
        // 处理标准输出
        svnProcess.stdout?.on('data', (data) => {
          const output = this.processCommandOutput(data.toString());
          outputBuffer += output;
          this.outputChannel.appendLine(`[checkout] 输出: ${output.replace(/\n/g, '\\n')}`);
          
          // 解析进度信息
          if (progressCallback) {
            if (output.includes('A ') || output.includes('添加')) {
              checkedOutFileCount++;
              
              // 根据文件总数计算准确进度
              if (totalFileCount > 0) {
                // 15% - 95% 的范围用于文件检出进度
                const fileProgress = Math.min((checkedOutFileCount / totalFileCount) * 80, 80);
                currentProgress = 15 + fileProgress;
              } else {
                // 传统方式：每个文件增加1%，最大90%
                currentProgress = Math.min(currentProgress + 1, 90);
              }
              
              const match = output.match(/A\s+(.+)/);
              if (match) {
                const fileName = path.basename(match[1]);
                if (totalFileCount > 0) {
                  progressCallback(`正在检出: ${fileName} (${checkedOutFileCount}/${totalFileCount})`, Math.round(currentProgress));
                } else {
                  progressCallback(`正在检出: ${fileName}`, Math.round(currentProgress));
                }
              } else {
                if (totalFileCount > 0) {
                  progressCallback(`正在检出文件... (${checkedOutFileCount}/${totalFileCount})`, Math.round(currentProgress));
                } else {
                  progressCallback('正在检出文件...', Math.round(currentProgress));
                }
              }
            } else if (output.includes('Checked out') || output.includes('检出完成')) {
              progressCallback('检出完成', 100);
            }
          }
        });
        
        // 处理错误输出
        svnProcess.stderr?.on('data', (data) => {
          const error = this.processCommandOutput(data.toString());
          errorBuffer += error;
          this.outputChannel.appendLine(`[checkout] 错误: ${error.replace(/\n/g, '\\n')}`);
          
          // 某些SVN版本会将进度信息输出到stderr
          if (progressCallback && (error.includes('A ') || error.includes('添加'))) {
            checkedOutFileCount++;
            
            // 根据文件总数计算准确进度
            if (totalFileCount > 0) {
              // 15% - 95% 的范围用于文件检出进度
              const fileProgress = Math.min((checkedOutFileCount / totalFileCount) * 80, 80);
              currentProgress = 15 + fileProgress;
            } else {
              // 传统方式：每个文件增加1%，最大90%
              currentProgress = Math.min(currentProgress + 1, 90);
            }
            
            const match = error.match(/A\s+(.+)/);
            if (match) {
              const fileName = path.basename(match[1]);
              if (totalFileCount > 0) {
                progressCallback(`正在检出: ${fileName} (${checkedOutFileCount}/${totalFileCount})`, Math.round(currentProgress));
              } else {
                progressCallback(`正在检出: ${fileName}`, Math.round(currentProgress));
              }
            }
          }
        });
        
        // 处理进程退出
        svnProcess.on('close', (code) => {
          this.outputChannel.appendLine(`[checkout] 进程退出，代码: ${code}`);
          
          if (code === 0) {
            // 检出成功
            const successMessage = `SVN检出成功完成\n目标目录: ${targetDirectory}`;
            this.outputChannel.appendLine(successMessage);
            this.outputChannel.appendLine('========== SVN检出操作完成 ==========');
            
            if (progressCallback) {
              progressCallback('检出完成', 100);
            }
            
            resolve({
              success: true,
              message: successMessage
            });
          } else {
            // 检出失败
            let errorMessage = errorBuffer || '检出操作失败';
            
            // 分析错误类型
            if (errorBuffer.includes('E170001') || errorBuffer.includes('Authentication failed')) {
              errorMessage = '认证失败：用户名或密码错误';
            } else if (errorBuffer.includes('E170013') || errorBuffer.includes('Unable to connect')) {
              errorMessage = '无法连接到SVN服务器：请检查网络连接和服务器地址';
            } else if (errorBuffer.includes('E200014') || errorBuffer.includes('Not found')) {
              errorMessage = 'SVN地址不存在：请检查仓库地址是否正确';
            } else if (errorBuffer.includes('E155000') || errorBuffer.includes('already a working copy')) {
              errorMessage = '目标目录已经是一个SVN工作副本';
            }
            
            this.outputChannel.appendLine(`错误: ${errorMessage}`);
            this.outputChannel.appendLine('========== SVN检出操作失败 ==========');
            
            if (progressCallback) {
              progressCallback('检出失败', 0);
            }
            
            resolve({
              success: false,
              message: errorMessage
            });
          }
        });
        
        // 处理进程错误
        svnProcess.on('error', (error) => {
          this.outputChannel.appendLine(`[checkout] 进程错误: ${error.message}`);
          this.outputChannel.appendLine('========== SVN检出操作失败 ==========');
          
          if (progressCallback) {
            progressCallback('检出失败', 0);
          }
          
          resolve({
            success: false,
            message: `检出进程启动失败: ${error.message}`
          });
        });
        
        // 设置超时（30分钟）
        setTimeout(() => {
          svnProcess.kill();
          this.outputChannel.appendLine('[checkout] 检出操作超时');
          this.outputChannel.appendLine('========== SVN检出操作超时 ==========');
          
          if (progressCallback) {
            progressCallback('检出超时', 0);
          }
          
          resolve({
            success: false,
            message: '检出操作超时（30分钟），可能是文件过多或网络问题'
          });
        }, 30 * 60 * 1000); // 30分钟超时
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[checkout] 检出操作异常: ${error.message}`);
      this.outputChannel.appendLine('========== SVN检出操作失败 ==========');
      
      if (progressCallback) {
        progressCallback('检出失败', 0);
      }
      
      return {
        success: false,
        message: `检出操作失败: ${error.message}`
      };
    }
  }

  /**
   * 扫描文件夹中的冲突文件
   * @param folderPath 文件夹路径
   * @param progressCallback 进度回调函数
   * @returns 冲突文件列表
   */
  public async scanConflicts(
    folderPath: string,
    progressCallback?: (currentFile: string, progress: number) => void
  ): Promise<ConflictFile[]> {
    this.showOutputChannel('SVN冲突扫描');
    this.outputChannel.appendLine(`扫描路径: ${folderPath}`);
    
    try {
      const conflictFiles: ConflictFile[] = [];
      
      // 执行 svn status 命令查找冲突文件
      this.outputChannel.appendLine('正在执行SVN status命令查找冲突文件...');
      const statusResult = await this.executeSvnCommand('status', folderPath, false);
      
      // 解析状态输出，查找状态为 'C' 的文件
      const lines = statusResult.split('\n').map(line => line.trim()).filter(line => line);
      
      let processedCount = 0;
      const totalLines = lines.length;
      
      for (const line of lines) {
        // SVN status 输出格式：第一列是状态码，后面是文件路径
        if (line.length === 0) continue;
        
        const status = line[0];
        const match = line.match(/^.[ A-Z+*!~]* {2,}(.+)$/);
        const filePath = match ? match[1] : line.replace(/^.\s+/, '').trim();
        
        if (status === 'C') {
          // 找到冲突文件
          const absolutePath = path.resolve(folderPath, filePath);
          
          // 检测冲突类型
          const conflictType = await this._detectConflictType(absolutePath);
          
          conflictFiles.push({
            path: absolutePath,
            displayName: filePath,
            conflictType,
            status: '冲突'
          });
          
          this.outputChannel.appendLine(`发现冲突文件: ${filePath} (${conflictType === 'text' ? '文本冲突' : conflictType === 'tree' ? '树冲突' : '属性冲突'})`);
        }
        
        processedCount++;
        if (progressCallback) {
          const progress = Math.round((processedCount / totalLines) * 100);
          progressCallback(filePath, progress);
        }
      }
      
      this.outputChannel.appendLine(`扫描完成，共发现 ${conflictFiles.length} 个冲突文件`);
      this.outputChannel.appendLine('========== SVN冲突扫描完成 ==========');
      
      return conflictFiles;
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN冲突扫描失败 ==========');
      throw error;
    }
  }

  /**
   * 检测冲突类型
   * @param filePath 文件路径
   * @returns 冲突类型
   */
  private async _detectConflictType(filePath: string): Promise<'text' | 'tree' | 'property'> {
    try {
      // 检查是否存在冲突标记文件
      const mineFile = `${filePath}.mine`;
      const theirsFile = `${filePath}.theirs`;
      const workingFile = `${filePath}.working`;
      
      const hasMine = await fsExists(mineFile);
      const hasTheirs = await fsExists(theirsFile);
      const hasWorking = await fsExists(workingFile);
      
      // 如果存在这些文件，通常是文本冲突
      if (hasMine || hasTheirs || hasWorking) {
        return 'text';
      }
      
      // 检查文件内容中是否有冲突标记
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('<<<<<<<') && content.includes('=======') && content.includes('>>>>>>>')) {
          return 'text';
        }
      } catch {
        // 文件可能不存在或无法读取
      }
      
      // 检查是否是树冲突（通过 svn info 或 status 详细信息）
      try {
        const infoResult = await this.executeSvnCommand(`info "${filePath}"`, path.dirname(filePath), false);
        if (infoResult.includes('Tree conflict') || infoResult.includes('树冲突')) {
          return 'tree';
        }
      } catch {
        // 忽略错误
      }
      
      // 默认返回文本冲突
      return 'text';
    } catch (error) {
      this.outputChannel.appendLine(`[_detectConflictType] 检测冲突类型失败: ${error}`);
      return 'text'; // 默认返回文本冲突
    }
  }

  /**
   * 获取冲突文件详情
   * @param filePath 文件路径
   * @returns 冲突详情
   */
  public async getConflictDetails(filePath: string): Promise<ConflictDetails> {
    this.outputChannel.appendLine(`\n[getConflictDetails] 获取冲突详情: ${filePath}`);
    
    try {
      const conflictType = await this._detectConflictType(filePath);
      const details: ConflictDetails = {
        filePath,
        conflictType
      };
      
      // 如果是文本冲突，尝试读取各个版本的内容
      if (conflictType === 'text') {
        try {
          const mineFile = `${filePath}.mine`;
          const theirsFile = `${filePath}.theirs`;
          const workingFile = `${filePath}.working`;
          
          if (await fsExists(mineFile)) {
            details.mineContent = fs.readFileSync(mineFile, 'utf8');
          }
          
          if (await fsExists(theirsFile)) {
            details.theirsContent = fs.readFileSync(theirsFile, 'utf8');
          }
          
          if (await fsExists(workingFile)) {
            details.workingContent = fs.readFileSync(workingFile, 'utf8');
          }
          
          // 读取当前工作文件内容
          if (await fsExists(filePath)) {
            const currentContent = fs.readFileSync(filePath, 'utf8');
            details.baseContent = currentContent;
            
            // 检测冲突标记位置
            details.conflictMarkers = this._detectConflictMarkers(currentContent);
          }
        } catch (error: any) {
          this.outputChannel.appendLine(`[getConflictDetails] 读取冲突文件内容失败: ${error.message}`);
        }
      }
      
      return details;
    } catch (error: any) {
      this.outputChannel.appendLine(`[getConflictDetails] 获取冲突详情失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 检测冲突标记位置
   * @param content 文件内容
   * @returns 冲突标记位置数组
   */
  private _detectConflictMarkers(content: string): Array<{ start: number; end: number; type: 'mine' | 'theirs' | 'both' }> {
    const markers: Array<{ start: number; end: number; type: 'mine' | 'theirs' | 'both' }> = [];
    const lines = content.split('\n');
    
    let inConflict = false;
    let conflictStart = 0;
    let mineStart = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.includes('<<<<<<<')) {
        inConflict = true;
        conflictStart = i;
        mineStart = i;
      } else if (line.includes('=======') && inConflict) {
        // 中间分隔符
      } else if (line.includes('>>>>>>>') && inConflict) {
        markers.push({
          start: conflictStart,
          end: i,
          type: 'both'
        });
        inConflict = false;
      }
    }
    
    return markers;
  }

  /**
   * 解决冲突（使用指定策略）
   * @param filePath 文件路径
   * @param strategy 解决策略：mine(使用本地), theirs(使用服务器), working(使用工作副本)
   */
  public async resolveConflict(filePath: string, strategy: 'mine' | 'theirs' | 'working'): Promise<void> {
    this.showOutputChannel('SVN冲突解决');
    this.outputChannel.appendLine(`解决文件: ${filePath}`);
    this.outputChannel.appendLine(`解决策略: ${strategy === 'mine' ? '使用本地版本' : strategy === 'theirs' ? '使用服务器版本' : '使用工作副本版本'}`);
    
    try {
      // 特殊处理：如果文件名包含@符号，需要转义
      let escapedPath = filePath;
      if (filePath.includes('@')) {
        escapedPath = `${filePath}@`;
      }
      
      // 将策略转换为SVN命令的正确参数
      // SVN的--accept参数值：mine-full(本地版本), theirs-full(服务器版本), working(工作副本)
      let acceptValue: string;
      switch (strategy) {
        case 'mine':
          acceptValue = 'mine-full';
          break;
        case 'theirs':
          acceptValue = 'theirs-full';
          break;
        case 'working':
          acceptValue = 'working';
          break;
        default:
          acceptValue = 'working';
      }
      
      this.outputChannel.appendLine(`SVN命令参数: --accept ${acceptValue}`);
      
      // 执行 svn resolve 命令
      const cwd = path.dirname(filePath);
      const fileName = path.basename(escapedPath);
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', filePath);
        } catch (error) {
          const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
          if (!relativePath.startsWith('..')) {
            let finalPath = relativePath;
            if (relativePath.includes('@')) {
              finalPath = `${relativePath}@`;
            }
            const result = await this.executeSvnCommand(`resolve --accept ${acceptValue} "${finalPath}"`, this.getCustomSvnRoot()!);
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN冲突解决完成 ==========');
            return;
          }
        }
      }
      
      const result = await this.executeSvnCommand(`resolve --accept ${acceptValue} "${fileName}"`, cwd);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN冲突解决完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN冲突解决失败 ==========');
      throw error;
    }
  }

  /**
   * 标记冲突已解决
   * @param filePath 文件路径
   */
  public async markResolved(filePath: string): Promise<void> {
    this.showOutputChannel('SVN标记冲突已解决');
    this.outputChannel.appendLine(`文件: ${filePath}`);
    
    try {
      // 使用 mine 策略标记已解决（假设用户已经手动编辑了文件）
      await this.resolveConflict(filePath, 'mine');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== 标记冲突已解决失败 ==========');
      throw error;
    }
  }

  /**
   * 批量解决冲突
   * @param filePaths 文件路径数组
   * @param strategy 解决策略
   * @param progressCallback 进度回调函数
   */
  public async resolveConflicts(
    filePaths: string[],
    strategy: 'mine' | 'theirs' | 'working',
    progressCallback?: (currentFile: string, progress: number) => void
  ): Promise<void> {
    this.showOutputChannel('SVN批量解决冲突');
    this.outputChannel.appendLine(`文件数量: ${filePaths.length}`);
    this.outputChannel.appendLine(`解决策略: ${strategy === 'mine' ? '使用本地版本' : strategy === 'theirs' ? '使用服务器版本' : '使用工作副本版本'}`);
    
    try {
      for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        this.outputChannel.appendLine(`\n正在解决第 ${i + 1}/${filePaths.length} 个文件: ${filePath}`);
        
        if (progressCallback) {
          const progress = Math.round(((i + 1) / filePaths.length) * 100);
          progressCallback(filePath, progress);
        }
        
        try {
          await this.resolveConflict(filePath, strategy);
        } catch (error: any) {
          this.outputChannel.appendLine(`解决文件失败: ${filePath}, 错误: ${error.message}`);
          // 继续处理下一个文件
        }
      }
      
      this.outputChannel.appendLine(`\n批量解决完成，共处理 ${filePaths.length} 个文件`);
      this.outputChannel.appendLine('========== SVN批量解决冲突完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN批量解决冲突失败 ==========');
      throw error;
    }
  }

  /**
   * 锁定文件（svn lock）
   * @param filePath 文件路径
   * @param message 锁定备注（可选）
   * @param force 是否强制锁定（夺取他人锁），默认 false
   */
  public async lockFile(filePath: string, message?: string, force: boolean = false): Promise<void> {
    this.showOutputChannel('SVN锁定操作');
    this.outputChannel.appendLine(`锁定文件: ${filePath}`);
    if (message) {
      this.outputChannel.appendLine(`锁定备注: ${message}`);
    }
    if (force) {
      this.outputChannel.appendLine('已启用强制锁定（--force）');
    }

    try {
      let fileName = path.basename(filePath);
      // 处理文件名包含 @ 符号的情况（SVN 对等号路径有特殊解析规则）
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }

      // 组装命令
      const messageArg = message && message.trim().length > 0
        ? ` -m "${message.replace(/"/g, '\\"')}"`
        : '';
      const forceArg = force ? ' --force' : '';
      const command = `lock "${fileName}"${messageArg}${forceArg}`;

      const result = await this.executeSvnCommand(command, path.dirname(filePath));
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN锁定操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN锁定操作失败 ==========');
      throw new Error(`锁定文件失败: ${error.message}`);
    }
  }

  /**
   * 解锁文件（svn unlock）
   * @param filePath 文件路径
   * @param force 是否强制解锁（解除他人锁），默认 false
   */
  public async unlockFile(filePath: string, force: boolean = false): Promise<void> {
    this.showOutputChannel('SVN解锁操作');
    this.outputChannel.appendLine(`解锁文件: ${filePath}`);
    if (force) {
      this.outputChannel.appendLine('已启用强制解锁（--force）');
    }

    try {
      let fileName = path.basename(filePath);
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }

      const forceArg = force ? ' --force' : '';
      const command = `unlock "${fileName}"${forceArg}`;

      const result = await this.executeSvnCommand(command, path.dirname(filePath));
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN解锁操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN解锁操作失败 ==========');
      throw new Error(`解锁文件失败: ${error.message}`);
    }
  }

  // ===================== Changelist 功能 =====================

  /**
   * 获取所有 changelist 列表
   * @param basePath 工作副本路径
   * @returns changelist 名称数组
   */
  public async getChangelists(basePath: string): Promise<string[]> {
    try {
      const result = await this.executeSvnCommand('status', basePath);
      const changelists = new Set<string>();
      const lines = result.split('\n');
      for (const line of lines) {
        const match = line.match(/^--- Changelist '(.+)'/);
        if (match) {
          changelists.add(match[1]);
        }
      }
      return Array.from(changelists);
    } catch (error: any) {
      this.outputChannel.appendLine(`[getChangelists] 获取 changelist 失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 获取指定 changelist 中的文件列表
   * @param basePath 工作副本路径
   * @param changelistName changelist 名称
   * @returns 文件路径数组（相对路径）
   */
  public async getChangelistFiles(basePath: string, changelistName: string): Promise<string[]> {
    try {
      const result = await this.executeSvnCommand(`status --changelist "${changelistName}"`, basePath);
      const files: string[] = [];
      const lines = result.split('\n');
      for (const line of lines) {
        if (line.length > 7 && !line.startsWith('---')) {
          const filePath = line.substring(7).trim();
          if (filePath) {
            files.push(filePath);
          }
        }
      }
      return files;
    } catch (error: any) {
      this.outputChannel.appendLine(`[getChangelistFiles] 获取 changelist 文件失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 将文件添加到 changelist
   * @param filePath 文件路径
   * @param changelistName changelist 名称
   */
  public async addToChangelist(filePath: string, changelistName: string): Promise<void> {
    this.showOutputChannel('SVN Changelist 操作');
    this.outputChannel.appendLine(`将文件添加到 changelist: ${changelistName}`);
    this.outputChannel.appendLine(`文件: ${filePath}`);

    try {
      let fileName = path.basename(filePath);
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }

      const command = `changelist "${changelistName.replace(/"/g, '\\"')}" "${fileName}"`;
      const result = await this.executeSvnCommand(command, path.dirname(filePath));
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN Changelist 操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN Changelist 操作失败 ==========');
      throw new Error(`添加到 changelist 失败: ${error.message}`);
    }
  }

  /**
   * 将文件从 changelist 中移除
   * @param filePath 文件路径
   */
  public async removeFromChangelist(filePath: string): Promise<void> {
    this.showOutputChannel('SVN Changelist 操作');
    this.outputChannel.appendLine(`将文件从 changelist 移除`);
    this.outputChannel.appendLine(`文件: ${filePath}`);

    try {
      let fileName = path.basename(filePath);
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }

      const command = `changelist --remove "${fileName}"`;
      const result = await this.executeSvnCommand(command, path.dirname(filePath));
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN Changelist 操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN Changelist 操作失败 ==========');
      throw new Error(`从 changelist 移除失败: ${error.message}`);
    }
  }

  /**
   * 提交指定 changelist
   * @param basePath 工作副本路径
   * @param changelistName changelist 名称
   * @param message 提交信息
   */
  public async commitChangelist(basePath: string, changelistName: string, message: string): Promise<void> {
    this.showOutputChannel('SVN Changelist 提交');
    this.outputChannel.appendLine(`提交 changelist: ${changelistName}`);
    this.outputChannel.appendLine(`工作目录: ${basePath}`);
    this.outputChannel.appendLine(`提交信息: ${message}`);

    try {
      const command = `commit --changelist "${changelistName.replace(/"/g, '\\"')}" -m "${message.replace(/"/g, '\\"')}"`;
      const result = await this.executeSvnCommand(command, basePath);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN Changelist 提交完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN Changelist 提交失败 ==========');

      if (this.isOutOfDateError(error.message)) {
        await this.handleOutOfDateError(basePath, message);
        return;
      }

      throw new Error(`提交 changelist 失败: ${error.message}`);
    }
  }

  /**
   * 获取文件的 changelist 信息
   * @param filePath 文件路径
   * @returns changelist 名称，如果没有则返回 undefined
   */
  public async getFileChangelist(filePath: string): Promise<string | undefined> {
    try {
      const cwd = path.dirname(filePath);
      let fileName = path.basename(filePath);
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }

      const result = await this.executeSvnCommand(`status "${fileName}"`, cwd);
      const lines = result.split('\n');
      for (const line of lines) {
        const match = line.match(/^--- Changelist '(.+)'/);
        if (match) {
          return match[1];
        }
      }
      return undefined;
    } catch (error: any) {
      this.outputChannel.appendLine(`[getFileChangelist] 获取文件 changelist 失败: ${error.message}`);
      return undefined;
    }
  }

  /**
   * 获取文件锁定信息
   * 通过 svn info --xml 解析远程仓库中的锁信息
   * @param filePath 文件路径
   * @returns 锁定信息对象，未锁定时 locked 为 false
   */
  public async getLockInfo(filePath: string): Promise<{
    locked: boolean;
    owner?: string;
    token?: string;
    comment?: string;
    created?: string;
    isCurrentUser?: boolean;
  }> {
    try {
      let cwd = path.dirname(filePath);
      let fileName = path.basename(filePath);
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }

      // 优先查询服务器上的锁状态（--show-item lock 在新版 svn 不一定可用，统一用 info --xml）
      // 使用 -r HEAD 让信息来自远程，否则可能只显示本地工作副本的锁
      let infoXml = '';
      try {
        infoXml = await this.executeSvnCommand(`info "${fileName}" -r HEAD --xml`, cwd, true);
      } catch (error) {
        // 远程查询失败时，回退到本地工作副本
        this.outputChannel.appendLine(`[getLockInfo] 远程查询失败，回退到本地：${(error as Error).message}`);
        infoXml = await this.executeSvnCommand(`info "${fileName}" --xml`, cwd, true);
      }

      // 解析 <lock> 节点
      const lockBlockMatch = /<lock>([\s\S]*?)<\/lock>/.exec(infoXml);
      if (!lockBlockMatch) {
        return { locked: false };
      }

      const lockBlock = lockBlockMatch[1];
      const ownerMatch = /<owner>([\s\S]*?)<\/owner>/.exec(lockBlock);
      const tokenMatch = /<token>([\s\S]*?)<\/token>/.exec(lockBlock);
      const commentMatch = /<comment>([\s\S]*?)<\/comment>/.exec(lockBlock);
      const createdMatch = /<created>([\s\S]*?)<\/created>/.exec(lockBlock);

      const owner = ownerMatch ? ownerMatch[1].trim() : undefined;

      // 尝试推断当前用户是否为锁的拥有者：从 svn auth 中获取保存的用户名
      let isCurrentUser: boolean | undefined = undefined;
      try {
        if (this.authService && owner) {
          const repoUrl = await this.authService.getRepositoryRootUrl(cwd);
          if (repoUrl) {
            const cred = await this.authService.getCredential(repoUrl);
            if (cred && cred.username) {
              isCurrentUser = cred.username === owner;
            }
          }
        }
      } catch {
        // 推断失败不影响主流程
      }

      return {
        locked: true,
        owner,
        token: tokenMatch ? tokenMatch[1].trim() : undefined,
        comment: commentMatch ? commentMatch[1].trim() : undefined,
        created: createdMatch ? createdMatch[1].trim() : undefined,
        isCurrentUser
      };
    } catch (error: any) {
      this.outputChannel.appendLine(`[getLockInfo] 获取锁定信息失败: ${error.message}`);
      throw new Error(`获取锁定信息失败: ${error.message}`);
    }
  }

  // ===================== Merge 相关方法 =====================

  /**
   * 获取仓库根 URL
   */
  public async getRepositoryRootUrlFromInfo(workingDir: string): Promise<string> {
    try {
      const result = await this.executeSvnCommand('info --xml', workingDir);
      const rootMatch = result.match(/<root>([^<]+)<\/root>/);
      if (!rootMatch) throw new Error('无法从 svn info 中解析 repository root');
      return rootMatch[1].trim();
    } catch (error: any) {
      this.outputChannel.appendLine(`[getRepositoryRootUrlFromInfo] 失败: ${error.message}`);
      throw new Error(`获取仓库根URL失败: ${error.message}`);
    }
  }

  /**
   * 获取当前工作副本的 URL（当前分支）
   */
  public async getWorkingCopyUrl(workingDir: string): Promise<string> {
    try {
      const result = await this.executeSvnCommand('info --xml', workingDir);
      const urlMatch = result.match(/<url>([^<]+)<\/url>/);
      if (!urlMatch) throw new Error('无法从 svn info 中解析工作副本 URL');
      return urlMatch[1].trim();
    } catch (error: any) {
      this.outputChannel.appendLine(`[getWorkingCopyUrl] 失败: ${error.message}`);
      throw new Error(`获取工作副本URL失败: ${error.message}`);
    }
  }

  /**
   * 列出远程 SVN 目录
   */
  public async listRemoteDir(svnUrl: string, workingDir: string): Promise<string[]> {
    try {
      const result = await this.executeSvnCommand(`ls "${svnUrl}"`, workingDir);
      return result.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.replace(/\/$/, '')); // 去掉尾部 /
    } catch (error: any) {
      this.outputChannel.appendLine(`[listRemoteDir] 列出 ${svnUrl} 失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 执行 SVN 合并
   */
  public async merge(workingDir: string, sourceUrl: string, options?: {
    revisionRange?: string;
    dryRun?: boolean;
    onProgress?: (line: string) => void;
  }): Promise<string> {
    let cmd = `merge "${sourceUrl}"`;
    if (options?.revisionRange) {
      // -c r1,r2,r3 格式（cherry-pick 多个版本）
      cmd += ` -c ${options.revisionRange}`;
    }
    if (options?.dryRun) {
      cmd += ' --dry-run';
    }
    try {
      this.outputChannel.appendLine(`[merge] 执行: svn ${cmd}`);
      this.outputChannel.appendLine(`[merge] 工作目录: ${workingDir}`);
      
      if (options?.onProgress) {
        // 流式执行，实时回调输出
        const result = await this._executeCommandWithProgress(cmd, workingDir, options.onProgress);
        this.outputChannel.appendLine(`[merge] 输出:\n${result}`);
        return result;
      } else {
        const result = await this.executeSvnCommand(cmd, workingDir);
        this.outputChannel.appendLine(`[merge] 输出:\n${result}`);
        return result;
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[merge] 失败: ${error.message}`);
      throw new Error(`合并失败: ${error.message}`);
    }
  }

  /**
   * 执行 SVN 命令并实时回调输出
   */
  private _executeCommandWithProgress(
    command: string,
    cwd: string,
    onProgress: (line: string) => void
  ): Promise<string> {
    const env = this.getEnhancedEnvironment();
    const finalCommand = `svn ${command}`.trim();

    return new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const svnProcess = cp.exec(
        finalCommand,
        { cwd, env, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' as BufferEncoding },
        (error) => {
          if (error) {
            const errMsg = stderr || error.message;
            reject(new Error(`SVN错误: ${errMsg}`));
          } else {
            resolve(stdout);
          }
        }
      );

      if (svnProcess.stdout) {
        let buffer = '';
        svnProcess.stdout.on('data', (data: string) => {
          stdout += data;
          buffer += data;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) {
              onProgress(line);
            }
          }
        });
        svnProcess.stdout.on('end', () => {
          if (buffer.trim()) {
            onProgress(buffer);
          }
        });
      }

      if (svnProcess.stderr) {
        svnProcess.stderr.on('data', (data: string) => {
          stderr += data;
          const lines = data.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              onProgress(`⚠️ ${line}`);
            }
          }
        });
      }
    });
  }

  /**
   * 获取工作副本中的冲突文件列表
   */
  public async getMergeConflicts(workingDir: string): Promise<ConflictFile[]> {
    try {
      const result = await this.executeSvnCommand('status', workingDir);
      const conflicts: ConflictFile[] = [];
      const lines = result.split('\n');
      for (const line of lines) {
        if (line.length < 8) continue;
        const textStatus = line.charAt(0);
        const propStatus = line.charAt(1);
        const treeStatus = line.charAt(6);
        if (textStatus === 'C' || propStatus === 'C' || treeStatus === 'C') {
          const filePath = line.substring(8).trim();
          if (!filePath) continue;
          let conflictType: 'text' | 'tree' | 'property' = 'text';
          if (treeStatus === 'C') conflictType = 'tree';
          else if (propStatus === 'C') conflictType = 'property';
          conflicts.push({
            path: path.resolve(workingDir, filePath),
            displayName: filePath,
            conflictType,
            status: 'C'
          });
        }
      }
      return conflicts;
    } catch (error: any) {
      this.outputChannel.appendLine(`[getMergeConflicts] 失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 标记合并冲突为已解决（与已有 resolveConflict 区分，支持更多 resolution 类型）
   */
  public async resolveMergeConflict(filePath: string, resolution: 'working' | 'theirs-full' | 'mine-full' = 'working'): Promise<void> {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    try {
      await this.executeSvnCommand(`resolve --accept=${resolution} "${fileName}"`, dir);
      this.outputChannel.appendLine(`[resolveConflict] 已解决: ${filePath} (${resolution})`);
    } catch (error: any) {
      this.outputChannel.appendLine(`[resolveConflict] 失败: ${error.message}`);
      throw new Error(`解决冲突失败: ${error.message}`);
    }
  }

  /**
   * 获取 SVN 日志（解析 XML 格式，用于合并面板版本选择器）
   */
  public async getLogEntries(svnUrl: string, workingDir: string, limit: number = 500): Promise<Array<{
    revision: number;
    author: string;
    date: string;
    message: string;
  }>> {
    try {
      const result = await this.executeSvnCommand(`log --xml -l ${limit} "${svnUrl}"`, workingDir);
      const entries: Array<{ revision: number; author: string; date: string; message: string }> = [];
      // 解析 <logentry revision="xxx"> ... </logentry>
      const entryRegex = /<logentry[^>]*revision="(\d+)"[^>]*>([\s\S]*?)<\/logentry>/g;
      let match;
      while ((match = entryRegex.exec(result)) !== null) {
        const rev = parseInt(match[1], 10);
        const body = match[2];
        const authorMatch = body.match(/<author>([^<]*)<\/author>/);
        const dateMatch = body.match(/<date>([^<]*)<\/date>/);
        const msgMatch = body.match(/<msg>([\s\S]*?)<\/msg>/);
        entries.push({
          revision: rev,
          author: authorMatch ? authorMatch[1] : '',
          date: dateMatch ? dateMatch[1] : '',
          message: msgMatch ? msgMatch[1].trim() : ''
        });
      }
      return entries;
    } catch (error: any) {
      this.outputChannel.appendLine(`[getLog] 失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 获取已合并的版本号列表
   */
  public async getMergedRevisions(workingDir: string, sourceUrl: string): Promise<Set<number>> {
    try {
      const result = await this.executeSvnCommand(
        `mergeinfo --show-revs merged "${sourceUrl}"`, workingDir
      );
      const revs = new Set<number>();
      result.split('\n').forEach(line => {
        const m = line.trim().match(/^r?(\d+)$/);
        if (m) revs.add(parseInt(m[1], 10));
      });
      return revs;
    } catch (error: any) {
      this.outputChannel.appendLine(`[getMergedRevisions] 失败: ${error.message}`);
      return new Set();
    }
  }

  /**
   * 获取可合并的版本号列表
   */
  public async getEligibleRevisions(workingDir: string, sourceUrl: string): Promise<Set<number>> {
    try {
      const result = await this.executeSvnCommand(
        `mergeinfo --show-revs eligible "${sourceUrl}"`, workingDir
      );
      const revs = new Set<number>();
      result.split('\n').forEach(line => {
        const m = line.trim().match(/^r?(\d+)$/);
        if (m) revs.add(parseInt(m[1], 10));
      });
      return revs;
    } catch (error: any) {
      this.outputChannel.appendLine(`[getEligibleRevisions] 失败: ${error.message}`);
      return new Set();
    }
  }

  // ===================== Export / Import =====================

  /**
   * SVN Export：导出干净的工作副本（不含 .svn 元数据）
   * @param sourcePath 工作副本路径或仓库 URL
   * @param targetPath 导出目标目录
   * @param revision 修订版本（可选，默认 HEAD）
   * @param force 是否强制覆盖
   */
  public async exportPath(sourcePath: string, targetPath: string, revision?: string, force: boolean = false): Promise<void> {
    this.showOutputChannel('SVN Export');
    this.outputChannel.appendLine(`Export: ${sourcePath} -> ${targetPath}`);
    try {
      const revArg = revision ? ` -r ${revision}` : '';
      const forceArg = force ? ' --force' : '';
      const command = `export${revArg} "${sourcePath}" "${targetPath}"${forceArg}`;
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        || (fs.existsSync(sourcePath) ? path.dirname(sourcePath) : os.tmpdir());
      const result = await this.executeSvnCommand(command, cwd);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN Export 完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      throw new Error(`Export 失败: ${error.message}`);
    }
  }

  /**
   * SVN Import：将本地目录导入到仓库
   * @param localPath 本地目录
   * @param repoUrl 仓库目标 URL
   * @param message 提交信息
   */
  public async importPath(localPath: string, repoUrl: string, message: string): Promise<void> {
    this.showOutputChannel('SVN Import');
    this.outputChannel.appendLine(`Import: ${localPath} -> ${repoUrl}`);
    try {
      const command = `import "${localPath}" "${repoUrl}" -m "${message.replace(/"/g, '\\"')}"`;
      const result = await this.executeSvnCommand(command, path.dirname(localPath));
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN Import 完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      throw new Error(`Import 失败: ${error.message}`);
    }
  }

  // ===================== Patch =====================

  /**
   * 创建 Patch 文件（svn diff > patch）
   * @param workingCopyPath 工作副本路径（文件或目录）
   * @param patchFilePath 输出 patch 文件路径
   */
  public async createPatch(workingCopyPath: string, patchFilePath: string): Promise<void> {
    this.showOutputChannel('SVN Create Patch');
    this.outputChannel.appendLine(`Create Patch: ${workingCopyPath} -> ${patchFilePath}`);
    try {
      const stat = fs.statSync(workingCopyPath);
      const cwd = stat.isDirectory() ? workingCopyPath : path.dirname(workingCopyPath);
      const target = stat.isDirectory() ? '.' : path.basename(workingCopyPath);
      const diffOutput = await this.executeSvnCommand(`diff "${target}"`, cwd);
      if (!diffOutput || !diffOutput.trim()) {
        throw new Error('没有检测到本地修改，无法创建 Patch');
      }
      fs.writeFileSync(patchFilePath, diffOutput, 'utf8');
      this.outputChannel.appendLine(`已写入: ${patchFilePath}`);
      this.outputChannel.appendLine('========== Patch 创建成功 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      throw error;
    }
  }

  /**
   * 应用 Patch 文件（svn patch）
   * @param workingCopyPath 工作副本目录
   * @param patchFilePath patch 文件路径
   */
  public async applyPatch(workingCopyPath: string, patchFilePath: string): Promise<void> {
    this.showOutputChannel('SVN Apply Patch');
    this.outputChannel.appendLine(`Apply Patch: ${patchFilePath} -> ${workingCopyPath}`);
    try {
      const stat = fs.statSync(workingCopyPath);
      const cwd = stat.isDirectory() ? workingCopyPath : path.dirname(workingCopyPath);
      const command = `patch "${patchFilePath}"`;
      const result = await this.executeSvnCommand(command, cwd);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== Patch 应用完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      throw new Error(`应用 Patch 失败: ${error.message}`);
    }
  }

  // ===================== Properties =====================

  /**
   * 列出所有属性
   */
  public async propList(fsPath: string): Promise<Array<{ name: string; value: string }>> {
    try {
      const stat = fs.statSync(fsPath);
      const cwd = stat.isDirectory() ? fsPath : path.dirname(fsPath);
      const target = stat.isDirectory() ? '.' : path.basename(fsPath);
      const result = await this.executeSvnCommand(`proplist -v "${target}"`, cwd);
      const props: Array<{ name: string; value: string }> = [];
      const lines = result.split('\n');
      let currentName = '';
      let currentValue: string[] = [];
      const flush = () => {
        if (currentName) {
          props.push({ name: currentName, value: currentValue.join('\n').trim() });
        }
      };
      for (const line of lines) {
        // 顶层属性行: "Properties on '...':" 跳过
        if (/^Properties on /.test(line)) continue;
        // 属性名: 行首两空格 + 名称
        const nameMatch = line.match(/^ {2}([^\s][^\n]*)$/);
        if (nameMatch) {
          flush();
          currentName = nameMatch[1].trim();
          currentValue = [];
          continue;
        }
        // 属性值: 行首四空格
        if (/^ {4}/.test(line)) {
          currentValue.push(line.replace(/^ {4}/, ''));
        }
      }
      flush();
      return props;
    } catch (error: any) {
      this.outputChannel.appendLine(`[propList] 失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 获取单个属性值
   */
  public async propGet(fsPath: string, propName: string): Promise<string> {
    const stat = fs.statSync(fsPath);
    const cwd = stat.isDirectory() ? fsPath : path.dirname(fsPath);
    const target = stat.isDirectory() ? '.' : path.basename(fsPath);
    const result = await this.executeSvnCommand(`propget "${propName}" "${target}"`, cwd);
    return result.replace(/\r?\n$/, '');
  }

  /**
   * 设置属性值（通过临时文件，支持多行）
   */
  public async propSet(fsPath: string, propName: string, value: string): Promise<void> {
    const stat = fs.statSync(fsPath);
    const cwd = stat.isDirectory() ? fsPath : path.dirname(fsPath);
    const target = stat.isDirectory() ? '.' : path.basename(fsPath);
    const tmpFile = path.join(os.tmpdir(), `svn-propset-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, value, 'utf8');
    try {
      await this.executeSvnCommand(`propset "${propName}" -F "${tmpFile}" "${target}"`, cwd);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  /**
   * 删除属性
   */
  public async propDel(fsPath: string, propName: string): Promise<void> {
    const stat = fs.statSync(fsPath);
    const cwd = stat.isDirectory() ? fsPath : path.dirname(fsPath);
    const target = stat.isDirectory() ? '.' : path.basename(fsPath);
    await this.executeSvnCommand(`propdel "${propName}" "${target}"`, cwd);
  }

  // ===================== Ignore =====================

  /**
   * 向父目录的 svn:ignore 添加忽略模式
   */
  public async addIgnore(parentDir: string, pattern: string): Promise<void> {
    this.showOutputChannel('SVN 添加忽略');
    let current = '';
    try {
      current = await this.propGet(parentDir, 'svn:ignore');
    } catch {
      // 还未设置 svn:ignore
    }
    const set = new Set(current.split('\n').map(l => l.trim()).filter(l => l));
    set.add(pattern.trim());
    const newValue = Array.from(set).join('\n');
    await this.propSet(parentDir, 'svn:ignore', newValue);
    this.outputChannel.appendLine(`已将 "${pattern}" 添加到 ${parentDir} 的 svn:ignore`);
  }

  /**
   * 从父目录的 svn:ignore 移除忽略模式
   */
  public async removeIgnore(parentDir: string, pattern: string): Promise<void> {
    this.showOutputChannel('SVN 移除忽略');
    let current = '';
    try {
      current = await this.propGet(parentDir, 'svn:ignore');
    } catch {
      return;
    }
    const lines = current.split('\n').map(l => l.trim()).filter(l => l && l !== pattern.trim());
    if (lines.length === 0) {
      await this.propDel(parentDir, 'svn:ignore');
    } else {
      await this.propSet(parentDir, 'svn:ignore', lines.join('\n'));
    }
    this.outputChannel.appendLine(`已从 ${parentDir} 的 svn:ignore 移除 "${pattern}"`);
  }

  // ===================== Copy / Move =====================

  /**
   * SVN Copy（版本化复制，本地或远程）
   * @param srcPath 源（本地路径或 URL）
   * @param dstPath 目标（本地路径或 URL）
   * @param message 远程操作时的提交信息（可选）
   */
  public async copyPath(srcPath: string, dstPath: string, message?: string): Promise<void> {
    this.showOutputChannel('SVN Copy');
    this.outputChannel.appendLine(`Copy: ${srcPath} -> ${dstPath}`);
    try {
      const msgArg = message ? ` -m "${message.replace(/"/g, '\\"')}"` : '';
      const command = `copy "${srcPath}" "${dstPath}"${msgArg}`;
      const cwd = (!/^[a-z]+:\/\//i.test(srcPath) && fs.existsSync(srcPath))
        ? path.dirname(srcPath)
        : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.tmpdir());
      const result = await this.executeSvnCommand(command, cwd);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN Copy 完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      throw new Error(`SVN Copy 失败: ${error.message}`);
    }
  }

  /**
   * SVN Move / Rename（版本化移动）
   */
  public async movePath(srcPath: string, dstPath: string, message?: string): Promise<void> {
    this.showOutputChannel('SVN Move');
    this.outputChannel.appendLine(`Move: ${srcPath} -> ${dstPath}`);
    try {
      const msgArg = message ? ` -m "${message.replace(/"/g, '\\"')}"` : '';
      const command = `move "${srcPath}" "${dstPath}"${msgArg}`;
      const cwd = (!/^[a-z]+:\/\//i.test(srcPath) && fs.existsSync(srcPath))
        ? path.dirname(srcPath)
        : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.tmpdir());
      const result = await this.executeSvnCommand(command, cwd);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN Move 完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      throw new Error(`SVN Move 失败: ${error.message}`);
    }
  }

  // ===================== Relocate =====================

  /**
   * 重定位工作副本到新 URL
   */
  public async relocate(workingCopyPath: string, newUrl: string): Promise<void> {
    this.showOutputChannel('SVN Relocate');
    this.outputChannel.appendLine(`Relocate: ${workingCopyPath} -> ${newUrl}`);
    try {
      const command = `relocate "${newUrl}"`;
      const result = await this.executeSvnCommand(command, workingCopyPath);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN Relocate 完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      throw new Error(`Relocate 失败: ${error.message}`);
    }
  }

  // ===================== Branch / Tag =====================

  /**
   * 获取仓库 root URL（svn info）
   */
  public async getRepoRoot(workingCopyPath: string): Promise<string> {
    const stat = fs.statSync(workingCopyPath);
    const cwd = stat.isDirectory() ? workingCopyPath : path.dirname(workingCopyPath);
    const result = await this.executeSvnCommand('info --xml', cwd);
    const match = result.match(/<root>([^<]+)<\/root>/);
    if (!match) throw new Error('无法获取仓库 Root URL');
    return match[1];
  }

  /**
   * 获取当前工作副本对应的 URL
   */
  public async getCurrentUrl(workingCopyPath: string): Promise<string> {
    const stat = fs.statSync(workingCopyPath);
    const cwd = stat.isDirectory() ? workingCopyPath : path.dirname(workingCopyPath);
    const result = await this.executeSvnCommand('info --xml', cwd);
    const match = result.match(/<url>([^<]+)<\/url>/);
    if (!match) throw new Error('无法获取当前 URL');
    return match[1];
  }

  /**
   * 创建分支或 Tag（svn copy <srcUrl> <dstUrl> -m <message>）
   */
  public async createBranchOrTag(workingCopyPath: string, srcUrl: string, dstUrl: string, message: string): Promise<void> {
    this.showOutputChannel('SVN 创建分支/Tag');
    this.outputChannel.appendLine(`Source: ${srcUrl}`);
    this.outputChannel.appendLine(`Target: ${dstUrl}`);
    try {
      const command = `copy "${srcUrl}" "${dstUrl}" -m "${message.replace(/"/g, '\\"')}"`;
      const result = await this.executeSvnCommand(command, workingCopyPath);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== 分支/Tag 创建完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      throw new Error(`创建分支/Tag 失败: ${error.message}`);
    }
  }

  // ===================== Repository Browser =====================

  /**
   * 列出仓库目录（svn list <URL>）
   * @returns 条目列表（dir 以 / 结尾）
   */
  public async listRepo(url: string): Promise<string[]> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.tmpdir();
    const result = await this.executeSvnCommand(`list "${url}"`, cwd);
    return result.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim().length > 0);
  }

  // ===================== Update to Revision =====================

  /**
   * 更新到指定版本
   * @param fsPath 文件或目录路径
   * @param revision 版本号（数字或 HEAD）
   */
  public async updateToRevision(fsPath: string, revision: string): Promise<void> {
    this.showOutputChannel('SVN Update to Revision');
    this.outputChannel.appendLine(`路径: ${fsPath}, 版本: ${revision}`);
    try {
      const stat = fs.statSync(fsPath);
      const isDir = stat.isDirectory();
      const cwd = isDir ? fsPath : path.dirname(fsPath);
      const target = isDir ? '.' : `"${path.basename(fsPath)}"`;
      const result = await this.executeSvnCommand(`update ${target} -r ${revision}`, cwd);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== Update to Revision 完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      throw new Error(`Update to Revision 失败: ${error.message}`);
    }
  }

  // ===================== Check for Modifications =====================

  /**
   * 获取工作副本中所有修改文件的状态列表
   * @param folderPath 工作副本目录
   * @returns 状态条目数组
   */
  public async getStatusList(folderPath: string): Promise<Array<{filePath: string; status: string; char: string}>> {
    try {
      const result = await this.executeSvnCommand('status', folderPath);
      const entries: Array<{filePath: string; status: string; char: string}> = [];
      const statusMap: Record<string, string> = {
        'M': '已修改', 'A': '已添加', 'D': '已删除', 'C': '冲突',
        '?': '未版本控制', '!': '丢失', 'R': '已替换', 'I': '已忽略', '~': '类型变更'
      };
      for (const line of result.split('\n')) {
        if (!line.trim() || line.startsWith('---')) continue;
        const char = line[0];
        if (char === ' ') continue;
        const filePath = line.substring(8).trim();
        if (!filePath) continue;
        entries.push({
          filePath: path.resolve(folderPath, filePath),
          status: statusMap[char] || `状态(${char})`,
          char
        });
      }
      return entries;
    } catch (error: any) {
      this.outputChannel.appendLine(`[getStatusList] 失败: ${error.message}`);
      return [];
    }
  }

  // ===================== Diff with Revision =====================

  /**
   * 与指定版本做 diff
   * @param filePath 文件或目录路径
   * @param rev1 版本1
   * @param rev2 版本2（可选，不传则与工作副本比较）
   */
  public async diffWithRevision(filePath: string, rev1: string, rev2?: string): Promise<string> {
    try {
      const stat = fs.statSync(filePath);
      const cwd = stat.isDirectory() ? filePath : path.dirname(filePath);
      const target = stat.isDirectory() ? '.' : `"${path.basename(filePath)}"`;
      const revArg = rev2 ? `-r ${rev1}:${rev2}` : `-r ${rev1}`;
      const result = await this.executeSvnCommand(`diff ${revArg} ${target}`, cwd);
      return result;
    } catch (error: any) {
      this.outputChannel.appendLine(`[diffWithRevision] 失败: ${error.message}`);
      throw new Error(`Diff with Revision 失败: ${error.message}`);
    }
  }

  // ===================== Rollback (Reverse Merge) =====================

  /**
   * 回滚指定版本（反向合并）
   * @param workingDir 工作副本目录
   * @param revision 要回滚的版本号
   */
  public async rollbackRevision(workingDir: string, revision: string): Promise<string> {
    this.showOutputChannel('SVN Rollback');
    this.outputChannel.appendLine(`工作目录: ${workingDir}, 回滚版本: r${revision}`);
    try {
      const result = await this.executeSvnCommand(`merge -c -${revision} .`, workingDir);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== Rollback 完成（反向合并已应用，请检查并提交） ==========');
      return result;
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      throw new Error(`Rollback 失败: ${error.message}`);
    }
  }

  // ===================== SVN Cat =====================

  /**
   * 查看文件指定版本的内容
   * @param filePath 文件路径
   * @param revision 版本号
   */
  public async catFile(filePath: string, revision: string): Promise<string> {
    try {
      const cwd = path.dirname(filePath);
      const fileName = path.basename(filePath);
      const escaped = fileName.includes('@') ? `${fileName}@` : fileName;
      const result = await this.executeSvnCommand(`cat -r ${revision} "${escaped}"`, cwd);
      return result;
    } catch (error: any) {
      this.outputChannel.appendLine(`[catFile] 失败: ${error.message}`);
      throw new Error(`查看版本文件失败: ${error.message}`);
    }
  }

  // ===================== Get File / Dir URL =====================

  /**
   * 获取文件/目录的 SVN URL
   * @param fsPath 文件系统路径
   */
  public async getFileUrl(fsPath: string): Promise<string> {
    try {
      const stat = fs.statSync(fsPath);
      const cwd = stat.isDirectory() ? fsPath : path.dirname(fsPath);
      const target = stat.isDirectory() ? '.' : `"${path.basename(fsPath)}"`;
      const result = await this.executeSvnCommand(`info --xml ${target}`, cwd, true);
      const match = result.match(/<url>([^<]+)<\/url>/);
      if (!match) throw new Error('无法获取 URL');
      return match[1].trim();
    } catch (error: any) {
      throw new Error(`获取 URL 失败: ${error.message}`);
    }
  }

  // ===================== Externals =====================

  /**
   * 获取目录的 svn:externals 属性
   */
  public async getExternals(dirPath: string): Promise<string> {
    try {
      const result = await this.executeSvnCommand(`propget svn:externals .`, dirPath);
      return result.trim();
    } catch {
      return '';
    }
  }

  /**
   * 设置目录的 svn:externals 属性
   */
  public async setExternals(dirPath: string, value: string): Promise<void> {
    const tmpFile = path.join(os.tmpdir(), `svn-ext-${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmpFile, value, 'utf8');
      await this.executeSvnCommand(`propset svn:externals -F "${tmpFile}" .`, dirPath);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  // ===================== Sparse Checkout =====================

  /**
   * 稀疏检出（按深度）
   * @param svnUrl 仓库 URL
   * @param targetDirectory 目标目录
   * @param depth 检出深度: empty | files | immediates | infinity
   */
  public async sparseCheckout(
    svnUrl: string,
    targetDirectory: string,
    depth: string,
    username?: string,
    password?: string
  ): Promise<{ success: boolean; message: string }> {
    this.showOutputChannel('SVN Sparse Checkout');
    this.outputChannel.appendLine(`URL: ${svnUrl}`);
    this.outputChannel.appendLine(`目标目录: ${targetDirectory}`);
    this.outputChannel.appendLine(`深度: ${depth}`);
    try {
      if (!await fsExists(targetDirectory)) {
        await fs.promises.mkdir(targetDirectory, { recursive: true });
      }
      const env = this.getEnhancedEnvironment();
      const args = ['checkout', `--depth=${depth}`, svnUrl, targetDirectory];
      if (username && password) {
        args.push('--username', username, '--password', password);
      }
      args.push('--non-interactive', '--trust-server-cert');
      return await new Promise<{ success: boolean; message: string }>((resolve) => {
        const proc = cp.spawn('svn', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d) => { stdout += d.toString(); });
        proc.stderr?.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) {
            this.outputChannel.appendLine(stdout);
            this.outputChannel.appendLine('========== Sparse Checkout 完成 ==========');
            resolve({ success: true, message: stdout || 'Sparse Checkout 完成' });
          } else {
            this.outputChannel.appendLine(`错误: ${stderr}`);
            resolve({ success: false, message: stderr || 'Sparse Checkout 失败' });
          }
        });
        proc.on('error', (e) => resolve({ success: false, message: e.message }));
      });
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }
}
