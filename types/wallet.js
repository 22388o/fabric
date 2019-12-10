'use strict';

const config = require('../settings/default');

// External Dependencies
const BN = require('bn.js');

// Types
const EncryptedPromise = require('./promise');
const Transaction = require('./transaction');
const Collection = require('./collection');
const Consensus = require('./consensus');
const Entity = require('./entity');
const Hash256 = require('./hash256');
const Service = require('./service');
const State = require('./state');

// Bcoin
const bcoin = require('bcoin/lib/bcoin-browser');

// Convenience classes...
const Address = bcoin.Address;
const Coin = bcoin.Coin;
const WalletDB = bcoin.WalletDB;
const WalletKey = bcoin.wallet.WalletKey;
const Outpoint = bcoin.Outpoint;
const Output = bcoin.Output;
const Keyring = bcoin.wallet.WalletKey;
const Mnemonic = bcoin.hd.Mnemonic;
const HD = bcoin.hd;
const MTX = bcoin.MTX;
const Script = bcoin.Script;

/**
 * Manage keys and track their balances.
 * @property {String} id Unique identifier for this {@link Wallet}.
 * @type {Object}
 */
class Wallet extends Service {
  /**
   * Create an instance of a {@link Wallet}.
   * @param  {Object} [settings={}] Configure the wallet.
   * @param  {Number} [verbosity=2] One of: 0 (none), 1 (error), 2 (warning), 3 (notice), 4 (debug), 5 (audit)
   * @return {Wallet}               Instance of the wallet.
   */
  constructor (settings = {}) {
    super(settings);

    // Create a Marshalling object
    this.marshall = {
      collections: {
        'transactions': null, // not yet loaded, seek for Buffer,
        'orders': null
      }
    };

    this.settings = Object.assign({
      name: 'primary',
      network: config.network,
      language: config.language,
      decimals: 8,
      verbosity: 2,
      witness: false,
      key: null
    }, settings);

    this.database = new WalletDB({
      db: 'memory',
      network: this.settings.network
    });

    bcoin.set(this.settings.network);

    this.account = null;
    this.manager = null;
    this.wallet = null;
    this.master = null;
    this.ring = null;
    this.seed = null;
    this.key = null;

    // TODO: enable wordlist translations
    // this.words = Mnemonic.getWordlist(this.settings.language).words;
    this.mnemonic = null;
    this.index = 0;

    this.accounts = new Collection();
    this.addresses = new Collection();
    this.keys = new Collection();
    this.coins = new Collection();
    this.secrets = new Collection();
    this.outputs = new Collection();

    this.entity = new Entity(this.settings);
    this.consensus = new Consensus();

    // Internal State
    this._state = {
      coins: [],
      keys: {},
      transactions: [],
      orders: []
    };

    // External State
    this.state = {
      asset: this.settings.asset || null,
      balances: {
        confirmed: 0,
        unconfirmed: 0
      },
      coins: [],
      keys: [],
      transactions: [],
      orders: []
    };

    Object.defineProperty(this, 'database', { enumerable: false });
    Object.defineProperty(this, 'wallet', { enumerable: false });

    this.status = 'closed';

    return this;
  }

  get id () {
    return this.settings.id || this.entity.id;
  }

  get balance () {
    return this.get('/balances/confirmed');
  }

  get transactions () {
    return this.get('/transactions');
  }

  get orders () {
    return this.get('/orders');
  }

  /**
   * Returns a bech32 address for the provided {@link Script}.
   * @param {Script} script 
   */
  getAddressForScript (script) {
    // TODO: use Fabric.Script
    let p2wsh = script.forWitness();
    let address = p2wsh.getAddress().toBech32(this.settings.network);
    return address;
  }

  /**
   * Generate a {@link BitcoinAddress} for the supplied {@link BitcoinScript}.
   * @param {BitcoinScript} redeemScript 
   */
  getAddressFromRedeemScript (redeemScript) {
    if (!redeemScript) return null;
    return Address.fromScripthash(redeemScript.hash160());
  }

  CSVencode (locktime, seconds = false) {
    let locktimeUint32 = locktime >>> 0;
    if (locktimeUint32 !== locktime)
      throw new Error('Locktime must be a uint32.');

    if (seconds) {
      locktimeUint32 >>>= this.consensus.SEQUENCE_GRANULARITY;
      locktimeUint32 &= this.consensus.SEQUENCE_MASK;
      locktimeUint32 |= this.consensus.SEQUENCE_TYPE_FLAG;
    } else {
      locktimeUint32 &= this.consensus.SEQUENCE_MASK;
    }

    return locktimeUint32;
  }

  async generateSignedTransactionTo (address, amount) {
    if (!address) throw new Error(`Parameter "address" is required.`);
    if (!amount) throw new Error(`Parameter "amount" is required.`);

    let bn = new BN(amount + '', 10);
    // TODO: labeled keypairs
    let clean = await this.generateCleanKeyPair();
    let change = await this.generateCleanKeyPair();

    let mtx = new MTX();
    let cb = await this._generateFakeCoinbase(amount);

    mtx.addOutput({
      address: address,
      amount: amount
    });

    await mtx.fund(this._state.coins, {
      rate: 10000, // TODO: fee calculation
      changeAddress: change.address
    });

    let coin = Coin.fromTX(cb, 0, -1);
    this._state.coins.push(coin);
    // TODO: store above coinbase in this.state._coins
    // TODO: reconcile above two lines

    mtx.addOutput({
      address: address,
      amount: amount
    });

    await mtx.fund(this._state.coins, {
      rate: 10000, // TODO: fee calculation
      changeAddress: change.address
    });

    mtx.sign(this.ring);
    // mtx.signInput(0, this.ring);

    let tx = mtx.toTX();
    let output = Coin.fromTX(mtx, 0, -1);
    let raw = mtx.toRaw();
    let hash = Hash256.digest(raw.toString('hex'));

    return {
      type: 'BitcoinTransaction',
      data: {
        tx: tx,
        output: output,
        raw: raw.toString('hex'),
        hash: hash
      }
    };
  }

  async _createAccount (data) {
    console.log('wallet creating account with data:', data);
    await this._load();
    let existing = await this.wallet.getAccount(data.name);
    if (existing) return existing;
    let account = await this.wallet.createAccount(data);
    return account;
  }

  async _updateBalance (amount) {
    return this.set('/balances/confirmed', amount);
  }

  _handleWalletTransaction (tx) {
    console.log('[BRIDGE:WALLET]', 'incoming transaction:', tx);
  }

  _getDepositAddress () {
    return this.ring.getAddress().toString();
  }

  _getSeed () {
    return this.seed;
  }

  _getAccountByIndex (index = 0) {
    return {
      address: this.account.deriveReceive(index).getAddress('string')
    };
  }

  async _addOutputToSpendables (coin) {
    this._state.coins.push(coin);
    return this;
  }

  async _generateFakeCoinbase (amount = 1) {
    // TODO: use Satoshis for all calculations
    let num = new BN(amount, 10);

    // TODO: remove all fake coinbases
    // TODO: remove all short-circuits
    // fake coinbase
    let cb = new MTX();
    let clean = await this.generateCleanKeyPair();

    // Coinbase Input
    cb.addInput({
      prevout: new Outpoint(),
      script: new Script(),
      sequence: 0xffffffff
    });

    // Add Output to pay ourselves
    cb.addOutput({
      address: clean.address,
      value: 5000000000
    });

    // TODO: remove short-circuit
    let coin = Coin.fromTX(cb, 0, -1);
    let tx = cb.toTX();

    await this._addOutputToSpendables(coin);

    return {
      type: 'BitcoinTransactionOutput',
      data: {
        tx: cb,
        coin: coin
      }
    };
  }

  async _getFreeCoinbase (amount = 1) {
    let num = new BN(amount, 10);
    let max = new BN('5000000000000', 10); // upper limit per coinbase
    let hun = new BN('100000000', 10); // one hundred million
    let value = num.mul(hun); // amount in Satoshis

    if (value.gt(max)) {
      value = max;
    }

    let v = value.toString(10);
    let w = parseInt(v);

    await this._load();

    const coins = {};
    const coinbase = new MTX();

    // INSERT 1 Input
    coinbase.addInput({
      prevout: new Outpoint(),
      script: new Script(),
      sequence: 0xffffffff
    });

    try {
      // INSERT 1 Output
      coinbase.addOutput({
        address: this._getDepositAddress(),
        value: w
      });
    } catch (E) {
      console.error('Could not add output:', E);
    }

    // TODO: wallet._getSpendableOutput()
    let coin = Coin.fromTX(coinbase, 0, -1);
    this._state.coins.push(coin);

    // console.log('coinbase:', coinbase);
    
    return coinbase;
  }

  /**
   * Signs a transaction with the keyring.
   * @param {BcoinTX} tx 
   */
  async _sign (tx) {
    let signature = await tx.sign(this.keyring);
    console.log('signing tx:', tx);
    console.log('signing sig:', signature);
    return Object.assign({}, tx, { signature });
  }

  /**
   * Create a crowdfunding transaction.
   * @param {Object} fund 
   */
  async _createCrowdfund (fund = {}) {
    if (!fund.amount) return null;
    if (!fund.address) return null;

    let index = fund.index || 0;
    let hashType = Script.hashType.ANYONECANPAY | Script.hashType.ALL;

    mtx.addCoin(this._state.coins[0]);
    mtx.scriptInput(index, this._state.coins[0], this.keyring);
    mtx.signInput(index, this._state.coins[0], this.keyring, hashType);

    await this.commit();

    return {
      tx: mtx.toTX(),
      mtx: mtx
    };
  }

  async _createSeed () {
    let mnemonic = new Mnemonic({ bits: 256 });
    return { seed: mnemonic.toString() };
  }

  async _createIncentivizedTransaction (config) {
    console.log('creating incentivized transaction with config:', config);

    let mtx = new MTX();
    let data = new Script();
    let clean = await this.generateCleanKeyPair();

    data.pushSym('OP_IF');
    data.pushSym('OP_SHA256');
    data.pushData(Buffer.from(config.hash));
    data.pushSym('OP_EQUALVERIFY');
    data.pushData(Buffer.from(config.payee));
    data.pushSym('OP_CHECKSIG');
    data.pushSym('OP_ELSE');
    data.pushInt(config.locktime);
    data.pushSym('OP_CHECKSEQUENCEVERIFY');
    data.pushSym('OP_DROP');
    data.pushData(Buffer.from(clean.public));
    data.pushSym('OP_CHECKSIG');
    data.pushSym('OP_ENDIF');
    data.compile();

    console.log('address data:', data);
    let segwitAddress = await this.getAddressForScript(data);

    mtx.addOutput({
      address: segwitAddress,
      value: 0
    });

    // TODO: load available outputs from wallet
    let out = await mtx.fund([] /* coins */, {
      // TODO: fee estimation
      rate: 10000,
      changeAddress: this.ring.getAddress()
    });

    console.log('transaction:', out);
    return out;
  }

  async _getBondAddress () {
    await this._load();

    let script = new Script();
    let clean = await this.generateCleanKeyPair();

    if (this.settings.verbosity >= 5) console.log('[AUDIT]', 'getting bond address, clean:', clean);

    // write the contract
    // script.pushData(clean.public.toString('hex'));
    // script.pushSym('OP_CHECKSIG');

    // compile the script
    // script.compile();

    return {
      pubkey: clean.public.toString(),
      address: clean.address
    };
  }

  async _getSpendableOutput (target, amount = 0) {
    let self = this;
    let key = null;
    let out = null;
    let mtx = new MTX();

    await this._load();

    console.log('funding transaction with coins:', this._state.coins);

    // INSERT 1 Output
    mtx.addOutput({
      address: target,
      value: amount
    });

    out = await mtx.fund(this._state.coins, {
      // TODO: fee estimation
      rate: 10000,
      changeAddress: self.ring.getAddress()
    });

    console.log('out:', out);

    console.trace('created mutable transaction:', mtx);
    console.trace('created immutable transaction:', mtx.toTX());

    return {
      tx: mtx.toTX(),
      mtx: mtx
    };
  }

  async _scanBlockForTransactions (block) {
    console.log('[AUDIT]', 'Scanning block for transactions:', block);
    let found = [];
  }

  async _scanChainForTransactions (chain) {
    console.log('[AUDIT]', 'Scanning chain for transactions:', chain);

    let transactions = [];

    for (let i = 0; i < chain.blocks.length; i++) {
      transactions.concat(await this._scanBlockForTransactions(chain.blocks[i]));
    }

    return transactions;
  }

  async getFirstAddressSlice (size = 256) {
    await this._load();

    // aggregate results for return
    let slice = [];

    // iterate over length of shard, aggregate addresses
    for (let i = 0; i < size; i++) {
      let addr = this.account.deriveReceive(i).getAddress('string');
      slice.push(await this.addresses.create({
        string: addr,
        label: `shared address ${i} for wallet ${this.id}`
      }));
    }

    return slice;
  }

  async generateCleanKeyPair () {
    if (this.status !== 'loaded') await this._load();

    this.index++;

    let key = this.master.derivePath(`m/44/0/0/0/${this.index}`);
    let keyring = bcoin.KeyRing.fromPrivate(key.privateKey);

    return {
      index: this.index,
      public: keyring.publicKey.toString('hex'),
      address: keyring.getAddress('string'),
      keyring: keyring
    };
  }

  async _handleWalletBalance (balance) {
    if (this.settings.verbosity >= 4) console.log('wallet balance:', balance);
    await this._PUT(`/balance`, balance);

    let depositor = new State({ name: this.settings.name || 'default' });
    await this._PUT(`/depositors/${depositor.id}/balance`, balance);
    this.emit('balance', balance);
  }

  async _registerAccount (obj) {
    if (!obj.name) throw new Error('Account must have "name" property.');
    if (!this.database.db.loaded) {
      await this.database.open();
    }

    // TODO: register account with this.wallet
    let wallet = await this.wallet.createAccount({ name: obj.name });
    if (this.settings.verbosity >= 4) console.log('bcoin wallet account:', wallet);
    let actor = Object.assign({
      account: wallet
    }, obj);

    let account = await this.accounts.create(obj);
    if (this.settings.verbosity >= 4) console.log('registering account, created:', account);

    if (this.manager) {
      this.manager.on('tx', this._handleWalletTransaction.bind(this));
      this.manager.on('balance', this._handleWalletBalance.bind(this));
    }

    return account;
  }

  async _loadSeed (seed) {
    this.settings.key = { seed };
    await this._load();
    return this.seed;
  }

  async _unload () {
    return this.database.close();
  }

  /**
   * Initialize the wallet, including keys and addresses.
   * @param {Object} settings 
   */
  async _load (settings = {}) {
    if (this.wallet) return this;

    this.status = 'loading';
    this.master = null;

    if (!this.database.db.loaded) {
      await this.database.open();
    }

    if (this.settings.key && this.settings.key.seed) {
      if (this.settings.verbosity >= 3) console.log('[AUDIT]', 'Restoring wallet from provided seed:', this.settings.key.seed);
      let mnemonic = new Mnemonic(this.settings.key.seed);
      this.master = bcoin.hd.fromMnemonic(mnemonic);
      this.seed = new EncryptedPromise({ data: this.settings.key.seed });
    } else {
      if (this.settings.verbosity >= 3) console.log('[AUDIT]', 'Generating new HD key for wallet...');
      this.master = bcoin.hd.generate(this.settings.network);
    }

    try {
      this.wallet = await this.database.create({
        network: this.settings.network,
        master: this.master
      });
    } catch (E) {
      console.error('Could not create wallet:', E);
    }

    // Setup Ring
    this.ring = new bcoin.KeyRing(this.master, this.settings.network);
    this.ring.witness = this.settings.witness; // designates witness

    if (this.settings.verbosity >= 4) console.log('keyring:', this.ring);
    if (this.settings.verbosity >= 4) console.log('address from keyring:', this.ring.getAddress().toString());

    this.account = await this.wallet.getAccount('default');

    // Let's call it a shard!
    this.shard = await this.getFirstAddressSlice();
    // console.log('shard created:', await this.addresses.asMerkleTree());
    // console.log('shard created:', this.shard);

    if (this.settings.verbosity >= 3) console.log('[AUDIT]', 'Wallet account:', this.account);
    // TODO: also retrieve key for address
    // let key = this.master.derivePath('m/44/0/0/0/0');
    // TODO: label as identity address
    // this.address = await this.account.receiveAddress();
    // TODO: notify downstream of short-circuit removal

    this.status = 'loaded';
    this.emit('ready');

    return this;
  }

  /**
   * Start the wallet, including listening for transactions.
   */
  async start () {
    return this._load();
  }
}

module.exports = Wallet;