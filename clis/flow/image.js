import { ArgumentError, TimeoutError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  ensureProjectPage,
  applyGenerationSettings,
  setEditorPrompt,
  triggerGeneration,
  autoApproveIfRequested,
  downloadFile,
  sleep,
} from './common.js';

cli({
  site: 'flow',
  name: 'image',
  description: 'Generate AI images using Google Flow (https://flow.google.com)',
  access: 'write',
  domain: 'flow.google.com',
  strategy: Strategy.UI,
  browser: true,
  args: [
    {
      name: 'prompt',
      positional: true,
      required: true,
      help: 'Text prompt describing the image to generate',
    },
    {
      name: 'ratio',
      type: 'string',
      required: false,
      default: '16:9',
      help: 'Image aspect ratio: 16:9, 4:3, 1:1, 3:4, 9:16',
    },
    {
      name: 'count',
      type: 'int',
      required: false,
      default: 1,
      help: 'Number of images to generate (1-4)',
    },
    {
      name: 'output',
      type: 'string',
      required: false,
      help: 'Local file path to save the generated image (e.g. ./output.png)',
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
      default: 120,
      help: 'Timeout in seconds for image generation',
    },
  ],
  columns: [
    'id',
    'prompt',
    'ratio',
    'url',
    'output',
    'status',
  ],
  func: async (page, kwargs) => {
    const rawPrompt = String(kwargs.prompt || '').trim();
    if (!rawPrompt) {
      throw new ArgumentError('prompt cannot be empty');
    }

    const aspect = String(kwargs.ratio || '16:9').trim();
    const countNum = Math.max(1, Math.min(4, Number(kwargs.count) || 1));
    const outputPath = kwargs.output ? String(kwargs.output).trim() : '';
    const targetProject = kwargs.project ? String(kwargs.project).trim() : '';
    const timeoutSec = Math.max(10, Number(kwargs.timeout) || 120);

    // 1. 确保停留在有效项目主页
    await ensureProjectPage(page, targetProject);

    // 2. 确保切换到 All media 视图，方便监听新出图
    await page.evaluate(() => {
      const allMediaItem = Array.from(document.querySelectorAll('flow-project-nav-list mat-list-item')).find((el) =>
        el.textContent.includes('All media')
      );
      if (allMediaItem) allMediaItem.click();
    });
    await sleep(800);

    // 3. 应用长宽比与生成数量偏好
    await applyGenerationSettings(page, {
      isVideo: false,
      ratio: aspect,
      count: countNum,
    });

    // 4. 记录提交前的已有媒体 URL 集合，避免命中历史图片
    const existingMediaUrls = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('flow-grid-tile-container img, flow-image-tile img, flow-chat-view img'));
      return imgs.map((i) => i.src).filter(Boolean);
    });
    const priorSet = new Set(existingMediaUrls);

    // 5. 注入 Prompt 并提交
    const promptReady = await setEditorPrompt(page, rawPrompt);
    if (!promptReady) {
      // 容错重试一次
      await sleep(500);
      await setEditorPrompt(page, rawPrompt);
    }

    const submitted = await triggerGeneration(page);
    if (!submitted) {
      throw new CommandExecutionError('flow image', 'Failed to click generation submit button in Google Flow prompt box');
    }

    // 6. 轮询等待生成完成并捕获图片 URL
    const startTime = Date.now();
    let capturedImgUrl = '';
    let mediaTileId = '';

    while (Date.now() - startTime < timeoutSec * 1000) {
      await sleep(2000);

      // 检查是否有确认审批卡片，自动点击 Approve
      await autoApproveIfRequested(page);

      // 检测新生成的图片
      const pollResult = await page.evaluate((priorUrls) => {
        const prior = new Set(priorUrls);
        const stopBtn = document.querySelector('flow-stop-icon-button button');
        const isGenerating = !!stopBtn;

        // 优先在聊天视图中寻找最新的 flow-a2ui-image-option
        const chatImgs = Array.from(document.querySelectorAll('flow-a2ui-image-option img, flow-chat-view flow-a2ui-multiple-choice img'));
        for (const img of chatImgs) {
          if (img.src && !prior.has(img.src) && (img.src.includes('flow-content.google') || img.src.includes('/asb/'))) {
            return { done: true, url: img.src, id: img.alt || '' };
          }
        }

        // 其次在左侧第一张媒体卡片寻找
        const topTile = document.querySelector('flow-grid-tile-container flow-image-tile img');
        if (topTile && topTile.src && !prior.has(topTile.src)) {
          const container = topTile.closest('flow-grid-tile-container');
          const label = container?.getAttribute('aria-label') || '';
          return { done: true, url: topTile.src, id: label };
        }

        // 检查聊天是否已经完成输出
        const chatText = document.querySelector('flow-chat-view')?.innerText || '';
        const hasFinishedText =
          chatText.includes("I've generated") ||
          chatText.includes('generated those') ||
          chatText.includes('adjust the style');

        return { done: false, isGenerating, hasFinishedText };
      }, Array.from(priorSet));

      if (pollResult.done && pollResult.url) {
        capturedImgUrl = pollResult.url;
        mediaTileId = pollResult.id || `flow-img-${Date.now()}`;
        break;
      }

      // 如果提示已完成但图片加载稍有延迟，再给 2 秒后重试捕获
      if (pollResult.hasFinishedText && !pollResult.isGenerating) {
        await sleep(2500);
        const lateImg = await page.evaluate((priorUrls) => {
          const prior = new Set(priorUrls);
          const topTile = document.querySelector('flow-grid-tile-container flow-image-tile img, flow-a2ui-image-option img');
          if (topTile && topTile.src && !prior.has(topTile.src)) {
            return topTile.src;
          }
          return '';
        }, Array.from(priorSet));

        if (lateImg) {
          capturedImgUrl = lateImg;
          mediaTileId = `flow-img-${Date.now()}`;
          break;
        }
      }
    }

    if (!capturedImgUrl) {
      throw new TimeoutError('flow image', `Image generation timed out after ${timeoutSec}s on Google Flow`);
    }

    // 7. 若指定本地输出路径，自动下载图片
    let finalOutputPath = '-';
    if (outputPath) {
      try {
        finalOutputPath = await downloadFile(capturedImgUrl, outputPath);
      } catch (err) {
        finalOutputPath = `Download error: ${err.message}`;
      }
    }

    return [
      {
        id: mediaTileId || `img-${Date.now()}`,
        prompt: rawPrompt,
        ratio: aspect,
        url: capturedImgUrl,
        output: finalOutputPath,
        status: 'completed',
      },
    ];
  },
});
