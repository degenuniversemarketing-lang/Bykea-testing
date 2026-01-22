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
    origin: ["http://localhost:3000", "https://thelandriders.com", "https://*.railway.app", "http://localhost:8080"],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// PostgreSQL connection - FIXED for Railway
console.log('Database URL available:', !!process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/landriders',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.on('connect', () => {
  console.log('✅ Database connected successfully');
});

pool.on('error', (err) => {
  console.error('❌ Database connection error:', err);
});

// Create tables if they don't exist
async function initializeDatabase() {
  let retries = 5;
  while (retries > 0) {
    try {
      console.log(`Attempting database connection (${retries} retries left)...`);
      
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          socket_id VARCHAR(255),
          name VARCHAR(100) NOT NULL,
          email VARCHAR(255),
          phone VARCHAR(20),
          user_type VARCHAR(20) CHECK (user_type IN ('customer', 'rider', 'admin')),
          vehicle_type VARCHAR(50),
          license_plate VARCHAR(20),
          rating DECIMAL(3,2) DEFAULT 5.0,
          status VARCHAR(20) DEFAULT 'offline',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(socket_id)
        );
      `);
      
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rides (
          id SERIAL PRIMARY KEY,
          ride_uuid VARCHAR(100) UNIQUE NOT NULL,
          customer_id INTEGER REFERENCES users(id),
          customer_socket_id VARCHAR(255),
          pickup_address TEXT NOT NULL,
          dropoff_address TEXT NOT NULL,
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
      `);
      
      await pool.query(`
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
      `);
      
      console.log('✅ Database tables initialized successfully');
      return;
      
    } catch (error) {
      console.error(`❌ Database initialization error (retry ${6 - retries}/5):`, error.message);
      retries--;
      
      if (retries === 0) {
        console.error('Failed to initialize database after 5 attempts');
        console.log('Starting server without database tables (will create on first use)...');
        return;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

// Serve static files
app.use(express.static('public'));
app.use(cors());
app.use(express.json());

// Serve HTML files
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

// API Endpoints
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date(),
    database: !!pool,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Simplified WebSocket Connection Handling
io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);
  
  // Store connections in memory for now
  const connections = {
    customers: new Map(),
    riders: new Map(),
    rides: new Map(),
    offers: new Map()
  };

  // Customer connects
  socket.on('customer-connect', async (customerData) => {
    try {
      connections.customers.set(socket.id, {
        ...customerData,
        type: 'customer',
        socketId: socket.id,
        connectedAt: new Date()
      });
      
      socket.join('customers');
      socket.emit('customer-connected', { 
        success: true, 
        customerId: socket.id,
        name: customerData.name 
      });
      
      console.log(`👤 Customer connected: ${customerData.name}`);
    } catch (error) {
      console.error('Customer connect error:', error);
      socket.emit('error', { message: 'Connection failed' });
    }
  });

  // Rider connects
  socket.on('rider-connect', async (riderData) => {
    try {
      connections.riders.set(socket.id, {
        ...riderData,
        type: 'rider',
        socketId: socket.id,
        status: 'online',
        connectedAt: new Date()
      });
      
      socket.join('riders');
      socket.emit('rider-connected', { 
        success: true, 
        riderId: socket.id,
        name: riderData.name 
      });
      
      // Notify admin
      io.to('admin').emit('rider-online', {
        riderId: socket.id,
        name: riderData.name,
        vehicleType: riderData.vehicleType,
        status: 'online'
      });
      
      console.log(`🏍️ Rider connected: ${riderData.name}`);
      
      // Send existing pending rides
      const pendingRides = Array.from(connections.rides.values())
        .filter(ride => ride.status === 'pending');
      
      if (pendingRides.length > 0) {
        socket.emit('pending-rides', pendingRides);
      }
    } catch (error) {
      console.error('Rider connect error:', error);
      socket.emit('error', { message: 'Connection failed' });
    }
  });

  // Admin connects
  socket.on('admin-connect', () => {
    socket.join('admin');
    
    // Send current stats
    const stats = {
      totalRides: connections.rides.size,
      onlineRiders: connections.riders.size,
      onlineCustomers: connections.customers.size,
      pendingRides: Array.from(connections.rides.values()).filter(r => r.status === 'pending').length
    };
    
    socket.emit('admin-stats', stats);
    console.log('👑 Admin connected');
  });

  // Customer requests a ride - SIMPLIFIED
  socket.on('request-ride', (rideData) => {
    try {
      const customer = connections.customers.get(socket.id);
      if (!customer) {
        socket.emit('error', { message: 'Customer not found. Please reconnect.' });
        return;
      }
      
      const rideId = `ride_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const newRide = {
        id: rideId,
        customerId: socket.id,
        customerName: customer.name,
        pickup: rideData.pickup,
        dropoff: rideData.dropoff,
        fare: rideData.fare || 25, // Default fare
        status: 'pending',
        createdAt: new Date(),
        offers: []
      };
      
      connections.rides.set(rideId, newRide);
      
      // Notify customer
      socket.emit('ride-created', {
        success: true,
        rideId: rideId,
        message: 'Ride requested successfully. Searching for riders...'
      });
      
      // Broadcast to all online riders
      io.to('riders').emit('new-ride-request', newRide);
      
      // Notify admin
      io.to('admin').emit('new-ride', newRide);
      
      console.log(`🚕 New ride requested: ${rideId} by ${customer.name}`);
      
    } catch (error) {
      console.error('Ride request error:', error);
      socket.emit('error', { message: 'Failed to request ride' });
    }
  });

  // Rider makes an offer - SIMPLIFIED
  socket.on('make-offer', (offerData) => {
    try {
      const rider = connections.riders.get(socket.id);
      if (!rider) {
        socket.emit('error', { message: 'Rider not found' });
        return;
      }
      
      const ride = connections.rides.get(offerData.rideId);
      if (!ride) {
        socket.emit('error', { message: 'Ride not found' });
        return;
      }
      
      const offer = {
        riderId: socket.id,
        riderName: rider.name,
        vehicleType: rider.vehicleType,
        licensePlate: rider.licensePlate,
        price: offerData.price,
        eta: offerData.eta,
        timestamp: new Date()
      };
      
      // Add offer to ride
      ride.offers.push(offer);
      connections.rides.set(offerData.rideId, ride);
      
      // Notify the customer
      const customerSocketId = ride.customerId;
      if (customerSocketId) {
        io.to(customerSocketId).emit('new-offer', {
          rideId: offerData.rideId,
          offer: offer
        });
      }
      
      // Notify admin
      io.to('admin').emit('new-offer', {
        rideId: offerData.rideId,
        riderName: rider.name,
        price: offerData.price
      });
      
      socket.emit('offer-sent', { success: true });
      
      console.log(`💰 Offer made by ${rider.name} for ride ${offerData.rideId}`);
      
    } catch (error) {
      console.error('Make offer error:', error);
      socket.emit('error', { message: 'Failed to make offer' });
    }
  });

  // Customer accepts an offer - SIMPLIFIED
  socket.on('accept-offer', (acceptData) => {
    try {
      const ride = connections.rides.get(acceptData.rideId);
      if (!ride || ride.status !== 'pending') {
        socket.emit('error', { message: 'Ride not available' });
        return;
      }
      
      // Find the offer
      const offer = ride.offers.find(o => o.riderId === acceptData.riderId);
      if (!offer) {
        socket.emit('error', { message: 'Offer not found' });
        return;
      }
      
      // Update ride
      ride.status = 'accepted';
      ride.acceptedRiderId = acceptData.riderId;
      ride.acceptedRiderName = offer.riderName;
      ride.acceptedPrice = offer.price;
      ride.acceptedAt = new Date();
      connections.rides.set(acceptData.rideId, ride);
      
      // Notify customer
      socket.emit('offer-accepted', {
        success: true,
        rideId: acceptData.rideId,
        riderName: offer.riderName,
        price: offer.price
      });
      
      // Notify the rider
      io.to(acceptData.riderId).emit('offer-won', {
        rideId: acceptData.rideId,
        customerName: ride.customerName,
        pickup: ride.pickup,
        dropoff: ride.dropoff,
        price: offer.price
      });
      
      // Notify other riders
      io.to('riders').emit('ride-taken', {
        rideId: acceptData.rideId,
        message: 'Ride has been accepted by another rider'
      });
      
      // Notify admin
      io.to('admin').emit('ride-accepted', ride);
      
      console.log(`✅ Ride ${acceptData.rideId} accepted by ${offer.riderName}`);
      
    } catch (error) {
      console.error('Accept offer error:', error);
      socket.emit('error', { message: 'Failed to accept offer' });
    }
  });

  // Update ride status
  socket.on('update-ride-status', (statusData) => {
    try {
      const ride = connections.rides.get(statusData.rideId);
      if (!ride) return;
      
      ride.status = statusData.status;
      ride.updatedAt = new Date();
      
      if (statusData.status === 'picked_up') {
        ride.pickedUpAt = new Date();
      } else if (statusData.status === 'completed') {
        ride.completedAt = new Date();
      }
      
      connections.rides.set(statusData.rideId, ride);
      
      // Notify customer
      if (ride.customerId) {
        io.to(ride.customerId).emit('ride-status-changed', {
          rideId: statusData.rideId,
          status: statusData.status,
          timestamp: new Date()
        });
      }
      
      // Notify rider
      if (ride.acceptedRiderId) {
        io.to(ride.acceptedRiderId).emit('ride-status-changed', {
          rideId: statusData.rideId,
          status: statusData.status,
          timestamp: new Date()
        });
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

  // Get active rides
  socket.on('get-active-rides', (userType) => {
    const ridesArray = Array.from(connections.rides.values());
    
    if (userType === 'rider') {
      const pendingRides = ridesArray.filter(ride => ride.status === 'pending');
      socket.emit('pending-rides', pendingRides);
    } else if (userType === 'customer') {
      const userRides = ridesArray.filter(ride => ride.customerId === socket.id);
      socket.emit('my-rides', userRides);
    } else if (userType === 'admin') {
      socket.emit('all-rides', ridesArray);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    // Remove from connections
    connections.customers.delete(socket.id);
    connections.riders.delete(socket.id);
    
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// Initialize and start server
async function startServer() {
  // Try to initialize database but don't block server start
  initializeDatabase().catch(err => {
    console.log('⚠️ Database initialization failed, running in memory-only mode');
    console.log('Rides will not persist after server restart');
  });
  
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 WebSocket server ready for connections`);
    console.log(`🌐 Server accessible at: http://0.0.0.0:${PORT}`);
  });
}

startServer();
