const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'relay.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('数据库连接成功');
    initializeDatabase();
  }
});

function initializeDatabase() {
  // 创建 sources 表
  db.run(`CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceKey TEXT UNIQUE NOT NULL,
    secret TEXT NOT NULL,
    targetUrl TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 创建 deliveries 表
  db.run(`CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    eventId TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    maxAttempts INTEGER DEFAULT 5,
    lastError TEXT,
    nextAttemptAt DATETIME,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source, eventId)
  )`);

  // 创建 deadletters 表
  db.run(`CREATE TABLE IF NOT EXISTS deadletters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deliveryId INTEGER UNIQUE NOT NULL,
    source TEXT NOT NULL,
    eventId TEXT NOT NULL,
    payload TEXT NOT NULL,
    lastError TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (deliveryId) REFERENCES deliveries(id)
  )`);

  console.log('数据库表初始化完成');
}

module.exports = db;