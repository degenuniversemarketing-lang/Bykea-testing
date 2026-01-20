const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Store data
const riders = new Map();
const customers = new Map();
const rides = new Map();
const admins = new Set();

// Test route
app.get('/', (req, res) => {
  res.json({
    app: 'THE LAND RIDERS',
    status: '🚀 LIVE & WORKING',
    time: new Date().toISOString(),
    stats: {
      riders: riders.size,
      customers: customers.size,
      rides: rides.size
    }
  });
});

io.on('connection', (socket) => {
  console.log('✅ New connection:', socket.id);
  
  socket.emit('connected', { message: 'Connected to LAND RIDERS', id: socket.id });

  // ==================== ADMIN ====================
  socket.on('admin_login', (data) => {
    if (data.username === 'admin' && data.password === 'admin123') {
      admins.add(socket.id);
      console.log('👑 Admin logged in:', socket.id);
      
      socket.emit('admin_login_success', {
        message: 'Admin login successful',
        stats: {
          totalRiders: riders.size,
          onlineRiders: Array.from(riders.values()).filter(r => r.status === 'online').length,
          totalCustomers: customers.size,
          pendingRides: Array.from(rides.values()).filter(r => r.status === 'pending').length
        }
      });
    }
  });

  // Admin creates rider
  socket.on('create_rider', (data) => {
    if (!admins.has(socket.id)) return;
    
    const riderId = 'RDR' + Date.now() + Math.random().toString(36).substr(2, 4).toUpperCase();
    const riderData = {
      riderId,
      name: data.name,
      phone: data.phone,
      vehicle: data.vehicle,
      password: data.password,
      status: 'offline',
      createdAt: new Date().toISOString()
    };
    
    riders.set(riderId, riderData);
    
    console.log('👑 Rider created:', riderId, data.name);
    
    socket.emit('rider_created', {
      success: true,
      rider: {
        riderId,
        name: data.name,
        phone: data.phone,
        vehicle: data.vehicle,
        password: data.password
      }
    });
  });

  // ==================== RIDER ====================
  socket.on('rider_login', (data) => {
    const rider = Array.from(riders.values()).find(r => r.riderId === data.riderId);
    
    if (rider && rider.password === data.password) {
      rider.status = 'online';
      rider.socketId = socket.id;
      rider.lastLogin = new Date().toISOString();
      
      console.log('🏍️ Rider logged in:', rider.name);
      
      socket.emit('rider_login_success', {
        rider: {
          riderId: rider.riderId,
          name: rider.name,
          phone: rider.phone,
          vehicle: rider.vehicle,
          status: 'online'
        }
      });
      
      // Notify admins
      admins.forEach(adminId => {
        io.to(adminId).emit('rider_online', {
          riderId: rider.riderId,
          name: rider.name,
          status: 'online'
        });
      });
    } else {
      socket.emit('login_failed', { message: 'Invalid credentials' });
    }
  });

  // ==================== CUSTOMER ====================
  socket.on('customer_register', (data) => {
    const customerId = 'CUST' + Date.now();
    const customerData = {
      customerId,
      name: data.name,
      phone: data.phone,
      password: data.password,
      createdAt: new Date().toISOString(),
      socketId: socket.id
    };
    
    customers.set(customerId, customerData);
    
    console.log('👤 Customer registered:', data.name);
    
    socket.emit('register_success', {
      customer: customerData
    });
  });

  socket.on('request_ride', (data) => {
    const rideId = 'RIDE' + Date.now();
    const rideData = {
      rideId,
      customerName: data.customerName || 'Customer',
      pickup: data.pickup,
      destination: data.destination,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    
    rides.set(rideId, rideData);
    
    console.log('🚖 Ride requested:', rideId);
    
    // Notify ALL online riders
    const onlineRiders = Array.from(riders.values()).filter(r => r.status === 'online');
    onlineRiders.forEach(rider => {
      if (rider.socketId) {
        io.to(rider.socketId).emit('new_ride', {
          ...rideData,
          alert: 'NEW RIDE REQUEST!'
        });
      }
    });
    
    // Notify admins
    admins.forEach(adminId => {
      io.to(adminId).emit('new_ride_request', rideData);
    });
    
    socket.emit('ride_requested', {
      rideId,
      message: 'Ride request sent to riders'
    });
  });

  // ==================== DISCONNECT ====================
  socket.on('disconnect', () => {
    console.log('❌ Disconnected:', socket.id);
    admins.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
