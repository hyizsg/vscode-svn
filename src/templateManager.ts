import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * WebView 模板管理器
 * 负责加载和处理 HTML 模板文件
 */
export class TemplateManager {
    private readonly extensionUri: vscode.Uri;
    private readonly templatesPath: string;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
        
        // 获取插件根目录路径
        const extensionPath = extensionUri.fsPath;
        console.log('插件根目录路径:', extensionPath);
        
        // 尝试不同的模板路径
        const possiblePaths = [
            path.join(extensionPath, 'templates'),           // 直接在根目录下的templates
            path.join(extensionPath, 'out', 'templates'),    // out目录下的templates
            path.join(extensionPath, 'src', 'templates')     // src目录下的templates
        ];
        
        // 找到第一个存在的路径
        let foundPath: string | null = null;
        for (const testPath of possiblePaths) {
            console.log('检查路径:', testPath);
            if (fs.existsSync(testPath)) {
                foundPath = testPath;
                console.log('找到模板路径:', foundPath);
                break;
            }
        }
        
        if (foundPath) {
            this.templatesPath = foundPath;
            console.log('使用模板路径:', this.templatesPath);
        } else {
            // 如果都不存在，默认使用第一个路径（会在后续操作中报错）
            this.templatesPath = possiblePaths[0];
            console.warn('模板目录不存在，使用默认路径:', this.templatesPath);
            console.warn('尝试过的路径:', possiblePaths);
        }
    }

    /**
     * 加载并处理模板文件
     * @param templateName 模板名称（不含扩展名）
     * @param webview WebView 实例
     * @param variables 模板变量
     * @returns 处理后的 HTML 字符串
     */
    public async loadTemplate(
        templateName: string, 
        webview: vscode.Webview, 
        variables: Record<string, string> = {}
    ): Promise<string> {
        try {
            // 读取 HTML 模板
            const htmlPath = path.join(this.templatesPath, `${templateName}.html`);
            let htmlContent = await this.readFile(htmlPath);

            // 处理资源 URI
            const cssUri = webview.asWebviewUri(
                vscode.Uri.file(path.join(this.templatesPath, `${templateName}.css`))
            );
            const jsUri = webview.asWebviewUri(
                vscode.Uri.file(path.join(this.templatesPath, `${templateName}.js`))
            );

            // 替换资源路径
            htmlContent = htmlContent
                .replace('{{STYLE_URI}}', cssUri.toString())
                .replace('{{SCRIPT_URI}}', jsUri.toString());

            // 替换自定义变量
            for (const [key, value] of Object.entries(variables)) {
                const placeholder = `{{${key}}}`;
                htmlContent = htmlContent.replace(new RegExp(placeholder, 'g'), () => value);
            }

            return htmlContent;
        } catch (error) {
            console.error(`加载模板失败: ${templateName}`, error);
            throw new Error(`模板加载失败: ${error}`);
        }
    }

    /**
     * 加载内联模板（CSS 和 JS 内嵌在 HTML 中）
     * @param templateName 模板名称
     * @param variables 模板变量
     * @returns 处理后的 HTML 字符串
     */
    public async loadInlineTemplate(
        templateName: string,
        variables: Record<string, string> = {}
    ): Promise<string> {
        try {
            // 读取各个文件
            const htmlPath = path.join(this.templatesPath, `${templateName}.html`);
            const cssPath = path.join(this.templatesPath, `${templateName}.css`);
            const jsPath = path.join(this.templatesPath, `${templateName}.js`);

            const [htmlContent, cssContent, jsContent] = await Promise.all([
                this.readFile(htmlPath),
                this.readFile(cssPath),
                this.readFile(jsPath)
            ]);

            // 构建完整的 HTML
            let fullHtml = htmlContent
                .replace('<link rel="stylesheet" href="{{STYLE_URI}}">', `<style>${cssContent}</style>`)
                .replace('<script src="{{SCRIPT_URI}}"></script>', `<script>${jsContent}</script>`);

            // 替换自定义变量
            for (const [key, value] of Object.entries(variables)) {
                const placeholder = `{{${key}}}`;
                fullHtml = fullHtml.replace(new RegExp(placeholder, 'g'), () => value);
            }

            return fullHtml;
        } catch (error) {
            console.error(`加载内联模板失败: ${templateName}`, error);
            throw new Error(`内联模板加载失败: ${error}`);
        }
    }

    /**
     * 检查模板文件是否存在
     * @param templateName 模板名称
     * @returns 是否存在完整的模板文件集
     */
    public templateExists(templateName: string): boolean {
        const htmlPath = path.join(this.templatesPath, `${templateName}.html`);
        const cssPath = path.join(this.templatesPath, `${templateName}.css`);
        const jsPath = path.join(this.templatesPath, `${templateName}.js`);

        return fs.existsSync(htmlPath) && fs.existsSync(cssPath) && fs.existsSync(jsPath);
    }

    /**
     * 获取可用的模板列表
     * @returns 模板名称数组
     */
    public getAvailableTemplates(): string[] {
        try {
            const files = fs.readdirSync(this.templatesPath);
            const htmlFiles = files.filter(file => file.endsWith('.html'));
            
            return htmlFiles
                .map(file => path.basename(file, '.html'))
                .filter(name => this.templateExists(name));
        } catch (error) {
            console.error('获取模板列表失败:', error);
            return [];
        }
    }

    /**
     * 读取文件内容
     * @param filePath 文件路径
     * @returns 文件内容
     */
    private async readFile(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            fs.readFile(filePath, 'utf8', (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
    }

    /**
     * 创建 CSP（内容安全策略）字符串
     * @param allowInlineStyles 是否允许内联样式
     * @param allowInlineScripts 是否允许内联脚本
     * @returns CSP 字符串
     */
    public static createCSP(allowInlineStyles = true, allowInlineScripts = true): string {
        const stylesSrc = allowInlineStyles ? "'unsafe-inline'" : "'self'";
        const scriptsSrc = allowInlineScripts ? "'unsafe-inline'" : "'self'";
        
        return `default-src 'none'; style-src ${stylesSrc}; script-src ${scriptsSrc}; img-src 'self' data:;`;
    }
} 