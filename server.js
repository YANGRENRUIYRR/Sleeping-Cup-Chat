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
    origin: "http://localhost:8848",
    methods: ["GET", "POST"]
  }
});

// 存储用户和连接信息
const users = new Map();
const banList = new Set();
const config = {
  maxUsers: 50,
  banWords: [],
  maxMessageLength: 2000
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

// 主页路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 管理员页面


// Socket.IO连接处理
io.on('connection', (socket) => {
  console.log('新连接:', socket.id);
  
  // 用户登录
  socket.on('login', (username) => {
    // 检查是否被封禁
    if (banList.has(socket.handshake.address)) {
      socket.emit('error', '您已被封禁');
      socket.disconnect();
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
    
    // 广播消息
    io.emit('message', {
      username: user.username,
      content: message,
      time: new Date().toLocaleTimeString()
    });
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

// 启动服务器
const PORT = 8848;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log('WebSocket服务已启动，与HTTP服务无冲突');
});