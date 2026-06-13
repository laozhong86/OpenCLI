#!/usr/bin/env python3
"""
TKV6 (tkv6.com) 运营中心命令行工具
支持账号管理、任务管理（任务列表/新增/终止/状态查看）。

用法：
  # 从 cookie JSON 文件读取 token（推荐）
  export TKV6_COOKIE="/Users/x/Downloads/cookies (9).json"
  python3 tkv6.py account list --limit 10
  python3 tkv6.py account stats

  python3 tkv6.py task list --limit 10
  python3 tkv6.py task running
  python3 tkv6.py task kill 7065232
  python3 tkv6.py task scripts
  python3 tkv6.py task params 174

  # 或手动登录（需要 RSA 加密）
  python3 tkv6.py login --username 13800138000 --password xxx

环境变量：
  TKV6_COOKIE - cookie JSON 文件路径
  TKV6_TOKEN  - 直接传入 Bearer token
"""
import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime
from pathlib import Path

import requests

BASE = "https://www.tkv6.com"


def load_token():
    """优先从环境变量或 cookie 文件加载 token。"""
    if os.environ.get("TKV6_TOKEN"):
        t = os.environ["TKV6_TOKEN"].strip()
        return t if t.lower().startswith("bearer ") else f"Bearer {t}"

    cookie_file = os.environ.get("TKV6_COOKIE", "/Users/x/Downloads/cookies (9).json")
    p = Path(cookie_file).expanduser()
    if p.exists():
        cookies = json.loads(p.read_text())
        for c in cookies:
            if c.get("name") == "ELADMIN-TOEKN" and c.get("domain") == "www.tkv6.com":
                return urllib.parse.unquote(c["value"])

    # 兼容旧文件
    token_file = Path.home() / ".tkv6_token"
    if token_file.exists():
        return token_file.read_text().strip()

    print("找不到 token。请设置 TKV6_COOKIE、TKV6_TOKEN 或先执行 login。", file=sys.stderr)
    sys.exit(1)


def save_token(token: str):
    """保存 token 到本地文件。"""
    token_file = Path.home() / ".tkv6_token"
    token_file.write_text(token)


def api(method: str, path: str, **kwargs):
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = load_token()
    headers.setdefault("Accept", "application/json")
    url = f"{BASE}{path}" if not path.startswith("http") else path
    r = requests.request(method, url, headers=headers, timeout=30, **kwargs)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text[:500]


def print_json(data):
    print(json.dumps(data, indent=2, ensure_ascii=False))


def ensure_bearer(token: str) -> str:
    return token if token.lower().startswith("bearer ") else f"Bearer {token}"


# ---------- helpers ----------

def parse_kv_list(items):
    """解析 ['key=value', ...] 为 dict。"""
    result = {}
    if not items:
        return result
    for item in items:
        if "=" not in item:
            raise ValueError(f"参数格式错误，应为 key=value: {item}")
        k, v = item.split("=", 1)
        result[k] = v
    return result


def _maybe_json(raw_value):
    """如果字符串是 JSON 数组/对象/字符串/布尔/null，解析后返回；纯数字保留字符串。"""
    if not isinstance(raw_value, str):
        return raw_value
    s = raw_value.strip()
    if s.startswith(("[", "{", '"')) or s in ("true", "false", "null"):
        try:
            return json.loads(s)
        except Exception:
            pass
    return raw_value


def coerce_param(param_def, raw_value):
    """根据脚本参数定义把字符串转换为合适类型。"""
    ptype = param_def.get("type", "text")
    if ptype in ("switch",):
        return raw_value.lower() in ("true", "1", "yes", "on")
    if ptype in ("number", "progress"):
        try:
            return int(raw_value)
        except ValueError:
            return float(raw_value)
    if ptype in ("sub_task", "tag_actions"):
        if isinstance(raw_value, str):
            return json.loads(raw_value)
        return raw_value
    # select/dropdown/resource/data/images/material_resource/select_media/text/textarea/backup_method
    # 先尝试 JSON，再保留字符串
    return _maybe_json(raw_value)


def fetch_scripts():
    status, data = api("GET", "/api/mytScript/getTaskMytScript")
    if status != 200:
        raise RuntimeError(f"获取脚本失败: {status} {data}")
    return data


def fetch_sub_scripts():
    status, data = api("GET", "/api/mytScript/getSubTaskScripts")
    if status != 200:
        raise RuntimeError(f"获取子任务脚本失败: {status} {data}")
    return data


def find_script(scripts, script_ref):
    """根据 id(int)、code 或 title/name 匹配脚本。"""
    if script_ref is None:
        return None
    ref = str(script_ref).strip()
    # 优先按 id
    if ref.isdigit():
        sid = int(ref)
        for s in scripts:
            if s.get("id") == sid:
                return s
    # 再按 code / name / title
    for s in scripts:
        if s.get("code") == ref or s.get("name") == ref or s.get("title") == ref:
            return s
    return None


def fetch_devices():
    status, data = api("GET", "/api/mytDevice/getTaskMytDevice")
    if status != 200:
        raise RuntimeError(f"获取设备失败: {status} {data}")
    return data


def fetch_proxies():
    status, data = api("GET", "/api/mytProxy/getTaskMytProxy")
    if status != 200:
        raise RuntimeError(f"获取代理失败: {status} {data}")
    return data


def build_task_payloads(script_id, script_name, script_code,
                        devices, seqs, proxies, proxy_allot,
                        params, name=None, remark=None, plan_time=None):
    """
    模拟前端 save_continue_batch，生成 POST /api/mytTask/batch 的数组。
    devices: list of device dicts
    seqs: list of ints
    proxies: list of proxy dicts
    proxy_allot: 1 表示单代理/轮询分配，2 表示按任务分配 proxyIdList
    params: dict，任务的 params 字段
    """
    if not devices or not seqs:
        raise ValueError("设备和机位不能为空")

    device_ids = [d["id"] for d in devices]
    device_seqs = list(seqs)
    task_group_param = {"deviceIds": device_ids, "deviceSeqs": device_seqs}

    proxy_id_list = [p["id"] for p in proxies] if proxies and proxy_allot == 2 else None

    payloads = []
    first = True
    for dev in devices:
        for seq in device_seqs:
            task = {
                "id": None,
                "userId": None,
                "name": name or f"{script_name}-{dev.get('name', dev['id'])}-{seq}",
                "scriptDesc": None,
                "mytDevice": dev,
                "mytProxy": None,
                "deviceId": None,
                "deviceIds": None,
                "deviceArray": None,
                "deviceSeq": seq,
                "deviceSeqs": None,
                "mytProxies": None,
                "params": params,
                "remark": remark,
                "planTime": plan_time or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "enable": True,
                "taskGroupParam": None,
                "template": False,
                "scriptId": script_id,
                "scriptName": script_name,
                "scriptCode": script_code,
                "status": 1,
                "main": first,
                "pid": None,
            }
            if proxy_allot == 2:
                task["proxyIdList"] = proxy_id_list
                task["mytProxy"] = None
            else:
                if proxies:
                    idx = len(payloads) % len(proxies)
                    task["mytProxy"] = proxies[idx]
                task["proxyIdList"] = None

            if first:
                task["taskGroupParam"] = json.dumps(task_group_param, separators=(",", ":"))
                task["template"] = task.get("template") or False
            else:
                task["taskGroupParam"] = None
                task["template"] = False

            payloads.append(task)
            first = False
    return payloads


# ---------- commands ----------

def rsa_encrypt_password(plain: str) -> str:
    try:
        from Crypto.Cipher import PKCS1_v1_5
        from Crypto.PublicKey import RSA
    except ImportError:
        print("login 需要 pycryptodome，请安装: pip3 install pycryptodome", file=sys.stderr)
        sys.exit(1)

    # 登录页 JS 中硬编码的 RSA 公钥（若后端轮换，可运行时从 /login 页面抓取）
    pubkey_pem = """-----BEGIN PUBLIC KEY-----
MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBANL378k3RiZHWx5AfJqdH9xRNBmD9wGD
2iRe41HdTNF8RUhNnHit5NpMNtGL0NPTSSpPjjI1kJfVorRvaQerUgkCAwEAAQ==
-----END PUBLIC KEY-----"""
    key = RSA.import_key(pubkey_pem)
    cipher = PKCS1_v1_5.new(key)
    return base64.b64encode(cipher.encrypt(plain.encode())).decode()


def cmd_login(args):
    s = requests.Session()

    # 1. 获取验证码
    code_resp = s.get(f"{BASE}/auth/code").json()
    uuid = code_resp["uuid"]
    img_data = base64.b64decode(code_resp["img"].split(",")[1])

    captcha_path = Path.home() / ".tkv6_captcha.png"
    captcha_path.write_bytes(img_data)
    print(f"验证码已保存: {captcha_path}")
    print("请打开图片，输入计算结果（例如 3+2=? 则输入 5）")

    # 2. 手动输入验证码
    code = input("验证码结果: ").strip()
    if not code:
        print("未输入验证码", file=sys.stderr)
        sys.exit(1)

    # 3. RSA 加密密码并登录
    payload = {
        "username": args.username,
        "password": rsa_encrypt_password(args.password),
        "code": code,
        "uuid": uuid,
        "rememberMe": True,
    }
    login_resp = s.post(f"{BASE}/auth/login", json=payload)
    try:
        data = login_resp.json()
    except Exception:
        print(f"登录失败: {login_resp.status_code} {login_resp.text[:200]}", file=sys.stderr)
        sys.exit(1)

    if login_resp.status_code != 200 or not data.get("token"):
        print(f"登录失败: {data}", file=sys.stderr)
        sys.exit(1)

    token = data["token"]
    save_token(token)
    print(f"登录成功，token 已保存到 {Path.home() / '.tkv6_token'}")
    print_json({"username": data.get("user", {}).get("username"), "token": token[:30] + "..."})


def cmd_whoami(args):
    status, data = api("GET", "/auth/info")
    print_json(data)


# ---------- account commands ----------

def cmd_account_list(args):
    params = {
        "sort": args.sort or "id,desc",
        "page": args.page,
        "size": args.limit,
    }
    if args.tag:
        params["tag"] = args.tag
    if args.search:
        params["blurry"] = args.search
    status, data = api("GET", "/api/mytAccount", params=params)
    if status != 200:
        print(f"请求失败: {status}", file=sys.stderr)
        print_json(data)
        sys.exit(1)

    rows = data.get("content", [])
    total = data.get("totalElements", len(rows))
    print(f"# 共 {total} 条，当前 {len(rows)} 条")
    for row in rows:
        print_json({
            "id": row.get("id"),
            "uid": row.get("uid"),
            "username": row.get("username"),
            "tag": row.get("tag"),
            "tagBucket": row.get("tagBucket"),
            "status": row.get("status"),
            "enable": row.get("enable"),
            "online": row.get("online"),
            "follower": row.get("follower"),
            "region": row.get("region"),
            "createTime": row.get("createTime"),
            "updateTime": row.get("updateTime"),
        })


def cmd_account_stats(args):
    status, data = api("GET", "/api/mytAccount/getStatistics")
    print_json(data)


def cmd_account_tags(args):
    status, data = api("GET", "/api/mytAccount/tagBucket/list")
    print_json(data)


def cmd_account_delete(args):
    ids = [int(x) for x in re.split(r"[,\s]+", args.ids) if x]
    status, data = api("DELETE", "/api/mytAccount", json=ids)
    print_json({"status": status, "data": data})


def cmd_account_favorite(args):
    status, data = api("POST", f"/api/mytAccount/favorite?id={args.id}&favorite={str(args.favorite).lower()}")
    print_json({"status": status, "data": data})


def cmd_account_export(args):
    """导出当前筛选条件的全部数据（Excel）。"""
    params = {"sort": "id,desc"}
    if args.tag:
        params["tag"] = args.tag
    print(f"正在导出，参数: {params}")
    headers = {"Authorization": load_token()}
    r = requests.get(f"{BASE}/api/mytAccount/download", headers=headers, params=params, timeout=120)
    if r.status_code == 200:
        filename = args.output or f"tkv6_accounts_{args.tag or 'all'}.xlsx"
        Path(filename).write_bytes(r.content)
        print(f"已保存: {filename} ({len(r.content)} bytes)")
    else:
        print(f"导出失败: {r.status_code}", file=sys.stderr)
        print(r.text[:500])


# ---------- task commands ----------

STATUS_LABEL = {
    -2: "强制结束",
    -3: "超时",
    -1: "异常",
    0: "已完成",
    1: "未启动",
    2: "已下发",
}


def cmd_task_list(args):
    params = {
        "sort": args.sort or "createTime,desc",
        "page": args.page,
        "size": args.limit,
    }
    if args.main:
        params["main"] = "true"
    if args.task_id:
        params["id"] = args.task_id
    if args.name:
        params["name"] = args.name
    if args.script:
        params["scriptName"] = args.script
    if args.device_id:
        params["deviceId"] = args.device_id
    if args.status is not None:
        params["status"] = args.status

    status, data = api("GET", "/api/mytTask", params=params)
    if status != 200:
        print(f"请求失败: {status}", file=sys.stderr)
        print_json(data)
        sys.exit(1)

    rows = data.get("content", [])
    total = data.get("totalElements", len(rows))
    print(f"# 共 {total} 条，当前 {len(rows)} 条")
    for row in rows:
        dev = row.get("mytDevice") or {}
        progress = 0
        total_exec = row.get("executeTotal") or 0
        if total_exec:
            progress = int((row.get("executeCount") or 0) / total_exec * 100)
        print_json({
            "id": row.get("id"),
            "name": row.get("name"),
            "scriptName": row.get("scriptName"),
            "scriptCode": row.get("scriptCode"),
            "device": f"{dev.get('ip', '-')} ({dev.get('name', '-')})",
            "deviceSeq": row.get("deviceSeq"),
            "status": row.get("status"),
            "statusLabel": STATUS_LABEL.get(row.get("status")),
            "progress": f"{progress}%",
            "executeCount": row.get("executeCount"),
            "executeTotal": row.get("executeTotal"),
            "main": row.get("main"),
            "hasChild": row.get("hasChild"),
            "planTime": row.get("planTime"),
            "createTime": row.get("createTime"),
        })


def cmd_task_detail(args):
    params = {"id": args.task_id, "page": 0, "size": 1, "sort": "createTime,desc"}
    status, data = api("GET", "/api/mytTask", params=params)
    if status != 200:
        print(f"请求失败: {status}", file=sys.stderr)
        print_json(data)
        sys.exit(1)
    rows = data.get("content", [])
    if not rows:
        print("任务不存在", file=sys.stderr)
        sys.exit(1)
    row = rows[0]
    # 尝试把 params 字符串反序列化方便阅读
    try:
        row["paramsObj"] = json.loads(row.get("params") or "{}")
    except Exception:
        row["paramsObj"] = row.get("params")
    print_json(row)


def cmd_task_scripts(args):
    scripts = fetch_scripts()
    print(f"# 共 {len(scripts)} 个主任务脚本")
    for s in scripts:
        print_json({
            "id": s.get("id"),
            "code": s.get("name"),
            "title": s.get("title"),
            "tag": s.get("tag"),
            "desc": s.get("desc"),
            "paramsCount": len(json.loads(s.get("params") or "[]")),
        })


def cmd_task_sub_scripts(args):
    scripts = fetch_sub_scripts()
    print(f"# 共 {len(scripts)} 个子任务脚本")
    for s in scripts:
        print_json({
            "id": s.get("id"),
            "code": s.get("name"),
            "title": s.get("title"),
            "tag": s.get("tag"),
            "paramsCount": len(json.loads(s.get("params") or "[]")),
        })


def _split_options(default_str):
    """select/dropdown 的选项默认用 || 分隔。"""
    if not default_str:
        return []
    return [opt.strip() for opt in str(default_str).split("||")]


def _format_option(opt):
    """选项格式常见为 'label,value' 或 'label----value'，返回 {label, value}。"""
    for sep in (",", "----"):
        if sep in opt:
            parts = opt.split(sep, 1)
            return {"label": parts[0].strip(), "value": parts[1].strip()}
    return {"label": opt, "value": opt}


def cmd_task_params(args):
    scripts = fetch_scripts()
    script = find_script(scripts, args.script)
    if not script:
        print(f"找不到主任务脚本: {args.script}", file=sys.stderr)
        sys.exit(1)

    param_defs = json.loads(script.get("params") or "[]")
    print(f"# 脚本 {script['title']} (id={script['id']}, code={script['name']}) 参数:")
    for p in param_defs:
        info = {
            "field": p.get("field"),
            "name": p.get("name"),
            "type": p.get("type"),
            "required": p.get("require"),
            "default": p.get("default"),
            "desc": p.get("desc"),
            "group": p.get("group"),
            "enable": p.get("enable"),
        }
        if p.get("type") in ("select", "dropdown"):
            info["options"] = [_format_option(o) for o in _split_options(p.get("default"))]
        print_json(info)


def cmd_task_running(args):
    devices = fetch_devices()
    if args.device_id:
        devices = [d for d in devices if d["id"] == args.device_id]
    if not devices:
        print("没有可用设备", file=sys.stderr)
        sys.exit(1)

    max_concurrency = 4
    results = []
    # 简单并发控制
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=max_concurrency) as ex:
        futures = {ex.submit(api, "GET", f"/api/mytBroker/getRunningTask?id={d['id']}"): d for d in devices}
        for fut in futures:
            d = futures[fut]
            try:
                st, data = fut.result()
                if st == 200 and isinstance(data, list):
                    for t in data:
                        t["_device"] = f"{d.get('ip')} ({d.get('name')})"
                    results.extend(data)
                else:
                    print(f"设备 {d['id']} 查询失败: {st} {data}", file=sys.stderr)
            except Exception as e:
                print(f"设备 {d['id']} 查询异常: {e}", file=sys.stderr)

    print(f"# 共 {len(results)} 个运行中任务")
    for t in results:
        print_json({
            "id": t.get("id"),
            "name": t.get("name"),
            "scriptName": t.get("scriptName"),
            "device": t.get("_device"),
            "deviceSeq": t.get("deviceSeq"),
            "status": t.get("status"),
            "executeCount": t.get("executeCount"),
            "executeTotal": t.get("executeTotal"),
        })


def _fetch_task_row(task_id):
    status, data = api("GET", "/api/mytTask", params={"id": task_id, "page": 0, "size": 1, "sort": "createTime,desc"})
    if status != 200:
        raise RuntimeError(f"查询任务失败: {status} {data}")
    rows = data.get("content", [])
    if not rows:
        raise RuntimeError("任务不存在")
    return rows[0]


def cmd_task_enable(args):
    row = _fetch_task_row(args.task_id)
    row["enable"] = True
    status, data = api("PUT", "/api/mytTask", json=row)
    print_json({"status": status, "data": data})


def cmd_task_disable(args):
    row = _fetch_task_row(args.task_id)
    row["enable"] = False
    status, data = api("PUT", "/api/mytTask", json=row)
    print_json({"status": status, "data": data})


def cmd_task_copy(args):
    """复制一个已有任务（重置 id/executeCount/executeTotal，保留设备/机位/参数）。"""
    row = _fetch_task_row(args.task_id)
    # 清除创建相关字段
    row.pop("id", None)
    row.pop("createTime", None)
    row.pop("updateTime", None)
    row["executeCount"] = 0
    row["executeTotal"] = 1
    row["status"] = 1
    row["enable"] = True
    row["main"] = True
    row["pid"] = None
    row["template"] = row.get("template") or False
    row["name"] = args.name or f"{row['name']}-copy"
    # 解析/保留 taskGroupParam
    try:
        tgp = json.loads(row.get("taskGroupParam") or "{}")
    except Exception:
        tgp = {}
    device_ids = tgp.get("deviceIds") or [row["mytDevice"]["id"]] if row.get("mytDevice") else []
    device_seqs = tgp.get("deviceSeqs") or [row.get("deviceSeq")] if row.get("deviceSeq") else [1]
    if not device_ids:
        print("无法复制：原任务没有设备信息", file=sys.stderr)
        sys.exit(1)

    # 用 /api/mytTask/batch 提交
    payload = {
        **row,
        "deviceIds": None,
        "deviceArray": None,
        "deviceSeqs": None,
        "mytProxies": None,
        "taskGroupParam": json.dumps({"deviceIds": device_ids, "deviceSeqs": device_seqs}, separators=(",", ":")),
    }
    # proxyIdList / mytProxy 保留原值
    status, data = api("POST", "/api/mytTask/batch", json=[payload])
    if status in (200, 201):
        print_json({"status": status, "data": data})
    else:
        print(f"复制失败: {status}", file=sys.stderr)
        print_json(data)
        sys.exit(1)


def cmd_task_log(args):
    """获取任务调试日志下载链接并打印/保存。"""
    file_path = f"log/debug_{args.task_id}.log"
    status, data = api("GET", "/api/mytBroker/uploadFile", params={"id": args.task_id, "filePath": file_path})
    if status != 200:
        print(f"获取日志链接失败: {status} {data}", file=sys.stderr)
        sys.exit(1)
    download_url = None
    if isinstance(data, dict):
        download_url = data.get("download_url")
        if not download_url and isinstance(data.get("data"), dict):
            download_url = data["data"].get("download_url")
    if not download_url:
        print(f"未返回下载链接: {data}", file=sys.stderr)
        sys.exit(1)
    r = requests.get(download_url, timeout=60)
    if r.status_code == 200:
        if args.output:
            Path(args.output).write_bytes(r.content)
            print(f"日志已保存: {args.output} ({len(r.content)} bytes)")
        else:
            print(r.text[:5000])
    else:
        print(f"下载日志失败: {r.status_code}", file=sys.stderr)
        print(r.text[:500])


def cmd_task_children(args):
    status, data = api("GET", f"/api/mytTask?size=100&pid={args.task_id}")
    if status != 200:
        print(f"请求失败: {status}", file=sys.stderr)
        print_json(data)
        sys.exit(1)
    rows = data.get("content", [])
    print(f"# 共 {len(rows)} 个子任务")
    for row in rows:
        print_json({
            "id": row.get("id"),
            "name": row.get("name"),
            "scriptName": row.get("scriptName"),
            "deviceSeq": row.get("deviceSeq"),
            "status": row.get("status"),
            "statusLabel": STATUS_LABEL.get(row.get("status")),
            "executeCount": row.get("executeCount"),
            "executeTotal": row.get("executeTotal"),
            "createTime": row.get("createTime"),
        })


def cmd_task_kill(args):
    status, data = api("GET", f"/api/mytBroker/killTask?id={args.task_id}")
    print_json({"status": status, "data": data})


def cmd_task_delete(args):
    ids = [int(x) for x in re.split(r"[,\s]+", args.ids) if x]
    status, data = api("DELETE", "/api/mytTask?delSubTask=true", json=ids)
    print_json({"status": status, "data": data})


def cmd_task_create(args):
    scripts = fetch_scripts()
    script = find_script(scripts, args.script)
    if not script:
        print(f"找不到脚本: {args.script}", file=sys.stderr)
        print("可用脚本：")
        for s in scripts:
            print(f"  {s['id']:>4}  {s.get('code') or '-':<30}  {s['title']}")
        sys.exit(1)

    devices = fetch_devices()
    selected_devices = [d for d in devices if d["id"] in args.device_id]
    if not selected_devices:
        print("找不到指定设备", file=sys.stderr)
        print("可用设备：")
        for d in devices:
            print(f"  {d['id']:>6}  {d.get('ip'):<16}  {d.get('name')}")
        sys.exit(1)

    proxies = []
    if args.proxy_id:
        all_proxies = fetch_proxies()
        proxies = [p for p in all_proxies if p["id"] in args.proxy_id]
        missing = set(args.proxy_id) - {p["id"] for p in proxies}
        if missing:
            print(f"找不到代理 ID: {missing}", file=sys.stderr)
            sys.exit(1)

    # 解析脚本默认参数
    param_defs = json.loads(script.get("params") or "[]")
    params = {}
    for pdef in param_defs:
        field = pdef.get("field")
        default = pdef.get("default")
        if default != "" and default is not None:
            params[field] = coerce_param(pdef, default)
        # 子任务默认空数组
        if pdef.get("type") == "sub_task":
            params[field] = params.get(field) or []

    # 用 --param / --param-json 覆盖
    overrides = parse_kv_list(args.param)
    overrides.update(parse_kv_list(args.param_json))
    field_map = {p["field"]: p for p in param_defs}
    for k, v in overrides.items():
        pdef = field_map.get(k, {})
        params[k] = coerce_param(pdef, v)

    # 如果没有传 name，自动生成
    name = args.name

    # proxy_allot 来自 params 或默认 1
    proxy_allot = params.get("proxy_allot", 1)
    if args.proxy_allot is not None:
        proxy_allot = int(args.proxy_allot)

    seqs = args.seq if args.seq else [1]
    payloads = build_task_payloads(
        script_id=script["id"],
        script_name=script["title"],
        script_code=script["name"],
        devices=selected_devices,
        seqs=seqs,
        proxies=proxies,
        proxy_allot=proxy_allot,
        params=params,
        name=name,
        remark=args.remark,
        plan_time=args.plan_time,
    )

    if args.dry_run:
        print_json({"wouldCreate": len(payloads), "payloads": payloads})
        return
    print(f"将创建 {len(payloads)} 个任务")

    status, data = api("POST", "/api/mytTask/batch", json=payloads)
    if status in (200, 201):
        print_json({"status": status, "created": len(payloads), "data": data})
    else:
        print(f"创建失败: {status}", file=sys.stderr)
        print_json(data)
        sys.exit(1)


def cmd_task_watch(args):
    """轮询任务状态直到完成/异常/超时。"""
    params = {"id": args.task_id, "page": 0, "size": 1, "sort": "createTime,desc"}
    end_status = {0, -1, -2, -3}
    start = time.time()
    while True:
        status, data = api("GET", "/api/mytTask", params=params)
        if status != 200:
            print(f"查询失败: {status} {data}", file=sys.stderr)
            sys.exit(1)
        rows = data.get("content", [])
        if not rows:
            print("任务不存在", file=sys.stderr)
            sys.exit(1)
        row = rows[0]
        st = row.get("status")
        total = row.get("executeTotal") or 0
        progress = int((row.get("executeCount") or 0) / total * 100) if total else 0
        now = datetime.now().strftime("%H:%M:%S")
        print(f"[{now}] 任务 {args.task_id} 状态 {st}({STATUS_LABEL.get(st)}) 进度 {progress}% ({row.get('executeCount')}/{total})")
        if st in end_status:
            print("任务已结束")
            break
        if args.timeout and (time.time() - start) > args.timeout:
            print("轮询超时")
            sys.exit(2)
        time.sleep(args.interval)


# ---------- main ----------

# 旧版兼容：顶层 list/stats/tags/delete/favorite/export 映射到 account 子命令
_LEGACY_ACCOUNT_CMDS = {"list", "stats", "tags", "delete", "favorite", "export"}


def main():
    argv = sys.argv[:]
    if len(argv) > 1 and argv[1] in _LEGACY_ACCOUNT_CMDS:
        argv.insert(1, "account")

    p = argparse.ArgumentParser(description="TKV6 运营中心 CLI")
    p.add_argument("--cookie", help="cookie JSON 文件路径", default=None)
    sub = p.add_subparsers(dest="cmd", required=True)

    login = sub.add_parser("login", help="登录（需要 RSA 加密 + 验证码）")
    login.add_argument("--username", required=True)
    login.add_argument("--password", required=True)

    sub.add_parser("whoami", help="当前登录用户信息")

    # account
    acc = sub.add_parser("account", help="账号管理")
    acc_sub = acc.add_subparsers(dest="subcmd", required=True)

    lst = acc_sub.add_parser("list", help="列出账号")
    lst.add_argument("--tag", default=None, help="按标签分组筛选")
    lst.add_argument("--search", "--blurry", dest="search", default=None, help="模糊搜索")
    lst.add_argument("--page", type=int, default=0, help="页码，从 0 开始")
    lst.add_argument("--limit", type=int, default=20, help="每页数量")
    lst.add_argument("--sort", default="id,desc", help="排序，如 createTime,desc")

    acc_sub.add_parser("stats", help="账号统计")
    acc_sub.add_parser("tags", help="标签分组")

    d = acc_sub.add_parser("delete", help="删除账号（传 id 数组）")
    d.add_argument("--ids", required=True, help="逗号分隔的账号 ID")

    fav = acc_sub.add_parser("favorite", help="收藏/取消收藏")
    fav.add_argument("--id", type=int, required=True)
    fav.add_argument("--favorite", type=lambda x: x.lower() == "true", default=True)

    exp = acc_sub.add_parser("export", help="导出 Excel")
    exp.add_argument("--tag", default=None)
    exp.add_argument("--output", "-o", default=None)

    # task
    tsk = sub.add_parser("task", help="任务管理")
    tsk_sub = tsk.add_subparsers(dest="subcmd", required=True)

    tl = tsk_sub.add_parser("list", help="列出任务")
    tl.add_argument("--task-id", type=int, default=None, help="按任务 ID 精确查询")
    tl.add_argument("--name", default=None, help="按任务名模糊查询")
    tl.add_argument("--script", default=None, help="按功能/脚本名模糊查询")
    tl.add_argument("--device-id", type=int, default=None, help="按设备 ID 筛选")
    tl.add_argument("--status", type=int, default=None, choices=[-2, -3, -1, 0, 1, 2], help="任务状态")
    tl.add_argument("--main", action="store_true", help="只查主任务")
    tl.add_argument("--page", type=int, default=0)
    tl.add_argument("--limit", type=int, default=20)
    tl.add_argument("--sort", default="createTime,desc")

    tsk_sub.add_parser("scripts", help="列出可创建的主任务脚本")
    tsk_sub.add_parser("sub-scripts", help="列出可创建的子任务脚本")

    tp = tsk_sub.add_parser("params", help="查看某脚本的参数定义")
    tp.add_argument("script", help="脚本 id / code / title")

    tsk_sub.add_parser("running", help="查询设备上正在执行的任务").add_argument("--device-id", type=int, default=None)

    tk = tsk_sub.add_parser("kill", help="终止运行中的任务")
    tk.add_argument("task_id", type=int)

    td = tsk_sub.add_parser("detail", help="查看任务详情")
    td.add_argument("task_id", type=int)

    tdel = tsk_sub.add_parser("delete", help="删除任务（会同步删除子任务）")
    tdel.add_argument("--ids", required=True, help="逗号分隔的任务 ID")

    ten = tsk_sub.add_parser("enable", help="启用任务")
    ten.add_argument("task_id", type=int)

    tdis = tsk_sub.add_parser("disable", help="禁用任务")
    tdis.add_argument("task_id", type=int)

    tcopy = tsk_sub.add_parser("copy", help="复制任务（基于已有任务创建新任务）")
    tcopy.add_argument("task_id", type=int)
    tcopy.add_argument("--name", default=None, help="新任务名")

    tlog = tsk_sub.add_parser("log", help="下载任务调试日志")
    tlog.add_argument("task_id", type=int)
    tlog.add_argument("--output", "-o", default=None, help="保存路径，默认打印到 stdout")

    tchild = tsk_sub.add_parser("children", help="查看子任务")
    tchild.add_argument("task_id", type=int)

    tc = tsk_sub.add_parser("create", help="创建任务（默认走 /api/mytTask/batch）")
    tc.add_argument("--script", required=True, help="脚本 id / code / title，例如 174 或 StartAccount")
    tc.add_argument("--device-id", type=int, required=True, action="append", help="设备 ID，可多次指定")
    tc.add_argument("--seq", type=int, action="append", default=None, help="机位序号 1-12，可多次指定，默认 [1]")
    tc.add_argument("--proxy-id", type=int, action="append", help="代理 ID，可多次指定")
    tc.add_argument("--proxy-allot", type=int, choices=[1, 2], help="代理分配方式：1 按设备轮询，2 按任务分配 proxyIdList")
    tc.add_argument("--param", action="append", help="脚本参数，格式 key=value，例如 tag=手搓。JSON 数组/对象需用引号包裹")
    tc.add_argument("--param-json", dest="param_json", action="append", help="显式 JSON 参数，格式 key=JSON，例如 sub_task=[{...}]")
    tc.add_argument("--name", default=None, help="任务名，默认自动生成")
    tc.add_argument("--remark", default=None, help="备注")
    tc.add_argument("--plan-time", default=None, help="计划执行时间，默认当前时间")
    tc.add_argument("--dry-run", action="store_true", help="只打印将要提交的 payload，不真正创建")

    tw = tsk_sub.add_parser("watch", help="轮询任务状态")
    tw.add_argument("task_id", type=int)
    tw.add_argument("--interval", type=int, default=5, help="轮询间隔秒")
    tw.add_argument("--timeout", type=int, default=None, help="最大轮询秒数")

    args = p.parse_args(argv[1:])
    if args.cookie:
        os.environ["TKV6_COOKIE"] = args.cookie

    if args.cmd == "login":
        cmd_login(args)
    elif args.cmd == "whoami":
        cmd_whoami(args)
    elif args.cmd == "account":
        func = globals().get(f"cmd_account_{args.subcmd}")
        if not func:
            print(f"未知 account 子命令: {args.subcmd}", file=sys.stderr)
            sys.exit(1)
        func(args)
    elif args.cmd == "task":
        func = globals().get(f"cmd_task_{args.subcmd}")
        if not func:
            print(f"未知 task 子命令: {args.subcmd}", file=sys.stderr)
            sys.exit(1)
        func(args)
    else:
        # 旧版兼容：顶层 list/stats/tags/delete/favorite/export
        old_func = globals().get(f"cmd_{args.cmd}")
        if old_func:
            old_func(args)
        else:
            print(f"未知命令: {args.cmd}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
