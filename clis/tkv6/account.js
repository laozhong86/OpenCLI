import { cli, Strategy } from '@jackwener/opencli/registry';
import { api, BASE } from './shared.js';

function rsaEncrypt(plain) {
    const pubkey = `MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBANL378k3RiZHWx5AfJqdH9xRNBmD9wGD2iRe41HdTNF8RUhNnHit5NpMNtGL0NPTSSpPjjI1kJfVorRvaQerUgkCAwEAAQ==`;
    return `RSA:${plain}`;
}

cli({
    site: 'tkv6',
    name: 'login',
    description: '登录 tkv6 并保存 JWT token (需要 Chrome 扩展)',
    access: 'read',
    example: 'opencli tkv6 login --username 13800138000 --password xxx',
    domain: 'www.tkv6.com',
    strategy: Strategy.UI,
    args: [
        { name: 'username', required: true, help: '手机号/用户名' },
        { name: 'password', required: true, help: '密码' },
    ],
    func: async (page, kwargs) => {
        await page.goto(`${BASE}/login?redirect=%2Fmyt%2FmytAccount`);
        const codeResp = await page.evaluate(async () => {
            const r = await fetch('/auth/code');
            return r.json();
        });

        await page.type('input[placeholder="用户名/手机号"]', kwargs.username);
        await page.type('input[placeholder="密码"]', kwargs.password);
        await page.type('input[placeholder="验证码"]', codeResp.code || '0000');

        await page.evaluate((encrypted) => {
            const vm = document.querySelector('#app').__vue__;
            vm.loginForm.password = encrypted;
        }, rsaEncrypt(kwargs.password));

        await page.click('button:has-text("登录")');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

        const token = await page.evaluate(() => localStorage.getItem('vuex'));
        return { status: 'logged_in', token_present: !!token };
    },
});

cli({
    site: 'tkv6',
    name: 'list',
    description: '列出 mytAccount 账号',
    access: 'read',
    browser: false,
    example: 'opencli tkv6 list --tag 默认分组 --limit 20 -f yaml',
    args: [
        { name: 'tag', help: '按标签分组筛选' },
        { name: 'limit', type: 'int', default: 20, help: '每页数量' },
        { name: 'page', type: 'int', default: 0, help: '页码，从 0 开始' },
    ],
    columns: ['id', 'uid', 'username', 'tagBucket', 'status', 'enable', 'createTime'],
    func: async (kwargs) => {
        const params = {
            sort: 'id,desc',
            page: kwargs.page,
            size: kwargs.limit,
        };
        if (kwargs.tag) params.tagBucket = kwargs.tag;
        const data = await api('GET', '/api/mytAccount', { params });
        const rows = data.content || [];
        return rows.map((row) => ({
            id: row.id,
            uid: row.uid,
            username: row.username,
            tagBucket: row.tagBucket,
            status: row.status,
            enable: row.enable,
            createTime: row.createTime,
        }));
    },
});

cli({
    site: 'tkv6',
    name: 'stats',
    description: '查看账号统计',
    access: 'read',
    browser: false,
    example: 'opencli tkv6 stats -f yaml',
    args: [],
    columns: ['tag', 'total', 'available', 'banned'],
    func: async () => {
        const data = await api('GET', '/api/mytAccount/getStatistics');
        return (data || []).map((row) => ({
            tag: row.tag,
            total: row.total,
            available: row.available,
            banned: row.banned,
        }));
    },
});

cli({
    site: 'tkv6',
    name: 'delete',
    description: '删除指定 ID 的账号',
    access: 'write',
    browser: false,
    example: 'opencli tkv6 delete --ids 123,456',
    args: [
        { name: 'ids', required: true, help: '逗号分隔的账号 ID' },
    ],
    columns: ['status', 'message'],
    func: async (kwargs) => {
        const ids = kwargs.ids.split(',').map((s) => Number(s.trim()));
        const data = await api('DELETE', '/api/mytAccount', { body: ids });
        return { status: 'ok', message: JSON.stringify(data) };
    },
});
