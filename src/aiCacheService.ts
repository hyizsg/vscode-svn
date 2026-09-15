import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getOutputChannel } from './outputChannel';

/**
 * AI分析缓存条目接口
 */
interface AICacheEntry {
    id: string;
    revision: string;
    filesHash: string;
    analysisResult: string;
    timestamp: number;
    aiModel: string;
}

/**
 * AI缓存服务类（单例模式）
 * 用于管理AI分析结果的本地缓存，减少API调用费用
 */
export class AiCacheService {
    private static readonly CACHE_DIR = path.join(os.homedir(), '.vscode-svn-ai-cache');
    private static readonly CACHE_FILE = path.join(AiCacheService.CACHE_DIR, 'ai-analysis-cache.json');
    private static readonly MAX_CACHE_SIZE = 1000; // 最大缓存条目数
    private static readonly CACHE_EXPIRY_DAYS = 30; // 缓存过期天数
    
    private static instance: AiCacheService | null = null;
    private cache: Map<string, AICacheEntry> = new Map();
    private outputChannel: vscode.OutputChannel;

    private constructor() {
        this.outputChannel = getOutputChannel();
        this._ensureCacheDir();
        this._loadCache();
    }

    /**
     * 获取单例实例
     */
    public static getInstance(): AiCacheService {
        if (!AiCacheService.instance) {
            AiCacheService.instance = new AiCacheService();
        }
        return AiCacheService.instance;
    }

    /**
     * 销毁单例实例
     */
    public static destroyInstance(): void {
        if (AiCacheService.instance) {
            AiCacheService.instance._saveCache();
            AiCacheService.instance = null;
        }
    }

    /**
     * 确保缓存目录存在
     */
    private _ensureCacheDir() {
        try {
            if (!fs.existsSync(AiCacheService.CACHE_DIR)) {
                fs.mkdirSync(AiCacheService.CACHE_DIR, { recursive: true });
                this.outputChannel.appendLine(`创建缓存目录: ${AiCacheService.CACHE_DIR}`);
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`创建缓存目录失败: ${error.message}`);
        }
    }

    /**
     * 从文件加载缓存
     */
    private _loadCache() {
        try {
            if (fs.existsSync(AiCacheService.CACHE_FILE)) {
                const cacheData = fs.readFileSync(AiCacheService.CACHE_FILE, 'utf8');
                const cacheArray: AICacheEntry[] = JSON.parse(cacheData);
                
                // 过滤过期的缓存条目
                const now = Date.now();
                const validEntries = cacheArray.filter(entry => {
                    const daysDiff = (now - entry.timestamp) / (1000 * 60 * 60 * 24);
                    return daysDiff <= AiCacheService.CACHE_EXPIRY_DAYS;
                });
                
                // 重建缓存Map
                this.cache.clear();
                validEntries.forEach(entry => {
                    this.cache.set(entry.id, entry);
                });
                
                this.outputChannel.appendLine(`加载缓存: ${validEntries.length} 条有效记录，过滤掉 ${cacheArray.length - validEntries.length} 条过期记录`);
                
                // 如果有过期记录被过滤，保存更新后的缓存
                if (cacheArray.length !== validEntries.length) {
                    this._saveCache();
                }
            } else {
                this.outputChannel.appendLine('缓存文件不存在，初始化空缓存');
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`加载缓存失败: ${error.message}`);
            this.cache.clear();
        }
    }

    /**
     * 保存缓存到文件
     */
    private _saveCache() {
        try {
            const cacheArray = Array.from(this.cache.values());
            
            // 如果缓存条目过多，删除最旧的条目
            if (cacheArray.length > AiCacheService.MAX_CACHE_SIZE) {
                cacheArray.sort((a, b) => b.timestamp - a.timestamp); // 按时间戳降序排序
                const keepEntries = cacheArray.slice(0, AiCacheService.MAX_CACHE_SIZE);
                
                this.cache.clear();
                keepEntries.forEach(entry => {
                    this.cache.set(entry.id, entry);
                });
                
                this.outputChannel.appendLine(`缓存条目过多，保留最新的 ${AiCacheService.MAX_CACHE_SIZE} 条记录`);
            }
            
            const cacheData = JSON.stringify(Array.from(this.cache.values()), null, 2);
            fs.writeFileSync(AiCacheService.CACHE_FILE, cacheData, 'utf8');
            
            this.outputChannel.appendLine(`保存缓存: ${this.cache.size} 条记录`);
        } catch (error: any) {
            this.outputChannel.appendLine(`保存缓存失败: ${error.message}`);
        }
    }

    /**
     * 生成缓存ID
     * 基于修订版本、文件差异内容生成唯一标识
     */
    public generateCacheId(revision: string, filesDiffs: string[]): string {
        try {
            // 将所有文件差异内容合并并排序，确保相同内容生成相同ID
            const sortedDiffs = filesDiffs.slice().sort();
            const combinedContent = `${revision}|${sortedDiffs.join('|||')}`;
            
            // 使用SHA-256生成哈希
            const hash = crypto.createHash('sha256').update(combinedContent, 'utf8').digest('hex');
            
            this.outputChannel.appendLine(`生成缓存ID: ${hash.substring(0, 16)}... (修订版本: ${revision}, 文件数: ${filesDiffs.length})`);
            
            return hash;
        } catch (error: any) {
            this.outputChannel.appendLine(`生成缓存ID失败: ${error.message}`);
            // 如果生成失败，返回一个基于时间戳的临时ID
            return `temp_${Date.now()}_${Math.random().toString(36).substring(2)}`;
        }
    }

    /**
     * 获取缓存的分析结果
     */
    public getCachedAnalysis(cacheId: string): string | null {
        const entry = this.cache.get(cacheId);
        if (!entry) {
            return null;
        }
        
        // 检查是否过期
        const now = Date.now();
        const ageInDays = (now - entry.timestamp) / (1000 * 60 * 60 * 24);
        
        if (ageInDays > AiCacheService.CACHE_EXPIRY_DAYS) {
            this.outputChannel.appendLine(`缓存条目已过期: ${cacheId.substring(0, 16)}...`);
            this.cache.delete(cacheId);
            this._saveCache();
            return null;
        }
        
        this.outputChannel.appendLine(`缓存命中: ${cacheId.substring(0, 16)}...`);
        return entry.analysisResult;
    }

    /**
     * 获取缓存的分析结果（包含详细信息）
     */
    public getCachedAnalysisWithDetails(cacheId: string): { result: string; timestamp: number; cacheDate: string } | null {
        const entry = this.cache.get(cacheId);
        if (!entry) {
            return null;
        }
        
        // 检查是否过期
        const now = Date.now();
        const ageInDays = (now - entry.timestamp) / (1000 * 60 * 60 * 24);
        
        if (ageInDays > AiCacheService.CACHE_EXPIRY_DAYS) {
            this.outputChannel.appendLine(`缓存条目已过期: ${cacheId.substring(0, 16)}...`);
            this.cache.delete(cacheId);
            this._saveCache();
            return null;
        }
        
        // 格式化缓存日期
        const cacheDate = new Date(entry.timestamp).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        
        this.outputChannel.appendLine(`缓存命中: ${cacheId.substring(0, 16)}...`);
        return {
            result: entry.analysisResult,
            timestamp: entry.timestamp,
            cacheDate: cacheDate
        };
    }

    /**
     * 缓存分析结果
     */
    public cacheAnalysis(cacheId: string, revision: string, filesDiffs: string[], analysisResult: string): void {
        try {
            // 生成文件差异的哈希值，用于验证缓存一致性
            const filesHash = crypto.createHash('md5').update(filesDiffs.join('|||'), 'utf8').digest('hex');
            
            const entry: AICacheEntry = {
                id: cacheId,
                revision: revision,
                filesHash: filesHash,
                analysisResult: analysisResult,
                timestamp: Date.now(),
                aiModel: 'ai' // 简化为通用标识
            };
            
            this.cache.set(cacheId, entry);
            // 立即保存缓存，确保数据持久化
            this._saveCache();
            
            this.outputChannel.appendLine(`缓存分析结果: ${cacheId.substring(0, 16)}... (修订版本: ${revision}, 结果长度: ${analysisResult.length} 字符)`);
        } catch (error: any) {
            this.outputChannel.appendLine(`缓存分析结果失败: ${error.message}`);
        }
    }

    /**
     * 清理过期缓存
     */
    public cleanExpiredCache(): number {
        try {
            const now = Date.now();
            let removedCount = 0;
            
            for (const [id, entry] of this.cache.entries()) {
                const daysDiff = (now - entry.timestamp) / (1000 * 60 * 60 * 24);
                if (daysDiff > AiCacheService.CACHE_EXPIRY_DAYS) {
                    this.cache.delete(id);
                    removedCount++;
                }
            }
            
            if (removedCount > 0) {
                this._saveCache();
                this.outputChannel.appendLine(`清理过期缓存: 删除 ${removedCount} 条记录`);
            }
            
            return removedCount;
        } catch (error: any) {
            this.outputChannel.appendLine(`清理过期缓存失败: ${error.message}`);
            return 0;
        }
    }

    /**
     * 获取缓存统计信息
     */
    public getCacheStats(): { totalEntries: number, cacheSize: string, oldestEntry: string, newestEntry: string } {
        try {
            const entries = Array.from(this.cache.values());
            const totalEntries = entries.length;
            
            if (totalEntries === 0) {
                return {
                    totalEntries: 0,
                    cacheSize: '0 KB',
                    oldestEntry: '无',
                    newestEntry: '无'
                };
            }
            
            // 计算缓存文件大小
            let cacheSize = '0 KB';
            try {
                if (fs.existsSync(AiCacheService.CACHE_FILE)) {
                    const stats = fs.statSync(AiCacheService.CACHE_FILE);
                    const sizeKB = (stats.size / 1024).toFixed(1);
                    cacheSize = `${sizeKB} KB`;
                }
            } catch (error) {
                // 忽略文件大小获取错误
            }
            
            // 找到最旧和最新的条目
            const timestamps = entries.map(e => e.timestamp);
            const oldestTimestamp = Math.min(...timestamps);
            const newestTimestamp = Math.max(...timestamps);
            
            const oldestEntry = new Date(oldestTimestamp).toLocaleString('zh-CN');
            const newestEntry = new Date(newestTimestamp).toLocaleString('zh-CN');
            
            return {
                totalEntries,
                cacheSize,
                oldestEntry,
                newestEntry
            };
        } catch (error: any) {
            this.outputChannel.appendLine(`获取缓存统计信息失败: ${error.message}`);
            return {
                totalEntries: 0,
                cacheSize: '未知',
                oldestEntry: '未知',
                newestEntry: '未知'
            };
        }
    }

    /**
     * 清空所有缓存
     */
    public clearAllCache(): void {
        try {
            this.cache.clear();
            if (fs.existsSync(AiCacheService.CACHE_FILE)) {
                fs.unlinkSync(AiCacheService.CACHE_FILE);
            }
            this.outputChannel.appendLine('已清空所有缓存');
        } catch (error: any) {
            this.outputChannel.appendLine(`清空缓存失败: ${error.message}`);
        }
    }

    /**
     * 释放资源（已废弃，使用destroyInstance代替）
     */
    public dispose(): void {
        // 不再直接释放资源，由单例管理
        this.outputChannel.appendLine('dispose方法已废弃，请使用AiCacheService.destroyInstance()');
    }
} 