// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const app = express();
const server = http.createServer(app);

// 配置Socket.IO，允许跨域
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 存储用户和连接信息
const users = new Map();
const banList = new Set();
const config = {
  maxUsers: 2000,
  banWords: [],
  maxMessageLength: 2000,
  userPasswords: {},
  adminPassword: 'admin',
  bannedIPs: [],
  historyCount: 30 // 新增：默认显示最近30条记录
};

// 加载配置
try {
  const configData = fs.readFileSync('config.json', 'utf8');
  Object.assign(config, JSON.parse(configData));
} catch (err) {
  console.log('使用默认配置');
}

// 设置静态文件目录
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 主页路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 管理员页面


// 辅助函数：持久化配置
function saveConfig() {
  fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
}

// 新增：加载历史记录（只加载最近 config.historyCount 条记录）
let messageHistory = [];
try {
  if (fs.existsSync('history.json')) {
    const historyData = fs.readFileSync('history.json', 'utf8');
    messageHistory = JSON.parse(historyData);
  }
} catch (err) {
  console.log('加载历史记录失败，使用空记录');
}

// 新增：持久化历史记录到 history.json
function saveHistory() {
  const recentHistory = messageHistory.slice(-config.historyCount);
  fs.writeFileSync('history.json', JSON.stringify(recentHistory, null, 2));
}

// Socket.IO连接处理
io.on('connection', (socket) => {
  console.log('新连接:', socket.id);
  
  // 用户登录
  socket.on('login', (data) => {
    let username, password;
    if (typeof data === 'string') {
      username = data;
      password = "";
    } else {
      username = data.username;
      password = data.password || "";
    }
    
    // 禁止用户名中含有非ASCII字符
    if (/[^\x00-\x7F]/.test(username)) {
      socket.emit('error', '用户名包含非ASCII字符');
      return;
    }
    
    // 新增：验证用户名最多16字符
    if (username.length > 16) {
      socket.emit('error', '用户名最多16字符');
      return;
    }

    // 禁止相同名字的用户登录
    for (const user of users.values()) {
      if (user.username === username) {
        socket.emit('error', '该用户名已登录');
        return;
      }
    }
    
    // 检查是否被封禁
    if (banList.has(socket.handshake.address)) {
      socket.emit('error', '您已被封禁');
      socket.disconnect();
      return;
    }
    
    // 如果该用户名设置了密码，则验证
    if (config.userPasswords[username] && config.userPasswords[username] !== password) {
      socket.emit('error', '密码错误');
      return;
    }
    
    // 检查用户数限制
    if (users.size >= config.maxUsers) {
      socket.emit('error', '服务器已满');
      socket.disconnect();
      return;
    }
    
    // 存储用户信息
    users.set(socket.id, {
      username,
      ip: socket.handshake.address,
      connectedAt: new Date()
    });
    
    // 登录成功后发送最近聊天记录
    socket.emit('history', messageHistory.slice(-config.historyCount));
    
    // 广播用户加入
    io.emit('system', `${username} 加入了聊天室`);
    // 发送当前用户列表
    io.emit('userList', Array.from(users.values()).map(u => u.username));
  });
  
  // 接收消息
  socket.on('message', (message) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    // 检查消息长度
    if (message.length > config.maxMessageLength) {
      socket.emit('error', `消息过长，最大长度为 ${config.maxMessageLength} 字符`);
      return;
    }
    
    // 检查敏感词
    const hasBanWord = config.banWords.some(word => 
      message.toLowerCase().includes(word.toLowerCase())
    );
    if (hasBanWord) {
      socket.emit('error', '消息包含敏感词');
      return;
    }
    
    // 处理@功能
    const mentionRegex = /@([A-Za-z0-9_]{1,16})/g;
    let match;
    const mentions = [];
    while ((match = mentionRegex.exec(message)) !== null) {
      mentions.push(match[1]);
    }
    if (mentions.length > 0) {
      const validMentions = mentions.filter(name =>
        Array.from(users.values()).some(u => u.username === name)
      );
      if (validMentions.length === 0) {
        socket.emit('error', '消息中提及的用户不存在');
        return;
      }
      // 通知被@的用户
      for (const name of validMentions) {
        for (const [id, u] of users) {
          if (u.username === name && id !== socket.id) {
            io.to(id).emit('at', { from: user.username, message });
          }
        }
      }
    }
    
    // 构造消息对象
    const msgData = {
      username: user.username,
      content: message,
      time: new Date().toLocaleTimeString()
    };
    // 保存消息记录
    messageHistory.push(msgData);
    if (messageHistory.length > config.historyCount) {
      messageHistory = messageHistory.slice(-config.historyCount);
    }
    saveHistory();
    
    // 广播消息
    io.emit('message', msgData);
  });
  
  // 断开连接处理
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      io.emit('system', `${user.username} 离开了聊天室`);
      users.delete(socket.id);
      io.emit('userList', Array.from(users.values()).map(u => u.username));
    }
    console.log('连接断开:', socket.id);
  });
});

// 管理员接口中间件：验证 admin 密码
function adminAuth(req, res, next) {
  const { adminPassword } = req.body;
  if (adminPassword !== config.adminPassword) {
    return res.status(403).json({ error: '无效的管理员密码' });
  }
  next();
}

// 封禁IP或IP段
app.post('/admin/ban', adminAuth, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: '缺少 ip 参数' });
  if (!config.bannedIPs.includes(ip)) {
    config.bannedIPs.push(ip);
    banList.add(ip);
    saveConfig();
  }
  res.json({ success: true });
});

// 解封IP或IP段
app.post('/admin/unban', adminAuth, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: '缺少 ip 参数' });
  config.bannedIPs = config.bannedIPs.filter(i => i !== ip);
  banList.delete(ip);
  saveConfig();
  res.json({ success: true });
});

// 为指定用户名设置密码（密码可置空表示无密码）
app.post('/admin/setUserPassword', adminAuth, (req, res) => {
  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: '缺少 username 参数' });
  config.userPasswords[username] = password || "";
  saveConfig();
  res.json({ success: true });
});

// 添加敏感词
app.post('/admin/banWord/add', adminAuth, (req, res) => {
  const { word } = req.body;
  if (!word) return res.status(400).json({ error: '缺少 word 参数' });
  if (!config.banWords.includes(word)) {
    config.banWords.push(word);
    saveConfig();
  }
  res.json({ success: true });
});

// 删除敏感词
app.post('/admin/banWord/remove', adminAuth, (req, res) => {
  const { word } = req.body;
  if (!word) return res.status(400).json({ error: '缺少 word 参数' });
  config.banWords = config.banWords.filter(w => w !== word);
  saveConfig();
  res.json({ success: true });
});

// 更新最大连接数、最大消息长度和历史记录数量
app.post('/admin/updateConfig', adminAuth, (req, res) => {
  const { maxUsers, maxMessageLength, historyCount } = req.body;
  if (maxUsers !== undefined) config.maxUsers = maxUsers;
  if (maxMessageLength !== undefined) config.maxMessageLength = maxMessageLength;
  if (historyCount !== undefined) config.historyCount = historyCount;
  saveConfig();
  res.json({ success: true });
});

// 修改admin密码
app.post('/admin/changeAdminPassword', adminAuth, (req, res) => {
  const { newAdminPassword } = req.body;
  if (!newAdminPassword) return res.status(400).json({ error: '缺少 newAdminPassword 参数' });
  config.adminPassword = newAdminPassword;
  saveConfig();
  res.json({ success: true });
});

// 新增管理员信息接口，返回敏感词列表、在线用户数和系统配置
app.get('/admin/info', (req, res) => {
  const { adminPassword } = req.query;
  if (adminPassword !== config.adminPassword) {
    return res.status(403).json({ error: '无效的管理员密码' });
  }
  res.json({
    banWords: config.banWords,
    onlineUsers: users.size,
    config: {
      maxUsers: config.maxUsers,
      maxMessageLength: config.maxMessageLength,
      historyCount: config.historyCount // 新增：历史记录条数
    }
  });
});

// 管理页面路由，返回管理页面文件
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 启动服务器
let PORT = parseInt(process.argv[2], 0); // 从命令行获取端口
if (isNaN(PORT)) {
  PORT = 8849; // 默认端口
}
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log('WebSocket服务已启动，与HTTP服务无冲突');
});