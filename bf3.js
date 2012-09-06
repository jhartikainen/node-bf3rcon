var net = require('net'),
    events = require('events'),
    sys = require('util'),
    mongoose = require('mongoose'),
	winston = require('winston')
;

var Put = require('put');
var Binary = require('binary');

var Connection = function() {
    events.EventEmitter.call(this);

    this.callbacks = [];
    this.handlers = {};
};

sys.inherits(Connection, events.EventEmitter);

Connection.prototype.sequenceNumber = 0;
Connection.prototype.open = function(ip, port) {
    if(this.conn) {
		throw new Error('Connection already exists');
    }

    this.conn = net.createConnection(port, ip);
    this.conn.addListener('connect', function() {
		this.emit('connect');
    }.bind(this));

    this.conn.addListener('error', function(err) {
		this.emit('error', err);
    }.bind(this));

    this.conn.addListener('end', function(err) {
		console.log('End');
		console.dir(err);
    }.bind(this));

    this.conn.addListener('close', function() {
		console.log('net sock close');
		this.emit('close');
    }.bind(this));
    this.conn.addListener('timeout', function(err) {
		console.log('Timeout');
		console.dir(err);
    }.bind(this));

    this.beginStream();
};

Connection.prototype.disconnect = function() {
	this.conn.end();
};

Connection.prototype.processPacket = function(vars, body) {
    try {
		var h = this.decodeHeader(vars.info);
    }
    catch(err) {
		console.log('Error decoding header:');
		console.log(err);
		console.log(vars.info);
		return null;
    }

	var words = this.decodeWord(body, vars.wordCount);

    var packet = {
		isFromServer: h.isFromServer,
		isResponse: h.isResponse,
		sequence: h.sequence,
		words: words,
		success: (words.length == 0) ? false : (words[0] == 'OK')
    };

    if(this.callbacks[packet.sequence]) {
        this.callbacks[packet.sequence](packet);
        this.callbacks[packet.sequence] = undefined;
    }
    else {
		if(!packet.isFromServer) {
			console.log('Packet not from server');
			console.dir(packet);
		}
        this.emit('packet', packet);
    }
};

Connection.prototype.beginStream = function() {
	var header = new Buffer(12);
	var headInfo, bodySize, wordCount;
	var headerLen = 0;
	var headerParsed = false;
	var body = null;
	var bodyReceived = false;
	var bodyLen = 0;
	var headerRead = false;
	this.conn.on('data', function(buf) {
		process(buf);
	}.bind(this));

	var process = function(buf) {
		if(headerLen < 12) {
			if(headerLen + buf.length < 12) {
				buf.copy(header, headerLen);
				headerLen += buf.length;
			}
			else {
				var copyLen = headerLen != 0 ? 12 - headerLen : 12;
				buf.copy(header, headerLen, 0, copyLen);

				if(buf.length + headerLen > 12) {
					headerLen = 12;
					process(buf.slice(copyLen));
				}
				else {
					headerLen = 12;
				}
			}
		}
		else {
			if(!headerParsed) {
				headInfo = header.readUInt32LE(0);
				bodySize = header.readUInt32LE(4) - 12;
				wordCount = header.readUInt32LE(8);

				body = new Buffer(bodySize);
				headerParsed = true;
			}

			if(bodyLen + buf.length < bodySize) {
				buf.copy(body, bodyLen);
				bodyLen += buf.length;
			}
			else {
				//got complete body, next is header, so reset
				headerParsed = false;
				headerLen = 0;
				header.fill(0);

				var copyLen = bodyLen != 0 ? bodySize - bodyLen : bodySize;

				buf.copy(body, bodyLen, 0, copyLen);

				this.processPacket({
					info: headInfo,
					bodySize: bodySize,
					wordCount: wordCount
				}, body);


				if(bodyLen + buf.length > bodySize) {
					bodyLen = 0;
					process(buf.slice(copyLen));
				}
				else {
					bodyLen = 0;
				}
			}
		}
	}.bind(this);
};

Connection.prototype.decodeWord = function(body, count) {
    var words = [];
	var offset = 0;
	while(words.length < count) {
		var len = body.readUInt32LE(offset);
		offset += 4;
		
		var word = body.slice(offset, offset + len).toString('ascii');
		words.push(word);
		//+1 for the closing null byte not in word length
		offset += len + 1;
	}

	return words;
};

Connection.prototype.decodeHeader = function(data) {
    var h = Number(data);
    return {
	isFromServer: h.toString(2)[0] == 1,
	isResponse: h.toString(2)[1] == 1,
	sequence: (h & 0x3fffffff)
    };
};

Connection.prototype.executeRequest = function(request) {
    this.callbacks[this.sequenceNumber] = request.callback;
    var req = this.encodeClientRequest(request.parameters);

    try {
		this.conn.write(req);
    }
    catch(err) {
		console.log('Failed');
		console.dir(err);
		request.callback(err);
		this.callbacks[this.sequenceNumber] = undefined;
    }
};

Connection.prototype.encodeClientRequest = function(words) {
    var put = Put();
    this.encodePacket(put, false, false, words, this.sequenceNumber);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0x3fffffff;

    return put.buffer();
};

Connection.prototype.encodeClientResponse = function(seq, words) {
    return this.encodePacket(Put(), false, false, words, seq).buffer();
};

Connection.prototype.encodePacket = function(put, isFromServer, isResponse, words, seq) {
    this.encodeHeader(put, isFromServer, isResponse, seq);
    var wordput = Put();
    this.encodeWords(wordput, words);

    var wordbuf = wordput.buffer();
    put.word32le(wordbuf.length + 12);
    put.word32le(words.length);
    put.put(wordbuf);
    return put;
};

Connection.prototype.encodeWords = function(put, words) {
    words.forEach(function(word) {
		//ensure string
		word = ''+word;

		put.word32le(word.length);
		put.put(new Buffer(word, 'ascii'));
		put.word8('\x00');
    }, this);

    words = null;
};

Connection.prototype.encodeHeader = function(put, isFromServer, isResponse, seq) {
    var h = seq & 0x3fffffff;

    if(isFromServer) {
	h += 0x80000000
    }

    if(isResponse) {
	h += 0x40000000
    }

    put.word32le(h);
};

var Server = function(config) {
	this.maps = [];
	this.disabled = !!config.disabled;
	this.plugins = [];
	this.autoReconnect = (config.autoReconnect == null) ? true : config.reconnect;
	this.reloadConfig(config);
    this.resetState();
};

sys.inherits(Server, events.EventEmitter);

Server.prototype.getUserPlugins = function() {
	return this.plugins.filter(function(p) {
		return !!p.getConfig;
	});
};

Server.prototype.reloadConfig = function(c) {
	this.ip = c.ip;
	this.port = c.port;
	this.password = c.password;
	this.admins = c.admins ? c.admins.concat() : [];
};

Server.prototype.getDisplayName = function() {
	if(this.name) {
		return this.name;
	}

	return this.ip + ':' + this.port;
};

Server.prototype.getAccess = function(username) {
	for(var i = 0; i < this.admins.length; i++) {
		if(this.admins[i].username == username) {
			return this.admins[i].access;
		}
	}

	return [];
};

Server.prototype.getTeams = function() {
	var teams = [], i;
	//always at least three teams (neutral, usa and rus)
	for(i = 0; i < 3; i++) {
		teams[i] = [];
	}

	for(i = 0; i < this.players.length; i++) {
		var p = this.players[i];
		if(!teams[p.teamId]) {
			teams[p.teamId] = [];
		}

		teams[p.teamId].push(p);
	}

	return teams;
};

Server.prototype.resetState = function() {
	this.disconnecting = false;
    this.state = 'closed';
    this.players = [];
    this.commands = [];
    this.open = false;
	this.reconnectCount = 0;
	this.vars = { };
};

Server.prototype.toServerInfo = function(ignoreFields) {
	if(!ignoreFields) {
		ignoreFields = [];
	}

    return {
		id: this.id,
		serverId: this.id,
		name: this.name || '',
		serverName: this.name || '',
		map: this.map || '',
		mapName: this.mapName || '',
		players: ignoreFields.indexOf('players') != -1 ? [] : this.players,
		maxPlayers: this.maxPlayers || 0,
		modeName: this.modeName || '',
		numPlayers: this.players.length || 0,
		scores: this.scores || {},
		ranked: this.ranked,
		punkbuster: this.punkbuster,
		hardcore: this.isHardcore(),
		hasPassword: this.hasPassword,
		connected: this.open,
		ip: this.ip,
		port: this.port,
		currentMapIndex: this.currentMapIndex,
		nextMapIndex: this.nextMapIndex
    };
}


Server.prototype.connect = function(cb) {
	if(this.open) {
		if(cb) {
			cb('connected');
		}
		
		//already open, do nothing
		return;
	}

	//make sure we're not reconnecting
	clearTimeout(this.reconnectHandle);
	this.reconnectHandle = null;

    this.conn = new Connection();
    this.conn.open(this.ip, this.port);
    this.state = 'connecting';
	this.disconnecting = false;

    this.conn.addListener('connect', function() {
		this.state = 'connected';
		this.conn.executeRequest({
			parameters: ['login.plaintext', this.password],
			callback: function(packet) {
				if(packet.words[0] != 'OK') {
					if(packet.words[0] != 'InvalidPassword') {
						winston.debug('Unexpected authentication error! Logged to debug log');
						winston.debug(packet);
					}
					this.emit('error', 'auth');
					if(cb) {
						cb('auth');
					}

					return;
				}
				
				console.log('Server connected ' + this.id);
				this.reconnectCount = 0;
				this.open = true;
				this.state = 'open';
				this.emit('connect');
				if(cb) {
					cb();
				}

				this.updateServerInfo();
				if(!this.serverInfoTimer) {
					this.serverInfoTimer = setInterval(this.updateServerInfo.bind(this), 30000);
				}

				this.updateMapList();
				if(!this.mapListTimer) {
					this.mapListTimer = setInterval(this.updateMapList.bind(this), 5 * 60000);
				}

				this.updateBanList();
				if(!this.banListTimer) {
					this.banListTimer = setInterval(this.updateBanList.bind(this), 5 * 60000);
				}

				this.updateVars();
				if(!this.varsTimer) {
					this.varsTimer = setInterval(this.updateVars.bind(this), 60 * 60000);
				}

				this.getMapIndices();

				this.conn.executeRequest({
					parameters: ['admin.eventsEnabled', 'true'],
					callback: this.handleEventsEnabled.bind(this)
				});

				this.requestPlayerList();
				if(!this.playerListTimer) {
					this.playerListTimer = setInterval(this.requestPlayerList.bind(this), 30000);
				}
			}.bind(this)
		});
    }.bind(this));

    this.conn.addListener('packet', this.handlePacket.bind(this));
    this.conn.addListener('error', this.handleError.bind(this));
    this.conn.addListener('close', this.handleClose.bind(this));
};

Server.prototype.runNextRound = function(fn) {
    this.conn.executeRequest({
		parameters: ['mapList.runNextRound'],
		callback: function(packet) {
			if(fn) {
				if(packet.words[0] != 'OK') {
					fn(false);
				}
				else {
					fn(true);
				}
			}
		}
    });
};

Server.prototype.updateBanList = function() {
    if(!this.open) {
		console.log('Tried to update banlist, but not connected');
		return;
    }

	this.conn.executeRequest({
		parameters: ['banList.list'],
		callback: (function(packet) {
			if(!packet) {
				console.log('banlist list failed: no packet?');
				return;
			}

			if(packet.words[0] != 'OK') {
				console.log('banlist update failed:');
				console.dir(packet);
				return;
			}

			var words = packet.words;

			//drop OK
			words.shift();

			//THIS DOES NOT WORK! Spec says this should happen but it doesn't
			//--------------
			//entries max 100 per request. Might need to change this in the future
			//so that if count == 100, perform updates until count != 100 to get all bans if more than 100
			//var entryCount = words.shift();
			//--------------

			var bans = [];
			while(words.length > 0) {
				//this is also different from the documentation. Surprise!
				bans.push({
					type: words.shift(),
					id: words.shift(),
					banType: words.shift(),
					duration: words.shift(),
					noIdeaWhatThisIs: words.shift(),
					reason: words.shift()
				});
			}

			this.bans = bans;
		}).bind(this)
	});
};

Server.prototype.isNormal = function() {
	//based on server admin docs
	return this.vars.autoBalance && !this.vars.friendlyFire && this.vars.regenerateHealth
		&& this.vars.killCam && this.vars.miniMap && this.vars.hud && this.vars['3dSpotting']
		&& this.vars.miniMapSpotting && this.vars.nameTag && this.vars['3pCam'] && this.vars.regenerateHealth
		&& this.vars.vehicleSpawnAllowed && this.vars.soldierHealth == 100 && this.vars.playerRespawnTime == 100
		&& this.vars.playerManDownTime == 100 && this.vars.bulletDamage == 100 && !this.vars.onlySquadLeaderSpawn;
};

Server.prototype.isInfantryOnly = function() {
	//based on server admin docs
	return this.vars.autoBalance && !this.vars.friendlyFire && this.vars.regenerateHealth
		&& this.vars.killCam && this.vars.miniMap && this.vars.hud && this.vars['3dSpotting']
		&& this.vars.miniMapSpotting && this.vars.nameTag && !this.vars['3pCam'] && !this.vars.regenerateHealth
		&& !this.vars.vehicleSpawnAllowed && this.vars.soldierHealth == 100 && this.vars.playerRespawnTime == 100
		&& this.vars.playerManDownTime == 100 && this.vars.bulletDamage == 100 && !this.vars.onlySquadLeaderSpawn;
};

Server.prototype.isHardcore = function() {
	//definition of hardcore from server admin docs
	return this.vars.autoBalance && this.vars.friendlyFire && !this.vars.regenerateHealth
		&& !this.vars.killCam && this.vars.miniMap && !this.vars.hud && !this.vars['3dSpotting']
		&& this.vars.miniMapSpotting && !this.vars.nameTag && !this.vars['3pCam'] && !this.vars.regenerateHealth
		&& this.vars.vehicleSpawnAllowed && this.vars.soldierHealth == 60 && this.vars.playerRespawnTime == 100
		&& this.vars.playerManDownTime == 100 && this.vars.bulletDamage == 100 && this.vars.onlySquadLeaderSpawn;
};

//these are in docs but don't exist? allUnlocksUnlocked, crossHair
Server.GAME_VARS = {
	ranked: { type: 'bool', effect: 'start', label: 'Ranked' },
	gamePassword: { type: 'string', unranked: true, effect: 'round', label: 'Password' },
	serverName: { type: 'string', effect: 'round', label: 'Server name' },
	autoBalance: { type: 'bool', effect: 'now', label: 'Autobalance' },
	friendlyFire: { type: 'bool', effect: 'round', label: 'Friendly fire' },
	maxPlayers: { type: 'number', effect: 'round', label: 'Max players' },
	killCam: { type: 'bool', effect: 'round', label: 'Killcam' },
	miniMap: { type: 'bool', effect: 'round', label: 'Minimap' },
	hud: { type: 'bool', effect: 'round', label: 'Hud' },
	'3dSpotting': { type: 'bool', effect: 'round', label: '3D spotting' },
	miniMapSpotting: { type: 'bool', effect: 'round', label: 'Minimap spotting' },
	nameTag: { type: 'bool', effect: 'round', label: 'Enemy nametags' },
	'3pCam': { type: 'bool', effect: 'round', label: '3rd person vehicle cam' },
	regenerateHealth: { type: 'bool', effect: 'now', label: 'Regenerate health' },
	teamKillCountForKick: { type: 'number', effect: 'now', label: 'Teamkill count for kick' },
	teamKillValueForKick: { type: 'number', effect: 'now', label: 'Teamkill value for kick' },
	teamKillValueIncrease: { type: 'number', effect: 'now', label: 'Teamkill value per TK' },
	teamKillValueDecreasePerSecond: { type: 'number', effect: 'now', label: 'Teamkill value decrease/second' },
	teamKillKickForBan: { type: 'number', effect: 'now', label: 'Teamkill kicks for ban' },
	idleTimeout: { type: 'number', effect: 'now', label: 'Idle timeout (seconds)' },
	idleBanRounds: { type: 'number', effect: 'now', label: 'Ban player after idling X rounds' },
	roundStartPlayerCount: { type: 'number', effect: 'round', label: 'Players required for round start' },
	roundRestartPlayerCount: { type: 'number', effect: 'round', label: 'Players required for round restart' },
	vehicleSpawnAllowed: { type: 'bool', effect: 'now', label: 'Vehicles enabled' },
	vehicleSpawnDelay: { type: 'number', effect: 'now', label: 'Vehicle spawn delay %' },
	soldierHealth: { type: 'number', effect: 'now', label: 'Soldier health %' },
	playerRespawnTime: { type: 'number', effect: 'now', label: 'Respawn time %' },
	playerManDownTime: { type: 'number', effect: 'now', label: 'Man down time %' },
	bulletDamage: { type: 'number', effect: 'now', label: 'Bullet damage %' },
	gameModeCounter: { type: 'number', effect: 'now', label: 'Ticket count %' },
	onlySquadLeaderSpawn: { type: 'bool', effect: 'now', label: 'Spawn only on squad leader' }
};

Server.prototype.updateVars = function(fn) {
	if(!this.open) {
		console.log('Tried to get all vars, but not open');
		return;
	}

	var allVars = Object.keys(Server.GAME_VARS);

	fetchNext.call(this);

	function fetchNext() {
		var name = allVars.shift();
		if(!name) {
			if(fn) {
				fn(this.vars);
			}

			return;
		}

		this.getVar(name, function(err, val) {
			//getVar updates value, just check error
			if(err) {
				if(err == 'CommandDisallowedOnRanked') {
					//we may get this for some vars on ranked, we can safely ignore it.
				}
				else {
					//otherwise this is some error we might want to know about
					winston.debug('Failed loading variable ' + name + ': ' + err);
				}
			}

			fetchNext.call(this);
		}.bind(this));
	};
};

Server.prototype.getBans = function(page, fn) {
	fn(null, this.bans);
};

Server.prototype.getVar = function(name, fn) {
    this.conn.executeRequest({
		parameters: ['vars.' + name],
		callback: function(packet) {
			if(packet.words[0] != 'OK') {
				fn(packet.words[0]);
			}
			else {
				var varValue = packet.words[1];
				switch(Server.GAME_VARS[name].type) {
					case 'bool':
						this.vars[name] = (varValue == 'true');
						break;

					case 'number':
						this.vars[name] = +varValue;
						break;

					case 'string':
						this.vars[name] = varValue;
						break;

					default:
						throw new Error('Assert: variable ' + name + ' has no definition');
						break;
				}

				fn(false, this.vars[name]);
			}
		}.bind(this)
    });
};

Server.prototype.getVars = function(fn) {
	fn(false, this.vars);
};

Server.prototype.setVar = function(name, value, fn) {
	if(!this.open) {
		if(fn) {
			fn('connection', this.vars[name]);
		}

		return;
	}

	var uncastValue = value;
	if(Server.GAME_VARS[name].type == 'bool') {
		value = value ? 'true' : 'false';
	}
	else {
		value = '' + value;
	}

	console.log('Server.setVar: ' + name + ' - ' + value);
    this.conn.executeRequest({
		parameters: ['vars.' + name, value],
		callback: function(packet) {
			if(packet.words[0] != 'OK' && fn) {
				fn(packet.words[0], this.vars[name]);
			}
			else {
				this.vars[name] = uncastValue;
				if(fn) {
					fn(undefined, packet.words[1]);
				}
			}
		}.bind(this)
    });
};

Server.prototype.updateMapList = function() {
	if(!this.open) {
		return;
	}

    this.conn.executeRequest({
		parameters: ['mapList.list'],
		callback: this.handleMapList.bind(this)
    });
};

Server.prototype.updateServerInfo = function() {
	if(!this.open) {
		return;
	}

    this.conn.executeRequest({
		parameters: ['serverInfo'],
		callback: this.handleServerInfo.bind(this)
    });
};

Server.prototype.requestPlayerList = function() {
    if(!this.open) {
		return;
    }

    this.conn.executeRequest({
	parameters: ['admin.listPlayers', 'all'],
	callback: this.handleListPlayers.bind(this)
    });
};

Server.prototype.handleClose = function() {
	console.log('Connection was closed');
	this.cleanTimers();
    this.open = false;
    this.state = 'closed';
	this.emit('close');
};

Server.prototype.disconnect = function(cb) {
	var wasOpen = this.open;
	this.resetState();
	this.disconnecting = true;

	this.cleanTimers();

	if(!wasOpen) {
		//make sure we're not reconnecting
		clearTimeout(this.reconnectHandle);
		this.reconnectHandle = null;
	}
	else {
		this.conn.disconnect();
	}

	if(cb) {
		cb();
	}

	this.emit('serverinfo');
};

Server.prototype.cleanTimers = function() {
	//clear all updaters
	clearInterval(this.serverInfoTimer);
	this.serverInfoTimer = null;

	clearInterval(this.mapListTimer);
	this.mapListTimer = null;

	clearInterval(this.banListTimer);
	this.banListTimer = null;

	clearInterval(this.varsTimer);
	this.varsTimer = null;

	clearInterval(this.playerListTimer);
	this.playerListTimer = null;
};

Server.prototype.handleError = function(error) {
	this.cleanTimers();
    this.state = 'closed';
    this.open = false;
	this.emit('error', error);
};

Server.prototype.reconnect = function() {
    if(!this.reconnectHandle) {
		this.reconnectHandle = setTimeout(function() {
			this.reconnectCount++;
			this.reconnectHandle = null;
			this.connect();
		}.bind(this), 10000 * Math.min(this.reconnectCount + 1, 3));
    }
};

Server.prototype.handleListPlayers = function(packet) {
    this.updatePlayerlist(packet);
};

Server.prototype.updatePlayers = function(data) {
	for(var i = 0; i < this.players.length; i++) {
		for(var key in data) {
			this.players[i][key] = data[key];
		}
	}

    this.emit('listplayers', this.players);
};

Server.prototype.updatePlayer = function(name, data) {
	for(var i = 0; i < this.players.length; i++) {
		if(this.players[i].name == name) {
			for(var key in data) {
				this.players[i][key] = data[key];
			}
		}
	}
};

Server.prototype.updatePlayerlist = function(packet) {
    var words = packet.words.concat();

    //shift once to get rid of "OK"
    words.shift();

    /*
      { name: 'Spion00X',
          guid: 'EA_63531B158E25D72CB9E939CFB4D604C1',
	  teamId: '2',
	  squadId: '2',
	  kills: '0',
	  deaths: '2',
	  score: '530' },
      */

    var updatedPlayers = this.parsePlayerinfo(words);
	var playersByName = {};
	for(var i = 0; i < this.players.length; i++) {
		playersByName[this.players[i].name] = this.players[i];
	}

	for(i = 0; i < updatedPlayers.length; i++) {
		var p = updatedPlayers[i];
		if(playersByName[p.name]) {
			p.joinTime = playersByName[p.name].joinTime;
			p.streaks = playersByName[p.name].streaks;
			p.round = playersByName[p.name].round;
			p.dead = playersByName[p.name].dead;
		}
		else {
			p.joinTime = new Date();
		}

		//cast numeric fields to numbers
		for(var field in p) {
			switch(field) {
				case 'teamId':
				case 'squadId':
				case 'kills':
				case 'deaths':
				case 'score':
					p[field] = +p[field];
					break;

				default:
					//string field, don't need to do anything
			}
		}
	}

	this.players = updatedPlayers;
    this.emit('listplayers', this.players);
};

var makePlayer = function() {
	return { 
		name: '',
		dead: true,
		guid: '',
		score: 0,
		kills: 0,
		deaths: 0,
		teamId: 0, 
		squadId: 0,
		joinTime: new Date(),
		streaks: {
			deaths: 0,
			kills: 0,
			headshots: 0
		},
		round: {
			teamkills: 0
		}
	};
};
Server.prototype.parsePlayerinfo = function(infoblock) {
    var numFields = infoblock.shift();
    var fieldNames = infoblock.splice(0, numFields);
    var numPlayers = infoblock.shift();

    var players = [];
    while(players.length < numPlayers) {
		var playerblock = infoblock.splice(0, numFields);
		var player = makePlayer();
		for(var i = 0; i < playerblock.length; i++) {
			player[fieldNames[i]] = playerblock[i];
		}

		players.push(player);
    }

	return players;
};

Server.prototype.addPlayer = function(join) {
	var p = makePlayer();
	p.name = join.player;
	p.guid = join.id;

    this.players.push(p);
};

Server.prototype.removePlayer = function(leave) {
    for(var i = 0; i < this.players.length; i++) {
	if(this.players[i].name == leave.name) {
	    this.players.splice(i, 1);
	    break;
	}
    }
};

Server.CMD_HIDDEN_PREFIX = '/';
Server.CMD_NORMAL_PREFIX = '!';

Server.prototype.processChat = function(packet) {
	//we need to have a valid chat packet (chat sender, chat message)  and the message also needs to contain something
    if(packet.words.length > 2 && packet.words[2].length > 0) {
		//We don't need to care about messages from the server itself
		if(packet.words[1] == 'Server') {
			return false;
		}

		//test first word whether it's a command or not
		var endIdx = packet.words[2].indexOf(' ');
		if(endIdx == -1) {
			//if there's only one word, we want the entire string as a command
			endIdx = undefined;
		}

		var cmd = packet.words[2].substr(0, endIdx);
		if(cmd[0] == Server.CMD_HIDDEN_PREFIX) {
			this.processCommand(cmd.substr(1).toLowerCase(), {
				from: packet.words[1],
				params: packet.words[2].substr(cmd.length + 1),
				reply: this.privateSay.bind(this, packet.words[1])
			});

			return true;
		}
		else if(cmd[0] == Server.CMD_NORMAL_PREFIX) {
			this.processCommand(cmd.substr(1).toLowerCase(), { 
				from: packet.words[1],
				params: packet.words[2].substr(cmd.length + 1),
				reply: this.say.bind(this)
			});
		}

		/*if(packet.words[2].substr(0,5) == '!help') {
			this.say('Webcommander 0.2 - available commands:');
			this.say(this.commands.map(function(cmd) {
				return cmd.command;
			}).join(' '));
		}*/
    }

    packet = null;
	return false;
};

Server.prototype.processCommand = function(command, args) {
	for(var i = 0; i < this.commands.length; i++) {
		if(this.commands[i].command == command) {
			this.commands[i].handler(args);
			break;
		}
	}
};

Server.prototype.handlePacket = function(packet) {
    if(packet.words.length == 0) {
	return;
    }

    var words = packet.words;

    switch(words[0]) {
	case 'player.onJoin':
	    var join = { player: words[1], id: words[2] };
	    this.emit('join', join);
	    this.addPlayer(join);
	    break;
	case 'player.onChat':
	    var hiddenCommand = this.processChat(packet);

		//some messages may be hidden
		if(!hiddenCommand) {
			//Sometimes message does not exist. In that case, assume empty line
			var message = { from: words[1], message: words[2] || '', time: new Date() };
			mongoose.model('Server').update({ _id: this.id }, { $push: { 'history.chat': message } }, function(err) {
			if(err) {
				console.log('Updated chat?');
				console.dir(err);
			}
			});
			this.emit('chat', message);
		}
	    break;
	case 'player.onTeamChange':
		var name = words[1];
		var teamId = +words[2];
		var squadId = +words[3];
		this.updatePlayer(name, { squadId: squadId, teamId: teamId });
	    this.emit('teamchange', { player: words[1], team: teamId, squad: words[3] });
	    break;
	case 'player.onSquadChange':
		var name = words[1];
		var squadId = +words[3];
		this.updatePlayer(name, { squadId: squadId });
	    this.emit('squadchange', { player: name, team: words[2], squad: squadId });
	    break;
	case 'player.onKill':
		this.updatePlayer(words[1], { dead: false });
		this.updatePlayer(words[2], { dead: true });
		var kill = { player: words[1], killed: words[2], weapon: words[3], headshot: words[4] != 'false'};

		var p = this.findPlayer(kill.player);
		var victim = this.findPlayer(kill.killed);

		if(p) {
			p.kills++;
			p.streaks.deaths = 0;
			p.streaks.kills++;
			if(kill.headshot) {
				p.streaks.headshots++;
			}
			else {
				p.streaks.headshots = 0;
			}
		}

		if(victim) {
			victim.streaks.deaths++;
			victim.streaks.kills = 0;
			victim.streaks.headshots = 0;

			victim.deaths++;
			if(p && p.teamId == victim.teamId && p.name != victim.name) {
				p.round.teamkills++;
			}
		}

		this.handleKill(kill);
	    this.emit('kill', kill);
	    break;
	case 'player.onSpawn':
		this.updatePlayer(words[1], { dead: false });
	    this.emit('spawn', { player: words[1], team: words[2] });
	    break;
	case 'player.onLeave':
	    var leave = { player: words[1], soldierInfo: this.parsePlayerinfo(words.slice(2))[0] };
	    this.emit('leave', leave);
	    this.removePlayer(leave);
	    break;
	case 'player.onAuthenticated':
	    this.emit('authenticated', { player: words[1], id: words[2] });
	    break;
	case 'server.onLevelLoaded':
	    var map = words[1];
	    var mode = words[2];
	    this.emit('levelloaded', { level: map, mode: mode, roundsPlayed: words[3], roundsTotal: words[4] });
	    this.map = map;
	    this.mode = mode;
	    this.mapName = Server.MAP_NAMES[map];
	    this.modeName = Server.MODE_NAMES[mode];
		this.getMapIndices();
	    this.emit('serverinfo');
	    break;
	case 'server.onRoundOver':
		//mark all players as dead as round is now over
		//clear round datas
		for(var i = 0; i < this.players.length; i++) {
			this.players[i].dead = true;
			this.players[i].round.teamkills = 0;
			this.players[i].streaks.headshots = 0;
			this.players[i].streaks.kills = 0;
			this.players[i].streaks.deaths = 0;
		}

	    this.emit('roundover', { winner: words[1] });
	    break;
	case 'server.onRoundOverPlayers':
	    this.emit('roundoverplayers', { soldierInfo: words[1] });
	    break;
	case 'server.onRoundOverTeamScores':
	    this.emit('roundoverteamscores', { teamScores: words[1] });
	    break;
	case 'punkBuster.onMessage':
	    this.emit('punkbustermessage', { message: words[1] });
	    break;
	case 'listPlayers':
	    //Disabled for now because server sends empty lists for some reason
	    //this.updatePlayerlist(packet);
	    break;
	case 'OK':
	    //This is probably a reply to something we sent without a callback, ignore it.
	    break;

	default:
	    console.log('Unknown server response: ' + words[0]);
	    break;
    }
};

Server.prototype.handleEventsEnabled = function(packet) {
    if(packet.success) {
	console.log('Events have been enabled');
    }
    else {
	console.log('Event enable failed!');
	console.dir(packet);
    }
};

Server.MODE_SQUAD_RUSH = 'SquadRush0';
Server.MODE_RUSH = 'RushLarge0';
Server.MODE_CONQUEST = 'ConquestSmall0';
Server.MODE_CONQUEST_ASSAULT = 'ConquestSmall1';
Server.MODE_SQUAD_DEATHMATCH = 'SquadDeathMatch0';
Server.MODE_TEAM_DEATHMATCH = 'TeamDeathMatch0';
Server.MODE_NAMES = {
    SquadRush0: 'Squad Rush',
    RushLarge0: 'Rush',
    ConquestSmall0: 'Conquest',
    ConquestSmall1: 'Conquest Assault',
    ConquestLarge0: 'Conquest Large',
    SquadDeathMatch0: 'Squad Deathmatch',
    TeamDeathMatch0: 'Team Deathmatch'
};

Server.TEAM_NEUTRAL = 0;
Server.TEAM_USA = 1;
Server.TEAM_RUSSIA = 2;

Server.SQUAD_NONE = 0;

Server.MAP_NAMES = {
    MP_001: 'Grand Bazaar',
    MP_003: 'Teheran Highway',
    MP_007: 'Caspian Border',
    MP_011: 'Seine Crossing',
    MP_012: 'Operation Firestorm',
    MP_013: 'Damavand Peak',
    MP_017: 'Noshahar Canals',
    MP_018: 'Kharg Island',
    MP_Subway: 'Operation Metro',
	XP1_001: 'Strike at Karkand',
	XP1_002: 'Gulf of Oman',
	XP1_003: 'Sharqi Peninsula',
	XP1_004: 'Wake Island'
};

Server.prototype.addPlugin = function(p) {
    this.plugins.push(p);
    p.init(this);
};

Server.prototype.clearPlugins = function() {
    this.plugins.forEach(function(p) {
		p.destroy(this);
    }.bind(this));

    this.plugins = [];
};

Server.prototype.registerCommand = function(command, helpText, handler) {
    this.commands.push({
		command: command,
		help: helpText,
		handler: handler
    });
};

Server.prototype.unregisterCommand = function(command) {
    for(var i = 0; i < this.commands.length; i++) {
		if(this.commands[i].command == command) {
			this.commands.splice(i, 1);
			break;
		}
    }
};

Server.prototype.hasPlayer = function(name) {
    return this.players.some(function(p) { return p.name.toLowerCase() == name.toLowerCase(); });
};

Server.prototype.findPlayer = function(name) {
    for(var i = 0; i < this.players.length; i++) {
	if(this.players[i].name.toLowerCase() == name.toLowerCase()) {
	    return this.players[i];
	}
    }

    return null;
};

Server.prototype.kill = function(player, callback) {
	if(!this.open) {
		return;
	}

	console.log('Server.kill: ' + player);
	this.conn.executeRequest({
		parameters: ['admin.killPlayer', player],
		callback: function(packet) {
			if(callback) {
				callback(packet.words[0]);
			}
		}
	});
};

Server.prototype.saveBanList = function(callback) {
	if(!this.open) {
		if(callback) callback(false);
		return;
	}

	console.log('Server.saveBanList');
	this.conn.executeRequest({
		parameters: ['banList.save'],
		callback: function(packet) {
			if(packet.words[0] != 'OK') {
				console.log('failed saving banlist');
			}

			if(callback) {
				callback(packet.words[0] != 'OK' ? packet.words[0] : undefined);
			}
		}
	});

};

Server.prototype.unban = function(id, type, callback) {
	if(!this.open) {
		if(callback) callback(false);
		return;
	}

	if(id == null) {
		throw new Error('assert: id is null');
	}

	if(type == null) {
		throw new Error('assert: type is null');
	}

	console.log('Server.unban: ' + id);
	this.conn.executeRequest({
		parameters: ['banList.remove', type, id],
		callback: function(packet) {
			if(packet.words[0] == 'OK') {
				//keep internal list in sync
				for(var i = 0; i < this.bans.length; i++) {
					var b = this.bans[i];
					if(b.type == type && b.id == id) {
						//Ban are unique for each type/id pair so we need to remove just this one
						this.bans.splice(i, 1);
						break;
					}
				}

				this.saveBanList();
			}

			if(callback) {
				callback(packet.words[0]);
			}
		}.bind(this)
	});
};

Server.prototype.ban = function(player, idType, banType, duration, reason, callback) {
	if(!this.open) {
		if(callback) {
			callback('connection');
		}

		return false;
	}

	if(!player) {
		throw new Error('assert: player must be set');
	}

	if(!idType) {
		throw new Error('assert: idType must be set');
	}

	if(!banType) {
		throw new Error('assert: banType must be set');
	}

	if(banType == 'seconds' && !duration) {
		throw new Error('assert: when banType is seconds, duration must be set');
	}

	if(!reason) {
		reason = 'Banned by admin';
	}

	console.log('Server.ban: ' + player);

	var args = ['banList.add', idType, player, banType];
	if(duration) {
		args.push(duration);
	}
	args.push(reason);

	this.conn.executeRequest({
		parameters: args,
		callback: function(packet) {
			if(packet.words[0] == 'OK') {
				this.bans.push({
					type: idType,
					id: player,
					banType: banType,
					duration: duration,
					reason: reason
				});

				this.saveBanList();
			}

			if(callback) {
				callback(packet.words[0]);
			}
		}.bind(this)
	});
};

Server.prototype.kick = function(player, reason, callback) {
    if(!this.open) {
		console.log('Tried to kick, but not connected');
		return;
    }

    console.log('Server.kick: ' + player + '(' + (reason || 'No reason given') + ')');
    var params = ['admin.kickPlayer', player];
    if(reason) {
		params.push(reason);
    }

    this.conn.executeRequest({
		parameters: params,
		callback: function(packet) {
			if(callback) {
				callback(packet.words[0]);
			}
		}.bind(this)
    });
};

Server.prototype.getEmptySquad = function(teamId) {
	var usedSquads = [];
	for(var i = 0; i < this.players.length; i++) {
		var p = this.players[i];
		if(p.teamId == teamId) {
			usedSquads.push(p.squadId);
		}
	}

	for(var i = 1; i < 10; i++) {
		if(usedSquads.indexOf(i) == -1) {
			return i;
		}
	}

	return Server.SQUAD_NONE;
};

Server.prototype.movePlayer = function(player, teamId, params, callback) {
	if(!player) {
		console.log('No player');
		throw new Error('assert: no player');
		return;
	}

    if(!this.open) {
		console.log('Tried to move, but not connected');
		return;
    }


    var forceKill = 'true';
    if(params.forceKill === false) {
		forceKill = 'false';
    }

	var squadId = params.squadId || '0';

    console.log('Server.movePlayer: ' + player.name + ', team: ' + teamId + ', squad: ' + squadId);
    this.conn.executeRequest({
		parameters: ['admin.movePlayer', player.name, ''+teamId, ''+squadId, forceKill],
		callback: function(packet) {
			if(packet.words[0] == 'OK') {
				//Make sure player object stays in sync
				player.teamId = +teamId;
				player.squadId = +squadId;
			}

			if(callback) {
				callback(packet.words[0]);
			}
		}
    });
};

Server.prototype.say = function(message) {
    if(!this.open) {
	console.log('Tried to say, but not connected');
	return;
    }

    console.log('Server.say (' + this.conn.sequenceNumber + '): ' + message);
    this.conn.executeRequest({
	parameters: ['admin.say', message, 'all'],
	callback: function(p) { }
    });

    message = null;
};

Server.prototype.getNextMap = function(callback) {
	this.getMapIndices(function(err, current, next) {
		if(this.maps[next]) {
			var nextmap = this.maps[next];
			callback(undefined, nextmap.name, nextmap.mode, next);
		}
		else {
			callback('not-found');
		}
	}.bind(this));
};

Server.prototype.getMapIndices = function(callback) {
	if(!this.open) {
		console.log('Tried to get map but not connected');
		return;
	}

    console.log('Server.getMapIndices (' + this.conn.sequenceNumber + ')');

    this.conn.executeRequest({
		parameters: ['mapList.getMapIndices'],
		callback: function(pack) {
			if(pack.words[0] != 'OK') {
				callback(pack.words[0]);
			}
			else {
				var curIndex = +pack.words[1];
				var nextIndex = +pack.words[2];
				this.currentMapIndex = curIndex;
				this.nextMapIndex = nextIndex;

				if(callback) {
					callback(undefined, curIndex, nextIndex);
				}
			}
		}.bind(this)
    });

    message = null;
};

Server.prototype.removeFromMapList = function(index, callback) {
	if(!this.open) {
		console.log('Tried to remove map but not connected');
		return;
	}

	if(index == null) {
		throw new Error('assert error: index is not set');
	}

    console.log('Server.removeFromMapList (' + this.conn.sequenceNumber + ')');

	var args = ['mapList.remove', index];

    this.conn.executeRequest({
		parameters: args,
		callback: function(pack) {
			if(pack.words[0] != 'OK') {
				if(callback) {
					callback(pack);
				}
			}
			else {
				this.maps.splice(index, 1);
				
				this.getMapIndices(function() {
					if(callback) {
						callback(undefined);
					}
					this.emit('map-remove', index);
				}.bind(this));
			}
		}.bind(this)
    });

    message = null;
};

Server.prototype.getMapList = function(callback) {
	callback(this.maps);
};

Server.prototype.setNextMap = function(index, cb) {
	if(!this.open) {
		console.log('Tried to set next map but not connected');
		return;
	}

    this.conn.executeRequest({
		parameters: ['mapList.setNextMapIndex', index],
		callback: function(pack) {
			if(cb) {
				if(pack.words[0] != 'OK') {
					cb(pack);
				}
				else {
					this.nextMapIndex = +index;
					cb(undefined);
				}
			}
		}.bind(this)
    });

    message = null;
};

Server.prototype.addToMapList = function(map, mode, rounds, index, callback) {
	if(!this.open) {
		if(callback) {
			callback(false);
		}
		return;
	}

	if(!map) {
		throw new Error('assert error: map not defined');
	}

	if(!mode) {
		throw new Error('assert error: mode not defined');
	}

	if(!rounds) {
		throw new Error('assert error: rounds not defined');
	}

    console.log('Server.addToMapList: ' + map + ', ' + mode + ', ' + rounds);

	var args = ['mapList.add', map, mode, rounds];

	//if index is bigger than map length assume it is supposed to be last
	if(index != null && index < this.maps.length) {
		args.push(index.toString());
	}

    this.conn.executeRequest({
		parameters: args,
		callback: function(pack) {
			if(pack.words[0] != 'OK') {
				callback(false, pack);
			}
			else {
				var mapdata = { name: map, mode: mode, rounds: rounds };
				if(index) {
					this.maps.splice(index, 0, mapdata);
				}
				else {
					this.maps.push(mapdata);
				}
				this.getMapIndices(function() {
					callback(true);
					this.emit('map-add', { map: map, mode: mode, rounds: rounds, index: index || (this.maps.length - 1) });
				}.bind(this));
			}
		}.bind(this)
    });

    message = null;
};

Server.prototype.privateSay = function(player, message, callback) {
	if(!this.open) {
		console.log('Tried to private but not connected');
		return;
	}

    console.log('Server.privateSay (' + this.conn.sequenceNumber + '), to ' + player + ': ' + message);
    this.conn.executeRequest({
		parameters: ['admin.say', message, 'player', player],
		callback: function(p) {
			if(callback) {
				callback(p);
			}
		}
    });

    message = null;
};

Server.prototype.handleMapList = function(packet) {
	var words = packet.words;
	if(!packet.success) {
		console.log('Failed map list request:');
		console.dir(packet);
		return;
	}

	//Skip result code
	words.shift();

	this.numMaps = words.shift();

	//take num words per map, should always be three so skip.
	words.shift();

	this.maps = [];
	for(var i = 0; i < words.length; i++) {
		this.maps.push({
			name: words[i++],
			mode: words[i++],
			rounds: words[i]
		});
	}

	this.emit('maplist', this.maps);
};

Server.prototype.handleKill = function(kill) {
	if(!kill.killed) {
		return;
	}

	for(var i = 0; i < this.players.length; i++) {
		if(this.players[i].name == kill.killed) {
			//predict tickets for teams:
			this.scores[this.players[i].teamId - 1]--;
			break;
		}
	}
};

Server.prototype.handleServerInfo = function(packet) {
    var words = packet.words;
    if(!packet.success) {
		console.log('Failed server info request:');
		console.dir(packet);
		return;
    }

    this.name = words[1];
    this.playerCount = +words[2];
    this.maxPlayers = +words[3]

    this.mode = words[4];
    this.modeName = Server.MODE_NAMES[words[4]];

    this.map = words[5];
    this.mapName = Server.MAP_NAMES[words[5]];
    this.roundsPlayed = +words[6];
    this.totalRounds = +words[7];

	//+ to convert to number
	var scoreEntries = +words[8];
	this.scores = [];
	for(var idx = 9; idx < 9 + scoreEntries; idx++) {
		//sometimes scores seem to come in as floats, best guess: round it down
		this.scores.push(Math.floor(+words[idx]));
	}

	this.targetScore = +words[idx++];

	this.onlineState = words[idx++];
    this.ranked = words[idx++] == 'true';
    this.punkbuster = words[idx++] == 'true';
    this.hasPassword = words[idx++] == 'true';
    this.uptime = +words[idx++];
    this.roundtime = +words[idx++];

    this.emit('serverinfo');
};

exports.Connection = Connection;
exports.Server = Server;
