# Webhook Relay 系统

一个可靠的 Webhook 转发全栈系统，使用 Node.js + Express + SQLite 构建。

## 功能特性

- ✅ **签名验证**: 使用 HMAC-SHA256 验证 webhook 来源
- ✅ **幂等性处理**: 同一 source+eventId 重复投递只处理一次
- ✅ **自动重试**: 指数退避算法，最多重试 5 次
- ✅ **死信队列**: 超过重试次数的投递进入死信队列，支持重放
- ✅ **管理控制台**: Web 界面管理 source 配置和查看记录
- ✅ **REST API**: 完整的 API 接口供程序调用

## 项目结构

```
webhook-relay/
├── index.js              # 主服务器文件
├── db.js                 # 数据库初始化和连接
├── package.json          # 项目依赖
├── data/
│   └── relay.db          # SQLite 数据库文件（自动创建）
└── public/
    └── admin.html        # 管理控制台页面
```

## 安装与启动

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务器

```bash
node index.js
```

服务器将在 http://localhost:3000 启动

### 3. 访问管理控制台

打开浏览器访问: http://localhost:3000/admin

## 本地验收测试

### 模拟 Target 端点

你可以使用以下方法之一来模拟 target 端点：

#### 方法一：使用 Python 简单 HTTP 服务器

创建一个简单的 Python 服务器来接收 webhook：

```python
# 创建 target_server.py
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

class WebhookHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        data = json.loads(post_data.decode('utf-8'))
        
        print(f"收到 Webhook: {json.dumps(data, indent=2)}")
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))

if __name__ == '__main__':
    server = HTTPServer(('localhost', 8080), WebhookHandler)
    print("Target 服务器运行在 http://localhost:8080")
    server.serve_forever()
```

启动 target 服务器：
```bash
python target_server.py
```

#### 方法二：使用 Node.js 模拟服务器

```javascript
// 创建 target_server.js
const http = require('http');

const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            console.log('收到 Webhook:', body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success' }));
        });
    }
});

server.listen(8080, () => {
    console.log('Target 服务器运行在 http://localhost:8080');
});
```

启动：
```bash
node target_server.js
```

## 验收测试用例

### 1. 基本功能测试
- ✅ 启动服务器，访问 http://localhost:3000/admin 应该显示管理控制台
- ✅ 在管理控制台添加一个新的 Source（sourceKey: test, secret: mysecret, targetUrl: http://localhost:8080）
- ✅ 验证 Source 列表显示新添加的记录

### 2. Webhook 接收测试
使用 curl 发送测试 webhook：

```bash
# 生成签名（需要 Node.js）
node -e "
const crypto = require('crypto');
const secret = 'mysecret';
const payload = JSON.stringify({eventId: 'test123', data: 'hello webhook'});
const hmac = crypto.createHmac('sha256', secret);
const signature = hmac.update(payload).digest('hex');
console.log('Signature:', signature);
"

# 发送 webhook
curl -X POST http://localhost:3000/ingest/test \
  -H "Content-Type: application/json" \
  -H "X-Signature: YOUR_GENERATED_SIGNATURE" \
  -d '{"eventId":"test123","data":"hello webhook"}'
```

### 3. 功能验证清单

1. ✅ **签名验证**: 正确签名返回 200，错误签名返回 401
2. ✅ **幂等性**: 同一 eventId 重复发送，只处理一次
3. ✅ **转发功能**: webhook 成功转发到 target 端点
4. ✅ **重试机制**: target 不可用时自动重试（指数退避）
5. ✅ **死信队列**: 超过 5 次重试后进入死信队列
6. ✅ **管理界面**: 可以添加、编辑、删除 source
7. ✅ **投递记录**: 可以查看最近 50 条投递记录
8. ✅ **死信重放**: 可以从死信队列重新投递
9. ✅ **日志记录**: 服务器控制台显示详细的转发日志
10. ✅ **错误处理**: 统一的错误响应格式 {error: {code, message}}

## 生成测试签名的工具

创建一个简单的签名生成工具：

```javascript
// sign.js
const crypto = require('crypto');

const secret = process.argv[2];
const payload = process.argv[3];

if (!secret || !payload) {
    console.log('使用方法: node sign.js <secret> <payload>');
    console.log('示例: node sign.js mysecret \'{"eventId":"test123","data":"test"}\'');
    process.exit(1);
}

const hmac = crypto.createHmac('sha256', secret);
const signature = hmac.update(payload).digest('hex');

console.log('Payload:', payload);
console.log('Signature:', signature);
console.log('\nCurl 命令:');
console.log(`curl -X POST http://localhost:3000/ingest/test -H "Content-Type: application/json" -H "X-Signature: ${signature}" -d '${payload}'`);
```

使用方法：
```bash
node sign.js mysecret '{"eventId":"test123","data":"hello"}'
```

## API 接口文档

### Source 管理
- `GET /api/sources` - 获取所有 source
- `POST /api/sources` - 创建新 source
- `PUT /api/sources/:id` - 更新 source
- `DELETE /api/sources/:id` - 删除 source

### 投递记录
- `GET /api/deliveries` - 获取最近 50 条投递记录

### 死信队列
- `GET /api/deadletters` - 获取死信队列
- `POST /api/deadletters/:id/replay` - 重新投递死信

### Webhook 接收
- `POST /ingest/:source` - 接收 webhook（需要 X-Signature 头）

## 注意事项

- 数据库文件会自动创建在 `data/relay.db`
- 服务器启动后自动创建数据库表
- 重试间隔: 2秒, 4秒, 8秒, 16秒, 32秒
- 超过 5 次重试后进入死信队列
- 管理界面默认可以公开访问，生产环境请添加认证