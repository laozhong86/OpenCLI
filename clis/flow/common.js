import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

export const FLOW_BASE_URL = 'https://flow.google.com/?pli=1';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 页面跳转兼容器
 */
export async function navigateTo(page, url) {
  if (typeof page.goto === 'function') {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return;
    } catch {}
  }
  if (typeof page.open === 'function') {
    try {
      await page.open(url);
      return;
    } catch {}
  }
  await page.evaluate((u) => { window.location.href = u; }, url);
}

/**
 * 获取当前 URL
 */
export async function getPageUrl(page) {
  if (typeof page.url === 'function') {
    try {
      return page.url();
    } catch {}
  }
  return await page.evaluate(() => window.location.href);
}

/**
 * 确保浏览器停留在有效 Google Flow 项目页面
 */
export async function ensureProjectPage(page, targetProject) {
  let currentUrl = await getPageUrl(page);

  // 如果指定了具体项目，直达该项目
  if (targetProject) {
    let projUrl = targetProject;
    if (!projUrl.startsWith('http')) {
      projUrl = `https://flow.google.com/project/${targetProject}`;
    }
    if (!currentUrl.includes(targetProject)) {
      await navigateTo(page, projUrl);
      await sleep(3000);
    }
  } else if (!currentUrl.includes('flow.google.com/project/')) {
    // 未在项目页面，打开 Flow 主页
    await navigateTo(page, FLOW_BASE_URL);
    await sleep(3000);
  }

  // 关闭 Cookie 条和所有可能出现的模态弹窗
  await dismissOverlays(page);

  currentUrl = await getPageUrl(page);
  // 如果还在首页，自动进入第一个项目或点击 New project
  if (!currentUrl.includes('/project/')) {
    const entered = await page.evaluate(() => {
      // 找已有项目卡片
      const projectLink = document.querySelector('flow-project-card a[href*="/project/"]');
      if (projectLink) {
        projectLink.click();
        return true;
      }
      // 找 New project 按钮
      const buttons = Array.from(document.querySelectorAll('button'));
      const newProjBtn = buttons.find((b) => b.textContent.includes('New project'));
      if (newProjBtn) {
        newProjBtn.click();
        return true;
      }
      return false;
    });

    if (entered) {
      await sleep(4000);
      await dismissOverlays(page);
    }
  }

  // 确保处于项目主画布（如果当前在 edit 或 tools 子页面，直接导航回到项目主画布）
  currentUrl = await getPageUrl(page);
  if (currentUrl.includes('/edit/') || currentUrl.includes('/tools')) {
    const cleanProjUrl = currentUrl.split('/edit/')[0].split('/tools')[0];
    await navigateTo(page, cleanProjUrl);
    await sleep(2500);
  }

  // 再次确保弹窗关闭
  await dismissOverlays(page);
}

/**
 * 关闭常见弹窗（Cookie 栏、更新日志、对话框）
 */
export async function dismissOverlays(page) {
  await page.evaluate(() => {
    // 1. Cookie 提示栏
    const cookieBtn = document.querySelector('#glue-cookie-notification-bar-1 button');
    if (cookieBtn) cookieBtn.click();

    // 2. Changelog / 引导弹窗
    const dialogButtons = Array.from(document.querySelectorAll('mat-dialog-container button, flow-change-log-modal button'));
    const startBtn = dialogButtons.find((b) => b.textContent.includes('Get started') || b.textContent.includes('Got it') || b.textContent.includes('Close'));
    if (startBtn) startBtn.click();
  });
  await sleep(500);
}

/**
 * 向 ProseMirror 编辑器注入文本并激活提交按钮
 */
export async function setEditorPrompt(page, promptText) {
  const success = await page.evaluate((text) => {
    const editor = document.querySelector('flow-rich-text-editor [contenteditable="true"]');
    if (!editor) return false;
    editor.focus();

    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);

    document.execCommand('delete');
    document.execCommand('insertText', false, text);
    editor.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      })
    );

    const submitBtn = document.querySelector('flow-generate-icon-button button[type="submit"]');
    return submitBtn && !submitBtn.disabled;
  }, promptText);

  return success;
}

/**
 * 点击开始生成按钮
 */
export async function triggerGeneration(page) {
  return await page.evaluate(() => {
    const submitBtn = document.querySelector('flow-generate-icon-button button[type="submit"]');
    if (submitBtn && !submitBtn.disabled) {
      submitBtn.click();
      return true;
    }
    return false;
  });
}

/**
 * 自动检测并点击审批确认卡片（如存在）
 */
export async function autoApproveIfRequested(page) {
  return await page.evaluate(() => {
    const options = Array.from(document.querySelectorAll('flow-chat-view .option-row, flow-permission-message [role="radio"]'));
    const approveBtn = options.find((el) => {
      const text = el.textContent.trim();
      return text.includes('Approve') && !text.includes('Always');
    });
    if (approveBtn) {
      approveBtn.click();
      return true;
    }
    return false;
  });
}

/**
 * 设置生图/生视频的参数配置（长宽比、生成数量）
 */
export async function applyGenerationSettings(page, { isVideo = false, ratio, count }) {
  if (!ratio && !count) return;

  await page.evaluate(async ({ isVideo, ratio, count }) => {
    const settingsBtn = document.querySelector('flow-creative-agent-prompt-box button[aria-label="Settings"]');
    if (!settingsBtn) return;
    settingsBtn.click();

    // 等待 settings 展开
    await new Promise((r) => setTimeout(r, 400));

    const settingsView = document.querySelector('flow-settings-view');
    if (!settingsView) return;

    const groupLabelPrefix = isVideo ? 'Video generation default' : 'Image generation default';

    // 匹配比例
    if (ratio) {
      const ratioGroup = Array.from(settingsView.querySelectorAll('flow-toggles')).find((t) =>
        t.getAttribute('aria-label')?.includes(`${groupLabelPrefix} aspect ratio`)
      );
      if (ratioGroup) {
        const btn = Array.from(ratioGroup.querySelectorAll('button')).find((b) => b.textContent.includes(ratio));
        if (btn && btn.getAttribute('aria-checked') !== 'true') {
          btn.click();
        }
      }
    }

    // 匹配数量
    if (count) {
      const countGroup = Array.from(settingsView.querySelectorAll('flow-toggles')).find((t) =>
        t.getAttribute('aria-label')?.includes(`${groupLabelPrefix} output count`)
      );
      if (countGroup) {
        const btn = Array.from(countGroup.querySelectorAll('button')).find((b) => b.textContent.trim() === `x${count}`);
        if (btn && btn.getAttribute('aria-checked') !== 'true') {
          btn.click();
        }
      }
    }

    // 点击 Back 按钮返回
    const backBtn = document.querySelector('flow-agent-panel button[aria-label="Back"]');
    if (backBtn) backBtn.click();
  }, { isVideo, ratio, count });

  await sleep(500);
}

/**
 * 下载远程 URL 到指定本地文件路径
 */
export function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const resolvedPath = path.resolve(destPath);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const file = fs.createWriteStream(resolvedPath);
    const client = url.startsWith('https') ? https : http;

    client
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(resolvedPath);
          return reject(new Error(`Download failed HTTP ${response.statusCode}`));
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve(resolvedPath));
        });
      })
      .on('error', (err) => {
        file.close();
        if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
        reject(err);
      });
  });
}
