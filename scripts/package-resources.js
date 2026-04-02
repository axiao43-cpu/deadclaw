/**
 * package-resources.js
 *
 * OneClaw Electron 应用资源打包脚本
 * 负责下载 Node.js 运行时、安装 openclaw 生产依赖、生成统一入口
 *
 * 用法: node scripts/package-resources.js [--platform darwin|win32] [--arch arm64|x64] [--locale en|cn]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const asar = require("@electron/asar");
const { execSync } = require("child_process");
const {
  normalizeSemverText,
  readRemoteLatestVersion,
} = require("./lib/openclaw-version-utils");

// ─── 项目根目录 ───
const ROOT = path.resolve(__dirname, "..");
const TARGETS_ROOT = path.join(ROOT, "resources", "targets");
const KIMI_PLUGIN_BASE_URL = "https://cdn.kimi.com/kimi-claw";
const KIMI_SEARCH_DEFAULT_TGZ_URL = `${KIMI_PLUGIN_BASE_URL}/openclaw-kimi-search-0.1.2.tgz`;
const KIMI_SEARCH_CACHE_FILE = "openclaw-kimi-search-0.1.2.tgz";
const QQBOT_PACKAGE_NAME = "@sliverp/qqbot";
const DINGTALK_CONNECTOR_PACKAGE_NAME = "@dingtalk-real-ai/dingtalk-connector";
const WECOM_PLUGIN_PACKAGE_NAME = "@wecom/wecom-openclaw-plugin";

// 计算目标产物的唯一标识
function getTargetId(platform, arch) {
  return `${platform}-${arch}`;
}

// 计算目标产物的目录集合
function getTargetPaths(platform, arch) {
  const targetId = getTargetId(platform, arch);
  const targetBase = path.join(TARGETS_ROOT, targetId);
  return {
    targetId,
    targetBase,
    runtimeDir: path.join(targetBase, "runtime"),
    gatewayDir: path.join(targetBase, "gateway"),
    iconPath: path.join(targetBase, "app-icon.png"),
    buildConfigPath: path.join(targetBase, "build-config.json"),
  };
}

// ─── 参数解析 ───
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    platform: process.platform,
    arch: process.platform === "win32" ? "x64" : "arm64",
    locale: "en",
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--platform" && args[i + 1]) {
      opts.platform = args[++i];
    } else if (args[i] === "--arch" && args[i + 1]) {
      opts.arch = args[++i];
    }
  }

  // 参数校验
  if (!["darwin", "win32"].includes(opts.platform)) {
    die(`不支持的平台: ${opts.platform}，仅支持 darwin | win32`);
  }
  if (!["arm64", "x64"].includes(opts.arch)) {
    die(`不支持的架构: ${opts.arch}，仅支持 arm64 | x64`);
  }
  return opts;
}

// ─── 工具函数 ───

function die(msg) {
  console.error(`\n[错误] ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[资源打包] ${msg}`);
}

// 确保目录存在
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// 递归删除目录（带重试机制 + 重命名技巧，彻底解决 Windows 文件锁定问题）
function rmDir(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }

  const maxRetries = 10;
  const retryDelayMs = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 尝试直接删除
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const isBusyError = err.code === "EBUSY" || err.code === "ENOTEMPTY" || err.code === "EPERM";
      const isLastAttempt = attempt === maxRetries;

      if (!isBusyError) {
        throw err;
      }

      if (isLastAttempt) {
        // 最后一次尝试：使用重命名技巧绕过文件锁定
        try {
          const tempDir = `${dir}_delete_${Date.now()}_${process.pid}`;
          fs.renameSync(dir, tempDir);
          try {
            fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 0 });
          } catch {
            // 忽略删除失败，反正已经重命名移走了
          }
          return;
        } catch {
          throw err;
        }
      }

      const message = err.code === "EBUSY"
        ? `文件被占用，等待 ${retryDelayMs}ms 后重试 (${attempt}/${maxRetries})`
        : `目录非空，等待 ${retryDelayMs}ms 后重试 (${attempt}/${maxRetries})`;

      if (attempt === 1) {
        console.log(`  [提示] ${message}`);
      }

      const start = Date.now();
      while (Date.now() - start < retryDelayMs) {
        // 忙等待（在构建脚本中可以接受）
      }
    }
  }
}

function cleanupDirBestEffort(dir, label = dir) {
  try {
    rmDir(dir);
  } catch (err) {
    log(`⚠ 跳过清理 ${label}: ${err.message || String(err)}`);
  }
}

// 带重试机制的 npm install（应对 Windows 文件锁定）
function npmInstallWithRetry(cwd, opts) {
  const maxRetries = 5;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execSync(
          `npm install --omit=dev --install-links --legacy-peer-deps --os=${opts.platform} --cpu=${opts.arch}`,
          {
            cwd,
            stdio: "inherit",
            env: {
              ...process.env,
              NODE_ENV: "production",
              npm_config_os: opts.platform,
              npm_config_cpu: opts.arch,
              NODE_LLAMA_CPP_SKIP_DOWNLOAD: "true",
              // npm 配置选项，增加容错性
              npm_config_fetch_retries: "5",
              npm_config_fetch_retry_factor: "2",
              npm_config_fetch_retry_mintimeout: "10000",
              npm_config_fetch_retry_maxtimeout: "60000",
              npm_config_registry: opts.registry || process.env.npm_config_registry || undefined,
            },
          }
      );
      return; // 成功则退出
    } catch (err) {
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        throw err; // 最后一次尝试失败，抛出错误
      }

      console.log(`  [提示] npm install 遇到文件锁定，等待 ${retryDelayMs}ms 后重试 (${attempt}/${maxRetries})`);
      console.log(`  [提示] 如果 IDE/编辑器正在打开项目目录，请先关闭以避免文件锁定`);

      // 同步延迟
      const start = Date.now();
      while (Date.now() - start < retryDelayMs) {
        // 忙等待
      }
    }
  }
}

// 安全删除单个文件（忽略不存在或权限瞬时错误）
function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // 忽略清理异常，保留原始错误上下文
  }
}

// 跨平台 tar.gz 解压（使用 Node.js 原生 zlib，避免 tar 命令兼容性问题）
function extractTarGz(archivePath, destDir) {
  ensureDir(destDir);

  // 读取并解压 gzip
  const gzipData = fs.readFileSync(archivePath);
  const tarData = zlib.gunzipSync(gzipData);

  // 解析 tar 格式并提取文件
  let offset = 0;
  const headerSize = 512;

  while (offset < tarData.length) {
    const header = tarData.slice(offset, offset + headerSize);
    offset += headerSize;

    // 检查是否到达结束标记（全零块）
    if (header.every((byte) => byte === 0)) {
      // 再检查一个全零块（tar 结尾有两个全零块）
      const nextHeader = tarData.slice(offset, offset + headerSize);
      if (nextHeader.every((byte) => byte === 0)) {
        break;
      }
    }

    // 解析文件名
    const name = header.toString("ascii", 0, 100).split("\0")[0];
    if (!name) break;

    // 解析文件大小
    const sizeStr = header.toString("ascii", 124, 136).split("\0")[0];
    const size = parseInt(sizeStr, 8);

    // 解析文件类型
    const typeFlag = header[156];

    // 跳过常规文件和目录
    if (typeFlag === 0 || typeFlag === 48) {
      // 常规文件
      const data = tarData.slice(offset, offset + size);
      const outputPath = path.join(destDir, name);

      // 确保父目录存在
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 写入文件
      fs.writeFileSync(outputPath, data);

      offset += size;
      // 跳到下一个 512 字节边界
      const padding = (512 - (size % 512)) % 512;
      offset += padding;
    } else if (typeFlag === 53) {
      // 目录
      const dirPath = path.join(destDir, name);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    } else {
      // 跳过其他类型（符号链接、设备文件等）
      if (typeFlag === 0 || typeFlag === 48) {
        offset += size;
        const padding = (512 - (size % 512)) % 512;
        offset += padding;
      }
    }
  }
}

// HTTPS GET，返回 Promise<Buffer>
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = (url) => {
      https
          .get(url, (res) => {
            // 处理重定向
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              request(res.headers.location);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode} — ${url}`));
              return;
            }
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
          })
          .on("error", reject);
    };
    request(url);
  });
}

// 带进度的文件下载
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const request = (url) => {
      https
          .get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              request(res.headers.location);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode} — ${url}`));
              return;
            }

            const totalBytes = parseInt(res.headers["content-length"], 10) || 0;
            let downloaded = 0;
            const file = fs.createWriteStream(dest);
            let settled = false;

            res.on("data", (chunk) => {
              downloaded += chunk.length;
              if (totalBytes > 0) {
                const pct = ((downloaded / totalBytes) * 100).toFixed(1);
                const mb = (downloaded / 1024 / 1024).toFixed(1);
                process.stdout.write(`\r  下载进度: ${mb} MB (${pct}%)`);
              }
            });

            const fail = (err) => {
              if (settled) return;
              settled = true;
              res.destroy();
              file.destroy();
              safeUnlink(dest);
              reject(err);
            };

            res.on("error", fail);
            file.on("error", fail);

            // 确保写入句柄真正 flush + close 后再返回，避免拿到半截压缩包
            file.on("finish", () => {
              file.close((closeErr) => {
                if (settled) return;
                settled = true;
                if (closeErr) {
                  safeUnlink(dest);
                  reject(closeErr);
                  return;
                }
                if (totalBytes > 0) process.stdout.write("\n");
                resolve();
              });
            });

            res.pipe(file);
          })
          .on("error", (err) => {
            safeUnlink(dest);
            reject(err);
          });
    };
    request(url);
  });
}

// 依次尝试多个下载源，直到成功
async function downloadFileWithFallback(urls, dest) {
  const errors = [];
  for (const url of urls) {
    try {
      await downloadFile(url, dest);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${url} -> ${message}`);
      safeUnlink(dest);
    }
  }
  throw new Error(`全部下载源失败:\n${errors.join("\n")}`);
}

// 快速校验 zip 的 EOCD 签名，提前识别损坏缓存包
function assertZipHasCentralDirectory(zipPath) {
  const stat = fs.statSync(zipPath);
  if (stat.size < 22) {
    throw new Error(`zip 文件过小: ${zipPath}`);
  }
  const readSize = Math.min(stat.size, 128 * 1024);
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(zipPath, "r");
  try {
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
  } finally {
    fs.closeSync(fd);
  }
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  if (buf.lastIndexOf(eocdSig) === -1) {
    throw new Error(`zip 缺少 End-of-central-directory 签名: ${zipPath}`);
  }
}

// ─── Step 1: 下载 Node.js 22 发行包 ───

// 获取 Node.js 22.x 最新版本号（带 24h 缓存）
async function getLatestNode22Version() {
  const cacheDir = path.join(ROOT, ".cache", "node");
  const cachePath = path.join(cacheDir, "versions.json");
  ensureDir(cacheDir);

  // 检查缓存是否有效（24小时）
  if (fs.existsSync(cachePath)) {
    const stat = fs.statSync(cachePath);
    const ageMs = Date.now() - stat.mtimeMs;
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (ageMs < ONE_DAY) {
      log("使用缓存的 Node.js 版本列表");
      const versions = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      return pickV22(versions);
    }
  }

  log("正在获取 Node.js 版本列表...");
  const buf = await httpGet("https://nodejs.org/dist/index.json");
  fs.writeFileSync(cachePath, buf);
  const versions = JSON.parse(buf.toString());
  return pickV22(versions);
}

// 从版本列表中取 v22.x 最新版
function pickV22(versions) {
  const v22 = versions.find((v) => v.version.startsWith("v22."));
  if (!v22) die("未找到 Node.js v22.x 版本");
  return v22.version.slice(1); // 去掉前缀 "v"
}

// 下载并解压 Node.js 运行时到目标目录
async function downloadAndExtractNode(version, platform, arch, runtimeDir) {
  const cacheDir = path.join(ROOT, ".cache", "node");
  ensureDir(cacheDir);

  // 增量检测：版本戳文件记录已解压的版本+架构
  const stampFile = path.join(runtimeDir, ".node-stamp");
  const stampValue = `${version}-${platform}-${arch}`;
  if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf-8").trim() === stampValue) {
    log(`runtime 已是 ${stampValue}，跳过解压`);
    return;
  }

  // 构造文件名和 URL
  const ext = platform === "darwin" ? "tar.gz" : "zip";
  const filename = `node-v${version}-${platform === "win32" ? "win" : "darwin"}-${arch}.${ext}`;
  const downloadUrls = [
    `https://nodejs.org/dist/v${version}/${filename}`,
    `https://npmmirror.com/mirrors/node/v${version}/${filename}`,
  ];
  const cachedFile = path.join(cacheDir, filename);

  // 下载（如果缓存中没有）
  if (fs.existsSync(cachedFile)) {
    log(`使用缓存: ${filename}`);
  } else {
    log(`正在下载 ${filename} ...`);
    await downloadFileWithFallback(downloadUrls, cachedFile);
    log(`下载完成: ${filename}`);
  }

  // 先尝试使用缓存包解压；若缓存损坏则删除后重下并重试一次
  try {
    extractNodeRuntimeArchive(cachedFile, runtimeDir, version, platform, arch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`检测到运行时缓存可能损坏，准备重下: ${filename}`);
    log(`解压失败原因: ${message}`);
    rmDir(runtimeDir);
    safeUnlink(cachedFile);
    log(`重新下载 ${filename} ...`);
    await downloadFileWithFallback(downloadUrls, cachedFile);
    log(`重新下载完成: ${filename}`);
    extractNodeRuntimeArchive(cachedFile, runtimeDir, version, platform, arch);
  }

  // 写入版本戳
  fs.writeFileSync(stampFile, stampValue);
}

// 清理目标目录并解压 Node.js 运行时压缩包
function extractNodeRuntimeArchive(cachedFile, runtimeDir, version, platform, arch) {
  rmDir(runtimeDir);
  ensureDir(runtimeDir);
  const targetId = getTargetId(platform, arch);
  if (platform === "darwin") {
    extractDarwin(cachedFile, runtimeDir, version, arch, targetId);
  } else {
    assertZipHasCentralDirectory(cachedFile);
    extractWin32(cachedFile, runtimeDir, version, arch, targetId);
  }
}

// 生成并发安全的临时解压目录
function createExtractTmpDir(cacheDir, targetId) {
  const tmpDir = path.join(cacheDir, `_extract_tmp_${targetId}_${process.pid}_${Date.now()}`);
  rmDir(tmpDir);
  ensureDir(tmpDir);
  return tmpDir;
}

// macOS: 从 tar.gz 中提取 node 二进制和 npm
function extractDarwin(tarPath, runtimeDir, version, arch, targetId) {
  log("正在解压 macOS Node.js 运行时...");
  const prefix = `node-v${version}-darwin-${arch}`;

  // 创建临时解压目录
  const tmpDir = createExtractTmpDir(path.dirname(tarPath), targetId);

  // 使用跨平台 Node.js 原生解压
  extractTarGz(tarPath, tmpDir);

  const srcBase = path.join(tmpDir, prefix);

  // 拷贝 bin/node
  fs.copyFileSync(path.join(srcBase, "bin", "node"), path.join(runtimeDir, "node"));

  // 生成 npm/npx 包装脚本（原始 bin/npm 是符号链接，路径解析不正确）
  fs.writeFileSync(
      path.join(runtimeDir, "npm"),
      '#!/bin/sh\ndir="$(cd "$(dirname "$0")" && pwd)"\n"$dir/node" "$dir/vendor/npm/bin/npm-cli.js" "$@"\n'
  );
  fs.writeFileSync(
      path.join(runtimeDir, "npx"),
      '#!/bin/sh\ndir="$(cd "$(dirname "$0")" && pwd)"\n"$dir/node" "$dir/vendor/npm/bin/npx-cli.js" "$@"\n'
  );


  // 拷贝 lib/node_modules/npm/ 到 vendor/npm/（避免 electron-builder 过滤 node_modules）
  const npmModSrc = path.join(srcBase, "lib", "node_modules", "npm");
  const npmModDest = path.join(runtimeDir, "vendor", "npm");
  ensureDir(path.join(runtimeDir, "vendor"));
  copyDirSync(npmModSrc, npmModDest);

  // 设置可执行权限
  fs.chmodSync(path.join(runtimeDir, "node"), 0o755);
  fs.chmodSync(path.join(runtimeDir, "npm"), 0o755);
  fs.chmodSync(path.join(runtimeDir, "npx"), 0o755);

  // 清理临时目录
  rmDir(tmpDir);
  log("macOS 运行时提取完成");
}

// Windows: 从 zip 中提取 node.exe 和 npm
function extractWin32(zipPath, runtimeDir, version, arch, targetId) {
  log("正在解压 Windows Node.js 运行时...");
  const prefix = `node-v${version}-win-${arch}`;

  // 创建临时解压目录
  const tmpDir = createExtractTmpDir(path.dirname(zipPath), targetId);

  // 判断宿主平台选择解压方式
  if (process.platform === "win32") {
    execSync(
        `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${tmpDir}'"`,
        { stdio: "inherit" }
    );
  } else {
    // 非 Windows 宿主（交叉打包场景），用 unzip
    execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`, { stdio: "inherit" });
  }

  const srcBase = path.join(tmpDir, prefix);

  // 拷贝 node.exe, npm.cmd, npx.cmd
  fs.copyFileSync(path.join(srcBase, "node.exe"), path.join(runtimeDir, "node.exe"));
  fs.copyFileSync(path.join(srcBase, "npm.cmd"), path.join(runtimeDir, "npm.cmd"));
  fs.copyFileSync(path.join(srcBase, "npx.cmd"), path.join(runtimeDir, "npx.cmd"));

  // 拷贝 node_modules/npm/ 整个目录
  const npmModSrc = path.join(srcBase, "node_modules", "npm");
  const npmModDest = path.join(runtimeDir, "node_modules", "npm");
  ensureDir(path.join(runtimeDir, "node_modules"));
  copyDirSync(npmModSrc, npmModDest);

  // 清理临时目录
  rmDir(tmpDir);
  log("Windows 运行时提取完成");
}

// 递归拷贝目录
function copyDirSync(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── Step 1.5: 写入 .npmrc ───
function writeNpmrc(runtimeDir) {
  const npmrcPath = path.join(runtimeDir, ".npmrc");
  const content = [
    "registry=https://registry.npmjs.org/",
    "disturl=https://nodejs.org/dist",
    "electron_builder_binaries_mirror=https://github.com/electron-userland/electron-builder-binaries/releases/download/",
    "",
  ].join("\n");
  fs.writeFileSync(npmrcPath, content);
  log("已写入 .npmrc（使用官方 npm 源）");
}

// ─── Step 1.8: 生成埋点配置（由打包环境动态注入） ───

function readEnvText(name) {
  return (process.env[name] || "").trim();
}

function readEnvPositiveInt(name, fallback) {
  const raw = readEnvText(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readEnvRetryDelays(name, fallback) {
  const raw = readEnvText(name);
  if (!raw) return [...fallback];
  const delays = raw
      .split(",")
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((value) => Number.isFinite(value) && value >= 0);
  return delays.length > 0 ? delays : [...fallback];
}

function buildAnalyticsConfig() {
  const captureURL = readEnvText("ONECLAW_ANALYTICS_CAPTURE_URL");
  const captureFallbackURL = readEnvText("ONECLAW_ANALYTICS_CAPTURE_FALLBACK_URL") || captureURL;
  const apiKey = readEnvText("ONECLAW_ANALYTICS_API_KEY");
  const requestTimeoutMs = readEnvPositiveInt("ONECLAW_ANALYTICS_REQUEST_TIMEOUT_MS", 8000);
  const retryDelaysMs = readEnvRetryDelays("ONECLAW_ANALYTICS_RETRY_DELAYS_MS", [0, 500, 1500]);
  const enabled = captureURL.length > 0 && apiKey.length > 0;

  if (!enabled) {
    return {
      enabled: false,
      captureURL: "",
      captureFallbackURL: "",
      apiKey: "",
      requestTimeoutMs,
      retryDelaysMs,
    };
  }

  return {
    enabled: true,
    captureURL,
    captureFallbackURL,
    apiKey,
    requestTimeoutMs,
    retryDelaysMs,
  };
}

function writeBuildConfig(configPath) {
  const config = {
    analytics: buildAnalyticsConfig(),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  log(`已生成 build-config.json（enabled=${config.analytics.enabled ? "true" : "false"}）`);
}

// ─── Step 2: 安装 openclaw 生产依赖 ───

// 确定 openclaw 安装来源：查询 npm latest stable
function getPackageSource() {
  // 显式覆盖（调试/测试用逃生舱）
  const explicitSource = readEnvText("OPENCLAW_PACKAGE_SOURCE");
  if (explicitSource) {
    log(`使用 OPENCLAW_PACKAGE_SOURCE 指定来源: ${explicitSource}`);
    return {
      source: explicitSource,
      stampSource: `explicit:${explicitSource}`,
    };
  }

  // 查询 npm registry 获取 openclaw latest 版本
  const latestVersion = readRemoteLatestVersion("openclaw", {
    cwd: ROOT,
    env: process.env,
    logError(message) {
      log(message);
    },
  });

  if (!latestVersion) {
    die("无法从 npm 获取 openclaw 最新版本（检查网络或设置 OPENCLAW_PACKAGE_SOURCE 手动指定）");
  }

  log(`使用 openclaw@${latestVersion}（来源: npm latest）`);
  return {
    source: latestVersion,
    stampSource: `remote:openclaw@${latestVersion}`,
  };
}

// 确定 QQ Bot 插件安装来源：查询 npm latest stable
function getQqbotPackageSource() {
  // 显式覆盖（调试 / 私有 tgz / 本地 file: 逃生舱）
  const explicitSource = readEnvText("ONECLAW_QQBOT_PACKAGE_SOURCE");
  if (explicitSource) {
    log(`使用 ONECLAW_QQBOT_PACKAGE_SOURCE 指定来源: ${explicitSource}`);
    return {
      source: explicitSource,
      stampSource: `explicit:${QQBOT_PACKAGE_NAME}@${explicitSource}`,
    };
  }

  const latestVersion = readRemoteLatestVersion(QQBOT_PACKAGE_NAME, {
    cwd: ROOT,
    env: process.env,
    logError(message) {
      log(message);
    },
  });

  if (!latestVersion) {
    die(`无法从 npm 获取 ${QQBOT_PACKAGE_NAME} 最新版本（检查网络或设置 ONECLAW_QQBOT_PACKAGE_SOURCE 手动指定）`);
  }

  log(`使用 ${QQBOT_PACKAGE_NAME}@${latestVersion}（来源: npm latest）`);
  return {
    source: latestVersion,
    stampSource: `remote:${QQBOT_PACKAGE_NAME}@${latestVersion}`,
  };
}

// 确定钉钉连接器安装来源：查询 npm latest stable
function getDingtalkConnectorPackageSource() {
  // 显式覆盖（调试 / 私有 tgz / 本地 file: 逃生舱）
  const explicitSource = readEnvText("ONECLAW_DINGTALK_CONNECTOR_PACKAGE_SOURCE");
  if (explicitSource) {
    log(`使用 ONECLAW_DINGTALK_CONNECTOR_PACKAGE_SOURCE 指定来源: ${explicitSource}`);
    return {
      source: explicitSource,
      stampSource: `explicit:${DINGTALK_CONNECTOR_PACKAGE_NAME}@${explicitSource}`,
    };
  }

  const latestVersion = readRemoteLatestVersion(DINGTALK_CONNECTOR_PACKAGE_NAME, {
    cwd: ROOT,
    env: process.env,
    logError(message) {
      log(message);
    },
  });

  if (!latestVersion) {
    die(`无法从 npm 获取 ${DINGTALK_CONNECTOR_PACKAGE_NAME} 最新版本（检查网络或设置 ONECLAW_DINGTALK_CONNECTOR_PACKAGE_SOURCE 手动指定）`);
  }

  log(`使用 ${DINGTALK_CONNECTOR_PACKAGE_NAME}@${latestVersion}（来源: npm latest）`);
  return {
    source: latestVersion,
    stampSource: `remote:${DINGTALK_CONNECTOR_PACKAGE_NAME}@${latestVersion}`,
  };
}

// 确定企业微信插件安装来源：查询 npm latest stable
function getWecomPluginPackageSource() {
  // 显式覆盖（调试 / 私有 tgz / 本地 file: 逃生舱）
  const explicitSource = readEnvText("ONECLAW_WECOM_PLUGIN_PACKAGE_SOURCE");
  if (explicitSource) {
    log(`使用 ONECLAW_WECOM_PLUGIN_PACKAGE_SOURCE 指定来源: ${explicitSource}`);
    return {
      source: explicitSource,
      stampSource: `explicit:${WECOM_PLUGIN_PACKAGE_NAME}@${explicitSource}`,
    };
  }

  const latestVersion = readRemoteLatestVersion(WECOM_PLUGIN_PACKAGE_NAME, {
    cwd: ROOT,
    env: process.env,
    logError(message) {
      log(message);
    },
  });

  if (!latestVersion) {
    die(`无法从 npm 获取 ${WECOM_PLUGIN_PACKAGE_NAME} 最新版本（检查网络或设置 ONECLAW_WECOM_PLUGIN_PACKAGE_SOURCE 手动指定）`);
  }

  log(`使用 ${WECOM_PLUGIN_PACKAGE_NAME}@${latestVersion}（来源: npm latest）`);
  return {
    source: latestVersion,
    stampSource: `remote:${WECOM_PLUGIN_PACKAGE_NAME}@${latestVersion}`,
  };
}

// 读取 gateway 依赖平台戳
function readGatewayStamp(stampPath) {
  try {
    return fs.readFileSync(stampPath, "utf-8").trim();
  } catch {
    return "";
  }
}

// 读取 openclaw/extensions 下插件包声明的运行时依赖，补齐被 npm 提升到根级后仍引用其子依赖的场景。
function collectBundledPluginRuntimeDependencies(gatewayDir) {
  const extensionsDir = path.join(gatewayDir, "node_modules", "openclaw", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }

  const staged = new Map();
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(extensionsDir, entry.name, "package.json");
    if (!fs.existsSync(pkgPath)) continue;

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    } catch {
      continue;
    }

    const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
    for (const [name, version] of Object.entries(deps)) {
      if (!name || typeof version !== "string" || !version.trim()) continue;
      if (!staged.has(name)) {
        staged.set(name, version.trim());
      }
    }
  }

  return Array.from(staged.entries()).map(([name, version]) => ({ name, version }));
}

function stageBundledPluginRuntimeDependencies(gatewayDir) {
  const stagedDeps = collectBundledPluginRuntimeDependencies(gatewayDir);
  if (stagedDeps.length === 0) {
    return;
  }

  const rootNodeModules = path.join(gatewayDir, "node_modules");
  const extensionsDir = path.join(gatewayDir, "node_modules", "openclaw", "extensions");
  let copiedCount = 0;

  for (const dep of stagedDeps) {
    const destDir = path.join(rootNodeModules, ...dep.name.split("/"));
    if (fs.existsSync(destDir)) {
      continue;
    }

    let sourceDir = null;
    for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidateDir = path.join(extensionsDir, entry.name, "node_modules", ...dep.name.split("/"));
      if (fs.existsSync(candidateDir)) {
        sourceDir = candidateDir;
        break;
      }
    }

    if (!sourceDir) {
      continue;
    }

    ensureDir(path.dirname(destDir));
    copyDirSync(sourceDir, destDir);
    copiedCount += 1;
  }

  if (copiedCount > 0) {
    log(`已提升 ${copiedCount} 个 bundled 插件运行时依赖到 gateway/node_modules`);
  }
}

// 读取 openclaw dist/extensions 下声明需要提升到宿主 node_modules 的运行时依赖。
function collectOpenclawStagedRuntimeDependencies(gatewayDir) {
  const extensionsDir = path.join(gatewayDir, "node_modules", "openclaw", "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }

  const staged = new Map();
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(extensionsDir, entry.name, "package.json");
    if (!fs.existsSync(pkgPath)) continue;

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    } catch {
      continue;
    }

    if (!pkg?.openclaw?.bundle?.stageRuntimeDependencies) {
      continue;
    }

    const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
    for (const [name, version] of Object.entries(deps)) {
      if (!name || typeof version !== "string" || !version.trim()) continue;
      if (!staged.has(name)) {
        staged.set(name, version.trim());
      }
    }
  }

  return Array.from(staged.entries()).map(([name, version]) => ({ name, version }));
}

// 将内置扩展声明的运行时依赖提升到 gateway 根 node_modules，确保 dist/* 共享模块可解析这些包。
function stageOpenclawRuntimeDependencies(gatewayDir) {
  const stagedDeps = collectOpenclawStagedRuntimeDependencies(gatewayDir);
  if (stagedDeps.length === 0) {
    return;
  }

  const rootNodeModules = path.join(gatewayDir, "node_modules");
  const extensionsDir = path.join(gatewayDir, "node_modules", "openclaw", "dist", "extensions");
  let copiedCount = 0;

  for (const dep of stagedDeps) {
    const destDir = path.join(rootNodeModules, ...dep.name.split("/"));
    if (fs.existsSync(destDir)) {
      continue;
    }

    let sourceDir = null;
    for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidateDir = path.join(extensionsDir, entry.name, "node_modules", ...dep.name.split("/"));
      if (fs.existsSync(candidateDir)) {
        sourceDir = candidateDir;
        break;
      }
    }

    if (!sourceDir) {
      continue;
    }

    ensureDir(path.dirname(destDir));
    copyDirSync(sourceDir, destDir);
    copiedCount += 1;
  }

  if (copiedCount > 0) {
    log(`已提升 ${copiedCount} 个扩展运行时依赖到 gateway/node_modules`);
  }
}

// 原生平台包前缀（用于跨平台污染检测与清理）
const NATIVE_NAME_PREFIX = [
  "sharp-",
  "sharp-libvips-",
  "node-pty-",
  "sqlite-vec-",
  "canvas-",
  "reflink-",
  "clipboard-",
];

// 收集 node_modules 第一层包（含 @scope 下子包）
function collectTopLevelPackages(nmDir) {
  const scopedDirs = fs.existsSync(nmDir)
      ? fs.readdirSync(nmDir, { withFileTypes: true })
      : [];

  const packages = [];
  for (const entry of scopedDirs) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(nmDir, entry.name);
    if (entry.name.startsWith("@")) {
      for (const child of fs.readdirSync(abs, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        packages.push({ name: child.name, dir: path.join(abs, child.name) });
      }
    } else {
      packages.push({ name: entry.name, dir: abs });
    }
  }
  return packages;
}

// 解析包名中的平台三元组（如 xxx-darwin-arm64）
function parseNativePackageTarget(name) {
  if (!NATIVE_NAME_PREFIX.some((prefix) => name.startsWith(prefix))) return null;
  const match = name.match(/-(darwin|linux|win32)-([a-z0-9_-]+)/i);
  if (!match) return null;
  return {
    platform: match[1],
    arch: match[2].split("-")[0],
  };
}

// Darwin 目标下移除 universal 原生包，强制仅保留 arm64/x64 二选一
function pruneDarwinUniversalNativePackages(nmDir, platform) {
  if (platform !== "darwin") return;

  const removed = [];
  for (const item of collectTopLevelPackages(nmDir)) {
    const target = parseNativePackageTarget(item.name);
    if (!target) continue;
    if (target.platform === "darwin" && target.arch === "universal") {
      rmDir(item.dir);
      removed.push(item.name);
    }
  }

  if (removed.length > 0) {
    log(`已移除 darwin-universal 原生包: ${removed.join(", ")}`);
  }
}

// 是否保留 node-llama-cpp（默认移除；设置 ONECLAW_KEEP_LLAMA=true/1 可保留）
function shouldKeepLlamaPackages() {
  const raw = readEnvText("ONECLAW_KEEP_LLAMA").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// 定点裁剪 llama 相关依赖，避免 --omit=optional 误伤其它可选功能
function pruneLlamaPackages(nmDir) {
  if (shouldKeepLlamaPackages()) {
    log("已保留 llama 依赖（ONECLAW_KEEP_LLAMA 已启用）");
    return;
  }

  const removeTargets = [
    path.join(nmDir, "node-llama-cpp"),
    path.join(nmDir, "@node-llama-cpp"),
  ];

  const removed = [];
  for (const target of removeTargets) {
    if (!fs.existsSync(target)) continue;
    rmDir(target);
    removed.push(path.basename(target));
  }

  if (removed.length > 0) {
    log(`已移除 llama 依赖: ${removed.join(", ")}`);
  } else {
    log("llama 依赖不存在，跳过移除");
  }
}

// 移除 @ffmpeg-installer 预编译二进制（35-68MB），视频缩略图功能降级但不崩溃
function pruneFFmpegBinaries(nmDir) {
  const ffmpegDir = path.join(nmDir, "@ffmpeg-installer");
  if (!fs.existsSync(ffmpegDir)) return;

  const sizeBefore = fs.readdirSync(ffmpegDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .reduce((sum, e) => {
        const dir = path.join(ffmpegDir, e.name);
        try {
          const stat = fs.statSync(dir);
          return sum + (stat.isDirectory() ? getDirSize(dir) : 0);
        } catch { return sum; }
      }, 0);

  rmDir(ffmpegDir);
  const savedMB = (sizeBefore / 1048576).toFixed(1);
  log(`已移除 @ffmpeg-installer 预编译二进制 (${savedMB} MB)`);
}

// 递归计算目录大小
function getDirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? getDirSize(full) : fs.statSync(full).size;
  }
  return total;
}

// 清理 pdf-parse 冗余的 pdf.js 版本（只保留最新版，节省约 13 MB）
function prunePdfParseRedundantVersions(nmDir) {
  const pdfJsDir = path.join(nmDir, "pdf-parse", "lib", "pdf.js");
  if (!fs.existsSync(pdfJsDir)) return;

  let entries;
  try {
    entries = fs.readdirSync(pdfJsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith("v"));
  } catch { return; }

  if (entries.length <= 1) return;

  // 按语义版本降序排列，保留最新版
  entries.sort((a, b) => {
    const va = a.name.slice(1).split(".").map(Number);
    const vb = b.name.slice(1).split(".").map(Number);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      if ((vb[i] || 0) !== (va[i] || 0)) return (vb[i] || 0) - (va[i] || 0);
    }
    return 0;
  });

  let savedBytes = 0;
  for (let i = 1; i < entries.length; i++) {
    const dir = path.join(pdfJsDir, entries[i].name);
    savedBytes += getDirSize(dir);
    rmDir(dir);
  }
  const savedMB = (savedBytes / 1048576).toFixed(1);
  log(`已移除 pdf-parse 冗余 pdf.js 版本 (保留 ${entries[0].name}，节省 ${savedMB} MB)`);
}

// 清理 node_modules/.bin 中的悬挂符号链接（避免 afterPack 拷贝时报 ENOENT）
function pruneDanglingBinLinks(nmDir) {
  const binDir = path.join(nmDir, ".bin");
  if (!fs.existsSync(binDir)) return;

  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(binDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(binDir, entry.name);
    try {
      fs.realpathSync(linkPath);
    } catch {
      try {
        fs.unlinkSync(linkPath);
        removed.push(entry.name);
      } catch {
        // 忽略清理异常，后续由打包阶段暴露更具体错误
      }
    }
  }

  if (removed.length > 0) {
    log(`已移除悬挂 .bin 链接: ${removed.join(", ")}`);
  }
}

// 校验平台相关原生包，避免把其它平台或 universal 包打进目标产物
function assertNativeDepsMatchTarget(nmDir, platform, arch) {
  const mismatches = [];
  for (const item of collectTopLevelPackages(nmDir)) {
    const target = parseNativePackageTarget(item.name);
    if (!target) continue;
    if (target.platform !== platform || target.arch !== arch) {
      mismatches.push(`${item.name} (目标 ${platform}-${arch})`);
    }
  }

  if (mismatches.length > 0) {
    die(
        [
          "检测到与目标平台不匹配的原生依赖：",
          ...mismatches.slice(0, 10).map((m) => `  - ${m}`),
          "",
          "请重新执行 package-resources，确保 npm install 按目标平台/架构运行。",
        ].join("\n")
    );
  }
}

// 安装 openclaw + clawhub 核心依赖（npm 插件由 bundleNpmPackagePlugin 独立安装）
function installDependencies(opts, gatewayDir) {
  const stampPath = path.join(gatewayDir, ".gateway-stamp");
  const sourceInfo = getPackageSource();
  const targetStamp = `${opts.platform}-${opts.arch}|${sourceInfo.stampSource}`;

  // 增量检测：stamp 匹配 + entry.js 存在 → 跳过安装
  const installedEntry = path.join(gatewayDir, "node_modules", "openclaw", "dist", "entry.js");
  const cachedStamp = readGatewayStamp(stampPath);
  if (fs.existsSync(installedEntry) && cachedStamp === targetStamp) {
    log(`gateway 依赖未变化且平台/来源匹配 (${targetStamp})，跳过 npm install`);
    const nmDir = path.join(gatewayDir, "node_modules");
    // 即使复用缓存依赖，也要执行最新裁剪规则，避免历史产物遗留冗余文件
    pruneNodeModules(nmDir);
    stageOpenclawRuntimeDependencies(gatewayDir);
    stageBundledPluginRuntimeDependencies(gatewayDir);
    pruneDarwinUniversalNativePackages(nmDir, opts.platform);
    pruneLlamaPackages(nmDir);
    pruneDanglingBinLinks(nmDir);
    assertNativeDepsMatchTarget(nmDir, opts.platform, opts.arch);
    patchWindowsOpenclawArtifacts(gatewayDir, opts.platform);
    return;
  }

  if (cachedStamp && cachedStamp !== targetStamp) {
    log(`检测到依赖来源或平台变更（${cachedStamp} → ${targetStamp}），重新安装 gateway 依赖`);
  } else if (fs.existsSync(installedEntry)) {
    log("检测到 gateway 依赖缺少来源戳，重新安装");
  }

  rmDir(gatewayDir);
  ensureDir(gatewayDir);

  const source = sourceInfo.source;
  log(`安装 openclaw 依赖 (来源: ${source}) ...`);

  // 只安装 openclaw + clawhub 核心依赖（npm 插件独立安装，避免 peerDep 传染）
  const pkg = {
    dependencies: {
      openclaw: source,
      clawhub: "latest",
    },
  };
  fs.writeFileSync(path.join(gatewayDir, "package.json"), JSON.stringify(pkg, null, 2));

  // 使用系统 npm 执行安装（带重试机制，应对 Windows 文件锁定）
  npmInstallWithRetry(gatewayDir, opts);

  log("依赖安装完成，开始裁剪 node_modules...");
  const nmDir = path.join(gatewayDir, "node_modules");
  pruneNodeModules(nmDir);
  stageOpenclawRuntimeDependencies(gatewayDir);
  stageBundledPluginRuntimeDependencies(gatewayDir);
  pruneDarwinUniversalNativePackages(nmDir, opts.platform);
  pruneLlamaPackages(nmDir);
  pruneDanglingBinLinks(nmDir);
  assertNativeDepsMatchTarget(nmDir, opts.platform, opts.arch);
  patchWindowsOpenclawArtifacts(gatewayDir, opts.platform);
  fs.writeFileSync(stampPath, targetStamp);
  log("node_modules 裁剪完成");
}

// Windows 上给 openclaw 已知的 spawn 热点统一补 windowsHide，避免黑框闪烁。
function patchWindowsOpenclawArtifacts(gatewayDir, platform = "win32") {
  if (platform !== "win32") return;

  const distDir = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  if (!fs.existsSync(distDir)) {
    die(`openclaw dist 目录不存在，无法应用 Windows 补丁: ${distDir}`);
  }

  const distEntries = fs.readdirSync(distDir);
  const execFiles = distEntries.filter((name) => /^exec-.*\.js$/.test(name));
  const gatewayCliFiles = distEntries.filter((name) => /^gateway-cli-.*\.js$/.test(name));

  const execResult = patchWindowsOpenclawFiles(distDir, execFiles, injectExecWindowsHide, hasExecWindowsHide);
  const gatewayCliResult = patchWindowsOpenclawFiles(
      distDir,
      gatewayCliFiles,
      injectGatewayCliPatches,
      hasGatewayCliPatches
  );

  if (execFiles.length === 0 || execResult.ready === 0) {
    die("未能为 openclaw exec Windows spawn 注入 windowsHide，构建已终止");
  }
  if (gatewayCliFiles.length === 0 || gatewayCliResult.ready === 0) {
    die("未能为 openclaw gateway-cli respawn 注入 windowsHide，构建已终止");
  }

  log(
      `已应用 openclaw Windows 补丁：exec=${execResult.patched}/${execResult.ready} gateway-cli=${gatewayCliResult.patched}/${gatewayCliResult.ready}`
  );
}

// 扫描并重写目标文件；若上游产物结构变化，让构建直接失败而不是静默漂移。
function patchWindowsOpenclawFiles(distDir, fileNames, transform, isReady) {
  let patched = 0;
  let ready = 0;
  for (const fileName of fileNames) {
    const filePath = path.join(distDir, fileName);
    const before = fs.readFileSync(filePath, "utf-8");
    const after = transform(before);
    if (after !== before) {
      fs.writeFileSync(filePath, after, "utf-8");
      patched += 1;
      ready += 1;
      continue;
    }
    if (isReady(before)) {
      ready += 1;
    }
  }
  return { patched, ready };
}

// exec helper 会走 cmd.exe / batch；这里漏掉 windowsHide 就会直接闪黑框。
function injectExecWindowsHide(source) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return source.replace(
      /(\] : finalArgv\.slice\(1\), \{)(\r?\n)(\s*)stdio,/,
      `$1$2$3windowsHide: true,${eol}$3stdio,`
  );
}

// 幂等校验：缓存依赖若已带 windowsHide，不应因为补丁再次运行而失败。
function hasExecWindowsHide(source) {
  return /\] : finalArgv\.slice\(1\), \{[\s\S]*?windowsHide:\s*true[\s\S]*?stdio,/.test(source);
}

// respawn 已被 OPENCLAW_NO_RESPAWN 大多压住，但这里补上更稳，避免旁路重新污染主进程树。
function injectGatewayCliPatches(source) {
  const withWindowsHide = injectGatewayRespawnWindowsHide(source);
  return disableGatewayModelPricingBootstrap(withWindowsHide);
}

function injectGatewayRespawnWindowsHide(source) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return source.replace(
      /(spawn\(process\.execPath, args, \{)(\r?\n)(\s*)env: process\.env,/,
      `$1$2$3windowsHide: true,${eol}$3env: process.env,`
  );
}

function disableGatewayModelPricingBootstrap(source) {
  return source.replace(
      /stopModelPricingRefresh = !minimalTestGateway && process\.env\.VITEST !== "1" \? startGatewayModelPricingRefresh\(\{ config: cfgAtStart \}\) : \(\) => \{\};/,
      'stopModelPricingRefresh = () => {};'
  );
}

// 幂等校验：已打过补丁的 gateway-cli 允许重复复用，不重复报错。
function hasGatewayCliPatches(source) {
  return hasGatewayRespawnWindowsHide(source) && /stopModelPricingRefresh = \(\) => \{\};/.test(source);
}

function hasGatewayRespawnWindowsHide(source) {
  return /spawn\(process\.execPath, args, \{[\s\S]*?windowsHide:\s*true[\s\S]*?env: process\.env,/.test(source);
}

// ─── Step 2.5: 注入 bundled 插件（kimi-search + qqbot + dingtalk） ───

// 插件定义（id → 下载/缓存参数）
const BUNDLED_PLUGINS = [
  {
    id: "kimi-search",
    localEnv: "ONECLAW_KIMI_SEARCH_TGZ_PATH",
    urlEnv: "ONECLAW_KIMI_SEARCH_TGZ_URL",
    refreshEnv: "ONECLAW_KIMI_SEARCH_REFRESH",
    defaultURL: KIMI_SEARCH_DEFAULT_TGZ_URL,
    cacheFile: KIMI_SEARCH_CACHE_FILE,
    requiredFiles: ["package.json", "openclaw.plugin.json"],
  },
  {
    id: "qqbot",
    packageName: QQBOT_PACKAGE_NAME,
    requiredFiles: ["package.json", "openclaw.plugin.json"],
    getSource: getQqbotPackageSource,
  },
  {
    id: "dingtalk-connector",
    packageName: DINGTALK_CONNECTOR_PACKAGE_NAME,
    requiredFiles: ["package.json", "openclaw.plugin.json"],
    getSource: getDingtalkConnectorPackageSource,
  },
  {
    id: "wecom-openclaw-plugin",
    packageName: WECOM_PLUGIN_PACKAGE_NAME,
    requiredFiles: ["package.json", "openclaw.plugin.json"],
    getSource: getWecomPluginPackageSource,
  },
];

// 解析插件包来源（优先本地 tgz，其次远程 URL）
function resolvePluginSource(plugin) {
  const localTgz = readEnvText(plugin.localEnv);
  if (localTgz) {
    const resolved = path.resolve(localTgz);
    if (!fs.existsSync(resolved)) {
      die(`${plugin.localEnv} 指向的文件不存在: ${resolved}`);
    }
    return { archivePath: resolved, sourceLabel: `local:${resolved}` };
  }

  const cacheDir = path.join(ROOT, ".cache", plugin.id);
  ensureDir(cacheDir);
  const archivePath = path.join(cacheDir, plugin.cacheFile);
  const sourceURL = readEnvText(plugin.urlEnv) || plugin.defaultURL;
  const refresh = readEnvText(plugin.refreshEnv).toLowerCase();
  const forceRefresh = refresh === "1" || refresh === "true" || refresh === "yes";

  return { archivePath, sourceURL, sourceLabel: sourceURL, forceRefresh };
}

// 下载（或复用缓存）插件 tgz
async function ensurePluginArchive(plugin) {
  const source = resolvePluginSource(plugin);
  const { archivePath } = source;

  if (!source.sourceURL) {
    log(`使用本地 ${plugin.id} 包: ${path.relative(ROOT, archivePath)}`);
    return source;
  }

  if (source.forceRefresh || !fs.existsSync(archivePath)) {
    log(`下载 ${plugin.id} 插件包: ${source.sourceURL}`);
    safeUnlink(archivePath);
    await downloadFileWithFallback([source.sourceURL], archivePath);
  } else {
    log(`使用缓存的 ${plugin.id} 包: ${path.relative(ROOT, archivePath)}`);
  }

  return source;
}

// 将 npm 安装后的包名解析到 node_modules 实际目录。
function resolveInstalledPackageDir(gatewayDir, packageName) {
  return path.join(gatewayDir, "node_modules", ...packageName.split("/"));
}

// 清理已复制完成的源包，避免 node_modules 与 extensions 重复打包。
function removeInstalledPackageSource(gatewayDir, packageName) {
  const packageDir = resolveInstalledPackageDir(gatewayDir, packageName);
  if (!fs.existsSync(packageDir)) {
    return;
  }

  rmDir(packageDir);

  const parts = packageName.split("/");
  if (parts.length === 2) {
    const scopeDir = path.join(gatewayDir, "node_modules", parts[0]);
    try {
      if (fs.existsSync(scopeDir) && fs.readdirSync(scopeDir).length === 0) {
        fs.rmdirSync(scopeDir);
      }
    } catch {
      // 忽略清理失败，避免影响主流程
    }
  }

  pruneDanglingBinLinks(path.join(gatewayDir, "node_modules"));
}

// 校验插件目录结构，确保最基本的运行入口存在。
function assertPluginDir(plugin, dirPath, missingLabel) {
  for (const f of plugin.requiredFiles) {
    if (!fs.existsSync(path.join(dirPath, f))) {
      die(`${plugin.id} 包内容无效（缺少 ${missingLabel}${f}）`);
    }
  }
}

// 在独立临时目录中安装 npm 包插件，避免传递依赖和 peerDep 污染 gateway node_modules
async function bundleNpmPackagePlugin(plugin, gatewayDir, targetId, opts) {
  const openclawDir = path.join(gatewayDir, "node_modules", "openclaw");
  if (!fs.existsSync(openclawDir)) {
    die(`openclaw 依赖目录不存在，无法注入 ${plugin.id}: ${openclawDir}`);
  }

  const extRoot = path.join(openclawDir, "extensions");
  const pluginDir = path.join(extRoot, plugin.id);
  ensureDir(extRoot);

  // 解析插件版本
  const sourceInfo = plugin.getSource();

  // 增量检测：版本戳匹配则跳过
  const stampPath = path.join(pluginDir, `.oneclaw-${plugin.id}-stamp.json`);
  if (fs.existsSync(stampPath) && fs.existsSync(pluginDir)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(stampPath, "utf-8"));
      if (stamp.source === sourceInfo.stampSource) {
        assertPluginDir(plugin, pluginDir, "");
        log(`复用已注入的 ${plugin.id} 插件 (${sourceInfo.stampSource})`);
        return;
      }
    } catch {
      // 戳文件损坏，重新安装
    }
  }

  log(`独立安装 ${plugin.id} 插件 (${sourceInfo.stampSource}) ...`);

  // 在临时目录中独立安装（隔离传递依赖，避免 peerDep 拉入巨型包）
  const tmpDir = createExtractTmpDir(TARGETS_ROOT, `${targetId}_npm_${plugin.id}`);
  const tmpPkg = { dependencies: { [plugin.packageName]: sourceInfo.source } };
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(tmpPkg, null, 2));

  try {
    npmInstallWithRetry(tmpDir, opts);
  } catch (err) {
    cleanupDirBestEffort(tmpDir, `${plugin.id} 临时安装目录`);
    die(`安装 ${plugin.id} 插件失败: ${err.message || String(err)}`);
  }

  // 定位已安装的插件包
  const installedPkgDir = resolveInstalledPackageDir(tmpDir, plugin.packageName);
  if (!fs.existsSync(installedPkgDir)) {
    cleanupDirBestEffort(tmpDir, `${plugin.id} 临时安装目录`);
    die(`安装 ${plugin.id} 后未找到包目录: ${installedPkgDir}`);
  }
  assertPluginDir(plugin, installedPkgDir, "");

  // 将插件包拷贝到 extensions
  rmDir(pluginDir);
  copyDirSync(installedPkgDir, pluginDir);

  // 将提升（hoisted）到 tmpDir/node_modules 的传递依赖收集到插件自身的 node_modules
  const tmpNm = path.join(tmpDir, "node_modules");
  const pluginNm = path.join(pluginDir, "node_modules");
  ensureDir(pluginNm);

  for (const entry of fs.readdirSync(tmpNm, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;

    if (entry.name.startsWith("@")) {
      // scoped 包：逐个子包检查
      const scopeDir = path.join(tmpNm, entry.name);
      for (const child of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const fullName = `${entry.name}/${child.name}`;
        // 跳过插件包自身
        if (fullName === plugin.packageName) continue;
        // 插件 node_modules 里已有的跳过（npm 嵌套安装的优先）
        const dest = path.join(pluginNm, entry.name, child.name);
        if (fs.existsSync(dest)) continue;
        ensureDir(path.join(pluginNm, entry.name));
        copyDirSync(path.join(scopeDir, child.name), dest);
      }
    } else {
      // 跳过插件包自身
      if (entry.name === plugin.packageName) continue;
      const dest = path.join(pluginNm, entry.name);
      if (fs.existsSync(dest)) continue;
      copyDirSync(path.join(tmpNm, entry.name), dest);
    }
  }

  // 裁剪插件的 node_modules
  pruneNodeModules(pluginNm);
  pruneLlamaPackages(pluginNm);
  pruneFFmpegBinaries(pluginNm);
  prunePdfParseRedundantVersions(pluginNm);
  pruneDarwinUniversalNativePackages(pluginNm, opts.platform);
  pruneDanglingBinLinks(pluginNm);

  // 清理临时目录
  cleanupDirBestEffort(tmpDir, `${plugin.id} 临时安装目录`);

  // 写入版本戳
  fs.writeFileSync(
      path.join(pluginDir, `.oneclaw-${plugin.id}-stamp.json`),
      JSON.stringify({ source: sourceInfo.stampSource, bundledAt: new Date().toISOString() }, null, 2)
  );
  log(`已注入 ${plugin.id} 插件到 ${path.relative(ROOT, pluginDir)}`);
}

// 将插件注入 openclaw/extensions/<id>（支持 tgz 解压和 npm 包两种来源）
async function bundlePlugin(plugin, gatewayDir, targetId, opts) {
  // npm 包插件：在独立目录安装，防止传递依赖污染 gateway
  if (plugin.packageName) {
    return bundleNpmPackagePlugin(plugin, gatewayDir, targetId, opts);
  }

  const openclawDir = path.join(gatewayDir, "node_modules", "openclaw");
  if (!fs.existsSync(openclawDir)) {
    die(`openclaw 依赖目录不存在，无法注入 ${plugin.id}: ${openclawDir}`);
  }

  const extRoot = path.join(openclawDir, "extensions");
  const pluginDir = path.join(extRoot, plugin.id);
  ensureDir(extRoot);

  const source = await ensurePluginArchive(plugin);

  const safeId = plugin.id.replace(/-/g, "_");
  const tmpDir = createExtractTmpDir(path.dirname(source.archivePath), `${targetId}_${safeId}`);
  let extracted = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // 使用跨平台 Node.js 原生解压（兼容 Windows/macOS/Linux）
      extractTarGz(source.archivePath, tmpDir);
      extracted = true;
      break;
    } catch (err) {
      if (attempt === 1 && source.sourceURL) {
        log(`检测到 ${plugin.id} 缓存包可能损坏，重新下载后重试...`);
        cleanupDirBestEffort(tmpDir, `${plugin.id} 解压临时目录`);
        ensureDir(tmpDir);
        safeUnlink(source.archivePath);
        await downloadFileWithFallback([source.sourceURL], source.archivePath);
        continue;
      }
      cleanupDirBestEffort(tmpDir, `${plugin.id} 解压临时目录`);
      die(`解压 ${plugin.id} 包失败: ${err.message || String(err)}`);
    }
  }

  if (!extracted) {
    cleanupDirBestEffort(tmpDir, `${plugin.id} 解压临时目录`);
    die(`解压 ${plugin.id} 包失败（未知原因）`);
  }

  // 校验解压产物
  const extractedPkgDir = path.join(tmpDir, "package");
  try {
    assertPluginDir(plugin, extractedPkgDir, "package/");
  } catch (err) {
    cleanupDirBestEffort(tmpDir, `${plugin.id} 解压临时目录`);
    throw err;
  }

  rmDir(pluginDir);
  copyDirSync(extractedPkgDir, pluginDir);
  cleanupDirBestEffort(tmpDir, `${plugin.id} 解压临时目录`);

  const stamp = { source: source.sourceLabel, bundledAt: new Date().toISOString() };
  fs.writeFileSync(
      path.join(pluginDir, `.oneclaw-${plugin.id}-stamp.json`),
      JSON.stringify(stamp, null, 2)
  );
  log(`已注入 ${plugin.id} 插件到 ${path.relative(ROOT, pluginDir)}`);
}

// 注入所有 bundled 插件
async function bundleAllPlugins(gatewayDir, targetId, opts) {
  for (const plugin of BUNDLED_PLUGINS) {
    await bundlePlugin(plugin, gatewayDir, targetId, opts);
  }
}

// 裁剪 node_modules，删除无用文件以减小体积
function pruneNodeModules(nmDir) {
  if (!fs.existsSync(nmDir)) return;

  const openclawDir = path.join(nmDir, "openclaw");
  const openclawDocsDir = path.join(openclawDir, "docs");
  const openclawExtensionsDir = path.join(openclawDir, "extensions");
  const openclawDocsKeepDir = path.join(openclawDocsDir, "reference", "templates");

  // 需要删除的文档文件名（精确匹配，不区分大小写，避免误杀 changelog.js 等源文件）
  const junkNames = new Set([
    "readme", "readme.md", "readme.txt", "readme.markdown",
    "changelog", "changelog.md", "changelog.txt",
    "history.md", "authors", "authors.md", "contributors.md",
  ]);

  // 需要删除的目录名（只保留运行所需内容）
  const junkDirs = new Set([
    "test",
    "tests",
    "__tests__",
    "coverage",
    "docs",
    "examples",
    ".github",
    ".vscode",
    "benchmark",
    "benchmarks",
  ]);

  let removedFiles = 0;
  let removedDirs = 0;

  // 判断路径是否位于某个目录内部（含目录本身）
  function isPathInside(targetPath, basePath) {
    const rel = path.relative(basePath, targetPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  // 安全删除单个文件并统计
  function removeFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return;
      fs.unlinkSync(filePath);
      removedFiles += 1;
    } catch {
      // 忽略单文件清理异常，避免中断整体打包
    }
  }

  // 删除目录并统计（按入口目录计数）
  function removeDir(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    rmDir(dirPath);
    removedDirs += 1;
  }

  // 判断是否为 TS 声明文件（path.extname 无法直接识别 .d.ts）
  function isTypeDeclarationFile(fileNameLower) {
    return (
        fileNameLower.endsWith(".d.ts") ||
        fileNameLower.endsWith(".d.mts") ||
        fileNameLower.endsWith(".d.cts")
    );
  }

  // 精简 openclaw/docs，仅保留运行时必需模板 docs/reference/templates
  function pruneOpenclawDocs() {
    if (!fs.existsSync(openclawDocsDir)) return;
    if (!fs.existsSync(openclawDocsKeepDir)) {
      log("openclaw docs/reference/templates 不存在，跳过 openclaw docs 裁剪");
      return;
    }

    // 递归清理 docs：保留模板目录及其祖先路径，删除其余内容
    function walkDocs(dir) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const keepSelf = isPathInside(fullPath, openclawDocsKeepDir);
        const keepAncestor = isPathInside(openclawDocsKeepDir, fullPath);

        if (entry.isDirectory()) {
          if (keepSelf || keepAncestor) {
            walkDocs(fullPath);
          } else {
            removeDir(fullPath);
          }
          continue;
        }

        if (!keepSelf) {
          removeFile(fullPath);
        }
      }
    }

    walkDocs(openclawDocsDir);
  }

  // 递归遍历并清理
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // extensions 目录整体保护 — 插件 skills、docs 等子目录不受裁剪
        if (isPathInside(fullPath, openclawExtensionsDir)) {
          continue;
        }

        // openclaw/docs 需要保留模板目录，不能整目录删除
        if (fullPath === openclawDocsDir) {
          pruneOpenclawDocs();
          continue;
        }

        if (junkDirs.has(entry.name)) {
          removeDir(fullPath);
        } else {
          walk(fullPath);
        }
      } else {
        const nameLower = entry.name.toLowerCase();
        const ext = path.extname(nameLower);
        const shouldDelete = isTypeDeclarationFile(nameLower) || ext === ".map" || junkNames.has(nameLower);
        if (shouldDelete) {
          removeFile(fullPath);
        }
      }
    }
  }

  walk(nmDir);
  log(`node_modules 裁剪统计: 删除文件 ${removedFiles} 个，删除目录 ${removedDirs} 个`);
}

// ─── Step 3: 生成构建配置 ───

function generateBuildConfig(targetPaths) {
  writeBuildConfig(targetPaths.buildConfigPath);
}

// ─── Step 4: 拷贝图标资源 ───

function copyAppIcon(iconPath) {
  const src = path.join(ROOT, "assets", "icon.png");
  if (!fs.existsSync(src)) {
    die(`图标文件不存在: ${src}`);
  }

  ensureDir(path.dirname(iconPath));
  fs.copyFileSync(src, iconPath);
  log(`已拷贝 app-icon.png 到 ${path.relative(ROOT, iconPath)}`);
}

// ─── Step 5: 生成统一入口和构建信息 ───

function generateEntryAndBuildInfo(gatewayDir, platform, arch) {
  // 写入 gateway-entry.mjs（保持静态入口，避免入口脚本提前退出）
  const entryContent = 'import "./node_modules/openclaw/dist/entry.js";\n';
  fs.writeFileSync(path.join(gatewayDir, "gateway-entry.mjs"), entryContent);
  log("已生成 gateway-entry.mjs");

  // 写入 build-info.json
  const buildInfo = {
    arch,
    platform,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(gatewayDir, "build-info.json"), JSON.stringify(buildInfo, null, 2));
  log("已生成 build-info.json");
}

async function maybePackGatewayAsar(targetPaths) {
  if (process.env.ONECLAW_GATEWAY_ASAR !== "1") {
    return;
  }

  const gatewayDir = targetPaths.gatewayDir;
  const asarPath = path.join(targetPaths.targetBase, "gateway.asar");
  const unpackedDir = path.join(targetPaths.targetBase, "gateway.asar.unpacked");

  cleanupDirBestEffort(asarPath, "gateway.asar");
  cleanupDirBestEffort(unpackedDir, "gateway.asar.unpacked");

  log("Step 5.5: 打包 gateway.asar");
  await asar.createPackageWithOptions(gatewayDir, asarPath, {
    unpack: "{**/*.node,**/extensions/**/*}",
  });

  if (!fs.existsSync(asarPath)) {
    die(`gateway.asar 生成失败: ${asarPath}`);
  }

  const sizeMB = (fs.statSync(asarPath).size / 1048576).toFixed(1);
  log(`已生成 gateway.asar (${sizeMB} MB)`);
}

// 验证目标目录关键文件是否存在
function verifyOutput(targetPaths, platform) {
  log("正在验证输出文件...");

  const nodeExe = platform === "darwin" ? "node" : "node.exe";
  const targetRel = path.relative(ROOT, targetPaths.targetBase);
  const useAsar = process.env.ONECLAW_GATEWAY_ASAR === "1";

  // macOS npm 在 vendor/npm/，Windows npm 在 node_modules/npm/
  const npmDir = platform === "darwin"
      ? path.join(targetRel, "runtime", "vendor", "npm")
      : path.join(targetRel, "runtime", "node_modules", "npm");

  const required = [
    path.join(targetRel, "runtime", nodeExe),
    npmDir,
    path.join(targetRel, "build-config.json"),
    path.join(targetRel, "app-icon.png"),
  ];

  if (useAsar) {
    required.push(path.join(targetRel, "gateway.asar"));
  } else {
    required.push(
      path.join(targetRel, "gateway", "gateway-entry.mjs"),
      path.join(targetRel, "gateway", "node_modules", "openclaw", "openclaw.mjs"),
      path.join(targetRel, "gateway", "node_modules", "openclaw", "dist", "entry.js"),
      path.join(targetRel, "gateway", "node_modules", "openclaw", "dist", "control-ui", "index.html"),
      path.join(targetRel, "gateway", "node_modules", "clawhub", "bin", "clawdhub.js"),
      path.join(targetRel, "gateway", "node_modules", "openclaw", "extensions", "kimi-search", "openclaw.plugin.json"),
      path.join(targetRel, "gateway", "node_modules", "openclaw", "extensions", "qqbot", "openclaw.plugin.json"),
      path.join(targetRel, "gateway", "node_modules", "openclaw", "extensions", "dingtalk-connector", "openclaw.plugin.json"),
      path.join(targetRel, "gateway", "node_modules", "openclaw", "extensions", "wecom-openclaw-plugin", "openclaw.plugin.json"),
    );
  }

  let allOk = true;
  for (const rel of required) {
    const abs = path.join(ROOT, rel);
    const exists = fs.existsSync(abs);
    const status = exists ? "OK" : "缺失";
    console.log(`  [${status}] ${rel}`);
    if (!exists) allOk = false;
  }

  if (!allOk) {
    die("关键文件缺失，打包失败");
  }

  log("所有关键文件验证通过");
}

// ─── 主流程 ───

async function main() {
  const opts = parseArgs();
  const targetPaths = getTargetPaths(opts.platform, opts.arch);
  ensureDir(targetPaths.targetBase);

  console.log();
  log("========================================");
  log(`平台: ${opts.platform} | 架构: ${opts.arch}`);
  log(`目标: ${targetPaths.targetId}`);
  log("========================================");
  console.log();

  // Step 1: 下载 Node.js 22 运行时
  log("Step 1: 下载 Node.js 22 运行时");
  const nodeVersion = await getLatestNode22Version();
  log(`最新 Node.js 22.x 版本: v${nodeVersion}`);
  await downloadAndExtractNode(nodeVersion, opts.platform, opts.arch, targetPaths.runtimeDir);

  // Step 1.5: 写入 .npmrc
  log("Step 1.5: 配置 .npmrc");
  writeNpmrc(targetPaths.runtimeDir);

  console.log();

  // Step 2: 安装 openclaw 生产依赖
  log("Step 2: 安装 openclaw 生产依赖");
  installDependencies(opts, targetPaths.gatewayDir);

  console.log();

  // Step 2.5: 注入 bundled 插件（kimi-search + qqbot + dingtalk）
  log("Step 2.5: 注入 bundled 插件");
  await bundleAllPlugins(targetPaths.gatewayDir, targetPaths.targetId, opts);

  console.log();

  // Step 3: 生成构建配置
  log("Step 3: 生成构建配置");
  generateBuildConfig(targetPaths);

  console.log();

  // Step 4: 拷贝图标资源
  log("Step 4: 拷贝图标资源");
  copyAppIcon(targetPaths.iconPath);

  console.log();

  // Step 5: 生成入口文件和构建信息
  log("Step 5: 生成入口文件和构建信息");
  generateEntryAndBuildInfo(targetPaths.gatewayDir, opts.platform, opts.arch);

  console.log();

  await maybePackGatewayAsar(targetPaths);

  console.log();

  // 最终验证
  verifyOutput(targetPaths, opts.platform);

  console.log();
  log("资源打包完成！");
}

main().catch((err) => {
  die(err.message || String(err));
});
