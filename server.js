const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
  } else {
    console.log('✅ Database connected successfully');
    release();
  }
});

// Initialize database tables
async function initializeDatabase() {
  try {
    console.log('🔄 Initializing database tables...');
    
    // Valid keys table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS valid_keys (
        id SERIAL PRIMARY KEY,
        key_value TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      )
    `);

    // Registered devices table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS registered_devices (
        id SERIAL PRIMARY KEY,
        device_id TEXT UNIQUE NOT NULL,
        key_used TEXT NOT NULL,
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      )
    `);

    // SMS logs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sms_logs (
        id SERIAL PRIMARY KEY,
        device_id TEXT NOT NULL,
        dest_number TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'pending'
      )
    `);

    // Insert default keys
    const defaultKeys = [
      'DEMO_KEY_123',
      'TEST_KEY_456', 
      'ADMIN_KEY_789',
      'USER_KEY_001',
      'FREE_KEY_999'
    ];

    for (const key of defaultKeys) {
      await pool.query(
        'INSERT INTO valid_keys (key_value) VALUES ($1) ON CONFLICT (key_value) DO NOTHING',
        [key]
      );
    }

    console.log('✅ Database initialized successfully');
    console.log('🔑 Default keys available:', defaultKeys.join(', '));
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// Initialize database on startup
initializeDatabase();

// Connected devices storage
const connectedDevices = new Map();

// Routes

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '🚀 SMS Hook Server Running',
    timestamp: new Date().toISOString(),
    connected_devices: connectedDevices.size,
    message: 'Server is working perfectly! SMS insertion ready.',
    admin_panel: '/admin',
    default_keys: ['DEMO_KEY_123', 'TEST_KEY_456', 'ADMIN_KEY_789', 'USER_KEY_001', 'FREE_KEY_999']
  });
});

// Admin panel route
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

// Register endpoint (Original working)
app.post('/register', async (req, res) => {
  const { key } = req.body;
  
  console.log(`📝 Registration attempt with key: ${key}`);
  
  if (!key) {
    return res.status(400).json({
      error: 'Key is required'
    });
  }

  try {
    // Check if key is valid
    const keyResult = await pool.query(
      'SELECT * FROM valid_keys WHERE key_value = $1 AND is_active = true',
      [key]
    );

    if (keyResult.rows.length === 0) {
      console.log(`❌ Invalid key attempted: ${key}`);
      return res.status(401).json({
        error: 'Invalid key'
      });
    }

    // Generate unique device ID
    const deviceId = 'DEVICE_' + uuidv4().replace(/-/g, '').substring(0, 12).toUpperCase();

    // Register device
    await pool.query(
      'INSERT INTO registered_devices (device_id, key_used) VALUES ($1, $2) ON CONFLICT (device_id) DO UPDATE SET key_used = $2, registered_at = CURRENT_TIMESTAMP',
      [deviceId, key]
    );

    console.log(`✅ Device registered: ${deviceId} with key: ${key}`);
    
    res.json({
      deviceid: deviceId,
      status: 'success'
    });

  } catch (error) {
    console.error('❌ Registration error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// Send endpoint (Original working - SMS insertion)
app.post('/send', async (req, res) => {
  const { deviceId, destNumber, textMessage } = req.body;

  console.log(`📱 SMS request: ${deviceId} -> ${destNumber}: ${textMessage}`);

  if (!deviceId || !destNumber || !textMessage) {
    return res.status(400).json({
      status: 'false',
      message: 'Missing required parameters'
    });
  }

  try {
    // Verify device is registered
    const deviceResult = await pool.query(
      'SELECT * FROM registered_devices WHERE device_id = $1 AND is_active = true',
      [deviceId]
    );

    if (deviceResult.rows.length === 0) {
      console.log(`❌ Unregistered device: ${deviceId}`);
      return res.status(401).json({
        status: 'false',
        message: 'Device not registered'
      });
    }

    // Log SMS request
    const logResult = await pool.query(
      'INSERT INTO sms_logs (device_id, dest_number, message) VALUES ($1, $2, $3) RETURNING id',
      [deviceId, destNumber, textMessage]
    );

    // Update device last active
    await pool.query(
      'UPDATE registered_devices SET last_active = CURRENT_TIMESTAMP WHERE device_id = $1',
      [deviceId]
    );

    // Send to connected device via Socket.IO
    const socketId = connectedDevices.get(deviceId);
    if (socketId) {
      const requestId = logResult.rows[0].id;
      io.to(socketId).emit('insert-sms', {
        requestId: requestId,
        destNumber: destNumber,
        textMessage: textMessage
      });
      
      console.log(`✅ SMS insertion command sent to device ${deviceId}`);
    } else {
      console.log(`⚠️ Device ${deviceId} not connected via Socket.IO`);
    }

    res.json({
      status: 'true',
      message: 'SMS request processed successfully'
    });

  } catch (error) {
    console.error('❌ SMS processing error:', error);
    res.status(500).json({
      status: 'false',
      message: 'Database error'
    });
  }
});

// Admin endpoints (Simple - No password required)
app.get('/admin/keys', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM valid_keys ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/keys', async (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'Key is required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO valid_keys (key_value) VALUES ($1) RETURNING id',
      [key]
    );
    
    console.log(`🔑 New key added: ${key}`);
    
    res.json({ 
      id: result.rows[0].id, 
      key: key, 
      message: 'Key added successfully' 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin/devices', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM registered_devices ORDER BY registered_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin/logs', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sl.*, rd.key_used 
      FROM sms_logs sl 
      JOIN registered_devices rd ON sl.device_id = rd.device_id 
      ORDER BY sl.timestamp DESC 
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO connection handling (Original working)
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Auto-authenticate with device ID
  const deviceId = socket.handshake.auth?.deviceId;
  if (deviceId) {
    connectedDevices.set(deviceId, socket.id);
    socket.deviceId = deviceId;
    
    console.log(`✅ Device authenticated: ${deviceId}`);
    
    socket.emit('connected', {
      message: 'Device connected successfully',
      deviceId: deviceId
    });

    // Update device status
    pool.query(
      'UPDATE registered_devices SET last_active = CURRENT_TIMESTAMP WHERE device_id = $1',
      [deviceId]
    ).catch(err => console.error('Error updating device status:', err));
  }

  // Manual authentication
  socket.on('authenticate', async (data) => {
    const { deviceId } = data;
    if (deviceId) {
      connectedDevices.set(deviceId, socket.id);
      socket.deviceId = deviceId;
      
      console.log(`✅ Device manually authenticated: ${deviceId}`);
      
      socket.emit('connected', {
        message: 'Device connected successfully',
        deviceId: deviceId
      });

      try {
        await pool.query(
          'UPDATE registered_devices SET last_active = CURRENT_TIMESTAMP WHERE device_id = $1',
          [deviceId]
        );
      } catch (error) {
        console.error('Error updating device status:', error);
      }
    }
  });

  // SMS response handling
  socket.on('sms-response', async (data) => {
    const { requestId, status, message } = data;
    console.log(`📱 SMS Response - Request: ${requestId}, Status: ${status}`);
    
    try {
      await pool.query(
        'UPDATE sms_logs SET status = $1 WHERE id = $2',
        [status ? 'success' : 'failed', requestId]
      );
    } catch (error) {
      console.error('Error updating SMS log status:', error);
    }
  });

  // Heartbeat
  socket.on('heartbeat', () => {
    socket.emit('heartbeat');
  });

  // Send periodic heartbeat
  const heartbeatInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit('heartbeat');
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  // Force disconnect
  socket.on('force_disconnect', (data) => {
    const { reason } = data;
    console.log(`⚠️ Force disconnect: ${reason}`);
    socket.emit('force_disconnect', { reason: reason || 'Server disconnect' });
    setTimeout(() => socket.disconnect(), 1000);
  });

  // Disconnect handling
  socket.on('disconnect', (reason) => {
    if (socket.deviceId) {
      connectedDevices.delete(socket.deviceId);
      console.log(`🔌 Device disconnected: ${socket.deviceId}`);
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 SMS Hook Server running on port ${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`✅ SMS insertion system ready!`);
  console.log(`🔑 Default keys: DEMO_KEY_123, TEST_KEY_456, ADMIN_KEY_789`);
});