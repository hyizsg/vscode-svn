#!/bin/bash

# VSCode SVN 插件打包并安装脚本
# 自动检测 vsce / cursor 命令，必要时通过 npx 调用 vsce

# 先删除现有的 *.vsix 文件
echo "正在清理旧的vsix文件..."
if ls *.vsix 1> /dev/null 2>&1; then
    rm *.vsix
    echo "旧的vsix文件已删除"
else
    echo "没有找到vsix文件，无需清理"
fi

# 任意命令失败立即退出
set -e

# 解析可用的 vsce 调用方式
# 1) 全局 vsce  2) npx @vscode/vsce  3) npx vsce（兼容旧名）
resolve_vsce_cmd() {
    if command -v vsce >/dev/null 2>&1; then
        echo "vsce"
        return 0
    fi
    if command -v npx >/dev/null 2>&1; then
        # 优先使用官方包名 @vscode/vsce
        echo "npx --yes @vscode/vsce"
        return 0
    fi
    return 1
}

VSCE_CMD="$(resolve_vsce_cmd)" || {
    echo "❌ 未检测到 vsce 命令，且未找到 npx。"
    echo "请先安装 Node.js（含 npm/npx），然后任选其一："
    echo "  1. 全局安装：npm install -g @vscode/vsce"
    echo "  2. 使用 npx：npx --yes @vscode/vsce package"
    exit 1
}

echo "使用打包命令：$VSCE_CMD"

# Step 1: 打包扩展为 VSIX 文件
echo "Packaging the VSCode extension..."
$VSCE_CMD package

# Step 2: 安装到 Cursor / VSCode
# 优先使用 cursor，回退到 code
INSTALL_CMD=""
if command -v cursor >/dev/null 2>&1; then
    INSTALL_CMD="cursor"
elif command -v code >/dev/null 2>&1; then
    INSTALL_CMD="code"
fi

if [ -n "$INSTALL_CMD" ]; then
    echo "Installing the extension into $INSTALL_CMD..."
    $INSTALL_CMD --install-extension *.vsix --force
    echo "Extension installed successfully!"
else
    echo "⚠️  未检测到 cursor 或 code 命令，已生成 vsix 文件，请手动安装。"
fi
