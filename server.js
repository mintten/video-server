// server.js
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = 3000;

// MediaSoup workers and routers
let worker;
const rooms = new Map(); // roomId -> { router, peers }

// MediaSoup configuration
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000
    }
  }
];

const webRtcTransportOptions = {
  listenIps: [
    {
      ip: '0.0.0.0',
      announcedIp: '127.0.0.1'
    }
  ],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true
};

// Initialize MediaSoup worker
async function createWorker() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 10000,
    rtcMaxPort: 10100
  });

  console.log(`MediaSoup worker pid: ${worker.pid}`);

  worker.on('died', () => {
    console.error('MediaSoup worker died, exiting...');
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
}

// Create or get room
async function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    const router = await worker.createRouter({ mediaCodecs });
    rooms.set(roomId, {
      router,
      peers: new Map() // socketId -> { username, transports, producers, consumers }
    });
    console.log(`Room created: ${roomId}`);
  }
  return rooms.get(roomId);
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  let currentRoomId = null;
  let currentUsername = null;

  // Join room
  socket.on('join-room', async ({ roomId, username }, callback) => {
    try {
      currentRoomId = roomId;
      currentUsername = username;

      const room = await getOrCreateRoom(roomId);
      
      // Initialize peer data
      room.peers.set(socket.id, {
        username,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map()
      });

      socket.join(roomId);

      // Get RTP capabilities
      const rtpCapabilities = room.router.rtpCapabilities;

      // Notify others in the room
      socket.to(roomId).emit('user-joined', {
        socketId: socket.id,
        username
      });

      // Send existing peers to the new user
      const existingPeers = [];
      room.peers.forEach((peer, peerId) => {
        if (peerId !== socket.id) {
          existingPeers.push({
            socketId: peerId,
            username: peer.username
          });
        }
      });

      callback({
        rtpCapabilities,
        peers: existingPeers
      });

      console.log(`User ${username} joined room ${roomId}`);
    } catch (error) {
      console.error('Error joining room:', error);
      callback({ error: error.message });
    }
  });

  // Create WebRTC transport
  socket.on('create-transport', async ({ roomId, direction }, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) throw new Error('Room not found');

      const transport = await room.router.createWebRtcTransport(webRtcTransportOptions);

      const peer = room.peers.get(socket.id);
      peer.transports.set(transport.id, transport);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });

      console.log(`Transport created: ${transport.id} for ${direction}`);
    } catch (error) {
      console.error('Error creating transport:', error);
      callback({ error: error.message });
    }
  });

  // Connect transport
  socket.on('connect-transport', async ({ roomId, transportId, dtlsParameters }, callback) => {
    try {
      const room = rooms.get(roomId);
      const peer = room.peers.get(socket.id);
      const transport = peer.transports.get(transportId);

      await transport.connect({ dtlsParameters });
      callback({ success: true });
      
      console.log(`Transport connected: ${transportId}`);
    } catch (error) {
      console.error('Error connecting transport:', error);
      callback({ error: error.message });
    }
  });

  // Produce media
  socket.on('produce', async ({ roomId, transportId, kind, rtpParameters }, callback) => {
    try {
      const room = rooms.get(roomId);
      const peer = room.peers.get(socket.id);
      const transport = peer.transports.get(transportId);

      const producer = await transport.produce({ kind, rtpParameters });
      peer.producers.set(producer.id, producer);

      // Notify other peers about new producer
      socket.to(roomId).emit('new-producer', {
        socketId: socket.id,
        producerId: producer.id,
        kind
      });

      callback({ id: producer.id });
      console.log(`Producer created: ${producer.id} (${kind})`);
    } catch (error) {
      console.error('Error producing:', error);
      callback({ error: error.message });
    }
  });

  // Consume media
  socket.on('consume', async ({ roomId, transportId, producerId, rtpCapabilities }, callback) => {
    try {
      const room = rooms.get(roomId);
      const peer = room.peers.get(socket.id);
      const transport = peer.transports.get(transportId);

      // Find the producer
      let producer = null;
      for (const [, p] of room.peers.entries()) {
        if (p.producers.has(producerId)) {
          producer = p.producers.get(producerId);
          break;
        }
      }

      if (!producer) throw new Error('Producer not found');

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Cannot consume');
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true
      });

      peer.consumers.set(consumer.id, consumer);

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });

      console.log(`Consumer created: ${consumer.id}`);
    } catch (error) {
      console.error('Error consuming:', error);
      callback({ error: error.message });
    }
  });

  // Resume consumer
  socket.on('resume-consumer', async ({ roomId, consumerId }, callback) => {
    try {
      const room = rooms.get(roomId);
      const peer = room.peers.get(socket.id);
      const consumer = peer.consumers.get(consumerId);

      await consumer.resume();
      callback({ success: true });
      
      console.log(`Consumer resumed: ${consumerId}`);
    } catch (error) {
      console.error('Error resuming consumer:', error);
      callback({ error: error.message });
    }
  });

  // Get producers in room
  socket.on('get-producers', async ({ roomId }, callback) => {
    try {
      const room = rooms.get(roomId);
      const producers = [];

      room.peers.forEach((peer, peerId) => {
        if (peerId !== socket.id) {
          peer.producers.forEach((producer) => {
            producers.push({
              socketId: peerId,
              producerId: producer.id,
              kind: producer.kind
            });
          });
        }
      });

      callback({ producers });
    } catch (error) {
      console.error('Error getting producers:', error);
      callback({ error: error.message });
    }
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      const peer = room.peers.get(socket.id);

      if (peer) {
        // Close all transports
        peer.transports.forEach((transport) => transport.close());
        
        // Remove peer
        room.peers.delete(socket.id);

        // Notify others
        socket.to(currentRoomId).emit('user-left', {
          socketId: socket.id,
          username: currentUsername
        });

        // Delete room if empty
        if (room.peers.size === 0) {
          room.router.close();
          rooms.delete(currentRoomId);
          console.log(`Room deleted: ${currentRoomId}`);
        }
      }
    }
  });
});

// API endpoint to check room status
app.get('/api/rooms/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms.get(roomId);
  
  if (room) {
    const users = [];
    room.peers.forEach((peer, socketId) => {
      users.push({ socketId, username: peer.username });
    });
    res.json({ exists: true, userCount: room.peers.size, users });
  } else {
    res.json({ exists: false, userCount: 0, users: [] });
  }
});

// Start server
async function startServer() {
  await createWorker();
  
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();