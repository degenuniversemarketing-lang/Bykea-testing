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

// In-memory storage (in production, use a database)
const activeRides = new Map(); // rideId -> ride data
const availableRiders = new Map(); // socketId -> rider data
const connectedUsers = new Map(); // socketId -> user data

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Customer connects
  socket.on('customer-connect', (customerData) => {
    connectedUsers.set(socket.id, { ...customerData, type: 'customer' });
    socket.join('customers');
    console.log(`Customer connected: ${customerData.name}`);
  });

  // Rider connects
  socket.on('rider-connect', (riderData) => {
    connectedUsers.set(socket.id, { ...riderData, type: 'rider' });
    availableRiders.set(socket.id, { ...riderData, socketId: socket.id });
    socket.join('riders');
    
    // Notify admin about new rider
    io.to('admin').emit('rider-status-changed', {
      riderId: socket.id,
      name: riderData.name,
      status: 'online'
    });
    
    console.log(`Rider connected: ${riderData.name}`);
  });

  // Admin connects
  socket.on('admin-connect', () => {
    socket.join('admin');
    console.log('Admin connected');
  });

  // Customer requests a ride
  socket.on('request-ride', (rideData) => {
    const rideId = `ride_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const customer = connectedUsers.get(socket.id);
    
    const newRide = {
      id: rideId,
      customerId: socket.id,
      customerName: customer.name,
      pickup: rideData.pickup,
      dropoff: rideData.dropoff,
      fare: rideData.fare,
      status: 'pending',
      createdAt: new Date(),
      offers: []
    };

    activeRides.set(rideId, newRide);
    
    // Notify customer
    socket.emit('ride-requested', {
      success: true,
      rideId,
      message: 'Ride requested. Waiting for riders...'
    });

    // Notify all available riders
    io.to('riders').emit('new-ride-available', newRide);
    
    // Notify admin
    io.to('admin').emit('new-ride', newRide);

    console.log(`New ride requested: ${rideId} by ${customer.name}`);
  });

  // Rider makes an offer
  socket.on('make-offer', (offerData) => {
    const rider = availableRiders.get(socket.id);
    const ride = activeRides.get(offerData.rideId);
    
    if (!ride || !rider) return;

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
    activeRides.set(offerData.rideId, ride);

    // Notify the specific customer
    io.to(ride.customerId).emit('new-offer', {
      rideId: offerData.rideId,
      offer
    });

    // Notify admin
    io.to('admin').emit('ride-updated', ride);

    console.log(`Rider ${rider.name} made offer for ride ${offerData.rideId}`);
  });

  // Customer accepts an offer
  socket.on('accept-offer', (acceptData) => {
    const ride = activeRides.get(acceptData.rideId);
    const offer = ride.offers.find(o => o.riderId === acceptData.riderId);
    
    if (!ride || !offer) return;

    // Update ride status
    ride.status = 'accepted';
    ride.acceptedRiderId = acceptData.riderId;
    ride.acceptedRiderName = offer.riderName;
    ride.acceptedPrice = offer.price;
    ride.acceptedAt = new Date();
    activeRides.set(acceptData.rideId, ride);

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

    // Notify other riders that ride is taken
    io.to('riders').emit('ride-taken', {
      rideId: acceptData.rideId
    });

    // Notify admin
    io.to('admin').emit('ride-updated', ride);

    console.log(`Ride ${acceptData.rideId} accepted by ${offer.riderName}`);
  });

  // Ride status updates
  socket.on('update-ride-status', (statusData) => {
    const ride = activeRides.get(statusData.rideId);
    if (!ride) return;

    ride.status = statusData.status;
    if (statusData.status === 'picked_up') ride.pickedUpAt = new Date();
    if (statusData.status === 'completed') ride.completedAt = new Date();
    
    activeRides.set(statusData.rideId, ride);

    // Notify both parties
    io.to(ride.customerId).emit('ride-status-updated', {
      rideId: statusData.rideId,
      status: statusData.status,
      timestamp: new Date()
    });

    if (ride.acceptedRiderId) {
      io.to(ride.acceptedRiderId).emit('ride-status-updated', {
        rideId: statusData.rideId,
        status: statusData.status,
        timestamp: new Date()
      });
    }

    // Notify admin
    io.to('admin').emit('ride-updated', ride);
  });

  // Rider goes online/offline
  socket.on('rider-status', (statusData) => {
    const rider = availableRiders.get(socket.id);
    if (!rider) return;

    if (statusData.status === 'offline') {
      availableRiders.delete(socket.id);
    } else {
      availableRiders.set(socket.id, { ...rider, ...statusData });
    }

    io.to('admin').emit('rider-status-changed', {
      riderId: socket.id,
      name: rider.name,
      status: statusData.status
    });
  });

  // Get active rides (for reconnection)
  socket.on('get-active-rides', (userType) => {
    const ridesArray = Array.from(activeRides.values());
    
    if (userType === 'rider') {
      const availableRides = ridesArray.filter(ride => ride.status === 'pending');
      socket.emit('active-rides', availableRides);
    } else if (userType === 'customer') {
      const userRides = ridesArray.filter(ride => ride.customerId === socket.id);
      socket.emit('my-rides', userRides);
    } else if (userType === 'admin') {
      socket.emit('all-rides', ridesArray);
    }
  });

  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    
    if (user && user.type === 'rider') {
      availableRiders.delete(socket.id);
      io.to('admin').emit('rider-status-changed', {
        riderId: socket.id,
        name: user.name,
        status: 'offline'
      });
    }
    
    connectedUsers.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server ready for real-time connections`);
});
