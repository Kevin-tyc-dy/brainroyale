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
  BATTLE_COOLDOWN:  3000,
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
// NO-DB MODE
// 題庫 + 地圖：記憶體儲存
const memBanks     = new Map();
const memQuestions = new Map();
const memMaps      = new Map();
function memId() { return Date.now().toString(36)+Math.random().toString(36).slice(2,5); }

// ── 建表（首次啟動自動建立，已存在則跳過）──────
async function initDB() { /* NO-DB */ }

async function seedData() { /* NO-DB */ }

async function getAllBanksInfo() {
  return [...memBanks.values()].map(b => ({...b,
    questionCount:[...memQuestions.values()].filter(q=>q.bankId===b.id).length, questions:[]}));
}

async function getBankDetail(bankId) {
  const b = memBanks.get(bankId); if (!b) return null;
  const qs = [...memQuestions.values()].filter(q=>q.bankId===bankId);
  return {...b, questionCount:qs.length, questions:qs};
}

const SAMPLE_QUESTIONS = [
  {id:'sq1',bankId:'sample',text:'1 + 1 = ?',opts:[{id:'A',text:'1'},{id:'B',text:'2'},{id:'C',text:'3'},{id:'D',text:'4'}],ans:'B',difficulty:'easy'},
  {id:'sq2',bankId:'sample',text:'台灣的首都是？',opts:[{id:'A',text:'台北'},{id:'B',text:'台中'},{id:'C',text:'高雄'},{id:'D',text:'台南'}],ans:'A',difficulty:'easy'},
  {id:'sq3',bankId:'sample',text:'2 × 8 = ?',opts:[{id:'A',text:'14'},{id:'B',text:'16'},{id:'C',text:'18'},{id:'D',text:'20'}],ans:'B',difficulty:'easy'},
  {id:'sq4',bankId:'sample',text:'水的化學式是？',opts:[{id:'A',text:'CO2'},{id:'B',text:'H2O'},{id:'C',text:'O2'},{id:'D',text:'NaCl'}],ans:'B',difficulty:'medium'},
  {id:'sq5',bankId:'sample',text:'地球是第幾顆行星？',opts:[{id:'A',text:'第一顆'},{id:'B',text:'第二顆'},{id:'C',text:'第三顆'},{id:'D',text:'第四顆'}],ans:'C',difficulty:'medium'},
  {id:'sq6',bankId:'sample',text:'光速約為每秒幾公里？',opts:[{id:'A',text:'30萬'},{id:'B',text:'3萬'},{id:'C',text:'300萬'},{id:'D',text:'3000萬'}],ans:'A',difficulty:'hard'},
];

async function refreshPickPool(room) {
  const bankIds = room.selectedBankIds && room.selectedBankIds.size>0
    ? [...room.selectedBankIds] : [...memBanks.keys()];
  room.questionPool = [...memQuestions.values()].filter(q=>bankIds.includes(q.bankId));
  if (room.questionPool.length===0) room.questionPool = [...SAMPLE_QUESTIONS];
  console.log(`[QBank] Pool: ${room.questionPool.length} questions`);
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
      botTargetId: null,
      botWanderAngle: Math.random() * Math.PI * 2,
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

app.get('/api/maps', async (req, res) => {
  res.json([...memMaps.values()].map(({data,...m})=>m).sort((a,b)=>a.createdAt-b.createdAt));
});

app.get('/api/maps/:id', async (req, res) => {
  const m=memMaps.get(req.params.id);
  if(!m) return res.status(404).json({error:'地圖不存在'});
  res.json(m);
});

app.post('/api/maps', async (req, res) => {
  const { name,type,cols,rows,tileSize,autoFillBots,data } = req.body;
  if (!name||!name.trim()) return res.status(400).json({error:'地圖名稱不可空白'});
  const id=newMapId(), now=Date.now();
  const m={id,name:name.trim(),type:type||'room',cols:cols||40,rows:rows||30,
    tileSize:tileSize||32,autoFillBots:autoFillBots!==false,data:data||{},createdAt:now,updatedAt:now};
  memMaps.set(id,m);
  res.status(201).json({id,name:m.name,type:m.type,createdAt:now});
});

app.put('/api/maps/:id', async (req, res) => {
  const { name,type,cols,rows,tileSize,autoFillBots,data } = req.body;
  const ex=memMaps.get(req.params.id);
  if(!ex) return res.status(404).json({error:'地圖不存在'});
  const now=Date.now();
  const m={...ex,name:name||'未命名',type:type||'room',cols:cols||40,rows:rows||30,
    tileSize:tileSize||32,autoFillBots:autoFillBots!==false,data:data||{},updatedAt:now};
  memMaps.set(req.params.id,m); mapCache.delete(req.params.id);
  res.json({id:req.params.id,name,updatedAt:now});
});

app.delete('/api/maps/:id', async (req, res) => {
  const ex=memMaps.get(req.params.id);
  if(!ex) return res.status(404).json({error:'地圖不存在'});
  memMaps.delete(req.params.id); mapCache.delete(req.params.id);
  res.json({deleted:req.params.id});
});

// Map cache & helpers
const mapCache = new Map();

async function getMapCached(mapId) {
  if (mapCache.has(mapId)) return mapCache.get(mapId);
  const m = memMaps.get(mapId); if (!m) return null;
  mapCache.set(mapId, m); return m;
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
  const m = 320;
  return { x: m + Math.random()*(CONFIG.MAP_W-m*2), y: m + Math.random()*(CONFIG.MAP_H-m*2) };
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
  const cl=(v,mn,mx)=>Math.max(mn,Math.min(mx,v));
  const p=24;
  return {
    newA:{ x:cl(pA.x-nx*d,p,CONFIG.MAP_W-p), y:cl(pA.y-ny*d,p,CONFIG.MAP_H-p) },
    newB:{ x:cl(pB.x+nx*d,p,CONFIG.MAP_W-p), y:cl(pB.y+ny*d,p,CONFIG.MAP_H-p) },
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
      list.push({ id:p.id, name:p.name, x:p.x, y:p.y, hp:p.hp, isAlive:p.isAlive });
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
  room.players.forEach(other=>{
    if(other.id===mover.id||!other.isAlive||other.isLocked) return;
    const cd = mover.cooldowns.get(other.id)||0;
    if(Date.now()-cd < CONFIG.BATTLE_COOLDOWN) return;
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

  if(!isTimeout || battle.answers.size>0){
    const aC = ansA?.isCorrect||false;
    const bC = ansB?.isCorrect||false;
    if(aC&&!bC)       { winnerId=pA.id; loserId=pB.id; }
    else if(!aC&&bC)  { winnerId=pB.id; loserId=pA.id; }
    else if(aC&&bC)   {
      if((ansA.serverTime||Infinity)<=(ansB.serverTime||Infinity)){ winnerId=pA.id; loserId=pB.id; }
      else { winnerId=pB.id; loserId=pA.id; }
    }
    // both wrong/timeout → draw
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

  // Damage
  let loserNewHp=null, loserElim=false;
  if(loserId){
    const loser=room.players.get(loserId);
    loser.hp=Math.max(0,loser.hp-1);
    loserNewHp=loser.hp;
    io.to(room.id).emit('player:hp_update',{ playerId:loserId, newHp:loserNewHp });
    toTeachers(room.id,'teacher:hp_update',{ playerId:loserId, newHp:loserNewHp });
    if(loser.hp<=0) loserElim=true;
  }
  if(winnerId){ const w=room.players.get(winnerId); if(w) w.wins=(w.wins||0)+1; }

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
    if(pA.isAlive) pA.isLocked=false;
    if(pB.isAlive) pB.isLocked=false;
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

    socket.on('teacher:join', ({ roomId }) => {
      teacherRoom = roomId;
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
      const room = rooms.get(roomId);
      if(!room) return;
      switch(action){
        case 'start': startGame(room); break;
        case 'pause': pauseGame(room); break;
        case 'stop':  forceEndGame(room); break;
      }
    });

    socket.on('teacher:force_shrink', ({ roomId }) => {
      const room=rooms.get(roomId);
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
    // ── 題庫（記憶體版）─────────────────────────────
    socket.on('qbank:get_all', async () => {
      socket.emit('qbank:list', await getAllBanksInfo());
    });
    socket.on('qbank:get_bank', async ({ bankId }) => {
      const b = await getBankDetail(bankId);
      if (b) socket.emit('qbank:bank_detail', b);
    });
    socket.on('qbank:create_bank', async ({ name, schoolYear, grade, subject, chapter, description }) => {
      const id=memId(), now=Date.now();
      const b={id,name:name||'新題庫',schoolYear:schoolYear||'',grade:grade||'',
        subject:subject||'',chapter:chapter||'',description:description||'',createdAt:now,questionCount:0};
      memBanks.set(id,b);
      socket.emit('qbank:bank_created',b);
      socket.emit('qbank:list', await getAllBanksInfo());
    });
    socket.on('qbank:update_bank', async ({ bankId, name, schoolYear, grade, subject, chapter, description }) => {
      const b=memBanks.get(bankId); if(!b) return;
      Object.assign(b,{name,schoolYear,grade,subject,chapter,description});
      socket.emit('qbank:bank_updated',b);
      socket.emit('qbank:list', await getAllBanksInfo());
    });
    socket.on('qbank:delete_bank', async ({ bankId }) => {
      memBanks.delete(bankId);
      for(const [qid,q] of memQuestions){ if(q.bankId===bankId) memQuestions.delete(qid); }
      socket.emit('qbank:bank_deleted',{bankId});
      socket.emit('qbank:list', await getAllBanksInfo());
    });
    socket.on('qbank:add_question', async ({ bankId, text, opts, ans, difficulty, tags }) => {
      const id=memId(), now=Date.now();
      const q={id,bankId,text,opts:opts||[],ans,difficulty:difficulty||'medium',tags:tags||'',createdAt:now};
      memQuestions.set(id,q);
      socket.emit('qbank:question_added',q);
      socket.emit('qbank:bank_detail', await getBankDetail(bankId));
    });
    socket.on('qbank:update_question', async ({ questionId, text, opts, ans, difficulty, tags }) => {
      const q=memQuestions.get(questionId); if(!q) return;
      Object.assign(q,{text,opts,ans,difficulty,tags});
      socket.emit('qbank:question_updated',q);
      socket.emit('qbank:bank_detail', await getBankDetail(q.bankId));
    });
    socket.on('qbank:delete_question', async ({ questionId }) => {
      const q=memQuestions.get(questionId); if(!q) return;
      const bankId=q.bankId; memQuestions.delete(questionId);
      socket.emit('qbank:question_deleted',{questionId});
      socket.emit('qbank:bank_detail', await getBankDetail(bankId));
    });
    socket.on('qbank:import_questions', async ({ bankId, questions }) => {
      let added=0;
      for(const q of (questions||[])){
        const id=memId();
        memQuestions.set(id,{id,bankId,text:q.text||'',opts:q.opts||[],
          ans:q.ans||'A',difficulty:q.difficulty||'medium',tags:q.tags||'',createdAt:Date.now()});
        added++;
      }
      socket.emit('qbank:import_result',{success:true,added});
      socket.emit('qbank:bank_detail', await getBankDetail(bankId));
    });
    socket.on('qbank:set_room_banks', async ({ roomId, bankIds }) => {
      const room=rooms.get(roomId||teacherRoom); if(!room) return;
      room.selectedBankIds=new Set(bankIds||[]);
      await refreshPickPool(room);
      socket.emit('qbank:room_banks_updated',{roomId:room.id,bankIds:[...room.selectedBankIds]});
    });
    socket.on('qbank:get_room_banks', async ({ roomId }) => {
      const room=rooms.get(roomId||teacherRoom);
      socket.emit('qbank:room_banks_updated',{roomId,bankIds:room?[...room.selectedBankIds]:[]});
    });

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
    const room=getRoom(roomId||'default');

    if(room.players.size>=CONFIG.MAX_PLAYERS){
      socket.emit('error',{ code:'ROOM_FULL' }); return;
    }

    const sp=randSpawn(room);
    const player={
      id:socket.id, name:safe, roomId:room.id,
      x:sp.x, y:sp.y,
      hp:CONFIG.MAX_HP, isAlive:true, isLocked:false,
      wins:0, lastMoveAt:Date.now(),
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
        walls:   room.mapObj.data?.walls  || [],
        spawns:  room.mapObj.data?.spawns  || [],
        portals: room.mapObj.data?.portals || [],
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
// NO-DB: 跳過環境變數檢查

// 先連 MySQL 建表，再啟動 HTTP server（含重試機制）
// NO-DB: 直接啟動
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║  🎮  BrainRoyale  Ready!  [NO-DB MODE]     ║
║  學生  →  http://localhost:${PORT}            ║
║  教師  →  http://localhost:${PORT}/teacher    ║
║  地圖  →  http://localhost:${PORT}/map-editor ║
║  ⚠  記憶體模式：重啟後資料清空             ║
╚════════════════════════════════════════════╝`);
});
