// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://prithvipatil494_db_user:rankalaismybestfriend@cluster0.ozmxva5.mongodb.net/?appName=Cluster0';

mongoose.connect(MONGODB_URI)
.then(async () => {
  console.log('✅ MongoDB connected');
})
.catch(err => {
  console.error('❌ MongoDB connection error:', err.message);
});

// Location Schema
const locationSchema = new mongoose.Schema({
  trackId: {
    type: String,
    required: true
  },
  lat: {
    type: Number,
    required: true
  },
  lng: {
    type: Number,
    required: true
  },
  speed: {
    type: Number,
    default: 0
  },
  accuracy: {
    type: Number,
    default: 0
  },
  heading: {
    type: Number,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

locationSchema.index({ trackId: 1, timestamp: -1 });
locationSchema.index({ timestamp: 1 }, { expireAfterSeconds: 86400 });

const Location = mongoose.model('Location', locationSchema);

// NEW: User Session Schema to persist tracked users
const userSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    default: 'default-session'
  },
  trackedUsers: [{
    trackId: {
      type: String,
      required: true
    },
    color: {
      type: String,
      required: true
    },
    displayName: {
      type: String,
      required: true
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

const UserSession = mongoose.model('UserSession', userSessionSchema);

// Socket.IO Connection Handling
const activeTrackers = new Map();

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  socket.on('track:subscribe', (trackId) => {
    console.log(`📡 Socket ${socket.id} subscribed to ${trackId}`);
    
    if (!activeTrackers.has(trackId)) {
      activeTrackers.set(trackId, new Set());
    }
    activeTrackers.get(trackId).add(socket.id);
    
    socket.join(trackId);
    socket.emit('track:subscribed', { trackId, socketId: socket.id });
  });

  socket.on('track:unsubscribe', (trackId) => {
    console.log(`📡 Socket ${socket.id} unsubscribed from ${trackId}`);
    socket.leave(trackId);
    
    if (activeTrackers.has(trackId)) {
      activeTrackers.get(trackId).delete(socket.id);
      if (activeTrackers.get(trackId).size === 0) {
        activeTrackers.delete(trackId);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
    
    activeTrackers.forEach((sockets, trackId) => {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        activeTrackers.delete(trackId);
      }
    });
  });
});

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    activeTrackers: activeTrackers.size,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Bus Tracking API Server',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      createLocation: 'POST /api/location',
      getLocation: 'GET /api/location/:trackId',
      getPath: 'GET /api/path/:trackId',
      getActiveTracks: 'GET /api/tracks/active',
      getSession: 'GET /api/session/:sessionId',
      updateSession: 'POST /api/session/:sessionId'
    }
  });
});

// NEW: Get user session (tracked users)
app.get('/api/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    let session = await UserSession.findOne({ sessionId });
    
    if (!session) {
      // Create new session if doesn't exist
      session = new UserSession({
        sessionId,
        trackedUsers: []
      });
      await session.save();
    }
    
    res.json({
      success: true,
      session: {
        sessionId: session.sessionId,
        trackedUsers: session.trackedUsers,
        lastUpdated: session.lastUpdated
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching session:', error.message);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// NEW: Update user session (add/remove tracked users)
app.post('/api/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { trackedUsers } = req.body;
    
    if (!Array.isArray(trackedUsers)) {
      return res.status(400).json({ error: 'trackedUsers must be an array' });
    }
    
    let session = await UserSession.findOne({ sessionId });
    
    if (!session) {
      session = new UserSession({
        sessionId,
        trackedUsers,
        lastUpdated: new Date()
      });
    } else {
      session.trackedUsers = trackedUsers;
      session.lastUpdated = new Date();
    }
    
    await session.save();
    
    console.log(`💾 Session ${sessionId} updated with ${trackedUsers.length} tracked users`);
    
    res.json({
      success: true,
      session: {
        sessionId: session.sessionId,
        trackedUsers: session.trackedUsers,
        lastUpdated: session.lastUpdated
      }
    });
    
  } catch (error) {
    console.error('❌ Error updating session:', error.message);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// Create/Update location
app.post('/api/location', async (req, res) => {
  try {
    const { trackId, lat, lng, speed, accuracy, heading, isActive, timestamp } = req.body;

    if (!trackId || lat === undefined || lng === undefined) {
      return res.status(400).json({ 
        error: 'Missing required fields: trackId, lat, lng' 
      });
    }

    const location = new Location({
      trackId,
      lat,
      lng,
      speed: speed || 0,
      accuracy: accuracy || 0,
      heading: heading || null,
      isActive: isActive !== undefined ? isActive : true,
      timestamp: timestamp || new Date()
    });

    await location.save();

    io.to(trackId).emit('location:updated', {
      trackId,
      lat,
      lng,
      speed,
      accuracy,
      heading,
      isActive,
      timestamp: location.timestamp,
      isRecent: true
    });

    console.log(`📍 Location saved for ${trackId}: (${lat.toFixed(4)}, ${lng.toFixed(4)}) - Speed: ${speed ? (speed * 3.6).toFixed(1) : 0} km/h`);

    res.status(201).json({
      success: true,
      location: {
        trackId: location.trackId,
        lat: location.lat,
        lng: location.lng,
        speed: location.speed,
        accuracy: location.accuracy,
        timestamp: location.timestamp
      }
    });

  } catch (error) {
    console.error('❌ Error saving location:', error.message);
    res.status(500).json({ 
      error: 'Failed to save location',
      details: error.message 
    });
  }
});

// Get latest location for a track ID
app.get('/api/location/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;

    const location = await Location
      .findOne({ trackId })
      .sort({ timestamp: -1 })
      .limit(1);

    if (!location) {
      return res.status(404).json({ error: 'Track ID not found' });
    }

    const isRecent = new Date() - location.timestamp < 5 * 60 * 1000;

    res.json({
      trackId: location.trackId,
      lat: location.lat,
      lng: location.lng,
      speed: location.speed,
      accuracy: location.accuracy,
      heading: location.heading,
      isActive: location.isActive,
      timestamp: location.timestamp,
      isRecent
    });

  } catch (error) {
    console.error('❌ Error fetching location:', error.message);
    res.status(500).json({ error: 'Failed to fetch location' });
  }
});

// Get path history for a track ID
app.get('/api/path/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const hours = parseInt(req.query.hours) || 2;

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const locations = await Location
      .find({ 
        trackId, 
        timestamp: { $gte: since } 
      })
      .sort({ timestamp: 1 })
      .select('lat lng timestamp speed')
      .limit(1000);

    const points = locations.map(loc => ({
      lat: loc.lat,
      lng: loc.lng,
      timestamp: loc.timestamp,
      speed: loc.speed
    }));

    res.json({
      trackId,
      points,
      count: points.length
    });

  } catch (error) {
    console.error('❌ Error fetching path:', error.message);
    res.status(500).json({ error: 'Failed to fetch path' });
  }
});

// Get all active tracks
app.get('/api/tracks/active', async (req, res) => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const activeTracks = await Location.aggregate([
      {
        $match: {
          timestamp: { $gte: fiveMinutesAgo },
          isActive: true
        }
      },
      {
        $sort: { timestamp: -1 }
      },
      {
        $group: {
          _id: '$trackId',
          lat: { $first: '$lat' },
          lng: { $first: '$lng' },
          speed: { $first: '$speed' },
          accuracy: { $first: '$accuracy' },
          timestamp: { $first: '$timestamp' }
        }
      }
    ]);

    const tracks = activeTracks.map(track => ({
      trackId: track._id,
      lat: track.lat,
      lng: track.lng,
      speed: track.speed,
      accuracy: track.accuracy,
      timestamp: track.timestamp,
      isActive: true,
      isRecent: true
    }));

    res.json({
      count: tracks.length,
      tracks
    });

  } catch (error) {
    console.error('❌ Error fetching active tracks:', error.message);
    res.status(500).json({ error: 'Failed to fetch active tracks' });
  }
});

// Delete old locations (cleanup endpoint)
app.delete('/api/cleanup', async (req, res) => {
  try {
    const hoursAgo = parseInt(req.query.hours) || 24;
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

    const result = await Location.deleteMany({
      timestamp: { $lt: cutoff }
    });

    res.json({
      success: true,
      deletedCount: result.deletedCount
    });

  } catch (error) {
    console.error('❌ Error cleaning up:', error.message);
    res.status(500).json({ error: 'Failed to clean up' });
  }
});

// Start server
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Bus Tracking Server Started Successfully');
  console.log('='.repeat(60));
  console.log(`📡 Server URL:        http://localhost:${PORT}`);
  console.log(`📊 Health Check:      http://localhost:${PORT}/health`);
  console.log(`🗺️  API Documentation: http://localhost:${PORT}/`);
  console.log(`🔌 Socket.IO:         Enabled for real-time updates`);
  console.log(`💾 Session Storage:   Enabled for persistent tracking`);
  console.log('='.repeat(60));
  console.log('📝 Logs:');
  console.log('='.repeat(60) + '\n');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await mongoose.connection.close();
  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Promise Rejection:', err);
});