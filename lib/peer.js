'use strict';

const net = require('net');
const util = require('util');
const crypto = require('crypto');
const stream = require('stream');

const Key = require('./key');
const Message = require('./message');
const Vector = require('./vector');

// TODO: implement the noise protocol: http://noiseprotocol.org/noise.html
const P2P_IDENT_REQUEST = 0x01; // 1, or the identity
const P2P_IDENT_RESPONSE = 0x11;
const P2P_ROOT = 0x00000000;
const P2P_PING = 0x00000012; // same ID as Lightning (18)
const P2P_PONG = 0x00000013; // same ID as Lightning (19)
const P2P_INSTRUCTION = 0x00000020; // TODO: select w/ no overlap
const P2P_STATE_COMMITTMENT = 0x00000032; // TODO: select w/ no overlap
const P2P_STATE_CHANGE = 0x00000033; // TODO: select w/ no overlap

const OP_ADD = 0x93;

/**
 * An in-memory representation of a node in our network.
 * @param       {Vector} config - Initialization Vector for this peer.
 * @constructor
 */
function Peer (config) {
  this.config = Object.assign({
    address: '0.0.0.0',
    port: 7777
  }, config || {});

  this.stream = new stream.Transform({
    transform (chunk, encoding, callback) {
      // TODO: parse as encrypted data
      callback(null, chunk);
    }
  });

  // TODO: attempt to use handler binding
  // probably bug with this vs. self
  // this.stream.on('data', this._handler.bind(this));

  this.key = this.config.key || new Key();
  this.hex = this.key.public.encodeCompressed('hex');
  this.id = crypto.createHash('sha256').update(this.hex).digest('hex');

  this.address = this.config.address;
  this.port = this.config.port;

  this.connections = {};
  this.peers = {};

  this.clock = 0;
  this.stack = [];
  this.known = {};

  this.init();
}

util.inherits(Peer, Vector);

Peer.prototype._connect = function connect (address) {
  let self = this;
  let parts = address.split(':');
  let known = Object.keys(self.connections);

  if (parts.length !== 2) return self.debug('Invalid address:', address);
  if (known.includes(address)) return self.connections[address];

  try {
    self.connections[address] = new net.Socket();

    self.connections[address].on('error', function (err) {
      self.debug('[PEER]', `could not connect to peer ${address} — Reason:`, err);
    });

    // TODO: unify as _dataHandler
    self.connections[address].on('data', function (data) {
      let message = self._parseMessage(data);
      let response = self._handleMessage(message);

      // disconnect from any peer sending invalid messages
      if (!message) this.destroy();
      if (response) {
        this.write(response.asRaw());
      }
    });

    // TODO: replace with handshake
    self.connections[address].connect(parts[1], parts[0], function () {
      self.emit('connection', {
        address: address,
        status: 'handshake',
        initiator: true
      });

      self.log(`connection to ${address} established!`);

      // TODO: check peer ID, eject if self or known
      let message = Message.fromVector([P2P_IDENT_REQUEST, self.id]);
      self.connections[address].write(message.asRaw());
    });
  } catch (E) {
    self.log('[PEER]', 'failed to connect:', E);
  }

  return self.connections[address];
};

Peer.prototype._parseMessage = function (data) {
  if (!data) return false;

  let self = this;
  let message = null;

  try {
    message = Message.fromRaw(data);
  } catch (E) {
    self.debug('[PEER]', 'error parsing message:', E);
  }

  return message;
};

Peer.prototype._handleConnection = function _handleConnection (socket) {
  let self = this;
  let address = [socket.remoteAddress, socket.remotePort].join(':');

  self.log('incoming connection:', address);

  self.emit('connection', {
    address: address,
    status: 'connected',
    initiator: false
  });

  socket.on('end', function terminate () {
    self.log('connection ended:', address);
    self.emit('part', address);
  });

  // TODO: unify as _dataHandler
  socket.on('data', function (data) {
    let message = self._parseMessage(data);
    let response = self._handleMessage(message);

    // disconnect from any peer sending invalid messages
    if (!message) this.destroy();
    if (response) {
      this.write(response.asRaw());
    }
  });

  // add this socket to the list of known connections
  this.connections[address] = socket;
};

Peer.prototype.broadcast = function message (message) {
  if (typeof message !== 'string') message = JSON.stringify(message);

  for (let i in this.connections) {
    let conn = this.connections[i];
    if (!conn.connecting && !conn._hadError) {
      // TODO: select type byte for state updates
      let msg = Message.fromVector([P2P_STATE_CHANGE, message]);
      conn.write(msg.asRaw());
    }
  }
};

/**
 * Start listening for connections.
 * @fires Peer#ready
 * @return {Peer} Chainable method.
 */
Peer.prototype.listen = function listen () {
  let self = this;
  self.server = net.createServer(self._handleConnection.bind(self));
  self.server.listen(self.config.port, self.config.address, function () {
    if (self.config.debug) {
      self.log('[PEER]', `${self.id} now listening on tcp://${self.address}:${self.port}`);
    }
    self.emit('ready');
  });
  return self;
};

// should there be a message queue?
Peer.prototype._handleMessage = function handler (message) {
  if (!message) return false;

  let self = this;
  let response = null;

  switch (message.type) {
    default:
      self.log('[PEER]', `unhandled message type "${message.type}"`);
      break;
    case P2P_IDENT_REQUEST:
      response = Message.fromVector([P2P_IDENT_RESPONSE, self.id]);
      break;
    case P2P_IDENT_RESPONSE:
      if (!self.peers[message.data]) {
        let peer = { id: message.data };
        self.peers[message.data] = peer;
        self.emit('peer', peer);
      }
      break;
    // TODO: consider renaming to TX
    case P2P_STATE_CHANGE:
      self.log('type was STATE_CHANGE, change is:', message.data);
      // TODO: validate (!) & then (!) apply state change
      let changes = null;

      try {
        changes = JSON.parse(message.data);
      } catch (E) {
        self.debug('Could not parse change:', message.data);
        return false;
      }

      if (changes) {
        self.emit('changes', changes);
      }

      break;
    case P2P_ROOT:
      response = Message.fromVector([P2P_STATE_COMMITTMENT, self.state]);
      self.log('type was ROOT, sending state root:', response);
      self.log('type was ROOT, state was:', self.state);
      break;
    case P2P_PING:
      response = Message.fromVector([P2P_PONG, message.id]);
      self.log(`type was PING (${message.id}), sending PONG:`, response);
      break;
    case P2P_INSTRUCTION:
      // TODO: use Fabric.Script / Fabric.Machine
      let stack = message.data.split(' ');
      switch (stack[1]) {
        case 'SIGN':
          let signature = self.key._sign(stack[0]);
          let buffer = Buffer.from(signature);
          let script = [buffer.toString('hex'), 'CHECKSIG'].join(' ');

          response = Message.fromVector([P2P_INSTRUCTION, script]);
          break;
        default:
          self.log('[PEER]', `unhandled instruction "${stack[1]}"`);
          break;
      }

      break;
  }

  return response;
};

Peer.prototype.start = function start () {
  if (!this.server) {
    this.listen();
  }
};

Peer.prototype.stop = function stop () {
  this.server.close();
};

module.exports = Peer;