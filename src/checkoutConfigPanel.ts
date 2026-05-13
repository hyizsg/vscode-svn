import * as vscode from 'vscode';
import * as path from 'path';
import { SvnService } from './svnService';
import { SvnCheckoutPanel } from './checkoutPanel';

/**
 * SVN检出配置面板类
 */
export class SvnCheckoutConfigPanel {
  /**
   * 面板视图类型标识
   */
  public static readonly viewType = 'svnCheckoutConfig';

  private static currentPanel: SvnCheckoutConfigPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  
  // 检出参数
  private readonly _targetDirectory: string;
  private readonly _svnService: SvnService;

  /**
   * 创建或显示检出配置面板
   * @param extensionUri 扩展URI
   * @param targetDirectory 目标目录
   * @param svnService SVN服务实例
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    targetDirectory: string,
    svnService: SvnService
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // 如果已有面板存在，则显示它
    if (SvnCheckoutConfigPanel.currentPanel) {
      SvnCheckoutConfigPanel.currentPanel._panel.reveal(undefined, true);
      return;
    }

    // 否则，创建新面板
    const panel = vscode.window.createWebviewPanel(
      SvnCheckoutConfigPanel.viewType,
      'SVN检出配置',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'out'),
          vscode.Uri.joinPath(extensionUri, 'src')
        ]
      }
    );

    // 将 webview 面板移到独立的悬浮窗口
    setTimeout(() => {
      vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => { /* 老版本不支持，静默忽略 */ });
    }, 100);

    SvnCheckoutConfigPanel.currentPanel = new SvnCheckoutConfigPanel(
      panel, 
      extensionUri, 
      targetDirectory, 
      svnService
    );
  }

  /**
   * 构造函数
   */
  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    targetDirectory: string,
    svnService: SvnService
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._targetDirectory = targetDirectory;
    this._svnService = svnService;

    // 设置webview的初始HTML内容
    this._update();

    // 监听面板关闭事件
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // 处理来自webview的消息
    this._panel.webview.onDidReceiveMessage(
      message => {
        switch (message.command) {
          case 'testConnection':
            this._testConnection(message.svnUrl, message.username, message.password);
            return;
          case 'startCheckout':
            this._startCheckout(message.svnUrl, message.username, message.password, message.targetDirectory);
            return;
          case 'selectDirectory':
            this._selectDirectory();
            return;
          case 'close':
            this.dispose();
            return;
          case 'error':
            console.error('WebView JavaScript错误:', message.message);
            return;
        }
      },
      null,
      this._disposables
    );
  }

  /**
   * 测试SVN连接
   */
  private async _testConnection(svnUrl: string, username?: string, password?: string) {
    // 发送测试开始消息
    this._panel.webview.postMessage({
      command: 'testResult',
      status: 'testing',
      message: '正在测试连接...'
    });

    try {
      const result = await this._svnService.testConnection(svnUrl, username, password);
      
      this._panel.webview.postMessage({
        command: 'testResult',
        status: result.success ? 'success' : 'error',
        message: result.message
      });
    } catch (error: any) {
      this._panel.webview.postMessage({
        command: 'testResult',
        status: 'error',
        message: error.message
      });
    }
  }

  /**
   * 开始检出操作
   */
  private async _startCheckout(svnUrl: string, username?: string, password?: string, targetDirectory?: string) {
    const finalTargetDirectory = targetDirectory || this._targetDirectory;
    
    // 关闭配置面板
    this.dispose();
    
    // 打开检出进度面板
    await SvnCheckoutPanel.createOrShow(
      this._extensionUri,
      svnUrl,
      finalTargetDirectory,
      this._svnService,
      { username, password }
    );
  }

  /**
   * 选择目录
   */
  private async _selectDirectory() {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择检出目录',
      title: '选择SVN检出的目标目录'
    });
    
    if (folders && folders.length > 0) {
      this._panel.webview.postMessage({
        command: 'directorySelected',
        directory: folders[0].fsPath
      });
    }
  }

  /**
   * 释放资源
   */
  public dispose() {
    SvnCheckoutConfigPanel.currentPanel = undefined;

    // 清理资源
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  /**
   * 更新webview内容
   */
  private _update() {
    const webview = this._panel.webview;
    this._panel.webview.html = this._getHtmlForWebview(webview);
  }

  /**
   * 获取webview的HTML内容
   */
  private _getHtmlForWebview(webview: vscode.Webview) {
    // 安全地转义目标目录路径
    const escapedTargetDirectory = this._targetDirectory.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
    <title>SVN检出配置</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            margin: 0;
            line-height: 1.6;
        }
        
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        
        .header {
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 15px;
            margin-bottom: 30px;
            text-align: center;
        }
        
        .header h1 {
            margin: 0;
            color: var(--vscode-foreground);
            font-size: 24px;
            font-weight: 600;
        }
        
        .header p {
            margin: 10px 0 0;
            color: var(--vscode-descriptionForeground);
            font-size: 14px;
        }
        
        .form-section {
            margin-bottom: 25px;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        
        .required {
            color: var(--vscode-errorForeground);
        }
        
        .form-input {
            width: 100%;
            padding: 8px 12px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 14px;
            box-sizing: border-box;
        }
        
        .form-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }
        
        .form-input.error {
            border-color: var(--vscode-inputValidation-errorBorder);
            background-color: var(--vscode-inputValidation-errorBackground);
        }
        
        .form-help {
            margin-top: 5px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        
        .checkbox-group {
            display: flex;
            align-items: center;
            margin-bottom: 15px;
        }
        
        .checkbox-input {
            margin-right: 10px;
        }
        
        .checkbox-label {
            font-size: 14px;
            color: var(--vscode-foreground);
            cursor: pointer;
        }
        
        .auth-section {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 15px;
            margin-top: 15px;
        }
        
        .auth-section.hidden {
            display: none;
        }
        
        .directory-group {
            display: flex;
            gap: 10px;
            align-items: flex-end;
        }
        
        .directory-input {
            flex: 1;
        }
        
        .button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-family: var(--vscode-font-family);
            white-space: nowrap;
        }
        
        .button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        
        .button-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .button-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        
        .button-small {
            padding: 6px 12px;
            font-size: 12px;
        }
        
        .test-result {
            margin-top: 10px;
            padding: 10px;
            border-radius: 4px;
            font-size: 13px;
        }
        
        .test-result.hidden {
            display: none;
        }
        
        .test-result.testing {
            background-color: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            color: var(--vscode-inputValidation-warningForeground);
        }
        
        .test-result.success {
            background-color: var(--vscode-terminal-ansiGreen);
            color: white;
        }
        
        .test-result.error {
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            color: var(--vscode-inputValidation-errorForeground);
        }
        
        .actions {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
            text-align: center;
        }
        
        .actions .button {
            margin: 0 10px;
            padding: 10px 20px;
            font-size: 14px;
        }
        
        .form-section-title {
            font-size: 16px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 5px;
        }
        
        .loading-spinner {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid var(--vscode-button-foreground);
            border-radius: 50%;
            border-top-color: transparent;
            animation: spin 1s ease-in-out infinite;
            margin-right: 8px;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .protocol-examples {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 10px;
            margin-top: 8px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        
        .protocol-examples .example {
            margin-bottom: 4px;
            color: var(--vscode-textLink-foreground);
        }
        
        .protocol-examples .example:last-child {
            margin-bottom: 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔄 SVN检出配置</h1>
            <p>配置SVN仓库信息和认证凭据，然后开始检出项目</p>
        </div>
        
        <form id="checkoutForm">
            <!-- SVN仓库配置 -->
            <div class="form-section">
                <div class="form-section-title">📡 SVN仓库配置</div>
                
                <div class="form-group">
                    <label class="form-label" for="svnUrl">
                        SVN仓库地址 <span class="required">*</span>
                    </label>
                    <input type="url" id="svnUrl" class="form-input" 
                           placeholder="https://svn.example.com/repo/trunk" 
                           required>
                    <div class="form-help">
                        输入完整的SVN仓库地址，支持多种协议
                    </div>
                    <div class="protocol-examples">
                        <div class="example">HTTPS: https://svn.example.com/repo/trunk</div>
                        <div class="example">HTTP: http://svn.example.com/repo/trunk</div>
                        <div class="example">SVN: svn://svn.example.com/repo/trunk</div>
                        <div class="example">本地: file:///path/to/local/repo</div>
                    </div>
                </div>
                
                <div class="form-group">
                    <button type="button" id="testButton" class="button button-secondary button-small">
                        🔍 测试连接
                    </button>
                    <div id="testResult" class="test-result hidden"></div>
                </div>
            </div>
            
            <!-- 认证配置 -->
            <div class="form-section">
                <div class="form-section-title">🔐 认证配置</div>
                
                <div class="checkbox-group">
                    <input type="checkbox" id="useCustomAuth" class="checkbox-input" checked>
                    <label class="checkbox-label" for="useCustomAuth">
                        使用自定义用户名和密码
                    </label>
                </div>
                
                <div id="authSection" class="auth-section">
                    <div class="form-group">
                        <label class="form-label" for="username">用户名</label>
                        <input type="text" id="username" class="form-input" 
                               placeholder="请输入SVN用户名">
                    </div>
                    
                    <div class="form-group">
                        <label class="form-label" for="password">密码</label>
                        <input type="password" id="password" class="form-input" 
                               placeholder="请输入SVN密码">
                    </div>
                    
                    <div class="checkbox-group">
                        <input type="checkbox" id="showPassword" class="checkbox-input">
                        <label class="checkbox-label" for="showPassword">
                            显示密码
                        </label>
                    </div>
                </div>
            </div>
            
            <!-- 目标目录配置 -->
            <div class="form-section">
                <div class="form-section-title">📁 目标目录</div>
                
                <div class="form-group">
                    <label class="form-label" for="targetDirectory">
                        检出目录 <span class="required">*</span>
                    </label>
                    <div class="directory-group">
                        <input type="text" id="targetDirectory" class="form-input directory-input" 
                               value="${escapedTargetDirectory}" required readonly>
                        <button type="button" id="selectDirButton" class="button button-secondary">
                            📂 选择
                        </button>
                    </div>
                    <div class="form-help">
                        SVN项目将被检出到此目录
                    </div>
                </div>
            </div>
        </form>
        
        <!-- 操作按钮 -->
        <div class="actions">
            <button type="button" id="startCheckoutButton" class="button">
                ⬇️ 开始检出
            </button>
            <button type="button" id="cancelButton" class="button button-secondary">
                ❌ 取消
            </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        // 错误处理
        window.addEventListener('error', function(e) {
            console.error('JavaScript错误:', e.error);
            vscode.postMessage({
                command: 'error',
                message: e.error.toString()
            });
        });
        
        // 等待DOM加载完成
        document.addEventListener('DOMContentLoaded', function() {
            initializePanel();
        });
        
        function initializePanel() {
            // DOM元素
            const svnUrlInput = document.getElementById('svnUrl');
            const useCustomAuthCheckbox = document.getElementById('useCustomAuth');
            const authSection = document.getElementById('authSection');
            const usernameInput = document.getElementById('username');
            const passwordInput = document.getElementById('password');
            const showPasswordCheckbox = document.getElementById('showPassword');
            const targetDirectoryInput = document.getElementById('targetDirectory');
            const testButton = document.getElementById('testButton');
            const testResult = document.getElementById('testResult');
            const startCheckoutButton = document.getElementById('startCheckoutButton');
            const cancelButton = document.getElementById('cancelButton');
            const selectDirButton = document.getElementById('selectDirButton');
            
            // 检查元素是否存在
            if (!svnUrlInput || !testButton || !startCheckoutButton) {
                console.error('关键DOM元素未找到');
                return;
            }
            
            // 事件监听
            useCustomAuthCheckbox.addEventListener('change', function() {
                try {
                    if (this.checked) {
                        authSection.classList.remove('hidden');
                    } else {
                        authSection.classList.add('hidden');
                        usernameInput.value = '';
                        passwordInput.value = '';
                    }
                } catch (e) {
                    console.error('认证区域切换错误:', e);
                }
            });
            
            showPasswordCheckbox.addEventListener('change', function() {
                try {
                    passwordInput.type = this.checked ? 'text' : 'password';
                } catch (e) {
                    console.error('密码显示切换错误:', e);
                }
            });
            
            testButton.addEventListener('click', function() {
                try {
                    testConnection();
                } catch (e) {
                    console.error('测试连接错误:', e);
                }
            });
            
            startCheckoutButton.addEventListener('click', function() {
                try {
                    startCheckout();
                } catch (e) {
                    console.error('开始检出错误:', e);
                }
            });
            
            cancelButton.addEventListener('click', function() {
                try {
                    vscode.postMessage({ command: 'close' });
                } catch (e) {
                    console.error('取消按钮错误:', e);
                }
            });
            
            selectDirButton.addEventListener('click', function() {
                try {
                    vscode.postMessage({ command: 'selectDirectory' });
                } catch (e) {
                    console.error('选择目录错误:', e);
                }
            });
            
            // URL输入验证
            svnUrlInput.addEventListener('input', function() {
                try {
                    const url = this.value.trim();
                    if (url && !isValidSvnUrl(url)) {
                        this.classList.add('error');
                    } else {
                        this.classList.remove('error');
                    }
                    updateTestButtonState();
                } catch (e) {
                    console.error('URL验证错误:', e);
                }
            });
            
            function isValidSvnUrl(url) {
                var regex = new RegExp('^(https?|svn|file):\\/\\/.+');
                return regex.test(url);
            }
            
            function updateTestButtonState() {
                try {
                    const url = svnUrlInput.value.trim();
                    testButton.disabled = !url || !isValidSvnUrl(url);
                } catch (e) {
                    console.error('更新测试按钮状态错误:', e);
                }
            }
            
            function testConnection() {
                try {
                    console.log('测试连接函数被调用');
                    const svnUrl = svnUrlInput.value.trim();
                    if (!svnUrl || !isValidSvnUrl(svnUrl)) {
                        showTestResult('error', '请输入有效的SVN地址');
                        return;
                    }
                    
                    const useCustomAuth = useCustomAuthCheckbox.checked;
                    const username = useCustomAuth ? usernameInput.value.trim() : undefined;
                    const password = useCustomAuth ? passwordInput.value : undefined;
                    
                    // 如果选择了自定义认证但用户名为空，给出提示
                    if (useCustomAuth && !username) {
                        showTestResult('error', '请输入用户名');
                        return;
                    }
                    
                    testButton.disabled = true;
                    testButton.innerHTML = '<span class="loading-spinner"></span>测试中...';
                    
                    vscode.postMessage({
                        command: 'testConnection',
                        svnUrl: svnUrl,
                        username: username,
                        password: password
                    });
                } catch (e) {
                    console.error('测试连接函数错误:', e);
                    showTestResult('error', '测试连接时发生错误: ' + e.message);
                }
            }
            
            function startCheckout() {
                try {
                    console.log('开始检出函数被调用');
                    const svnUrl = svnUrlInput.value.trim();
                    const targetDirectory = targetDirectoryInput.value.trim();
                    
                    if (!svnUrl || !isValidSvnUrl(svnUrl)) {
                        alert('请输入有效的SVN地址');
                        return;
                    }
                    
                    if (!targetDirectory) {
                        alert('请选择目标目录');
                        return;
                    }
                    
                    const useCustomAuth = useCustomAuthCheckbox.checked;
                    const username = useCustomAuth ? usernameInput.value.trim() : undefined;
                    const password = useCustomAuth ? passwordInput.value : undefined;
                    
                    if (useCustomAuth && !username) {
                        alert('请输入用户名');
                        return;
                    }
                    
                    vscode.postMessage({
                        command: 'startCheckout',
                        svnUrl: svnUrl,
                        username: username,
                        password: password,
                        targetDirectory: targetDirectory
                    });
                } catch (e) {
                    console.error('开始检出函数错误:', e);
                    alert('开始检出时发生错误: ' + e.message);
                }
            }
            
            function showTestResult(status, message) {
                try {
                    testResult.className = 'test-result ' + status;
                    testResult.textContent = message;
                    testResult.classList.remove('hidden');
                } catch (e) {
                    console.error('显示测试结果错误:', e);
                }
            }
            
            // 监听来自扩展的消息
            window.addEventListener('message', function(event) {
                try {
                    const message = event.data;
                    
                    switch (message.command) {
                        case 'testResult':
                            testButton.disabled = false;
                            testButton.innerHTML = '🔍 测试连接';
                            showTestResult(message.status, message.message);
                            break;
                        case 'directorySelected':
                            targetDirectoryInput.value = message.directory;
                            break;
                    }
                } catch (e) {
                    console.error('消息处理错误:', e);
                }
            });
            
            // 初始化
            updateTestButtonState();
            
            // 初始化认证区域状态
            if (useCustomAuthCheckbox.checked) {
                authSection.classList.remove('hidden');
            }
            
            console.log('面板初始化完成');
        }
        
        // 如果DOM已经加载完成，直接初始化
        if (document.readyState === 'loading') {
            // DOM还在加载中，等待DOMContentLoaded事件
        } else {
            // DOM已经加载完成，直接初始化
            initializePanel();
        }
    </script>
</body>
</html>`;
  }
}
