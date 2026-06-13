import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

export const BASE = 'https://www.tkv6.com';

const DEFAULT_COOKIE_PATHS = [
    resolve(homedir(), 'Downloads/cookies (9).json'),
    resolve(homedir(), 'Downloads/tkv6-cookies.json'),
    resolve(homedir(), '.tkv6_token'),
];

let _cachedToken = null;

export function loadToken() {
    if (_cachedToken) return _cachedToken;

    if (process.env.TKV6_TOKEN) {
        const t = process.env.TKV6_TOKEN.trim();
        _cachedToken = t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}`;
        return _cachedToken;
    }

    const cookieFile = process.env.TKV6_COOKIE;
    const paths = cookieFile ? [resolve(cookieFile)] : DEFAULT_COOKIE_PATHS;

    for (const p of paths) {
        if (!existsSync(p)) continue;
        const content = readFileSync(p, 'utf-8');

        if (p.endsWith('.tkv6_token')) {
            _cachedToken = content.trim();
            if (!_cachedToken.toLowerCase().startsWith('bearer ')) {
                _cachedToken = `Bearer ${_cachedToken}`;
            }
            return _cachedToken;
        }

        try {
            const cookies = JSON.parse(content);
            const c = cookies.find(c => c.name === 'ELADMIN-TOEKN' && c.domain === 'www.tkv6.com');
            if (c) {
                _cachedToken = decodeURIComponent(c.value);
                if (!_cachedToken.toLowerCase().startsWith('bearer ')) {
                    _cachedToken = `Bearer ${_cachedToken}`;
                }
                return _cachedToken;
            }
        } catch { /* not a cookie JSON file */ }
    }

    throw new AuthRequiredError('tkv6', 'Set TKV6_COOKIE env var to a cookie JSON file path, or TKV6_TOKEN to a Bearer token');
}

export async function api(method, path, options = {}) {
    const token = loadToken();
    const headers = {
        Authorization: token,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...options.headers,
    };

    let url = `${BASE}${path}`;
    if (options.params) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(options.params)) {
            if (v !== undefined && v !== null) qs.append(k, String(v));
        }
        const qsStr = qs.toString();
        if (qsStr) url += (url.includes('?') ? '&' : '?') + qsStr;
    }

    const res = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!res.ok) throw new CommandExecutionError(`${method} ${path} failed: ${JSON.stringify(data)}`);
    return data;
}

export function buildTaskPayloads({ script, devices, seqs, proxies, proxyAllot = 1, params, name, planTime }) {
    if (!devices.length || !seqs.length) throw new CommandExecutionError('devices and seqs cannot be empty');

    const deviceIds = devices.map(d => d.id);
    const taskGroupParam = JSON.stringify({ deviceIds, deviceSeqs: seqs });
    const proxyIdList = (proxies?.length && proxyAllot === 2) ? proxies.map(p => p.id) : null;

    const now = new Date();
    const defaultPlanTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const payloads = [];
    let first = true;

    for (const dev of devices) {
        for (const seq of seqs) {
            const task = {
                id: null,
                userId: null,
                name: name || `${script.title}-${dev.name || dev.id}-${seq}`,
                scriptDesc: null,
                mytDevice: dev,
                mytProxy: null,
                deviceId: null,
                deviceIds: null,
                deviceArray: null,
                deviceSeq: seq,
                deviceSeqs: null,
                mytProxies: null,
                params,
                remark: null,
                planTime: planTime || defaultPlanTime,
                enable: true,
                taskGroupParam: null,
                template: false,
                scriptId: script.id,
                scriptName: script.title,
                scriptCode: script.name,
                status: 1,
                main: first,
                pid: null,
            };

            if (proxyAllot === 2) {
                task.proxyIdList = proxyIdList;
            } else if (proxies?.length) {
                task.mytProxy = proxies[payloads.length % proxies.length];
                task.proxyIdList = null;
            }

            if (first) {
                task.taskGroupParam = taskGroupParam;
            }

            payloads.push(task);
            first = false;
        }
    }

    return payloads;
}
