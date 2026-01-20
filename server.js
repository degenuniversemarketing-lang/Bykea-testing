const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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

// File storage
const DATA_FILE = path.join(__dirname, 'data.json');
let db = {
  riders: {},
  customers: {},
  rides: {},
  complaints: {},
  admins: {
    admin_001: {
      username: 'admin',
      password: 'admin123',
      name: 'Admin'
    }
  }
};

// Load data
if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = { ...db, ...saved };
    console.log('📁 Loaded saved data');
  } catch (e) {
    console.log('Starting fresh');
  }
}

// Save data
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  console.log('💾 Data saved');
}

// Auto-save
setInterval(saveData, 30000);

// Routes
app.get('/', (req, res) => {
  res.json({
    app: 'THE LAND RIDERS',
    status: '🚀 LIVE & WORKING',
    stats: {
      riders: Object.keys(db.riders).length,
      customers: Object.keys(db.customers).length,
      rides: Object.keys(db.rides).length,
      complaints: Object.keys(db.complaints).length,
      lastUpdated: new Date().toISOString()
    }
  });
});

// Socket.io
io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);
  
  socket.emit('connected', { 
    message: 'Connected to THE LAND RIDERS',
    time: new Date().toISOString()
  });

  // ==================== TEST EVENT ====================
  socket.on('ping', (data) => {
    console.log('Ping received:', data);
    socket.emit('pong', { 
      message: 'Hello from backend!',
      server: 'bykea-testing-production.up.railway.app',
      time: new Date().toISOString()
    });
  });

  socket.on('test_connection', (data) => {
    console.log('Test connection:', data);
    socket.emit('test_response', {
      message: 'Connection successful!',
      backend: 'bykea-testing-production.up.railway.app',
      time: new Date().toISOString()
    });
  });

  // ==================== ADMIN EVENTS ====================
  socket.on('admin_login', (data) => {
    console.log('Admin login attempt:', data.username);
    
    const admin = Object.values(db.admins).find(a => 
      a.username === data.username && a.password === data.password
    );
    
    if (admin) {
      console.log('✅ Admin login successful:', data.username);
      
      socket.emit('admin_login_success', {
        admin: {
          username: admin.username,
          name: admin.name
        },
        stats: {
          totalRiders: Object.keys(db.riders).length,
          totalCustomers: Object.keys(db.customers).length,
          totalRides: Object.keys(db.rides).length,
          totalComplaints: Object.keys(db.complaints).length
        }
      });
    } else {
      console.log('❌ Admin login failed:', data.username);
      socket.emit('admin_login_failed', {
        message: 'Invalid admin credentials'
      });
    }
  });

  socket.on('admin_create_rider', (data) => {
    console.log('Creating rider:', data.name);
    
    const riderId = 'RDR' + Date.now() + Math.random().toString(36).substr(2, 4).toUpperCase();
    
    db.riders[riderId] = {
      riderId,
      name: data.name,
      phone: data.phone,
      vehicle: data.vehicle,
      plateNumber: data.plateNumber,
      whatsapp: data.whatsapp,
      password: data.password,
      status: 'offline',
      earnings: 0,
      totalRides: 0,
      rating: 5.0,
      createdAt: new Date().toISOString(),
      createdBy: 'admin'
    };
    
    saveData();
    console.log('✅ Rider created:', riderId, data.name);
    
    socket.emit('rider_created_success', {
      success: true,
      message: `Rider ${data.name} created successfully!`,
      rider: {
        riderId,
        name: data.name,
        phone: data.phone,
        vehicle: data.vehicle,
        plateNumber: data.plateNumber,
        whatsapp: data.whatsapp,
        password: data.password,
        loginInstructions: `Share with rider: Rider ID: ${riderId}, Password: ${data.password}`
      }
    });
    
    // Update stats on frontend
    io.emit('stats_update', {
      riders: Object.keys(db.riders).length,
      customers: Object.keys(db.customers).length,
      rides: Object.keys(db.rides).length
    });
  });

  // ==================== RIDER EVENTS ====================
  socket.on('rider_login', (data) => {
    console.log('Rider login attempt:', data.riderId);
    
    const rider = Object.values(db.riders).find(r => r.riderId === data.riderId);
    
    if (!rider) {
      socket.emit('login_error', { message: 'Invalid Rider ID' });
      return;
    }
    
    if (rider.password !== data.password) {
      socket.emit('login_error', { message: 'Invalid password' });
      return;
    }
    
    // Update rider
    rider.status = 'online';
    rider.lastLogin = new Date().toISOString();
    rider.socketId = socket.id;
    
    saveData();
    console.log('✅ Rider logged in:', rider.name);
    
    socket.emit('rider_login_success', {
      rider: {
        riderId: rider.riderId,
        name: rider.name,
        phone: rider.phone,
        vehicle: rider.vehicle,
        status: 'online',
        earnings: rider.earnings,
        totalRides: rider.totalRides,
        rating: rider.rating
      }
    });
    
    // Notify admin
    io.emit('rider_online', {
      riderId: rider.riderId,
      name: rider.name,
      status: 'online'
    });
  });

  socket.on('rider_status_update', (data) => {
    console.log('Rider status update:', data);
    
    const rider = Object.values(db.riders).find(r => r.socketId === socket.id);
    if (rider) {
      rider.status = data.status;
      saveData();
      
      io.emit('rider_status_changed', {
        riderId: rider.riderId,
        name: rider.name,
        status: data.status
      });
    }
  });

  // ==================== CUSTOMER EVENTS ====================
  socket.on('customer_register', (data) => {
    console.log('Customer register:', data.name);
    
    const customerId = 'CUST' + Date.now();
    
    db.customers[customerId] = {
      customerId,
      name: data.name,
      phone: data.phone,
      password: data.password,
      email: data.email || '',
      createdAt: new Date().toISOString(),
      totalRides: 0,
      socketId: socket.id
    };
    
    saveData();
    console.log('✅ Customer registered:', data.name);
    
    socket.emit('register_success', {
      customer: {
        customerId,
        name: data.name,
        phone: data.phone,
        email: data.email || ''
      }
    });
    
    // Update stats
    io.emit('stats_update', {
      riders: Object.keys(db.riders).length,
      customers: Object.keys(db.customers).length,
      rides: Object.keys(db.rides).length
    });
  });

  socket.on('customer_login', (data) => {
    console.log('Customer login:', data.phone);
    
    const customer = Object.values(db.customers).find(c => c.phone === data.phone);
    
    if (!customer) {
      socket.emit('login_error', { message: 'Customer not found' });
      return;
    }
    
    if (customer.password !== data.password) {
      socket.emit('login_error', { message: 'Invalid password' });
      return;
    }
    
    customer.socketId = socket.id;
    customer.lastLogin = new Date().toISOString();
    
    saveData();
    console.log('✅ Customer logged in:', customer.name);
    
    socket.emit('login_success', {
      customer: {
        name: customer.name,
        phone: customer.phone,
        customerId: customer.customerId,
        totalRides: customer.totalRides || 0
      }
    });
  });

  socket.on('request_ride', (data) => {
    console.log('Ride request:', data.pickup, '→', data.destination);
    
    const rideId = 'RIDE' + Date.now();
    const customerName = data.customerName || 'Customer';
    const customerId = data.customerId || 'guest_' + Date.now();
    
    db.rides[rideId] = {
      rideId,
      customerId,
      customerName,
      pickup: data.pickup,
      destination: data.destination,
      fare: data.fare || 'To be determined',
      notes: data.notes || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      offers: []
    };
    
    saveData();
    console.log('✅ Ride created:', rideId);
    
    // Notify customer
    socket.emit('ride_requested', {
      rideId,
      message: 'Ride request sent to available riders',
      estimatedWait: '2-5 minutes'
    });
    
    // Notify ALL online riders
    const onlineRiders = Object.values(db.riders).filter(r => r.status === 'online');
    console.log('Notifying', onlineRiders.length, 'online riders');
    
    onlineRiders.forEach(rider => {
      if (rider.socketId) {
        io.to(rider.socketId).emit('new_ride_request', {
          rideId,
          customerName,
          pickup: data.pickup,
          destination: data.destination,
          fare: data.fare || 'To be determined',
          createdAt: new Date().toISOString()
        });
      }
    });
    
    // Update stats
    io.emit('stats_update', {
      riders: Object.keys(db.riders).length,
      customers: Object.keys(db.customers).length,
      rides: Object.keys(db.rides).length
    });
  });

  socket.on('accept_ride', (data) => {
    console.log('Accept ride:', data.rideId);
    
    const ride = db.rides[data.rideId];
    const rider = Object.values(db.riders).find(r => r.socketId === socket.id);
    
    if (!ride || !rider) {
      socket.emit('ride_error', { message: 'Invalid ride acceptance' });
      return;
    }
    
    // Update ride
    ride.status = 'active';
    ride.riderId = rider.riderId;
    ride.riderName = rider.name;
    ride.riderPhone = rider.phone;
    ride.riderVehicle = rider.vehicle;
    ride.acceptedAt = new Date().toISOString();
    ride.estimatedArrival = '5-10 minutes';
    
    // Update rider
    rider.status = 'busy';
    rider.totalRides = (rider.totalRides || 0) + 1;
    
    saveData();
    console.log('✅ Ride accepted:', rider.name, '→', ride.customerName);
    
    // Notify customer
    const customerSocket = Object.values(db.customers)
      .find(c => c.customerId === ride.customerId)?.socketId;
    
    if (customerSocket) {
      io.to(customerSocket).emit('ride_accepted', {
        rideId: data.rideId,
        riderName: rider.name,
        riderPhone: rider.phone,
        riderVehicle: rider.vehicle,
        estimatedArrival: '5-10 minutes',
        message: `Rider ${rider.name} is on the way!`
      });
    }
    
    // Notify rider
    socket.emit('ride_confirmed', {
      rideId: data.rideId,
      customerName: ride.customerName,
      customerPhone: ride.customerId,
      pickup: ride.pickup,
      destination: ride.destination,
      fare: ride.fare,
      notes: ride.notes
    });
    
    // Notify admin
    io.emit('ride_accepted_by_rider', {
      rideId: data.rideId,
      riderName: rider.name,
      customerName: ride.customerName,
      time: new Date().toISOString()
    });
  });

  socket.on('complete_ride', (data) => {
    console.log('Complete ride:', data.rideId);
    
    const ride = db.rides[data.rideId];
    const rider = Object.values(db.riders).find(r => r.socketId === socket.id);
    
    if (!ride || !rider || ride.riderId !== rider.riderId) {
      socket.emit('ride_error', { message: 'Invalid ride completion' });
      return;
    }
    
    // Update ride
    ride.status = 'completed';
    ride.completedAt = new Date().toISOString();
    ride.actualFare = data.fare || ride.fare;
    
    // Update rider
    rider.status = 'online';
    rider.earnings += parseInt(data.fare) || 0;
    
    // Update customer
    const customer = Object.values(db.customers)
      .find(c => c.customerId === ride.customerId);
    if (customer) {
      customer.totalRides = (customer.totalRides || 0) + 1;
    }
    
    saveData();
    console.log('✅ Ride completed:', rideId);
    
    // Notify customer
    const customerSocket = customer?.socketId;
    if (customerSocket) {
      io.to(customerSocket).emit('ride_completed', {
        rideId: data.rideId,
        riderName: ride.riderName,
        fare: ride.actualFare,
        message: 'Thank you for choosing THE LAND RIDERS!'
      });
    }
    
    // Notify rider
    socket.emit('ride_completed_rider', {
      rideId: data.rideId,
      earnings: rider.earnings,
      totalRides: rider.totalRides,
      message: 'Ride completed successfully!'
    });
    
    // Update stats
    io.emit('stats_update', {
      riders: Object.keys(db.riders).length,
      customers: Object.keys(db.customers).length,
      rides: Object.keys(db.rides).length
    });
  });

  // ==================== DISCONNECT ====================
  socket.on('disconnect', () => {
    console.log('❌ Disconnected:', socket.id);
    
    // Mark rider offline
    const rider = Object.values(db.riders).find(r => r.socketId === socket.id);
    if (rider) {
      rider.status = 'offline';
      rider.socketId = null;
      saveData();
      
      io.emit('rider_offline', {
        riderId: rider.riderId,
        name: rider.name,
        time: new Date().toISOString()
      });
    }
    
    // Mark customer offline
    const customer = Object.values(db.customers).find(c => c.socketId === socket.id);
    if (customer) {
      customer.socketId = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  ============================================
  🚀 THE LAND RIDERS BACKEND - COMPLETE VERSION
  ============================================
  Port: ${PORT}
  URL: https://bykea-testing-production.up.railway.app
  Time: ${new Date().toLocaleString()}
  ============================================
  `);
  console.log('✅ All event handlers registered');
  console.log('✅ File storage enabled');
  console.log('✅ Real-time updates ready');
});
