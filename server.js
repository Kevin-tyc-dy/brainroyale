/**
 * ═══════════════════════════════════════════════════════════
 *  戰學者──知識大挑戰 · BrainRoyale — Complete Game Server
 *  Node.js + Socket.io (single file, no external modules)
 *
 *  目錄結構：
 *    project/
 *    ├── server.js         ← 本檔案
 *    ├── package.json
 *    └── public/
 *        ├── index.html    ← 學生遊戲頁面
 *        └── teacher.html  ← 教師控制台
 *
 *  啟動：
 *    npm install express socket.io
 *    node server.js
 *
 *  連線：
 *    學生：http://localhost:3000
 *    教師：http://localhost:3000/teacher
 * ═══════════════════════════════════════════════════════════
 */

'use strict';
// 本地開發時載入 .env，Zeabur 部署時會直接注入環境變數
try { require('dotenv').config(); } catch(_) {}

const express      = require('express');
const http         = require('http');
const path         = require('path');
const EventEmitter = require('events');
const { Server }   = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
});
const gameEmitter = new EventEmitter();
gameEmitter.setMaxListeners(100);

// Static files — serve from public/ and also directly from root
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname)); // also serve index.html / teacher.html from root dir

// Explicit routes: support both / and any sub-path prefix (e.g. /v2/)
function sendIndex(_, res)   { res.sendFile(path.join(__dirname, 'public', 'index.html')); }
function sendTeacher(_, res) { res.sendFile(path.join(__dirname, 'public', 'teacher.html')); }

// Root paths
app.get('/',           sendIndex);
app.get('/index.html', sendIndex);
app.get('/teacher',         sendTeacher);
app.get('/teacher.html',    sendTeacher);

// Sub-path variants (e.g. /v2/, /v1/, /game/, etc.)
app.get('*/index.html',   sendIndex);
app.get('*/teacher.html', sendTeacher);
app.get('*/teacher',      sendTeacher);

// Catch-all: any unmatched GET → serve index.html (SPA fallback)
app.get('/map-editor',      (_, res) => res.sendFile(path.join(__dirname, 'public', 'map-editor.html')));
app.get('/map-editor.html', (_, res) => res.sendFile(path.join(__dirname, 'public', 'map-editor.html')));
app.use(express.json({ limit: '2mb' }));
app.get('/api/maps', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id,name,type,`cols`,`rows`,tile_size,auto_fill_bots,created_at,updated_at FROM maps ORDER BY created_at ASC'
    );
    res.json(rows.map(r => ({
      id:r.id, name:r.name, type:r.type,
      cols:r.cols, rows:r.rows, tileSize:r.tile_size,
      autoFillBots:!!r.auto_fill_bots,
      createdAt:r.created_at, updatedAt:r.updated_at,
    })));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/maps/:id', async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM maps WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error:'地圖不存在' });
    const data = typeof row.data==='string' ? JSON.parse(row.data) : row.data;
    res.json({ id:row.id, name:row.name, type:row.type, cols:row.cols, rows:row.rows,
      tileSize:row.tile_size, autoFillBots:!!row.auto_fill_bots, data,
      createdAt:row.created_at, updatedAt:row.updated_at });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/maps', async (req, res) => {
  const { name,type,cols,rows,tileSize,autoFillBots,data } = req.body;
  if (!name||!name.trim()) return res.status(400).json({ error:'地圖名稱不可空白' });
  const id=newMapId(), now=Date.now();
  try {
    await pool.query(
      'INSERT INTO maps (id,name,type,`cols`,`rows`,tile_size,data,auto_fill_bots,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id,name.trim(),type||'room',cols||40,rows||30,tileSize||32,
       JSON.stringify(data||{}),autoFillBots?1:0,now,now]);
    console.log('[Maps] Created:', name);
    res.status(201).json({ id, name:name.trim(), type:type||'room', createdAt:now });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.put('/api/maps/:id', async (req, res) => {
  const { name,type,cols,rows,tileSize,autoFillBots,data } = req.body;
  const now=Date.now();
  try {
    const [[ex]] = await pool.query('SELECT id FROM maps WHERE id=?', [req.params.id]);
    if (!ex) return res.status(404).json({ error:'地圖不存在' });
    await pool.query(
      'UPDATE maps SET name=?,type=?,`cols`=?,`rows`=?,tile_size=?,data=?,auto_fill_bots=?,updated_at=? WHERE id=?',
      [name||'未命名',type||'room',cols||40,rows||30,tileSize||32,
       JSON.stringify(data||{}),autoFillBots?1:0,now,req.params.id]);
    mapCache.delete(req.params.id);
    console.log('[Maps] Updated:', name);
    res.json({ id:req.params.id, name, updatedAt:now });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/maps/:id', async (req, res) => {
  try {
    const [[ex]] = await pool.query('SELECT id,name FROM maps WHERE id=?', [req.params.id]);
    if (!ex) return res.status(404).json({ error:'地圖不存在' });
    await pool.query('DELETE FROM maps WHERE id=?', [req.params.id]);
    mapCache.delete(req.params.id);
    console.log('[Maps] Deleted:', ex.name);
    res.json({ deleted:req.params.id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('*', sendIndex);

// ═══════════════════════════════════════════════
//  GAME CONFIG
// ═══════════════════════════════════════════════
const BOT_NAMES = [
  '小明','小花','阿強','阿志','小玲','阿宏','小芳','阿豪',
  '小傑','阿珍','小威','阿覕','小龍','阿美','小俊','阿文',
  '小涵','阿銘','小雅','阿偉','小翔','阿琢','小穎','阿凱',
  '小婷','阿勝','小萃','阿哲','小恩','阿廷',
];

const CONFIG = {
  MAP_W:            4800,
  MAP_H:            4800,
  MAX_PLAYERS:      30,
  MAX_HP:           5,
  COLLISION_DIST:   60,
  KNOCKBACK_DIST:   160,
  BATTLE_COOLDOWN:  5000,  // 對戰後 5 秒無敵保護
  BATTLE_TIMEOUT:   15000,
  SYNC_INTERVAL:    100,
  FOG_RADIUS:       600,     // Server-side fog: only broadcast players within this range
  MAX_SPEED_PX_MS:  0.38,    // Anti-cheat: max allowed speed
  ZONE_STAGES: [
    { at:0,   radius:2400 },
    { at:60,  radius:1800 },
    { at:120, radius:1200 },
    { at:180, radius:750  },
    { at:240, radius:400  },
    { at:300, radius:150  },
  ],
  ZONE_DMG_INTERVAL: 2000,
  ZONE_DMG_HP:       1,
  COUNTDOWN_SEC:     3,
};

// ═══════════════════════════════════════════════
//  QUESTION BANK — MySQL 持久化
//  套件：mysql2  →  npm install mysql2
//  連線設定：.env 檔案（與 server.js 同目錄）
// ═══════════════════════════════════════════════
const mysql = require('mysql2/promise');

// 連線池（最多 10 條連線，自動重連）
// Zeabur 自動注入 MYSQL_* 變數；本地開發用 DB_* (.env)
const pool = mysql.createPool({
  host:               process.env.MYSQL_HOST     || process.env.DB_HOST,
  port:               parseInt(process.env.MYSQL_PORT     || process.env.DB_PORT     || '3306'),
  user:               process.env.MYSQL_USERNAME  || process.env.DB_USER,
  password:           process.env.MYSQL_PASSWORD  || process.env.DB_PASSWORD,
  database:           process.env.MYSQL_DATABASE  || process.env.DB_NAME,
  charset:            'utf8mb4',
  timezone:           '+08:00',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  connectTimeout:     10000,
});

// ── 建表（首次啟動自動建立，已存在則跳過）──────
async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS banks (
        id          VARCHAR(40)  PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        school_year VARCHAR(10)  NOT NULL DEFAULT '',
        grade       VARCHAR(5)   NOT NULL DEFAULT '',
        subject     VARCHAR(20)  NOT NULL DEFAULT '',
        chapter     VARCHAR(100) NOT NULL DEFAULT '',
        description TEXT,
        created_at  BIGINT       NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id          VARCHAR(40)  PRIMARY KEY,
        bank_id     VARCHAR(40)  NOT NULL,
        text        TEXT         NOT NULL,
        opts        JSON         NOT NULL,
        ans         VARCHAR(5)   NOT NULL,
        difficulty  VARCHAR(10)  NOT NULL DEFAULT 'medium',
        tags        VARCHAR(200) NOT NULL DEFAULT '',
        created_at  BIGINT       NOT NULL,
        FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE,
        INDEX idx_bank (bank_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS maps (
        id             VARCHAR(40)  PRIMARY KEY,
        name           VARCHAR(100) NOT NULL,
        type           VARCHAR(20)  NOT NULL DEFAULT 'room',
        \`cols\`         INT          NOT NULL DEFAULT 40,
        \`rows\`         INT          NOT NULL DEFAULT 30,
        tile_size      INT          NOT NULL DEFAULT 32,
        data           JSON         NOT NULL,
        auto_fill_bots TINYINT      NOT NULL DEFAULT 1,
        created_at     BIGINT       NOT NULL,
        updated_at     BIGINT       NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('[MySQL] Tables ready.');

    // Seed（只在 banks 表完全空白時插入範例資料）
    const [[{ c }]] = await conn.query('SELECT COUNT(*) AS c FROM banks');
    if (c === 0) {
      console.log('[MySQL] Empty DB — inserting seed data...');
      await seedData(conn);
      console.log('[MySQL] Seed complete.');
    } else {
      console.log(`[MySQL] DB loaded (${c} banks).`);
    }
  } finally {
    conn.release();
  }
}

async function seedData(conn) {
  const now = Date.now();
  await conn.query(
    `INSERT INTO banks (id,name,school_year,grade,subject,chapter,description,created_at) VALUES ?`,
    [[
      ['bank_sci',    '自然科學範例題庫', '113', '5', '自然', '第一章：地球與宇宙', '範例示範用', now],
      ['bank_social', '社會科範例題庫',   '113', '5', '社會', '第三章：台灣地理',   '台灣地理試題', now],
    ]]
  );
  const qs = [
    ['q1','bank_sci',  '地球距離太陽約多少公里？',         JSON.stringify([{id:'a',text:'約 1 億 5 千萬公里'},{id:'b',text:'約 3 億公里'},{id:'c',text:'約 5 千萬公里'},{id:'d',text:'約 2 億公里'}]),   'a','medium','地球,太陽',  now],
    ['q2','bank_sci',  '水分子的化學式是什麼？',            JSON.stringify([{id:'a',text:'CO₂'},{id:'b',text:'H₂O'},{id:'c',text:'O₂'},{id:'d',text:'NaCl'}]),                                            'b','easy',  '化學,分子式',now],
    ['q3','bank_sci',  '光速約為每秒多少公里？',            JSON.stringify([{id:'a',text:'約 30 萬公里/秒'},{id:'b',text:'約 3 萬公里/秒'},{id:'c',text:'約 300 公里/秒'},{id:'d',text:'約 3000 公里/秒'}]),'a','medium','光速,物理',  now],
    ['q4','bank_sci',  '人體最大的器官是哪個？',            JSON.stringify([{id:'a',text:'心臟'},{id:'b',text:'肝臟'},{id:'c',text:'皮膚'},{id:'d',text:'大腸'}]),                                         'c','easy',  '人體,器官',  now],
    ['q5','bank_sci',  '哪位科學家提出「相對論」？',        JSON.stringify([{id:'a',text:'牛頓'},{id:'b',text:'伽利略'},{id:'c',text:'愛因斯坦'},{id:'d',text:'波耳'}]),                                   'c','easy',  '科學家',     now],
    ['s1','bank_social','臺灣最高峰是哪一座山？',           JSON.stringify([{id:'a',text:'雪山'},{id:'b',text:'玉山'},{id:'c',text:'南湖大山'},{id:'d',text:'秀姑巒山'}]),                                 'b','easy',  '臺灣,地理',  now],
    ['s2','bank_social','二次世界大戰結束於哪一年？',       JSON.stringify([{id:'a',text:'1943'},{id:'b',text:'1944'},{id:'c',text:'1945'},{id:'d',text:'1946'}]),                                         'c','medium','歷史,二戰',  now],
    ['s3','bank_social','金字塔位於哪個國家？',             JSON.stringify([{id:'a',text:'伊拉克'},{id:'b',text:'伊朗'},{id:'c',text:'沙烏地阿拉伯'},{id:'d',text:'埃及'}]),                               'd','easy',  '世界地理',   now],
  ];
  await conn.query(
    `INSERT INTO questions (id,bank_id,text,opts,ans,difficulty,tags,created_at) VALUES ?`, [qs]
  );
}

// ── DB Query Helpers ────────────────────────────
function newId(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function parseQ(row) {
  // MySQL JSON 欄位會自動 parse；若為字串則手動 parse
  const opts = typeof row.opts === 'string' ? JSON.parse(row.opts) : row.opts;
  return { ...row, opts };
}

function serializeBank(row, questions = null) {
  return {
    id:            row.id,
    name:          row.name,
    schoolYear:    row.school_year,
    grade:         row.grade,
    subject:       row.subject,
    chapter:       row.chapter,
    description:   row.description || '',
    createdAt:     row.created_at,
    questionCount: Number(row.question_count ?? (questions ? questions.length : 0)),
    questions:     questions || [],
  };
}

async function getAllBanksInfo() {
  const [rows] = await pool.query(`
    SELECT b.*, COUNT(q.id) AS question_count
    FROM banks b LEFT JOIN questions q ON q.bank_id = b.id
    GROUP BY b.id ORDER BY b.created_at ASC
  `);
  return rows.map(b => serializeBank(b, null));
}

async function getBankDetail(bankId) {
  const [[bank]] = await pool.query('SELECT * FROM banks WHERE id = ?', [bankId]);
  if (!bank) return null;
  const [qs] = await pool.query('SELECT * FROM questions WHERE bank_id = ? ORDER BY created_at ASC', [bankId]);
  bank.question_count = qs.length;
  return serializeBank(bank, qs.map(parseQ));
}

// 抽題用：從選定題庫撈題，緩存在 room.questionPool（每場遊戲緩存一次）
async function refreshPickPool(room) {
  try {
    let rows;
    if (room.selectedBankIds && room.selectedBankIds.size > 0) {
      const ids = [...room.selectedBankIds];
      const placeholders = ids.map(() => '?').join(',');
      [rows] = await pool.query(
        `SELECT * FROM questions WHERE bank_id IN (${placeholders})`, ids
      );
    } else {
      [rows] = await pool.query('SELECT * FROM questions');
    }
    room.questionPool = rows.map(parseQ);
    console.log(`[QBank] Pool refreshed: ${room.questionPool.length} questions`);
  } catch(e) {
    console.error('[QBank] Pool refresh error:', e.message);
    room.questionPool = room.questionPool || [];
  }
}

// ── 初始化（async 啟動）──────────────────────────
// initDB() 在檔案底部 server.listen 前呼叫


// ═══════════════════════════════════════════════
//  BOT SYSTEM
// ═══════════════════════════════════════════════
const BOT_CORRECT_RATE = { easy: 0.80, medium: 0.55, hard: 0.30 };
const BOT_SPEED   = 28;
const BOT_TICK_MS = 200;

function makeBotId() {
  return 'bot_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
}

function spawnBots(room, count) {
  const usedNames = new Set([...room.players.values()].map(p => p.name));
  const available = BOT_NAMES.filter(n => !usedNames.has(n));
  for (let i = 0; i < count; i++) {
    const sp   = randSpawn(room);
    const name = available.length > 0 ? available.splice(0,1)[0] : ('Bot'+(i+1));
    const id   = makeBotId();
    const bot  = {
      id, name, roomId: room.id,
      x: sp.x, y: sp.y,
      hp: CONFIG.MAX_HP, isAlive: true, isLocked: false,
      wins: 0, lastMoveAt: Date.now(),
      spectateTargetId: null, cooldowns: new Map(),
      isBot: true,
      streak: 0,
      botTargetId: null,
      botWanderAngle: Math.random() * Math.PI * 2,
      botSheet: (i % 3) + 1,  // 1=bot1, 2=bot2, 3=bot3 (spritesheet)
      botTint: [0xff9999, 0x99ccff, 0x99ffaa, 0xffdd88, 0xdd99ff, 0xff99dd][i % 6],
    };
    room.players.set(id, bot);
    toTeachers(room.id, 'teacher:player_joined', {
      id: bot.id, name: bot.name, x: bot.x, y: bot.y,
      hp: bot.hp, isAlive: true, wins: 0, isBot: true,
    });
    console.log('[Bot] Spawned: ' + bot.name);
  }
}

function isBotBlocked(wallSet, tileSize, px, py) {
  const gx = Math.floor(px / tileSize);
  const gy = Math.floor(py / tileSize);
  for (let dy=-1; dy<=1; dy++) {
    for (let dx2=-1; dx2<=1; dx2++) {
      if (!wallSet.has((gx+dx2)+','+(gy+dy))) continue;
      const wx=(gx+dx2)*tileSize, wy=(gy+dy)*tileSize;
      if (px+20>wx && px-20<wx+tileSize && py+6>wy && py-28<wy+tileSize) return true;
    }
  }
  return false;
}

function tickBots(room) {
  if (!room.gameStarted || room.isPaused) return;
  // bot 開局等待 5 秒，讓玩家有時間看清楚局面
  if (!room.startAt || Date.now() - room.startAt < 5000) return;
  const humans = [...room.players.values()].filter(p => p.isAlive && !p.isBot);
  const margin = 80;
  const cl = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
  room.players.forEach(bot => {
    if (!bot.isBot || !bot.isAlive || bot.isLocked) return;
    if (!bot.botTargetId || Math.random() < 0.05) {
      let nearest = null, nearestDist = Infinity;
      humans.forEach(h => {
        if (!h.isAlive) return;
        const d = dist(bot, h);
        if (d < nearestDist) { nearestDist = d; nearest = h; }
      });
      bot.botTargetId = nearest ? nearest.id : null;
    }
    const target = bot.botTargetId ? room.players.get(bot.botTargetId) : null;
    const zx = room.zone.centerX, zy = room.zone.centerY, zr = room.zone.currentRadius;
    const dz = dist(bot, { x: zx, y: zy });
    const inZone = dz < zr * 0.92;
    let dx = 0, dy = 0;
    if (!inZone) {
      const len = dz || 1;
      dx = (zx - bot.x) / len; dy = (zy - bot.y) / len;
    } else if (target && target.isAlive) {
      const td = dist(bot, target) || 1;
      dx = (target.x - bot.x) / td; dy = (target.y - bot.y) / td;
    } else {
      bot.botWanderAngle += (Math.random() - 0.5) * 0.6;
      dx = Math.cos(bot.botWanderAngle); dy = Math.sin(bot.botWanderAngle);
    }
    const nx2 = cl(bot.x + dx * BOT_SPEED, margin, CONFIG.MAP_W - margin);
    const ny2 = cl(bot.y + dy * BOT_SPEED, margin, CONFIG.MAP_H - margin);
    // Wall avoidance: try X then Y separately if direct path blocked
    if (room.wallSet && room.wallSet.size > 0 && room.mapObj) {
      const ts2 = room.mapObj.tileSize || 32;
      const hitXY = isBotBlocked(room.wallSet, ts2, nx2, ny2);
      const hitX  = isBotBlocked(room.wallSet, ts2, nx2, bot.y);
      const hitY  = isBotBlocked(room.wallSet, ts2, bot.x, ny2);
      if (!hitXY) {
        bot.x = nx2; bot.y = ny2;
      } else if (!hitX) {
        bot.x = nx2;
        bot.botWanderAngle = Math.PI - bot.botWanderAngle; // bounce Y
      } else if (!hitY) {
        bot.y = ny2;
        bot.botWanderAngle = -bot.botWanderAngle; // bounce X
      } else {
        // Fully blocked: rotate wander angle randomly
        bot.botWanderAngle += Math.PI * (0.5 + Math.random());
      }
    } else {
      bot.x = nx2; bot.y = ny2;
    }
    bot.lastMoveAt = Date.now();
    checkCollisions(room, bot);
  });
}

function botAnswerBattle(room, battle, botId) {
  if (battle.resolved) return;
  const q    = battle.q;
  const diff = q.difficulty || 'medium';
  const rate = BOT_CORRECT_RATE[diff] !== undefined ? BOT_CORRECT_RATE[diff] : 0.55;
  const delay = 500 + Math.random() * 2500;
  setTimeout(() => {
    if (battle.resolved) return;
    let ans;
    if (Math.random() < rate) {
      ans = q.ans;
    } else {
      const wrong = q.opts.filter(o => o.id !== q.ans);
      ans = wrong.length > 0 ? wrong[Math.floor(Math.random() * wrong.length)].id : q.opts[0].id;
    }
    receiveAnswer(room, botId, { battleId: battle.id, answerId: ans });
  }, delay);
}

// ═══════════════════════════════════════════════
//  MAPS REST API
// ═══════════════════════════════════════════════
function newMapId() {
  return 'map_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
}



// Map cache & helpers
const mapCache = new Map();

async function getMapCached(mapId) {
  if (mapCache.has(mapId)) return mapCache.get(mapId);
  const [[row]] = await pool.query('SELECT * FROM maps WHERE id=?', [mapId]);
  if (!row) return null;
  const mapObj = { id:row.id, name:row.name, type:row.type,
    cols:row.cols, rows:row.rows, tileSize:row.tile_size,
    autoFillBots:!!row.auto_fill_bots,
    data: typeof row.data==='string' ? JSON.parse(row.data) : row.data };
  mapCache.set(mapId, mapObj);
  return mapObj;
}

function getMapSpawnPoints(mapObj) {
  const ts = mapObj.tileSize || 32;
  return (mapObj.data?.spawns || []).map(([gx,gy]) => ({ x:(gx+0.5)*ts, y:(gy+0.5)*ts }));
}

function getMapZoneCenter(mapObj) {
  const z = mapObj.data?.zone;
  if (z?.centerX != null && z?.centerY != null) return { x:z.centerX, y:z.centerY };
  const ts = mapObj.tileSize || 32;
  return { x:mapObj.cols*ts/2, y:mapObj.rows*ts/2 };
}

function getMapZoneStages(mapObj) {
  const stages = mapObj.data?.zone?.stages;
  return (stages && stages.length > 0) ? stages : CONFIG.ZONE_STAGES;
}

function getMapWallSet(mapObj) {
  return new Set((mapObj.data?.walls || []).map(([x,y]) => x+','+y));
}

// ═══════════════════════════════════════════════
//  ROOM STATE
// ═══════════════════════════════════════════════
// rooms: Map<roomId, Room>
// Room = {
//   id, players: Map<id,Player>, battles: Map<id,Battle>,
//   gameStarted, isPaused, startAt,
//   zone: { centerX, centerY, currentRadius, stageIndex, nextShrinkAt },
//   stats: { totalBattles, totalElim, correct, wrong, timeout, timesMs[], qMap },
//   intervals: { sync, zone, zoneDmg }
// }
const rooms = new Map();

// teachers: Map<roomId, Set<socketId>>
const teachers = new Map();

// activeCodes: 老師正式開設的有效房間代碼
const activeCodes = new Set();
function genRoomCode() {
  let code;
  do { code = String(Math.floor(10000 + Math.random() * 90000)); }
  while (activeCodes.has(code));
  return code;
}

function getRoom(id) {
  if(!rooms.has(id)) {
    rooms.set(id, {
      id,
      players:     new Map(),
      battles:     new Map(),
      gameStarted: false,
      isPaused:    false,
      startAt:     0,
      zone: {
        centerX:       CONFIG.MAP_W / 2,
        centerY:       CONFIG.MAP_H / 2,
        currentRadius: CONFIG.ZONE_STAGES[0].radius,
        stageIndex:    0,
        nextShrinkAt:  0,
        stages:        CONFIG.ZONE_STAGES,
      },
      stats: {
        totalBattles: 0,
        totalElim:    0,
        correct:      0,
        wrong:        0,
        timeout:      0,
        timesMs:      [],
        qMap:         new Map(),
      },
      intervals: { sync:null, zone:null, zoneDmg:null, bot:null },
      selectedBankIds: new Set(),
      questionPool: [],
      mapId:   null,
      mapObj:  null,
      wallSet:    new Set(),
      botEnabled: true,
      botCount:   null,
    });
    console.log(`[Room] Created: ${id}`);
  }
  return rooms.get(id);
}

function cleanRoom(room) {
  const humans = [...room.players.values()].filter(p => !p.isBot).length;
  if(humans === 0) {
    Object.values(room.intervals).forEach(clearInterval);
    rooms.delete(room.id);
    console.log('[Room] Destroyed: ' + room.id);
  }
}

async function loadRoomMap(room, mapId) {
  if (!mapId) { room.mapId=null; room.mapObj=null; room.wallSet=new Set(); return; }
  try {
    const mapObj = await getMapCached(mapId);
    if (!mapObj) { console.warn('[Map] Not found:', mapId); return; }
    room.mapId  = mapId;
    room.mapObj = mapObj;
    room.wallSet = getMapWallSet(mapObj);
    const center = getMapZoneCenter(mapObj);
    const stages = getMapZoneStages(mapObj);
    room.zone.centerX       = center.x;
    room.zone.centerY       = center.y;
    room.zone.currentRadius = stages[0].radius;
    room.zone.stageIndex    = 0;
    room.zone.stages        = stages;
    console.log('[Map] Loaded: ' + mapObj.name + ' -> room ' + room.id);
  } catch(e) { console.error('[Map] Load error:', e.message); }
}

// ═══════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════
const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);

function randSpawn(room) {
  if (room && room.mapObj) {
    const pts = getMapSpawnPoints(room.mapObj);
    if (pts.length > 0) return pts[Math.floor(Math.random() * pts.length)];
  }
  // 開局在安全圈初始半徑（2400px）內隨機 spawn，確保不在圈外
  const cx = CONFIG.MAP_W / 2, cy = CONFIG.MAP_H / 2;
  const initR = CONFIG.ZONE_STAGES[0].radius * 0.85; // 85% 安全半徑內
  const angle = Math.random() * Math.PI * 2;
  const r     = Math.random() * initR;
  return {
    x: Math.round(cx + Math.cos(angle) * r),
    y: Math.round(cy + Math.sin(angle) * r),
  };
}

function pickQ(room) {
  const pool = room.questionPool || [];
  if (pool.length === 0) {
    return { id:'fallback', text:'（尚未設定題庫，請教師新增題目）',
      opts:[{id:'a',text:'A'},{id:'b',text:'B'},{id:'c',text:'C'},{id:'d',text:'D'}], ans:'a' };
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function knockback(pA, pB, d) {
  const dx=pB.x-pA.x, dy=pB.y-pA.y;
  const len=Math.hypot(dx,dy)||1;
  const nx=dx/len, ny=dy/len;

  // Walk along knockback direction in small steps, stop before entering a wall
  function safeSlide(player, dirX, dirY, dist) {
    const room  = player.roomId ? rooms.get(player.roomId) : null;
    const ts2   = room?.mapObj?.tileSize || 32;
    const wSet  = room?.wallSet;
    const STEP  = ts2 * 0.4;           // step size ~40% of tile
    const PAD   = 20;                  // player half-width for collision
    const steps = Math.ceil(dist / STEP);
    let cx = player.x, cy = player.y;

    for (let i = 0; i < steps; i++) {
      const remaining = dist - i * STEP;
      const move = Math.min(STEP, remaining);
      const tx = Math.max(PAD, Math.min(CONFIG.MAP_W - PAD, cx + dirX * move));
      const ty = Math.max(PAD, Math.min(CONFIG.MAP_H - PAD, cy + dirY * move));

      // Check wall collision at new position
      let blocked = false;
      if (wSet && wSet.size > 0) {
        const gx = Math.floor(tx / ts2);
        const gy = Math.floor(ty / ts2);
        outer: for (let dy2 = -1; dy2 <= 1; dy2++) {
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            if (wSet.has((gx+dx2)+','+(gy+dy2))) {
              const wx = (gx+dx2)*ts2, wy = (gy+dy2)*ts2;
              if (tx+PAD > wx && tx-PAD < wx+ts2 && ty+PAD > wy && ty-PAD < wy+ts2) {
                blocked = true; break outer;
              }
            }
          }
        }
      }

      if (blocked) break;   // stop before the wall
      cx = tx; cy = ty;
    }
    return { x: cx, y: cy };
  }

  return {
    newA: safeSlide(pA, -nx, -ny, d),
    newB: safeSlide(pB,  nx,  ny, d),
  };
}

// Broadcast to all teachers in a room
function toTeachers(roomId, event, data) {
  const set = teachers.get(roomId);
  if(!set) return;
  set.forEach(tid => io.to(tid).emit(event, data));
}

// ═══════════════════════════════════════════════
//  GAME LIFECYCLE
// ═══════════════════════════════════════════════
function startGame(room) {
  if(room.gameStarted) return;
  room.gameStarted = true;
  room.startAt     = Date.now();
  if (room.botEnabled) {
    const humanCount = [...room.players.values()].filter(p=>!p.isBot).length;
    const wanted = room.botCount !== null ? room.botCount : CONFIG.MAX_PLAYERS - humanCount;
    const toSpawn = Math.max(0, Math.min(wanted, CONFIG.MAX_PLAYERS - humanCount));
    if (toSpawn > 0) { spawnBots(room, toSpawn); console.log('[Bot] Spawned '+toSpawn+' bots.'); }
  } else {
    console.log('[Bot] Bots disabled for this room.');
  }
  console.log('[Game] '+room.id+' STARTED ('+room.players.size+'p)');

  // 開局前廣播最新地圖給所有玩家（玩家加入後老師可能才套用地圖）
  const mapPayload = room.mapObj ? {
    cols:     room.mapObj.cols,
    rows:     room.mapObj.rows,
    tileSize: room.mapObj.tileSize,
    walls:    room.mapObj.data?.walls   || [],
    spawns:   room.mapObj.data?.spawns  || [],
    portals:  room.mapObj.data?.portals || [],
    terrain:  room.mapObj.data?.terrain || [],
  } : null;
  io.to(room.id).emit('map:load', { mapData: mapPayload });

  // Broadcast countdown to players
  io.to(room.id).emit('game:countdown');
  toTeachers(room.id,'teacher:game_state',{ state:'running' });

  broadcastZone(room);

  room.intervals.sync   = setInterval(()=> broadcastWorld(room), CONFIG.SYNC_INTERVAL);
  room.intervals.zone   = setInterval(()=> tickZone(room), 1000);
  room.intervals.zoneDmg= setInterval(()=> applyZoneDmg(room), CONFIG.ZONE_DMG_INTERVAL);
  room.intervals.bot    = setInterval(()=> tickBots(room), BOT_TICK_MS);
}

function pauseGame(room) {
  room.isPaused = !room.isPaused;
  room.players.forEach(p=>{ if(p.isAlive) p.isLocked=room.isPaused; });
  io.to(room.id).emit('game:paused',{ paused:room.isPaused });
  toTeachers(room.id,'teacher:game_state',{ state:room.isPaused?'paused':'running' });
  console.log(`[Game] ${room.id} ${room.isPaused?'PAUSED':'RESUMED'}`);
}

function forceEndGame(room) {
  Object.values(room.intervals).forEach(clearInterval);
  room.gameStarted = false;
  io.to(room.id).emit('game:force_ended',{ message:'教師已結束本局遊戲' });
  toTeachers(room.id,'teacher:game_state',{ state:'ended' });
  console.log(`[Game] ${room.id} FORCE ENDED`);
}

// ═══════════════════════════════════════════════
//  WORLD BROADCAST (server-side fog)
// ═══════════════════════════════════════════════
function broadcastWorld(room) {
  const alive = [...room.players.values()].filter(p=>p.isAlive).length;
  const count = room.players.size;

  room.players.forEach(viewer => {
    const list = [];
    room.players.forEach(p => {
      if(p.id===viewer.id) return;
      // Spectators see all; alive players limited by fog
      if(viewer.isAlive && dist(viewer,p) > CONFIG.FOG_RADIUS) return;
      list.push({ id:p.id, name:p.name, x:p.x, y:p.y, hp:p.hp, isAlive:p.isAlive, isBot:!!p.isBot, botSheet:p.botSheet||1, botTint:p.botTint||null, charKey:p.charKey||'char1', streak:p.streak||0 });
    });
    io.to(viewer.id).emit('world:update',{ players:list, aliveCount:alive });
  });

  // Broadcast player count to teachers for waiting room display
  toTeachers(room.id,'teacher:world_update',{
    players: [...room.players.values()].map(p=>({
      id:p.id, name:p.name, x:p.x, y:p.y, hp:p.hp,
      isAlive:p.isAlive, wins:p.wins||0, inBattle:p.isLocked||false,
    })),
    aliveCount: alive,
    totalCount: count,
  });

  // Also notify players in waiting room of count
  if(!room.gameStarted) {
    io.to(room.id).emit('teacher:world_update_count',{ count });
  }
}

// ═══════════════════════════════════════════════
//  ZONE
// ═══════════════════════════════════════════════
function tickZone(room) {
  const el = (Date.now()-room.startAt)/1000;
  const stages = room.zone.stages || CONFIG.ZONE_STAGES;
  const z = room.zone;
  for(let i=stages.length-1;i>=0;i--){
    if(el>=stages[i].at && z.stageIndex<=i){
      z.stageIndex    = i;
      z.currentRadius = stages[i].radius;
      break;
    }
  }
  const next=stages[z.stageIndex+1];
  if(next){ z.nextShrinkAt = room.startAt+next.at*1000; broadcastZone(room); }
}

function broadcastZone(room) {
  const z    = room.zone;
  const next = CONFIG.ZONE_STAGES[z.stageIndex+1];
  const data = {
    centerX:z.centerX, centerY:z.centerY,
    currentRadius:z.currentRadius,
    nextRadius: next?next.radius:z.currentRadius,
    shrinkAt: z.nextShrinkAt,
  };
  io.to(room.id).emit('zone:update',data);
  toTeachers(room.id,'zone:update',data);
}

function forceShrink(room) {
  const z=room.zone, stages=CONFIG.ZONE_STAGES;
  if(z.stageIndex < stages.length-1){
    z.stageIndex++;
    z.currentRadius = stages[z.stageIndex].radius;
    broadcastZone(room);
    console.log(`[Zone] ${room.id} force shrink → r=${z.currentRadius}`);
  }
}

function applyZoneDmg(room) {
  if(room.isPaused) return;
  const z=room.zone;
  room.players.forEach(p=>{
    if(!p.isAlive||p.isLocked) return;
    if(dist(p,{x:z.centerX,y:z.centerY}) > z.currentRadius){
      dmg(room,p.id,CONFIG.ZONE_DMG_HP,'zone');
    }
  });
}

// ═══════════════════════════════════════════════
//  DAMAGE / ELIMINATE
// ═══════════════════════════════════════════════
function dmg(room, pid, amount, source) {
  const p = room.players.get(pid);
  if(!p||!p.isAlive) return;
  p.hp = Math.max(0, p.hp-amount);

  io.to(pid).emit('player:hp_update',{ playerId:pid, newHp:p.hp, source });
  toTeachers(room.id,'teacher:hp_update',{ playerId:pid, newHp:p.hp });

  console.log(`[HP] ${p.name}: ${p.hp}/${CONFIG.MAX_HP} (${source})`);
  if(p.hp<=0) eliminate(room,pid);
}

function eliminate(room, pid) {
  const p = room.players.get(pid);
  if(!p||!p.isAlive) return;
  p.isAlive=false; p.isLocked=false;

  const targets = [...room.players.values()]
    .filter(x=>x.isAlive&&x.id!==pid)
    .map(x=>({id:x.id,name:x.name}));

  io.to(pid).emit('player:eliminated',{ spectateTargets:targets });
  room.stats.totalElim++;
  toTeachers(room.id,'teacher:eliminated',{
    playerId:pid, playerName:p.name, totalElim:room.stats.totalElim,
  });
  console.log(`[Elim] ${p.name}`);

  // Check win
  const alive = [...room.players.values()].filter(x=>x.isAlive);
  if(alive.length<=1){
    const w=alive[0];
    if(w) {
      io.to(room.id).emit('game:winner',{ winnerId:w.id, winnerName:w.name });
      toTeachers(room.id,'teacher:game_state',{ state:'ended' });
      console.log(`[Win] ${w.name}`);
    }
  }
}

// ═══════════════════════════════════════════════
//  COLLISION DETECTION
// ═══════════════════════════════════════════════
function checkCollisions(room, mover) {
  if(!mover.isAlive||mover.isLocked||room.isPaused) return;
  const now = Date.now();
  // 開局保護：遊戲開始後 5 秒內不觸發對戰
  if(room.startAt && now - room.startAt < 5000) return;
  // 玩家無敵期間不觸發對戰
  if(mover.invincibleUntil && now < mover.invincibleUntil) return;
  room.players.forEach(other=>{
    if(other.id===mover.id||!other.isAlive||other.isLocked) return;
    if(other.invincibleUntil && now < other.invincibleUntil) return;
    const cd = mover.cooldowns.get(other.id)||0;
    if(now - cd < CONFIG.BATTLE_COOLDOWN) return;
    if(dist(mover,other) <= CONFIG.COLLISION_DIST) triggerBattle(room,mover,other).catch(e=>console.error('[Battle] triggerBattle error:',e.message));
  });
}

// ═══════════════════════════════════════════════
//  BATTLE
// ═══════════════════════════════════════════════
async function triggerBattle(room, pA, pB) {
  if(pA.isLocked||pB.isLocked) return;
  pA.isLocked=true; pB.isLocked=true;
  pA.cooldowns.set(pB.id,Date.now());
  pB.cooldowns.set(pA.id,Date.now());

  // 每次對戰前從 MySQL 重新拉一次題目池（確保題庫最新）
  await refreshPickPool(room);
  const q = pickQ(room);

  const bid = `b_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  const battle = {
    id:bid, playerAId:pA.id, playerBId:pB.id,
    q, startAt:Date.now(),
    answers:new Map(), resolved:false, timeoutRef:null,
  };
  room.battles.set(bid,battle);
  room.stats.totalBattles++;

  // Send to players (no correct answer)
  const qClient = { id:q.id, text:q.text, options:q.opts };
  io.to(pA.id).emit('battle:start',{ battleId:bid, opponentId:pB.id, opponentName:pB.name, question:qClient });
  io.to(pB.id).emit('battle:start',{ battleId:bid, opponentId:pA.id, opponentName:pA.name, question:qClient });

  // Notify teachers
  toTeachers(room.id,'teacher:battle_event',{
    battleId:bid, playerAId:pA.id, playerAName:pA.name,
    playerBId:pB.id, playerBName:pB.name, questionText:q.text,
  });

  console.log(`[Battle] ${pA.name} vs ${pB.name} | Q: ${q.id}`);

  battle.timeoutRef = setTimeout(()=>{
    if(!battle.resolved) resolveBattle(room,battle,true);
  }, CONFIG.BATTLE_TIMEOUT+500);
  if (pA.isBot) botAnswerBattle(room, battle, pA.id);
  if (pB.isBot) botAnswerBattle(room, battle, pB.id);
}

function receiveAnswer(room, pid, { battleId, answerId }) {
  const battle = room.battles.get(battleId);
  if(!battle) {
    console.log(`[Battle] Answer ignored: battleId ${battleId} not found (player ${pid})`);
    return;
  }
  if(battle.resolved) {
    console.log(`[Battle] Answer ignored: battle ${battleId} already resolved (player ${pid})`);
    return;
  }
  if(battle.playerAId!==pid&&battle.playerBId!==pid) return;
  if(battle.answers.has(pid)) {
    console.log(`[Battle] Answer ignored: player ${pid} already answered in ${battleId}`);
    return;
  }

  const now   = Date.now();
  const delay = now - battle.startAt;
  // Anti-cheat: < 150ms is bot
  const _p = room.players.get(pid);
  const cheat = !_p?.isBot && delay < 150;
  const isCorrect = cheat ? false : answerId === battle.q.ans;
  battle.answers.set(pid,{ answerId: cheat?'__cheat__':answerId, serverTime:now, isCorrect });
  console.log(`[Battle] Answer received: battle=${battleId} player=${pid} correct=${isCorrect} answers=${battle.answers.size}/2`);

  if(battle.answers.size===2){
    clearTimeout(battle.timeoutRef);
    resolveBattle(room,battle,false);
  }
}

function resolveBattle(room, battle, isTimeout) {
  if(battle.resolved) return;
  battle.resolved = true;

  const pA = room.players.get(battle.playerAId);
  const pB = room.players.get(battle.playerBId);
  if(!pA||!pB){
    if(pA) pA.isLocked=false;
    if(pB) pB.isLocked=false;
    room.battles.delete(battle.id);
    return;
  }

  const ansA = battle.answers.get(pA.id);
  const ansB = battle.answers.get(pB.id);
  let winnerId=null, loserId=null;

  {
    const aC = ansA?.isCorrect || false;
    const bC = ansB?.isCorrect || false;
    const aAnswered = battle.answers.has(pA.id);
    const bAnswered = battle.answers.has(pB.id);

    // 判勝負：bot 對戰時，玩家答對即贏（不與 bot 比速度，因 bot 有人工 delay）
    const aIsBot = pA.isBot || false;
    const bIsBot = pB.isBot || false;
    const humanVsBot = (aIsBot !== bIsBot); // 一人一 bot

    if (aC && !bC)  { winnerId=pA.id; loserId=pB.id; }
    else if (!aC && bC) { winnerId=pB.id; loserId=pA.id; }
    else if (aC && bC) {
      if (humanVsBot) {
        // 玩家 vs bot：答對的人類直接贏，不比速度
        winnerId = aIsBot ? pB.id : pA.id;
        loserId  = aIsBot ? pA.id : pB.id;
      } else {
        // 人類 vs 人類：比速度
        if((ansA?.serverTime||Infinity) <= (ansB?.serverTime||Infinity)){ winnerId=pA.id; loserId=pB.id; }
        else { winnerId=pB.id; loserId=pA.id; }
      }
    } else if (!aAnswered && bC) { winnerId=pB.id; loserId=pA.id; }
    else if (!bAnswered && aC)   { winnerId=pA.id; loserId=pB.id; }
    // 兩者都沒答或都答錯 → 平局
  }

  // Stats
  const st = room.stats;
  if(winnerId) {
    const wAns = battle.answers.get(winnerId);
    if(wAns?.isCorrect) st.correct++;
    if(wAns?.serverTime) st.timesMs.push(wAns.serverTime-battle.startAt);
  }
  if(loserId) {
    const lAns = battle.answers.get(loserId);
    if(lAns && !lAns.isCorrect) st.wrong++;
    if(!lAns) st.timeout++;
  }
  // Per-question stats
  const qid=battle.q.id;
  if(!st.qMap.has(qid)) st.qMap.set(qid,{text:battle.q.text,correct:0,wrong:0,timeout:0});
  const qst=st.qMap.get(qid);
  if(winnerId&&battle.answers.get(winnerId)?.isCorrect) qst.correct++;
  if(loserId&&battle.answers.get(loserId)&&!battle.answers.get(loserId).isCorrect) qst.wrong++;
  if(loserId&&!battle.answers.has(loserId)) qst.timeout++;

  // Damage — loser takes 1HP; on draw (timeout, both wrong/unanswered) both take 1HP
  let loserNewHp=null, loserElim=false;
  if(loserId){
    const loser=room.players.get(loserId);
    loser.hp=Math.max(0,loser.hp-1);
    loserNewHp=loser.hp;
    io.to(room.id).emit('player:hp_update',{ playerId:loserId, newHp:loserNewHp });
    toTeachers(room.id,'teacher:hp_update',{ playerId:loserId, newHp:loserNewHp });
    if(loser.hp<=0) loserElim=true;
  } else if(isTimeout && !winnerId) {
    // Draw on timeout: both lose 1HP
    [pA, pB].forEach(p => {
      p.hp = Math.max(0, p.hp-1);
      io.to(room.id).emit('player:hp_update',{ playerId:p.id, newHp:p.hp });
      toTeachers(room.id,'teacher:hp_update',{ playerId:p.id, newHp:p.hp });
    });
    loserNewHp = null; // signal draw to client
  }
  if(winnerId){
    const w=room.players.get(winnerId);
    if(w){
      w.wins = (w.wins||0)+1;
      w.streak = (w.streak||0)+1;
      // 連勝回血：連勝 3 或 5+ 且未滿血時回復 1 滴
      let healed = false;
      if((w.streak===3 || w.streak>=5) && w.hp < CONFIG.MAX_HP && !w.isBot){
        w.hp = Math.min(CONFIG.MAX_HP, w.hp+1);
        io.to(w.id).emit('player:hp_update', { playerId:w.id, newHp:w.hp });
        toTeachers(room.id,'teacher:hp_update',{ playerId:w.id, newHp:w.hp });
        healed = true;
      }
      // 速度加成：連勝 2+ 給予 speedBoostUntil
      if(w.streak>=2 && !w.isBot){
        const boostSec = w.streak>=5 ? 5000 : 3000;
        w.speedBoostUntil = Date.now() + boostSec;
        io.to(w.id).emit('player:streak', { streak:w.streak, speedBoostMs:boostSec, healed });
      } else if(!w.isBot){
        io.to(w.id).emit('player:streak', { streak:w.streak, speedBoostMs:0, healed });
      }
    }
  }
  if(loserId){
    const l=room.players.get(loserId);
    if(l){ l.streak=0; }
  }
  // draw: 雙方 streak 歸零
  if(!winnerId && !loserId){
    [pA,pB].forEach(p=>{ if(p) p.streak=0; });
  }

  // Result payload
  const result = {
    battleId:battle.id, winnerId, loserId,
    correctAnswer:battle.q.ans,
    winnerTime: winnerId?(battle.answers.get(winnerId)?.serverTime-battle.startAt):null,
    loserTime:  loserId?(battle.answers.get(loserId)?.serverTime-battle.startAt):null,
    loserNewHp, loserEliminated:loserElim,
  };
  io.to(pA.id).emit('battle:result',result);
  io.to(pB.id).emit('battle:result',result);

  // Teacher notification
  const wAns=battle.answers.get(winnerId);
  const lAns=battle.answers.get(loserId);
  toTeachers(room.id,'teacher:battle_result',{
    battleId:battle.id, questionId:qid, questionText:battle.q.text,
    winnerId, winnerName:room.players.get(winnerId)?.name,
    loserId,  loserName:room.players.get(loserId)?.name,
    playerAId:pA.id, playerBId:pB.id,
    winnerAnsweredCorrectly: wAns?.isCorrect||false,
    loserAnsweredWrong:      lAns?!lAns.isCorrect:false,
    loserTimedOut:           loserId&&!battle.answers.has(loserId),
    answerTimeMs:            wAns?(wAns.serverTime-battle.startAt):null,
  });

  console.log(`[Battle] Result: winner=${winnerId?room.players.get(winnerId)?.name:'none'} loser=${loserId?room.players.get(loserId)?.name:'none'}`);

  setTimeout(()=>{
    if(loserElim&&loserId) eliminate(room,loserId);
    const { newA, newB } = knockback(pA,pB,CONFIG.KNOCKBACK_DIST);
    pA.x=newA.x; pA.y=newA.y;
    pB.x=newB.x; pB.y=newB.y;
    // 無論勝負，只要玩家還活著就解鎖
    if(pA.isAlive) { pA.isLocked=false; pA.invincibleUntil = Date.now() + 5000; }
    if(pB.isAlive) { pB.isLocked=false; pB.invincibleUntil = Date.now() + 5000; }
    io.to(pA.id).emit('player:knockback',{ myNewPos:newA });
    io.to(pB.id).emit('player:knockback',{ myNewPos:newB });
    room.battles.delete(battle.id);
  }, 600);  // 縮短至 600ms：讓玩家快速恢復移動，cooldown(3000ms) 仍足夠防止立即重複對戰
}

// ═══════════════════════════════════════════════
//  ANTI-CHEAT: coordinate validation
// ═══════════════════════════════════════════════
function validateMove(p, nx, ny, ts) {
  if(nx<0||nx>CONFIG.MAP_W||ny<0||ny>CONFIG.MAP_H) return false;
  const dt=ts-(p.lastMoveAt||ts);
  const d=Math.hypot(nx-p.x,ny-p.y);
  const maxD=CONFIG.MAX_SPEED_PX_MS*Math.max(dt,CONFIG.SYNC_INTERVAL);
  if(dt>0&&dt<2000&&d>maxD) return false;
  // Wall collision: check room wallSet if available
  const room = p.roomId ? rooms.get(p.roomId) : null;
  if (room && room.wallSet && room.wallSet.size > 0 && room.mapObj) {
    const ts2 = room.mapObj.tileSize || 32;
    const gx  = Math.floor(nx / ts2);
    const gy  = Math.floor(ny / ts2);
    // Check a small radius around the player center (3x3 tiles)
    for (let dy=-1; dy<=1; dy++) {
      for (let dx=-1; dx<=1; dx++) {
        const key = (gx+dx)+','+(gy+dy);
        if (room.wallSet.has(key)) {
          // Check actual pixel overlap with 28px player radius
          const wx = (gx+dx)*ts2, wy = (gy+dy)*ts2;
          if (nx+24 > wx && nx-24 < wx+ts2 && ny+8 > wy && ny-32 < wy+ts2) {
            return false;
          }
        }
      }
    }
  }
  return true;
}

// ═══════════════════════════════════════════════
//  SOCKET: PLAYER CONNECTIONS
// ═══════════════════════════════════════════════
io.on('connection', socket => {
  const role = socket.handshake.query.role;

  // ── TEACHER ──────────────────────────────────
  if(role==='teacher') {
    console.log(`[Teacher] Connect: ${socket.id}`);
    let teacherRoom = null;

    socket.on('teacher:create_room', () => {
      const code = genRoomCode();
      activeCodes.add(code);
      getRoom(code);
      teacherRoom = code;
      socket.join(`teacher_${code}`);
      if (!teachers.has(code)) teachers.set(code, new Set());
      teachers.get(code).add(socket.id);
      socket.emit('teacher:room_created', { roomId: code });
      console.log(`[Room] Teacher created room: ${code}`);
    });

    socket.on('teacher:join', ({ roomId }) => {
      teacherRoom = roomId;
      activeCodes.add(roomId);
      socket.join(`teacher_${roomId}`);
      if(!teachers.has(roomId)) teachers.set(roomId,new Set());
      teachers.get(roomId).add(socket.id);

      // Snapshot
      const room = rooms.get(roomId);
      const snap = room ? buildSnapshot(room) : {
        players:[], gameState:'idle',
        zoneRadius:CONFIG.ZONE_STAGES[0].radius,
        totalBattles:0, totalElim:0,
      };
      socket.emit('teacher:snapshot', snap);
      console.log(`[Teacher] Joined: ${roomId}`);
    });

    socket.on('teacher:game_control', ({ action, roomId }) => {
      const room = rooms.get(roomId) || rooms.get(teacherRoom);
      if(!room) return;
      switch(action){
        case 'start': startGame(room); break;
        case 'pause': pauseGame(room); break;
        case 'stop':  forceEndGame(room); break;
      }
    });

    socket.on('teacher:force_shrink', ({ roomId }) => {
      const room=rooms.get(roomId)||rooms.get(teacherRoom);
      if(room) forceShrink(room);
    });

    socket.on('teacher:broadcast', ({ roomId, message }) => {
      if(!message||message.length>120) return;
      const safe=message.replace(/[<>&"]/g,'');
      io.to(roomId).emit('game:announcement',{ message:safe, from:'Teacher' });
      socket.emit('teacher:broadcast_ack');
      console.log(`[Teacher] Broadcast: "${safe}"`);
    });

    socket.on('teacher:kick_player', ({ playerId }) => {
      const target=io.sockets.sockets.get(playerId);
      if(target){ target.emit('game:kicked',{ reason:'Removed by teacher' }); target.disconnect(true); }
    });

    socket.on('teacher:adjust_hp', ({ playerId, delta, roomId }) => {
      const room=rooms.get(roomId||teacherRoom);
      if(!room) return;
      const p=room.players.get(playerId);
      if(!p||!p.isAlive) return;
      const newHp=Math.max(0,Math.min(CONFIG.MAX_HP,p.hp+delta));
      p.hp=newHp;
      io.to(playerId).emit('player:hp_update',{ playerId, newHp, source:'teacher' });
      toTeachers(room.id,'teacher:hp_update',{ playerId, newHp });
      if(newHp<=0) eliminate(room,playerId);
    });

    // ── QUESTION BANK CRUD (MySQL async) ─────────
    socket.on('qbank:get_all', async () => {
      try {
        socket.emit('qbank:list', await getAllBanksInfo());
      } catch(e) { socket.emit('qbank:error', { msg: e.message }); }
    });

    socket.on('qbank:get_bank', async ({ bankId }) => {
      try {
        const detail = await getBankDetail(bankId);
        if (!detail) { socket.emit('qbank:error', { msg: '找不到題庫' }); return; }
        socket.emit('qbank:bank_detail', detail);
      } catch(e) { socket.emit('qbank:error', { msg: e.message }); }
    });

    socket.on('qbank:create_bank', async ({ name, schoolYear, grade, subject, chapter, description }) => {
      if (!name || !name.trim()) { socket.emit('qbank:error', { msg: '題庫名稱不可空白' }); return; }
      const id = newId('bank_');
      try {
        await pool.query(
          `INSERT INTO banks (id,name,school_year,grade,subject,chapter,description,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [id, name.trim(),
           String(schoolYear||'').trim(), String(grade||'').trim(),
           String(subject||'').trim(),    String(chapter||'').trim(),
           String(description||'').trim(), Date.now()]
        );
        console.log(`[QBank] Created: ${name}`);
        io.emit('qbank:list', await getAllBanksInfo());
        socket.emit('qbank:bank_created', serializeBank(
          { id, name: name.trim(), school_year: String(schoolYear||''), grade: String(grade||''),
            subject: String(subject||''), chapter: String(chapter||''),
            description: String(description||''), created_at: Date.now(), question_count: 0 }, null
        ));
      } catch(e) { socket.emit('qbank:error', { msg: '儲存失敗：' + e.message }); }
    });

    socket.on('qbank:update_bank', async ({ bankId, name, schoolYear, grade, subject, chapter, description }) => {
      try {
        const [[bank]] = await pool.query('SELECT * FROM banks WHERE id = ?', [bankId]);
        if (!bank) { socket.emit('qbank:error', { msg: '找不到題庫' }); return; }
        await pool.query(
          `UPDATE banks SET name=?,school_year=?,grade=?,subject=?,chapter=?,description=? WHERE id=?`,
          [
            name        !== undefined ? name.trim()              : bank.name,
            schoolYear  !== undefined ? String(schoolYear).trim(): bank.school_year,
            grade       !== undefined ? String(grade).trim()     : bank.grade,
            subject     !== undefined ? String(subject).trim()   : bank.subject,
            chapter     !== undefined ? String(chapter).trim()   : bank.chapter,
            description !== undefined ? String(description).trim(): bank.description,
            bankId,
          ]
        );
        io.emit('qbank:list', await getAllBanksInfo());
        const detail = await getBankDetail(bankId);
        socket.emit('qbank:bank_updated', serializeBank(
          { ...detail, school_year: detail.schoolYear, created_at: detail.createdAt,
            question_count: detail.questionCount }, null
        ));
      } catch(e) { socket.emit('qbank:error', { msg: '更新失敗：' + e.message }); }
    });

    socket.on('qbank:delete_bank', async ({ bankId }) => {
      try {
        const [[bank]] = await pool.query('SELECT id FROM banks WHERE id = ?', [bankId]);
        if (!bank) { socket.emit('qbank:error', { msg: '找不到題庫' }); return; }
        await pool.query('DELETE FROM banks WHERE id = ?', [bankId]); // CASCADE 刪 questions
        rooms.forEach(room => room.selectedBankIds.delete(bankId));
        io.emit('qbank:list', await getAllBanksInfo());
        socket.emit('qbank:bank_deleted', { bankId });
      } catch(e) { socket.emit('qbank:error', { msg: '刪除失敗：' + e.message }); }
    });

    socket.on('qbank:add_question', async ({ bankId, text, opts, ans, difficulty, tags }) => {
      if (!text || !text.trim())                   { socket.emit('qbank:error', { msg: '題目不可空白' }); return; }
      if (!Array.isArray(opts) || opts.length < 2) { socket.emit('qbank:error', { msg: '至少需要 2 個選項' }); return; }
      if (!opts.some(o => o.id === ans))           { socket.emit('qbank:error', { msg: '正確答案必須對應選項 ID' }); return; }
      const qid = newId('q_');
      const cleanOpts = opts.map((o,i) => ({ id: o.id||['a','b','c','d'][i], text: String(o.text||'').trim() }));
      try {
        const [[bankRow]] = await pool.query('SELECT id FROM banks WHERE id = ?', [bankId]);
        if (!bankRow) { socket.emit('qbank:error', { msg: '找不到題庫' }); return; }
        await pool.query(
          `INSERT INTO questions (id,bank_id,text,opts,ans,difficulty,tags,created_at) VALUES (?,?,?,?,?,?,?,?)`,
          [qid, bankId, text.trim(), JSON.stringify(cleanOpts), String(ans), difficulty||'medium', String(tags||'').trim(), Date.now()]
        );
        const [[qrow]] = await pool.query('SELECT * FROM questions WHERE id = ?', [qid]);
        const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM questions WHERE bank_id = ?', [bankId]);
        console.log(`[QBank] Q added to ${bankId}: ${text.slice(0,30)}`);
        socket.emit('qbank:question_added', { bankId, question: parseQ(qrow), questionCount: Number(c) });
      } catch(e) { socket.emit('qbank:error', { msg: '儲存失敗：' + e.message }); }
    });

    socket.on('qbank:update_question', async ({ bankId, questionId, text, opts, ans, difficulty, tags }) => {
      try {
        const [[row]] = await pool.query('SELECT * FROM questions WHERE id = ?', [questionId]);
        if (!row) { socket.emit('qbank:error', { msg: '找不到題目' }); return; }
        const cleanOpts = opts
          ? opts.map((o,i) => ({ id: o.id||['a','b','c','d'][i], text: String(o.text||'').trim() }))
          : (typeof row.opts === 'string' ? JSON.parse(row.opts) : row.opts);
        await pool.query(
          `UPDATE questions SET text=?,opts=?,ans=?,difficulty=?,tags=? WHERE id=?`,
          [
            text        ? text.trim()        : row.text,
            JSON.stringify(cleanOpts),
            ans         ? String(ans)         : row.ans,
            difficulty  ? difficulty           : row.difficulty,
            tags !== undefined ? String(tags).trim() : row.tags,
            questionId,
          ]
        );
        const [[updated]] = await pool.query('SELECT * FROM questions WHERE id = ?', [questionId]);
        socket.emit('qbank:question_updated', { bankId, question: parseQ(updated) });
      } catch(e) { socket.emit('qbank:error', { msg: '更新失敗：' + e.message }); }
    });

    socket.on('qbank:delete_question', async ({ bankId, questionId }) => {
      try {
        await pool.query('DELETE FROM questions WHERE id = ?', [questionId]);
        const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM questions WHERE bank_id = ?', [bankId]);
        socket.emit('qbank:question_deleted', { bankId, questionId, questionCount: Number(c) });
      } catch(e) { socket.emit('qbank:error', { msg: '刪除失敗：' + e.message }); }
    });

    // ── 批次匯入試題（CSV/Excel 解析後由 client 傳來）──
    socket.on('qbank:import_questions', async ({ bankId, questions }) => {
      if (!Array.isArray(questions) || questions.length === 0) { socket.emit('qbank:error', { msg: '無有效試題資料' }); return; }
      if (questions.length > 500) { socket.emit('qbank:error', { msg: '單次最多匯入 500 題' }); return; }
      try {
        const [[bankRow]] = await pool.query('SELECT id FROM banks WHERE id = ?', [bankId]);
        if (!bankRow) { socket.emit('qbank:error', { msg: '找不到題庫' }); return; }
      } catch(e) { socket.emit('qbank:error', { msg: e.message }); return; }

      const VALID_DIFF = new Set(['easy','medium','hard']);
      const errors = [];
      const valid  = [];
      const now    = Date.now();

      questions.forEach((q, i) => {
        const rowNum = i + 1;
        if (!q.text || !q.text.trim()) { errors.push(`第 ${rowNum} 題：題目不可空白`); return; }
        if (!Array.isArray(q.opts) || q.opts.filter(o => o.text.trim()).length < 2) { errors.push(`第 ${rowNum} 題：至少需要 2 個非空選項`); return; }
        const ansLower = String(q.ans||'').toLowerCase();
        if (!q.opts.map(o=>o.id.toLowerCase()).includes(ansLower)) { errors.push(`第 ${rowNum} 題「${q.text.slice(0,20)}」：答案「${q.ans}」不在選項中`); return; }
        valid.push([
          newId('q_'), bankId, q.text.trim(),
          JSON.stringify(q.opts.map((o,idx) => ({ id: o.id||['a','b','c','d'][idx], text: String(o.text||'').trim() }))),
          ansLower, VALID_DIFF.has(q.difficulty) ? q.difficulty : 'medium',
          String(q.tags||'').trim(), now,
        ]);
      });

      if (valid.length === 0) { socket.emit('qbank:import_result', { bankId, imported: 0, errors }); return; }

      // MySQL multi-row INSERT transaction
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(
          `INSERT INTO questions (id,bank_id,text,opts,ans,difficulty,tags,created_at) VALUES ?`, [valid]
        );
        await conn.commit();
        const [[{ c }]] = await conn.query('SELECT COUNT(*) AS c FROM questions WHERE bank_id = ?', [bankId]);
        console.log(`[QBank] Imported ${valid.length} questions to ${bankId}`);
        socket.emit('qbank:import_result', { bankId, imported: valid.length, errors, questionCount: Number(c) });
      } catch(e) {
        await conn.rollback();
        socket.emit('qbank:error', { msg: '批次寫入失敗：' + e.message });
      } finally {
        conn.release();
      }
    });

    // ── 設定房間使用的題庫（複選）──
    socket.on('qbank:set_room_banks', async ({ roomId, bankIds }) => {
      const room = rooms.get(roomId || teacherRoom);
      if (!room) { socket.emit('qbank:error', { msg: '找不到房間' }); return; }
      room.selectedBankIds = new Set(Array.isArray(bankIds) ? bankIds : []);
      try {
        let total = 0;
        if (room.selectedBankIds.size > 0) {
          const ids = [...room.selectedBankIds];
          const [[{ c }]] = await pool.query(
            `SELECT COUNT(*) AS c FROM questions WHERE bank_id IN (${ids.map(()=>'?').join(',')})`, ids
          );
          total = Number(c);
        } else {
          const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM questions');
          total = Number(c);
        }
        // 同時刷新題目池
        await refreshPickPool(room);
        toTeachers(room.id, 'qbank:room_banks_updated', { bankIds: [...room.selectedBankIds], totalQuestions: total });
        console.log(`[QBank] Room ${room.id} banks: ${[...room.selectedBankIds].join(',') || '(all)'}`);
      } catch(e) { socket.emit('qbank:error', { msg: e.message }); }
    });

    socket.on('qbank:get_room_banks', async ({ roomId }) => {
      const room = rooms.get(roomId || teacherRoom);
      const bankIds = room ? [...room.selectedBankIds] : [];
      try {
        let total = 0;
        if (bankIds.length > 0) {
          const [[{ c }]] = await pool.query(
            `SELECT COUNT(*) AS c FROM questions WHERE bank_id IN (${bankIds.map(()=>'?').join(',')})`, bankIds
          );
          total = Number(c);
        } else {
          const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM questions');
          total = Number(c);
        }
        socket.emit('qbank:room_banks_updated', { bankIds, totalQuestions: total });
      } catch(e) { socket.emit('qbank:error', { msg: e.message }); }
    });


 
    // ── Bot 設定 ──────────────────────────────────────────
    socket.on('teacher:bot_settings', ({ roomId, botEnabled, botCount }) => {
      const room = getRoom(roomId || teacherRoom);  // getRoom 會自動建立房間
      if (!room) { socket.emit('bot:error', { msg: '找不到房間' }); return; }
      if (room.gameStarted) { socket.emit('bot:error', { msg: '遊戲進行中，無法變更 Bot 設定' }); return; }
      room.botEnabled = !!botEnabled;
      room.botCount   = (botCount===null||botCount===undefined) ? null : Math.max(0,Math.min(parseInt(botCount)||0,CONFIG.MAX_PLAYERS));
      const info = { botEnabled: room.botEnabled, botCount: room.botCount };
      console.log(`[Bot] room=${room.id} botEnabled=${room.botEnabled} botCount=${room.botCount}`);
      toTeachers(room.id, 'bot:settings_updated', info);
      socket.emit('bot:settings_updated', info);  // 也回傳給發送者
      console.log('[Bot] Settings:', JSON.stringify(info));
    });
    socket.on('teacher:get_bot_settings', ({ roomId }) => {
      const room = getRoom(roomId || teacherRoom);  // getRoom 會自動建立房間
      socket.emit('bot:settings_updated', {
        botEnabled: room ? room.botEnabled : true,
        botCount:   room ? room.botCount   : null,
      });
    });
   // ── 地圖選擇 ──────────────────────────────
    socket.on('map:set_room_map', async ({ roomId, mapId }) => {
      const room = rooms.get(roomId || teacherRoom);
      if (!room) { socket.emit('map:error',{ msg:'找不到房間' }); return; }
      if (room.gameStarted) { socket.emit('map:error',{ msg:'選局進行中，無法更換地圖' }); return; }
      try {
        await loadRoomMap(room, mapId||null);
        const info = room.mapObj
          ? { mapId:room.mapId, mapName:room.mapObj.name, mapType:room.mapObj.type }
          : { mapId:null, mapName:'預設地圖', mapType:'default' };
        toTeachers(room.id, 'map:room_map_updated', info);
        socket.emit('map:room_map_updated', info);
      } catch(e) { socket.emit('map:error',{ msg:e.message }); }
    });

    socket.on('map:get_room_map', ({ roomId }) => {
      const room = rooms.get(roomId || teacherRoom);
      const info = room?.mapObj
        ? { mapId:room.mapId, mapName:room.mapObj.name, mapType:room.mapObj.type }
        : { mapId:null, mapName:'預設地圖', mapType:'default' };
      socket.emit('map:room_map_updated', info);
    });
    socket.on('disconnect', () => {
      if(teacherRoom){
        const s=teachers.get(teacherRoom);
        if(s) s.delete(socket.id);
        // 若無其他老師監控此房間，移除有效代碼
        if (!s || s.size === 0) {
          activeCodes.delete(teacherRoom);
          console.log(`[Room] Code ${teacherRoom} deactivated (no teacher)`);
        }
      }
      console.log(`[Teacher] Disconnect: ${socket.id}`);
    });
    return; // Don't continue to player handling
  }

  // ── PLAYER ───────────────────────────────────
  console.log(`[Player] Connect: ${socket.id}`);
  let curRoom=null, curPlayer=null;

  socket.on('player:join', ({ name, roomId }) => {
    const safe=String(name||'Player').slice(0,12).replace(/[<>&"]/g,'');
    const rid = String(roomId||'').trim();
    if (!activeCodes.has(rid)) {
      socket.emit('error', { code: 'INVALID_ROOM', msg: '無效的房間代碼，請確認老師提供的代碼。' });
      return;
    }
    const room=getRoom(rid);

    if(room.players.size>=CONFIG.MAX_PLAYERS){
      socket.emit('error',{ code:'ROOM_FULL' }); return;
    }

    const sp=randSpawn(room);
    const player={
      id:socket.id, name:safe, roomId:room.id,
      x:sp.x, y:sp.y,
      hp:CONFIG.MAX_HP, isAlive:true, isLocked:false,
      wins:0, streak:0, lastMoveAt:Date.now(),
      spectateTargetId:null, cooldowns:new Map(),
    };
    room.players.set(socket.id,player);
    socket.join(room.id);
    curRoom=room; curPlayer=player;

    socket.emit('player:init',{
      id:player.id, name:player.name, x:player.x, y:player.y,
      mapData: room.mapObj ? {
        cols:    room.mapObj.cols,
        rows:    room.mapObj.rows,
        tileSize:room.mapObj.tileSize,
        walls:   room.mapObj.data?.walls   || [],
        spawns:  room.mapObj.data?.spawns  || [],
        portals: room.mapObj.data?.portals || [],
        terrain: room.mapObj.data?.terrain || [],
      } : null,
    });
    toTeachers(room.id,'teacher:player_joined',{
      id:player.id, name:player.name, x:player.x, y:player.y,
      hp:player.hp, isAlive:true, wins:0,
    });
    console.log(`[Join] ${player.name} → ${room.id} (${room.players.size}p)`);

    // Broadcast world immediately for waiting room count
    broadcastWorld(room);
  });

  socket.on('player:char', ({ charKey }) => {
    if (!curPlayer) return;
    // 只接受 char1~char10
    if (/^char([1-9]|10)$/.test(charKey)) {
      curPlayer.charKey = charKey;
    }
  });

  socket.on('player:move', ({ x, y, timestamp }) => {
    if(!curPlayer||!curRoom) return;
    if(!curPlayer.isAlive||curPlayer.isLocked||curRoom.isPaused) return;
    const nx=Number(x), ny=Number(y);
    if(!validateMove(curPlayer,nx,ny,timestamp)){
      socket.emit('player:position_correct',{ x:curPlayer.x, y:curPlayer.y }); return;
    }
    curPlayer.x=nx; curPlayer.y=ny; curPlayer.lastMoveAt=Date.now();

    // Relay to spectators
    curRoom.players.forEach(p=>{
      if(p.spectateTargetId===curPlayer.id)
        io.to(p.id).emit('spectate:sync',{ targetId:curPlayer.id, x:nx, y:ny });
    });

    checkCollisions(curRoom,curPlayer);
  });

  socket.on('battle:answer', data => {
    if(curRoom&&curPlayer) receiveAnswer(curRoom,curPlayer.id,data);
  });

  socket.on('spectate:follow', ({ targetId }) => {
    if(curPlayer&&!curPlayer.isAlive) curPlayer.spectateTargetId=targetId;
  });

  socket.on('disconnect', () => {
    console.log(`[Disconnect] ${socket.id}`);
    if(!curRoom||!curPlayer) return;

    // Resolve any ongoing battles
    curRoom.battles.forEach(battle=>{
      if((battle.playerAId===socket.id||battle.playerBId===socket.id)&&!battle.resolved){
        clearTimeout(battle.timeoutRef);
        const oppId=battle.playerAId===socket.id?battle.playerBId:battle.playerAId;
        const opp=curRoom.players.get(oppId);
        if(opp){
          opp.isLocked=false;
          io.to(oppId).emit('battle:result',{
            battleId:battle.id, winnerId:oppId, loserId:socket.id,
            correctAnswer:battle.q.ans,
            loserNewHp:null, loserEliminated:false,
            reason:'opponent_disconnected',
          });
        }
        battle.resolved=true;
        curRoom.battles.delete(battle.id);
      }
    });

    toTeachers(curRoom.id,'teacher:player_left',{ playerId:socket.id, name:curPlayer.name });
    curRoom.players.delete(socket.id);
    cleanRoom(curRoom);
  });
});

// ═══════════════════════════════════════════════
//  TEACHER SNAPSHOT BUILDER
// ═══════════════════════════════════════════════
function buildSnapshot(room) {
  const st=room.stats;
  const total=st.correct+st.wrong+st.timeout;
  const avgMs=st.timesMs.length>0
    ?Math.round(st.timesMs.reduce((a,b)=>a+b,0)/st.timesMs.length):null;
  const qList=[];
  st.qMap.forEach((v,k)=>qList.push({ qid:k,...v }));

  return {
    players:[...room.players.values()].map(p=>({
      id:p.id, name:p.name, x:p.x, y:p.y,
      hp:p.hp, isAlive:p.isAlive, wins:p.wins||0, inBattle:p.isLocked,
      isBot: p.isBot||false,
    })),
    gameState: room.gameStarted?(room.isPaused?'paused':'running'):'idle',
    zoneRadius: room.zone.currentRadius,
    totalBattles:st.totalBattles, totalElim:st.totalElim,
    globalCorrect:st.correct, globalWrong:st.wrong, globalTimeout:st.timeout,
    totalAnswers:total, avgAnswerMs:avgMs, questionList:qList,
  };
}

// Periodic world + teacher broadcast
setInterval(()=>{
  rooms.forEach(room=>{
    if(room.players.size===0) return;
    broadcastWorld(room);
    // Snapshot to teachers every 2s
    if(teachers.get(room.id)?.size>0){
      toTeachers(room.id,'teacher:snapshot',buildSnapshot(room));
    }
  });
}, CONFIG.SYNC_INTERVAL);

// ═══════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

// ── 啟動前檢查必要環境變數 ────────────────────
// 接受 Zeabur 原生變數 或 本地 DB_* 變數
const hasDB = (process.env.MYSQL_HOST || process.env.DB_HOST) &&
              (process.env.MYSQL_USERNAME || process.env.DB_USER) &&
              (process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD) &&
              (process.env.MYSQL_DATABASE || process.env.DB_NAME);
const missingEnv = hasDB ? [] : ['DB_HOST (或 MYSQL_HOST)', 'DB_USER (或 MYSQL_USERNAME)', 'DB_PASSWORD (或 MYSQL_PASSWORD)', 'DB_NAME (或 MYSQL_DATABASE)'];
if (missingEnv.length > 0) {
  console.error('╔══════════════════════════════════════════════╗');
  console.error('║  ❌  缺少必要的環境變數，請在 Zeabur        ║');
  console.error('║      Variables 頁籤設定以下變數：           ║');
  missingEnv.forEach(k => console.error('║  →  ' + k.padEnd(38) + '║'));
  console.error('╚══════════════════════════════════════════════╝');
  process.exit(1);
}

// 先連 MySQL 建表，再啟動 HTTP server（含重試機制）
async function startServer(retries = 12, delay = 10000) {  // 等最多 2 分鐘讓 MySQL 啟動
  for (let i = 1; i <= retries; i++) {
    try {
      await initDB();
      server.listen(PORT, () => {
        console.log(`
╔═══════════════════════════════════════════╗
║  🎮  BrainRoyale Server  Ready!           ║
║  學生  →  http://localhost:${PORT}           ║
║  教師  →  http://localhost:${PORT}/teacher   ║
║  地圖  →  http://localhost:${PORT}/map-editor║
╚═══════════════════════════════════════════╝`);
      });
      return; // 成功，結束重試
    } catch(err) {
      console.error(`[MySQL] 連線失敗 (${i}/${retries})：${err.message}`);
      if (i === retries) {
        console.error('[MySQL] 已達最大重試次數，請確認環境變數設定正確。');
        process.exit(1);
      }
      console.log(`[MySQL] ${delay/1000} 秒後重試... (${i}/${retries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

startServer();
