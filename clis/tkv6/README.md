# tkv6.com 运营中心命令行管理研究

覆盖 `/myt/mytAccount`（账号管理）与 `/myt/mytTask`（任务列表）。

## 站点概述

- **域名**: https://www.tkv6.com
- **页面**: /myt/mytAccount（账号管理后台）、/myt/mytTask（任务列表）
- **前端框架**: Vue 2 + Element UI（eladmin_web）
- **后端**: Spring Boot（eladmin）
- **认证方式**: 用户名/手机号 + 密码 + 图形验证码，密码使用 RSA 公钥加密
- **API 鉴权**: JWT Bearer Token（`Authorization` Header）
- **性质**: 淘客/社交媒体账号管理平台（管理 TikTok/抖音/淘宝等多平台账号资产）

## 认证流程

1. `GET /auth/code` → 获取验证码 `{uuid, img}`
2. `POST /auth/login` → 登录，获取 JWT
   - 请求体: `{username, password(RSA加密), code, uuid, rememberMe}`
3. 后续请求携带 `Authorization: Bearer <token>`
4. `GET /auth/info` → 获取当前用户信息

## 核心 API（mytAccount 账号管理）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/mytAccount` | 分页查询账号列表 |
| POST | `/api/mytAccount` | 新增账号 |
| PUT | `/api/mytAccount` | 修改账号 |
| DELETE | `/api/mytAccount` | 删除账号（data 传 id 数组）|
| GET | `/api/mytAccount/tagBucket/list` | 标签分组列表 |
| POST | `/api/mytAccount/addTagBucket` | 为筛选结果添加标签分组 |
| POST | `/api/mytAccount/removeTagBucket` | 为筛选结果移除标签分组 |
| POST | `/api/mytAccount/addTagById` | 为选中账号添加标签 |
| POST | `/api/mytAccount/removeTagById` | 为选中账号移除标签 |
| POST | `/api/mytAccount/editTag?new_tag=` | 批量修改标签 |
| POST | `/api/mytAccount/moveTag?new_tag=` | 批量移动标签 |
| POST | `/api/mytAccount/editProxy?proxy_id=` | 批量修改代理 |
| POST | `/api/mytAccount/assignProxy` | 分配代理 |
| POST | `/api/mytAccount/favorite?id=&favorite=` | 收藏/取消收藏 |
| GET | `/api/mytAccount/deleteAccount?tag=` | 删除某分组下全部账号 |
| GET | `/api/mytAccount/deleteBannedAccount?tag=` | 删除某分组下全部封号账号 |
| POST | `/api/mytAccount/resetAccountStatus?tag=` | 重置某分组账号状态 |
| GET | `/api/mytAccount/getStatistics` | 获取账号统计 |
| GET | `/api/mytAccount/getProxyStatistics` | 获取代理统计 |
| GET | `/api/mytAccount/getTransferStatistics` | 获取转移码统计 |
| GET | `/api/mytAccount/checkTransferKeyExists` | 检查转移码是否存在 |
| POST | `/api/mytAccount/mergeTransferKeys` | 合并转移码 |
| POST | `/api/mytAccount/splitTransferKey` | 拆分转移码 |
| POST | `/api/mytAccount/revokeTransferKey?transferKey=` | 撤销转移码 |
| GET | `/api/mytAccount/download` | 导出全部数据（Excel）|
| GET | `/api/mytAccount/downloadHT` | 导出 HT 格式 |
| POST | `/api/mytAccount/download_selected` | 导出选中数据 |
| GET | `/api/mytAccount/recycle` | 回收站列表 |
| POST | `/api/mytAccount/recycle/restore` | 从回收站恢复 |
| POST | `/api/mytAccount/clearAllTag` | 清空所有标签 |

## 核心 API（mytTask 任务管理）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/mytTask` | 任务列表分页查询（`main=true` 只查主任务）|
| POST | `/api/mytTask/batch` | 批量新增任务（前端新增任务实际走这里）|
| POST | `/api/mytTask` | 单条新增（CRUD 默认）|
| PUT | `/api/mytTask` | 修改任务 |
| DELETE | `/api/mytTask?delSubTask=true` | 删除任务（data 传 id 数组，同步删子任务）|
| GET | `/api/mytScript/getTaskMytScript` | 可创建的主任务脚本列表 |
| GET | `/api/mytScript/getSubTaskScripts` | 可创建的子任务脚本列表 |
| GET | `/api/mytDevice/getTaskMytDevice` | 任务可用设备列表 |
| GET | `/api/mytProxy/getTaskMytProxy` | 任务可用代理列表 |
| GET | `/api/mytBroker/getRunningTask?id=<deviceId>` | 查询某设备上正在执行的任务 |
| GET | `/api/mytBroker/killTask?id=<taskId>` | 终止运行中的任务 |
| GET | `/api/backgroundTask/{id}/progress` | 后台任务中心进度轮询（任务列表本身不自动轮询）|

### 任务状态字典

```
-2  强制结束
-3  超时
-1  异常
 0  已完成
 1  未启动
 2  已下发
```

### 新增任务链路（前端实现）

1. 打开 `TaskForm` 弹窗，调用 `loadData()` 拉取设备、脚本、代理、注册资源、素材资源。
2. 选择脚本后，根据脚本 `params` 字段渲染参数表单（`params_obj`）。
3. 用户填写参数后点击确认，`format_params()` 把参数整理成 `this.form.params` 对象。
4. `save_continue_batch()` 按设备 × 机位生成任务数组：
   - 第一个任务 `main=true`，`taskGroupParam` 存 JSON 字符串 `{"deviceIds":[...],"deviceSeqs":[...]}`。
   - 其余任务 `main=false`，`taskGroupParam=null`。
   - `proxy_allot=2` 时把代理列表放进 `proxyIdList`；否则按轮询放进 `mytProxy`。
5. `POST /api/mytTask/batch` 创建任务，返回 `201` + 文本消息。

### 运行任务轮询

- 任务列表页本身 **没有** `setInterval` 自动轮询；刷新靠手动或 `crud.toQuery()`。
- “正在执行”面板：`GET /api/mytBroker/getRunningTask?id=<deviceId>`，最多并发 4 个设备。
- 后台任务中心：`GET /api/backgroundTask/{id}/progress`，每 3 秒自动轮询。

## 账号字段（从 CRUD 配置推断）

- `id`, `deviceIp`, `deviceName`, `deviceSeq`, `backType`, `backKey`, `backCloud`
- `uid`, `username`, `password`, `totp`, `follower`, `sessionKey`, `extra`
- `tagBucket`, `tagBucketId`, `enable`, `status`, `remark`, `createTime`, `updateTime`

## 已验证的可用命令

已通过用户提供的 cookie 验证 token 可用，并测试了以下接口：

```bash
# 方式一：用账号密码登录（会保存验证码图片到 ~/.tkv6_captcha.png，手动输入结果）
python3 clis/tkv6/tkv6.py login --username p2602111602 --password ny584520

# 方式二：从 cookie JSON 读取 token（推荐，避免验证码）
export TKV6_COOKIE="/Users/x/Downloads/cookies (9).json"

# 查看当前登录用户信息
python3 clis/tkv6/tkv6.py whoami

# ---------- 账号管理 ----------
# 查看账号统计（按 tag 汇总）
python3 clis/tkv6/tkv6.py stats

# 列出全部账号
python3 clis/tkv6/tkv6.py list --limit 10

# 按 tag 筛选（如：已封号）
python3 clis/tkv6/tkv6.py list --tag 已封号 --limit 10

# 模糊搜索用户名/UID
python3 clis/tkv6/tkv6.py list --search svtzlnnwgsd

# 收藏/取消收藏
python3 clis/tkv6/tkv6.py favorite --id 123 --favorite true

# 导出 Excel
python3 clis/tkv6/tkv6.py export --tag 已封号 -o banned.xlsx

# ---------- 任务管理 ----------
# 列出任务（只查主任务）
python3 clis/tkv6/tkv6.py task list --main --limit 10

# 按任务名/状态筛选
python3 clis/tkv6/tkv6.py task list --name 手搓 --status 0

# 查看任务详情
python3 clis/tkv6/tkv6.py task detail 7065232

# 查看设备上正在执行的任务
python3 clis/tkv6/tkv6.py task running
python3 clis/tkv6/tkv6.py task running --device-id 405

# 终止任务
python3 clis/tkv6/tkv6.py task kill 7065232

# 删除任务（同步删除子任务）
python3 clis/tkv6/tkv6.py task delete --ids 7065232,7065233

# 启用/禁用任务
python3 clis/tkv6/tkv6.py task enable 7065232
python3 clis/tkv6/tkv6.py task disable 7065232

# 复制任务
python3 clis/tkv6/tkv6.py task copy 7065232 --name "复制任务"

# 查看子任务
python3 clis/tkv6/tkv6.py task children 7065232

# 下载任务调试日志
python3 clis/tkv6/tkv6.py task log 7065232
python3 clis/tkv6/tkv6.py task log 7065232 -o /tmp/task.log

# 查看可用脚本及其参数
python3 clis/tkv6/tkv6.py task scripts
python3 clis/tkv6/tkv6.py task sub-scripts
python3 clis/tkv6/tkv6.py task params 174

# 创建任务（dry-run 预览 payload）
python3 clis/tkv6/tkv6.py task create \
  --script 174 \
  --device-id 405 \
  --seq 1 \
  --param back_type=2 \
  --param use_backup_proxy=true \
  --param tag=手搓 \
  --param times=1 \
  --name "CLI测试任务" \
  --dry-run

# 真正创建任务（简单参数）
python3 clis/tkv6/tkv6.py task create \
  --script 174 \
  --device-id 405 \
  --seq 1 \
  --param back_type=2 \
  --param use_backup_proxy=true \
  --param tag=手搓 \
  --param times=1 \
  --name "CLI测试任务"

# 创建带复杂 JSON 参数/子任务（用 --param-json 更直观）
python3 clis/tkv6/tkv6.py task create \
  --script 174 \
  --device-id 405 \
  --seq 1 \
  --param back_type=2 \
  --param use_backup_proxy=true \
  --param tag=手搓 \
  --param times=1 \
  --param-json 'sub_task=[{"name":"养号","scriptId":233,"scriptName":"自动养号","scriptCode":"TkNewTrainAccountVertical","params":{},"order":1}]' \
  --name "CLI测试任务"

# 轮询任务状态（直到完成/异常/超时）
python3 clis/tkv6/tkv6.py task watch 7065232 --interval 5 --timeout 300
```

## 实现思路

1. **快速方案**: `clis/tkv6/tkv6.py` 从 cookie JSON 读取 `ELADMIN-TOEKN`，直接调用 REST API。账号与任务命令统一在 `account` / `task` 子命令下，同时保留旧版顶层命令兼容。
2. **opencli 适配器方案**: `clis/tkv6/account.js` 是 TypeScript 适配器骨架，封装 `login`、`list`、`stats`、`delete` 等命令，通过 `opencli tkv6 <cmd>` 调用。

## 风险与限制

- 需要有效的账号密码
- 部分操作（删除、转移、查看密码）触发短信二次验证
- 操作影响真实账号资产，务必先测试
