const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// CORS configuration for production
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "https://thelandriders.com", "https://*.railway.app"],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Create tables if they don't exist
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        socket_id VARCHAR(255),
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE,
        phone VARCHAR(20),
        user_type VARCHAR(20) CHECK (user_type IN ('customer', 'rider', 'admin')),
        vehicle_type VARCHAR(50),
        license_plate VARCHAR(20),
        rating DECIMAL(3,2) DEFAULT 5.0,
        status VARCHAR(20) DEFAULT 'offline',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS rides (
        id SERIAL PRIMARY KEY,
        ride_uuid VARCHAR(100) UNIQUE NOT NULL,
        customer_id INTEGER REFERENCES users(id),
        customer_socket_id VARCHAR(255),
        pickup_address TEXT NOT NULL,
        dropoff_address TEXT NOT NULL,
        pickup_lat DECIMAL(10,8),
        pickup_lng DECIMAL(11,8),
        dropoff_lat DECIMAL(10,8),
        dropoff_lng DECIMAL(11,8),
        fare DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'picked_up', 'completed', 'cancelled')),
        rider_id INTEGER REFERENCES users(id),
        rider_socket_id VARCHAR(255),
        accepted_price DECIMAL(10,2),
        accepted_at TIMESTAMP,
        picked_up_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS offers (
        id SERIAL PRIMARY KEY,
        ride_id INTEGER REFERENCES rides(id),
        rider_id INTEGER REFERENCES users(id),
        rider_socket_id VARCHAR(255),
        price DECIMAL(10,2) NOT NULL,
        eta_minutes INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
      CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, user_type);
      CREATE INDEX IF NOT EXISTS idx_offers_ride_id ON offers(ride_id);
    `);
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

app.use(cors());
app.use(express.json());

// API Endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

app.get('/api/stats', async (req, res) => {
  try {
    const [totalRides, activeRiders, completedToday, pendingRides] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM rides'),
      pool.query("SELECT COUNT(*) FROM users WHERE status = 'online' AND user_type = 'rider'"),
      pool.query("SELECT COUNT(*) FROM rides WHERE status = 'completed' AND DATE(created_at) = CURRENT_DATE"),
      pool.query("SELECT COUNT(*) FROM rides WHERE status = 'pending'")
    ]);
    
    res.json({
      total_rides: parseInt(totalRides.rows[0].count),
      active_riders: parseInt(activeRiders.rows[0].count),
      completed_today: parseInt(completedToday.rows[0].count),
      pending_rides: parseInt(pendingRides.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WebSocket Connection Handling
io.on('connection', async (socket) => {
  console.log('🔌 New connection:', socket.id);

  // Customer connects
  socket.on('customer-connect', async (customerData) => {
    try {
      const result = await pool.query(
        `INSERT INTO users (socket_id, name, email, phone, user_type, status) 
         VALUES ($1, $2, $3, $4, 'customer', 'online')
         ON CONFLICT (email) WHERE email IS NOT NULL 
         DO UPDATE SET socket_id = $1, status = 'online', updated_at = CURRENT_TIMESTAMP
         RETURNING id, name`,
        [socket.id, customerData.name, customerData.email, customerData.phone]
      );
      
      const user = result.rows[0];
      socket.join('customers');
      socket.join(`user:${user.id}`);
      
      socket.emit('customer-connected', { 
        success: true, 
        userId: user.id,
        name: user.name 
      });
      
      console.log(`👤 Customer connected: ${user.name} (ID: ${user.id})`);
    } catch (error) {
      console.error('Customer connect error:', error);
      socket.emit('error', { message: 'Connection failed' });
    }
  });

  // Rider connects
  socket.on('rider-connect', async (riderData) => {
    try {
      const result = await pool.query(
        `INSERT INTO users (socket_id, name, vehicle_type, license_plate, user_type, status) 
         VALUES ($1, $2, $3, $4, 'rider', 'online')
         ON CONFLICT (license_plate) 
         DO UPDATE SET socket_id = $1, status = 'online', updated_at = CURRENT_TIMESTAMP
         RETURNING id, name`,
        [socket.id, riderData.name, riderData.vehicleType, riderData.licensePlate]
      );
      
      const rider = result.rows[0];
      socket.join('riders');
      socket.join(`user:${rider.id}`);
      
      // Notify admin
      io.to('admin').emit('rider-online', {
        riderId: rider.id,
        name: rider.name,
        vehicleType: riderData.vehicleType,
        status: 'online'
      });
      
      socket.emit('rider-connected', { 
        success: true, 
        riderId: rider.id,
        name: rider.name 
      });
      
      // Send pending rides to rider
      const pendingRides = await pool.query(`
        SELECT r.*, u.name as customer_name 
        FROM rides r
        JOIN users u ON r.customer_id = u.id
        WHERE r.status = 'pending'
        ORDER BY r.created_at DESC
        LIMIT 10
      `);
      
      if (pendingRides.rows.length > 0) {
        socket.emit('pending-rides', pendingRides.rows);
      }
      
      console.log(`🏍️ Rider connected: ${rider.name} (ID: ${rider.id})`);
    } catch (error) {
      console.error('Rider connect error:', error);
      socket.emit('error', { message: 'Connection failed' });
    }
  });

  // Admin connects
  socket.on('admin-connect', async () => {
    socket.join('admin');
    
    // Send current stats
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM rides) as total_rides,
        (SELECT COUNT(*) FROM users WHERE user_type = 'rider' AND status = 'online') as online_riders,
        (SELECT COUNT(*) FROM rides WHERE status = 'pending') as pending_rides,
        (SELECT COUNT(*) FROM rides WHERE status = 'accepted' OR status = 'picked_up') as active_rides
    `);
    
    socket.emit('admin-stats', stats.rows[0]);
    console.log('👑 Admin connected');
  });

  // Customer requests a ride
  socket.on('request-ride', async (rideData) => {
    try {
      // Get customer info
      const customer = await pool.query(
        'SELECT id, name FROM users WHERE socket_id = $1',
        [socket.id]
      );
      
      if (customer.rows.length === 0) {
        socket.emit('error', { message: 'Customer not found' });
        return;
      }
      
      const customerId = customer.rows[0].id;
      const rideUUID = `ride_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Create ride
      const result = await pool.query(
        `INSERT INTO rides (
          ride_uuid, customer_id, customer_socket_id, 
          pickup_address, dropoff_address, fare
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, ride_uuid, created_at`,
        [
          rideUUID, customerId, socket.id,
          rideData.pickup, rideData.dropoff, rideData.fare
        ]
      );
      
      const ride = result.rows[0];
      
      // Notify customer
      socket.emit('ride-created', {
        success: true,
        rideId: ride.id,
        rideUUID: ride.ride_uuid,
        message: 'Ride requested successfully'
      });
      
      // Get ride details for broadcast
      const rideDetails = await pool.query(`
        SELECT r.*, u.name as customer_name 
        FROM rides r
        JOIN users u ON r.customer_id = u.id
        WHERE r.id = $1
      `, [ride.id]);
      
      // Broadcast to all online riders
      io.to('riders').emit('new-ride-request', rideDetails.rows[0]);
      
      // Notify admin
      io.to('admin').emit('new-ride', rideDetails.rows[0]);
      
      console.log(`🚕 New ride requested: ${rideUUID} by ${customer.rows[0].name}`);
      
    } catch (error) {
      console.error('Ride request error:', error);
      socket.emit('error', { message: 'Failed to request ride' });
    }
  });

  // Rider makes an offer
  socket.on('make-offer', async (offerData) => {
    try {
      // Get rider info
      const rider = await pool.query(
        'SELECT id, name, vehicle_type FROM users WHERE socket_id = $1',
        [socket.id]
      );
      
      if (rider.rows.length === 0) {
        socket.emit('error', { message: 'Rider not found' });
        return;
      }
      
      const riderId = rider.rows[0].id;
      
      // Create offer
      await pool.query(
        `INSERT INTO offers (ride_id, rider_id, rider_socket_id, price, eta_minutes)
         VALUES ($1, $2, $3, $4, $5)`,
        [offerData.rideId, riderId, socket.id, offerData.price, offerData.eta]
      );
      
      // Get ride details
      const ride = await pool.query(`
        SELECT r.*, u.socket_id as customer_socket_id 
        FROM rides r
        JOIN users u ON r.customer_id = u.id
        WHERE r.id = $1
      `, [offerData.rideId]);
      
      if (ride.rows.length === 0) return;
      
      // Notify customer
      io.to(ride.rows[0].customer_socket_id).emit('new-offer', {
        rideId: offerData.rideId,
        offer: {
          riderId: riderId,
          riderName: rider.rows[0].name,
          vehicleType: rider.rows[0].vehicle_type,
          price: offerData.price,
          eta: offerData.eta,
          timestamp: new Date()
        }
      });
      
      // Notify admin
      io.to('admin').emit('new-offer', {
        rideId: offerData.rideId,
        riderName: rider.rows[0].name,
        price: offerData.price
      });
      
      socket.emit('offer-sent', { success: true });
      
      console.log(`💰 Offer made by ${rider.rows[0].name} for ride ${offerData.rideId}`);
      
    } catch (error) {
      console.error('Make offer error:', error);
      socket.emit('error', { message: 'Failed to make offer' });
    }
  });

  // Customer accepts an offer
  socket.on('accept-offer', async (acceptData) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Update ride
      await client.query(
        `UPDATE rides 
         SET status = 'accepted', 
             rider_id = $1,
             rider_socket_id = $2,
             accepted_price = $3,
             accepted_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4 AND status = 'pending'`,
        [acceptData.riderId, acceptData.riderSocketId, acceptData.price, acceptData.rideId]
      );
      
      // Update offer status
      await client.query(
        `UPDATE offers SET status = 'accepted'
         WHERE ride_id = $1 AND rider_id = $2`,
        [acceptData.rideId, acceptData.riderId]
      );
      
      // Reject other offers
      await client.query(
        `UPDATE offers SET status = 'rejected'
         WHERE ride_id = $1 AND rider_id != $2`,
        [acceptData.rideId, acceptData.riderId]
      );
      
      // Get ride details
      const ride = await client.query(`
        SELECT r.*, 
               u1.name as customer_name, u1.socket_id as customer_socket_id,
               u2.name as rider_name, u2.socket_id as rider_socket_id
        FROM rides r
        JOIN users u1 ON r.customer_id = u1.id
        JOIN users u2 ON r.rider_id = u2.id
        WHERE r.id = $1
      `, [acceptData.rideId]);
      
      if (ride.rows.length === 0) {
        await client.query('ROLLBACK');
        return;
      }
      
      await client.query('COMMIT');
      
      const rideData = ride.rows[0];
      
      // Notify customer
      io.to(rideData.customer_socket_id).emit('offer-accepted', {
        success: true,
        rideId: acceptData.rideId,
        riderName: rideData.rider_name,
        price: acceptData.price
      });
      
      // Notify rider
      io.to(rideData.rider_socket_id).emit('offer-won', {
        rideId: acceptData.rideId,
        customerName: rideData.customer_name,
        pickup: rideData.pickup_address,
        dropoff: rideData.dropoff_address,
        price: acceptData.price
      });
      
      // Notify other riders
      io.to('riders').emit('ride-taken', {
        rideId: acceptData.rideId,
        message: 'Ride has been accepted by another rider'
      });
      
      // Notify admin
      io.to('admin').emit('ride-accepted', rideData);
      
      console.log(`✅ Ride ${acceptData.rideId} accepted by ${rideData.rider_name}`);
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Accept offer error:', error);
      socket.emit('error', { message: 'Failed to accept offer' });
    } finally {
      client.release();
    }
  });

  // Update ride status
  socket.on('update-ride-status', async (statusData) => {
    try {
      let updateQuery = 'UPDATE rides SET status = $1, updated_at = CURRENT_TIMESTAMP';
      const values = [statusData.status];
      
      if (statusData.status === 'picked_up') {
        updateQuery += ', picked_up_at = CURRENT_TIMESTAMP';
      } else if (statusData.status === 'completed') {
        updateQuery += ', completed_at = CURRENT_TIMESTAMP';
      }
      
      updateQuery += ' WHERE id = $2 RETURNING *';
      values.push(statusData.rideId);
      
      const result = await pool.query(updateQuery, values);
      
      if (result.rows.length === 0) return;
      
      const ride = result.rows[0];
      
      // Get socket IDs
      const sockets = await pool.query(`
        SELECT u1.socket_id as customer_socket, u2.socket_id as rider_socket
        FROM rides r
        JOIN users u1 ON r.customer_id = u1.id
        JOIN users u2 ON r.rider_id = u2.id
        WHERE r.id = $1
      `, [statusData.rideId]);
      
      if (sockets.rows.length > 0) {
        const socketIds = sockets.rows[0];
        
        // Notify both parties
        if (socketIds.customer_socket) {
          io.to(socketIds.customer_socket).emit('ride-status-changed', {
            rideId: statusData.rideId,
            status: statusData.status,
            timestamp: new Date()
          });
        }
        
        if (socketIds.rider_socket) {
          io.to(socketIds.rider_socket).emit('ride-status-changed', {
            rideId: statusData.rideId,
            status: statusData.status,
            timestamp: new Date()
          });
        }
      }
      
      // Notify admin
      io.to('admin').emit('ride-status-updated', {
        rideId: statusData.rideId,
        status: statusData.status
      });
      
    } catch (error) {
      console.error('Update ride status error:', error);
      socket.emit('error', { message: 'Failed to update status' });
    }
  });

  // Disconnect
  socket.on('disconnect', async () => {
    try {
      await pool.query(
        "UPDATE users SET status = 'offline', socket_id = NULL WHERE socket_id = $1",
        [socket.id]
      );
      
      console.log(`❌ Client disconnected: ${socket.id}`);
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  });
});

// Initialize and start server
async function startServer() {
  await initializeDatabase();
  
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 WebSocket server ready for connections`);
    console.log(`🗄️ Database connected: ${process.env.DATABASE_URL ? 'Yes' : 'No'}`);
  });
}

startServer();
