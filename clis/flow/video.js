import fs from 'fs';
import path from 'path';
import os from 'os';
import { ArgumentError, TimeoutError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  ensureProjectPage,
  applyGenerationSettings,
  setEditorPrompt,
  triggerGeneration,
  autoApproveIfRequested,
  sleep,
} from './common.js';

function getDownloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

function getRecentDownloadFile(beforeTimestamp) {
  const downloadsDir = getDownloadsDir();
  if (!fs.existsSync(downloadsDir)) return null;

  const files = fs.readdirSync(downloadsDir).map((f) => {
    const fullPath = path.join(downloadsDir, f);
    try {
      const stat = fs.statSync(fullPath);
      return { name: f, fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }).filter(Boolean);

  // 筛选在 beforeTimestamp 之后修改的 mp4 文件
  const matching = files
    .filter((f) => f.mtimeMs >= beforeTimestamp && f.name.endsWith('.mp4'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return matching.length > 0 ? matching[0] : null;
}

cli({
  site: 'flow',
  name: 'video',
  description: 'Generate AI videos using Google Flow (https://flow.google.com)',
  access: 'write',
  domain: 'flow.google.com',
  strategy: Strategy.UI,
  browser: true,
  args: [
    {
      name: 'prompt',
      positional: true,
      required: true,
      help: 'Text prompt describing the video to generate',
    },
    {
      name: 'ratio',
      type: 'string',
      required: false,
      default: '16:9',
      help: 'Video aspect ratio: 16:9, 9:16',
    },
    {
      name: 'count',
      type: 'int',
      required: false,
      default: 1,
      help: 'Number of videos to generate (1-2)',
    },
    {
      name: 'output',
      type: 'string',
      required: false,
      help: 'Local file path to save the generated video (e.g. ./output.mp4)',
    },
    {
      name: 'project',
      type: 'string',
      required: false,
      help: 'Optional project ID or URL to run generation inside',
    },
    {
      name: 'timeout',
      type: 'int',
      required: false,
      default: 300,
      help: 'Timeout in seconds for video generation (default 300s)',
    },
  ],
  columns: [
    'id',
    'prompt',
    'ratio',
    'coverUrl',
    'output',
    'status',
  ],
  func: async (page, kwargs) => {
    const rawPrompt = String(kwargs.prompt || '').trim();
    if (!rawPrompt) {
      throw new ArgumentError('prompt cannot be empty');
    }

    const aspect = String(kwargs.ratio || '16:9').trim();
    const countNum = Math.max(1, Math.min(2, Number(kwargs.count) || 1));
    const outputPath = kwargs.output ? String(kwargs.output).trim() : '';
    const targetProject = kwargs.project ? String(kwargs.project).trim() : '';
    const timeoutSec = Math.max(30, Number(kwargs.timeout) || 300);

    // 格式化 prompt，若未明确指定生视频意图，补充视频提示词前缀
    let effectivePrompt = rawPrompt;
    if (!effectivePrompt.toLowerCase().includes('video') && !effectivePrompt.toLowerCase().includes('cinematic')) {
      effectivePrompt = `Generate a video of ${rawPrompt}`;
    }

    // 1. 确保停留在有效项目页面
    await ensureProjectPage(page, targetProject);

    // 2. 切换到 All media 视图
    await page.evaluate(() => {
      const allMediaItem = Array.from(document.querySelectorAll('flow-project-nav-list mat-list-item')).find((el) =>
        el.textContent.includes('All media')
      );
      if (allMediaItem) allMediaItem.click();
    });
    await sleep(800);

    // 3. 设置视频参数偏好
    await applyGenerationSettings(page, {
      isVideo: true,
      ratio: aspect,
      count: countNum,
    });

    // 4. 记录提交前的已有媒体元素集合
    const existingTileLabels = await page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll('flow-grid-tile-container'));
      return tiles.map((t) => t.getAttribute('aria-label') || '').filter(Boolean);
    });
    const priorLabels = new Set(existingTileLabels);

    // 5. 注入 Prompt 并提交
    const promptReady = await setEditorPrompt(page, effectivePrompt);
    if (!promptReady) {
      await sleep(500);
      await setEditorPrompt(page, effectivePrompt);
    }

    const submitted = await triggerGeneration(page);
    if (!submitted) {
      throw new CommandExecutionError('flow video', 'Failed to click generation submit button in Google Flow prompt box');
    }

    // 6. 轮询等待视频生成完成
    const startTime = Date.now();
    let videoCompleted = false;
    let coverUrl = '';
    let videoTitle = '';

    while (Date.now() - startTime < timeoutSec * 1000) {
      await sleep(3000);

      // 自动点击审批卡片（若出现）
      await autoApproveIfRequested(page);

      // 检查视频 Tile 或聊天项的状态
      const checkState = await page.evaluate((knownLabels) => {
        const known = new Set(knownLabels);
        const tiles = Array.from(document.querySelectorAll('flow-grid-tile-container'));

        // 找最新的视频 Tile
        for (const tile of tiles) {
          const videoTile = tile.querySelector('flow-video-tile');
          if (videoTile) {
            const label = tile.getAttribute('aria-label') || '';
            const pending = videoTile.querySelector('flow-pending-tile');
            const img = videoTile.querySelector('img.thumbnail, img');

            if (pending) {
              // 还在生成/渲染中
              const progressText = pending.textContent.trim();
              return { status: 'generating', progress: progressText, label };
            }

            if (img && img.src && (img.src.includes('flow-content.google') || img.src.includes('/asb/'))) {
              return { status: 'completed', coverUrl: img.src, label };
            }
          }
        }

        // 检查聊天视图中的 a2ui-video-option
        const chatVideoOption = document.querySelector('flow-a2ui-video-option');
        if (chatVideoOption) {
          const overlay = chatVideoOption.querySelector('flow-soupy-overlay, .loading-overlay');
          const videoImg = chatVideoOption.querySelector('img');
          if (!overlay && videoImg && videoImg.src) {
            return { status: 'completed', coverUrl: videoImg.src, label: 'video-from-chat' };
          }
          if (overlay) {
            return { status: 'generating', progress: 'rendering', label: 'video-from-chat' };
          }
        }

        return { status: 'waiting' };
      }, Array.from(priorLabels));

      if (checkState.status === 'completed') {
        videoCompleted = true;
        coverUrl = checkState.coverUrl || '';
        videoTitle = checkState.label || 'Google Flow Video';
        break;
      }
    }

    if (!videoCompleted) {
      throw new TimeoutError('flow video', `Video generation timed out after ${timeoutSec}s on Google Flow`);
    }

    // 7. 进入编辑器下载 720p 视频
    const downloadStartTime = Date.now() - 2000;
    let finalSavedPath = '-';

    // 点击视频 Tile 打开编辑详情页
    await page.evaluate(() => {
      const tile = document.querySelector('flow-grid-tile-container flow-video-tile');
      if (tile) {
        tile.click();
        return true;
      }
      const chatOption = document.querySelector('flow-a2ui-video-option [role="button"]');
      if (chatOption) {
        chatOption.click();
        return true;
      }
      return false;
    });

    // 等待进入 /edit/<sceneId>
    await sleep(2500);

    // 点击 Download media 按钮选择 720p 原画
    const downloadTriggered = await page.evaluate(async () => {
      const downloadBtn = document.querySelector('button[aria-label="Download media"]');
      if (!downloadBtn) return false;
      downloadBtn.click();

      await new Promise((r) => setTimeout(r, 400));

      const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] button'));
      const targetItem = menuItems.find((b) => b.textContent.includes('720p') || b.textContent.includes('Original size'));
      if (targetItem) {
        targetItem.click();
        return true;
      }
      return false;
    });

    if (downloadTriggered) {
      // 等待下载文件落盘完成（最多等待 30 秒）
      const pollDlStart = Date.now();
      let downloadedFile = null;

      while (Date.now() - pollDlStart < 30000) {
        await sleep(1500);
        const match = getRecentDownloadFile(downloadStartTime);
        if (match && match.size > 100000) {
          downloadedFile = match;
          break;
        }
      }

      if (downloadedFile) {
        if (outputPath) {
          const targetAbs = path.resolve(outputPath);
          const targetDir = path.dirname(targetAbs);
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          fs.copyFileSync(downloadedFile.fullPath, targetAbs);
          finalSavedPath = targetAbs;
        } else {
          finalSavedPath = downloadedFile.fullPath;
        }
      }
    }

    return [
      {
        id: videoTitle || `vid-${Date.now()}`,
        prompt: rawPrompt,
        ratio: aspect,
        coverUrl: coverUrl,
        output: finalSavedPath,
        status: 'completed',
      },
    ];
  },
});
