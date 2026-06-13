import { cli } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { api, buildTaskPayloads } from './shared.js';

const STATUS_LABEL = {
    '-2': '强制结束',
    '-3': '超时',
    '-1': '异常',
    '0': '已完成',
    '1': '未启动',
    '2': '已下发',
};

const TRAIN_ACCOUNT_SUB_TASK = {
    name: '[TK] - 自动养号 - 优先使用',
    scriptId: 233,
    scriptName: '[TK] - 自动养号 - 优先使用',
    scriptCode: 'TkNewTrainAccountVertical',
    order: 1,
};

const DEFAULT_TRAIN_PARAMS = {
    search_keywords: '',
    search_type: '1',
    scroll_num: 5,
    follow_rate: 5,
    like_rate: 5,
    favorite_rate: 5,
    watch_comment_rate: 5,
    watch_comment_pages: 1,
    watch_comment_digg_rate: 5,
    watch_comment_enter_rate: 5,
    post_comment_rate: 3,
    post_comment_at: '',
    post_comment_content: '',
    keywords: '',
    interval_min: 2,
    interval_max: 5,
    repost_video: false,
};

const SEARCH_TYPE_MAP = { video: '1', top: '2', hashtag: '3', user: '4', work_id: '5' };

cli({
    site: 'tkv6',
    name: 'task-create',
    description: '创建自动养号任务 (StartAccount + 养号子任务)',
    access: 'write',
    browser: false,
    example: 'opencli tkv6 task-create --device-ids 405 --tag 手搓 --video-count 10 --follow-prob 5',
    args: [
        { name: 'device-ids', required: true, help: '逗号分隔设备 ID，如 405,406' },
        { name: 'tag', required: true, help: '账号池标签，如 手搓' },
        { name: 'seq', default: '1', help: '逗号分隔机位序号，默认 1' },
        { name: 'times', type: 'int', default: 1, help: '每窗口分配数量' },
        { name: 'back-type', default: '2', help: '备份方式: 2=盒子 3=私有云' },
        { name: 'use-proxy', type: 'boolean', default: true, help: '使用账号绑定代理' },
        { name: 'search-term', help: '搜索词' },
        { name: 'search-type', default: 'video', choices: ['video', 'top', 'hashtag', 'user', 'work_id'], help: '搜索类型' },
        { name: 'video-count', type: 'int', default: 5, help: '刷视频数量' },
        { name: 'follow-prob', type: 'int', default: 5, help: '关注概率(%)' },
        { name: 'like-prob', type: 'int', default: 5, help: '点赞概率(%)' },
        { name: 'save-prob', type: 'int', default: 5, help: '收藏概率(%)' },
        { name: 'comment-prob', type: 'int', default: 5, help: '评论概率(%)' },
        { name: 'comment-pages', type: 'int', default: 1, help: '看评论页数' },
        { name: 'comment-digg-prob', type: 'int', default: 5, help: '评论点赞概率(%)' },
        { name: 'comment-enter-prob', type: 'int', default: 5, help: '进入评论概率(%)' },
        { name: 'post-comment-prob', type: 'int', default: 3, help: '发表评论概率(%)' },
        { name: 'dwell-min', type: 'int', default: 2, help: '最小停留时间(秒)' },
        { name: 'dwell-max', type: 'int', default: 5, help: '最大停留时间(秒)' },
        { name: 'forward', type: 'boolean', default: false, help: '转发作品' },
        { name: 'uid', help: '指定 UID，每行一个' },
        { name: 'name', help: '任务名，默认自动生成' },
        { name: 'proxy-ids', help: '逗号分隔代理 ID' },
        { name: 'proxy-allot', type: 'int', default: 1, help: '代理分配: 1=轮询 2=按任务' },
        { name: 'dry-run', type: 'boolean', default: false, help: '只打印 payload 不创建' },
    ],
    columns: ['name', 'scriptName', 'deviceId', 'deviceSeq', 'status'],
    func: async (kwargs) => {
        const scripts = await api('GET', '/api/mytScript/getTaskMytScript');
        const script = scripts.find(s => s.name === 'StartAccount' || s.id === 174);
        if (!script) {
            const available = scripts.map(s => `  ${s.id}  ${s.name || '-'}  ${s.title}`).join('\n');
            throw new CommandExecutionError(`找不到 StartAccount 脚本。可用:\n${available}`);
        }

        const allDevices = await api('GET', '/api/mytDevice/getTaskMytDevice');
        const deviceIds = kwargs['device-ids'].split(',').map(s => Number(s.trim())).filter(Boolean);
        const devices = allDevices.filter(d => deviceIds.includes(d.id));
        if (!devices.length) {
            const available = allDevices.map(d => `  ${d.id}  ${d.ip || '-'}  ${d.name || '-'}`).join('\n');
            throw new CommandExecutionError(`找不到指定设备。可用:\n${available}`);
        }

        const seqs = kwargs.seq.split(',').map(s => Number(s.trim())).filter(Boolean);

        let proxies = [];
        if (kwargs['proxy-ids']) {
            const proxyIds = kwargs['proxy-ids'].split(',').map(s => Number(s.trim())).filter(Boolean);
            const allProxies = await api('GET', '/api/mytProxy/getTaskMytProxy');
            proxies = allProxies.filter(p => proxyIds.includes(p.id));
        }

        const trainParams = { ...DEFAULT_TRAIN_PARAMS };
        if (kwargs['search-term']) trainParams.search_keywords = kwargs['search-term'];
        trainParams.search_type = SEARCH_TYPE_MAP[kwargs['search-type']] || '1';
        trainParams.scroll_num = kwargs['video-count'];
        trainParams.follow_rate = kwargs['follow-prob'];
        trainParams.like_rate = kwargs['like-prob'];
        trainParams.favorite_rate = kwargs['save-prob'];
        trainParams.watch_comment_rate = kwargs['comment-prob'];
        trainParams.watch_comment_pages = kwargs['comment-pages'];
        trainParams.watch_comment_digg_rate = kwargs['comment-digg-prob'];
        trainParams.watch_comment_enter_rate = kwargs['comment-enter-prob'];
        trainParams.post_comment_rate = kwargs['post-comment-prob'];
        trainParams.interval_min = kwargs['dwell-min'];
        trainParams.interval_max = kwargs['dwell-max'];
        trainParams.repost_video = kwargs.forward;

        const params = {
            back_type: kwargs['back-type'],
            use_backup_proxy: kwargs['use-proxy'],
            uid: kwargs.uid || '',
            tag: kwargs.tag,
            times: kwargs.times,
            sub_task: [
                {
                    ...TRAIN_ACCOUNT_SUB_TASK,
                    params: trainParams,
                },
            ],
        };

        const payloads = buildTaskPayloads({
            script,
            devices,
            seqs,
            proxies,
            proxyAllot: kwargs['proxy-allot'],
            params,
            name: kwargs.name,
        });

        if (kwargs['dry-run']) {
            return payloads.map(p => ({
                name: p.name,
                scriptName: p.scriptName,
                deviceId: p.mytDevice?.id,
                deviceSeq: p.deviceSeq,
                status: 'dry-run',
                params: JSON.stringify(p.params),
            }));
        }

        await api('POST', '/api/mytTask/batch', { body: payloads });

        return payloads.map(p => ({
            name: p.name,
            scriptName: p.scriptName,
            deviceId: p.mytDevice?.id,
            deviceSeq: p.deviceSeq,
            status: 'created',
        }));
    },
});

cli({
    site: 'tkv6',
    name: 'task-list',
    description: '列出 TKV6 任务',
    access: 'read',
    browser: false,
    example: 'opencli tkv6 task-list --limit 10 --main',
    args: [
        { name: 'limit', type: 'int', default: 20, help: '每页数量' },
        { name: 'page', type: 'int', default: 0, help: '页码，从 0 开始' },
        { name: 'task-id', type: 'int', help: '按任务 ID 精确查询' },
        { name: 'name', help: '按任务名模糊查询' },
        { name: 'script', help: '按功能/脚本名模糊查询' },
        { name: 'device-id', type: 'int', help: '按设备 ID 筛选' },
        { name: 'status', type: 'int', help: '任务状态: -2=强制结束 -3=超时 -1=异常 0=已完成 1=未启动 2=已下发' },
        { name: 'main', type: 'boolean', default: false, help: '只查主任务' },
    ],
    columns: ['id', 'name', 'scriptName', 'device', 'deviceSeq', 'status', 'statusLabel', 'progress', 'createTime'],
    func: async (kwargs) => {
        const params = {
            sort: 'createTime,desc',
            page: kwargs.page,
            size: kwargs.limit,
        };
        if (kwargs.main) params.main = 'true';
        if (kwargs.name) params.name = kwargs.name;
        if (kwargs.script) params.scriptName = kwargs.script;
        if (kwargs['device-id'] != null) params.deviceId = kwargs['device-id'];
        if (kwargs['task-id'] != null) params.id = kwargs['task-id'];
        if (kwargs.status != null) params.status = kwargs.status;

        const data = await api('GET', '/api/mytTask', { params });
        const rows = data.content || [];
        return rows.map(row => {
            const dev = row.mytDevice || {};
            const totalExec = row.executeTotal || 0;
            const progress = totalExec ? Math.round((row.executeCount || 0) / totalExec * 100) : 0;
            return {
                id: row.id,
                name: row.name,
                scriptName: row.scriptName,
                device: `${dev.ip || '-'} (${dev.name || '-'})`,
                deviceSeq: row.deviceSeq,
                status: row.status,
                statusLabel: STATUS_LABEL[String(row.status)] || 'unknown',
                progress: `${progress}%`,
                createTime: row.createTime,
            };
        });
    },
});

cli({
    site: 'tkv6',
    name: 'task-kill',
    description: '终止运行中的 TKV6 任务',
    access: 'write',
    browser: false,
    example: 'opencli tkv6 task-kill --task-id 7065232',
    args: [
        { name: 'task-id', type: 'int', required: true, help: '任务 ID' },
    ],
    columns: ['status', 'message'],
    func: async (kwargs) => {
        const data = await api('GET', `/api/mytBroker/killTask?id=${kwargs['task-id']}`);
        return { status: 'ok', message: JSON.stringify(data) };
    },
});
