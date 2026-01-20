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

// File-based storage (persists through restarts)
const DATA_FILE = path.join(__dirname, 'data.json');

// Load data from file
let db = {
  riders: {},
  customers: {},
  rides: {},
  admins: { admin_001: { username: 'admin', password: 'admin123', name: 'Admin' } }
};

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = { ...db, ...saved };
    console.log('📁 Loaded saved data');
  } catch (e) {
    console.log('No saved data, starting fresh');
  }
}

// Save data to file
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  console.log('💾 Data saved');
}

// Auto-save every 30 seconds
setInterval(saveData, 30000);

app.get('/', (req, res) => {
  res.json({
    app: 'THE LAND RIDERS',
    status: '🚀 PERMANENT SERVER',
    stats: {
      riders: Object.keys(db.riders).length,
      customers: Object.keys(db.customers).length,
      rides: Object.keys(db.rides).length,
      lastUpdated: new Date().toISOString()
    }
  });
});

io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);

  socket.emit('connected', { message: 'Connected to LAND RIDERS', id: socket.id });

  // ==================== ADMIN ====================
  socket.on('admin_login', (data) => {
    const admin = Object.values(db.admins).find(a => 
      a.username === data.username && a.password === data.password
    );
    
    if (admin) {
      console.log('👑 Admin logged in:', data.username);
      
      socket.emit('admin_login_success', {
        admin: { username: admin.username, name: admin.name },
        stats: {
          totalRiders: Object.keys(db.riders).length,
          totalCustomers: Object.keys(db.customers).length,
          totalRides: Object.keys(db.rides).length
        },
        riders: Object.values(db.riders),
        customers: Object.values(db.customers),
        rides: Object.values(db.rides)
      });
    } else {
      socket.emit('admin_login_failed', { message: 'Invalid credentials' });
    }
  });

  socket.on('create_rider', (data) => {
    const riderId = 'RDR' + Date.now() + Math.random().toString(36).substr(2, 4).toUpperCase();
    
    db.riders[riderId] = {
      riderId,
      name: data.name,
      phone: data.phone,
      vehicle: data.vehicle,
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
    const rider = Object.values(db.riders).find(r => r.riderId === data.riderId);
    
    if (rider && rider.password === data.password) {
      rider.status = 'online';
      rider.lastLogin = new Date().toISOString();
      rider.socketId = socket.id;
      
      saveData();
      console.log('🏍️ Rider logged in:', rider.name);
      
      socket.emit('rider_login_success', {
        rider: {
          riderId: rider.riderId,
          name: rider.name,
          phone: rider.phone,
          vehicle: rider.vehicle,
          status: 'online',
          earnings: rider.earnings,
          totalRides: rider.totalRides
        }
      });
    } else {
      socket.emit('login_failed', { message: 'Invalid credentials' });
    }
  });

  // ==================== CUSTOMER ====================
  socket.on('customer_register', (data) => {
    const customerId = 'CUST' + Date.now();
    
    db.customers[customerId] = {
      customerId,
      name: data.name,
      phone: data.phone,
      password: data.password,
      createdAt: new Date().toISOString(),
      totalRides: 0,
      socketId: socket.id
    };
    
    saveData();
    console.log('👤 Customer registered:', data.name);
    
    socket.emit('register_success', {
      customer: {
        customerId,
        name: data.name,
        phone: data.phone
      }
    });
  });

  socket.on('customer_login', (data) => {
    const customer = Object.values(db.customers).find(c => c.phone === data.phone);
    
    if (customer && customer.password === data.password) {
      customer.socketId = socket.id;
      customer.lastLogin = new Date().toISOString();
      
      saveData();
      console.log('👤 Customer logged in:', customer.name);
      
      socket.emit('login_success', {
        customer: {
          name: customer.name,
          phone: customer.phone,
          customerId: customer.customerId,
          totalRides: customer.totalRides || 0
        }
      });
    } else {
      socket.emit('login_failed', { message: 'Invalid credentials' });
    }
  });

  socket.on('request_ride', (data) => {
    const rideId = 'RIDE' + Date.now();
    
    db.rides[rideId] = {
      rideId,
      customerId: data.customerId || 'guest',
      customerName: data.customerName || 'Customer',
      pickup: data.pickup,
      destination: data.destination,
      status: 'pending',
      createdAt: new Date().toISOString(),
      offers: []
    };
    
    saveData();
    console.log('🚖 Ride requested:', rideId);
    
    // Notify all online riders
    const onlineRiders = Object.values(db.riders).filter(r => r.status === 'online');
    onlineRiders.forEach(rider => {
      if (rider.socketId) {
        io.to(rider.socketId).emit('new_ride_request', {
          rideId,
          customerName: db.rides[rideId].customerName,
          pickup: data.pickup,
          destination: data.destination,
          createdAt: new Date().toISOString()
        });
      }
    });
    
    socket.emit('ride_requested', {
      rideId,
      message: 'Ride request sent to available riders'
    });
  });

  socket.on('disconnect', () => {
    console.log('❌ Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 PERMANENT Server running on port ${PORT}`);
  console.log(`📁 Data will be saved to: ${DATA_FILE}`);
});
