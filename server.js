const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS ayarları
app.use(cors());
app.use(express.json());

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Aktif kullanıcıları ve odaları takip etmek için
const users = new Map(); // nunuk -> socket.id
const rooms = new Map(); // nunuk -> {host: socket.id, viewers: [socket.id]}

io.on('connection', (socket) => {
  console.log('[BAGLANTI] Yeni baglanti:', socket.id);

  // Kullanıcı nunuk oluşturma
  socket.on('create-nunuk', (callback) => {
    const nunuk = generateNunuk();
    users.set(nunuk, socket.id);
    rooms.set(nunuk, { host: socket.id, viewers: [] });
    socket.nunuk = nunuk;
    socket.role = 'host';
    
    console.log(`[NUNUK] Olusturuldu: ${nunuk} (${socket.id})`);
    
    if (callback) {
      callback({ success: true, nunuk });
    }
  });

  // Nunuk ile bağlanma (izleyici)
  socket.on('join-nunuk', ({ nunuk }, callback) => {
    console.log(`[JOIN] Nunuk ile baglanma talebi: ${nunuk} (${socket.id})`);
    
    const room = rooms.get(nunuk);
    
    if (!room) {
      console.log(`[HATA] Nunuk bulunamadi: ${nunuk}`);
      if (callback) {
        callback({ success: false, message: 'Nunuk bulunamadi!' });
      }
      return;
    }

    socket.nunuk = nunuk;
    socket.role = 'viewer';
    room.viewers.push(socket.id);
    
    console.log(`[BASARILI] Izleyici katilds: ${socket.id} -> ${nunuk}`);
    
    // Host'a yeni izleyici geldiğini bildir
    io.to(room.host).emit('viewer-joined', {
      viewerId: socket.id,
      viewerCount: room.viewers.length
    });
    
    if (callback) {
      callback({ success: true, nunuk });
    }
  });

  // WebRTC signaling - offer
  socket.on('offer', ({ offer, targetId }) => {
    console.log(`[WEBRTC] Offer: ${socket.id} -> ${targetId}`);
    io.to(targetId).emit('offer', {
      offer,
      senderId: socket.id
    });
  });

  // WebRTC signaling - answer
  socket.on('answer', ({ answer, targetId }) => {
    console.log(`[WEBRTC] Answer: ${socket.id} -> ${targetId}`);
    io.to(targetId).emit('answer', {
      answer,
      senderId: socket.id
    });
  });

  // WebRTC signaling - ICE candidate
  socket.on('ice-candidate', ({ candidate, targetId }) => {
    io.to(targetId).emit('ice-candidate', {
      candidate,
      senderId: socket.id
    });
  });

  // WebRTC renegotiation - viewer'dan host'a
  socket.on('renegotiate-offer', ({ offer, targetId }) => {
    console.log(`[WEBRTC] Renegotiate Offer: ${socket.id} -> ${targetId}`);
    if (socket.nunuk) {
      const room = rooms.get(socket.nunuk);
      if (room && room.host) {
        // Viewer'dan host'a renegotiation offer gönder
        io.to(room.host).emit('renegotiate-offer', {
          offer,
          senderId: socket.id
        });
        console.log(`[WEBRTC] Renegotiate offer gonderildi: ${socket.id} -> ${room.host}`);
      }
    }
  });

  // WebRTC renegotiation - host'tan viewer'a answer
  socket.on('renegotiate-answer', ({ answer, targetId }) => {
    console.log(`[WEBRTC] Renegotiate Answer: ${socket.id} -> ${targetId}`);
    io.to(targetId).emit('renegotiate-answer', {
      answer,
      senderId: socket.id
    });
  });

  // Ekran paylaşımı başladı
  socket.on('start-sharing', ({ settings }) => {
    if (socket.role === 'host' && socket.nunuk) {
      const room = rooms.get(socket.nunuk);
      if (room) {
        console.log(`[PAYLASIM] Basladi: ${socket.nunuk}`);
        room.viewers.forEach(viewerId => {
          io.to(viewerId).emit('sharing-started', { settings });
        });
      }
    }
  });

  // Ekran paylaşımı durdu
  socket.on('stop-sharing', () => {
    if (socket.role === 'host' && socket.nunuk) {
      const room = rooms.get(socket.nunuk);
      if (room) {
        console.log(`[PAYLASIM] Durdu: ${socket.nunuk}`);
        room.viewers.forEach(viewerId => {
          io.to(viewerId).emit('sharing-stopped');
        });
      }
    }
  });

  // Audio durumu değişti (mute/unmute)
  socket.on('audio-state-changed', ({ isMuted, userId, role }) => {
    console.log(`[AUDIO] ${userId} ses durumu: ${isMuted ? 'Kapalı' : 'Açık'}`);
    
    if (socket.nunuk) {
      const room = rooms.get(socket.nunuk);
      if (room) {
        // Tüm katılımcılara bildir
        const targets = role === 'host' ? room.viewers : [room.host, ...room.viewers.filter(id => id !== socket.id)];
        targets.forEach(targetId => {
          io.to(targetId).emit('participant-audio-changed', {
            userId: socket.id,
            isMuted,
            role
          });
        });
      }
    }
  });

  // Konuşma aktivitesi (ses seviyesi)
  socket.on('speaking-state', ({ isSpeaking, level }) => {
    if (socket.nunuk) {
      const room = rooms.get(socket.nunuk);
      if (room) {
        const targets = socket.role === 'host' ? room.viewers : [room.host];
        targets.forEach(targetId => {
          io.to(targetId).emit('participant-speaking', {
            userId: socket.id,
            isSpeaking,
            level,
            role: socket.role
          });
        });
      }
    }
  });

  // Chat mesajı gönderme
  socket.on('chat-message', ({ message, senderName, senderRole }) => {
    console.log('[CHAT] ===== MESAJ ALINDI =====');
    console.log('[CHAT] Socket ID:', socket.id);
    console.log('[CHAT] Socket nunuk:', socket.nunuk);
    console.log('[CHAT] Sender Role:', senderRole);
    console.log('[CHAT] Message:', message.substring(0, 50));
    
    if (!socket.nunuk) {
      console.error('[CHAT] ❌ HATA: Socket\'in nunuk\'u yok!');
      console.error('[CHAT] Aktif odalar:', Array.from(rooms.keys()));
      
      // Manuel nunuk bulma denemesi
      let foundNunuk = null;
      rooms.forEach((room, nunuk) => {
        if (room.host === socket.id || room.viewers.includes(socket.id)) {
          foundNunuk = nunuk;
          console.log('[CHAT] Socket bu odada bulundu:', nunuk);
        }
      });
      
      if (foundNunuk) {
        console.log('[CHAT] Nunuk manuel olarak ayarlaniyor:', foundNunuk);
        socket.nunuk = foundNunuk;
      } else {
        console.error('[CHAT] ❌ Socket hicbir odada bulunamadi!');
        return;
      }
    }

    const room = rooms.get(socket.nunuk);
    if (!room) {
      console.error('[CHAT] ❌ HATA: Oda bulunamadi:', socket.nunuk);
      console.error('[CHAT] Mevcut odalar:', Array.from(rooms.keys()));
      return;
    }
    
    console.log('[CHAT] ✅ Oda bulundu:', socket.nunuk);
    console.log('[CHAT] Host:', room.host);
    console.log('[CHAT] Viewers:', room.viewers);

    const chatMessage = {
      id: Date.now() + Math.random(), // Unique ID
      message,
      senderName: senderName || (senderRole === 'host' ? 'Host' : 'Izleyici'),
      senderRole,
      senderId: socket.id,
      timestamp: new Date().toISOString()
    };

    console.log(`[CHAT] ===== MESAJ HAZIRLANDI =====`);
    console.log(`[CHAT] Mesaj icerigi:`, chatMessage);
    console.log(`[CHAT] Odadakiler - Host: ${room.host}, Viewers: [${room.viewers.join(', ')}]`);

    // Karşı tarafa gönder
    if (senderRole === 'host') {
      // Host mesaj gönderdi, tüm izleyicilere ilet
      console.log(`[CHAT] 📡 HOST MESAJI GONDERILIYOR`);
      console.log(`[CHAT] Hedef viewer sayisi: ${room.viewers.length}`);
      
      if (room.viewers.length === 0) {
        console.warn('[CHAT] ⚠️ DIKKAT: Hic viewer yok!');
      }
      
      room.viewers.forEach((viewerId, index) => {
        console.log(`[CHAT] -> [${index + 1}/${room.viewers.length}] Viewer'a emit: ${viewerId}`);
        const result = io.to(viewerId).emit('chat-message', chatMessage);
        console.log(`[CHAT]    Emit result:`, result ? 'Success' : 'Failed');
      });
      
      console.log(`[CHAT] ✅ ${room.viewers.length} viewer'a gonderildi`);
    } else {
      // Viewer mesaj gönderdi
      console.log(`[CHAT] 👁️ VIEWER MESAJI GONDERILIYOR`);
      
      // Host'a gönder
      console.log(`[CHAT] -> Host'a emit: ${room.host}`);
      const hostResult = io.to(room.host).emit('chat-message', chatMessage);
      console.log(`[CHAT]    Host emit result:`, hostResult ? 'Success' : 'Failed');
      
      // Diğer viewer'lara gönder
      const otherViewers = room.viewers.filter(id => id !== socket.id);
      console.log(`[CHAT] -> Diger ${otherViewers.length} viewer'a gonderiliyor`);
      
      otherViewers.forEach((viewerId, index) => {
        console.log(`[CHAT]    [${index + 1}/${otherViewers.length}] Viewer'a emit: ${viewerId}`);
        io.to(viewerId).emit('chat-message', chatMessage);
      });
      
      console.log(`[CHAT] ✅ Host + ${otherViewers.length} viewer'a gonderildi`);
    }
    
    console.log('[CHAT] ===== MESAJ GONDERME TAMAMLANDI =====');
  });

  // Yazıyor göstergesi
  socket.on('typing', ({ senderName, senderRole }) => {
    if (!socket.nunuk) return;

    const room = rooms.get(socket.nunuk);
    if (!room) return;

    const typingData = {
      senderName: senderName || (senderRole === 'host' ? 'Host' : 'Izleyici'),
      senderRole,
      senderId: socket.id
    };

    // Diğer katılımcılara bildir
    if (senderRole === 'host') {
      room.viewers.forEach(viewerId => {
        io.to(viewerId).emit('typing', typingData);
      });
    } else {
      io.to(room.host).emit('typing', typingData);
    }
  });

  // Bağlantı koptuğunda
  socket.on('disconnect', () => {
    console.log('[DISCONNECT] Baglanti koptu:', socket.id);
    
    if (socket.nunuk) {
      const room = rooms.get(socket.nunuk);
      
      if (room) {
        if (socket.role === 'host') {
          // Host ayrıldı, tüm izleyicilere bildir
          room.viewers.forEach(viewerId => {
            io.to(viewerId).emit('host-disconnected');
          });
          rooms.delete(socket.nunuk);
          users.delete(socket.nunuk);
          console.log(`[ODA] Kapatildi: ${socket.nunuk}`);
        } else if (socket.role === 'viewer') {
          // İzleyici ayrıldı
          room.viewers = room.viewers.filter(id => id !== socket.id);
          io.to(room.host).emit('viewer-left', {
            viewerId: socket.id,
            viewerCount: room.viewers.length
          });
        }
      }
    }
  });
});

// Benzersiz nunuk oluştur (6 haneli)
function generateNunuk() {
  let nunuk;
  do {
    nunuk = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (users.has(nunuk));
  return nunuk;
}

// Sağlık kontrolü endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    activeRooms: rooms.size,
    activeUsers: users.size,
    timestamp: new Date().toISOString()
  });
});

// Ana sayfa
app.get('/', (req, res) => {
  res.send('Backend calisiyor! Frontend icin http://localhost:3000 adresini kullanin.');
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log('================================');
  console.log('EKRAN PAYLASIMI BACKEND SUNUCU');
  console.log('================================');
  console.log(`Port: ${PORT}`);
  console.log(`URL: http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log('================================');
});
