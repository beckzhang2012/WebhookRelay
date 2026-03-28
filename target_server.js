const http = require('http');

const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            console.log(`\n[${new Date().toISOString()}] 收到 Webhook:`);
            console.log('Headers:', req.headers);
            console.log('Body:', body);
            
            // 随机返回成功或失败，用于测试重试机制
            const randomSuccess = Math.random() > 0.3; // 70% 成功率
            
            if (randomSuccess) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'success', message: 'Webhook 接收成功' }));
                console.log('响应: 200 OK');
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '服务器内部错误' }));
                console.log('响应: 500 错误（用于测试重试）');
            }
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const PORT = 8080;
server.listen(PORT, () => {
    console.log(`🎯 Target 服务器运行在 http://localhost:${PORT}`);
    console.log('   这个服务器用于接收 Webhook 转发');
    console.log('   它会随机返回成功或失败来测试重试机制');
    console.log('   按 Ctrl+C 停止服务器');
});