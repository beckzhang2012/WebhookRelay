const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

function verifySignature(req, res, next) {
  const sourceKey = req.params.source;
  const signature = req.headers['x-signature'];
  
  if (!signature) {
    return res.status(401).json({ error: { code: 'MISSING_SIGNATURE', message: 'X-Signature header is required' } });
  }

  const source = db.get('SELECT * FROM sources WHERE sourceKey = ?', [sourceKey]);
  
  if (!source) {
    return res.status(404).json({ error: { code: 'SOURCE_NOT_FOUND', message: 'Source not found' } });
  }

  const hmac = crypto.createHmac('sha256', source.secret);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
  
  if (signature !== digest) {
    return res.status(403).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } });
  }

  req.source = source;
  next();
}

async function forwardWebhook(deliveryId) {
  const delivery = db.get('SELECT * FROM deliveries WHERE id = ?', [deliveryId]);
  
  if (!delivery || delivery.status === 'success') return;

  const source = db.get('SELECT * FROM sources WHERE sourceKey = ?', [delivery.sourceKey]);
  
  if (!source) {
    db.run('UPDATE deliveries SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', ['failed', deliveryId]);
    return;
  }

  try {
    await axios.post(source.targetUrl, JSON.parse(delivery.payload), {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });
    
    db.run('UPDATE deliveries SET status = ?, attempts = attempts + 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', ['success', deliveryId]);
  } catch (error) {
    const newAttempts = delivery.attempts + 1;
    const errorMessage = error.message;
    
    if (newAttempts >= delivery.maxAttempts) {
      db.run('UPDATE deliveries SET status = ?, attempts = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', ['failed', newAttempts, deliveryId]);
      
      db.run('INSERT OR IGNORE INTO dead_letters (sourceKey, eventId, payload, error) VALUES (?, ?, ?, ?)', 
        [delivery.sourceKey, delivery.eventId, delivery.payload, errorMessage]);
    } else {
      db.run('UPDATE deliveries SET status = ?, attempts = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', ['pending', newAttempts, deliveryId]);
      
      const delay = Math.pow(2, newAttempts) * 1000;
      setTimeout(() => forwardWebhook(deliveryId), delay);
    }
  }
}

app.post('/ingest/:source', verifySignature, (req, res) => {
  const eventId = req.headers['x-event-id'] || crypto.randomUUID();
  const sourceKey = req.params.source;
  
  try {
    db.run('INSERT INTO deliveries (sourceKey, eventId, payload) VALUES (?, ?, ?)', 
      [sourceKey, eventId, JSON.stringify(req.body)]);
    
    const delivery = db.get('SELECT id FROM deliveries WHERE sourceKey = ? AND eventId = ?', [sourceKey, eventId]);
    
    setImmediate(() => forwardWebhook(delivery.id));
    
    res.status(202).json({ received: true, eventId });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      res.status(202).json({ received: true, eventId, message: 'Event already processed' });
    } else {
      res.status(500).json({ error: { code: 'DATABASE_ERROR', message: error.message } });
    }
  }
});

app.get('/api/sources', (req, res) => {
  const sources = db.all('SELECT * FROM sources ORDER BY createdAt DESC');
  res.json(sources);
});

app.post('/api/sources', (req, res) => {
  const { sourceKey, targetUrl, secret } = req.body;
  
  if (!sourceKey || !targetUrl || !secret) {
    return res.status(422).json({ error: { code: 'INVALID_INPUT', message: 'sourceKey, targetUrl and secret are required' } });
  }

  try {
    db.run('INSERT INTO sources (sourceKey, targetUrl, secret) VALUES (?, ?, ?)', [sourceKey, targetUrl, secret]);
    const source = db.get('SELECT * FROM sources WHERE sourceKey = ?', [sourceKey]);
    res.status(201).json(source);
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      res.status(422).json({ error: { code: 'DUPLICATE_SOURCE', message: 'Source with this key already exists' } });
    } else {
      res.status(500).json({ error: { code: 'DATABASE_ERROR', message: error.message } });
    }
  }
});

app.put('/api/sources/:id', (req, res) => {
  const { targetUrl, secret } = req.body;
  const id = req.params.id;
  
  if (!targetUrl && !secret) {
    return res.status(422).json({ error: { code: 'INVALID_INPUT', message: 'At least one of targetUrl or secret is required' } });
  }

  const updates = [];
  const params = [];
  
  if (targetUrl) {
    updates.push('targetUrl = ?');
    params.push(targetUrl);
  }
  if (secret) {
    updates.push('secret = ?');
    params.push(secret);
  }
  
  params.push(id);
  
  db.run(`UPDATE sources SET ${updates.join(', ')} WHERE id = ?`, params);
  const source = db.get('SELECT * FROM sources WHERE id = ?', [id]);
  
  if (source) {
    res.json(source);
  } else {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Source not found' } });
  }
});

app.delete('/api/sources/:id', (req, res) => {
  const id = req.params.id;
  const source = db.get('SELECT * FROM sources WHERE id = ?', [id]);
  
  if (source) {
    db.run('DELETE FROM sources WHERE id = ?', [id]);
    res.status(204).end();
  } else {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Source not found' } });
  }
});

app.get('/api/deliveries', (req, res) => {
  const deliveries = db.all('SELECT * FROM deliveries ORDER BY createdAt DESC LIMIT 100');
  res.json(deliveries);
});

app.get('/api/deadletters', (req, res) => {
  const deadLetters = db.all('SELECT * FROM dead_letters ORDER BY createdAt DESC');
  res.json(deadLetters);
});

app.post('/api/deadletters/:id/replay', (req, res) => {
  const id = req.params.id;
  const deadLetter = db.get('SELECT * FROM dead_letters WHERE id = ?', [id]);
  
  if (!deadLetter) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dead letter not found' } });
  }

  try {
    db.run('INSERT INTO deliveries (sourceKey, eventId, payload, status, attempts) VALUES (?, ?, ?, ?, ?)', 
      [deadLetter.sourceKey, deadLetter.eventId, deadLetter.payload, 'pending', 0]);
    
    db.run('DELETE FROM dead_letters WHERE id = ?', [id]);
    
    const delivery = db.get('SELECT id FROM deliveries WHERE sourceKey = ? AND eventId = ?', 
      [deadLetter.sourceKey, deadLetter.eventId]);
    
    setImmediate(() => forwardWebhook(delivery.id));
    
    res.json({ replayed: true, eventId: deadLetter.eventId });
  } catch (error) {
    res.status(500).json({ error: { code: 'DATABASE_ERROR', message: error.message } });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
});

async function startServer() {
  await db.initDatabase();
  app.listen(PORT, () => {
    console.log(`Webhook Relay server running on port ${PORT}`);
    console.log(`Admin interface: http://localhost:${PORT}/admin`);
  });
}

startServer();
