import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

async function hasGoogleSessionCookie(page) {
  const cookies = await page.getCookies({ url: 'https://flow.google.com' });
  const names = new Set(cookies.map((c) => c.name));
  return names.has('SID') || names.has('SAPISID') || names.has('__Secure-1PSID') || names.has('SSID');
}

async function verifyFlowIdentity(page) {
  if (!await hasGoogleSessionCookie(page)) {
    throw new AuthRequiredError('flow.google.com', 'Google session cookies (SID / SAPISID) missing');
  }
  await page.goto('https://flow.google.com/?pli=1');
  await page.wait(3);
  const probe = await page.evaluate(`
    (() => {
      const a = document.querySelector('a[aria-label^="Google Account:"], a[aria-label*="@"]');
      if (a) {
        const label = a.getAttribute('aria-label') || '';
        return { ok: true, name: label.replace(/^Google Account:\\s*/, '').trim() };
      }
      const hasContent = !!document.querySelector('flow-project-card, button[aria-label*="project"], flow-rich-text-editor');
      if (hasContent) {
        return { ok: true, name: 'Flow User' };
      }
      const signInBtn = Array.from(document.querySelectorAll('a, button')).find(
        (b) => b.textContent.includes('Sign in') || b.textContent.includes('登录')
      );
      if (signInBtn) {
        return { kind: 'auth', detail: 'Sign in button visible on flow.google.com' };
      }
      return { ok: true, name: 'Google Flow User' };
    })()
  `);
  if (probe?.kind === 'auth') throw new AuthRequiredError('flow.google.com', probe.detail);
  return { name: probe.name || 'Google Flow' };
}

registerSiteAuthCommands({
  site: 'flow',
  domain: 'flow.google.com',
  loginUrl: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fflow.google.com%2F%3Fpli%3D1',
  columns: ['name'],
  quickCheck: hasGoogleSessionCookie,
  verify: verifyFlowIdentity,
  poll: async (page) => {
    if (!await hasGoogleSessionCookie(page)) {
      throw new AuthRequiredError('flow.google.com', 'Waiting for Google Flow session cookies');
    }
    return verifyFlowIdentity(page);
  },
});
