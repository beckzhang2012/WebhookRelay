const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const url = require('url');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(bodyParser.json({ verify: (req, res, buf, encoding) => {
  req.rawBody = buf;
}}));
app.use(express.static('public'));

// 统一错误处理中间件
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'Internal Server Error';
  
  res.status(status).json({ error: { code, message } });
});

// 管理台页面
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

// API 接口 - Sources
app.get('/api/sources', (req, res, next) => {
  db.all('SELECT * FROM sources ORDER BY createdAt DESC', (err, rows) => {
    if (err) return next(err);
    res.json(rows);
  });
});

app.post('/api/sources', (req, res, next) => {
  const { sourceKey, secret, targetUrl } = req.body;
  
  if (!sourceKey || !secret || !targetUrl) {
    return res.status(422).json({ 
      error: { code: 'VALIDATION_ERROR', message: 'sourceKey, secret 和 targetUrl 都是必填的' } 
    });
  }

  db.run(
    'INSERT INTO sources (sourceKey, secret, targetUrl) VALUES (?, ?, ?)',
    [sourceKey, secret, targetUrl],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(422).json({ 
            error: { code: 'SOURCE_ALREADY_EXISTS', message: 'sourceKey 已存在' } 
          });
        }
        return next(err);
      }
      
      db.get('SELECT * FROM sources WHERE id = ?', [this.lastID], (err, row) => {
        if (err) return next(err);
        res.status(201).json(row);
      });
    }
  );
});

app.put('/api/sources/:id', (req, res, next) => {
  const { id } = req.params;
  const { sourceKey, secret, targetUrl } = req.body;

  db.run(
    'UPDATE sources SET sourceKey = ?, secret = ?, targetUrl = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
    [sourceKey, secret, targetUrl, id],
    function(err) {
      if (err) return next(err);
      if (this.changes === 0) {
        return res.status(404).json({ 
          error: { code: 'SOURCE_NOT_FOUND', message: 'Source 不存在' } 
        });
      }
      
      db.get('SELECT * FROM sources WHERE id = ?', [id], (err, row) => {
        if (err) return next(err);
        res.json(row);
      });
    }
  );
});

app.delete('/api/sources/:id', (req, res, next) => {
  const { id } = req.params;
  
  db.run('DELETE FROM sources WHERE id = ?', [id], function(err) {
    if (err) return next(err);
    if (this.changes === 0) {
      return res.status(404).json({ 
        error: { code: 'SOURCE_NOT_FOUND', message: 'Source 不存在' } 
      });
    }
    res.json({ success: true });
  });
});

// API 接口 - Deliveries
app.get('/api/deliveries', (req, res, next) => {
  db.all(
    'SELECT * FROM deliveries ORDER BY createdAt DESC LIMIT 50',
    (err, rows) => {
      if (err) return next(err);
      res.json(rows);
    }
  );
});

// API 接口 - Deadletters
app.get('/api/deadletters', (req, res, next) => {
  db.all(
    'SELECT * FROM deadletters ORDER BY createdAt DESC',
    (err, rows) => {
      if (err) return next(err);
      res.json(rows);
    }
  );
});

app.post('/api/deadletters/:id/replay', (req, res, next) => {
  const { id } = req.params;
  
  db.get('SELECT * FROM deadletters WHERE id = ?', [id], (err, deadletter) => {
    if (err) return next(err);
    if (!deadletter) {
      return res.status(404).json({ 
        error: { code: 'DEADLETTER_NOT_FOUND', message: 'Deadletter 不存在' } 
      });
    }

    // 重新投递
    db.run(
      'UPDATE deliveries SET status = ?, attempts = ?, nextAttemptAt = ? WHERE id = ?',
      ['pending', 0, new Date().toISOString(), deadletter.deliveryId],
      (err) => {
        if (err) return next(err);
        
        db.run('DELETE FROM deadletters WHERE id = ?', [id], (err) => {
          if (err) return next(err);
          res.json({ success: true, message: '重新投递成功' });
          
          // 立即触发重试
          processNextDelivery();
        });
      }
    );
  });
});

// 验证 HMAC 签名
function verifySignature(secret, rawBody, signature) {
  const hmac = crypto.createHmac('sha256', secret);
  const digest = hmac.update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// 接收 webhook
app.post('/ingest/:source', (req, res, next) => {
  const { source } = req.params;
  const signature = req.headers['x-signature'];
  const rawBody = req.rawBody;
  const payload = req.body;

  // 验证 source 存在
  db.get('SELECT * FROM sources WHERE sourceKey = ?', [source], (err, sourceConfig) => {
    if (err) return next(err);
    if (!sourceConfig) {
      return res.status(401).json({ 
        error: { code: 'SOURCE_NOT_FOUND', message: 'Source 不存在' } 
      });
    }

    // 验证签名
    if (!signature || !verifySignature(sourceConfig.secret, rawBody, signature)) {
      return res.status(401).json({ 
        error: { code: 'INVALID_SIGNATURE', message: '签名验证失败' } 
      });
    }

    // 验证 eventId
    if (!payload.eventId) {
      return res.status(422).json({ 
        error: { code: 'EVENT_ID_REQUIRED', message: 'payload 中必须包含 eventId' } 
      });
    }

    // 检查幂等性
    db.get(
      'SELECT * FROM deliveries WHERE source = ? AND eventId = ?',
      [source, payload.eventId],
      (err, existingDelivery) => {
        if (err) return next(err);
        
        if (existingDelivery) {
          // 返回已存在的投递结果
          return res.json({ 
            status: 'already_processed',
            deliveryId: existingDelivery.id,
            currentStatus: existingDelivery.status
          });
        }

        // 创建新的投递记录
        const payloadStr = JSON.stringify(payload);
        db.run(
          'INSERT INTO deliveries (source, eventId, payload, nextAttemptAt) VALUES (?, ?, ?, ?)',
          [source, payload.eventId, payloadStr, new Date().toISOString()],
          function(err) {
            if (err) return next(err);
            
            const deliveryId = this.lastID;
            res.json({ status: 'accepted', deliveryId });
            
            // 立即尝试转发
            processDelivery(deliveryId);
          }
        );
      }
    );
  });
});

// 转发请求
async function forwardWebhook(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    const parsedUrl = url.parse(targetUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 5000
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, data });
        } else {
          reject(new Error(`HTTP 状态码: ${res.statusCode}, 响应: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    req.write(payload);
    req.end();
  });
}

// 处理单个投递
async function processDelivery(deliveryId) {
  db.get(
    'SELECT d.*, s.targetUrl FROM deliveries d JOIN sources s ON d.source = s.sourceKey WHERE d.id = ?',
    [deliveryId],
    async (err, delivery) => {
      if (err) {
        console.error('查询投递记录失败:', err);
        return;
      }
      if (!delivery) {
        console.error('投递记录不存在:', deliveryId);
        return;
      }

      const attempts = delivery.attempts + 1;
      
      try {
        await forwardWebhook(delivery.targetUrl, delivery.payload);
        
        // 成功
        db.run(
          'UPDATE deliveries SET status = ?, attempts = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
          ['success', attempts, deliveryId],
          (err) => {
            if (err) console.error('更新投递状态失败:', err);
            console.log(`投递成功: ID=${deliveryId}, 尝试次数=${attempts}`);
          }
        );
      } catch (error) {
        const errorMessage = error.message;
        
        if (attempts >= delivery.maxAttempts) {
          // 超过最大尝试次数，进入 dead-letter
          db.run(
            'UPDATE deliveries SET status = ?, attempts = ?, lastError = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
            ['deadletter', attempts, errorMessage, deliveryId],
            (err) => {
              if (err) console.error('更新投递状态失败:', err);
              
              // 创建 dead-letter 记录
              db.run(
                'INSERT INTO deadletters (deliveryId, source, eventId, payload, lastError) VALUES (?, ?, ?, ?, ?)',
                [deliveryId, delivery.source, delivery.eventId, delivery.payload, errorMessage],
                (err) => {
                  if (err) console.error('创建 dead-letter 失败:', err);
                  console.log(`进入死信队列: ID=${deliveryId}, 错误: ${errorMessage}`);
                }
              );
            }
          );
        } else {
          // 计算下一次重试时间（指数退避）
          const delay = Math.pow(2, attempts) * 1000; // 2^attempts 秒
          const nextAttemptAt = new Date(Date.now() + delay).toISOString();
          
          db.run(
            'UPDATE deliveries SET status = ?, attempts = ?, lastError = ?, nextAttemptAt = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
            ['pending', attempts, errorMessage, nextAttemptAt, deliveryId],
            (err) => {
              if (err) console.error('更新投递状态失败:', err);
              console.log(`重试计划: ID=${deliveryId}, 尝试次数=${attempts}, 下一次: ${nextAttemptAt}`);
              
              // 安排下一次重试
              setTimeout(() => processDelivery(deliveryId), delay);
            }
          );
        }
      }
    }
  );
}

// 处理所有待处理的投递
function processNextDelivery() {
  const now = new Date().toISOString();
  
  db.all(
    'SELECT id FROM deliveries WHERE status = ? AND nextAttemptAt <= ? ORDER BY nextAttemptAt ASC',
    ['pending', now],
    (err, rows) => {
      if (err) {
        console.error('查询待处理投递失败:', err);
        return;
      }
      
      rows.forEach(row => {
        processDelivery(row.id);
      });
    }
  );
}

// 定期检查待处理的投递
setInterval(processNextDelivery, 60000); // 每分钟检查一次

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`管理台: http://localhost:${PORT}/admin`);
});

module.exports = app;