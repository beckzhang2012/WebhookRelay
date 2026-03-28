# Webhook Relay 系统

一个完整的 Webhook 中继转发系统，基于 Node.js + Express + SQLite 构建。

## 功能特性

- ✅ Webhook 接收端点：`POST /ingest/:source`
- ✅ HMAC-SHA256 签名验证
- ✅ 幂等处理：同一 source + eventId 只处理一次
- ✅ 自动转发到配置的 targetUrl
- ✅ 失败自动重试（指数退避，最多 5 次）
- ✅ 死信队列：超过重试次数后进入死信，支持手动重放
- ✅ 管理台界面：`/admin`，支持 Source 配置管理
- ✅ REST API：完整的 CRUD 接口
- ✅ 统一错误处理

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

服务默认运行在 `http://localhost:3001`

### 3. 访问管理台

打开浏览器访问：`http://localhost:3001/admin`

## 数据库位置

SQLite 数据库文件位于：`data/relay.db`

## API 端点

### 接收 Webhook

```
POST /ingest/:source
```

Headers:
- `X-Signature`: HMAC-SHA256 签名，格式为 `sha256=<hash>`
- `X-Event-ID`: 可选，用于幂等性

Body: JSON 格式的 webhook 数据

### 管理 API

- `GET /api/sources` - 获取所有 Source 配置
- `POST /api/sources` - 创建新的 Source
- `PUT /api/sources/:id` - 更新 Source
- `DELETE /api/sources/:id` - 删除 Source
- `GET /api/deliveries` - 获取投递记录（最近 100 条）
- `GET /api/deadletters` - 获取死信队列
- `POST /api/deadletters/:id/replay` - 重放死信

## 本地验收测试

### 准备工作：启动一个测试目标服务器

在另一个终端运行以下命令，启动一个简单的测试服务器来接收 webhook：

```bash
node -e "
const http = require('http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    console.log('=== Received Webhook ===');
    console.log('Method:', req.method);
    console.log('URL:', req.url);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', body);
    console.log('========================\n');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true }));
  });
});
server.listen(4000, () => console.log('Test server running on http://localhost:4000/webhook'));
"
```

### 测试步骤

#### 1. 创建 Source 配置

访问管理台 `http://localhost:3001/admin`，点击 "添加 Source"：

- Source Key: `test`
- Target URL: `http://localhost:4000/webhook`
- Secret: `my-secret-key`

或者使用 API：

```bash
curl -X POST http://localhost:3001/api/sources \
  -H "Content-Type: application/json" \
  -d '{
    "sourceKey": "test",
    "targetUrl": "http://localhost:4000/webhook",
    "secret": "my-secret-key"
  }'
```

#### 2. 发送测试 Webhook

使用以下 Node.js 脚本发送一个带正确签名的 webhook：

```javascript
const crypto = require('crypto');
const axios = require('axios');

const secret = 'my-secret-key';
const payload = {
  event: 'user.created',
  data: { id: 123, name: 'Test User', email: 'test@example.com' }
};

const hmac = crypto.createHmac('sha256', secret);
const signature = 'sha256=' + hmac.update(JSON.stringify(payload)).digest('hex');

axios.post('http://localhost:3001/ingest/test', payload, {
  headers: {
    'X-Signature': signature,
    'X-Event-ID': 'test-event-001'
  }
}).then(res => {
  console.log('Response:', res.data);
}).catch(err => {
  console.error('Error:', err.response?.data || err.message);
});
```

或者使用 curl（需要手动计算签名）：

```bash
# 计算签名
PAYLOAD='{"event":"user.created","data":{"id":123}}'
SIGNATURE="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "my-secret-key" | cut -d' ' -f2)"

# 发送请求
curl -X POST http://localhost:3001/ingest/test \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Event-ID: test-event-001" \
  -d "$PAYLOAD"
```

#### 3. 验证结果

- 查看测试服务器终端，应该能看到收到的 webhook
- 访问管理台的 "Deliveries" 标签页，状态应该显示为 "success"

#### 4. 测试幂等性

再次发送相同的 webhook（使用相同的 X-Event-ID），系统应该返回 `Event already processed` 但不会重复转发。

#### 5. 测试失败场景

停止测试服务器，然后再次发送 webhook：

- 系统会重试 5 次（指数退避）
- 5 次失败后会进入死信队列
- 在管理台的 "Dead Letters" 标签页可以看到
- 点击 "重放" 可以再次尝试投递

## 改动文件清单

- `package.json` - 项目配置和依赖
- `src/db.js` - 数据库初始化和操作
- `src/server.js` - Express 服务器主文件
- `src/public/admin.html` - 管理台界面
- `README.md` - 项目文档

## 验收清单

1. ✅ 项目可以通过 `npm install` 正确安装依赖
2. ✅ 服务可以通过 `npm start` 正常启动
3. ✅ 访问 `http://localhost:3001/admin` 可以打开管理台
4. ✅ 可以在管理台添加、编辑、删除 Source 配置
5. ✅ 发送带正确签名的 webhook 到 `/ingest/:source` 返回 202 Accepted
6. ✅ 缺少签名或签名错误时返回正确的错误码（401/403）
7. ✅ webhook 成功转发到配置的 targetUrl
8. ✅ 同一 eventId 重复发送时不会重复处理
9. ✅ 转发失败时会自动重试，最多 5 次
10. ✅ 超过重试次数后会进入死信队列
11. ✅ 死信可以在管理台手动重放
12. ✅ 数据库文件正确保存在 `data/relay.db`
13. ✅ 所有 API 端点返回的数据格式正确
14. ✅ 错误响应格式统一为 `{ error: { code, message } }`

## 技术栈

- Node.js
- Express
- SQL.js (纯 JavaScript SQLite 实现，无需编译)
- Axios
- 原生 HTML/CSS/JavaScript 前端
