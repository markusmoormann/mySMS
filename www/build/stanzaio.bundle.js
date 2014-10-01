!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.XMPP=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
(function (process){
'use strict';

exports.lang = process.env.LANG;

exports.Stream = _dereq_('./lib/stanza/stream');
exports.BOSH = _dereq_('./lib/stanza/bosh');
exports.Message = _dereq_('./lib/stanza/message');
exports.Presence = _dereq_('./lib/stanza/presence');
exports.Iq = _dereq_('./lib/stanza/iq');

exports.PubsubEvent = _dereq_('./lib/stanza/pubsubEvents').EventItem;
exports.PubsubItem = _dereq_('./lib/stanza/pubsub').Item;

exports.JID = _dereq_('xmpp-jid').JID;

exports.Client = _dereq_('./lib/client');
exports.crypto = _dereq_('crypto');
exports.jxt = _dereq_('jxt');

exports.jingle = _dereq_('./lib/stanza/jingle');


exports.createClient = function (opts) {
    var client = new exports.Client(opts);
    client.use(_dereq_('./lib/plugins'));

    return client;
};

}).call(this,_dereq_("FWaASH"))
},{"./lib/client":2,"./lib/plugins":22,"./lib/stanza/bosh":52,"./lib/stanza/iq":69,"./lib/stanza/jingle":70,"./lib/stanza/message":74,"./lib/stanza/presence":80,"./lib/stanza/pubsub":83,"./lib/stanza/pubsubEvents":85,"./lib/stanza/stream":97,"FWaASH":166,"crypto":154,"jxt":210,"xmpp-jid":236}],2:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var WildEmitter = _dereq_('wildemitter');
var util = _dereq_('util');
var BPromise = _dereq_('bluebird');
var async = _dereq_('async');
var uuid = _dereq_('node-uuid');
var b64decode = _dereq_('atob');
var b64encode = _dereq_('btoa');
var SASL = _dereq_('./stanza/sasl');
var Message = _dereq_('./stanza/message');
var Presence = _dereq_('./stanza/presence');
var StreamError = _dereq_('./stanza/streamError');
var Iq = _dereq_('./stanza/iq');
var JID = _dereq_('xmpp-jid').JID;
var StreamManagement = _dereq_('./sm');
var WSConnection = _dereq_('./transports/websocket');
var OldWSConnection = _dereq_('./transports/old-websocket');
var BOSHConnection = _dereq_('./transports/bosh');
var getHostMeta = _dereq_('hostmeta');
var SASLFactory = _dereq_('saslmechanisms');


var SASL_MECHS = {
    external: _dereq_('sasl-external'),
    'scram-sha-1': _dereq_('sasl-scram-sha-1'),
    'digest-md5': _dereq_('alt-sasl-digest-md5'),
    plain: _dereq_('sasl-plain'),
    anonymous: _dereq_('sasl-anonymous')
};


// Ensure that all basic stanza relationships are established
_dereq_('./stanza/stream');
_dereq_('./stanza/sm');
_dereq_('./stanza/csi');
_dereq_('./stanza/error');
_dereq_('./stanza/streamFeatures');
_dereq_('./stanza/bind');
_dereq_('./stanza/session');


function Client(opts) {
    var self = this;

    WildEmitter.call(this);

    opts = opts || {};
    this._initConfig(opts);

    this.jid = new JID();

    this.transports = {
        websocket: WSConnection,
        bosh: BOSHConnection,
        'old-websocket': OldWSConnection
    };

    this.negotiatedFeatures = {};
    this.featureOrder = [
        'sasl',
        'streamManagement',
        'bind',
        'clientStateIndication',
        'streamManagement',
        'caps',
        'session'
    ];
    this.features = {};

    this.sm = new StreamManagement(this);

    this.on('stream:data', function (data) {
        var json = data.toJSON();

        if (data._name === 'iq') {
            json._xmlChildCount = 0;
            _.each(data.xml.childNodes, function (child) {
                if (child.nodeType === 1) {
                    json._xmlChildCount += 1;
                }
            });
        }

        self.emit(data._eventname || data._name, json);
        if (data._name === 'message' || data._name === 'presence' || data._name === 'iq') {
            self.sm.handle(json);
            self.emit('stanza', json);
        } else if (data._name === 'smAck') {
            return self.sm.process(json);
        } else if (data._name === 'smRequest') {
            return self.sm.ack();
        }

        if (json.id) {
            self.emit('id:' + json.id, json);
        }
    });

    this.on('streamFeatures', function (features) {
        var series = [];

        self.featureOrder.forEach(function (name) {
            if (features[name] && !self.negotiatedFeatures[name]) {
                series.push(function (cb) {
                    if (!self.negotiatedFeatures[name] && self.features[name]) {
                        self.features[name](features, cb);
                    } else {
                        cb();
                    }
                });
            }
        });

        async.series(series, function (cmd, msg) {
            if (cmd === 'restart') {
                self.transport.restart();
            } else if (cmd === 'disconnect') {
                var serr = new StreamError({
                    condition: 'policy-violation',
                    text: 'failed to negotiate stream features: ' + msg
                });
                self.emit('stream:error', serr);
                self.disconnect();
            }
        });
    });

    this.features.sasl = function (features, cb) {
        var mech = self.SASLFactory.create(features.sasl.mechanisms);
        if (!mech) {
            self.releaseGroup('sasl');
            self.emit('auth:failed');
            return cb('disconnect', 'authentication failed');
        }

        self.on('sasl:success', 'sasl', function () {
            self.negotiatedFeatures.sasl = true;
            self.releaseGroup('sasl');
            self.emit('auth:success', self.config.credentials);
            cb('restart');
        });
        self.on('sasl:challenge', 'sasl', function (challenge) {
            mech.challenge(challenge.value);
            self.send(new SASL.Response({
                value: mech.response(self.getCredentials())
            }));

            if (mech.cache) {
                _.each(mech.cache, function (val, key) {
                    if (val) {
                        self.config.credentials[key] = b64encode(val);
                    }
                });
                self.emit('credentials:update', self.config.credentials);
            }

            cb();
        });
        self.on('sasl:failure', 'sasl', function () {
            self.releaseGroup('sasl');
            self.emit('auth:failed');
            cb('disconnect', 'authentication failed');
        });
        self.on('sasl:abort', 'sasl', function () {
            self.releaseGroup('sasl');
            self.emit('auth:failed');
            cb('disconnect', 'authentication failed');
        });

        var auth = {
            mechanism: mech.name
        };

        if (mech.clientFirst) {
            auth.value = mech.response(self.getCredentials());
        }
        self.send(new SASL.Auth(auth));
    };

    this.features.bind = function (features, cb) {
        self.sendIq({
            type: 'set',
            bind: {
                resource: self.config.resource
            }
        }, function (err, resp) {
            if (err) {
                self.emit('session:error', err);
                return cb('disconnect', 'JID binding failed');
            }

            self.negotiatedFeatures.bind = true;
            self.emit('session:bound', resp.bind.jid);
            self.jid = new JID(resp.bind.jid);
            var canStartSession = !features.session || (features.session && features.session.optional);
            if (!self.sessionStarted && canStartSession) {
                self.sessionStarted = true;
                self.emit('session:started', resp.bind.jid);
            }
            cb();
        });
    };

    this.features.session = function (features, cb) {
        if (features.session.optional || self.sessionStarted) {
            self.negotiatedFeatures.session = true;
            return cb();
        }

        self.sendIq({
            type: 'set',
            session: {}
        }, function (err) {
            if (err) {
                return cb('disconnect', 'session request failed');
            }

            self.negotiatedFeatures.session = true;
            if (!self.sessionStarted) {
                self.sessionStarted = true;
                self.emit('session:started', self.jid);
            }
            cb();
        });
    };

    this.features.caps = function (features, cb) {
        self.emit('disco:caps', {from: new JID(self.jid.domain), caps: features.caps});
        self.negotiatedFeatures.caps = true;
        cb();
    };

    this.features.streamManagement = function (features, cb) {
        if (!self.config.useStreamManagement) {
            return cb();
        }

        self.on('stream:management:enabled', 'sm', function (enabled) {
            self.sm.enabled(enabled);
            self.negotiatedFeatures.streamManagement = true;
            self.releaseGroup('sm');
            cb();
        });

        self.on('stream:management:resumed', 'sm', function (resumed) {
            self.sm.resumed(resumed);
            self.negotiatedFeatures.streamManagement = true;
            self.negotiatedFeatures.bind = true;
            self.sessionStarted = true;
            self.releaseGroup('sm');
            cb('break'); // Halt further processing of stream features
        });

        self.on('stream:management:failed', 'sm', function () {
            self.sm.failed();
            self.emit('session:end');
            self.releaseGroup('session');
            self.releaseGroup('sm');
            cb();
        });

        if (!self.sm.id) {
            if (self.negotiatedFeatures.bind) {
                self.sm.enable();
            } else {
                cb();
            }
        } else if (self.sm.id && self.sm.allowResume) {
            self.sm.resume();
        } else {
            cb();
        }
    };

    this.on('disconnected', function () {
        if (self.transport) {
            self.transport.off('*');
            delete self.transport;
        }
        self.sessionStarted = false;
        self.negotiatedFeatures.sasl = false;
        self.negotiatedFeatures.streamManagement = false;
        self.negotiatedFeatures.bind = false;
        self.negotiatedFeatures.session = false;
        self.releaseGroup('connection');
    });

    this.on('iq', function (iq) {
        var iqType = iq.type;
        var xmlChildCount = iq._xmlChildCount;
        delete iq._xmlChildCount;

        var exts = Object.keys(iq);

        if (iq.type === 'get' || iq.type === 'set') {
            // Invalid request
            if (xmlChildCount !== 1) {
                return self.sendIq(iq.errorReply({
                    error: {
                        type: 'modify',
                        condition: 'bad-request'
                    }
                }));
            }

            // Valid request, but we don't have support for the
            // payload data.
            if (!exts.length) {
                return self.sendIq(iq.errorReply({
                    error: {
                        type: 'cancel',
                        condition: 'feature-not-implemented'
                    }
                }));
            }

            var iqEvent = 'iq:' + iqType + ':' + exts[0];
            if (self.callbacks[iqEvent]) {
                self.emit(iqEvent, iq);
            } else {
                // We support the payload data, but there's
                // nothing registered to handle it.
                self.sendIq(iq.errorReply({
                    error: {
                        type: 'cancel',
                        condition: 'feature-not-implemented'
                    }
                }));
            }
        }
    });

    this.on('message', function (msg) {
        if (Object.keys(msg.$body || {}).length) {
            if (msg.type === 'chat' || msg.type === 'normal') {
                self.emit('chat', msg);
            } else if (msg.type === 'groupchat') {
                self.emit('groupchat', msg);
            }
        }
        if (msg.type === 'error') {
            self.emit('message:error', msg);
        }
    });

    this.on('presence', function (pres) {
        var presType = pres.type || 'available';
        if (presType === 'error') {
            presType = 'presence:error';
        }
        self.emit(presType, pres);
    });
}

util.inherits(Client, WildEmitter);

Object.defineProperty(Client.prototype, 'stream', {
    get: function () {
        return this.transport ? this.transport.stream : undefined;
    }
});

Client.prototype._initConfig = function (opts) {
    var self = this;
    var currConfig = this.config || {};

    this.config = _.extend({
        useStreamManagement: true,
        transports: ['websocket', 'bosh'],
        sasl: ['external', 'scram-sha-1', 'digest-md5', 'plain', 'anonymous']
    }, currConfig, opts);

    // Enable SASL authentication mechanisms (and their preferred order)
    // based on user configuration.
    if (!_.isArray(this.config.sasl)) {
        this.config.sasl = [this.config.sasl];
    }

    this.SASLFactory = new SASLFactory();
    this.config.sasl.forEach(function (mech) {
        if (typeof mech === 'string') {
            var existingMech = SASL_MECHS[mech.toLowerCase()];
            if (existingMech) {
                self.SASLFactory.use(existingMech);
            }
        } else {
            self.SASLFactory.use(mech);
        }
    });

    this.config.jid = new JID(this.config.jid);

    if (!this.config.server) {
        this.config.server = this.config.jid.domain;
    }

    if (this.config.password) {
        this.config.credentials = this.config.credentials || {};
        this.config.credentials.password = this.config.password;
        delete this.config.password;
    }

    if (this.config.transport) {
        this.config.transports = [this.config.transport];
    }

    if (!_.isArray(this.config.transports)) {
        this.config.transports = [this.config.transports];
    }
};

Client.prototype.use = function (pluginInit) {
    pluginInit(this);
};

Client.prototype.nextId = function () {
    return uuid.v4();
};

Client.prototype.discoverBindings = function (server, cb) {
    getHostMeta(server, function (err, data) {
        if (err) {
            return cb(err, []);
        }

        var results = {
            websocket: [],
            bosh: []
        };
        var links = data.links || [];

        links.forEach(function (link) {
            if (link.href && link.rel === 'urn:xmpp:alt-connections:websocket') {
                results.websocket.push(link.href);
            }
            if (link.href && link.rel === 'urn:xmpp:altconnect:websocket') {
                results.websocket.push(link.href);
            }
            if (link.href && link.rel === 'urn:xmpp:alt-connections:xbosh') {
                results.bosh.push(link.href);
            }
            if (link.href && link.rel === 'urn:xmpp:altconnect:bosh') {
                results.bosh.push(link.href);
            }
        });

        cb(false, results);
    });
};

Client.prototype.getCredentials = function () {
    var creds = this.config.credentials || {};
    var requestedJID = new JID(this.config.jid);

    var username = creds.username || requestedJID.local;
    var server = creds.server || requestedJID.domain;

    var defaultCreds = {
        username: username,
        password: this.config.password,
        server: server,
        host: server,
        realm: server,
        serviceType: 'xmpp',
        serviceName: server
    };

    var result = _.extend(defaultCreds, creds);

    var cachedBinary = ['saltedPassword', 'clientKey', 'serverKey'];
    cachedBinary.forEach(function (key) {
        if (result[key]) {
            result[key] = b64decode(result[key]);
        }
    });

    return result;
};

Client.prototype.connect = function (opts, transInfo) {
    var self = this;

    this._initConfig(opts);

    if (transInfo && transInfo.name && transInfo.url) {
        var trans = self.transport = new self.transports[transInfo.name](self.sm);
        trans.on('*', function (event, data) {
            self.emit(event, data);
        });
        return trans.connect(self.config);
    }

    if (!transInfo && self.config.transports.length === 1) {
        transInfo = {};
        transInfo.name = self.config.transports[0];
        if (transInfo.name === 'websocket' || transInfo.name === 'old-websocket') {
            transInfo.url = self.config.wsURL;
        }
        if (transInfo.name === 'bosh') {
            transInfo.url = self.config.boshURL;
        }
        if (transInfo.name && transInfo.url) {
            return self.connect(null, transInfo);
        }
    }

    return self.discoverBindings(self.config.server, function (err, endpoints) {
        if (err) {
            return self.disconnect();
        }

        for (var t = 0, tlen = self.config.transports.length; t < tlen; t++) {
            var transport = self.config.transports[t];
            console.log('Checking for %s endpoints', transport);
            for (var i = 0, len = (endpoints[transport] || []).length; i < len; i++) {
                var uri = endpoints[transport][i];
                if (uri.indexOf('wss://') === 0 || uri.indexOf('https://') === 0) {
                    if (transport === 'websocket') {
                        self.config.wsURL = uri;
                    } else {
                        self.config.boshURL = uri;
                    }
                    console.log('Using %s endpoint: %s', transport, uri);
                    return self.connect(null, {
                        name: transport,
                        url: uri
                    });
                } else {
                    console.warn('Discovered unencrypted %s endpoint (%s). Ignoring', transport, uri);
                }
            }
        }
        console.warn('No endpoints found for the requested transports.');
        return self.disconnect();
    });
};

Client.prototype.disconnect = function () {
    if (this.sessionStarted) {
        this.releaseGroup('session');
        if (!this.sm.started) {
            // Only emit session:end if we had a session, and we aren't using
            // stream management to keep the session alive.
            this.emit('session:end');
        }
    }
    this.sessionStarted = false;
    this.releaseGroup('connection');
    if (this.transport) {
        this.transport.disconnect();
    } else {
        this.emit('disconnected');
    }
};

Client.prototype.send = function (data) {
    if (this.transport) {
        this.transport.send(data);
    }
    this.sm.track(data);
};

Client.prototype.sendMessage = function (data) {
    data = data || {};
    if (!data.id) {
        data.id = this.nextId();
    }
    var message = new Message(data);

    this.emit('message:sent', message.toJSON());
    this.send(message);

    return data.id;
};

Client.prototype.sendPresence = function (data) {
    data = data || {};
    if (!data.id) {
        data.id = this.nextId();
    }
    this.send(new Presence(data));

    return data.id;
};

Client.prototype.sendIq = function (data, cb) {
    var result, respEvent, allowed, dest;
    var self = this;

    data = data || {};
    if (!data.id) {
        data.id = this.nextId();
    }

    var iq = (!data.toJSON) ? new Iq(data) : data;

    if (data.type === 'error' || data.type === 'result') {
        this.send(iq);
        return;
    }

    dest = new JID(data.to);
    allowed = {};
    allowed[''] = true;
    allowed[dest.full] = true;
    allowed[dest.bare] = true;
    allowed[dest.domain] = true;
    allowed[self.jid.bare] = true;
    allowed[self.jid.domain] = true;

    respEvent = 'id:' + data.id;
    result = new BPromise(function (resolve, reject) {
        var handler = function (res) {
            if (!allowed[res.from.full]) {
                return;
            }

            self.off(respEvent, handler);
            if (!res.error) {
                resolve(res);
            } else {
                reject(res);
            }
        };
        self.on(respEvent, 'session', handler);
    });

    this.send(iq);

    return result.timeout(self.config.timeout * 1000 || 15000)
        .catch(BPromise.TimeoutError, function () {
            throw {
                id: data.id,
                type: 'error',
                error: {
                    condition: 'timeout'
                }
            };
        })
        .nodeify(cb);
};

Client.prototype.sendStreamError = function (data) {
    data = data || {};

    var error = new StreamError(data);

    this.emit('stream:error', error);
    this.send(error);
    this.disconnect();
};

Client.prototype.JID = function (jid) {
    return new JID(jid);
};


module.exports = Client;

},{"./sm":46,"./stanza/bind":48,"./stanza/csi":56,"./stanza/error":60,"./stanza/iq":69,"./stanza/message":74,"./stanza/presence":80,"./stanza/sasl":93,"./stanza/session":94,"./stanza/sm":96,"./stanza/stream":97,"./stanza/streamError":98,"./stanza/streamFeatures":99,"./transports/bosh":104,"./transports/old-websocket":105,"./transports/websocket":106,"alt-sasl-digest-md5":107,"async":108,"atob":109,"bluebird":112,"btoa":170,"hostmeta":171,"node-uuid":221,"sasl-anonymous":223,"sasl-external":225,"sasl-plain":227,"sasl-scram-sha-1":228,"saslmechanisms":233,"underscore":234,"util":169,"wildemitter":235,"xmpp-jid":236}],3:[function(_dereq_,module,exports){
'use strict';


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:attention:0');


    client.getAttention = function (jid, opts) {
        opts = opts || {};
        opts.to = jid;
        opts.type = 'headline';
        opts.attention = true;
        client.sendMessage(opts);
    };

    client.on('message', function (msg) {
        if (msg.attention) {
            client.emit('attention', msg);
        }
    });
};

},{}],4:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/avatar');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:avatar:metadata+notify');

    client.on('pubsub:event', function (msg) {
        if (!msg.event.updated) {
            return;
        }
        if (msg.event.updated.node !== 'urn:xmpp:avatar:metadata') {
            return;
        }

        client.emit('avatar', {
            jid: msg.from,
            source: 'pubsub',
            avatars: msg.event.updated.published[0].avatars
        });
    });

    client.on('presence', function (pres) {
        if (pres.avatarId) {
            client.emit('avatar', {
                jid: pres.from,
                source: 'vcard',
                avatars: [{
                    id: pres.avatarId
                }]
            });
        }
    });

    client.publishAvatar = function (id, data, cb) {
        return this.publish('', 'urn:xmpp:avatar:data', {
            id: id,
            avatarData: data
        }, cb);
    };

    client.useAvatars = function (info, cb) {
        return this.publish('', 'urn:xmpp:avatar:metadata', {
            id: 'current',
            avatars: info
        }, cb);
    };

    client.getAvatar = function (jid, id, cb) {
        return this.getItem(jid, 'urn:xmpp:avatar:data', id, cb);
    };
};

},{"../stanza/avatar":47}],5:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/blocking');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:blocking');

    client.block = function (jid, cb) {
        return client.sendIq({
            type: 'set',
            block: {
                jids: [jid]
            }
        }, cb);
    };

    client.unblock = function (jid, cb) {
        return client.sendIq({
            type: 'set',
            unblock: {
                jids: [jid]
            }
        }, cb);
    };

    client.getBlocked = function (cb) {
        return client.sendIq({
            type: 'get',
            blockList: true
        }, cb);
    };

    client.on('iq:set:block', function (iq) {
        client.emit('block', {
            jids: iq.block.jids || []
        });
        client.sendIq(iq.resultReply());
    });

    client.on('iq:set:unblock', function (iq) {
        client.emit('unblock', {
            jids: iq.unblock.jids || []
        });
        client.sendIq(iq.resultReply());
    });
};

},{"../stanza/blocking":49}],6:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/bob');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:bob');

    client.getBits = function (jid, cid, cb) {
        return client.sendIq({
            to: jid,
            type: 'get',
            bob: {
                cid: cid
            }
        }, cb);
    };
};

},{"../stanza/bob":50}],7:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/bookmarks');

var _ = _dereq_('underscore');
var JID = _dereq_('xmpp-jid').JID;


module.exports = function (client) {
    client.getBookmarks = function (cb) {
        return this.getPrivateData({bookmarks: true}, cb);
    };

    client.setBookmarks = function (opts, cb) {
        return this.setPrivateData({bookmarks: opts}, cb);
    };

    client.addBookmark = function (bookmark, cb) {
        bookmark.jid = new JID(bookmark.jid);

        return this.getBookmarks().then(function (res) {
            var bookmarks = res.privateStorage.bookmarks.conferences || [];
            var existing = _.filter(bookmarks, function (bm) {
                return bm.jid.bare === bookmark.jid.bare;
            });

            if (existing.length) {
                _.extend(existing[0], bookmark);
            } else {
                bookmarks.push(bookmark);
            }

            return client.setBookmarks({conferences: bookmarks});
        }).nodeify(cb);
    };

    client.removeBookmark = function (jid, cb) {
        jid = new JID(jid);
        return this.getBookmarks().then(function (res) {
            var bookmarks = res.privateStorage.bookmarks.conferences || [];
            bookmarks = _.filter(bookmarks, function (bm) {
                return jid.bare !== bm.jid.bare;
            });
            return client.setBookmarks({conferences: bookmarks});
        }).nodeify(cb);
    };
};

},{"../stanza/bookmarks":51,"underscore":234,"xmpp-jid":236}],8:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/carbons');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:carbons:2');

    client.enableCarbons = function (cb) {
        return this.sendIq({
            type: 'set',
            enableCarbons: true
        }, cb);
    };

    client.disableCarbons = function (cb) {
        return this.sendIq({
            type: 'set',
            disableCarbons: true
        }, cb);
    };

    client.on('message', function (msg) {
        if (msg.carbonSent) {
            return client.emit('carbon:sent', msg);
        }
        if (msg.carbonReceived) {
            return client.emit('carbon:received', msg);
        }
    });

    client.on('carbon:*', function (name, carbon) {
        var dir = name.split(':')[1];

        if (carbon.from.bare !== client.jid.bare) {
            return;
        }

        var msg, delay;
        if (dir === 'received') {
            msg = carbon.carbonReceived.forwarded.message;
            delay = carbon.carbonReceived.forwarded.delay;
        } else {
            msg = carbon.carbonSent.forwarded.message;
            delay = carbon.carbonSent.forwarded.delay;
        }

        if (!msg.delay) {
            if (delay) {
                msg.delay.stamp = delay.stamp;
            } else {
                msg.delay = {
                    stamp: new Date(Date.now())
                };
            }
        }

        msg.carbon = true;

        // Treat the carbon copied message however we would
        // have originally treated it ourself.
        if (msg.from.bare === client.jid.bare) {
            client.emit('message:sent', msg);
        } else {
            client.emit('message', msg);
        }
    });
};

},{"../stanza/carbons":54}],9:[function(_dereq_,module,exports){
'use strict';


module.exports = function (client) {
    client.disco.addFeature('http://jabber.org/protocol/chatstates');

    client.on('message', function (msg) {
        if (msg.chatState) {
            client.emit('chat:state', {
                to: msg.to,
                from: msg.from,
                chatState: msg.chatState
            });
            client.emit('chatState', {
                to: msg.to,
                from: msg.from,
                chatState: msg.chatState
            });
        }
    });
};

},{}],10:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/command');

var NS = 'http://jabber.org/protocol/commands';


module.exports = function (client) {
    client.disco.addFeature(NS);
    client.disco.addItem({
        name: 'Ad-Hoc Commands',
        node: NS
    });


    client.getCommands = function (jid, cb) {
        return client.getDiscoItems(jid, NS, cb);
    };
};

},{"../stanza/command":55}],11:[function(_dereq_,module,exports){
'use strict';


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:message-correct:0');

    client.on('message', function (msg) {
        if (msg.replace) {
            client.emit('replace', msg);
            client.emit('replace:' + msg.id, msg);
        }
    });
};

},{}],12:[function(_dereq_,module,exports){
'use strict';

var CSI = _dereq_('../stanza/csi');


module.exports = function (client) {

    client.features.clientStateIndication = function (features, cb) {
        client.negotiatedFeatures.clientStateIndication = true;
        cb();
    };

    client.markActive = function () {
        if (this.negotiatedFeatures.clientStateIndication) {
            this.send(new CSI.Active());
        }
    };

    client.markInactive = function () {
        if (this.negotiatedFeatures.clientStateIndication) {
            this.send(new CSI.Inactive());
        }
    };
};

},{"../stanza/csi":56}],13:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/dataforms');


module.exports = function (client) {
    client.disco.addFeature('jabber:x:data');
    client.disco.addFeature('urn:xmpp:media-element');
    client.disco.addFeature('http://jabber.org/protocol/xdata-validate');
    client.disco.addFeature('http://jabber.org/protocol/xdata-layout');

    client.on('message', function (msg) {
        if (msg.form) {
            client.emit('dataform', msg);
        }
    });
};

},{"../stanza/dataforms":57}],14:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/delayed');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:delay');
};

},{"../stanza/delayed":58}],15:[function(_dereq_,module,exports){
(function (Buffer){
'use strict';

var _ = _dereq_('underscore');
var hashes = _dereq_('iana-hashes');

_dereq_('../stanza/disco');
_dereq_('../stanza/caps');


function generateVerString(info, hash) {
    var S = '';
    var features = info.features.sort();
    var identities = [];
    var formTypes = {};
    var formOrder = [];

    _.forEach(info.identities, function (identity) {
        identities.push([
            identity.category || '',
            identity.type || '',
            identity.lang || '',
            identity.name || ''
        ].join('/'));
    });

    var idLen = identities.length;
    var featureLen = features.length;

    identities = _.unique(identities, true);
    features = _.unique(features, true);

    if (featureLen !== features.length || idLen !== identities.length) {
        return false;
    }


    S += identities.join('<') + '<';
    S += features.join('<') + '<';


    var illFormed = false;
    _.forEach(info.extensions, function (ext) {
        var fields = ext.fields;
        for (var i = 0, len = fields.length; i < len; i++) {
            if (fields[i].name === 'FORM_TYPE' && fields[i].type === 'hidden') {
                var name = fields[i].value;
                if (formTypes[name]) {
                    illFormed = true;
                    return;
                }
                formTypes[name] = ext;
                formOrder.push(name);
                return;
            }
        }
    });
    if (illFormed) {
        return false;
    }

    formOrder.sort();

    _.forEach(formOrder, function (name) {
        var ext = formTypes[name];
        var fields = {};
        var fieldOrder = [];

        S += '<' + name;

        _.forEach(ext.fields, function (field) {
            var fieldName = field.name;
            if (fieldName !== 'FORM_TYPE') {
                var values = field.value || '';
                if (typeof values !== 'object') {
                    values = values.split('\n');
                }
                fields[fieldName] = values.sort();
                fieldOrder.push(fieldName);
            }
        });

        fieldOrder.sort();

        _.forEach(fieldOrder, function (fieldName) {
            S += '<' + fieldName;
            _.forEach(fields[fieldName], function (val) {
                S += '<' + val;
            });
        });
    });

    var ver = hashes.createHash(hash).update(new Buffer(S, 'utf8')).digest('base64');
    var padding = 4 - ver.length % 4;
    if (padding === 4) {
        padding = 0;
    }

    for (var i = 0; i < padding; i++) {
        ver += '=';
    }
    return ver;
}

function verifyVerString(info, hash, check) {
    var computed = generateVerString(info, hash);
    return computed && computed === check;
}


function Disco() {
    this.features = {};
    this.identities = {};
    this.extensions = {};
    this.items = {};
    this.caps = {};
}

Disco.prototype = {
    constructor: {
        value: Disco
    },
    addFeature: function (feature, node) {
        node = node || '';
        if (!this.features[node]) {
            this.features[node] = [];
        }
        this.features[node].push(feature);
    },
    addIdentity: function (identity, node) {
        node = node || '';
        if (!this.identities[node]) {
            this.identities[node] = [];
        }
        this.identities[node].push(identity);
    },
    addItem: function (item, node) {
        node = node || '';
        if (!this.items[node]) {
            this.items[node] = [];
        }
        this.items[node].push(item);
    },
    addExtension: function (form, node) {
        node = node || '';
        if (!this.extensions[node]) {
            this.extensions[node] = [];
        }
        this.extensions[node].push(form);
    }
};

module.exports = function (client) {
    client.disco = new Disco(client);

    client.disco.addFeature('http://jabber.org/protocol/disco#info');
    client.disco.addIdentity({
        category: 'client',
        type: 'web'
    });

    client.getDiscoInfo = function (jid, node, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            discoInfo: {
                node: node
            }
        }, cb);
    };

    client.getDiscoItems = function (jid, node, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            discoItems: {
                node: node
            }
        }, cb);
    };

    client.updateCaps = function () {
        var node = this.config.capsNode || 'https://stanza.io';
        var data = JSON.parse(JSON.stringify({
            identities: this.disco.identities[''],
            features: this.disco.features[''],
            extensions: this.disco.extensions['']
        }));

        var ver = generateVerString(data, 'sha-1');

        this.disco.caps = {
            node: node,
            hash: 'sha-1',
            ver: ver
        };

        node = node + '#' + ver;
        this.disco.features[node] = data.features;
        this.disco.identities[node] = data.identities;
        this.disco.extensions[node] = data.extensions;

        return client.getCurrentCaps();
    };

    client.getCurrentCaps = function () {
        var caps = client.disco.caps;
        if (!caps.ver) {
            return {ver: null, discoInfo: null};
        }

        var node = caps.node + '#' + caps.ver;
        return {
            ver: caps.ver,
            discoInfo: {
                identities: client.disco.identities[node],
                features: client.disco.features[node],
                extensions: client.disco.extensions[node]
            }
        };
    };

    client.on('presence', function (pres) {
        if (pres.caps) {
            client.emit('disco:caps', pres);
        }
    });

    client.on('iq:get:discoInfo', function (iq) {
        var node = iq.discoInfo.node || '';
        var reportedNode = iq.discoInfo.node || '';

        if (node === client.disco.caps.node + '#' + client.disco.caps.ver) {
            reportedNode = node;
            node = '';
        }

        client.sendIq(iq.resultReply({
            discoInfo: {
                node: reportedNode,
                identities: client.disco.identities[node] || [],
                features: client.disco.features[node] || [],
                extensions: client.disco.extensions[node] || []
            }
        }));
    });

    client.on('iq:get:discoItems', function (iq) {
        var node = iq.discoItems.node;
        client.sendIq(iq.resultReply({
            discoItems: {
                node: node,
                items: client.disco.items[node] || []
            }
        }));
    });

    client.verifyVerString = verifyVerString;
    client.generateVerString = generateVerString;

    // Ensure we always have some caps data
    client.updateCaps();
};

}).call(this,_dereq_("buffer").Buffer)
},{"../stanza/caps":53,"../stanza/disco":59,"buffer":147,"iana-hashes":174,"underscore":234}],16:[function(_dereq_,module,exports){
'use strict';

module.exports = function (client) {
    client.disco.addFeature('jid\\20escaping');
};

},{}],17:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/extdisco');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:extdisco:1');

    client.getServices = function (jid, type, cb) {
        return this.sendIq({
            type: 'get',
            to: jid,
            services: {
                type: type
            }
        }, cb);
    };

    client.getServiceCredentials = function (jid, host, cb) {
        return this.sendIq({
            type: 'get',
            to: jid,
            credentials: {
                service: {
                    host: host
                }
            }
        }, cb);
    };
};

},{"../stanza/extdisco":61}],18:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/forwarded');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:forward:0');
};

},{"../stanza/forwarded":63}],19:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/geoloc');


module.exports = function (client) {
    client.disco.addFeature('http://jabber.org/protocol/geoloc');
    client.disco.addFeature('http://jabber.org/protocol/geoloc+notify');

    client.on('pubsub:event', function (msg) {
        if (!msg.event.updated) {
            return;
        }
        if (msg.event.updated.node !== 'http://jabber.org/protocol/geoloc') {
            return;
        }

        client.emit('geoloc', {
            jid: msg.from,
            geoloc: msg.event.updated.published[0].geoloc
        });
    });

    client.publishGeoLoc = function (data, cb) {
        return this.publish('', 'http://jabber.org/protocol/geoloc', {
            geoloc: data
        }, cb);
    };
};

},{"../stanza/geoloc":65}],20:[function(_dereq_,module,exports){
'use strict';

var hashes = _dereq_('iana-hashes');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:hashes:1');

    var names = hashes.getHashes();
    names.forEach(function (name) {
        client.disco.addFeature('urn:xmpp:hash-function-text-names:' + name);
    });
};

},{"iana-hashes":174}],21:[function(_dereq_,module,exports){
'use strict';

module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:idle:1');
};

},{}],22:[function(_dereq_,module,exports){
'use strict';

module.exports = function (client) {
    // We always need this one first
    client.use(_dereq_('./disco'));

    client.use(_dereq_('./attention'));
    client.use(_dereq_('./avatar'));
    client.use(_dereq_('./blocking'));
    client.use(_dereq_('./bob'));
    client.use(_dereq_('./bookmarks'));
    client.use(_dereq_('./carbons'));
    client.use(_dereq_('./chatstates'));
    client.use(_dereq_('./command'));
    client.use(_dereq_('./correction'));
    client.use(_dereq_('./csi'));
    client.use(_dereq_('./dataforms'));
    client.use(_dereq_('./delayed'));
    client.use(_dereq_('./escaping'));
    client.use(_dereq_('./extdisco'));
    client.use(_dereq_('./forwarding'));
    client.use(_dereq_('./geoloc'));
    client.use(_dereq_('./hashes'));
    client.use(_dereq_('./idle'));
    client.use(_dereq_('./invisible'));
    client.use(_dereq_('./jingle'));
    client.use(_dereq_('./json'));
    client.use(_dereq_('./keepalive'));
    client.use(_dereq_('./logging'));
    client.use(_dereq_('./mam'));
    client.use(_dereq_('./muc'));
    client.use(_dereq_('./mood'));
    client.use(_dereq_('./nick'));
    client.use(_dereq_('./oob'));
    client.use(_dereq_('./ping'));
    client.use(_dereq_('./private'));
    client.use(_dereq_('./psa'));
    client.use(_dereq_('./pubsub'));
    client.use(_dereq_('./reach'));
    client.use(_dereq_('./receipts'));
    client.use(_dereq_('./register'));
    client.use(_dereq_('./roster'));
    client.use(_dereq_('./rtt'));
    client.use(_dereq_('./shim'));
    client.use(_dereq_('./time'));
    client.use(_dereq_('./vcard'));
    client.use(_dereq_('./version'));
};

},{"./attention":3,"./avatar":4,"./blocking":5,"./bob":6,"./bookmarks":7,"./carbons":8,"./chatstates":9,"./command":10,"./correction":11,"./csi":12,"./dataforms":13,"./delayed":14,"./disco":15,"./escaping":16,"./extdisco":17,"./forwarding":18,"./geoloc":19,"./hashes":20,"./idle":21,"./invisible":23,"./jingle":24,"./json":25,"./keepalive":26,"./logging":27,"./mam":28,"./mood":29,"./muc":30,"./nick":31,"./oob":32,"./ping":33,"./private":34,"./psa":35,"./pubsub":36,"./reach":37,"./receipts":38,"./register":39,"./roster":40,"./rtt":41,"./shim":42,"./time":43,"./vcard":44,"./version":45}],23:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/visibility');


module.exports = function (client) {
    client.goInvisible = function (cb) {
        return this.sendIq({
            type: 'set',
            invisible: true
        }, cb);
    };

    client.goVisible = function (cb) {
        return this.sendIq({
            type: 'set',
            visible: true
        }, cb);
    };
};

},{"../stanza/visibility":103}],24:[function(_dereq_,module,exports){
'use strict';

var Jingle = _dereq_('jingle');

_dereq_('../stanza/jingle');
_dereq_('../stanza/rtp');
_dereq_('../stanza/iceUdp');
_dereq_('../stanza/file');


module.exports = function (client) {
    var jingle = client.jingle = new Jingle();

    jingle.capabilities.forEach(function (cap) {
        client.disco.addFeature(cap);
    });

    var mappedEvents = [
        'outgoing', 'incoming', 'accepted', 'terminated',
        'ringing', 'mute', 'unmute', 'hold', 'resumed'
    ];
    mappedEvents.forEach(function (event) {
        jingle.on(event, function (session, arg1) {
            client.emit('jingle:' + event, session, arg1);
        });
    });

    jingle.on('peerStreamAdded', function (session, stream) {
        client.emit('jingle:remotestream:added', session, stream);
    });

    jingle.on('peerStreamRemoved', function (session, stream) {
        client.emit('jingle:remotestream:removed', session, stream);
    });

    jingle.on('send', function (data) {
        client.sendIq(data, function (err) {
            if (err) {
                client.emit('jingle:error', err);
            }
        });
    });

    client.on('iq:set:jingle', function (data) {
        jingle.process(data);
    });

    client.on('unavailable', function (pres) {
        var peer = pres.from.full;
        jingle.endPeerSessions(peer, true);
    });

    /*
     * gone for now, might come back in the future
    client.call = function (peer) {
        peer = peer.full || peer;
        var sess = jingle.createMediaSession(peer);
        client.sendPresence({to: peer});
        sess.start();
        return sess;
    };
    */

    client.discoverICEServers = function (cb) {
        return this.getServices(client.config.server).then(function (res) {
            var services = res.services.services;
            var discovered = [];

            for (var i = 0; i < services.length; i++) {
                var service = services[i];
                var ice = {};
                if (service.type === 'stun' || service.type === 'stuns') {
                    ice.url = service.type + ':' + service.host;
                    if (service.port) {
                        ice.url += ':' + service.port;
                    }
                    discovered.push(ice);
                    client.jingle.addICEServer(ice);
                } else if (service.type === 'turn' || service.type === 'turns') {
                    ice.url = service.type + ':' + service.host;
                    if (service.port) {
                        ice.url += ':' + service.port;
                    }
                    if (service.transport && service.transport !== 'udp') {
                        ice.url += '?transport=' + service.transport;
                    }

                    if (service.username) {
                        ice.username = service.username;
                    }
                    if (service.password) {
                        ice.credential = service.password;
                    }
                    discovered.push(ice);
                    client.jingle.addICEServer(ice);
                }
            }

            return discovered;
        }).nodeify(cb);
    };
};

},{"../stanza/file":62,"../stanza/iceUdp":68,"../stanza/jingle":70,"../stanza/rtp":91,"jingle":190}],25:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/json');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:json:0');
};

},{"../stanza/json":71}],26:[function(_dereq_,module,exports){
'use strict';

var BPromise = _dereq_('bluebird');


function checkConnection(client, timeout) {
    return new BPromise(function (resolve, reject) {
        if (client.sm.started) {
            client.once('stream:management:ack', resolve);
            client.sm.request();
        } else {
            client.ping().then(resolve).catch(function (err) {
                if (err.error && err.error.condition !== 'timeout') {
                    resolve();
                } else {
                    reject();
                }
            });
        }
    }).timeout(timeout * 1000 || 15000);
}


module.exports = function (client) {
    client.enableKeepAlive = function (opts) {
        opts = opts || {};

        // Ping every 5 minutes
        opts.interval = opts.interval || 300;

        // Disconnect if no response in 15 seconds
        opts.timeout = opts.timeout || 15;

        function keepalive() {
            if (client.sessionStarted) {
                checkConnection(client, opts.timeout).catch(function () {
                    client.sendStreamError({
                        condition: 'connection-timeout'
                    });
                });
            }
        }

        client._keepAliveInterval = setInterval(keepalive, opts.interval * 1000);
    };

    client.disableKeepAlive = function () {
        if (client._keepAliveInterval) {
            clearInterval(client._keepAliveInterval);
            delete client._keepAliveInterval;
        }
    };

    client.on('disconnected', function () {
        client.disableKeepAlive();
    });
};

},{"bluebird":112}],27:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/logging');


module.exports = function (client) {
    client.disco.addFeature('', 'urn:xmpp:eventlog');

    client.sendLog = function (jid, logData) {
        client.sendMessage({
            to: jid,
            type: 'normal',
            log: logData
        });
    };
};

},{"../stanza/logging":72}],28:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/mam');

var JID = _dereq_('xmpp-jid').JID;


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:mam:tmp');

    client.getHistory = function (opts, cb) {
        var self = this;
        var queryid = this.nextId();

        opts = opts || {};
        opts.queryid = queryid;

        var to = opts.to || '';
        delete opts.to;

        var dest = new JID(to || client.jid.bare);
        var allowed = {};
        allowed[''] = true;
        allowed[dest.full] = true;
        allowed[dest.bare] = true;
        allowed[dest.domain] = true;
        allowed[client.jid.bare] = true;
        allowed[client.jid.domain] = true;

        var mamResults = [];
        this.on('mam:' + queryid, 'session', function (msg) {
            if (!allowed[msg.from.full]) {
                return;
            }
            mamResults.push(msg);
        });

        return this.sendIq({
            type: 'get',
            to: to,
            id: queryid,
            mamQuery: opts
        }).then(function (resp) {
            resp.mamQuery.results = mamResults;
            return resp;
        }).finally(function () {
            self.off('mam:' + queryid);
        }).nodeify(cb);
    };

    client.getHistoryPreferences = function (cb) {
        return this.sendIq({
            type: 'get',
            mamPrefs: true
        }, cb);
    };

    client.setHistoryPreferences = function (opts, cb) {
        return this.sendIq({
            type: 'set',
            mamPrefs: opts
        }, cb);
    };

    client.on('message', function (msg) {
        if (msg.mam) {
            client.emit('mam:' + msg.mam.queryid, msg);
        }
    });
};

},{"../stanza/mam":73,"xmpp-jid":236}],29:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/mood');

var NS = 'http://jabber.org/protocol/mood';

module.exports = function (client) {
    client.disco.addFeature(NS);
    client.disco.addFeature(NS + '+notify');

    client.on('pubsub:event', function (msg) {
        if (!msg.event.updated) {
            return;
        }

        if (msg.event.updated.node !== NS) {
            return;
        }

        client.emit('mood', {
            jid: msg.from,
            mood: msg.event.updated.published[0].mood
        });
    });

    client.publishMood = function (mood, text, cb) {
        return this.publish('', NS, {
            mood: {
                value: mood,
                text: text
            }
        }, cb);
    };
};

},{"../stanza/mood":75}],30:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/muc');
_dereq_('../stanza/hats');

var _ = _dereq_('underscore');
var JID = _dereq_('xmpp-jid').JID;


module.exports = function (client) {
    client.disco.addFeature('http://jabber.org/protocol/muc');
    client.disco.addFeature('jabber:x:conference');
    client.disco.addFeature('urn:xmpp:hats:0');

    client.joinedRooms = {};

    function rejoinRooms() {
        _.each(client.joinedRooms, function (nick, room) {
            client.joinedRooms[room] = false;
            client.joinRoom(room, nick);
        });
    }
    client.on('session:started', rejoinRooms);
    client.on('stream:management:resumed', rejoinRooms);

    client.on('message', function (msg) {
        if (msg.muc) {
            if (msg.muc.invite) {
                client.emit('muc:invite', {
                    from: msg.muc.invite.from,
                    room: msg.from,
                    reason: msg.muc.invite.reason,
                    password: msg.muc.password,
                    thread: msg.muc.invite.thread,
                    type: 'mediated'
                });
            }
            if (msg.muc.destroyed) {
                client.emit('muc:destroyed', {
                    room: msg.from,
                    newRoom: msg.muc.destroyed.jid,
                    reason: msg.muc.destroyed.reason,
                    password: msg.muc.password
                });
            }
            if (msg.muc.decline) {
                client.emit('muc:declined', {
                    room: msg.from,
                    from: msg.muc.decline.from,
                    reason: msg.muc.decline.reason
                });
            }
        } else if (msg.mucInvite) {
            client.emit('muc:invite', {
                from: msg.from,
                room: msg.mucInvite.jid,
                reason: msg.mucInvite.reason,
                password: msg.mucInvite.password,
                thread: msg.mucInvite.thread,
                type: 'direct'
            });
        }

        if (msg.type === 'groupchat' && msg.subject) {
            client.emit('muc:subject', msg);
        }
    });

    client.on('presence', function (pres) {
        if (pres.joinMuc && pres.type === 'error') {
            client.emit('muc:error', pres);
        } else if (pres.muc) {
            var isSelf = pres.muc.codes && pres.muc.codes.indexOf('110') >= 0;
            if (pres.type === 'error') {
                client.emit('muc:error', pres);
            } else if (pres.type === 'unavailable') {
                client.emit('muc:unavailable', pres);
                if (isSelf) {
                    client.emit('muc:leave', pres);
                    delete client.joinedRooms[pres.from.bare];
                }
            } else {
                client.emit('muc:available', pres);
                if (isSelf && !client.joinedRooms[pres.from.bare]) {
                    client.emit('muc:join', pres);
                    client.joinedRooms[pres.from.bare] = pres.from.resource;
                }
            }
        }
    });

    client.joinRoom = function (room, nick, opts) {
        opts = opts || {};
        opts.to = room + '/' + nick;
        opts.caps = this.disco.caps;
        opts.joinMuc = opts.joinMuc || {};

        this.sendPresence(opts);
    };

    client.leaveRoom = function (room, nick, opts) {
        opts = opts || {};
        opts.to = room + '/' + nick;
        opts.type = 'unavailable';
        this.sendPresence(opts);
    };

    client.ban = function (room, jid, reason, cb) {
        client.setRoomAffiliation(room, jid, 'outcast', reason, cb);
    };

    client.kick = function (room, nick, reason, cb) {
        client.setRoomRole(room, nick, 'none', reason, cb);
    };

    client.invite = function (room, opts) {
        client.sendMessage({
            to: room,
            muc: {
                invites: opts
            }
        });
    };

    client.directInvite = function (room, opts) {
        opts.jid = room;
        client.sendMessage({
            to: opts.to,
            mucInvite: opts
        });
    };

    client.declineInvite = function (room, sender, reason) {
        client.sendMessage({
            to: room,
            muc: {
                decline: {
                    to: sender,
                    reason: reason
                }
            }
        });
    };

    client.changeNick = function (room, nick) {
        client.sendPresence({
            to: (new JID(room)).bare + '/' + nick
        });
    };

    client.setSubject = function (room, subject) {
        client.sendMessage({
            to: room,
            type: 'groupchat',
            subject: subject
        });
    };

    client.discoverReservedNick = function (room, cb) {
        client.getDiscoInfo(room, 'x-roomuser-item', function (err, res) {
            if (err) {
                return cb(err);
            }
            var ident = res.discoInfo.identities[0] || {};
            cb(null, ident.name);
        });
    };

    client.requestRoomVoice = function (room) {
        client.sendMessage({
            to: room,
            form: {
                fields: [
                    {
                        name: 'FORM_TYPE',
                        value: 'http://jabber.org/protocol/muc#request'
                    },
                    {
                        name: 'muc#role',
                        type: 'text-single',
                        value: 'participant'
                    }
                ]
            }
        });
    };

    client.setRoomAffiliation = function (room, jid, affiliation, reason, cb) {
        return this.sendIq({
            type: 'set',
            to: room,
            mucAdmin: {
                jid: jid,
                affiliation: affiliation,
                reason: reason
            }
        }, cb);
    };

    client.setRoomRole = function (room, nick, role, reason, cb) {
        return this.sendIq({
            type: 'set',
            to: room,
            mucAdmin: {
                nick: nick,
                role: role,
                reason: reason
            }
        }, cb);
    };

    client.getRoomMembers = function (room, opts, cb) {
        return this.sendIq({
            type: 'get',
            to: room,
            mucAdmin: opts
        }, cb);
    };

    client.getRoomConfig = function (jid, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            mucOwner: true
        }, cb);
    };

    client.configureRoom = function (jid, form, cb) {
        if (!form.type) {
            form.type = 'submit';
        }
        return this.sendIq({
            to: jid,
            type: 'set',
            mucOwner: {
                form: form
            }
        }, cb);
    };

    client.getUniqueRoomName = function (jid, cb) {
        return this.sendIq({
            type: 'get',
            to: jid,
            mucUnique: true
        }, cb);
    };
};

},{"../stanza/hats":67,"../stanza/muc":76,"underscore":234,"xmpp-jid":236}],31:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/nick');

var NS = 'http://jabber.org/protocol/nick';


module.exports = function (client) {
    client.disco.addFeature(NS);
    client.disco.addFeature(NS + '+notify');

    client.on('pubsub:event', function (msg) {
        if (!msg.event.updated) {
            return;
        }
        if (msg.event.updated.node !== NS) {
            return;
        }

        client.emit('nick', {
            jid: msg.from,
            nick: msg.event.updated.published[0].nick
        });
    });

    client.publishNick = function (nick, cb) {
        return this.publish('', NS, {
            nick: nick
        }, cb);
    };
};

},{"../stanza/nick":77}],32:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/oob');


module.exports = function (client) {
    client.disco.addFeature('jabber:x:oob');
};

},{"../stanza/oob":78}],33:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/ping');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:ping');

    client.on('iq:get:ping', function (iq) {
        client.sendIq(iq.resultReply());
    });

    client.ping = function (jid, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            ping: true
        }, cb);
    };
};

},{"../stanza/ping":79}],34:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/private');


module.exports = function (client) {

    client.getPrivateData = function (opts, cb) {
        return this.sendIq({
            type: 'get',
            privateStorage: opts
        }, cb);
    };

    client.setPrivateData = function (opts, cb) {
        return this.sendIq({
            type: 'set',
            privateStorage: opts
        }, cb);
    };

};

},{"../stanza/private":81}],35:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/psa');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:psa');
};

},{"../stanza/psa":82}],36:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/pubsub');
_dereq_('../stanza/pubsubOwner');
_dereq_('../stanza/pubsubEvents');
_dereq_('../stanza/pubsubError');


module.exports = function (client) {

    client.on('message', function (msg) {
        if (msg.event) {
            client.emit('pubsub:event', msg);
            client.emit('pubsubEvent', msg);
        }
    });

    client.subscribeToNode = function (jid, opts, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsub: {
                subscribe: {
                    node: opts.node,
                    jid: opts.jid || client.jid
                }
            }
        }, cb);
    };

    client.unsubscribeFromNode = function (jid, opts, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsub: {
                unsubscribe: {
                    node: opts.node,
                    jid: opts.jid || client.jid.split('/')[0]
                }
            }
        }, cb);
    };

    client.publish = function (jid, node, item, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsub: {
                publish: {
                    node: node,
                    item: item
                }
            }
        }, cb);
    };

    client.getItem = function (jid, node, id, cb) {
        return this.sendIq({
            type: 'get',
            to: jid,
            pubsub: {
                retrieve: {
                    node: node,
                    item: id
                }
            }
        }, cb);
    };

    client.getItems = function (jid, node, opts, cb) {
        opts = opts || {};
        opts.node = node;
        return this.sendIq({
            type: 'get',
            to: jid,
            pubsub: {
                retrieve: {
                    node: node,
                    max: opts.max
                },
                rsm: opts.rsm
            }
        }, cb);
    };

    client.retract = function (jid, node, id, notify, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsub: {
                retract: {
                    node: node,
                    notify: notify,
                    id: id
                }
            }
        }, cb);
    };

    client.purgeNode = function (jid, node, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsubOwner: {
                purge: node
            }
        }, cb);
    };

    client.deleteNode = function (jid, node, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsubOwner: {
                del: node
            }
        }, cb);
    };

    client.createNode = function (jid, node, config, cb) {
        var cmd = {
            type: 'set',
            to: jid,
            pubsubOwner: {
                create: node
            }
        };

        if (config) {
            cmd.pubsubOwner.config = {form: config};
        }

        return this.sendIq(cmd, cb);
    };
};

},{"../stanza/pubsub":83,"../stanza/pubsubError":84,"../stanza/pubsubEvents":85,"../stanza/pubsubOwner":86}],37:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/reach');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:reach:0');
    client.disco.addFeature('urn:xmpp:reach:0+notify');

    client.on('pubsub:event', function (msg) {
        if (!msg.event.updated) {
            return;
        }
        if (msg.event.updated.node !== 'urn:xmpp:reach:0') {
            return;
        }

        client.emit('reachability', {
            jid: msg.from,
            addresses: msg.event.updated.published[0].reach
        });
    });

    client.on('presence', function (pres) {
        if (!pres.reach || !pres.reach.length) {
            return;
        }

        client.emit('reachability', {
            jid: pres.from,
            addresses: pres.reach
        });
    });

    client.publishReachability = function (data, cb) {
        return this.publish('', 'urn:xmpp:reach:0', {
            reach: data
        }, cb);
    };
};

},{"../stanza/reach":87}],38:[function(_dereq_,module,exports){
'use strict';

module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:receipts');

    client.on('message', function (msg) {
        var ackTypes = {
            normal: true,
            chat: true,
            headline: true
        };
        if (ackTypes[msg.type] && msg.requestReceipt && !msg.receipt) {
            client.sendMessage({
                to: msg.from,
                receipt: msg.id,
                id: msg.id
            });
        }
        if (msg.receipt) {
            client.emit('receipt', msg);
            client.emit('receipt:' + msg.receipt);
        }
    });
};

},{}],39:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/register');


module.exports = function (client) {
    client.getAccountInfo = function (jid, cb) {
        return this.sendIq({
            type: 'get',
            to: jid,
            register: true
        }, cb);
    };

    client.updateAccount = function (jid, data, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            register: data
        }, cb);
    };

    client.deleteAccount = function (jid, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            register: {
                remove: true
            }
        }, cb);
    };
};

},{"../stanza/register":88}],40:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/roster');


module.exports = function (client) {

    client.on('iq:set:roster', function (iq) {
        var allowed = {};
        allowed[''] = true;
        allowed[client.jid.bare] = true;
        allowed[client.jid.domain] = true;

        if (!allowed[iq.from.full]) {
            return client.sendIq(iq.errorReply({
                error: {
                    type: 'cancel',
                    condition: 'service-unavailable'
                }
            }));
        }

        client.emit('roster:update', iq);
        client.sendIq({
            id: iq.id,
            type: 'result'
        });
    });

    client.getRoster = function (cb) {
        var self = this;
        cb = cb || function () {};

        return client.sendIq({
            type: 'get',
            roster: {
                ver: self.config.rosterVer
            }
        }).then(function (resp) {
            if (resp.roster) {
                var ver = resp.roster.ver;
                if (ver) {
                    self.config.rosterVer = ver;
                    self.emit('roster:ver', ver);
                }
            }
            return resp;
        }).nodeify(cb);
    };

    client.updateRosterItem = function (item, cb) {
        return client.sendIq({
            type: 'set',
            roster: {
                items: [item]
            }
        }, cb);
    };

    client.removeRosterItem = function (jid, cb) {
        return client.updateRosterItem({jid: jid, subscription: 'remove'}, cb);
    };

    client.subscribe = function (jid) {
        client.sendPresence({type: 'subscribe', to: jid});
    };

    client.unsubscribe = function (jid) {
        client.sendPresence({type: 'unsubscribe', to: jid});
    };

    client.acceptSubscription = function (jid) {
        client.sendPresence({type: 'subscribed', to: jid});
    };

    client.denySubscription = function (jid) {
        client.sendPresence({type: 'unsubscribed', to: jid});
    };
};

},{"../stanza/roster":89}],41:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/rtt');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:rtt:0');

    client.on('message', function (msg) {
        if (msg.rtt) {
            client.emit('rtt', msg);
            client.emit('rtt:' + msg.rtt.event, msg);
        }
    });
};

},{"../stanza/rtt":92}],42:[function(_dereq_,module,exports){
_dereq_('../stanza/shim');

var NS = 'http://jabber.org/protocol/shim';


module.exports = function (client) {
    client.disco.addFeature(NS);
    client.disco.addFeature(NS + '#SubID', NS);
};

},{"../stanza/shim":95}],43:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/time');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:time');

    client.getTime = function (jid, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            time: true
        }, cb);
    };

    client.on('iq:get:time', function (iq) {
        var time = new Date();
        client.sendIq(iq.resultReply({
            time: {
                utc: time,
                tzo: time.getTimezoneOffset()
            }
        }));
    });
};

},{"../stanza/time":100}],44:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/vcard');


module.exports = function (client) {
    client.disco.addFeature('vcard-temp');

    client.getVCard = function (jid, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            vCardTemp: true
        }, cb);
    };

    client.publishVCard = function (vcard, cb) {
        return this.sendIq({
            type: 'set',
            vCardTemp: vcard
        }, cb);
    };
};

},{"../stanza/vcard":101}],45:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/version');


module.exports = function (client) {
    client.disco.addFeature('jabber:iq:version');

    client.on('iq:get:version', function (iq) {
        client.sendIq(iq.resultReply({
            version: client.config.softwareVersion || {
                name: 'stanza.io'
            }
        }));
    });

    client.getSoftwareVersion = function (jid, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            version: true
        }, cb);
    };
};

},{"../stanza/version":102}],46:[function(_dereq_,module,exports){
'use strict';

var SM = _dereq_('./stanza/sm');
var MAX_SEQ = Math.pow(2, 32);


function mod(v, n) {
    return ((v % n) + n) % n;
}


function StreamManagement(client) {
    this.client = client;
    this.id = false;
    this.allowResume = true;
    this.started = false;
    this.lastAck = 0;
    this.handled = 0;
    this.windowSize = 1;
    this.unacked = [];
    this.pendingAck = false;
}

StreamManagement.prototype = {
    constructor: {
        value: StreamManagement
    },
    enable: function () {
        var enable = new SM.Enable();
        enable.resume = this.allowResume;
        this.client.send(enable);
        this.handled = 0;
        this.started = true;
    },
    resume: function () {
        var resume = new SM.Resume({
            h: this.handled,
            previd: this.id
        });
        this.client.send(resume);
        this.started = true;
    },
    enabled: function (resp) {
        this.id = resp.id;
    },
    resumed: function (resp) {
        this.id = resp.previd;
        if (resp.h) {
            this.process(resp, true);
        }
    },
    failed: function () {
        this.started = false;
        this.id = false;
        this.lastAck = 0;
        this.handled = 0;
        this.unacked = [];
    },
    ack: function () {
        this.client.send(new SM.Ack({
            h: this.handled
        }));
    },
    request: function () {
        this.pendingAck = true;
        this.client.send(new SM.Request());
    },
    process: function (ack, resend) {
        var self = this;
        var numAcked = mod(ack.h - this.lastAck, MAX_SEQ);

        this.pendingAck = false;

        for (var i = 0; i < numAcked && this.unacked.length > 0; i++) {
            this.client.emit('stanza:acked', this.unacked.shift());
        }
        this.lastAck = ack.h;

        if (resend) {
            var resendUnacked = this.unacked;
            this.unacked = [];
            resendUnacked.forEach(function (stanza) {
                self.client.send(stanza);
            });
        }

        if (this.needAck()) {
            this.request();
        }
    },
    track: function (stanza) {
        var name = stanza._name;
        var acceptable = {
            message: true,
            presence: true,
            iq: true
        };

        if (this.started && acceptable[name]) {
            this.unacked.push(stanza);
            if (this.needAck()) {
                this.request();
            }
        }
    },
    handle: function () {
        if (this.started) {
            this.handled = mod(this.handled + 1, MAX_SEQ);
        }
    },
    needAck: function () {
        return !this.pendingAck && this.unacked.length >= this.windowSize;
    }
};

module.exports = StreamManagement;

},{"./stanza/sm":96}],47:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var stanza = _dereq_('jxt');
var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;

var Avatar = module.exports = stanza.define({
    name: 'avatar',
    namespace: 'urn:xmpp:avatar:metadata',
    element: 'info',
    fields: {
        id: stanza.attribute('id'),
        bytes: stanza.attribute('bytes'),
        height: stanza.attribute('height'),
        width: stanza.attribute('width'),
        type: stanza.attribute('type', 'image/png'),
        url: stanza.attribute('url')
    }
});


var avatars = {
    get: function () {
        var metadata = stanza.find(this.xml, 'urn:xmpp:avatar:metadata', 'metadata');
        var results = [];
        if (metadata.length) {
            var avatars = stanza.find(metadata[0], 'urn:xmpp:avatar:metadata', 'info');
            _.forEach(avatars, function (info) {
                results.push(new Avatar({}, info));
            });
        }
        return results;
    },
    set: function (value) {
        var metadata = stanza.findOrCreate(this.xml, 'urn:xmpp:avatar:metadata', 'metadata');
        stanza.setAttribute(metadata, 'xmlns', 'urn:xmpp:avatar:metadata');
        _.forEach(value, function (info) {
            var avatar = new Avatar(info);
            metadata.appendChild(avatar.xml);
        });
    }
};

stanza.add(Item, 'avatars', avatars);
stanza.add(EventItem, 'avatars', avatars);
stanza.add(Item, 'avatarData', stanza.subText('urn:xmpp:avatar:data', 'data'));
stanza.add(EventItem, 'avatarData', stanza.subText('urn:xmpp:avatar:data', 'data'));

},{"./pubsub":83,"./pubsubEvents":85,"jxt":210,"underscore":234}],48:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var StreamFeatures = _dereq_('./streamFeatures');
var jxtutil = _dereq_('jxt-xmpp-types');

var NS = 'urn:ietf:params:xml:ns:xmpp-bind';

var Bind = module.exports = stanza.define({
    name: 'bind',
    namespace: NS,
    element: 'bind',
    fields: {
        resource: stanza.subText(NS, 'resource'),
        jid: jxtutil.jidSub(NS, 'jid')
    }
});

stanza.extend(Iq, Bind);
stanza.extend(StreamFeatures, Bind);

},{"./iq":69,"./streamFeatures":99,"jxt":210,"jxt-xmpp-types":209}],49:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var JID = _dereq_('xmpp-jid').JID;

var NS = 'urn:xmpp:blocking';


var jids = {
    get: function () {
        var result = [];
        var items = stanza.find(this.xml, NS, 'item');
        if (!items.length) {
            return result;
        }

        items.forEach(function (item) {
            result.push(new JID(stanza.getAttribute(item, 'jid', '')));
        });

        return result;
    },
    set: function (values) {
        var self = this;
        values.forEach(function (value) {
            var item = stanza.createElement(NS, 'item', NS);
            stanza.setAttribute(item, 'jid', value.toString());
            self.xml.appendChild(item);
        });
    }
};

exports.Block = stanza.define({
    name: 'block',
    namespace: NS,
    element: 'block',
    fields: {
        jids: jids
    }
});

exports.Unblock = stanza.define({
    name: 'unblock',
    namespace: NS,
    element: 'unblock',
    fields: {
        jids: jids
    }
});

exports.BlockList = stanza.define({
    name: 'blockList',
    namespace: NS,
    element: 'blocklist',
    fields: {
        jids: jids
    }
});


stanza.extend(Iq, exports.Block);
stanza.extend(Iq, exports.Unblock);
stanza.extend(Iq, exports.BlockList);

},{"./iq":69,"jxt":210,"xmpp-jid":236}],50:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');

var Iq = _dereq_('./iq');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');

var NS = 'urn:xmpp:bob';


var BOB = module.exports = stanza.define({
    name: 'bob',
    namespace: NS,
    element: 'data',
    fields: {
        cid: stanza.attribute('cid'),
        maxAge: stanza.numberAttribute('max-age'),
        type: stanza.attribute('type'),
        data: stanza.text()
    }
});


stanza.extend(Iq, BOB);
stanza.extend(Message, BOB);
stanza.extend(Presence, BOB);

},{"./iq":69,"./message":74,"./presence":80,"jxt":210}],51:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');
var PrivateStorage = _dereq_('./private');


var Conference = stanza.define({
    name: '_conference',
    namespace: 'storage:bookmarks',
    element: 'conference',
    fields: {
        name: stanza.attribute('name'),
        autoJoin: stanza.boolAttribute('autojoin'),
        jid: jxtutil.jidAttribute('jid'),
        nick: stanza.subText('storage:bookmarks', 'nick')
    }
});

var Bookmarks = module.exports = stanza.define({
    name: 'bookmarks',
    namespace: 'storage:bookmarks',
    element: 'storage'
});


stanza.extend(PrivateStorage, Bookmarks);
stanza.extend(Bookmarks, Conference, 'conferences');

},{"./private":81,"jxt":210,"jxt-xmpp-types":209}],52:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');

var NS = 'http://jabber.org/protocol/httpbind';
var XMPP_NS = 'urn:xmpp:xbosh';


module.exports = stanza.define({
    name: 'bosh',
    namespace: NS,
    element: 'body',
    prefixes: {
        xmpp: XMPP_NS
    },
    fields: {
        accept: stanza.attribute('accept'),
        ack: stanza.numberAttribute('ack'),
        authid: stanza.attribute('authid'),
        charsets: stanza.attribute('charsets'),
        condition: stanza.attribute('condition'),
        content: stanza.attribute('content'),
        from: jxtutil.jidAttribute('from', true),
        hold: stanza.numberAttribute('hold'),
        inactivity: stanza.numberAttribute('inactivity'),
        key: stanza.attribute('key'),
        maxpause: stanza.numberAttribute('maxpause'),
        newKey: stanza.attribute('newkey'),
        pause: stanza.numberAttribute('pause'),
        polling: stanza.numberAttribute('polling'),
        resport: stanza.numberAttribute('report'),
        requests: stanza.numberAttribute('requests'),
        rid: stanza.numberAttribute('rid'),
        sid: stanza.attribute('sid'),
        stream: stanza.attribute('stream'),
        time: stanza.attribute('time'),
        to: jxtutil.jidAttribute('to', true),
        type: stanza.attribute('type'),
        ver: stanza.attribute('ver'),
        wait: stanza.numberAttribute('wait'),
        uri: stanza.subText(NS, 'uri'),
        lang: stanza.langAttribute(),
        // These three should be using namespaced attributes, but browsers are stupid
        // when it comes to serializing attributes with namespaces
        version: stanza.attribute('xmpp:version', '1.0'),
        restart: stanza.attribute('xmpp:restart'),
        restartLogic: stanza.boolAttribute('xmpp:restartLogic'),
        payload: {
            get: function () {
                var results = [];
                for (var i = 0, len = this.xml.childNodes.length; i < len; i++)  {
                    var obj = stanza.build(this.xml.childNodes[i]);
                    if (obj !== undefined) {
                        results.push(obj);
                    }
                }
                return results;
            },
            set: function (values) {
                var self = this;
                values.forEach(function (stanza) {
                    self.xml.appendChild(stanza.xml);
                });
            }
        }
    }
});

},{"jxt":210,"jxt-xmpp-types":209}],53:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Presence = _dereq_('./presence');
var StreamFeatures = _dereq_('./streamFeatures');


var Caps = module.exports = stanza.define({
    name: 'caps',
    namespace: 'http://jabber.org/protocol/caps',
    element: 'c',
    fields: {
        ver: stanza.attribute('ver'),
        node: stanza.attribute('node'),
        hash: stanza.attribute('hash'),
        ext: stanza.attribute('ext')
    }
});

stanza.extend(Presence, Caps);
stanza.extend(StreamFeatures, Caps);

},{"./presence":80,"./streamFeatures":99,"jxt":210}],54:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Iq = _dereq_('./iq');
var Forwarded = _dereq_('./forwarded');


exports.Sent = stanza.define({
    name: 'carbonSent',
    eventName: 'carbon:sent',
    namespace: 'urn:xmpp:carbons:2',
    element: 'sent'
});

exports.Received = stanza.define({
    name: 'carbonReceived',
    eventName: 'carbon:received',
    namespace: 'urn:xmpp:carbons:2',
    element: 'received'
});

exports.Private = stanza.define({
    name: 'carbonPrivate',
    eventName: 'carbon:private',
    namespace: 'urn:xmpp:carbons:2',
    element: 'private'
});

exports.Enable = stanza.define({
    name: 'enableCarbons',
    namespace: 'urn:xmpp:carbons:2',
    element: 'enable'
});

exports.Disable = stanza.define({
    name: 'disableCarbons',
    namespace: 'urn:xmpp:carbons:2',
    element: 'disable'
});


stanza.extend(exports.Sent, Forwarded);
stanza.extend(exports.Received, Forwarded);
stanza.extend(Message, exports.Sent);
stanza.extend(Message, exports.Received);
stanza.extend(Message, exports.Private);
stanza.extend(Iq, exports.Enable);
stanza.extend(Iq, exports.Disable);

},{"./forwarded":63,"./iq":69,"./message":74,"jxt":210}],55:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');

var DataForm = _dereq_('./dataforms').DataForm;
var ErrorStanza = _dereq_('./error');
var Iq = _dereq_('./iq');

var NS = 'http://jabber.org/protocol/commands';
var ACTIONS = ['next', 'prev', 'complete', 'cancel'];
var CONDITIONS = [
    'bad-action', 'bad-locale', 'bad-payload', 'bad-sessionid',
    'malformed-action', 'session-expired'
];


var Command = module.exports = stanza.define({
    name: 'command',
    namespace: NS,
    element: 'command',
    fields: {
        action: stanza.attribute('action'),
        node: stanza.attribute('node'),
        sessionid: stanza.attribute('sessionid'),
        status: stanza.attribute('status'),
        noteType: stanza.subAttribute(NS, 'note', 'type'),
        note: stanza.subText(NS, 'note'),
        execute: stanza.subAttribute(NS, 'actions', 'execute'),
        actions: {
            get: function () {
                var result = [];
                var actionSet = stanza.find(this.xml, NS, 'actions');
                if (!actionSet.length) {
                    return [];
                }
                ACTIONS.forEach(function (action) {
                    var existing = stanza.find(actionSet[0], NS, action);
                    if (existing.length) {
                        result.push(action);
                    }
                });
                return result;
            },
            set: function (values) {
                var actionSet = stanza.findOrCreate(this.xml, NS, 'actions');
                for (var i = 0, len = actionSet.childNodes.length; i < len; i++) {
                    actionSet.removeChild(actionSet.childNodes[i]);
                }
                values.forEach(function (value) {
                    actionSet.appendChild(stanza.createElement(NS, value.toLowerCase(), NS));
                });
            }
        }
    }
});


stanza.add(ErrorStanza, 'adhocCommandCondition', stanza.enumSub(NS, CONDITIONS));

stanza.extend(Iq, Command);
stanza.extend(Command, DataForm);

},{"./dataforms":57,"./error":60,"./iq":69,"jxt":210}],56:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var StreamFeatures = _dereq_('./streamFeatures');


var NS = 'urn:xmpp:csi';


exports.CSIFeature = stanza.define({
    name: 'clientStateIndication',
    namespace: NS,
    element: 'csi'
});


exports.Active = stanza.define({
    name: 'csiActive',
    eventName: 'csi:active',
    namespace: NS,
    element: 'active',
    topLevel: true
});

exports.Inactive = stanza.define({
    name: 'csiInactive',
    eventName: 'csi:inactive',
    namespace: NS,
    element: 'inactive',
    topLevel: true
});


stanza.extend(StreamFeatures, exports.CSIFeature);

},{"./streamFeatures":99,"jxt":210}],57:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var JID = _dereq_('xmpp-jid').JID;

var FORM_NS = 'jabber:x:data';
var MEDIA_NS = 'urn:xmpp:media-element';
var VALIDATE_NS = 'http://jabber.org/protocol/xdata-validate';
var LAYOUT_NS = 'http://jabber.org/protocol/xdata-layout';

var SINGLE_FIELDS = [
    'text-single',
    'text-private',
    'list-single',
    'jid-single'
];


exports.Field = stanza.define({
    name: '_field',
    namespace: FORM_NS,
    element: 'field',
    init: function (data) {
        this._type = (data || {}).type || this.type;
    },
    fields: {
        type: {
            get: function () {
                return stanza.getAttribute(this.xml, 'type', 'text-single');
            },
            set: function (value) {
                this._type = value;
                stanza.setAttribute(this.xml, 'type', value);
            }
        },
        name: stanza.attribute('var'),
        desc: stanza.subText(FORM_NS, 'desc'),
        required: stanza.boolSub(FORM_NS, 'required'),
        label: stanza.attribute('label'),
        value: {
            get: function () {
                var vals = stanza.getMultiSubText(this.xml, FORM_NS, 'value');
                if (this._type === 'boolean') {
                    return vals[0] === '1' || vals[0] === 'true';
                }
                if (vals.length > 1) {
                    if (this._type === 'text-multi') {
                        return vals.join('\n');
                    }

                    if (this._type === 'jid-multi') {
                        return vals.map(function (jid) {
                            return new JID(jid);
                        });
                    }

                    return vals;
                }
                if (SINGLE_FIELDS.indexOf(this._type) >= 0) {
                    if (this._type === 'jid-single') {
                        return new JID(vals[0]);
                    }
                    return vals[0];
                }

                return vals;
            },
            set: function (value) {
                if (this._type === 'boolean') {
                    var truthy = value === true || value === 'true' || value === '1';
                    stanza.setSubText(this.xml, FORM_NS, 'value', truthy ? '1' : '0');
                } else {
                    if (this._type === 'text-multi' && typeof(value) === 'string') {
                        value = value.split('\n');
                    }
                    stanza.setMultiSubText(this.xml, FORM_NS, 'value', value);
                }
            }
        }
    }
});

exports.Option = stanza.define({
    name: '_formoption',
    namespace: FORM_NS,
    element: 'option',
    fields: {
        label: stanza.attribute('label'),
        value: stanza.subText(FORM_NS, 'value')
    }
});

exports.Item = stanza.define({
    name: '_formitem',
    namespace: FORM_NS,
    element: 'item'
});

exports.Media = stanza.define({
    name: 'media',
    element: 'media',
    namespace: MEDIA_NS,
    fields: {
        height: stanza.numberAttribute('height'),
        width: stanza.numberAttribute('width')
    }
});

exports.MediaURI = stanza.define({
    name: '_mediaURI',
    element: 'uri',
    namespace: MEDIA_NS,
    fields: {
        uri: stanza.text(),
        type: stanza.attribute('type')
    }
});

exports.Validation = stanza.define({
    name: 'validation',
    element: 'validate',
    namespace: VALIDATE_NS,
    fields: {
        dataType: stanza.attribute('datatype'),
        basic: stanza.boolSub(VALIDATE_NS, 'basic'),
        open: stanza.boolSub(VALIDATE_NS, 'open'),
        regex: stanza.subText(VALIDATE_NS, 'regex')
    }
});

exports.Range = stanza.define({
    name: 'range',
    element: 'range',
    namespace: VALIDATE_NS,
    fields: {
        min: stanza.attribute('min'),
        max: stanza.attribute('max')
    }
});

exports.ListRange = stanza.define({
    name: 'select',
    element: 'list-range',
    namespace: VALIDATE_NS,
    fields: {
        min: stanza.numberAttribute('min'),
        max: stanza.numberAttribute('max')
    }
});

var layoutContents = {
    get: function () {
        var result = [];
        for (var i = 0, len = this.xml.childNodes.length; i < len; i++) {
            var child = this.xml.childNodes[i];
            if (child.namespaceURI !== LAYOUT_NS) {
                continue;
            }

            switch (child.localName) {
                case 'text':
                    result.push({
                        text: child.textContent
                    });
                    break;
                case 'fieldref':
                    result.push({
                        field: child.getAttribute('var')
                    });
                    break;
                case 'reportedref':
                    result.push({
                        reported: true
                    });
                    break;
                case 'section':
                    result.push({
                        section: new exports.Section(null, child, this).toJSON()
                    });
                    break;
            }
        }

        return result;
    },
    set: function (values) {
        for (var i = 0, len = values.length; i < len; i++) {
            var value = values[i];
            if (value.text) {
                var text = stanza.createElement(LAYOUT_NS, 'text', LAYOUT_NS);
                text.textContent = value.text;
                this.xml.appendChild(text);
            }
            if (value.field) {
                var field = stanza.createElement(LAYOUT_NS, 'fieldref', LAYOUT_NS);
                field.setAttribute('var', value.field);
                this.xml.appendChild(field);
            }
            if (value.reported) {
                this.xml.appendChild(stanza.createElement(LAYOUT_NS, 'reportedref', LAYOUT_NS));
            }
            if (value.section) {
                var sectionXML = stanza.createElement(LAYOUT_NS, 'section', LAYOUT_NS);
                this.xml.appendChild(sectionXML);

                var section = new exports.Section(null, sectionXML);
                section.label = value.section.label;
                section.contents = value.section.contents;
            }
        }
    }
};

exports.Section = stanza.define({
    name: '_section',
    element: 'section',
    namespace: LAYOUT_NS,
    fields: {
        label: stanza.attribute('label'),
        contents: layoutContents
    }
});

exports.Page = stanza.define({
    name: '_page',
    element: 'page',
    namespace: LAYOUT_NS,
    fields: {
        label: stanza.attribute('label'),
        contents: layoutContents
    }
});
 
exports.DataForm = stanza.define({
    name: 'form',
    namespace: FORM_NS,
    element: 'x',
    init: function () {
        // Propagate reported field types to items

        if (!this.reportedFields.length) {
            return;
        }

        var fieldTypes = {};
        this.reportedFields.forEach(function (reported) {
            fieldTypes[reported.name] = reported.type;
        });

        this.items.forEach(function (item) {
            item.fields.forEach(function (field) {
                field.type = field._type = fieldTypes[field.name];
            });
        });
    },
    fields: {
        title: stanza.subText(FORM_NS, 'title'),
        instructions: stanza.multiSubText(FORM_NS, 'instructions'),
        type: stanza.attribute('type', 'form'),
        reportedFields: stanza.subMultiExtension(FORM_NS, 'reported', exports.Field)
    }
});


stanza.extend(Message, exports.DataForm);
stanza.extend(exports.DataForm, exports.Field, 'fields');
stanza.extend(exports.DataForm, exports.Item, 'items');
stanza.extend(exports.DataForm, exports.Page, 'layout');

stanza.extend(exports.Field, exports.Media);
stanza.extend(exports.Field, exports.Validation);
stanza.extend(exports.Field, exports.Option, 'options');

stanza.extend(exports.Item, exports.Field, 'fields');

stanza.extend(exports.Media, exports.MediaURI, 'uris');
stanza.extend(exports.Validation, exports.Range);
stanza.extend(exports.Validation, exports.ListRange);

},{"./message":74,"jxt":210,"xmpp-jid":236}],58:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');
var jxtutil = _dereq_('jxt-xmpp-types');

var DelayedDelivery = module.exports = stanza.define({
    name: 'delay',
    namespace: 'urn:xmpp:delay',
    element: 'delay',
    fields: {
        from: jxtutil.jidAttribute('from'),
        stamp: stanza.dateAttribute('stamp'),
        reason: stanza.text()
    }
});

stanza.extend(Message, DelayedDelivery);
stanza.extend(Presence, DelayedDelivery);

},{"./message":74,"./presence":80,"jxt":210,"jxt-xmpp-types":209}],59:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');
var Iq = _dereq_('./iq');
var RSM = _dereq_('./rsm');
var DataForm = _dereq_('./dataforms').DataForm;


var NSInfo = 'http://jabber.org/protocol/disco#info';
var NSItems = 'http://jabber.org/protocol/disco#items';



exports.DiscoInfo = stanza.define({
    name: 'discoInfo',
    namespace: NSInfo,
    element: 'query',
    fields: {
        node: stanza.attribute('node'),
        features: stanza.multiSubAttribute(NSInfo, 'feature', 'var')
    }
});


var DiscoIdentity = stanza.define({
    name: '_discoIdentity',
    namespace: NSInfo,
    element: 'identity',
    fields: {
        category: stanza.attribute('category'),
        type: stanza.attribute('type'),
        name: stanza.attribute('name'),
        lang: stanza.langAttribute()
    }
});


exports.DiscoItems = stanza.define({
    name: 'discoItems',
    namespace: NSItems,
    element: 'query',
    fields: {
        node: stanza.attribute('node'),
    }
});

var DiscoItem = stanza.define({
    name: '_discoItem',
    namespace: NSItems,
    element: 'item',
    fields: {
        jid: jxtutil.jidAttribute('jid'),
        node: stanza.attribute('node'),
        name: stanza.attribute('name')
    }
});


stanza.extend(Iq, exports.DiscoInfo);
stanza.extend(Iq, exports.DiscoItems);
stanza.extend(exports.DiscoItems, RSM);
stanza.extend(exports.DiscoItems, DiscoItem, 'items');
stanza.extend(exports.DiscoInfo, DiscoIdentity, 'identities');
stanza.extend(exports.DiscoInfo, DataForm, 'extensions');

},{"./dataforms":57,"./iq":69,"./rsm":90,"jxt":210,"jxt-xmpp-types":209}],60:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');
var Iq = _dereq_('./iq');


var ERR_NS = 'urn:ietf:params:xml:ns:xmpp-stanzas';
var CONDITIONS = [
    'bad-request', 'conflict', 'feature-not-implemented',
    'forbidden', 'gone', 'internal-server-error',
    'item-not-found', 'jid-malformed', 'not-acceptable',
    'not-allowed', 'not-authorized', 'payment-required',
    'recipient-unavailable', 'redirect',
    'registration-required', 'remote-server-not-found',
    'remote-server-timeout', 'resource-constraint',
    'service-unavailable', 'subscription-required',
    'undefined-condition', 'unexpected-request'
];


var ErrorStanza = module.exports = stanza.define({
    name: 'error',
    namespace: 'jabber:client',
    element: 'error',
    fields: {
        lang: {
            get: function () {
                return (this.parent || {}).lang || '';
            }
        },
        condition: stanza.enumSub(ERR_NS, CONDITIONS),
        gone: {
            get: function () {
                return stanza.getSubText(this.xml, ERR_NS, 'gone');
            },
            set: function (value) {
                this.condition = 'gone';
                stanza.setSubText(this.xml, ERR_NS, 'gone', value);
            }
        },
        redirect: {
            get: function () {
                return stanza.getSubText(this.xml, ERR_NS, 'redirect');
            },
            set: function (value) {
                this.condition = 'redirect';
                stanza.setSubText(this.xml, ERR_NS, 'redirect', value);
            }
        },
        code: stanza.attribute('code'),
        type: stanza.attribute('type'),
        by: jxtutil.jidAttribute('by'),
        $text: {
            get: function () {
                return stanza.getSubLangText(this.xml, ERR_NS, 'text', this.lang);
            }
        },
        text: {
            get: function () {
                var text = this.$text;
                return text[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, ERR_NS, 'text', value, this.lang);
            }
        }
    }
});


stanza.extend(Message, ErrorStanza);
stanza.extend(Presence, ErrorStanza);
stanza.extend(Iq, ErrorStanza);

},{"./iq":69,"./message":74,"./presence":80,"jxt":210,"jxt-xmpp-types":209}],61:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var DataForm = _dereq_('./dataforms').DataForm;

var NS = 'urn:xmpp:extdisco:1';


var Services = exports.Services = stanza.define({
    name: 'services',
    namespace: NS,
    element: 'services',
    fields: {
        type: stanza.attribute('type')
    }
});

var Credentials = exports.Credentials = stanza.define({
    name: 'credentials',
    namespace: NS,
    element: 'credentials'
});

var Service = stanza.define({
    name: 'service',
    namespace: NS,
    element: 'service',
    fields: {
        host: stanza.attribute('host'),
        port: stanza.attribute('port'),
        transport: stanza.attribute('transport'),
        type: stanza.attribute('type'),
        username: stanza.attribute('username'),
        password: stanza.attribute('password')
    }
});


stanza.extend(Services, Service, 'services');
stanza.extend(Credentials, Service);
stanza.extend(Service, DataForm);

stanza.extend(Iq, Services);
stanza.extend(Iq, Credentials);

},{"./dataforms":57,"./iq":69,"jxt":210}],62:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jingle = _dereq_('./jingle');
var Hash = _dereq_('./hash');


var NS = 'urn:xmpp:jingle:apps:file-transfer:3';
var TB_NS = 'urn:xmpp:thumbs:0';


exports.File = stanza.define({
    name: '_file',
    namespace: NS,
    element: 'file',
    fields: {
        name: stanza.subText(NS, 'name'),
        desc: stanza.subText(NS, 'desc'),
        size: stanza.numberSub(NS, 'size'),
        date: stanza.dateSub(NS, 'date')
    }
});

exports.Range = stanza.define({
    name: 'range',
    namespace: NS,
    element: 'range',
    fields: {
        offset: stanza.numberAttribute('offset')
    }
});

exports.Thumbnail = stanza.define({
    name: 'thumbnail',
    namespace: TB_NS,
    element: 'thumbnail',
    fields: {
        cid: stanza.attribute('cid'),
        mimeType: stanza.attribute('mime-type'),
        width: stanza.numberAttribute('width'),
        height: stanza.numberAttribute('height')
    }
});

exports.FileTransfer = stanza.define({
    name: '_filetransfer',
    namespace: NS,
    element: 'description',
    fields: {
        descType: {value: 'filetransfer'},
        offer: stanza.subExtension('offer', NS, 'offer', exports.File),
        request: stanza.subExtension('request', NS, 'request', exports.File)
    }
});


jingle.registerDescription(exports.FileTransfer);

stanza.extend(exports.File, Hash, 'hashes');
stanza.extend(exports.File, exports.Range);
stanza.extend(exports.File, exports.Thumbnail);
stanza.extend(jingle.Content, exports.FileTransfer);

},{"./hash":66,"./jingle":70,"jxt":210}],63:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');
var Iq = _dereq_('./iq');
var DelayedDelivery = _dereq_('./delayed');


var Forwarded = module.exports = stanza.define({
    name: 'forwarded',
    eventName: 'forward',
    namespace: 'urn:xmpp:forward:0',
    element: 'forwarded'
});


stanza.extend(Message, Forwarded);
stanza.extend(Forwarded, Message);
stanza.extend(Forwarded, Presence);
stanza.extend(Forwarded, Iq);
stanza.extend(Forwarded, DelayedDelivery);

},{"./delayed":58,"./iq":69,"./message":74,"./presence":80,"jxt":210}],64:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');

var NS = 'urn:ietf:params:xml:ns:xmpp-framing';


exports.Open = stanza.define({
    name: 'openStream',
    namespace: NS,
    element: 'open',
    topLevel: true,
    fields: {
        lang: stanza.langAttribute(),
        id: stanza.attribute('id'),
        version: stanza.attribute('version', '1.0'),
        to: jxtutil.jidAttribute('to', true),
        from: jxtutil.jidAttribute('from', true)
    }
});

exports.Close = stanza.define({
    name: 'closeStream',
    namespace: NS,
    element: 'close',
    topLevel: true,
    fields: {
        seeOtherURI: stanza.attribute('see-other-uri')
    }
});

},{"jxt":210,"jxt-xmpp-types":209}],65:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');
var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;

var NS = 'http://jabber.org/protocol/geoloc';

var GeoLoc = module.exports = stanza.define({
    name: 'geoloc',
    namespace: NS,
    element: 'geoloc',
    fields: {
        accuracy: stanza.numberSub(NS, 'accuracy', true),
        altitude: stanza.numberSub(NS, 'alt', true),
        area: stanza.subText(NS, 'area'),
        heading: stanza.numberSub(NS, 'bearing', true),
        bearing: stanza.numberSub(NS, 'bearing', true),
        building: stanza.subText(NS, 'building'),
        country: stanza.subText(NS, 'country'),
        countrycode: stanza.subText(NS, 'countrycode'),
        datum: stanza.subText(NS, 'datum'),
        description: stanza.subText(NS, 'description'),
        error: stanza.numberSub(NS, 'error', true),
        floor: stanza.subText(NS, 'floor'),
        latitude: stanza.numberSub(NS, 'lat', true),
        locality: stanza.subText(NS, 'locality'),
        longitude: stanza.numberSub(NS, 'lon', true),
        postalcode: stanza.subText(NS, 'postalcode'),
        region: stanza.subText(NS, 'region'),
        room: stanza.subText(NS, 'room'),
        speed: stanza.numberSub(NS, 'speed', true),
        street: stanza.subText(NS, 'street'),
        text: stanza.subText(NS, 'text'),
        timestamp: stanza.dateSub(NS, 'timestamp'),
        tzo: jxtutil.tzoSub(NS, 'tzo'),
        uri: stanza.subText(NS, 'uri')
    }
});

stanza.extend(Item, GeoLoc);
stanza.extend(EventItem, GeoLoc);

},{"./pubsub":83,"./pubsubEvents":85,"jxt":210,"jxt-xmpp-types":209}],66:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');

module.exports = stanza.define({
    name: 'hash',
    namespace: 'urn:xmpp:hashes:1',
    element: 'hash',
    fields: {
        algo: stanza.attribute('algo'),
        value: stanza.text()
    }
});

},{"jxt":210}],67:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Presence = _dereq_('./presence');

var NS = 'urn:xmpp:hats:0';


var Hat = module.exports = stanza.define({
    name: '_hat',
    namespace: NS,
    element: 'hat',
    fields: {
        lang: stanza.langAttribute(),
        name: stanza.attribute('name'),
        displayName: stanza.attribute('displayName')
    }
});


stanza.add(Presence, 'hats', stanza.subMultiExtension(NS, 'hats', Hat));

},{"./presence":80,"jxt":210}],68:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var jingle = _dereq_('./jingle');


var NS = 'urn:xmpp:jingle:transports:ice-udp:1';


exports.ICEUDP = stanza.define({
    name: '_iceUdp',
    namespace: NS,
    element: 'transport',
    fields: {
        transType: {value: 'iceUdp'},
        pwd: stanza.attribute('pwd'),
        ufrag: stanza.attribute('ufrag')
    }
});


exports.RemoteCandidate = stanza.define({
    name: 'remoteCandidate',
    namespace: NS,
    element: 'remote-candidate',
    fields: {
        component: stanza.attribute('component'),
        ip: stanza.attribute('ip'),
        port: stanza.attribute('port')
    }
});


exports.Candidate = stanza.define({
    name: '_iceUdpCandidate',
    namespace: NS,
    element: 'candidate',
    fields: {
        component: stanza.attribute('component'),
        foundation: stanza.attribute('foundation'),
        generation: stanza.attribute('generation'),
        id: stanza.attribute('id'),
        ip: stanza.attribute('ip'),
        network: stanza.attribute('network'),
        port: stanza.attribute('port'),
        priority: stanza.attribute('priority'),
        protocol: stanza.attribute('protocol'),
        relAddr: stanza.attribute('rel-addr'),
        relPort: stanza.attribute('rel-port'),
        tcpType: stanza.attribute('tcptype'),
        type: stanza.attribute('type')
    }
});


exports.Fingerprint = stanza.define({
    name: '_iceFingerprint',
    namespace: 'urn:xmpp:jingle:apps:dtls:0',
    element: 'fingerprint',
    fields: {
        hash: stanza.attribute('hash'),
        setup: stanza.attribute('setup'),
        value: stanza.text(),
        required: stanza.boolAttribute('required')
    }
});

exports.SctpMap = stanza.define({
    name: '_sctpMap',
    namespace: 'urn:xmpp:jingle:transports:dtls-sctp:1',
    element: 'sctpmap',
    fields: {
        number: stanza.attribute('number'),
        protocol: stanza.attribute('protocol'),
        streams: stanza.attribute('streams')
    }
});

jingle.registerTransport(exports.ICEUDP);

stanza.extend(jingle.Content, exports.ICEUDP);
stanza.extend(exports.ICEUDP, exports.Candidate, 'candidates');
stanza.extend(exports.ICEUDP, exports.RemoteCandidate);
stanza.extend(exports.ICEUDP, exports.Fingerprint, 'fingerprints');
stanza.extend(exports.ICEUDP, exports.SctpMap, 'sctp');

},{"./jingle":70,"jxt":210}],69:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');


var Iq = module.exports = stanza.define({
    name: 'iq',
    namespace: 'jabber:client',
    element: 'iq',
    topLevel: true,
    fields: {
        lang: stanza.langAttribute(),
        id: stanza.attribute('id'),
        to: jxtutil.jidAttribute('to', true),
        from: jxtutil.jidAttribute('from', true),
        type: stanza.attribute('type')
    }
});

var toJSON = Iq.prototype.toJSON;

Iq.prototype.toJSON = function () {
    var result = toJSON.call(this);
    result.resultReply = this.resultReply;
    result.errorReply = this.errorReply;
    return result;
};

Iq.prototype.resultReply = function (data) {
    data = data || {};
    data.to = this.from;
    data.id = this.id;
    data.type = 'result';
    return new Iq(data);
};

Iq.prototype.errorReply = function (data) {
    data = data || {};
    data.to = this.from;
    data.id = this.id;
    data.type = 'error';
    return new Iq(data);
};

},{"jxt":210,"jxt-xmpp-types":209}],70:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var ErrorStanza = _dereq_('./error');


var NS = 'urn:xmpp:jingle:1';
var ERRNS = 'urn:xmpp:jingle:errors:1';
var CONDITIONS = ['out-of-order', 'tie-break', 'unknown-session', 'unsupported-info'];
var REASONS = [
    'alternative-session', 'busy', 'cancel', 'connectivity-error',
    'decline', 'expired', 'failed-application', 'failed-transport',
    'general-error', 'gone', 'incompatible-parameters', 'media-error',
    'security-error', 'success', 'timeout', 'unsupported-applications',
    'unsupported-transports'
];


var REGISTRY = {
    descriptions: [],
    transports: []
};


exports.registerDescription = function (desc) {
    REGISTRY.descriptions.push(desc.prototype._name);
};

exports.registerTransport = function (trans) {
    REGISTRY.transports.push(trans.prototype._name);
};


exports.Jingle = stanza.define({
    name: 'jingle',
    namespace: NS,
    element: 'jingle',
    fields: {
        action: stanza.attribute('action'),
        initiator: stanza.attribute('initiator'),
        responder: stanza.attribute('responder'),
        sid: stanza.attribute('sid')
    }
});


exports.Content = stanza.define({
    name: '_jingleContent',
    namespace: NS,
    element: 'content',
    fields: {
        creator: stanza.attribute('creator'),
        disposition: stanza.attribute('disposition', 'session'),
        name: stanza.attribute('name'),
        senders: stanza.attribute('senders', 'both'),
        description: {
            get: function () {
                var opts = REGISTRY.descriptions;
                for (var i = 0, len = opts.length; i < len; i++) {
                    if (this._extensions[opts[i]]) {
                        return this._extensions[opts[i]];
                    }
                }
            },
            set: function (value) {
                var ext = '_' + value.descType;
                this[ext] = value;
            }
        },
        transport: {
            get: function () {
                var opts = REGISTRY.transports;
                for (var i = 0, len = opts.length; i < len; i++) {
                    if (this._extensions[opts[i]]) {
                        return this._extensions[opts[i]];
                    }
                }
            },
            set: function (value) {
                var ext = '_' + value.transType;
                this[ext] = value;
            }
        }
    }
});

exports.Reason = stanza.define({
    name: 'reason',
    namespace: NS,
    element: 'reason',
    fields: {
        condition: stanza.enumSub(NS, REASONS),
        alternativeSession: {
            get: function () {
                return stanza.getSubText(this.xml, NS, 'alternative-session');
            },
            set: function (value) {
                this.condition = 'alternative-session';
                stanza.setSubText(this.xml, NS, 'alternative-session', value);
            }
        },
        text: stanza.subText(NS, 'text')
    }
});


stanza.add(ErrorStanza, 'jingleCondition', stanza.enumSub(ERRNS, CONDITIONS));

stanza.extend(Iq, exports.Jingle);
stanza.extend(exports.Jingle, exports.Content, 'contents');
stanza.extend(exports.Jingle, exports.Reason);

},{"./error":60,"./iq":69,"jxt":210}],71:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;


var JSONExtension = module.exports = {
    get: function () {
        var data = stanza.getSubText(this.xml, 'urn:xmpp:json:0', 'json');
        if (data) {
            return JSON.parse(data);
        }
    },
    set: function (value) {
        value = JSON.stringify(value);
        if (value) {
            stanza.setSubText(this.xml, 'urn:xmpp:json:0', 'json', value);
        }
    }
};


stanza.add(Message, 'json', JSONExtension);
stanza.add(Item, 'json', JSONExtension);
stanza.add(EventItem, 'json', JSONExtension);

},{"./message":74,"./pubsub":83,"./pubsubEvents":85,"jxt":210}],72:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Message = _dereq_('./message');

var NS = 'urn:xmpp:eventlog';


exports.Log = stanza.define({
    name: 'log',
    namespace: NS,
    element: 'log',
    fields: {
        id: stanza.attribute('id'),
        timestamp: stanza.dateAttribute('timestamp'),
        type: stanza.attribute('type'),
        level: stanza.attribute('level'),
        object: stanza.attribute('object'),
        subject: stanza.attribute('subject'),
        facility: stanza.attribute('facility'),
        module: stanza.attribute('module'),
        message: stanza.subText(NS, 'message'),
        stackTrace: stanza.subText(NS, 'stackTrace')
    }
});

exports.Tag = stanza.define({
    name: '_logtag',
    namespace: NS,
    element: 'tag',
    fields: {
        name: stanza.attribute('name'),
        value: stanza.attribute('value'),
        type: stanza.attribute('type')
    }
});


stanza.extend(exports.Log, exports.Tag, 'tags');
stanza.extend(Message, exports.Log);

},{"./message":74,"jxt":210}],73:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');
var Message = _dereq_('./message');
var Iq = _dereq_('./iq');
var Forwarded = _dereq_('./forwarded');
var RSM = _dereq_('./rsm');
var JID = _dereq_('xmpp-jid').JID;


exports.MAMQuery = stanza.define({
    name: 'mamQuery',
    namespace: 'urn:xmpp:mam:tmp',
    element: 'query',
    fields: {
        queryid: stanza.attribute('queryid'),
        start: stanza.dateSub('urn:xmpp:mam:tmp', 'start'),
        end: stanza.dateSub('urn:xmpp:mam:tmp', 'end'),
        'with': jxtutil.jidSub('urn:xmpp:mam:tmp', 'with')
    }
});

exports.Result = stanza.define({
    name: 'mam',
    eventName: 'mam:result',
    namespace: 'urn:xmpp:mam:tmp',
    element: 'result',
    fields: {
        queryid: stanza.attribute('queryid'),
        id: stanza.attribute('id')
    }
});

exports.Archived = stanza.define({
    name: '_mamArchived',
    namespace: 'urn:xmpp:mam:tmp',
    element: 'archived',
    fields: {
        by: jxtutil.jidAttribute('by'),
        id: stanza.attribute('id')
    }
});

exports.Prefs = stanza.define({
    name: 'mamPrefs',
    namespace: 'urn:xmpp:mam:tmp',
    element: 'prefs',
    fields: {
        defaultCondition: stanza.attribute('default'),
        always: {
            get: function () {
                var results = [];
                var container = stanza.find(this.xml, this._NS, 'always');
                if (container.length === 0) {
                    return results;
                }
                container = container[0];
                var jids = stanza.getMultiSubText(container, this._NS, 'jid');
                jids.forEach(function (jid) {
                    results.push(new JID(jid.textContent));
                });
                return results;
            },
            set: function (value) {
                if (value.length > 0) {
                    var container = stanza.find(this.xml, this._NS, 'always');
                    stanza.setMultiSubText(container, this._NS, 'jid', value);
                }
            }
        },
        never: {
            get: function () {
                var results = [];
                var container = stanza.find(this.xml, this._NS, 'always');
                if (container.length === 0) {
                    return results;
                }
                container = container[0];
                var jids = stanza.getMultiSubText(container, this._NS, 'jid');
                jids.forEach(function (jid) {
                    results.push(new JID(jid.textContent));
                });
                return results;
            },
            set: function (value) {
                if (value.length > 0) {
                    var container = stanza.find(this.xml, this._NS, 'never');
                    stanza.setMultiSubText(container, this._NS, 'jid', value);
                }
            }
        }
    }
});

stanza.extend(Message, exports.Archived, 'archived');
stanza.extend(Iq, exports.MAMQuery);
stanza.extend(Iq, exports.Prefs);
stanza.extend(Message, exports.Result);
stanza.extend(exports.Result, Forwarded);
stanza.extend(exports.MAMQuery, RSM);

},{"./forwarded":63,"./iq":69,"./message":74,"./rsm":90,"jxt":210,"jxt-xmpp-types":209,"xmpp-jid":236}],74:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');


module.exports = stanza.define({
    name: 'message',
    namespace: 'jabber:client',
    element: 'message',
    topLevel: true,
    fields: {
        lang: stanza.langAttribute(),
        id: stanza.attribute('id'),
        to: jxtutil.jidAttribute('to', true),
        from: jxtutil.jidAttribute('from', true),
        type: stanza.attribute('type', 'normal'),
        thread: stanza.subText('jabber:client', 'thread'),
        parentThread: stanza.subAttribute('jabber:client', 'thread', 'parent'),
        subject: stanza.subText('jabber:client', 'subject'),
        $body: {
            get: function () {
                return stanza.getSubLangText(this.xml, this._NS, 'body', this.lang);
            }
        },
        body: {
            get: function () {
                var bodies = this.$body;
                return bodies[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, this._NS, 'body', value, this.lang);
            }
        },
        attention: stanza.boolSub('urn:xmpp:attention:0', 'attention'),
        chatState: stanza.enumSub('http://jabber.org/protocol/chatstates', [
            'active', 'composing', 'paused', 'inactive', 'gone'
        ]),
        replace: stanza.subAttribute('urn:xmpp:message-correct:0', 'replace', 'id'),
        requestReceipt: stanza.boolSub('urn:xmpp:receipts', 'request'),
        receipt: stanza.subAttribute('urn:xmpp:receipts', 'received', 'id')
    }
});

},{"jxt":210,"jxt-xmpp-types":209}],75:[function(_dereq_,module,exports){
'use strict';
var stanza = _dereq_('jxt');

var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;
var Message = _dereq_('./message');


var NS = 'http://jabber.org/protocol/mood';

var MOODS = [
    'afraid',
    'amazed',
    'amorous',
    'angry',
    'annoyed',
    'anxious',
    'aroused',
    'ashamed',
    'bored',
    'brave',
    'calm',
    'cautious',
    'cold',
    'confident',
    'confused',
    'contemplative',
    'contented',
    'cranky',
    'crazy',
    'creative',
    'curious',
    'dejected',
    'depressed',
    'disappointed',
    'disgusted',
    'dismayed',
    'distracted',
    'embarrassed',
    'envious',
    'excited',
    'flirtatious',
    'frustrated',
    'grateful',
    'grieving',
    'grumpy',
    'guilty',
    'happy',
    'hopeful',
    'hot',
    'humbled',
    'humiliated',
    'hungry',
    'hurt',
    'impressed',
    'in_awe',
    'in_love',
    'indignant',
    'interested',
    'intoxicated',
    'invincible',
    'jealous',
    'lonely',
    'lucky',
    'mean',
    'moody',
    'nervous',
    'neutral',
    'offended',
    'outraged',
    'playful',
    'proud',
    'relaxed',
    'relieved',
    'remorseful',
    'restless',
    'sad',
    'sarcastic',
    'serious',
    'shocked',
    'shy',
    'sick',
    'sleepy',
    'spontaneous',
    'stressed',
    'strong',
    'surprised',
    'thankful',
    'thirsty',
    'tired',
    'undefined',
    'weak',
    'worried'
];


var Mood = module.exports = stanza.define({
    name: 'mood',
    namespace: NS,
    element: 'mood',
    fields: {
        text: stanza.subText(NS, 'text'),
        value: stanza.enumSub(NS, MOODS)
    }
});


stanza.extend(Item, Mood);
stanza.extend(EventItem, Mood);
stanza.extend(Message, Mood);

},{"./message":74,"./pubsub":83,"./pubsubEvents":85,"jxt":210}],76:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');
var Iq = _dereq_('./iq');
var DataForm = _dereq_('./dataforms').DataForm;
var jxtutil = _dereq_('jxt-xmpp-types');

var NS = 'http://jabber.org/protocol/muc';
var USER_NS = NS + '#user';
var ADMIN_NS = NS + '#admin';
var OWNER_NS = NS + '#owner';
var UNIQ_NS = NS + '#unique';


var proxy = function (child, field) {
    return {
        get: function () {
            if (this._extensions[child]) {
                return this[child][field];
            }
        },
        set: function (value) {
            this[child][field] = value;
        }
    };
};

var UserItem = stanza.define({
    name: '_mucUserItem',
    namespace: USER_NS,
    element: 'item',
    fields: {
        affiliation: stanza.attribute('affiliation'),
        nick: stanza.attribute('nick'),
        jid: jxtutil.jidAttribute('jid'),
        role: stanza.attribute('role'),
        reason: stanza.subText(USER_NS, 'reason')
    }
});

var UserActor = stanza.define({
    name: '_mucUserActor',
    namespace: USER_NS,
    element: 'actor',
    fields: {
        nick: stanza.attribute('nick'),
        jid: jxtutil.jidAttribute('jid')
    }
});

var Destroyed = stanza.define({
    name: 'destroyed',
    namespace: USER_NS,
    element: 'destroy',
    fields: {
        jid: jxtutil.jidAttribute('jid'),
        reason: stanza.subText(USER_NS, 'reason')
    }
});

var Invite = stanza.define({
    name: 'invite',
    namespace: USER_NS,
    element: 'invite',
    fields: {
        to: jxtutil.jidAttribute('to'),
        from: jxtutil.jidAttribute('from'),
        reason: stanza.subText(USER_NS, 'reason'),
        thread: stanza.subAttribute(USER_NS, 'continue', 'thread'),
        'continue': stanza.boolSub(USER_NS, 'continue')
    }
});

var Decline = stanza.define({
    name: 'decline',
    namespace: USER_NS,
    element: 'decline',
    fields: {
        to: jxtutil.jidAttribute('to'),
        from: jxtutil.jidAttribute('from'),
        reason: stanza.subText(USER_NS, 'reason')
    }
});

var AdminItem = stanza.define({
    name: '_mucAdminItem',
    namespace: ADMIN_NS,
    element: 'item',
    fields: {
        affiliation: stanza.attribute('affiliation'),
        nick: stanza.attribute('nick'),
        jid: jxtutil.jidAttribute('jid'),
        role: stanza.attribute('role'),
        reason: stanza.subText(ADMIN_NS, 'reason')
    }
});

var AdminActor = stanza.define({
    name: 'actor',
    namespace: USER_NS,
    element: 'actor',
    fields: {
        nick: stanza.attribute('nick'),
        jid: jxtutil.jidAttribute('jid')
    }
});

var Destroy = stanza.define({
    name: 'destroy',
    namespace: OWNER_NS,
    element: 'destroy',
    fields: {
        jid: jxtutil.jidAttribute('jid'),
        password: stanza.subText(OWNER_NS, 'password'),
        reason: stanza.subText(OWNER_NS, 'reason')
    }
});

exports.MUC = stanza.define({
    name: 'muc',
    namespace: USER_NS,
    element: 'x',
    fields: {
        affiliation: proxy('_mucUserItem', 'affiliation'),
        nick: proxy('_mucUserItem', 'nick'),
        jid: proxy('_mucUserItem', 'jid'),
        role: proxy('_mucUserItem', 'role'),
        actor: proxy('_mucUserItem', '_mucUserActor'),
        reason: proxy('_mucUserItem', 'reason'),
        password: stanza.subText(USER_NS, 'password'),
        codes: {
            get: function () {
                return stanza.getMultiSubText(this.xml, USER_NS, 'status', function (sub) {
                    return stanza.getAttribute(sub, 'code');
                });
            },
            set: function (value) {
                var self = this;
                stanza.setMultiSubText(this.xml, USER_NS, 'status', value, function (val) {
                    var child = stanza.createElement(USER_NS, 'status', USER_NS);
                    stanza.setAttribute(child, 'code', val);
                    self.xml.appendChild(child);
                });
            }
        }
    }
});

exports.MUCAdmin = stanza.define({
    name: 'mucAdmin',
    namespace: ADMIN_NS,
    element: 'query',
    fields: {
        affiliation: proxy('_mucAdminItem', 'affiliation'),
        nick: proxy('_mucAdminItem', 'nick'),
        jid: proxy('_mucAdminItem', 'jid'),
        role: proxy('_mucAdminItem', 'role'),
        actor: proxy('_mucAdminItem', '_mucAdminActor'),
        reason: proxy('_mucAdminItem', 'reason')
    }
});

exports.MUCOwner = stanza.define({
    name: 'mucOwner',
    namespace: OWNER_NS,
    element: 'query'
});

exports.MUCJoin = stanza.define({
    name: 'joinMuc',
    namespace: NS,
    element: 'x',
    fields: {
        password: stanza.subText(NS, 'password'),
        history: {
            get: function () {
                var result = {};
                var hist = stanza.find(this.xml, this._NS, 'history');

                if (!hist.length) {
                    return {};
                }
                hist = hist[0];

                var maxchars = hist.getAttribute('maxchars') || '';
                var maxstanzas = hist.getAttribute('maxstanas') || '';
                var seconds = hist.getAttribute('seconds') || '';
                var since = hist.getAttribute('since') || '';


                if (maxchars) {
                    result.maxchars = parseInt(maxchars, 10);
                }
                if (maxstanzas) {
                    result.maxstanzas = parseInt(maxstanzas, 10);
                }
                if (seconds) {
                    result.seconds = parseInt(seconds, 10);
                }
                if (since) {
                    result.since = new Date(since);
                }
            },
            set: function (opts) {
                var existing = stanza.find(this.xml, this._NS, 'history');
                if (existing.length) {
                    for (var i = 0; i < existing.length; i++) {
                        this.xml.removeChild(existing[i]);
                    }
                }

                var hist = stanza.createElement(this._NS, 'history', this._NS);
                this.xml.appendChild(hist);

                if (opts.maxchars) {
                    hist.setAttribute('' + opts.maxchars);
                }
                if (opts.maxstanzas) {
                    hist.setAttribute('' + opts.maxstanzas);
                }
                if (opts.seconds) {
                    hist.setAttribute('' + opts.seconds);
                }
                if (opts.since) {
                    hist.setAttribute(opts.since.toISOString());
                }
            }
        }
    }
});

exports.DirectInvite = stanza.define({
    name: 'mucInvite',
    namespace: 'jabber:x:conference',
    element: 'x',
    fields: {
        jid: jxtutil.jidAttribute('jid'),
        password: stanza.attribute('password'),
        reason: stanza.attribute('reason'),
        thread: stanza.attribute('thread'),
        'continue': stanza.boolAttribute('continue')
    }
});


stanza.add(Iq, 'mucUnique', stanza.subText(UNIQ_NS, 'unique'));


stanza.extend(UserItem, UserActor);
stanza.extend(exports.MUC, UserItem);
stanza.extend(exports.MUC, Invite, 'invites');
stanza.extend(exports.MUC, Decline);
stanza.extend(exports.MUC, Destroyed);
stanza.extend(AdminItem, AdminActor);
stanza.extend(exports.MUCAdmin, AdminItem, 'items');
stanza.extend(exports.MUCOwner, Destroy);
stanza.extend(exports.MUCOwner, DataForm);
stanza.extend(Presence, exports.MUC);
stanza.extend(Message, exports.MUC);
stanza.extend(Presence, exports.MUCJoin);
stanza.extend(Message, exports.DirectInvite);
stanza.extend(Iq, exports.MUCAdmin);
stanza.extend(Iq, exports.MUCOwner);

},{"./dataforms":57,"./iq":69,"./message":74,"./presence":80,"jxt":210,"jxt-xmpp-types":209}],77:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;
var Presence = _dereq_('./presence');
var Message = _dereq_('./message');


var nick = stanza.subText('http://jabber.org/protocol/nick', 'nick');


stanza.add(Item, 'nick', nick);
stanza.add(EventItem, 'nick', nick);
stanza.add(Presence, 'nick', nick);
stanza.add(Message, 'nick', nick);

},{"./message":74,"./presence":80,"./pubsub":83,"./pubsubEvents":85,"jxt":210}],78:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var NS = 'jabber:x:oob';

var OOB = module.exports = stanza.define({
    name: 'oob',
    element: 'x',
    namespace: NS,
    fields: {
        url: stanza.subText(NS, 'url'),
        desc: stanza.subText(NS, 'desc')
    }
});

stanza.extend(Message, OOB, 'oobURIs');

},{"./message":74,"jxt":210}],79:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');

var NS = 'urn:xmpp:ping';

var Ping = module.exports = stanza.define({
    name: 'ping',
    namespace: NS,
    element: 'ping',
    fields: {
    }
});

stanza.extend(Iq, Ping);

},{"./iq":69,"jxt":210}],80:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');


module.exports = stanza.define({
    name: 'presence',
    namespace: 'jabber:client',
    element: 'presence',
    topLevel: true,
    fields: {
        lang: stanza.langAttribute(),
        id: stanza.attribute('id'),
        to: jxtutil.jidAttribute('to', true),
        from: jxtutil.jidAttribute('from', true),
        priority: stanza.numberSub('jabber:client', 'priority', false, 0),
        show: stanza.subText('jabber:client', 'show'),
        type: {
            get: function () {
                return stanza.getAttribute(this.xml, 'type', 'available');
            },
            set: function (value) {
                if (value === 'available') {
                    value = false;
                }
                stanza.setAttribute(this.xml, 'type', value);
            }
        },
        $status: {
            get: function () {
                return stanza.getSubLangText(this.xml, this._NS, 'status', this.lang);
            }
        },
        status: {
            get: function () {
                var statuses = this.$status;
                return statuses[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, this._NS, 'status', value, this.lang);
            }
        },
        idleSince: stanza.dateSubAttribute('urn:xmpp:idle:1', 'idle', 'since'),
        decloak: stanza.subAttribute('urn:xmpp:decloak:0', 'decloak', 'reason'),
        avatarId: {
            get: function () {
                var NS = 'vcard-temp:x:update';
                var update = stanza.find(this.xml, NS, 'x');
                if (!update.length) {
                    return '';
                }
                return stanza.getSubText(update[0], NS, 'photo');
            },
            set: function (value) {
                var NS = 'vcard-temp:x:update';
                var update = stanza.findOrCreate(this.xml, NS, 'x');

                if (value === '') {
                    stanza.setBoolSub(update, NS, 'photo', true);
                } else if (value === true) {
                    return;
                } else if (value) {
                    stanza.setSubText(update, NS, 'photo', value);
                } else {
                    this.xml.removeChild(update);
                }
            }
        }
    }
});

},{"jxt":210,"jxt-xmpp-types":209}],81:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');


var PrivateStorage = module.exports = stanza.define({
    name: 'privateStorage',
    namespace: 'jabber:iq:private',
    element: 'query'
});

stanza.extend(Iq, PrivateStorage);

},{"./iq":69,"jxt":210}],82:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');
var Presence = _dereq_('./presence');

var NS = 'urn:xmpp:psa';
var CONDITIONS = [
    'server-unavailable', 'connection-paused'
];


var PSA = module.exports = stanza.define({
    name: 'state',
    namespace: NS,
    element: 'state-annotation',
    fields: {
        from: jxtutil.jidAttribute('from'),
        condition: stanza.enumSub(NS, CONDITIONS),
        description: stanza.subText(NS, 'description')
    }
});


stanza.extend(Presence, PSA);

},{"./presence":80,"jxt":210,"jxt-xmpp-types":209}],83:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');
var Iq = _dereq_('./iq');
var DataForm = _dereq_('./dataforms').DataForm;
var RSM = _dereq_('./rsm');


var NS = 'http://jabber.org/protocol/pubsub';


exports.Pubsub = stanza.define({
    name: 'pubsub',
    namespace: 'http://jabber.org/protocol/pubsub',
    element: 'pubsub',
    fields: {
        publishOptions: {
            get: function () {
                var conf = stanza.find(this.xml, this._NS, 'publish-options');
                if (conf.length && conf[0].childNodes.length) {
                    return new DataForm({}, conf[0].childNodes[0]);
                }
            },
            set: function (value) {
                var conf = stanza.findOrCreate(this.xml, this._NS, 'publish-options');
                if (value) {
                    var form = new DataForm(value);
                    conf.appendChild(form.xml);
                }
            }
        }
    }
});

exports.Subscribe = stanza.define({
    name: 'subscribe',
    namespace: NS,
    element: 'subscribe',
    fields: {
        node: stanza.attribute('node'),
        jid: jxtutil.jidAttribute('jid')
    }
});

exports.Subscription = stanza.define({
    name: 'subscription',
    namespace: NS,
    element: 'subscription',
    fields: {
        node: stanza.attribute('node'),
        jid: jxtutil.jidAttribute('jid'),
        subid: stanza.attribute('subid'),
        type: stanza.attribute('subscription'),
        configurable: stanza.boolSub('subscribe-options'),
        configurationRequired: {
            get: function () {
                var options = stanza.find(this.xml, NS, 'subscribe-options');
                if (options.length) {
                    return stanza.getBoolSub(options[0], NS, 'required');
                }
                return false;
            }
        }
    }
});

exports.SubscriptionOptions = stanza.define({
    name: 'subscriptionOptions',
    namespace: NS,
    element: 'options',
    fields: {
        node: stanza.attribute('node'),
        jid: jxtutil.jidAttribute('jid'),
        subid: stanza.attribute('subid')
    }
});

exports.Unsubscribe = stanza.define({
    name: 'unsubscribe',
    namespace: NS,
    element: 'unsubscribe',
    fields: {
        node: stanza.attribute('node'),
        jid: jxtutil.jidAttribute('jid')
    }
});

exports.Publish = stanza.define({
    name: 'publish',
    namespace: NS,
    element: 'publish',
    fields: {
        node: stanza.attribute('node'),
    }
});

exports.Retract = stanza.define({
    name: 'retract',
    namespace: NS,
    element: 'retract',
    fields: {
        node: stanza.attribute('node'),
        notify: stanza.boolAttribute('notify'),
        id: stanza.subAttribute(NS, 'item', 'id')
    }
});

exports.Retrieve = stanza.define({
    name: 'retrieve',
    namespace: NS,
    element: 'items',
    fields: {
        node: stanza.attribute('node'),
        max: stanza.attribute('max_items')
    }
});

exports.Item = stanza.define({
    name: 'item',
    namespace: NS,
    element: 'item',
    fields: {
        id: stanza.attribute('id')
    }
});


stanza.extend(exports.Pubsub, exports.Subscribe);
stanza.extend(exports.Pubsub, exports.Unsubscribe);
stanza.extend(exports.Pubsub, exports.Publish);
stanza.extend(exports.Pubsub, exports.Retrieve);
stanza.extend(exports.Pubsub, exports.Subscription);
stanza.extend(exports.Pubsub, exports.SubscriptionOptions);
stanza.extend(exports.Pubsub, RSM);

stanza.extend(exports.Publish, exports.Item, 'items');
stanza.extend(exports.Retrieve, exports.Item, 'items');

stanza.extend(exports.SubscriptionOptions, DataForm);

stanza.extend(Iq, exports.Pubsub);

},{"./dataforms":57,"./iq":69,"./rsm":90,"jxt":210,"jxt-xmpp-types":209}],84:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var ErrorStanza = _dereq_('./error');


var ERRNS = 'http://jabber.org/protocol/pubsub#errors';
var CONDITIONS = [
    'closed-node',
    'configuration-required',
    'invalid-jid',
    'invalid-options',
    'invalid-payload',
    'invalid-subid',
    'item-forbidden',
    'item-required',
    'jid-required',
    'max-items-exceeded',
    'max-nodes-exceeded',
    'nodeid-required',
    'not-in-roster-group',
    'not-subscribed',
    'payload-too-big',
    'payload-required',
    'pending-subscription',
    'presence-subscription-required',
    'subid-required',
    'too-many-subscriptions',
    'unsupported',
    'unsupported-access-model'
];


stanza.add(ErrorStanza, 'pubsubCondition', stanza.enumSub(ERRNS, CONDITIONS));

},{"./error":60,"jxt":210}],85:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');
var Message = _dereq_('./message');
var DataForm = _dereq_('./dataforms').DataForm;


var NS = 'http://jabber.org/protocol/pubsub#event';


exports.Event = stanza.define({
    name: 'event',
    namespace: NS,
    element: 'event'
});

exports.EventPurge = stanza.define({
    name: 'purged',
    namespace: NS,
    element: 'purge',
    fields: {
        node: stanza.attribute('node'),
    }
});

exports.EventDelete = stanza.define({
    name: 'deleted',
    namespace: NS,
    element: 'delete',
    fields: {
        node: stanza.attribute('node'),
        redirect: stanza.subAttribute(NS, 'redirect', 'uri')
    }
});

exports.EventSubscription = stanza.define({
    name: 'subscriptionChanged',
    namespace: NS,
    element: 'subscription',
    fields: {
        node: stanza.attribute('node'),
        jid: jxtutil.jidAttribute('jid'),
        type: stanza.attribute('subscription'),
        subid: stanza.attribute('subid'),
        expiry: {
            get: function () {
                var text = stanza.getAttribute(this.xml, 'expiry');
                if (text === 'presence') {
                    return text;
                } else if (text) {
                    return new Date(text);
                }
            },
            set: function (value) {
                if (!value) {
                    return;
                }

                if (typeof value !== 'string') {
                    value = value.toISOString();
                }

                stanza.setAttribute(this.xml, 'expiry', value);
            }
        }
    }
});

exports.EventConfiguration = stanza.define({
    name: 'configurationChanged',
    namespace: NS,
    element: 'configuration',
    fields: {
        node: stanza.attribute('node')
    }
});

exports.EventItems = stanza.define({
    name: 'updated',
    namespace: NS,
    element: 'items',
    fields: {
        node: stanza.attribute('node'),
        retracted: {
            get: function () {
                var results = [];
                var retracted = stanza.find(this.xml, this._NS, 'retract');

                retracted.forEach(function (xml) {
                    results.push(xml.getAttribute('id'));
                });
                return results;
            },
            set: function (value) {
                var self = this;
                value.forEach(function (id) {
                    var retracted = stanza.createElement(self._NS, 'retract', self._NS);
                    retracted.setAttribute('id', id);
                    this.xml.appendChild(retracted);
                });
            }
        }
    }
});

exports.EventItem = stanza.define({
    name: '_eventItem',
    namespace: NS,
    element: 'item',
    fields: {
        id: stanza.attribute('id'),
        node: stanza.attribute('node'),
        publisher: jxtutil.jidAttribute('publisher')
    }
});


stanza.extend(exports.EventConfiguration, DataForm);

stanza.extend(exports.EventItems, exports.EventItem, 'published');

stanza.extend(exports.Event, exports.EventItems);
stanza.extend(exports.Event, exports.EventSubscription);
stanza.extend(exports.Event, exports.EventConfiguration);
stanza.extend(exports.Event, exports.EventDelete);
stanza.extend(exports.Event, exports.EventPurge);

stanza.extend(Message, exports.Event);

},{"./dataforms":57,"./message":74,"jxt":210,"jxt-xmpp-types":209}],86:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var DataForm = _dereq_('./dataforms').DataForm;


var NS = 'http://jabber.org/protocol/pubsub#owner';


exports.PubsubOwner = stanza.define({
    name: 'pubsubOwner',
    namespace: NS,
    element: 'pubsub',
    fields: {
        create: stanza.subAttribute(NS, 'create', 'node'),
        purge: stanza.subAttribute(NS, 'purge', 'node'),
        del: stanza.subAttribute(NS, 'delete', 'node'),
        redirect: {
            get: function () {
                var del = stanza.find(this.xml, this._NS, 'delete');
                if (del.length) {
                    return stanza.getSubAttribute(del[0], this._NS, 'redirect', 'uri');
                }
                return '';
            },
            set: function (value) {
                var del = stanza.findOrCreate(this.xml, this._NS, 'delete');
                stanza.setSubAttribute(del, this._NS, 'redirect', 'uri', value);
            }
        }
    }
});

exports.Configure = stanza.define({
    name: 'config',
    namespace: NS,
    element: 'configure',
    fields: {
        node: stanza.attribute('node')
    }
});


stanza.extend(exports.Configure, DataForm);
stanza.extend(exports.PubsubOwner, exports.Configure);

stanza.extend(Iq, exports.PubsubOwner);

},{"./dataforms":57,"./iq":69,"jxt":210}],87:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var stanza = _dereq_('jxt');
var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;
var Presence = _dereq_('./presence');


var NS = 'urn:xmpp:reach:0';


var ReachURI = module.exports = stanza.define({
    name: '_reachAddr',
    namespace: NS,
    element: 'addr',
    fields: {
        uri: stanza.attribute('uri'),
        $desc: {
            get: function () {
                return stanza.getSubLangText(this.xml, NS, 'desc', this.lang);
            }
        },
        desc: {
            get: function () {
                var descs = this.$desc;
                return descs[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, NS, 'desc', value, this.lang);
            }
        }
    }
});


var reachability = {
    get: function () {
        var reach = stanza.find(this.xml, NS, 'reach');
        var results = [];
        if (reach.length) {
            var addrs = stanza.find(reach[0], NS, 'addr');
            _.forEach(addrs, function (addr) {
                results.push(new ReachURI({}, addr));
            });
        }
        return results;
    },
    set: function (value) {
        var reach = stanza.findOrCreate(this.xml, NS, 'reach');
        stanza.setAttribute(reach, 'xmlns', NS);
        _.forEach(value, function (info) {
            var addr = new ReachURI(info);
            reach.appendChild(addr.xml);
        });
    }
};


stanza.add(Item, 'reach', reachability);
stanza.add(EventItem, 'reach', reachability);
stanza.add(Presence, 'reach', reachability);

},{"./presence":80,"./pubsub":83,"./pubsubEvents":85,"jxt":210,"underscore":234}],88:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');

var Iq = _dereq_('./iq');
var DataForm = _dereq_('./dataforms').DataForm;
var OOB = _dereq_('./oob');

var NS = 'jabber:iq:register';


var Register = module.exports = stanza.define({
    name: 'register',
    namespace: NS,
    element: 'query',
    fields: {
        instructions: stanza.subText(NS, 'instructions'),
        registered: stanza.boolSub(NS, 'registered'),
        remove: stanza.boolSub(NS, 'remove'),
        username: stanza.subText(NS, 'username'),
        nick: stanza.subText(NS, 'nick'),
        password: stanza.subText(NS, 'password'),
        name: stanza.subText(NS, 'name'),
        first: stanza.subText(NS, 'first'),
        last: stanza.subText(NS, 'last'),
        email: stanza.subText(NS, 'email'),
        address: stanza.subText(NS, 'address'),
        city: stanza.subText(NS, 'city'),
        state: stanza.subText(NS, 'state'),
        zip: stanza.subText(NS, 'zip'),
        phone: stanza.subText(NS, 'phone'),
        url: stanza.subText(NS, 'url'),
        date: stanza.subText(NS, 'date'),
        misc: stanza.subText(NS, 'misc'),
        text: stanza.subText(NS, 'text'),
        key: stanza.subText(NS, 'key')
    }
});


stanza.extend(Iq, Register);
stanza.extend(Register, DataForm);
stanza.extend(Register, OOB);

},{"./dataforms":57,"./iq":69,"./oob":78,"jxt":210}],89:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');
var Iq = _dereq_('./iq');

var NS = 'jabber:iq:roster';


var Roster = module.exports = stanza.define({
    name: 'roster',
    namespace: NS,
    element: 'query',
    fields: {
        ver: {
            get: function () {
                return stanza.getAttribute(this.xml, 'ver');
            },
            set: function (value) {
                var force = (value === '');
                stanza.setAttribute(this.xml, 'ver', value, force);
            }
        }
    }
});

var RosterItem = stanza.define({
    name: '_rosterItem',
    namespace: NS,
    element: 'item',
    fields: {
        jid: jxtutil.jidAttribute('jid', true),
        name: stanza.attribute('name'),
        subscription: stanza.attribute('subscription', 'none'),
        subscriptionRequested: {
            get: function () {
                var ask = stanza.getAttribute(this.xml, 'ask');
                return ask === 'subscribe';
            }
        },
        preApproved: stanza.boolAttribute(NS, 'approved'),
        groups: stanza.multiSubText(NS, 'group')
    }
});


stanza.extend(Iq, Roster);
stanza.extend(Roster, RosterItem, 'items');

},{"./iq":69,"jxt":210,"jxt-xmpp-types":209}],90:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');


var NS = 'http://jabber.org/protocol/rsm';


module.exports = stanza.define({
    name: 'rsm',
    namespace: NS,
    element: 'set',
    fields: {
        after: stanza.subText(NS, 'after'),
        before: {
            get: function () {
                return stanza.getSubText(this.xml, this._NS, 'before');
            },
            set: function (value) {
                if (value === true) {
                    stanza.findOrCreate(this.xml, this._NS, 'before');
                } else {
                    stanza.setSubText(this.xml, this._NS, 'before', value);
                }
            }
        },
        count: stanza.numberSub(NS, 'count', false, 0),
        first: stanza.subText(NS, 'first'),
        firstIndex: stanza.subAttribute(NS, 'first', 'index'),
        index: stanza.subText(NS, 'index'),
        last: stanza.subText(NS, 'last'),
        max: stanza.subText(NS, 'max')
    }
});

},{"jxt":210}],91:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jingle = _dereq_('./jingle');

var NS = 'urn:xmpp:jingle:apps:rtp:1';
var FBNS = 'urn:xmpp:jingle:apps:rtp:rtcp-fb:0';
var HDRNS = 'urn:xmpp:jingle:apps:rtp:rtp-hdrext:0';
var INFONS = 'urn:xmpp:jingle:apps:rtp:info:1';
var SSMANS = 'urn:xmpp:jingle:apps:rtp:ssma:0';
var GROUPNS = 'urn:xmpp:jingle:apps:grouping:0';


var Feedback = {
    get: function () {
        var existing = stanza.find(this.xml, FBNS, 'rtcp-fb');
        var result = [];
        existing.forEach(function (xml) {
            result.push({
                type: stanza.getAttribute(xml, 'type'),
                subtype: stanza.getAttribute(xml, 'subtype')
            });
        });
        existing = stanza.find(this.xml, FBNS, 'rtcp-fb-trr-int');
        existing.forEach(function (xml) {
            result.push({
                type: stanza.getAttribute(xml, 'type'),
                value: stanza.getAttribute(xml, 'value')
            });
        });
        return result;
    },
    set: function (values) {
        var self = this;
        var existing = stanza.find(this.xml, FBNS, 'rtcp-fb');
        existing.forEach(function (item) {
            self.xml.removeChild(item);
        });
        existing = stanza.find(this.xml, FBNS, 'rtcp-fb-trr-int');
        existing.forEach(function (item) {
            self.xml.removeChild(item);
        });

        values.forEach(function (value) {
            var fb;
            if (value.type === 'trr-int') {
                fb = stanza.createElement(FBNS, 'rtcp-fb-trr-int', NS);
                stanza.setAttribute(fb, 'type', value.type);
                stanza.setAttribute(fb, 'value', value.value);
            } else {
                fb = stanza.createElement(FBNS, 'rtcp-fb', NS);
                stanza.setAttribute(fb, 'type', value.type);
                stanza.setAttribute(fb, 'subtype', value.subtype);
            }
            self.xml.appendChild(fb);
        });
    }
};

exports.RTP = stanza.define({
    name: '_rtp',
    namespace: NS,
    element: 'description',
    fields: {
        descType: {value: 'rtp'},
        media: stanza.attribute('media'),
        ssrc: stanza.attribute('ssrc'),
        mux: stanza.boolSub(NS, 'rtcp-mux'),
        encryption: {
            get: function () {
                var enc = stanza.find(this.xml, NS, 'encryption');
                if (!enc.length) {
                    return [];
                }
                enc = enc[0];

                var self = this;
                var data = stanza.find(enc, NS, 'crypto');
                var results = [];

                data.forEach(function (xml) {
                    results.push(new exports.Crypto({}, xml, self).toJSON());
                });
                return results;
            },
            set: function (values) {
                var enc = stanza.find(this.xml, NS, 'encryption');
                if (enc.length) {
                    this.xml.removeChild(enc);
                }

                if (!values.length) {
                    return;
                }

                stanza.setBoolSubAttribute(this.xml, NS, 'encryption', 'required', true);
                enc = stanza.find(this.xml, NS, 'encryption')[0];

                var self = this;
                values.forEach(function (value) {
                    var content = new exports.Crypto(value, null, self);
                    enc.appendChild(content.xml);
                });
            }
        },
        feedback: Feedback,
        headerExtensions: {
            get: function () {
                var existing = stanza.find(this.xml, HDRNS, 'rtp-hdrext');
                var result = [];
                existing.forEach(function (xml) {
                    result.push({
                        id: stanza.getAttribute(xml, 'id'),
                        uri: stanza.getAttribute(xml, 'uri'),
                        senders: stanza.getAttribute(xml, 'senders')
                    });
                });
                return result;
            },
            set: function (values) {
                var self = this;
                var existing = stanza.find(this.xml, HDRNS, 'rtp-hdrext');
                existing.forEach(function (item) {
                    self.xml.removeChild(item);
                });

                values.forEach(function (value) {
                    var hdr = stanza.createElement(HDRNS, 'rtp-hdrext', NS);
                    stanza.setAttribute(hdr, 'id', value.id);
                    stanza.setAttribute(hdr, 'uri', value.uri);
                    stanza.setAttribute(hdr, 'senders', value.senders);
                    self.xml.appendChild(hdr);
                });
            }
        }
    }
});


exports.PayloadType = stanza.define({
    name: '_payloadType',
    namespace: NS,
    element: 'payload-type',
    fields: {
        channels: stanza.attribute('channels'),
        clockrate: stanza.attribute('clockrate'),
        id: stanza.attribute('id'),
        maxptime: stanza.attribute('maxptime'),
        name: stanza.attribute('name'),
        ptime: stanza.attribute('ptime'),
        feedback: Feedback,
        parameters: {
            get: function () {
                var result = [];
                var params = stanza.find(this.xml, NS, 'parameter');
                params.forEach(function (param) {
                    result.push({
                        key: stanza.getAttribute(param, 'name'),
                        value: stanza.getAttribute(param, 'value')
                    });
                });
                return result;
            },
            set: function (values) {
                var self = this;
                values.forEach(function (value) {
                    var param = stanza.createElement(NS, 'parameter');
                    stanza.setAttribute(param, 'name', value.key);
                    stanza.setAttribute(param, 'value', value.value);
                    self.xml.appendChild(param);
                });
            }
        }
    }
});

exports.Bandwidth = stanza.define({
    name: 'bandwidth',
    namespace: NS,
    element: 'bandwidth',
    fields: {
        type: stanza.attribute('type'),
        bandwidth: stanza.text()
    }
});

exports.Crypto = stanza.define({
    name: 'crypto',
    namespace: NS,
    element: 'crypto',
    fields: {
        cipherSuite: stanza.attribute('crypto-suite'),
        keyParams: stanza.attribute('key-params'),
        sessionParams: stanza.attribute('session-params'),
        tag: stanza.attribute('tag')
    }
});


exports.ContentGroup = stanza.define({
    name: '_group',
    namespace: GROUPNS,
    element: 'group',
    fields: {
        semantics: stanza.attribute('semantics'),
        contents: stanza.multiSubAttribute(GROUPNS, 'content', 'name')
    }
});

exports.SourceGroup = stanza.define({
    name: '_sourceGroup',
    namespace: SSMANS,
    element: 'ssrc-group',
    fields: {
        semantics: stanza.attribute('semantics'),
        sources: stanza.multiSubAttribute(SSMANS, 'source', 'ssrc')
    }
});

exports.Source = stanza.define({
    name: '_source',
    namespace: SSMANS,
    element: 'source',
    fields: {
        ssrc: stanza.attribute('ssrc'),
        parameters: {
            get: function () {
                var result = [];
                var params = stanza.find(this.xml, SSMANS, 'parameter');
                params.forEach(function (param) {
                    result.push({
                        key: stanza.getAttribute(param, 'name'),
                        value: stanza.getAttribute(param, 'value')
                    });
                });
                return result;
            },
            set: function (values) {
                var self = this;
                values.forEach(function (value) {
                    var param = stanza.createElement(SSMANS, 'parameter');
                    stanza.setAttribute(param, 'name', value.key);
                    stanza.setAttribute(param, 'value', value.value);
                    self.xml.appendChild(param);
                });
            }
        }
    }
});


exports.Mute = stanza.define({
    name: 'mute',
    namespace: INFONS,
    element: 'mute',
    fields: {
        creator: stanza.attribute('creator'),
        name: stanza.attribute('name')
    }
});


exports.Unmute = stanza.define({
    name: 'unmute',
    namespace: INFONS,
    element: 'unmute',
    fields: {
        creator: stanza.attribute('creator'),
        name: stanza.attribute('name')
    }
});


jingle.registerDescription(exports.RTP);

stanza.extend(jingle.Content, exports.RTP);
stanza.extend(exports.RTP, exports.Bandwidth);
stanza.extend(exports.RTP, exports.PayloadType, 'payloads');
stanza.extend(exports.RTP, exports.Source, 'sources');
stanza.extend(exports.RTP, exports.SourceGroup, 'sourceGroups');

stanza.extend(jingle.Jingle, exports.Mute);
stanza.extend(jingle.Jingle, exports.Unmute);
stanza.extend(jingle.Jingle, exports.ContentGroup, 'groups');
stanza.add(jingle.Jingle, 'ringing', stanza.boolSub(INFONS, 'ringing'));
stanza.add(jingle.Jingle, 'hold', stanza.boolSub(INFONS, 'hold'));
stanza.add(jingle.Jingle, 'active', stanza.boolSub(INFONS, 'active'));

},{"./jingle":70,"jxt":210}],92:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');

var Message = _dereq_('./message');

var NS = 'urn:xmpp:rtt:0';

var typemap = {
    'insert': 't',
    'erase': 'e',
    'wait': 'w',
};

var actionmap = {
    't': 'insert',
    'e': 'erase',
    'w': 'wait'
};


var RTT = module.exports = stanza.define({
    name: 'rtt',
    namespace: NS,
    element: 'rtt',
    fields: {
        id: stanza.attribute('id'),
        event: stanza.attribute('event', 'edit'),
        seq: stanza.numberAttribute('seq'),
        actions: {
            get: function () {
                var results = [];
                for(var i = 0, len = this.xml.childNodes.length; i < len; i++) {
                    var child = this.xml.childNodes[i];
                    var name = child.localName;
                    var action = {};

                    if (child.namespaceURI !== NS) {
                        continue;
                    }

                    if (actionmap[name]) {
                        action.type = actionmap[name];
                    } else {
                        continue;
                    }

                    var pos = stanza.getAttribute(child, 'p');
                    if (pos) {
                        action.pos = parseInt(pos, 10);
                    }

                    var n = stanza.getAttribute(child, 'n');
                    if (n) {
                        action.num = parseInt(n, 10);
                    }

                    var t = stanza.getText(child);
                    if (t && name === 't') {
                        action.text = t;
                    }


                    results.push(action);
                }

                return results;
            },
            set: function (actions) {
                var self = this;

                for (var i = 0, len = this.xml.childNodes.length; i < len; i++) {
                    this.xml.removeChild(this.xml.childNodes[i]);
                }

                actions.forEach(function (action ) {
                    if (!typemap[action.type]) {
                        return;
                    }

                    var child = stanza.createElement(NS, typemap[action.type], NS);

                    if (action.pos !== undefined) {
                        stanza.setAttribute(child, 'p', action.pos.toString());
                    }

                    if (action.num) {
                        stanza.setAttribute(child, 'n', action.num.toString());
                    }

                    if (action.text) {
                        stanza.setText(child, action.text);
                    }

                    self.xml.appendChild(child);
                });
            }
        }
    }
});


stanza.extend(Message, RTT);

},{"./message":74,"jxt":210}],93:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var StreamFeatures = _dereq_('./streamFeatures');

var NS = 'urn:ietf:params:xml:ns:xmpp-sasl';
var CONDITIONS = [
    'aborted', 'account-disabled', 'credentials-expired',
    'encryption-required', 'incorrect-encoding', 'invalid-authzid',
    'invalid-mechanism', 'malformed-request', 'mechanism-too-weak',
    'not-authorized', 'temporary-auth-failure'
];

exports.Mechanisms = stanza.define({
    name: 'sasl',
    namespace: NS,
    element: 'mechanisms',
    fields: {
        mechanisms: stanza.multiSubText(NS, 'mechanism')
    }
});

exports.Auth = stanza.define({
    name: 'saslAuth',
    eventName: 'sasl:auth',
    namespace: NS,
    element: 'auth',
    topLevel: true,
    fields: {
        value: stanza.b64Text(),
        mechanism: stanza.attribute('mechanism')
    }
});

exports.Challenge = stanza.define({
    name: 'saslChallenge',
    eventName: 'sasl:challenge',
    namespace: NS,
    element: 'challenge',
    topLevel: true,
    fields: {
        value: stanza.b64Text()
    }
});

exports.Response = stanza.define({
    name: 'saslResponse',
    eventName: 'sasl:response',
    namespace: NS,
    element: 'response',
    topLevel: true,
    fields: {
        value: stanza.b64Text()
    }
});

exports.Abort = stanza.define({
    name: 'saslAbort',
    eventName: 'sasl:abort',
    namespace: NS,
    element: 'abort',
    topLevel: true
});

exports.Success = stanza.define({
    name: 'saslSuccess',
    eventName: 'sasl:success',
    namespace: NS,
    element: 'success',
    topLevel: true,
    fields: {
        value: stanza.b64Text()
    }
});

exports.Failure = stanza.define({
    name: 'saslFailure',
    eventName: 'sasl:failure',
    namespace: NS,
    element: 'failure',
    topLevel: true,
    fields: {
        lang: {
            get: function () {
                return this._lang || '';
            },
            set: function (value) {
                this._lang = value;
            }
        },
        condition: stanza.enumSub(NS, CONDITIONS),
        $text: {
            get: function () {
                return stanza.getSubLangText(this.xml, NS, 'text', this.lang);
            }
        },
        text: {
            get: function () {
                var text = this.$text;
                return text[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, NS, 'text', value, this.lang);
            }
        }
    }
});


stanza.extend(StreamFeatures, exports.Mechanisms);

},{"./streamFeatures":99,"jxt":210}],94:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var StreamFeatures = _dereq_('./streamFeatures');

var NS = 'urn:ietf:params:xml:ns:xmpp-session';

var Session = module.exports = stanza.define({
    name: 'session',
    namespace: NS,
    element: 'session',
    fields: {
        required: stanza.boolSub(NS, 'required'),
        optional: stanza.boolSub(NS, 'optional')
    }
});

stanza.extend(StreamFeatures, Session);
stanza.extend(Iq, Session);

},{"./iq":69,"./streamFeatures":99,"jxt":210}],95:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');


var NS = 'http://jabber.org/protocol/shim';


var SHIM = module.exports = {
    get: function () {
        var headerSet = stanza.find(this.xml, NS, 'headers');
        if (headerSet.length) {
            return stanza.getMultiSubText(headerSet[0], NS, 'header', function (header) {
                var name = stanza.getAttribute(header, 'name');
                if (name) {
                    return {
                        name: name,
                        value: stanza.getText(header)
                    };
                }
            });
        }
        return [];
    },
    set: function (values) {
        var headerSet = stanza.findOrCreate(this.xml, NS, 'headers');
        stanza.setMultiSubText(headerSet, NS, 'header', values, function (val) {
            var header = stanza.createElement(NS, 'header', NS);
            stanza.setAttribute(header, 'name', val.name);
            stanza.setText(header, val.value);
            headerSet.appendChild(header);
        });
    }
};


stanza.add(Message, 'headers', SHIM);
stanza.add(Presence, 'headers', SHIM);

},{"./message":74,"./presence":80,"jxt":210}],96:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var StreamFeatures = _dereq_('./streamFeatures');


var NS = 'urn:xmpp:sm:3';


exports.SMFeature = stanza.define({
    name: 'streamManagement',
    namespace: NS,
    element: 'sm'
});

exports.Enable = stanza.define({
    name: 'smEnable',
    eventName: 'stream:management:enable',
    namespace: NS,
    element: 'enable',
    topLevel: true,
    fields: {
        resume: stanza.boolAttribute('resume')
    }
});

exports.Enabled = stanza.define({
    name: 'smEnabled',
    eventName: 'stream:management:enabled',
    namespace: NS,
    element: 'enabled',
    topLevel: true,
    fields: {
        id: stanza.attribute('id'),
        resume: stanza.boolAttribute('resume')
    }
});

exports.Resume = stanza.define({
    name: 'smResume',
    eventName: 'stream:management:resume',
    namespace: NS,
    element: 'resume',
    topLevel: true,
    fields: {
        h: stanza.numberAttribute('h', false, 0),
        previd: stanza.attribute('previd')
    }
});

exports.Resumed = stanza.define({
    name: 'smResumed',
    eventName: 'stream:management:resumed',
    namespace: NS,
    element: 'resumed',
    topLevel: true,
    fields: {
        h: stanza.numberAttribute('h', false, 0),
        previd: stanza.attribute('previd')
    }
});

exports.Failed = stanza.define({
    name: 'smFailed',
    eventName: 'stream:management:failed',
    namespace: NS,
    element: 'failed',
    topLevel: true
});

exports.Ack = stanza.define({
    name: 'smAck',
    eventName: 'stream:management:ack',
    namespace: NS,
    element: 'a',
    topLevel: true,
    fields: {
        h: stanza.numberAttribute('h', false, 0)
    }
});

exports.Request = stanza.define({
    name: 'smRequest',
    eventName: 'stream:management:request',
    namespace: NS,
    element: 'r',
    topLevel: true
});


stanza.extend(StreamFeatures, exports.SMFeature);

},{"./streamFeatures":99,"jxt":210}],97:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');


module.exports = stanza.define({
    name: 'stream',
    namespace: 'http://etherx.jabber.org/streams',
    element: 'stream',
    fields: {
        lang: stanza.langAttribute(),
        id: stanza.attribute('id'),
        version: stanza.attribute('version', '1.0'),
        to: jxtutil.jidAttribute('to', true),
        from: jxtutil.jidAttribute('from', true)
    }
});

},{"jxt":210,"jxt-xmpp-types":209}],98:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');


var ERR_NS = 'urn:ietf:params:xml:ns:xmpp-streams';
var CONDITIONS = [
    'bad-format', 'bad-namespace-prefix', 'conflict',
    'connection-timeout', 'host-gone', 'host-unknown',
    'improper-addressing', 'internal-server-error', 'invalid-from',
    'invalid-namespace', 'invalid-xml', 'not-authorized',
    'not-well-formed', 'policy-violation', 'remote-connection-failed',
    'reset', 'resource-constraint', 'restricted-xml', 'see-other-host',
    'system-shutdown', 'undefined-condition', 'unsupported-encoding',
    'unsupported-feature', 'unsupported-stanza-type',
    'unsupported-version'
];

module.exports = stanza.define({
    name: 'streamError',
    namespace: 'http://etherx.jabber.org/streams',
    element: 'error',
    topLevel: true,
    fields: {
        lang: {
            get: function () {
                return this._lang || '';
            },
            set: function (value) {
                this._lang = value;
            }
        },
        condition: stanza.enumSub(ERR_NS, CONDITIONS),
        seeOtherHost: {
            get: function () {
                return stanza.getSubText(this.xml, ERR_NS, 'see-other-host');
            },
            set: function (value) {
                this.condition = 'see-other-host';
                stanza.setSubText(this.xml, ERR_NS, 'see-other-host', value);
            }
        },
        $text: {
            get: function () {
                return stanza.getSubLangText(this.xml, ERR_NS, 'text', this.lang);
            }
        },
        text: {
            get: function () {
                var text = this.$text;
                return text[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, ERR_NS, 'text', value, this.lang);
            }
        }
    }
});

},{"jxt":210}],99:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');


var StreamFeatures = module.exports = stanza.define({
    name: 'streamFeatures',
    namespace: 'http://etherx.jabber.org/streams',
    element: 'features',
    topLevel: true
});

var RosterVerFeature = stanza.define({
    name: 'rosterVersioning',
    namespace: 'urn:xmpp:features:rosterver',
    element: 'ver'
});

var SubscriptionPreApprovalFeature = stanza.define({
    name: 'subscriptionPreApproval',
    namespace: 'urn:xmpp:features:pre-approval',
    element: 'sub'
});


stanza.extend(StreamFeatures, RosterVerFeature);
stanza.extend(StreamFeatures, SubscriptionPreApprovalFeature);

},{"jxt":210}],100:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jxtutil = _dereq_('jxt-xmpp-types');
var Iq = _dereq_('./iq');


var EntityTime = module.exports = stanza.define({
    name: 'time',
    namespace: 'urn:xmpp:time',
    element: 'time',
    fields: {
        utc: stanza.dateSub('urn:xmpp:time', 'utc'),
        tzo: jxtutil.tzoSub('urn:xmpp:time', 'tzo', 0)
    }
});


stanza.extend(Iq, EntityTime);

},{"./iq":69,"jxt":210,"jxt-xmpp-types":209}],101:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var NS = 'vcard-temp';


var VCardTemp = module.exports = stanza.define({
    name: 'vCardTemp',
    namespace: NS,
    element: 'vCard',
    fields: {
        role: stanza.subText(NS, 'ROLE'),
        website: stanza.subText(NS, 'URL'),
        title: stanza.subText(NS, 'TITLE'),
        description: stanza.subText(NS, 'DESC'),
        fullName: stanza.subText(NS, 'FN'),
        birthday: stanza.dateSub(NS, 'BDAY'),
        nicknames: stanza.multiSubText(NS, 'NICKNAME'),
        jids: stanza.multiSubText(NS, 'JABBERID')
    }
});

var Email = stanza.define({
    name: '_email',
    namespace: NS,
    element: 'EMAIL',
    fields: {
        email: stanza.subText(NS, 'USERID'),
        home: stanza.boolSub(NS, 'HOME'),
        work: stanza.boolSub(NS, 'WORK'),
        preferred: stanza.boolSub(NS, 'PREF')
    }
});

var PhoneNumber = stanza.define({
    name: '_tel',
    namespace: NS,
    element: 'TEL',
    fields: {
        number: stanza.subText(NS, 'NUMBER'),
        home: stanza.boolSub(NS, 'HOME'),
        work: stanza.boolSub(NS, 'WORK'),
        mobile: stanza.boolSub(NS, 'CELL'),
        preferred: stanza.boolSub(NS, 'PREF')
    }
});

var Address = stanza.define({
    name: '_address',
    namespace: NS,
    element: 'ADR',
    fields: {
        street: stanza.subText(NS, 'STREET'),
        street2: stanza.subText(NS, 'EXTADD'),
        country: stanza.subText(NS, 'CTRY'),
        city: stanza.subText(NS, 'LOCALITY'),
        region: stanza.subText(NS, 'REGION'),
        postalCode: stanza.subText(NS, 'PCODE'),
        pobox: stanza.subText(NS, 'POBOX'),
        home: stanza.boolSub(NS, 'HOME'),
        work: stanza.boolSub(NS, 'WORK'),
        preferred: stanza.boolSub(NS, 'PREF')
    }
});

var Organization = stanza.define({
    name: 'organization',
    namespace: NS,
    element: 'ORG',
    fields: {
        name: stanza.subText(NS, 'ORGNAME'),
        unit: stanza.subText(NS, 'ORGUNIT')
    }
});

var Name = stanza.define({
    name: 'name',
    namespace: NS,
    element: 'N',
    fields: {
        family: stanza.subText(NS, 'FAMILY'),
        given: stanza.subText(NS, 'GIVEN'),
        middle: stanza.subText(NS, 'MIDDLE'),
        prefix: stanza.subText(NS, 'PREFIX'),
        suffix: stanza.subText(NS, 'SUFFIX')
    }
});

var Photo = stanza.define({
    name: 'photo',
    namespace: NS,
    element: 'PHOTO',
    fields: {
        type: stanza.subText(NS, 'TYPE'),
        data: stanza.subText(NS, 'BINVAL'),
        url: stanza.subText(NS, 'EXTVAL')
    }
});


stanza.extend(VCardTemp, Email, 'emails');
stanza.extend(VCardTemp, Address, 'addresses');
stanza.extend(VCardTemp, PhoneNumber, 'phoneNumbers');
stanza.extend(VCardTemp, Organization);
stanza.extend(VCardTemp, Name);
stanza.extend(VCardTemp, Photo);
stanza.extend(Iq, VCardTemp);

},{"./iq":69,"jxt":210}],102:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');

var NS = 'jabber:iq:version';

var Version = module.exports = stanza.define({
    name: 'version',
    namespace: NS,
    element: 'query',
    fields: {
        name: stanza.subText(NS, 'name'),
        version: stanza.subText(NS, 'version'),
        os: stanza.subText(NS, 'os')
    }
});

stanza.extend(Iq, Version);

},{"./iq":69,"jxt":210}],103:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');


stanza.add(Iq, 'visible', stanza.boolSub('urn:xmpp:invisible:0', 'visible'));
stanza.add(Iq, 'invisible', stanza.boolSub('urn:xmpp:invisible:0', 'invisible'));

},{"./iq":69,"jxt":210}],104:[function(_dereq_,module,exports){
(function (process,Buffer){
'use strict';

var _ = _dereq_('underscore');
var util = _dereq_('util');
var BPromise = _dereq_('bluebird');
var request = BPromise.promisify(_dereq_('request'));

var WildEmitter = _dereq_('wildemitter');
var stanza = _dereq_('jxt');
var BOSH = _dereq_('../stanza/bosh');
var StreamError = _dereq_('../stanza/streamError');


function ConnectionError() {}
util.inherits(ConnectionError, Error);


function retryRequest(opts, timeout, allowedRetries, retries) {
    retries = retries || 0;

    var req = request(opts).cancellable().timeout((timeout || 20) * 1000);

    return req.spread(function (req, body) {
        if (req.statusCode < 200 || req.statusCode >= 400) {
            throw new ConnectionError('HTTP Status Error');
        }
        return body;
    }).catch(BPromise.TimeoutError, function () {
        throw new ConnectionError('Dead Connection, exceeded timeout limit');
    }).catch(BPromise.CancellationError, function () {
        return; // We only cancel on manual disconnect, so let things die silently
    }).catch(function () {
        if (retries < allowedRetries) {
            return BPromise.delay(100).then(function () {
                return retryRequest(opts, timeout, allowedRetries, retries + 1);
            });
        } else {
            throw new ConnectionError('Dead Connection, exceeded retry limit');
        }
    });
}


function BOSHConnection(sm) {
    var self = this;

    WildEmitter.call(this);

    self.sm = sm;

    self.sendQueue = [];
    self.requests = [];
    self.maxRequests = 2;
    self.sid = '';

    self.on('raw:incoming', function (data) {
        data = data.trim();
        if (data === '') {
            return;
        }

        var bosh, err;

        try {
            bosh = stanza.parse(data, BOSH);
        } catch (e) {
            err = new StreamError({
                condition: 'invalid-xml'
            });
            self.emit('stream:error', err, e);
            self.send(err);
            return self.disconnect();
        }

        if (!self.hasStream) {
            self.hasStream = true;
            self.stream = {
                id: bosh.sid,
                lang: bosh.lang || 'en',
                version: bosh.version || '1.0',
                to: bosh.to,
                from: bosh.from
            };
            self.sid = bosh.sid;
            self.maxRequests = bosh.requests;
        }

        var payload = bosh.payload;
        payload.forEach(function (stanzaObj) {
            if (!stanzaObj.lang) {
                stanzaObj.lang = self.stream.lang;
            }

            self.emit('stream:data', stanzaObj);
        });

        if (bosh.type === 'terminate') {
            self.rid = undefined;
            self.sid = undefined;
            self.emit('bosh:terminate', bosh);
            self.emit('stream:end');
            self.emit('disconnected', self);
        }
    });
}

util.inherits(BOSHConnection, WildEmitter);

BOSHConnection.prototype.connect = function (opts) {
    var self = this;

    self.config = _.extend({
        rid: Math.ceil(Math.random() * 9999999999),
        wait: 30,
        maxRetries: 5
    }, opts);

    self.hasStream = false;
    self.sm.started = false;
    self.url = opts.boshURL;

    self.rid = self.config.rid;

    self.requests = [];

    self.rid++;
    self.request(new BOSH({
        version: self.config.version || '1.0',
        to: self.config.server,
        lang: self.config.lang || 'en',
        wait: self.config.wait,
        ver: '1.6',
        hold: 1
    }));
};

BOSHConnection.prototype.disconnect = function () {
    if (this.hasStream) {
        this.rid++;
        this.request(new BOSH({
            type: 'terminate'
        }));
    } else {
        this.requests.forEach(function (ticket) {
            ticket.request.cancel();
        });
        this.stream = undefined;
        this.sid = undefined;
        this.rid = undefined;
        this.emit('disconnected', this);
    }
};

BOSHConnection.prototype.restart = function () {
    var self = this;
    self.rid++;
    self.request(new BOSH({
        to: self.config.server,
        lang: self.config.lang || 'en',
        restart: 'true'
    }));
};

BOSHConnection.prototype.send = function (data) {
    var self = this;
    if (self.hasStream) {
        self.sendQueue.push(data);
        process.nextTick(self.longPoll.bind(self));
    }
};

BOSHConnection.prototype.longPoll = function () {
    var canReceive = this.requests.length === 0;
    var canSend = this.sendQueue.length > 0 && this.requests.length < this.maxRequests;

    if (!this.sid || (!canReceive && !canSend)) {
        return;
    }

    var stanzas = this.sendQueue;
    this.sendQueue = [];
    this.rid++;

    this.request(new BOSH({
        payload: stanzas
    }));
};

BOSHConnection.prototype.request = function (bosh) {
    var self = this;

    var ticket = {id: self.rid, request: null};
    bosh.rid = self.rid;
    bosh.sid = self.sid;

    var body = new Buffer(bosh.toString(), 'utf8').toString();

    self.emit('raw:outgoing', body);

    self.requests.push(ticket);

    var req = retryRequest({
        uri: self.url,
        body: body,
        method: 'POST',
        strictSSL: true
    }, self.config.wait * 1.5, this.config.maxRetries);

    ticket.request = req;

    return req.then(function (body) {
        self.emit('raw:incoming', new Buffer(body, 'utf8').toString());
    }).catch(ConnectionError, function (err) {
        self.hasStream = false;
        var serr = new StreamError({
            condition: 'connection-timeout'
        });
        self.emit('stream:error', serr, err);
        self.disconnect();
    }).catch(function (err) {
        var serr = new StreamError({
            condition: 'undefined-condition'
        });
        self.emit('stream:error', serr, err);
        self.send(serr);
        self.disconnect();
    }).finally(function () {
        self.requests = _.filter(self.requests, function (item) {
            return item.id !== ticket.id;
        });
        if (bosh.type !== 'terminate') {
            // Delay next auto-request by two ticks since we're likely
            // to send data anyway next tick.
            process.nextTick(function () {
                process.nextTick(self.longPoll.bind(self));
            });
        }
    });
};

module.exports = BOSHConnection;

}).call(this,_dereq_("FWaASH"),_dereq_("buffer").Buffer)
},{"../stanza/bosh":52,"../stanza/streamError":98,"FWaASH":166,"bluebird":112,"buffer":147,"jxt":210,"request":145,"underscore":234,"util":169,"wildemitter":235}],105:[function(_dereq_,module,exports){
'use strict';

var WSConnection = _dereq_('./websocket');
var _ = _dereq_('underscore');
var util = _dereq_('util');
var stanza = _dereq_('jxt');
var Stream = _dereq_('../stanza/stream');
var StreamError = _dereq_('../stanza/streamError');



function OldWSConnection(sm) {
    WSConnection.call(this, sm);

    var self = this;


    function wrap(data) {
        return [self.streamStart, data, self.streamEnd].join('');
    }


    self.on('connected', function () {
        self.streamStart = '<stream:stream xmlns:stream="http://etherx.jabber.org/streams">';
        self.streamEnd = '</stream:stream>';
    });

    self.off('raw:incoming');
    self.on('raw:incoming', function (data) {
        var streamData, ended, err;

        data = data.trim();
        data = data.replace(/^(\s*<\?.*\?>\s*)*/, '');
        if (data === '') {
            return;
        }

        if (data.match(self.streamEnd)) {
            return self.disconnect();
        } else if (self.hasStream) {
            try {
                streamData = stanza.parse(wrap(data), Stream);
            } catch (e) {
                err = new StreamError({
                    condition: 'invalid-xml'
                });
                self.emit('stream:error', err, e);
                self.send(err);
                return self.disconnect();
            }
        } else {
            // Inspect start of stream element to get NS prefix name
            var parts = data.match(/^<(\S+:)?(\S+) /);
            self.streamStart = data;
            self.streamEnd = '</' + (parts[1] || '') + parts[2] + '>';

            ended = false;
            try {
                streamData = stanza.parse(data + self.streamEnd, Stream);
            } catch (e) {
                try {
                    streamData = stanza.parse(data, Stream);
                    ended = true;
                } catch (e2) {
                    err = new StreamError({
                        condition: 'invalid-xml'
                    });
                    self.emit('stream:error', err, e2);
                    self.send(err);
                    return self.disconnect();
                }
            }

            self.hasStream = true;
            self.stream = streamData;
            self.emit('stream:start', streamData);
        }

        _.each(streamData._extensions, function (stanzaObj) {
            if (!stanzaObj.lang) {
                stanzaObj.lang = self.stream.lang;
            }

            self.emit('stream:data', stanzaObj);
        });

        if (ended) {
            self.emit('stream:end');
        }
    });
}

util.inherits(OldWSConnection, WSConnection);


OldWSConnection.prototype.startHeader = function () {
    return [
        '<stream:stream',
        'xmlns:stream="http://etherx.jabber.org/streams"',
        'xmlns="jabber:client"',
        'version="' + (this.config.version || '1.0') + '"',
        'xml:lang="' + (this.config.lang || 'en') + '"',
        'to="' + this.config.server + '">'
    ].join(' ');
};

OldWSConnection.prototype.closeHeader = function () {
    return '</stream:stream>';
};


module.exports = OldWSConnection;

},{"../stanza/stream":97,"../stanza/streamError":98,"./websocket":106,"jxt":210,"underscore":234,"util":169}],106:[function(_dereq_,module,exports){
(function (Buffer){
'use strict';

var util = _dereq_('util');
var stanza = _dereq_('jxt');
var WildEmitter = _dereq_('wildemitter');
var async = _dereq_('async');
var framing = _dereq_('../stanza/framing');
var StreamError = _dereq_('../stanza/streamError');

var WS = (_dereq_('faye-websocket') && _dereq_('faye-websocket').Client) ?
                                       _dereq_('faye-websocket').Client :
                                       window.WebSocket;

var WS_OPEN = 1;



function WSConnection(sm) {
    var self = this;

    WildEmitter.call(this);

    self.sm = sm;
    self.closing = false;

    self.sendQueue = async.queue(function (data, cb) {
        if (self.conn) {
            if (typeof data !== 'string') {
                data = data.toString();
            }

            data = new Buffer(data, 'utf8').toString();

            self.emit('raw:outgoing', data);
            if (self.conn.readyState === WS_OPEN) {
                self.conn.send(data);
            }
        }
        cb();
    }, 1);

    self.on('connected', function () {
        self.send(self.startHeader());
    });

    self.on('raw:incoming', function (data) {
        var stanzaObj, err;

        data = data.trim();
        if (data === '') {
            return;
        }

        try {
            stanzaObj = stanza.parse(data);
        } catch (e) {
            err = new StreamError({
                condition: 'invalid-xml'
            });
            self.emit('stream:error', err, e);
            self.send(err);
            return self.disconnect();
        }

        if (stanzaObj._name === 'openStream') {
            self.hasStream = true;
            self.stream = stanzaObj;
            return self.emit('stream:start', stanzaObj.toJSON());
        }
        if (stanzaObj._name === 'closeStream') {
            self.emit('stream:end');
            return self.disconnect();
        }

        if (!stanzaObj.lang) {
            stanzaObj.lang = self.stream.lang;
        }

        self.emit('stream:data', stanzaObj);
    });
}

util.inherits(WSConnection, WildEmitter);

WSConnection.prototype.connect = function (opts) {
    var self = this;

    self.config = opts;

    self.hasStream = false;
    self.closing = false;

    self.conn = new WS(opts.wsURL, 'xmpp');
    self.conn.onerror = function (e) {
        e.preventDefault();
        self.emit('disconnected', self);
    };

    self.conn.onclose = function () {
        self.emit('disconnected', self);
    };

    self.conn.onopen = function () {
        self.sm.started = false;
        self.emit('connected', self);
    };

    self.conn.onmessage = function (wsMsg) {
        self.emit('raw:incoming', new Buffer(wsMsg.data, 'utf8').toString());
    };
};

WSConnection.prototype.startHeader = function () {
    return new framing.Open({
        version: this.config.version || '1.0',
        lang: this.config.lang || 'en',
        to: this.config.server
    });
};

WSConnection.prototype.closeHeader = function () {
    return new framing.Close();
};

WSConnection.prototype.disconnect = function () {
    if (this.conn && !this.closing) {
        this.closing = true;
        this.send(this.closeHeader());
    } else {
        this.hasStream = false;
        this.stream = undefined;
        if (this.conn.readyState === WS_OPEN) {
            this.conn.close();
        }
        this.conn = undefined;
    }
};

WSConnection.prototype.restart = function () {
    var self = this;
    self.hasStream = false;
    self.send(this.startHeader());
};

WSConnection.prototype.send = function (data) {
    this.sendQueue.push(data);
};


module.exports = WSConnection;

}).call(this,_dereq_("buffer").Buffer)
},{"../stanza/framing":64,"../stanza/streamError":98,"async":108,"buffer":147,"faye-websocket":146,"jxt":210,"util":169,"wildemitter":235}],107:[function(_dereq_,module,exports){
var crypto = _dereq_('crypto');


function parse(chal) {
    var dtives = {};
    var tokens = chal.split(/,(?=(?:[^"]|"[^"]*")*$)/);
    for (var i = 0, len = tokens.length; i < len; i++) {
        var dtiv = /(\w+)=["]?([^"]+)["]?$/.exec(tokens[i]);
        if (dtiv) {
            dtives[dtiv[1]] = dtiv[2];
        }
    }
    return dtives;
}

function genNonce() {
    return crypto.randomBytes(16).toString('hex');
}



function Mechanism(options) {
    options = options || {};
    this._genNonce = options.genNonce || genNonce;
}

// Conform to the SASL lib's expectations
Mechanism.Mechanism = Mechanism;


Mechanism.prototype.name = 'DIGEST-MD5';
Mechanism.prototype.clientFirst = false;


Mechanism.prototype.response = function(cred) {
    if (this._completed) {
        return undefined;
    }

    var uri = cred.serviceType + '/' + cred.host;

    if (cred.serviceName && cred.host !== cred.serviceName) {
        uri += '/' + cred.serviceName;
    }

    var realm = cred.realm || this._realm || '';
    var cnonce = this._genNonce();
    var nc = '00000001';
    var qop = 'auth';

    var str = '';
    str += 'username="' + cred.username + '"';
    if (realm) {
        str += ',realm="' + realm + '"';
    }
    str += ',nonce="' + this._nonce + '"';
    str += ',cnonce="' + cnonce + '"';
    str += ',nc=' + nc;
    str += ',qop=' + qop;
    str += ',digest-uri="' + uri + '"';
  
    var base = crypto.createHash('md5').update(cred.username)
                                       .update(':')
                                       .update(realm)
                                       .update(':')
                                       .update(cred.password)
                                       .digest();

    var ha1 = crypto.createHash('md5').update(base)
                                      .update(':')
                                      .update(this._nonce)
                                      .update(':')
                                      .update(cnonce);


    if (cred.authzid) {
        ha1.update(':').update(cred.authzid);
    }

    ha1 = ha1.digest('hex');
  
    var ha2 = crypto.createHash('md5').update('AUTHENTICATE:')
                                      .update(uri);
    
    if (qop === 'auth-int' || qop === 'auth-conf') {
        ha2.update(':00000000000000000000000000000000');
    }

    ha2 = ha2.digest('hex');
  
    var digest = crypto.createHash('md5').update(ha1)
                                         .update(':')
                                         .update(this._nonce)
                                         .update(':')
                                         .update(nc)
                                         .update(':')
                                         .update(cnonce)
                                         .update(':')
                                         .update(qop)
                                         .update(':')
                                         .update(ha2)
                                         .digest('hex');

    str += ',response=' + digest;
  
    if (this._charset === 'utf-8') {
        str += ',charset=utf-8';
    }
    if (cred.authzid) {
        str += 'authzid="' + cred.authzid + '"';
    }
  
    return str;
};

Mechanism.prototype.challenge = function(chal) {
    var dtives = parse(chal);

    this._completed = !!dtives.rspauth;

    this._realm = dtives.realm;
    this._nonce = dtives.nonce;
    this._qop = (dtives.qop || 'auth').split(',');
    this._stale = dtives.stale;
    this._maxbuf = parseInt(dtives.maxbuf) || 65536;
    this._charset = dtives.charset;
    this._algo = dtives.algorithm;
    this._cipher = dtives.cipher;
    if (this._cipher) {
        this._cipher.split(',');
    }

    return this;
};



module.exports = Mechanism;

},{"crypto":154}],108:[function(_dereq_,module,exports){
(function (process){
/*!
 * async
 * https://github.com/caolan/async
 *
 * Copyright 2010-2014 Caolan McMahon
 * Released under the MIT license
 */
/*jshint onevar: false, indent:4 */
/*global setImmediate: false, setTimeout: false, console: false */
(function () {

    var async = {};

    // global on the server, window in the browser
    var root, previous_async;

    root = this;
    if (root != null) {
      previous_async = root.async;
    }

    async.noConflict = function () {
        root.async = previous_async;
        return async;
    };

    function only_once(fn) {
        var called = false;
        return function() {
            if (called) throw new Error("Callback was already called.");
            called = true;
            fn.apply(root, arguments);
        }
    }

    //// cross-browser compatiblity functions ////

    var _toString = Object.prototype.toString;

    var _isArray = Array.isArray || function (obj) {
        return _toString.call(obj) === '[object Array]';
    };

    var _each = function (arr, iterator) {
        if (arr.forEach) {
            return arr.forEach(iterator);
        }
        for (var i = 0; i < arr.length; i += 1) {
            iterator(arr[i], i, arr);
        }
    };

    var _map = function (arr, iterator) {
        if (arr.map) {
            return arr.map(iterator);
        }
        var results = [];
        _each(arr, function (x, i, a) {
            results.push(iterator(x, i, a));
        });
        return results;
    };

    var _reduce = function (arr, iterator, memo) {
        if (arr.reduce) {
            return arr.reduce(iterator, memo);
        }
        _each(arr, function (x, i, a) {
            memo = iterator(memo, x, i, a);
        });
        return memo;
    };

    var _keys = function (obj) {
        if (Object.keys) {
            return Object.keys(obj);
        }
        var keys = [];
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) {
                keys.push(k);
            }
        }
        return keys;
    };

    //// exported async module functions ////

    //// nextTick implementation with browser-compatible fallback ////
    if (typeof process === 'undefined' || !(process.nextTick)) {
        if (typeof setImmediate === 'function') {
            async.nextTick = function (fn) {
                // not a direct alias for IE10 compatibility
                setImmediate(fn);
            };
            async.setImmediate = async.nextTick;
        }
        else {
            async.nextTick = function (fn) {
                setTimeout(fn, 0);
            };
            async.setImmediate = async.nextTick;
        }
    }
    else {
        async.nextTick = process.nextTick;
        if (typeof setImmediate !== 'undefined') {
            async.setImmediate = function (fn) {
              // not a direct alias for IE10 compatibility
              setImmediate(fn);
            };
        }
        else {
            async.setImmediate = async.nextTick;
        }
    }

    async.each = function (arr, iterator, callback) {
        callback = callback || function () {};
        if (!arr.length) {
            return callback();
        }
        var completed = 0;
        _each(arr, function (x) {
            iterator(x, only_once(done) );
        });
        function done(err) {
          if (err) {
              callback(err);
              callback = function () {};
          }
          else {
              completed += 1;
              if (completed >= arr.length) {
                  callback();
              }
          }
        }
    };
    async.forEach = async.each;

    async.eachSeries = function (arr, iterator, callback) {
        callback = callback || function () {};
        if (!arr.length) {
            return callback();
        }
        var completed = 0;
        var iterate = function () {
            iterator(arr[completed], function (err) {
                if (err) {
                    callback(err);
                    callback = function () {};
                }
                else {
                    completed += 1;
                    if (completed >= arr.length) {
                        callback();
                    }
                    else {
                        iterate();
                    }
                }
            });
        };
        iterate();
    };
    async.forEachSeries = async.eachSeries;

    async.eachLimit = function (arr, limit, iterator, callback) {
        var fn = _eachLimit(limit);
        fn.apply(null, [arr, iterator, callback]);
    };
    async.forEachLimit = async.eachLimit;

    var _eachLimit = function (limit) {

        return function (arr, iterator, callback) {
            callback = callback || function () {};
            if (!arr.length || limit <= 0) {
                return callback();
            }
            var completed = 0;
            var started = 0;
            var running = 0;

            (function replenish () {
                if (completed >= arr.length) {
                    return callback();
                }

                while (running < limit && started < arr.length) {
                    started += 1;
                    running += 1;
                    iterator(arr[started - 1], function (err) {
                        if (err) {
                            callback(err);
                            callback = function () {};
                        }
                        else {
                            completed += 1;
                            running -= 1;
                            if (completed >= arr.length) {
                                callback();
                            }
                            else {
                                replenish();
                            }
                        }
                    });
                }
            })();
        };
    };


    var doParallel = function (fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [async.each].concat(args));
        };
    };
    var doParallelLimit = function(limit, fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [_eachLimit(limit)].concat(args));
        };
    };
    var doSeries = function (fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [async.eachSeries].concat(args));
        };
    };


    var _asyncMap = function (eachfn, arr, iterator, callback) {
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        if (!callback) {
            eachfn(arr, function (x, callback) {
                iterator(x.value, function (err) {
                    callback(err);
                });
            });
        } else {
            var results = [];
            eachfn(arr, function (x, callback) {
                iterator(x.value, function (err, v) {
                    results[x.index] = v;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };
    async.map = doParallel(_asyncMap);
    async.mapSeries = doSeries(_asyncMap);
    async.mapLimit = function (arr, limit, iterator, callback) {
        return _mapLimit(limit)(arr, iterator, callback);
    };

    var _mapLimit = function(limit) {
        return doParallelLimit(limit, _asyncMap);
    };

    // reduce only has a series version, as doing reduce in parallel won't
    // work in many situations.
    async.reduce = function (arr, memo, iterator, callback) {
        async.eachSeries(arr, function (x, callback) {
            iterator(memo, x, function (err, v) {
                memo = v;
                callback(err);
            });
        }, function (err) {
            callback(err, memo);
        });
    };
    // inject alias
    async.inject = async.reduce;
    // foldl alias
    async.foldl = async.reduce;

    async.reduceRight = function (arr, memo, iterator, callback) {
        var reversed = _map(arr, function (x) {
            return x;
        }).reverse();
        async.reduce(reversed, memo, iterator, callback);
    };
    // foldr alias
    async.foldr = async.reduceRight;

    var _filter = function (eachfn, arr, iterator, callback) {
        var results = [];
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        eachfn(arr, function (x, callback) {
            iterator(x.value, function (v) {
                if (v) {
                    results.push(x);
                }
                callback();
            });
        }, function (err) {
            callback(_map(results.sort(function (a, b) {
                return a.index - b.index;
            }), function (x) {
                return x.value;
            }));
        });
    };
    async.filter = doParallel(_filter);
    async.filterSeries = doSeries(_filter);
    // select alias
    async.select = async.filter;
    async.selectSeries = async.filterSeries;

    var _reject = function (eachfn, arr, iterator, callback) {
        var results = [];
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        eachfn(arr, function (x, callback) {
            iterator(x.value, function (v) {
                if (!v) {
                    results.push(x);
                }
                callback();
            });
        }, function (err) {
            callback(_map(results.sort(function (a, b) {
                return a.index - b.index;
            }), function (x) {
                return x.value;
            }));
        });
    };
    async.reject = doParallel(_reject);
    async.rejectSeries = doSeries(_reject);

    var _detect = function (eachfn, arr, iterator, main_callback) {
        eachfn(arr, function (x, callback) {
            iterator(x, function (result) {
                if (result) {
                    main_callback(x);
                    main_callback = function () {};
                }
                else {
                    callback();
                }
            });
        }, function (err) {
            main_callback();
        });
    };
    async.detect = doParallel(_detect);
    async.detectSeries = doSeries(_detect);

    async.some = function (arr, iterator, main_callback) {
        async.each(arr, function (x, callback) {
            iterator(x, function (v) {
                if (v) {
                    main_callback(true);
                    main_callback = function () {};
                }
                callback();
            });
        }, function (err) {
            main_callback(false);
        });
    };
    // any alias
    async.any = async.some;

    async.every = function (arr, iterator, main_callback) {
        async.each(arr, function (x, callback) {
            iterator(x, function (v) {
                if (!v) {
                    main_callback(false);
                    main_callback = function () {};
                }
                callback();
            });
        }, function (err) {
            main_callback(true);
        });
    };
    // all alias
    async.all = async.every;

    async.sortBy = function (arr, iterator, callback) {
        async.map(arr, function (x, callback) {
            iterator(x, function (err, criteria) {
                if (err) {
                    callback(err);
                }
                else {
                    callback(null, {value: x, criteria: criteria});
                }
            });
        }, function (err, results) {
            if (err) {
                return callback(err);
            }
            else {
                var fn = function (left, right) {
                    var a = left.criteria, b = right.criteria;
                    return a < b ? -1 : a > b ? 1 : 0;
                };
                callback(null, _map(results.sort(fn), function (x) {
                    return x.value;
                }));
            }
        });
    };

    async.auto = function (tasks, callback) {
        callback = callback || function () {};
        var keys = _keys(tasks);
        var remainingTasks = keys.length
        if (!remainingTasks) {
            return callback();
        }

        var results = {};

        var listeners = [];
        var addListener = function (fn) {
            listeners.unshift(fn);
        };
        var removeListener = function (fn) {
            for (var i = 0; i < listeners.length; i += 1) {
                if (listeners[i] === fn) {
                    listeners.splice(i, 1);
                    return;
                }
            }
        };
        var taskComplete = function () {
            remainingTasks--
            _each(listeners.slice(0), function (fn) {
                fn();
            });
        };

        addListener(function () {
            if (!remainingTasks) {
                var theCallback = callback;
                // prevent final callback from calling itself if it errors
                callback = function () {};

                theCallback(null, results);
            }
        });

        _each(keys, function (k) {
            var task = _isArray(tasks[k]) ? tasks[k]: [tasks[k]];
            var taskCallback = function (err) {
                var args = Array.prototype.slice.call(arguments, 1);
                if (args.length <= 1) {
                    args = args[0];
                }
                if (err) {
                    var safeResults = {};
                    _each(_keys(results), function(rkey) {
                        safeResults[rkey] = results[rkey];
                    });
                    safeResults[k] = args;
                    callback(err, safeResults);
                    // stop subsequent errors hitting callback multiple times
                    callback = function () {};
                }
                else {
                    results[k] = args;
                    async.setImmediate(taskComplete);
                }
            };
            var requires = task.slice(0, Math.abs(task.length - 1)) || [];
            var ready = function () {
                return _reduce(requires, function (a, x) {
                    return (a && results.hasOwnProperty(x));
                }, true) && !results.hasOwnProperty(k);
            };
            if (ready()) {
                task[task.length - 1](taskCallback, results);
            }
            else {
                var listener = function () {
                    if (ready()) {
                        removeListener(listener);
                        task[task.length - 1](taskCallback, results);
                    }
                };
                addListener(listener);
            }
        });
    };

    async.retry = function(times, task, callback) {
        var DEFAULT_TIMES = 5;
        var attempts = [];
        // Use defaults if times not passed
        if (typeof times === 'function') {
            callback = task;
            task = times;
            times = DEFAULT_TIMES;
        }
        // Make sure times is a number
        times = parseInt(times, 10) || DEFAULT_TIMES;
        var wrappedTask = function(wrappedCallback, wrappedResults) {
            var retryAttempt = function(task, finalAttempt) {
                return function(seriesCallback) {
                    task(function(err, result){
                        seriesCallback(!err || finalAttempt, {err: err, result: result});
                    }, wrappedResults);
                };
            };
            while (times) {
                attempts.push(retryAttempt(task, !(times-=1)));
            }
            async.series(attempts, function(done, data){
                data = data[data.length - 1];
                (wrappedCallback || callback)(data.err, data.result);
            });
        }
        // If a callback is passed, run this as a controll flow
        return callback ? wrappedTask() : wrappedTask
    };

    async.waterfall = function (tasks, callback) {
        callback = callback || function () {};
        if (!_isArray(tasks)) {
          var err = new Error('First argument to waterfall must be an array of functions');
          return callback(err);
        }
        if (!tasks.length) {
            return callback();
        }
        var wrapIterator = function (iterator) {
            return function (err) {
                if (err) {
                    callback.apply(null, arguments);
                    callback = function () {};
                }
                else {
                    var args = Array.prototype.slice.call(arguments, 1);
                    var next = iterator.next();
                    if (next) {
                        args.push(wrapIterator(next));
                    }
                    else {
                        args.push(callback);
                    }
                    async.setImmediate(function () {
                        iterator.apply(null, args);
                    });
                }
            };
        };
        wrapIterator(async.iterator(tasks))();
    };

    var _parallel = function(eachfn, tasks, callback) {
        callback = callback || function () {};
        if (_isArray(tasks)) {
            eachfn.map(tasks, function (fn, callback) {
                if (fn) {
                    fn(function (err) {
                        var args = Array.prototype.slice.call(arguments, 1);
                        if (args.length <= 1) {
                            args = args[0];
                        }
                        callback.call(null, err, args);
                    });
                }
            }, callback);
        }
        else {
            var results = {};
            eachfn.each(_keys(tasks), function (k, callback) {
                tasks[k](function (err) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    if (args.length <= 1) {
                        args = args[0];
                    }
                    results[k] = args;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };

    async.parallel = function (tasks, callback) {
        _parallel({ map: async.map, each: async.each }, tasks, callback);
    };

    async.parallelLimit = function(tasks, limit, callback) {
        _parallel({ map: _mapLimit(limit), each: _eachLimit(limit) }, tasks, callback);
    };

    async.series = function (tasks, callback) {
        callback = callback || function () {};
        if (_isArray(tasks)) {
            async.mapSeries(tasks, function (fn, callback) {
                if (fn) {
                    fn(function (err) {
                        var args = Array.prototype.slice.call(arguments, 1);
                        if (args.length <= 1) {
                            args = args[0];
                        }
                        callback.call(null, err, args);
                    });
                }
            }, callback);
        }
        else {
            var results = {};
            async.eachSeries(_keys(tasks), function (k, callback) {
                tasks[k](function (err) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    if (args.length <= 1) {
                        args = args[0];
                    }
                    results[k] = args;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };

    async.iterator = function (tasks) {
        var makeCallback = function (index) {
            var fn = function () {
                if (tasks.length) {
                    tasks[index].apply(null, arguments);
                }
                return fn.next();
            };
            fn.next = function () {
                return (index < tasks.length - 1) ? makeCallback(index + 1): null;
            };
            return fn;
        };
        return makeCallback(0);
    };

    async.apply = function (fn) {
        var args = Array.prototype.slice.call(arguments, 1);
        return function () {
            return fn.apply(
                null, args.concat(Array.prototype.slice.call(arguments))
            );
        };
    };

    var _concat = function (eachfn, arr, fn, callback) {
        var r = [];
        eachfn(arr, function (x, cb) {
            fn(x, function (err, y) {
                r = r.concat(y || []);
                cb(err);
            });
        }, function (err) {
            callback(err, r);
        });
    };
    async.concat = doParallel(_concat);
    async.concatSeries = doSeries(_concat);

    async.whilst = function (test, iterator, callback) {
        if (test()) {
            iterator(function (err) {
                if (err) {
                    return callback(err);
                }
                async.whilst(test, iterator, callback);
            });
        }
        else {
            callback();
        }
    };

    async.doWhilst = function (iterator, test, callback) {
        iterator(function (err) {
            if (err) {
                return callback(err);
            }
            var args = Array.prototype.slice.call(arguments, 1);
            if (test.apply(null, args)) {
                async.doWhilst(iterator, test, callback);
            }
            else {
                callback();
            }
        });
    };

    async.until = function (test, iterator, callback) {
        if (!test()) {
            iterator(function (err) {
                if (err) {
                    return callback(err);
                }
                async.until(test, iterator, callback);
            });
        }
        else {
            callback();
        }
    };

    async.doUntil = function (iterator, test, callback) {
        iterator(function (err) {
            if (err) {
                return callback(err);
            }
            var args = Array.prototype.slice.call(arguments, 1);
            if (!test.apply(null, args)) {
                async.doUntil(iterator, test, callback);
            }
            else {
                callback();
            }
        });
    };

    async.queue = function (worker, concurrency) {
        if (concurrency === undefined) {
            concurrency = 1;
        }
        function _insert(q, data, pos, callback) {
          if (!q.started){
            q.started = true;
          }
          if (!_isArray(data)) {
              data = [data];
          }
          if(data.length == 0) {
             // call drain immediately if there are no tasks
             return async.setImmediate(function() {
                 if (q.drain) {
                     q.drain();
                 }
             });
          }
          _each(data, function(task) {
              var item = {
                  data: task,
                  callback: typeof callback === 'function' ? callback : null
              };

              if (pos) {
                q.tasks.unshift(item);
              } else {
                q.tasks.push(item);
              }

              if (q.saturated && q.tasks.length === q.concurrency) {
                  q.saturated();
              }
              async.setImmediate(q.process);
          });
        }

        var workers = 0;
        var q = {
            tasks: [],
            concurrency: concurrency,
            saturated: null,
            empty: null,
            drain: null,
            started: false,
            paused: false,
            push: function (data, callback) {
              _insert(q, data, false, callback);
            },
            kill: function () {
              q.drain = null;
              q.tasks = [];
            },
            unshift: function (data, callback) {
              _insert(q, data, true, callback);
            },
            process: function () {
                if (!q.paused && workers < q.concurrency && q.tasks.length) {
                    var task = q.tasks.shift();
                    if (q.empty && q.tasks.length === 0) {
                        q.empty();
                    }
                    workers += 1;
                    var next = function () {
                        workers -= 1;
                        if (task.callback) {
                            task.callback.apply(task, arguments);
                        }
                        if (q.drain && q.tasks.length + workers === 0) {
                            q.drain();
                        }
                        q.process();
                    };
                    var cb = only_once(next);
                    worker(task.data, cb);
                }
            },
            length: function () {
                return q.tasks.length;
            },
            running: function () {
                return workers;
            },
            idle: function() {
                return q.tasks.length + workers === 0;
            },
            pause: function () {
                if (q.paused === true) { return; }
                q.paused = true;
                q.process();
            },
            resume: function () {
                if (q.paused === false) { return; }
                q.paused = false;
                q.process();
            }
        };
        return q;
    };
    
    async.priorityQueue = function (worker, concurrency) {
        
        function _compareTasks(a, b){
          return a.priority - b.priority;
        };
        
        function _binarySearch(sequence, item, compare) {
          var beg = -1,
              end = sequence.length - 1;
          while (beg < end) {
            var mid = beg + ((end - beg + 1) >>> 1);
            if (compare(item, sequence[mid]) >= 0) {
              beg = mid;
            } else {
              end = mid - 1;
            }
          }
          return beg;
        }
        
        function _insert(q, data, priority, callback) {
          if (!q.started){
            q.started = true;
          }
          if (!_isArray(data)) {
              data = [data];
          }
          if(data.length == 0) {
             // call drain immediately if there are no tasks
             return async.setImmediate(function() {
                 if (q.drain) {
                     q.drain();
                 }
             });
          }
          _each(data, function(task) {
              var item = {
                  data: task,
                  priority: priority,
                  callback: typeof callback === 'function' ? callback : null
              };
              
              q.tasks.splice(_binarySearch(q.tasks, item, _compareTasks) + 1, 0, item);

              if (q.saturated && q.tasks.length === q.concurrency) {
                  q.saturated();
              }
              async.setImmediate(q.process);
          });
        }
        
        // Start with a normal queue
        var q = async.queue(worker, concurrency);
        
        // Override push to accept second parameter representing priority
        q.push = function (data, priority, callback) {
          _insert(q, data, priority, callback);
        };
        
        // Remove unshift function
        delete q.unshift;

        return q;
    };

    async.cargo = function (worker, payload) {
        var working     = false,
            tasks       = [];

        var cargo = {
            tasks: tasks,
            payload: payload,
            saturated: null,
            empty: null,
            drain: null,
            drained: true,
            push: function (data, callback) {
                if (!_isArray(data)) {
                    data = [data];
                }
                _each(data, function(task) {
                    tasks.push({
                        data: task,
                        callback: typeof callback === 'function' ? callback : null
                    });
                    cargo.drained = false;
                    if (cargo.saturated && tasks.length === payload) {
                        cargo.saturated();
                    }
                });
                async.setImmediate(cargo.process);
            },
            process: function process() {
                if (working) return;
                if (tasks.length === 0) {
                    if(cargo.drain && !cargo.drained) cargo.drain();
                    cargo.drained = true;
                    return;
                }

                var ts = typeof payload === 'number'
                            ? tasks.splice(0, payload)
                            : tasks.splice(0, tasks.length);

                var ds = _map(ts, function (task) {
                    return task.data;
                });

                if(cargo.empty) cargo.empty();
                working = true;
                worker(ds, function () {
                    working = false;

                    var args = arguments;
                    _each(ts, function (data) {
                        if (data.callback) {
                            data.callback.apply(null, args);
                        }
                    });

                    process();
                });
            },
            length: function () {
                return tasks.length;
            },
            running: function () {
                return working;
            }
        };
        return cargo;
    };

    var _console_fn = function (name) {
        return function (fn) {
            var args = Array.prototype.slice.call(arguments, 1);
            fn.apply(null, args.concat([function (err) {
                var args = Array.prototype.slice.call(arguments, 1);
                if (typeof console !== 'undefined') {
                    if (err) {
                        if (console.error) {
                            console.error(err);
                        }
                    }
                    else if (console[name]) {
                        _each(args, function (x) {
                            console[name](x);
                        });
                    }
                }
            }]));
        };
    };
    async.log = _console_fn('log');
    async.dir = _console_fn('dir');
    /*async.info = _console_fn('info');
    async.warn = _console_fn('warn');
    async.error = _console_fn('error');*/

    async.memoize = function (fn, hasher) {
        var memo = {};
        var queues = {};
        hasher = hasher || function (x) {
            return x;
        };
        var memoized = function () {
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            var key = hasher.apply(null, args);
            if (key in memo) {
                async.nextTick(function () {
                    callback.apply(null, memo[key]);
                });
            }
            else if (key in queues) {
                queues[key].push(callback);
            }
            else {
                queues[key] = [callback];
                fn.apply(null, args.concat([function () {
                    memo[key] = arguments;
                    var q = queues[key];
                    delete queues[key];
                    for (var i = 0, l = q.length; i < l; i++) {
                      q[i].apply(null, arguments);
                    }
                }]));
            }
        };
        memoized.memo = memo;
        memoized.unmemoized = fn;
        return memoized;
    };

    async.unmemoize = function (fn) {
      return function () {
        return (fn.unmemoized || fn).apply(null, arguments);
      };
    };

    async.times = function (count, iterator, callback) {
        var counter = [];
        for (var i = 0; i < count; i++) {
            counter.push(i);
        }
        return async.map(counter, iterator, callback);
    };

    async.timesSeries = function (count, iterator, callback) {
        var counter = [];
        for (var i = 0; i < count; i++) {
            counter.push(i);
        }
        return async.mapSeries(counter, iterator, callback);
    };

    async.seq = function (/* functions... */) {
        var fns = arguments;
        return function () {
            var that = this;
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            async.reduce(fns, args, function (newargs, fn, cb) {
                fn.apply(that, newargs.concat([function () {
                    var err = arguments[0];
                    var nextargs = Array.prototype.slice.call(arguments, 1);
                    cb(err, nextargs);
                }]))
            },
            function (err, results) {
                callback.apply(that, [err].concat(results));
            });
        };
    };

    async.compose = function (/* functions... */) {
      return async.seq.apply(null, Array.prototype.reverse.call(arguments));
    };

    var _applyEach = function (eachfn, fns /*args...*/) {
        var go = function () {
            var that = this;
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            return eachfn(fns, function (fn, cb) {
                fn.apply(that, args.concat([cb]));
            },
            callback);
        };
        if (arguments.length > 2) {
            var args = Array.prototype.slice.call(arguments, 2);
            return go.apply(this, args);
        }
        else {
            return go;
        }
    };
    async.applyEach = doParallel(_applyEach);
    async.applyEachSeries = doSeries(_applyEach);

    async.forever = function (fn, callback) {
        function next(err) {
            if (err) {
                if (callback) {
                    return callback(err);
                }
                throw err;
            }
            fn(next);
        }
        next();
    };

    // Node.js
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = async;
    }
    // AMD / RequireJS
    else if (typeof define !== 'undefined' && define.amd) {
        define([], function () {
            return async;
        });
    }
    // included directly via <script> tag
    else {
        root.async = async;
    }

}());

}).call(this,_dereq_("FWaASH"))
},{"FWaASH":166}],109:[function(_dereq_,module,exports){
(function (Buffer){
(function () {
  "use strict";

  function atob(str) {
    return new Buffer(str, 'base64').toString('binary');
  }

  module.exports = atob;
}());

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":147}],110:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
var SomePromiseArray = Promise._SomePromiseArray;
function Promise$_Any(promises) {
    var ret = new SomePromiseArray(promises);
    var promise = ret.promise();
    if (promise.isRejected()) {
        return promise;
    }
    ret.setHowMany(1);
    ret.setUnwrap();
    ret.init();
    return promise;
}

Promise.any = function Promise$Any(promises) {
    return Promise$_Any(promises);
};

Promise.prototype.any = function Promise$any() {
    return Promise$_Any(this);
};

};

},{}],111:[function(_dereq_,module,exports){
(function (process){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var schedule = _dereq_("./schedule.js");
var Queue = _dereq_("./queue.js");
var errorObj = _dereq_("./util.js").errorObj;
var tryCatch1 = _dereq_("./util.js").tryCatch1;
var _process = typeof process !== "undefined" ? process : void 0;

function Async() {
    this._isTickUsed = false;
    this._schedule = schedule;
    this._length = 0;
    this._lateBuffer = new Queue(16);
    this._functionBuffer = new Queue(65536);
    var self = this;
    this.consumeFunctionBuffer = function Async$consumeFunctionBuffer() {
        self._consumeFunctionBuffer();
    };
}

Async.prototype.haveItemsQueued = function Async$haveItemsQueued() {
    return this._length > 0;
};

Async.prototype.invokeLater = function Async$invokeLater(fn, receiver, arg) {
    if (_process !== void 0 &&
        _process.domain != null &&
        !fn.domain) {
        fn = _process.domain.bind(fn);
    }
    this._lateBuffer.push(fn, receiver, arg);
    this._queueTick();
};

Async.prototype.invoke = function Async$invoke(fn, receiver, arg) {
    if (_process !== void 0 &&
        _process.domain != null &&
        !fn.domain) {
        fn = _process.domain.bind(fn);
    }
    var functionBuffer = this._functionBuffer;
    functionBuffer.push(fn, receiver, arg);
    this._length = functionBuffer.length();
    this._queueTick();
};

Async.prototype._consumeFunctionBuffer =
function Async$_consumeFunctionBuffer() {
    var functionBuffer = this._functionBuffer;
    while (functionBuffer.length() > 0) {
        var fn = functionBuffer.shift();
        var receiver = functionBuffer.shift();
        var arg = functionBuffer.shift();
        fn.call(receiver, arg);
    }
    this._reset();
    this._consumeLateBuffer();
};

Async.prototype._consumeLateBuffer = function Async$_consumeLateBuffer() {
    var buffer = this._lateBuffer;
    while(buffer.length() > 0) {
        var fn = buffer.shift();
        var receiver = buffer.shift();
        var arg = buffer.shift();
        var res = tryCatch1(fn, receiver, arg);
        if (res === errorObj) {
            this._queueTick();
            if (fn.domain != null) {
                fn.domain.emit("error", res.e);
            } else {
                throw res.e;
            }
        }
    }
};

Async.prototype._queueTick = function Async$_queue() {
    if (!this._isTickUsed) {
        this._schedule(this.consumeFunctionBuffer);
        this._isTickUsed = true;
    }
};

Async.prototype._reset = function Async$_reset() {
    this._isTickUsed = false;
    this._length = 0;
};

module.exports = new Async();

}).call(this,_dereq_("FWaASH"))
},{"./queue.js":134,"./schedule.js":137,"./util.js":144,"FWaASH":166}],112:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var Promise = _dereq_("./promise.js")();
module.exports = Promise;
},{"./promise.js":129}],113:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var cr = Object.create;
if (cr) {
    var callerCache = cr(null);
    var getterCache = cr(null);
    callerCache[" size"] = getterCache[" size"] = 0;
}

module.exports = function(Promise) {
var util = _dereq_("./util.js");
var canEvaluate = util.canEvaluate;
var isIdentifier = util.isIdentifier;

function makeMethodCaller (methodName) {
    return new Function("obj", "                                             \n\
        'use strict'                                                         \n\
        var len = this.length;                                               \n\
        switch(len) {                                                        \n\
            case 1: return obj.methodName(this[0]);                          \n\
            case 2: return obj.methodName(this[0], this[1]);                 \n\
            case 3: return obj.methodName(this[0], this[1], this[2]);        \n\
            case 0: return obj.methodName();                                 \n\
            default: return obj.methodName.apply(obj, this);                 \n\
        }                                                                    \n\
        ".replace(/methodName/g, methodName));
}

function makeGetter (propertyName) {
    return new Function("obj", "                                             \n\
        'use strict';                                                        \n\
        return obj.propertyName;                                             \n\
        ".replace("propertyName", propertyName));
}

function getCompiled(name, compiler, cache) {
    var ret = cache[name];
    if (typeof ret !== "function") {
        if (!isIdentifier(name)) {
            return null;
        }
        ret = compiler(name);
        cache[name] = ret;
        cache[" size"]++;
        if (cache[" size"] > 512) {
            var keys = Object.keys(cache);
            for (var i = 0; i < 256; ++i) delete cache[keys[i]];
            cache[" size"] = keys.length - 256;
        }
    }
    return ret;
}

function getMethodCaller(name) {
    return getCompiled(name, makeMethodCaller, callerCache);
}

function getGetter(name) {
    return getCompiled(name, makeGetter, getterCache);
}

function caller(obj) {
    return obj[this.pop()].apply(obj, this);
}
Promise.prototype.call = function Promise$call(methodName) {
    var $_len = arguments.length;var args = new Array($_len - 1); for(var $_i = 1; $_i < $_len; ++$_i) {args[$_i - 1] = arguments[$_i];}
    if (canEvaluate) {
        var maybeCaller = getMethodCaller(methodName);
        if (maybeCaller !== null) {
            return this._then(maybeCaller, void 0, void 0, args, void 0);
        }
    }
    args.push(methodName);
    return this._then(caller, void 0, void 0, args, void 0);
};

function namedGetter(obj) {
    return obj[this];
}
function indexedGetter(obj) {
    return obj[this];
}
Promise.prototype.get = function Promise$get(propertyName) {
    var isIndex = (typeof propertyName === "number");
    var getter;
    if (!isIndex) {
        if (canEvaluate) {
            var maybeGetter = getGetter(propertyName);
            getter = maybeGetter !== null ? maybeGetter : namedGetter;
        } else {
            getter = namedGetter;
        }
    } else {
        getter = indexedGetter;
    }
    return this._then(getter, void 0, void 0, propertyName, void 0);
};
};

},{"./util.js":144}],114:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var errors = _dereq_("./errors.js");
var canAttach = errors.canAttach;
var async = _dereq_("./async.js");
var CancellationError = errors.CancellationError;

Promise.prototype._cancel = function Promise$_cancel(reason) {
    if (!this.isCancellable()) return this;
    var parent;
    var promiseToReject = this;
    while ((parent = promiseToReject._cancellationParent) !== void 0 &&
        parent.isCancellable()) {
        promiseToReject = parent;
    }
    promiseToReject._attachExtraTrace(reason);
    promiseToReject._rejectUnchecked(reason);
};

Promise.prototype.cancel = function Promise$cancel(reason) {
    if (!this.isCancellable()) return this;
    reason = reason !== void 0
        ? (canAttach(reason) ? reason : new Error(reason + ""))
        : new CancellationError();
    async.invokeLater(this._cancel, this, reason);
    return this;
};

Promise.prototype.cancellable = function Promise$cancellable() {
    if (this._cancellable()) return this;
    this._setCancellable();
    this._cancellationParent = void 0;
    return this;
};

Promise.prototype.uncancellable = function Promise$uncancellable() {
    var ret = new Promise(INTERNAL);
    ret._propagateFrom(this, 2 | 4);
    ret._follow(this);
    ret._unsetCancellable();
    return ret;
};

Promise.prototype.fork =
function Promise$fork(didFulfill, didReject, didProgress) {
    var ret = this._then(didFulfill, didReject, didProgress,
                         void 0, void 0);

    ret._setCancellable();
    ret._cancellationParent = void 0;
    return ret;
};
};

},{"./async.js":111,"./errors.js":119}],115:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function() {
var inherits = _dereq_("./util.js").inherits;
var defineProperty = _dereq_("./es5.js").defineProperty;

var rignore = new RegExp(
    "\\b(?:[a-zA-Z0-9.]+\\$_\\w+|" +
    "tryCatch(?:1|2|3|4|Apply)|new \\w*PromiseArray|" +
    "\\w*PromiseArray\\.\\w*PromiseArray|" +
    "setTimeout|CatchFilter\\$_\\w+|makeNodePromisified|processImmediate|" +
    "process._tickCallback|nextTick|Async\\$\\w+)\\b"
);

var rtraceline = null;
var formatStack = null;

function formatNonError(obj) {
    var str;
    if (typeof obj === "function") {
        str = "[function " +
            (obj.name || "anonymous") +
            "]";
    } else {
        str = obj.toString();
        var ruselessToString = /\[object [a-zA-Z0-9$_]+\]/;
        if (ruselessToString.test(str)) {
            try {
                var newStr = JSON.stringify(obj);
                str = newStr;
            }
            catch(e) {

            }
        }
        if (str.length === 0) {
            str = "(empty array)";
        }
    }
    return ("(<" + snip(str) + ">, no stack trace)");
}

function snip(str) {
    var maxChars = 41;
    if (str.length < maxChars) {
        return str;
    }
    return str.substr(0, maxChars - 3) + "...";
}

function CapturedTrace(ignoreUntil, isTopLevel) {
    this.captureStackTrace(CapturedTrace, isTopLevel);

}
inherits(CapturedTrace, Error);

CapturedTrace.prototype.captureStackTrace =
function CapturedTrace$captureStackTrace(ignoreUntil, isTopLevel) {
    captureStackTrace(this, ignoreUntil, isTopLevel);
};

CapturedTrace.possiblyUnhandledRejection =
function CapturedTrace$PossiblyUnhandledRejection(reason) {
    if (typeof console === "object") {
        var message;
        if (typeof reason === "object" || typeof reason === "function") {
            var stack = reason.stack;
            message = "Possibly unhandled " + formatStack(stack, reason);
        } else {
            message = "Possibly unhandled " + String(reason);
        }
        if (typeof console.error === "function" ||
            typeof console.error === "object") {
            console.error(message);
        } else if (typeof console.log === "function" ||
            typeof console.log === "object") {
            console.log(message);
        }
    }
};

CapturedTrace.combine = function CapturedTrace$Combine(current, prev) {
    var curLast = current.length - 1;
    for (var i = prev.length - 1; i >= 0; --i) {
        var line = prev[i];
        if (current[curLast] === line) {
            current.pop();
            curLast--;
        } else {
            break;
        }
    }

    current.push("From previous event:");
    var lines = current.concat(prev);

    var ret = [];

    for (var i = 0, len = lines.length; i < len; ++i) {

        if (((rignore.test(lines[i]) && rtraceline.test(lines[i])) ||
            (i > 0 && !rtraceline.test(lines[i])) &&
            lines[i] !== "From previous event:")
       ) {
            continue;
        }
        ret.push(lines[i]);
    }
    return ret;
};

CapturedTrace.protectErrorMessageNewlines = function(stack) {
    for (var i = 0; i < stack.length; ++i) {
        if (rtraceline.test(stack[i])) {
            break;
        }
    }

    if (i <= 1) return;

    var errorMessageLines = [];
    for (var j = 0; j < i; ++j) {
        errorMessageLines.push(stack.shift());
    }
    stack.unshift(errorMessageLines.join("\u0002\u0000\u0001"));
};

CapturedTrace.isSupported = function CapturedTrace$IsSupported() {
    return typeof captureStackTrace === "function";
};

var captureStackTrace = (function stackDetection() {
    if (typeof Error.stackTraceLimit === "number" &&
        typeof Error.captureStackTrace === "function") {
        rtraceline = /^\s*at\s*/;
        formatStack = function(stack, error) {
            if (typeof stack === "string") return stack;

            if (error.name !== void 0 &&
                error.message !== void 0) {
                return error.name + ". " + error.message;
            }
            return formatNonError(error);


        };
        var captureStackTrace = Error.captureStackTrace;
        return function CapturedTrace$_captureStackTrace(
            receiver, ignoreUntil) {
            captureStackTrace(receiver, ignoreUntil);
        };
    }
    var err = new Error();

    if (typeof err.stack === "string" &&
        typeof "".startsWith === "function" &&
        (err.stack.startsWith("stackDetection@")) &&
        stackDetection.name === "stackDetection") {

        defineProperty(Error, "stackTraceLimit", {
            writable: true,
            enumerable: false,
            configurable: false,
            value: 25
        });
        rtraceline = /@/;
        var rline = /[@\n]/;

        formatStack = function(stack, error) {
            if (typeof stack === "string") {
                return (error.name + ". " + error.message + "\n" + stack);
            }

            if (error.name !== void 0 &&
                error.message !== void 0) {
                return error.name + ". " + error.message;
            }
            return formatNonError(error);
        };

        return function captureStackTrace(o) {
            var stack = new Error().stack;
            var split = stack.split(rline);
            var len = split.length;
            var ret = "";
            for (var i = 0; i < len; i += 2) {
                ret += split[i];
                ret += "@";
                ret += split[i + 1];
                ret += "\n";
            }
            o.stack = ret;
        };
    } else {
        formatStack = function(stack, error) {
            if (typeof stack === "string") return stack;

            if ((typeof error === "object" ||
                typeof error === "function") &&
                error.name !== void 0 &&
                error.message !== void 0) {
                return error.name + ". " + error.message;
            }
            return formatNonError(error);
        };

        return null;
    }
})();

return CapturedTrace;
};

},{"./es5.js":121,"./util.js":144}],116:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(NEXT_FILTER) {
var util = _dereq_("./util.js");
var errors = _dereq_("./errors.js");
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;
var keys = _dereq_("./es5.js").keys;
var TypeError = errors.TypeError;

function CatchFilter(instances, callback, promise) {
    this._instances = instances;
    this._callback = callback;
    this._promise = promise;
}

function CatchFilter$_safePredicate(predicate, e) {
    var safeObject = {};
    var retfilter = tryCatch1(predicate, safeObject, e);

    if (retfilter === errorObj) return retfilter;

    var safeKeys = keys(safeObject);
    if (safeKeys.length) {
        errorObj.e = new TypeError(
            "Catch filter must inherit from Error "
          + "or be a simple predicate function");
        return errorObj;
    }
    return retfilter;
}

CatchFilter.prototype.doFilter = function CatchFilter$_doFilter(e) {
    var cb = this._callback;
    var promise = this._promise;
    var boundTo = promise._boundTo;
    for (var i = 0, len = this._instances.length; i < len; ++i) {
        var item = this._instances[i];
        var itemIsErrorType = item === Error ||
            (item != null && item.prototype instanceof Error);

        if (itemIsErrorType && e instanceof item) {
            var ret = tryCatch1(cb, boundTo, e);
            if (ret === errorObj) {
                NEXT_FILTER.e = ret.e;
                return NEXT_FILTER;
            }
            return ret;
        } else if (typeof item === "function" && !itemIsErrorType) {
            var shouldHandle = CatchFilter$_safePredicate(item, e);
            if (shouldHandle === errorObj) {
                var trace = errors.canAttach(errorObj.e)
                    ? errorObj.e
                    : new Error(errorObj.e + "");
                this._promise._attachExtraTrace(trace);
                e = errorObj.e;
                break;
            } else if (shouldHandle) {
                var ret = tryCatch1(cb, boundTo, e);
                if (ret === errorObj) {
                    NEXT_FILTER.e = ret.e;
                    return NEXT_FILTER;
                }
                return ret;
            }
        }
    }
    NEXT_FILTER.e = e;
    return NEXT_FILTER;
};

return CatchFilter;
};

},{"./errors.js":119,"./es5.js":121,"./util.js":144}],117:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var util = _dereq_("./util.js");
var isPrimitive = util.isPrimitive;
var wrapsPrimitiveReceiver = util.wrapsPrimitiveReceiver;

module.exports = function(Promise) {
var returner = function Promise$_returner() {
    return this;
};
var thrower = function Promise$_thrower() {
    throw this;
};

var wrapper = function Promise$_wrapper(value, action) {
    if (action === 1) {
        return function Promise$_thrower() {
            throw value;
        };
    } else if (action === 2) {
        return function Promise$_returner() {
            return value;
        };
    }
};


Promise.prototype["return"] =
Promise.prototype.thenReturn =
function Promise$thenReturn(value) {
    if (wrapsPrimitiveReceiver && isPrimitive(value)) {
        return this._then(
            wrapper(value, 2),
            void 0,
            void 0,
            void 0,
            void 0
       );
    }
    return this._then(returner, void 0, void 0, value, void 0);
};

Promise.prototype["throw"] =
Promise.prototype.thenThrow =
function Promise$thenThrow(reason) {
    if (wrapsPrimitiveReceiver && isPrimitive(reason)) {
        return this._then(
            wrapper(reason, 1),
            void 0,
            void 0,
            void 0,
            void 0
       );
    }
    return this._then(thrower, void 0, void 0, reason, void 0);
};
};

},{"./util.js":144}],118:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var PromiseReduce = Promise.reduce;

Promise.prototype.each = function Promise$each(fn) {
    return PromiseReduce(this, fn, null, INTERNAL);
};

Promise.each = function Promise$Each(promises, fn) {
    return PromiseReduce(promises, fn, null, INTERNAL);
};
};

},{}],119:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var Objectfreeze = _dereq_("./es5.js").freeze;
var util = _dereq_("./util.js");
var inherits = util.inherits;
var notEnumerableProp = util.notEnumerableProp;

function markAsOriginatingFromRejection(e) {
    try {
        notEnumerableProp(e, "isOperational", true);
    }
    catch(ignore) {}
}

function originatesFromRejection(e) {
    if (e == null) return false;
    return ((e instanceof OperationalError) ||
        e["isOperational"] === true);
}

function isError(obj) {
    return obj instanceof Error;
}

function canAttach(obj) {
    return isError(obj);
}

function subError(nameProperty, defaultMessage) {
    function SubError(message) {
        if (!(this instanceof SubError)) return new SubError(message);
        this.message = typeof message === "string" ? message : defaultMessage;
        this.name = nameProperty;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
    inherits(SubError, Error);
    return SubError;
}

var _TypeError, _RangeError;
var CancellationError = subError("CancellationError", "cancellation error");
var TimeoutError = subError("TimeoutError", "timeout error");
var AggregateError = subError("AggregateError", "aggregate error");
try {
    _TypeError = TypeError;
    _RangeError = RangeError;
} catch(e) {
    _TypeError = subError("TypeError", "type error");
    _RangeError = subError("RangeError", "range error");
}

var methods = ("join pop push shift unshift slice filter forEach some " +
    "every map indexOf lastIndexOf reduce reduceRight sort reverse").split(" ");

for (var i = 0; i < methods.length; ++i) {
    if (typeof Array.prototype[methods[i]] === "function") {
        AggregateError.prototype[methods[i]] = Array.prototype[methods[i]];
    }
}

AggregateError.prototype.length = 0;
AggregateError.prototype["isOperational"] = true;
var level = 0;
AggregateError.prototype.toString = function() {
    var indent = Array(level * 4 + 1).join(" ");
    var ret = "\n" + indent + "AggregateError of:" + "\n";
    level++;
    indent = Array(level * 4 + 1).join(" ");
    for (var i = 0; i < this.length; ++i) {
        var str = this[i] === this ? "[Circular AggregateError]" : this[i] + "";
        var lines = str.split("\n");
        for (var j = 0; j < lines.length; ++j) {
            lines[j] = indent + lines[j];
        }
        str = lines.join("\n");
        ret += str + "\n";
    }
    level--;
    return ret;
};

function OperationalError(message) {
    this.name = "OperationalError";
    this.message = message;
    this.cause = message;
    this["isOperational"] = true;

    if (message instanceof Error) {
        this.message = message.message;
        this.stack = message.stack;
    } else if (Error.captureStackTrace) {
        Error.captureStackTrace(this, this.constructor);
    }

}
inherits(OperationalError, Error);

var key = "__BluebirdErrorTypes__";
var errorTypes = Error[key];
if (!errorTypes) {
    errorTypes = Objectfreeze({
        CancellationError: CancellationError,
        TimeoutError: TimeoutError,
        OperationalError: OperationalError,
        RejectionError: OperationalError,
        AggregateError: AggregateError
    });
    notEnumerableProp(Error, key, errorTypes);
}

module.exports = {
    Error: Error,
    TypeError: _TypeError,
    RangeError: _RangeError,
    CancellationError: errorTypes.CancellationError,
    OperationalError: errorTypes.OperationalError,
    TimeoutError: errorTypes.TimeoutError,
    AggregateError: errorTypes.AggregateError,
    originatesFromRejection: originatesFromRejection,
    markAsOriginatingFromRejection: markAsOriginatingFromRejection,
    canAttach: canAttach
};

},{"./es5.js":121,"./util.js":144}],120:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
var TypeError = _dereq_('./errors.js').TypeError;

function apiRejection(msg) {
    var error = new TypeError(msg);
    var ret = Promise.rejected(error);
    var parent = ret._peekContext();
    if (parent != null) {
        parent._attachExtraTrace(error);
    }
    return ret;
}

return apiRejection;
};

},{"./errors.js":119}],121:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
var isES5 = (function(){
    "use strict";
    return this === void 0;
})();

if (isES5) {
    module.exports = {
        freeze: Object.freeze,
        defineProperty: Object.defineProperty,
        keys: Object.keys,
        getPrototypeOf: Object.getPrototypeOf,
        isArray: Array.isArray,
        isES5: isES5
    };
} else {
    var has = {}.hasOwnProperty;
    var str = {}.toString;
    var proto = {}.constructor.prototype;

    var ObjectKeys = function ObjectKeys(o) {
        var ret = [];
        for (var key in o) {
            if (has.call(o, key)) {
                ret.push(key);
            }
        }
        return ret;
    }

    var ObjectDefineProperty = function ObjectDefineProperty(o, key, desc) {
        o[key] = desc.value;
        return o;
    }

    var ObjectFreeze = function ObjectFreeze(obj) {
        return obj;
    }

    var ObjectGetPrototypeOf = function ObjectGetPrototypeOf(obj) {
        try {
            return Object(obj).constructor.prototype;
        }
        catch (e) {
            return proto;
        }
    }

    var ArrayIsArray = function ArrayIsArray(obj) {
        try {
            return str.call(obj) === "[object Array]";
        }
        catch(e) {
            return false;
        }
    }

    module.exports = {
        isArray: ArrayIsArray,
        keys: ObjectKeys,
        defineProperty: ObjectDefineProperty,
        freeze: ObjectFreeze,
        getPrototypeOf: ObjectGetPrototypeOf,
        isES5: isES5
    };
}

},{}],122:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var PromiseMap = Promise.map;

Promise.prototype.filter = function Promise$filter(fn, options) {
    return PromiseMap(this, fn, options, INTERNAL);
};

Promise.filter = function Promise$Filter(promises, fn, options) {
    return PromiseMap(promises, fn, options, INTERNAL);
};
};

},{}],123:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, NEXT_FILTER, cast) {
var util = _dereq_("./util.js");
var wrapsPrimitiveReceiver = util.wrapsPrimitiveReceiver;
var isPrimitive = util.isPrimitive;
var thrower = util.thrower;

function returnThis() {
    return this;
}
function throwThis() {
    throw this;
}
function return$(r) {
    return function Promise$_returner() {
        return r;
    };
}
function throw$(r) {
    return function Promise$_thrower() {
        throw r;
    };
}
function promisedFinally(ret, reasonOrValue, isFulfilled) {
    var then;
    if (wrapsPrimitiveReceiver && isPrimitive(reasonOrValue)) {
        then = isFulfilled ? return$(reasonOrValue) : throw$(reasonOrValue);
    } else {
        then = isFulfilled ? returnThis : throwThis;
    }
    return ret._then(then, thrower, void 0, reasonOrValue, void 0);
}

function finallyHandler(reasonOrValue) {
    var promise = this.promise;
    var handler = this.handler;

    var ret = promise._isBound()
                    ? handler.call(promise._boundTo)
                    : handler();

    if (ret !== void 0) {
        var maybePromise = cast(ret, void 0);
        if (maybePromise instanceof Promise) {
            return promisedFinally(maybePromise, reasonOrValue,
                                    promise.isFulfilled());
        }
    }

    if (promise.isRejected()) {
        NEXT_FILTER.e = reasonOrValue;
        return NEXT_FILTER;
    } else {
        return reasonOrValue;
    }
}

function tapHandler(value) {
    var promise = this.promise;
    var handler = this.handler;

    var ret = promise._isBound()
                    ? handler.call(promise._boundTo, value)
                    : handler(value);

    if (ret !== void 0) {
        var maybePromise = cast(ret, void 0);
        if (maybePromise instanceof Promise) {
            return promisedFinally(maybePromise, value, true);
        }
    }
    return value;
}

Promise.prototype._passThroughHandler =
function Promise$_passThroughHandler(handler, isFinally) {
    if (typeof handler !== "function") return this.then();

    var promiseAndHandler = {
        promise: this,
        handler: handler
    };

    return this._then(
            isFinally ? finallyHandler : tapHandler,
            isFinally ? finallyHandler : void 0, void 0,
            promiseAndHandler, void 0);
};

Promise.prototype.lastly =
Promise.prototype["finally"] = function Promise$finally(handler) {
    return this._passThroughHandler(handler, true);
};

Promise.prototype.tap = function Promise$tap(handler) {
    return this._passThroughHandler(handler, false);
};
};

},{"./util.js":144}],124:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, apiRejection, INTERNAL, cast) {
var errors = _dereq_("./errors.js");
var TypeError = errors.TypeError;
var deprecated = _dereq_("./util.js").deprecated;
var util = _dereq_("./util.js");
var errorObj = util.errorObj;
var tryCatch1 = util.tryCatch1;
var yieldHandlers = [];

function promiseFromYieldHandler(value, yieldHandlers) {
    var _errorObj = errorObj;
    var _Promise = Promise;
    var len = yieldHandlers.length;
    for (var i = 0; i < len; ++i) {
        var result = tryCatch1(yieldHandlers[i], void 0, value);
        if (result === _errorObj) {
            return _Promise.reject(_errorObj.e);
        }
        var maybePromise = cast(result, promiseFromYieldHandler);
        if (maybePromise instanceof _Promise) return maybePromise;
    }
    return null;
}

function PromiseSpawn(generatorFunction, receiver, yieldHandler) {
    var promise = this._promise = new Promise(INTERNAL);
    promise._setTrace(void 0);
    this._generatorFunction = generatorFunction;
    this._receiver = receiver;
    this._generator = void 0;
    this._yieldHandlers = typeof yieldHandler === "function"
        ? [yieldHandler].concat(yieldHandlers)
        : yieldHandlers;
}

PromiseSpawn.prototype.promise = function PromiseSpawn$promise() {
    return this._promise;
};

PromiseSpawn.prototype._run = function PromiseSpawn$_run() {
    this._generator = this._generatorFunction.call(this._receiver);
    this._receiver =
        this._generatorFunction = void 0;
    this._next(void 0);
};

PromiseSpawn.prototype._continue = function PromiseSpawn$_continue(result) {
    if (result === errorObj) {
        this._generator = void 0;
        var trace = errors.canAttach(result.e)
            ? result.e : new Error(result.e + "");
        this._promise._attachExtraTrace(trace);
        this._promise._reject(result.e, trace);
        return;
    }

    var value = result.value;
    if (result.done === true) {
        this._generator = void 0;
        if (!this._promise._tryFollow(value)) {
            this._promise._fulfill(value);
        }
    } else {
        var maybePromise = cast(value, void 0);
        if (!(maybePromise instanceof Promise)) {
            maybePromise =
                promiseFromYieldHandler(maybePromise, this._yieldHandlers);
            if (maybePromise === null) {
                this._throw(new TypeError("A value was yielded that could not be treated as a promise"));
                return;
            }
        }
        maybePromise._then(
            this._next,
            this._throw,
            void 0,
            this,
            null
       );
    }
};

PromiseSpawn.prototype._throw = function PromiseSpawn$_throw(reason) {
    if (errors.canAttach(reason))
        this._promise._attachExtraTrace(reason);
    this._continue(
        tryCatch1(this._generator["throw"], this._generator, reason)
   );
};

PromiseSpawn.prototype._next = function PromiseSpawn$_next(value) {
    this._continue(
        tryCatch1(this._generator.next, this._generator, value)
   );
};

Promise.coroutine =
function Promise$Coroutine(generatorFunction, options) {
    if (typeof generatorFunction !== "function") {
        throw new TypeError("generatorFunction must be a function");
    }
    var yieldHandler = Object(options).yieldHandler;
    var PromiseSpawn$ = PromiseSpawn;
    return function () {
        var generator = generatorFunction.apply(this, arguments);
        var spawn = new PromiseSpawn$(void 0, void 0, yieldHandler);
        spawn._generator = generator;
        spawn._next(void 0);
        return spawn.promise();
    };
};

Promise.coroutine.addYieldHandler = function(fn) {
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    yieldHandlers.push(fn);
};

Promise.spawn = function Promise$Spawn(generatorFunction) {
    deprecated("Promise.spawn is deprecated. Use Promise.coroutine instead.");
    if (typeof generatorFunction !== "function") {
        return apiRejection("generatorFunction must be a function");
    }
    var spawn = new PromiseSpawn(generatorFunction, this);
    var ret = spawn.promise();
    spawn._run(Promise.spawn);
    return ret;
};
};

},{"./errors.js":119,"./util.js":144}],125:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports =
function(Promise, PromiseArray, cast, INTERNAL) {
var util = _dereq_("./util.js");
var canEvaluate = util.canEvaluate;
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;


if (canEvaluate) {
    var thenCallback = function(i) {
        return new Function("value", "holder", "                             \n\
            'use strict';                                                    \n\
            holder.pIndex = value;                                           \n\
            holder.checkFulfillment(this);                                   \n\
            ".replace(/Index/g, i));
    };

    var caller = function(count) {
        var values = [];
        for (var i = 1; i <= count; ++i) values.push("holder.p" + i);
        return new Function("holder", "                                      \n\
            'use strict';                                                    \n\
            var callback = holder.fn;                                        \n\
            return callback(values);                                         \n\
            ".replace(/values/g, values.join(", ")));
    };
    var thenCallbacks = [];
    var callers = [void 0];
    for (var i = 1; i <= 5; ++i) {
        thenCallbacks.push(thenCallback(i));
        callers.push(caller(i));
    }

    var Holder = function(total, fn) {
        this.p1 = this.p2 = this.p3 = this.p4 = this.p5 = null;
        this.fn = fn;
        this.total = total;
        this.now = 0;
    };

    Holder.prototype.callers = callers;
    Holder.prototype.checkFulfillment = function(promise) {
        var now = this.now;
        now++;
        var total = this.total;
        if (now >= total) {
            var handler = this.callers[total];
            var ret = tryCatch1(handler, void 0, this);
            if (ret === errorObj) {
                promise._rejectUnchecked(ret.e);
            } else if (!promise._tryFollow(ret)) {
                promise._fulfillUnchecked(ret);
            }
        } else {
            this.now = now;
        }
    };
}




Promise.join = function Promise$Join() {
    var last = arguments.length - 1;
    var fn;
    if (last > 0 && typeof arguments[last] === "function") {
        fn = arguments[last];
        if (last < 6 && canEvaluate) {
            var ret = new Promise(INTERNAL);
            ret._setTrace(void 0);
            var holder = new Holder(last, fn);
            var reject = ret._reject;
            var callbacks = thenCallbacks;
            for (var i = 0; i < last; ++i) {
                var maybePromise = cast(arguments[i], void 0);
                if (maybePromise instanceof Promise) {
                    if (maybePromise.isPending()) {
                        maybePromise._then(callbacks[i], reject,
                                           void 0, ret, holder);
                    } else if (maybePromise.isFulfilled()) {
                        callbacks[i].call(ret,
                                          maybePromise._settledValue, holder);
                    } else {
                        ret._reject(maybePromise._settledValue);
                        maybePromise._unsetRejectionIsUnhandled();
                    }
                } else {
                    callbacks[i].call(ret, maybePromise, holder);
                }
            }
            return ret;
        }
    }
    var $_len = arguments.length;var args = new Array($_len); for(var $_i = 0; $_i < $_len; ++$_i) {args[$_i] = arguments[$_i];}
    var ret = new PromiseArray(args).promise();
    return fn !== void 0 ? ret.spread(fn) : ret;
};

};

},{"./util.js":144}],126:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray, apiRejection, cast, INTERNAL) {
var util = _dereq_("./util.js");
var tryCatch3 = util.tryCatch3;
var errorObj = util.errorObj;
var PENDING = {};
var EMPTY_ARRAY = [];

function MappingPromiseArray(promises, fn, limit, _filter) {
    this.constructor$(promises);
    this._callback = fn;
    this._preservedValues = _filter === INTERNAL
        ? new Array(this.length())
        : null;
    this._limit = limit;
    this._inFlight = 0;
    this._queue = limit >= 1 ? [] : EMPTY_ARRAY;
    this._init$(void 0, -2);
}
util.inherits(MappingPromiseArray, PromiseArray);

MappingPromiseArray.prototype._init = function MappingPromiseArray$_init() {};

MappingPromiseArray.prototype._promiseFulfilled =
function MappingPromiseArray$_promiseFulfilled(value, index) {
    var values = this._values;
    if (values === null) return;

    var length = this.length();
    var preservedValues = this._preservedValues;
    var limit = this._limit;
    if (values[index] === PENDING) {
        values[index] = value;
        if (limit >= 1) {
            this._inFlight--;
            this._drainQueue();
            if (this._isResolved()) return;
        }
    } else {
        if (limit >= 1 && this._inFlight >= limit) {
            values[index] = value;
            this._queue.push(index);
            return;
        }
        if (preservedValues !== null) preservedValues[index] = value;

        var callback = this._callback;
        var receiver = this._promise._boundTo;
        var ret = tryCatch3(callback, receiver, value, index, length);
        if (ret === errorObj) return this._reject(ret.e);

        var maybePromise = cast(ret, void 0);
        if (maybePromise instanceof Promise) {
            if (maybePromise.isPending()) {
                if (limit >= 1) this._inFlight++;
                values[index] = PENDING;
                return maybePromise._proxyPromiseArray(this, index);
            } else if (maybePromise.isFulfilled()) {
                ret = maybePromise.value();
            } else {
                maybePromise._unsetRejectionIsUnhandled();
                return this._reject(maybePromise.reason());
            }
        }
        values[index] = ret;
    }
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= length) {
        if (preservedValues !== null) {
            this._filter(values, preservedValues);
        } else {
            this._resolve(values);
        }

    }
};

MappingPromiseArray.prototype._drainQueue =
function MappingPromiseArray$_drainQueue() {
    var queue = this._queue;
    var limit = this._limit;
    var values = this._values;
    while (queue.length > 0 && this._inFlight < limit) {
        var index = queue.pop();
        this._promiseFulfilled(values[index], index);
    }
};

MappingPromiseArray.prototype._filter =
function MappingPromiseArray$_filter(booleans, values) {
    var len = values.length;
    var ret = new Array(len);
    var j = 0;
    for (var i = 0; i < len; ++i) {
        if (booleans[i]) ret[j++] = values[i];
    }
    ret.length = j;
    this._resolve(ret);
};

MappingPromiseArray.prototype.preservedValues =
function MappingPromiseArray$preserveValues() {
    return this._preservedValues;
};

function map(promises, fn, options, _filter) {
    var limit = typeof options === "object" && options !== null
        ? options.concurrency
        : 0;
    limit = typeof limit === "number" &&
        isFinite(limit) && limit >= 1 ? limit : 0;
    return new MappingPromiseArray(promises, fn, limit, _filter);
}

Promise.prototype.map = function Promise$map(fn, options) {
    if (typeof fn !== "function") return apiRejection("fn must be a function");

    return map(this, fn, options, null).promise();
};

Promise.map = function Promise$Map(promises, fn, options, _filter) {
    if (typeof fn !== "function") return apiRejection("fn must be a function");
    return map(promises, fn, options, _filter).promise();
};


};

},{"./util.js":144}],127:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
var util = _dereq_("./util.js");
var async = _dereq_("./async.js");
var tryCatch2 = util.tryCatch2;
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;

function thrower(r) {
    throw r;
}

function Promise$_spreadAdapter(val, receiver) {
    if (!util.isArray(val)) return Promise$_successAdapter(val, receiver);
    var ret = util.tryCatchApply(this, [null].concat(val), receiver);
    if (ret === errorObj) {
        async.invokeLater(thrower, void 0, ret.e);
    }
}

function Promise$_successAdapter(val, receiver) {
    var nodeback = this;
    var ret = val === void 0
        ? tryCatch1(nodeback, receiver, null)
        : tryCatch2(nodeback, receiver, null, val);
    if (ret === errorObj) {
        async.invokeLater(thrower, void 0, ret.e);
    }
}
function Promise$_errorAdapter(reason, receiver) {
    var nodeback = this;
    var ret = tryCatch1(nodeback, receiver, reason);
    if (ret === errorObj) {
        async.invokeLater(thrower, void 0, ret.e);
    }
}

Promise.prototype.nodeify = function Promise$nodeify(nodeback, options) {
    if (typeof nodeback == "function") {
        var adapter = Promise$_successAdapter;
        if (options !== void 0 && Object(options).spread) {
            adapter = Promise$_spreadAdapter;
        }
        this._then(
            adapter,
            Promise$_errorAdapter,
            void 0,
            nodeback,
            this._boundTo
        );
    }
    return this;
};
};

},{"./async.js":111,"./util.js":144}],128:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray) {
var util = _dereq_("./util.js");
var async = _dereq_("./async.js");
var errors = _dereq_("./errors.js");
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;

Promise.prototype.progressed = function Promise$progressed(handler) {
    return this._then(void 0, void 0, handler, void 0, void 0);
};

Promise.prototype._progress = function Promise$_progress(progressValue) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._progressUnchecked(progressValue);

};

Promise.prototype._clearFirstHandlerData$Base =
Promise.prototype._clearFirstHandlerData;
Promise.prototype._clearFirstHandlerData =
function Promise$_clearFirstHandlerData() {
    this._clearFirstHandlerData$Base();
    this._progressHandler0 = void 0;
};

Promise.prototype._progressHandlerAt =
function Promise$_progressHandlerAt(index) {
    return index === 0
        ? this._progressHandler0
        : this[(index << 2) + index - 5 + 2];
};

Promise.prototype._doProgressWith =
function Promise$_doProgressWith(progression) {
    var progressValue = progression.value;
    var handler = progression.handler;
    var promise = progression.promise;
    var receiver = progression.receiver;

    var ret = tryCatch1(handler, receiver, progressValue);
    if (ret === errorObj) {
        if (ret.e != null &&
            ret.e.name !== "StopProgressPropagation") {
            var trace = errors.canAttach(ret.e)
                ? ret.e : new Error(ret.e + "");
            promise._attachExtraTrace(trace);
            promise._progress(ret.e);
        }
    } else if (ret instanceof Promise) {
        ret._then(promise._progress, null, null, promise, void 0);
    } else {
        promise._progress(ret);
    }
};


Promise.prototype._progressUnchecked =
function Promise$_progressUnchecked(progressValue) {
    if (!this.isPending()) return;
    var len = this._length();
    var progress = this._progress;
    for (var i = 0; i < len; i++) {
        var handler = this._progressHandlerAt(i);
        var promise = this._promiseAt(i);
        if (!(promise instanceof Promise)) {
            var receiver = this._receiverAt(i);
            if (typeof handler === "function") {
                handler.call(receiver, progressValue, promise);
            } else if (receiver instanceof Promise && receiver._isProxied()) {
                receiver._progressUnchecked(progressValue);
            } else if (receiver instanceof PromiseArray) {
                receiver._promiseProgressed(progressValue, promise);
            }
            continue;
        }

        if (typeof handler === "function") {
            async.invoke(this._doProgressWith, this, {
                handler: handler,
                promise: promise,
                receiver: this._receiverAt(i),
                value: progressValue
            });
        } else {
            async.invoke(progress, promise, progressValue);
        }
    }
};
};

},{"./async.js":111,"./errors.js":119,"./util.js":144}],129:[function(_dereq_,module,exports){
(function (process){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var old;
if (typeof Promise !== "undefined") old = Promise;
function noConflict(bluebird) {
    try { if (Promise === bluebird) Promise = old; }
    catch (e) {}
    return bluebird;
}
module.exports = function() {
var util = _dereq_("./util.js");
var async = _dereq_("./async.js");
var errors = _dereq_("./errors.js");

var INTERNAL = function(){};
var APPLY = {};
var NEXT_FILTER = {e: null};

var cast = _dereq_("./thenables.js")(Promise, INTERNAL);
var PromiseArray = _dereq_("./promise_array.js")(Promise, INTERNAL, cast);
var CapturedTrace = _dereq_("./captured_trace.js")();
var CatchFilter = _dereq_("./catch_filter.js")(NEXT_FILTER);
var PromiseResolver = _dereq_("./promise_resolver.js");

var isArray = util.isArray;

var errorObj = util.errorObj;
var tryCatch1 = util.tryCatch1;
var tryCatch2 = util.tryCatch2;
var tryCatchApply = util.tryCatchApply;
var RangeError = errors.RangeError;
var TypeError = errors.TypeError;
var CancellationError = errors.CancellationError;
var TimeoutError = errors.TimeoutError;
var OperationalError = errors.OperationalError;
var originatesFromRejection = errors.originatesFromRejection;
var markAsOriginatingFromRejection = errors.markAsOriginatingFromRejection;
var canAttach = errors.canAttach;
var thrower = util.thrower;
var apiRejection = _dereq_("./errors_api_rejection")(Promise);


var makeSelfResolutionError = function Promise$_makeSelfResolutionError() {
    return new TypeError("circular promise resolution chain");
};

function Promise(resolver) {
    if (typeof resolver !== "function") {
        throw new TypeError("the promise constructor requires a resolver function");
    }
    if (this.constructor !== Promise) {
        throw new TypeError("the promise constructor cannot be invoked directly");
    }
    this._bitField = 0;
    this._fulfillmentHandler0 = void 0;
    this._rejectionHandler0 = void 0;
    this._promise0 = void 0;
    this._receiver0 = void 0;
    this._settledValue = void 0;
    this._boundTo = void 0;
    if (resolver !== INTERNAL) this._resolveFromResolver(resolver);
}

function returnFirstElement(elements) {
    return elements[0];
}

Promise.prototype.bind = function Promise$bind(thisArg) {
    var maybePromise = cast(thisArg, void 0);
    var ret = new Promise(INTERNAL);
    if (maybePromise instanceof Promise) {
        var binder = maybePromise.then(function(thisArg) {
            ret._setBoundTo(thisArg);
        });
        var p = Promise.all([this, binder]).then(returnFirstElement);
        ret._follow(p);
    } else {
        ret._follow(this);
        ret._setBoundTo(thisArg);
    }
    ret._propagateFrom(this, 2 | 1);
    return ret;
};

Promise.prototype.toString = function Promise$toString() {
    return "[object Promise]";
};

Promise.prototype.caught = Promise.prototype["catch"] =
function Promise$catch(fn) {
    var len = arguments.length;
    if (len > 1) {
        var catchInstances = new Array(len - 1),
            j = 0, i;
        for (i = 0; i < len - 1; ++i) {
            var item = arguments[i];
            if (typeof item === "function") {
                catchInstances[j++] = item;
            } else {
                var catchFilterTypeError =
                    new TypeError(
                        "A catch filter must be an error constructor "
                        + "or a filter function");

                this._attachExtraTrace(catchFilterTypeError);
                return Promise.reject(catchFilterTypeError);
            }
        }
        catchInstances.length = j;
        fn = arguments[i];

        this._resetTrace();
        var catchFilter = new CatchFilter(catchInstances, fn, this);
        return this._then(void 0, catchFilter.doFilter, void 0,
            catchFilter, void 0);
    }
    return this._then(void 0, fn, void 0, void 0, void 0);
};

Promise.prototype.then =
function Promise$then(didFulfill, didReject, didProgress) {
    return this._then(didFulfill, didReject, didProgress,
        void 0, void 0);
};


Promise.prototype.done =
function Promise$done(didFulfill, didReject, didProgress) {
    var promise = this._then(didFulfill, didReject, didProgress,
        void 0, void 0);
    promise._setIsFinal();
};

Promise.prototype.spread = function Promise$spread(didFulfill, didReject) {
    return this._then(didFulfill, didReject, void 0,
        APPLY, void 0);
};

Promise.prototype.isCancellable = function Promise$isCancellable() {
    return !this.isResolved() &&
        this._cancellable();
};

Promise.prototype.toJSON = function Promise$toJSON() {
    var ret = {
        isFulfilled: false,
        isRejected: false,
        fulfillmentValue: void 0,
        rejectionReason: void 0
    };
    if (this.isFulfilled()) {
        ret.fulfillmentValue = this._settledValue;
        ret.isFulfilled = true;
    } else if (this.isRejected()) {
        ret.rejectionReason = this._settledValue;
        ret.isRejected = true;
    }
    return ret;
};

Promise.prototype.all = function Promise$all() {
    return new PromiseArray(this).promise();
};


Promise.is = function Promise$Is(val) {
    return val instanceof Promise;
};

Promise.all = function Promise$All(promises) {
    return new PromiseArray(promises).promise();
};

Promise.prototype.error = function Promise$_error(fn) {
    return this.caught(originatesFromRejection, fn);
};

Promise.prototype._resolveFromSyncValue =
function Promise$_resolveFromSyncValue(value) {
    if (value === errorObj) {
        this._cleanValues();
        this._setRejected();
        this._settledValue = value.e;
        this._ensurePossibleRejectionHandled();
    } else {
        var maybePromise = cast(value, void 0);
        if (maybePromise instanceof Promise) {
            this._follow(maybePromise);
        } else {
            this._cleanValues();
            this._setFulfilled();
            this._settledValue = value;
        }
    }
};

Promise.method = function Promise$_Method(fn) {
    if (typeof fn !== "function") {
        throw new TypeError("fn must be a function");
    }
    return function Promise$_method() {
        var value;
        switch(arguments.length) {
        case 0: value = tryCatch1(fn, this, void 0); break;
        case 1: value = tryCatch1(fn, this, arguments[0]); break;
        case 2: value = tryCatch2(fn, this, arguments[0], arguments[1]); break;
        default:
            var $_len = arguments.length;var args = new Array($_len); for(var $_i = 0; $_i < $_len; ++$_i) {args[$_i] = arguments[$_i];}
            value = tryCatchApply(fn, args, this); break;
        }
        var ret = new Promise(INTERNAL);
        ret._setTrace(void 0);
        ret._resolveFromSyncValue(value);
        return ret;
    };
};

Promise.attempt = Promise["try"] = function Promise$_Try(fn, args, ctx) {
    if (typeof fn !== "function") {
        return apiRejection("fn must be a function");
    }
    var value = isArray(args)
        ? tryCatchApply(fn, args, ctx)
        : tryCatch1(fn, ctx, args);

    var ret = new Promise(INTERNAL);
    ret._setTrace(void 0);
    ret._resolveFromSyncValue(value);
    return ret;
};

Promise.defer = Promise.pending = function Promise$Defer() {
    var promise = new Promise(INTERNAL);
    promise._setTrace(void 0);
    return new PromiseResolver(promise);
};

Promise.bind = function Promise$Bind(thisArg) {
    var maybePromise = cast(thisArg, void 0);
    var ret = new Promise(INTERNAL);
    ret._setTrace(void 0);

    if (maybePromise instanceof Promise) {
        var p = maybePromise.then(function(thisArg) {
            ret._setBoundTo(thisArg);
        });
        ret._follow(p);
    } else {
        ret._setBoundTo(thisArg);
        ret._setFulfilled();
    }
    return ret;
};

Promise.cast = function Promise$_Cast(obj) {
    var ret = cast(obj, void 0);
    if (!(ret instanceof Promise)) {
        var val = ret;
        ret = new Promise(INTERNAL);
        ret._setTrace(void 0);
        ret._setFulfilled();
        ret._cleanValues();
        ret._settledValue = val;
    }
    return ret;
};

Promise.resolve = Promise.fulfilled = Promise.cast;

Promise.reject = Promise.rejected = function Promise$Reject(reason) {
    var ret = new Promise(INTERNAL);
    ret._setTrace(void 0);
    markAsOriginatingFromRejection(reason);
    ret._cleanValues();
    ret._setRejected();
    ret._settledValue = reason;
    if (!canAttach(reason)) {
        var trace = new Error(reason + "");
        ret._setCarriedStackTrace(trace);
    }
    ret._ensurePossibleRejectionHandled();
    return ret;
};

Promise.onPossiblyUnhandledRejection =
function Promise$OnPossiblyUnhandledRejection(fn) {
        CapturedTrace.possiblyUnhandledRejection = typeof fn === "function"
                                                    ? fn : void 0;
};

var unhandledRejectionHandled;
Promise.onUnhandledRejectionHandled =
function Promise$onUnhandledRejectionHandled(fn) {
    unhandledRejectionHandled = typeof fn === "function" ? fn : void 0;
};

var debugging = false || !!(
    typeof process !== "undefined" &&
    typeof process.execPath === "string" &&
    typeof process.env === "object" &&
    (process.env["BLUEBIRD_DEBUG"] ||
        process.env["NODE_ENV"] === "development")
);


Promise.longStackTraces = function Promise$LongStackTraces() {
    if (async.haveItemsQueued() &&
        debugging === false
   ) {
        throw new Error("cannot enable long stack traces after promises have been created");
    }
    debugging = CapturedTrace.isSupported();
};

Promise.hasLongStackTraces = function Promise$HasLongStackTraces() {
    return debugging && CapturedTrace.isSupported();
};

Promise.prototype._then =
function Promise$_then(
    didFulfill,
    didReject,
    didProgress,
    receiver,
    internalData
) {
    var haveInternalData = internalData !== void 0;
    var ret = haveInternalData ? internalData : new Promise(INTERNAL);

    if (!haveInternalData) {
        if (debugging) {
            var haveSameContext = this._peekContext() === this._traceParent;
            ret._traceParent = haveSameContext ? this._traceParent : this;
        }
        ret._propagateFrom(this, 7);
    }

    var callbackIndex =
        this._addCallbacks(didFulfill, didReject, didProgress, ret, receiver);

    if (this.isResolved()) {
        async.invoke(this._queueSettleAt, this, callbackIndex);
    }

    return ret;
};

Promise.prototype._length = function Promise$_length() {
    return this._bitField & 262143;
};

Promise.prototype._isFollowingOrFulfilledOrRejected =
function Promise$_isFollowingOrFulfilledOrRejected() {
    return (this._bitField & 939524096) > 0;
};

Promise.prototype._isFollowing = function Promise$_isFollowing() {
    return (this._bitField & 536870912) === 536870912;
};

Promise.prototype._setLength = function Promise$_setLength(len) {
    this._bitField = (this._bitField & -262144) |
        (len & 262143);
};

Promise.prototype._setFulfilled = function Promise$_setFulfilled() {
    this._bitField = this._bitField | 268435456;
};

Promise.prototype._setRejected = function Promise$_setRejected() {
    this._bitField = this._bitField | 134217728;
};

Promise.prototype._setFollowing = function Promise$_setFollowing() {
    this._bitField = this._bitField | 536870912;
};

Promise.prototype._setIsFinal = function Promise$_setIsFinal() {
    this._bitField = this._bitField | 33554432;
};

Promise.prototype._isFinal = function Promise$_isFinal() {
    return (this._bitField & 33554432) > 0;
};

Promise.prototype._cancellable = function Promise$_cancellable() {
    return (this._bitField & 67108864) > 0;
};

Promise.prototype._setCancellable = function Promise$_setCancellable() {
    this._bitField = this._bitField | 67108864;
};

Promise.prototype._unsetCancellable = function Promise$_unsetCancellable() {
    this._bitField = this._bitField & (~67108864);
};

Promise.prototype._setRejectionIsUnhandled =
function Promise$_setRejectionIsUnhandled() {
    this._bitField = this._bitField | 2097152;
};

Promise.prototype._unsetRejectionIsUnhandled =
function Promise$_unsetRejectionIsUnhandled() {
    this._bitField = this._bitField & (~2097152);
    if (this._isUnhandledRejectionNotified()) {
        this._unsetUnhandledRejectionIsNotified();
        this._notifyUnhandledRejectionIsHandled();
    }
};

Promise.prototype._isRejectionUnhandled =
function Promise$_isRejectionUnhandled() {
    return (this._bitField & 2097152) > 0;
};

Promise.prototype._setUnhandledRejectionIsNotified =
function Promise$_setUnhandledRejectionIsNotified() {
    this._bitField = this._bitField | 524288;
};

Promise.prototype._unsetUnhandledRejectionIsNotified =
function Promise$_unsetUnhandledRejectionIsNotified() {
    this._bitField = this._bitField & (~524288);
};

Promise.prototype._isUnhandledRejectionNotified =
function Promise$_isUnhandledRejectionNotified() {
    return (this._bitField & 524288) > 0;
};

Promise.prototype._setCarriedStackTrace =
function Promise$_setCarriedStackTrace(capturedTrace) {
    this._bitField = this._bitField | 1048576;
    this._fulfillmentHandler0 = capturedTrace;
};

Promise.prototype._unsetCarriedStackTrace =
function Promise$_unsetCarriedStackTrace() {
    this._bitField = this._bitField & (~1048576);
    this._fulfillmentHandler0 = void 0;
};

Promise.prototype._isCarryingStackTrace =
function Promise$_isCarryingStackTrace() {
    return (this._bitField & 1048576) > 0;
};

Promise.prototype._getCarriedStackTrace =
function Promise$_getCarriedStackTrace() {
    return this._isCarryingStackTrace()
        ? this._fulfillmentHandler0
        : void 0;
};

Promise.prototype._receiverAt = function Promise$_receiverAt(index) {
    var ret = index === 0
        ? this._receiver0
        : this[(index << 2) + index - 5 + 4];
    if (this._isBound() && ret === void 0) {
        return this._boundTo;
    }
    return ret;
};

Promise.prototype._promiseAt = function Promise$_promiseAt(index) {
    return index === 0
        ? this._promise0
        : this[(index << 2) + index - 5 + 3];
};

Promise.prototype._fulfillmentHandlerAt =
function Promise$_fulfillmentHandlerAt(index) {
    return index === 0
        ? this._fulfillmentHandler0
        : this[(index << 2) + index - 5 + 0];
};

Promise.prototype._rejectionHandlerAt =
function Promise$_rejectionHandlerAt(index) {
    return index === 0
        ? this._rejectionHandler0
        : this[(index << 2) + index - 5 + 1];
};

Promise.prototype._addCallbacks = function Promise$_addCallbacks(
    fulfill,
    reject,
    progress,
    promise,
    receiver
) {
    var index = this._length();

    if (index >= 262143 - 5) {
        index = 0;
        this._setLength(0);
    }

    if (index === 0) {
        this._promise0 = promise;
        if (receiver !== void 0) this._receiver0 = receiver;
        if (typeof fulfill === "function" && !this._isCarryingStackTrace())
            this._fulfillmentHandler0 = fulfill;
        if (typeof reject === "function") this._rejectionHandler0 = reject;
        if (typeof progress === "function") this._progressHandler0 = progress;
    } else {
        var base = (index << 2) + index - 5;
        this[base + 3] = promise;
        this[base + 4] = receiver;
        this[base + 0] = typeof fulfill === "function"
                                            ? fulfill : void 0;
        this[base + 1] = typeof reject === "function"
                                            ? reject : void 0;
        this[base + 2] = typeof progress === "function"
                                            ? progress : void 0;
    }
    this._setLength(index + 1);
    return index;
};

Promise.prototype._setProxyHandlers =
function Promise$_setProxyHandlers(receiver, promiseSlotValue) {
    var index = this._length();

    if (index >= 262143 - 5) {
        index = 0;
        this._setLength(0);
    }
    if (index === 0) {
        this._promise0 = promiseSlotValue;
        this._receiver0 = receiver;
    } else {
        var base = (index << 2) + index - 5;
        this[base + 3] = promiseSlotValue;
        this[base + 4] = receiver;
        this[base + 0] =
        this[base + 1] =
        this[base + 2] = void 0;
    }
    this._setLength(index + 1);
};

Promise.prototype._proxyPromiseArray =
function Promise$_proxyPromiseArray(promiseArray, index) {
    this._setProxyHandlers(promiseArray, index);
};

Promise.prototype._proxyPromise = function Promise$_proxyPromise(promise) {
    promise._setProxied();
    this._setProxyHandlers(promise, -15);
};

Promise.prototype._setBoundTo = function Promise$_setBoundTo(obj) {
    if (obj !== void 0) {
        this._bitField = this._bitField | 8388608;
        this._boundTo = obj;
    } else {
        this._bitField = this._bitField & (~8388608);
    }
};

Promise.prototype._isBound = function Promise$_isBound() {
    return (this._bitField & 8388608) === 8388608;
};

Promise.prototype._resolveFromResolver =
function Promise$_resolveFromResolver(resolver) {
    var promise = this;
    this._setTrace(void 0);
    this._pushContext();

    function Promise$_resolver(val) {
        if (promise._tryFollow(val)) {
            return;
        }
        promise._fulfill(val);
    }
    function Promise$_rejecter(val) {
        var trace = canAttach(val) ? val : new Error(val + "");
        promise._attachExtraTrace(trace);
        markAsOriginatingFromRejection(val);
        promise._reject(val, trace === val ? void 0 : trace);
    }
    var r = tryCatch2(resolver, void 0, Promise$_resolver, Promise$_rejecter);
    this._popContext();

    if (r !== void 0 && r === errorObj) {
        var e = r.e;
        var trace = canAttach(e) ? e : new Error(e + "");
        promise._reject(e, trace);
    }
};

Promise.prototype._spreadSlowCase =
function Promise$_spreadSlowCase(targetFn, promise, values, boundTo) {
    var promiseForAll = new PromiseArray(values).promise();
    var promise2 = promiseForAll._then(function() {
        return targetFn.apply(boundTo, arguments);
    }, void 0, void 0, APPLY, void 0);
    promise._follow(promise2);
};

Promise.prototype._callSpread =
function Promise$_callSpread(handler, promise, value) {
    var boundTo = this._boundTo;
    if (isArray(value)) {
        for (var i = 0, len = value.length; i < len; ++i) {
            if (cast(value[i], void 0) instanceof Promise) {
                this._spreadSlowCase(handler, promise, value, boundTo);
                return;
            }
        }
    }
    promise._pushContext();
    return tryCatchApply(handler, value, boundTo);
};

Promise.prototype._callHandler =
function Promise$_callHandler(
    handler, receiver, promise, value) {
    var x;
    if (receiver === APPLY && !this.isRejected()) {
        x = this._callSpread(handler, promise, value);
    } else {
        promise._pushContext();
        x = tryCatch1(handler, receiver, value);
    }
    promise._popContext();
    return x;
};

Promise.prototype._settlePromiseFromHandler =
function Promise$_settlePromiseFromHandler(
    handler, receiver, value, promise
) {
    if (!(promise instanceof Promise)) {
        handler.call(receiver, value, promise);
        return;
    }
    var x = this._callHandler(handler, receiver, promise, value);
    if (promise._isFollowing()) return;

    if (x === errorObj || x === promise || x === NEXT_FILTER) {
        var err = x === promise
                    ? makeSelfResolutionError()
                    : x.e;
        var trace = canAttach(err) ? err : new Error(err + "");
        if (x !== NEXT_FILTER) promise._attachExtraTrace(trace);
        promise._rejectUnchecked(err, trace);
    } else {
        var castValue = cast(x, promise);
        if (castValue instanceof Promise) {
            if (castValue.isRejected() &&
                !castValue._isCarryingStackTrace() &&
                !canAttach(castValue._settledValue)) {
                var trace = new Error(castValue._settledValue + "");
                promise._attachExtraTrace(trace);
                castValue._setCarriedStackTrace(trace);
            }
            promise._follow(castValue);
            promise._propagateFrom(castValue, 1);
        } else {
            promise._fulfillUnchecked(x);
        }
    }
};

Promise.prototype._follow =
function Promise$_follow(promise) {
    this._setFollowing();

    if (promise.isPending()) {
        this._propagateFrom(promise, 1);
        promise._proxyPromise(this);
    } else if (promise.isFulfilled()) {
        this._fulfillUnchecked(promise._settledValue);
    } else {
        this._rejectUnchecked(promise._settledValue,
            promise._getCarriedStackTrace());
    }

    if (promise._isRejectionUnhandled()) promise._unsetRejectionIsUnhandled();

    if (debugging &&
        promise._traceParent == null) {
        promise._traceParent = this;
    }
};

Promise.prototype._tryFollow =
function Promise$_tryFollow(value) {
    if (this._isFollowingOrFulfilledOrRejected() ||
        value === this) {
        return false;
    }
    var maybePromise = cast(value, void 0);
    if (!(maybePromise instanceof Promise)) {
        return false;
    }
    this._follow(maybePromise);
    return true;
};

Promise.prototype._resetTrace = function Promise$_resetTrace() {
    if (debugging) {
        this._trace = new CapturedTrace(this._peekContext() === void 0);
    }
};

Promise.prototype._setTrace = function Promise$_setTrace(parent) {
    if (debugging) {
        var context = this._peekContext();
        this._traceParent = context;
        var isTopLevel = context === void 0;
        if (parent !== void 0 &&
            parent._traceParent === context) {
            this._trace = parent._trace;
        } else {
            this._trace = new CapturedTrace(isTopLevel);
        }
    }
    return this;
};

Promise.prototype._attachExtraTrace =
function Promise$_attachExtraTrace(error) {
    if (debugging) {
        var promise = this;
        var stack = error.stack;
        stack = typeof stack === "string" ? stack.split("\n") : [];
        CapturedTrace.protectErrorMessageNewlines(stack);
        var headerLineCount = 1;
        var combinedTraces = 1;
        while(promise != null &&
            promise._trace != null) {
            stack = CapturedTrace.combine(
                stack,
                promise._trace.stack.split("\n")
            );
            promise = promise._traceParent;
            combinedTraces++;
        }

        var stackTraceLimit = Error.stackTraceLimit || 10;
        var max = (stackTraceLimit + headerLineCount) * combinedTraces;
        var len = stack.length;
        if (len > max) {
            stack.length = max;
        }

        if (len > 0)
            stack[0] = stack[0].split("\u0002\u0000\u0001").join("\n");

        if (stack.length <= headerLineCount) {
            error.stack = "(No stack trace)";
        } else {
            error.stack = stack.join("\n");
        }
    }
};

Promise.prototype._cleanValues = function Promise$_cleanValues() {
    if (this._cancellable()) {
        this._cancellationParent = void 0;
    }
};

Promise.prototype._propagateFrom =
function Promise$_propagateFrom(parent, flags) {
    if ((flags & 1) > 0 && parent._cancellable()) {
        this._setCancellable();
        this._cancellationParent = parent;
    }
    if ((flags & 4) > 0) {
        this._setBoundTo(parent._boundTo);
    }
    if ((flags & 2) > 0) {
        this._setTrace(parent);
    }
};

Promise.prototype._fulfill = function Promise$_fulfill(value) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._fulfillUnchecked(value);
};

Promise.prototype._reject =
function Promise$_reject(reason, carriedStackTrace) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._rejectUnchecked(reason, carriedStackTrace);
};

Promise.prototype._settlePromiseAt = function Promise$_settlePromiseAt(index) {
    var handler = this.isFulfilled()
        ? this._fulfillmentHandlerAt(index)
        : this._rejectionHandlerAt(index);

    var value = this._settledValue;
    var receiver = this._receiverAt(index);
    var promise = this._promiseAt(index);

    if (typeof handler === "function") {
        this._settlePromiseFromHandler(handler, receiver, value, promise);
    } else {
        var done = false;
        var isFulfilled = this.isFulfilled();
        if (receiver !== void 0) {
            if (receiver instanceof Promise &&
                receiver._isProxied()) {
                receiver._unsetProxied();

                if (isFulfilled) receiver._fulfillUnchecked(value);
                else receiver._rejectUnchecked(value,
                    this._getCarriedStackTrace());
                done = true;
            } else if (receiver instanceof PromiseArray) {
                if (isFulfilled) receiver._promiseFulfilled(value, promise);
                else receiver._promiseRejected(value, promise);
                done = true;
            }
        }

        if (!done) {
            if (isFulfilled) promise._fulfill(value);
            else promise._reject(value, this._getCarriedStackTrace());
        }
    }

    if (index >= 4) {
        this._queueGC();
    }
};

Promise.prototype._isProxied = function Promise$_isProxied() {
    return (this._bitField & 4194304) === 4194304;
};

Promise.prototype._setProxied = function Promise$_setProxied() {
    this._bitField = this._bitField | 4194304;
};

Promise.prototype._unsetProxied = function Promise$_unsetProxied() {
    this._bitField = this._bitField & (~4194304);
};

Promise.prototype._isGcQueued = function Promise$_isGcQueued() {
    return (this._bitField & -1073741824) === -1073741824;
};

Promise.prototype._setGcQueued = function Promise$_setGcQueued() {
    this._bitField = this._bitField | -1073741824;
};

Promise.prototype._unsetGcQueued = function Promise$_unsetGcQueued() {
    this._bitField = this._bitField & (~-1073741824);
};

Promise.prototype._queueGC = function Promise$_queueGC() {
    if (this._isGcQueued()) return;
    this._setGcQueued();
    async.invokeLater(this._gc, this, void 0);
};

Promise.prototype._gc = function Promise$gc() {
    var len = this._length() * 5 - 5;
    for (var i = 0; i < len; i++) {
        delete this[i];
    }
    this._clearFirstHandlerData();
    this._setLength(0);
    this._unsetGcQueued();
};

Promise.prototype._clearFirstHandlerData =
function Promise$_clearFirstHandlerData() {
    this._fulfillmentHandler0 = void 0;
    this._rejectionHandler0 = void 0;
    this._promise0 = void 0;
    this._receiver0 = void 0;
};

Promise.prototype._queueSettleAt = function Promise$_queueSettleAt(index) {
    if (this._isRejectionUnhandled()) this._unsetRejectionIsUnhandled();
    async.invoke(this._settlePromiseAt, this, index);
};

Promise.prototype._fulfillUnchecked =
function Promise$_fulfillUnchecked(value) {
    if (!this.isPending()) return;
    if (value === this) {
        var err = makeSelfResolutionError();
        this._attachExtraTrace(err);
        return this._rejectUnchecked(err, void 0);
    }
    this._cleanValues();
    this._setFulfilled();
    this._settledValue = value;
    var len = this._length();

    if (len > 0) {
        async.invoke(this._settlePromises, this, len);
    }
};

Promise.prototype._rejectUncheckedCheckError =
function Promise$_rejectUncheckedCheckError(reason) {
    var trace = canAttach(reason) ? reason : new Error(reason + "");
    this._rejectUnchecked(reason, trace === reason ? void 0 : trace);
};

Promise.prototype._rejectUnchecked =
function Promise$_rejectUnchecked(reason, trace) {
    if (!this.isPending()) return;
    if (reason === this) {
        var err = makeSelfResolutionError();
        this._attachExtraTrace(err);
        return this._rejectUnchecked(err);
    }
    this._cleanValues();
    this._setRejected();
    this._settledValue = reason;

    if (this._isFinal()) {
        async.invokeLater(thrower, void 0, trace === void 0 ? reason : trace);
        return;
    }
    var len = this._length();

    if (trace !== void 0) this._setCarriedStackTrace(trace);

    if (len > 0) {
        async.invoke(this._rejectPromises, this, null);
    } else {
        this._ensurePossibleRejectionHandled();
    }
};

Promise.prototype._rejectPromises = function Promise$_rejectPromises() {
    this._settlePromises();
    this._unsetCarriedStackTrace();
};

Promise.prototype._settlePromises = function Promise$_settlePromises() {
    var len = this._length();
    for (var i = 0; i < len; i++) {
        this._settlePromiseAt(i);
    }
};

Promise.prototype._ensurePossibleRejectionHandled =
function Promise$_ensurePossibleRejectionHandled() {
    this._setRejectionIsUnhandled();
    if (CapturedTrace.possiblyUnhandledRejection !== void 0) {
        async.invokeLater(this._notifyUnhandledRejection, this, void 0);
    }
};

Promise.prototype._notifyUnhandledRejectionIsHandled =
function Promise$_notifyUnhandledRejectionIsHandled() {
    if (typeof unhandledRejectionHandled === "function") {
        async.invokeLater(unhandledRejectionHandled, void 0, this);
    }
};

Promise.prototype._notifyUnhandledRejection =
function Promise$_notifyUnhandledRejection() {
    if (this._isRejectionUnhandled()) {
        var reason = this._settledValue;
        var trace = this._getCarriedStackTrace();

        this._setUnhandledRejectionIsNotified();

        if (trace !== void 0) {
            this._unsetCarriedStackTrace();
            reason = trace;
        }
        if (typeof CapturedTrace.possiblyUnhandledRejection === "function") {
            CapturedTrace.possiblyUnhandledRejection(reason, this);
        }
    }
};

var contextStack = [];
Promise.prototype._peekContext = function Promise$_peekContext() {
    var lastIndex = contextStack.length - 1;
    if (lastIndex >= 0) {
        return contextStack[lastIndex];
    }
    return void 0;

};

Promise.prototype._pushContext = function Promise$_pushContext() {
    if (!debugging) return;
    contextStack.push(this);
};

Promise.prototype._popContext = function Promise$_popContext() {
    if (!debugging) return;
    contextStack.pop();
};

Promise.noConflict = function Promise$NoConflict() {
    return noConflict(Promise);
};

Promise.setScheduler = function(fn) {
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    async._schedule = fn;
};

if (!CapturedTrace.isSupported()) {
    Promise.longStackTraces = function(){};
    debugging = false;
}

Promise._makeSelfResolutionError = makeSelfResolutionError;
_dereq_("./finally.js")(Promise, NEXT_FILTER, cast);
_dereq_("./direct_resolve.js")(Promise);
_dereq_("./synchronous_inspection.js")(Promise);
_dereq_("./join.js")(Promise, PromiseArray, cast, INTERNAL);
Promise.RangeError = RangeError;
Promise.CancellationError = CancellationError;
Promise.TimeoutError = TimeoutError;
Promise.TypeError = TypeError;
Promise.OperationalError = OperationalError;
Promise.RejectionError = OperationalError;
Promise.AggregateError = errors.AggregateError;

util.toFastProperties(Promise);
util.toFastProperties(Promise.prototype);
Promise.Promise = Promise;
_dereq_('./timers.js')(Promise,INTERNAL,cast);
_dereq_('./race.js')(Promise,INTERNAL,cast);
_dereq_('./call_get.js')(Promise);
_dereq_('./generators.js')(Promise,apiRejection,INTERNAL,cast);
_dereq_('./map.js')(Promise,PromiseArray,apiRejection,cast,INTERNAL);
_dereq_('./nodeify.js')(Promise);
_dereq_('./promisify.js')(Promise,INTERNAL);
_dereq_('./props.js')(Promise,PromiseArray,cast);
_dereq_('./reduce.js')(Promise,PromiseArray,apiRejection,cast,INTERNAL);
_dereq_('./settle.js')(Promise,PromiseArray);
_dereq_('./some.js')(Promise,PromiseArray,apiRejection);
_dereq_('./progress.js')(Promise,PromiseArray);
_dereq_('./cancel.js')(Promise,INTERNAL);
_dereq_('./filter.js')(Promise,INTERNAL);
_dereq_('./any.js')(Promise,PromiseArray);
_dereq_('./each.js')(Promise,INTERNAL);
_dereq_('./using.js')(Promise,apiRejection,cast);

Promise.prototype = Promise.prototype;
return Promise;

};

}).call(this,_dereq_("FWaASH"))
},{"./any.js":110,"./async.js":111,"./call_get.js":113,"./cancel.js":114,"./captured_trace.js":115,"./catch_filter.js":116,"./direct_resolve.js":117,"./each.js":118,"./errors.js":119,"./errors_api_rejection":120,"./filter.js":122,"./finally.js":123,"./generators.js":124,"./join.js":125,"./map.js":126,"./nodeify.js":127,"./progress.js":128,"./promise_array.js":130,"./promise_resolver.js":131,"./promisify.js":132,"./props.js":133,"./race.js":135,"./reduce.js":136,"./settle.js":138,"./some.js":139,"./synchronous_inspection.js":140,"./thenables.js":141,"./timers.js":142,"./using.js":143,"./util.js":144,"FWaASH":166}],130:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL, cast) {
var canAttach = _dereq_("./errors.js").canAttach;
var util = _dereq_("./util.js");
var isArray = util.isArray;

function toResolutionValue(val) {
    switch(val) {
    case -1: return void 0;
    case -2: return [];
    case -3: return {};
    }
}

function PromiseArray(values) {
    var promise = this._promise = new Promise(INTERNAL);
    var parent = void 0;
    if (values instanceof Promise) {
        parent = values;
        promise._propagateFrom(parent, 1 | 4);
    }
    promise._setTrace(parent);
    this._values = values;
    this._length = 0;
    this._totalResolved = 0;
    this._init(void 0, -2);
}
PromiseArray.prototype.length = function PromiseArray$length() {
    return this._length;
};

PromiseArray.prototype.promise = function PromiseArray$promise() {
    return this._promise;
};

PromiseArray.prototype._init =
function PromiseArray$_init(_, resolveValueIfEmpty) {
    var values = cast(this._values, void 0);
    if (values instanceof Promise) {
        this._values = values;
        values._setBoundTo(this._promise._boundTo);
        if (values.isFulfilled()) {
            values = values._settledValue;
            if (!isArray(values)) {
                var err = new Promise.TypeError("expecting an array, a promise or a thenable");
                this.__hardReject__(err);
                return;
            }
        } else if (values.isPending()) {
            values._then(
                PromiseArray$_init,
                this._reject,
                void 0,
                this,
                resolveValueIfEmpty
           );
            return;
        } else {
            values._unsetRejectionIsUnhandled();
            this._reject(values._settledValue);
            return;
        }
    } else if (!isArray(values)) {
        var err = new Promise.TypeError("expecting an array, a promise or a thenable");
        this.__hardReject__(err);
        return;
    }

    if (values.length === 0) {
        if (resolveValueIfEmpty === -5) {
            this._resolveEmptyArray();
        }
        else {
            this._resolve(toResolutionValue(resolveValueIfEmpty));
        }
        return;
    }
    var len = this.getActualLength(values.length);
    var newLen = len;
    var newValues = this.shouldCopyValues() ? new Array(len) : this._values;
    var isDirectScanNeeded = false;
    for (var i = 0; i < len; ++i) {
        var maybePromise = cast(values[i], void 0);
        if (maybePromise instanceof Promise) {
            if (maybePromise.isPending()) {
                maybePromise._proxyPromiseArray(this, i);
            } else {
                maybePromise._unsetRejectionIsUnhandled();
                isDirectScanNeeded = true;
            }
        } else {
            isDirectScanNeeded = true;
        }
        newValues[i] = maybePromise;
    }
    this._values = newValues;
    this._length = newLen;
    if (isDirectScanNeeded) {
        this._scanDirectValues(len);
    }
};

PromiseArray.prototype._settlePromiseAt =
function PromiseArray$_settlePromiseAt(index) {
    var value = this._values[index];
    if (!(value instanceof Promise)) {
        this._promiseFulfilled(value, index);
    } else if (value.isFulfilled()) {
        this._promiseFulfilled(value._settledValue, index);
    } else if (value.isRejected()) {
        this._promiseRejected(value._settledValue, index);
    }
};

PromiseArray.prototype._scanDirectValues =
function PromiseArray$_scanDirectValues(len) {
    for (var i = 0; i < len; ++i) {
        if (this._isResolved()) {
            break;
        }
        this._settlePromiseAt(i);
    }
};

PromiseArray.prototype._isResolved = function PromiseArray$_isResolved() {
    return this._values === null;
};

PromiseArray.prototype._resolve = function PromiseArray$_resolve(value) {
    this._values = null;
    this._promise._fulfill(value);
};

PromiseArray.prototype.__hardReject__ =
PromiseArray.prototype._reject = function PromiseArray$_reject(reason) {
    this._values = null;
    var trace = canAttach(reason) ? reason : new Error(reason + "");
    this._promise._attachExtraTrace(trace);
    this._promise._reject(reason, trace);
};

PromiseArray.prototype._promiseProgressed =
function PromiseArray$_promiseProgressed(progressValue, index) {
    if (this._isResolved()) return;
    this._promise._progress({
        index: index,
        value: progressValue
    });
};


PromiseArray.prototype._promiseFulfilled =
function PromiseArray$_promiseFulfilled(value, index) {
    if (this._isResolved()) return;
    this._values[index] = value;
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= this._length) {
        this._resolve(this._values);
    }
};

PromiseArray.prototype._promiseRejected =
function PromiseArray$_promiseRejected(reason, index) {
    if (this._isResolved()) return;
    this._totalResolved++;
    this._reject(reason);
};

PromiseArray.prototype.shouldCopyValues =
function PromiseArray$_shouldCopyValues() {
    return true;
};

PromiseArray.prototype.getActualLength =
function PromiseArray$getActualLength(len) {
    return len;
};

return PromiseArray;
};

},{"./errors.js":119,"./util.js":144}],131:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var util = _dereq_("./util.js");
var maybeWrapAsError = util.maybeWrapAsError;
var errors = _dereq_("./errors.js");
var TimeoutError = errors.TimeoutError;
var OperationalError = errors.OperationalError;
var async = _dereq_("./async.js");
var haveGetters = util.haveGetters;
var es5 = _dereq_("./es5.js");

function isUntypedError(obj) {
    return obj instanceof Error &&
        es5.getPrototypeOf(obj) === Error.prototype;
}

function wrapAsOperationalError(obj) {
    var ret;
    if (isUntypedError(obj)) {
        ret = new OperationalError(obj);
    } else {
        ret = obj;
    }
    errors.markAsOriginatingFromRejection(ret);
    return ret;
}

function nodebackForPromise(promise) {
    function PromiseResolver$_callback(err, value) {
        if (promise === null) return;

        if (err) {
            var wrapped = wrapAsOperationalError(maybeWrapAsError(err));
            promise._attachExtraTrace(wrapped);
            promise._reject(wrapped);
        } else if (arguments.length > 2) {
            var $_len = arguments.length;var args = new Array($_len - 1); for(var $_i = 1; $_i < $_len; ++$_i) {args[$_i - 1] = arguments[$_i];}
            promise._fulfill(args);
        } else {
            promise._fulfill(value);
        }

        promise = null;
    }
    return PromiseResolver$_callback;
}


var PromiseResolver;
if (!haveGetters) {
    PromiseResolver = function PromiseResolver(promise) {
        this.promise = promise;
        this.asCallback = nodebackForPromise(promise);
        this.callback = this.asCallback;
    };
}
else {
    PromiseResolver = function PromiseResolver(promise) {
        this.promise = promise;
    };
}
if (haveGetters) {
    var prop = {
        get: function() {
            return nodebackForPromise(this.promise);
        }
    };
    es5.defineProperty(PromiseResolver.prototype, "asCallback", prop);
    es5.defineProperty(PromiseResolver.prototype, "callback", prop);
}

PromiseResolver._nodebackForPromise = nodebackForPromise;

PromiseResolver.prototype.toString = function PromiseResolver$toString() {
    return "[object PromiseResolver]";
};

PromiseResolver.prototype.resolve =
PromiseResolver.prototype.fulfill = function PromiseResolver$resolve(value) {
    if (!(this instanceof PromiseResolver)) {
        throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.");
    }

    var promise = this.promise;
    if (promise._tryFollow(value)) {
        return;
    }
    async.invoke(promise._fulfill, promise, value);
};

PromiseResolver.prototype.reject = function PromiseResolver$reject(reason) {
    if (!(this instanceof PromiseResolver)) {
        throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.");
    }

    var promise = this.promise;
    errors.markAsOriginatingFromRejection(reason);
    var trace = errors.canAttach(reason) ? reason : new Error(reason + "");
    promise._attachExtraTrace(trace);
    async.invoke(promise._reject, promise, reason);
    if (trace !== reason) {
        async.invoke(this._setCarriedStackTrace, this, trace);
    }
};

PromiseResolver.prototype.progress =
function PromiseResolver$progress(value) {
    if (!(this instanceof PromiseResolver)) {
        throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.");
    }
    async.invoke(this.promise._progress, this.promise, value);
};

PromiseResolver.prototype.cancel = function PromiseResolver$cancel() {
    async.invoke(this.promise.cancel, this.promise, void 0);
};

PromiseResolver.prototype.timeout = function PromiseResolver$timeout() {
    this.reject(new TimeoutError("timeout"));
};

PromiseResolver.prototype.isResolved = function PromiseResolver$isResolved() {
    return this.promise.isResolved();
};

PromiseResolver.prototype.toJSON = function PromiseResolver$toJSON() {
    return this.promise.toJSON();
};

PromiseResolver.prototype._setCarriedStackTrace =
function PromiseResolver$_setCarriedStackTrace(trace) {
    if (this.promise.isRejected()) {
        this.promise._setCarriedStackTrace(trace);
    }
};

module.exports = PromiseResolver;

},{"./async.js":111,"./errors.js":119,"./es5.js":121,"./util.js":144}],132:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var THIS = {};
var util = _dereq_("./util.js");
var nodebackForPromise = _dereq_("./promise_resolver.js")
    ._nodebackForPromise;
var withAppended = util.withAppended;
var maybeWrapAsError = util.maybeWrapAsError;
var canEvaluate = util.canEvaluate;
var TypeError = _dereq_("./errors").TypeError;
var defaultSuffix = "Async";
var defaultFilter = function(name, func) {
    return util.isIdentifier(name) &&
        name.charAt(0) !== "_" &&
        !util.isClass(func);
};
var defaultPromisified = {__isPromisified__: true};


function escapeIdentRegex(str) {
    return str.replace(/([$])/, "\\$");
}

function isPromisified(fn) {
    try {
        return fn.__isPromisified__ === true;
    }
    catch (e) {
        return false;
    }
}

function hasPromisified(obj, key, suffix) {
    var val = util.getDataPropertyOrDefault(obj, key + suffix,
                                            defaultPromisified);
    return val ? isPromisified(val) : false;
}
function checkValid(ret, suffix, suffixRegexp) {
    for (var i = 0; i < ret.length; i += 2) {
        var key = ret[i];
        if (suffixRegexp.test(key)) {
            var keyWithoutAsyncSuffix = key.replace(suffixRegexp, "");
            for (var j = 0; j < ret.length; j += 2) {
                if (ret[j] === keyWithoutAsyncSuffix) {
                    throw new TypeError("Cannot promisify an API " +
                        "that has normal methods with '"+suffix+"'-suffix");
                }
            }
        }
    }
}

function promisifiableMethods(obj, suffix, suffixRegexp, filter) {
    var keys = util.inheritedDataKeys(obj);
    var ret = [];
    for (var i = 0; i < keys.length; ++i) {
        var key = keys[i];
        var value = obj[key];
        if (typeof value === "function" &&
            !isPromisified(value) &&
            !hasPromisified(obj, key, suffix) &&
            filter(key, value, obj)) {
            ret.push(key, value);
        }
    }
    checkValid(ret, suffix, suffixRegexp);
    return ret;
}

function switchCaseArgumentOrder(likelyArgumentCount) {
    var ret = [likelyArgumentCount];
    var min = Math.max(0, likelyArgumentCount - 1 - 5);
    for(var i = likelyArgumentCount - 1; i >= min; --i) {
        if (i === likelyArgumentCount) continue;
        ret.push(i);
    }
    for(var i = likelyArgumentCount + 1; i <= 5; ++i) {
        ret.push(i);
    }
    return ret;
}

function argumentSequence(argumentCount) {
    return util.filledRange(argumentCount, "arguments[", "]");
}

function parameterDeclaration(parameterCount) {
    return util.filledRange(parameterCount, "_arg", "");
}

function parameterCount(fn) {
    if (typeof fn.length === "number") {
        return Math.max(Math.min(fn.length, 1023 + 1), 0);
    }
    return 0;
}

function generatePropertyAccess(key) {
    if (util.isIdentifier(key)) {
        return "." + key;
    }
    else return "['" + key.replace(/(['\\])/g, "\\$1") + "']";
}

function makeNodePromisifiedEval(callback, receiver, originalName, fn, suffix) {
    var newParameterCount = Math.max(0, parameterCount(fn) - 1);
    var argumentOrder = switchCaseArgumentOrder(newParameterCount);
    var callbackName =
        (typeof originalName === "string" && util.isIdentifier(originalName)
            ? originalName + suffix
            : "promisified");

    function generateCallForArgumentCount(count) {
        var args = argumentSequence(count).join(", ");
        var comma = count > 0 ? ", " : "";
        var ret;
        if (typeof callback === "string") {
            ret = "                                                          \n\
                this.method(args, fn);                                       \n\
                break;                                                       \n\
            ".replace(".method", generatePropertyAccess(callback));
        } else if (receiver === THIS) {
            ret =  "                                                         \n\
                callback.call(this, args, fn);                               \n\
                break;                                                       \n\
            ";
        } else if (receiver !== void 0) {
            ret =  "                                                         \n\
                callback.call(receiver, args, fn);                           \n\
                break;                                                       \n\
            ";
        } else {
            ret =  "                                                         \n\
                callback(args, fn);                                          \n\
                break;                                                       \n\
            ";
        }
        return ret.replace("args", args).replace(", ", comma);
    }

    function generateArgumentSwitchCase() {
        var ret = "";
        for(var i = 0; i < argumentOrder.length; ++i) {
            ret += "case " + argumentOrder[i] +":" +
                generateCallForArgumentCount(argumentOrder[i]);
        }
        var codeForCall;
        if (typeof callback === "string") {
            codeForCall = "                                                  \n\
                this.property.apply(this, args);                             \n\
            "
                .replace(".property", generatePropertyAccess(callback));
        } else if (receiver === THIS) {
            codeForCall = "                                                  \n\
                callback.apply(this, args);                                  \n\
            ";
        } else {
            codeForCall = "                                                  \n\
                callback.apply(receiver, args);                              \n\
            ";
        }

        ret += "                                                             \n\
        default:                                                             \n\
            var args = new Array(len + 1);                                   \n\
            var i = 0;                                                       \n\
            for (var i = 0; i < len; ++i) {                                  \n\
               args[i] = arguments[i];                                       \n\
            }                                                                \n\
            args[i] = fn;                                                    \n\
            [CodeForCall]                                                    \n\
            break;                                                           \n\
        ".replace("[CodeForCall]", codeForCall);
        return ret;
    }

    return new Function("Promise",
                        "callback",
                        "receiver",
                        "withAppended",
                        "maybeWrapAsError",
                        "nodebackForPromise",
                        "INTERNAL","                                         \n\
        var ret = function FunctionName(Parameters) {                        \n\
            'use strict';                                                    \n\
            var len = arguments.length;                                      \n\
            var promise = new Promise(INTERNAL);                             \n\
            promise._setTrace(void 0);                                       \n\
            var fn = nodebackForPromise(promise);                            \n\
            try {                                                            \n\
                switch(len) {                                                \n\
                    [CodeForSwitchCase]                                      \n\
                }                                                            \n\
            } catch (e) {                                                    \n\
                var wrapped = maybeWrapAsError(e);                           \n\
                promise._attachExtraTrace(wrapped);                          \n\
                promise._reject(wrapped);                                    \n\
            }                                                                \n\
            return promise;                                                  \n\
        };                                                                   \n\
        ret.__isPromisified__ = true;                                        \n\
        return ret;                                                          \n\
        "
        .replace("FunctionName", callbackName)
        .replace("Parameters", parameterDeclaration(newParameterCount))
        .replace("[CodeForSwitchCase]", generateArgumentSwitchCase()))(
            Promise,
            callback,
            receiver,
            withAppended,
            maybeWrapAsError,
            nodebackForPromise,
            INTERNAL
        );
}

function makeNodePromisifiedClosure(callback, receiver) {
    function promisified() {
        var _receiver = receiver;
        if (receiver === THIS) _receiver = this;
        if (typeof callback === "string") {
            callback = _receiver[callback];
        }
        var promise = new Promise(INTERNAL);
        promise._setTrace(void 0);
        var fn = nodebackForPromise(promise);
        try {
            callback.apply(_receiver, withAppended(arguments, fn));
        } catch(e) {
            var wrapped = maybeWrapAsError(e);
            promise._attachExtraTrace(wrapped);
            promise._reject(wrapped);
        }
        return promise;
    }
    promisified.__isPromisified__ = true;
    return promisified;
}

var makeNodePromisified = canEvaluate
    ? makeNodePromisifiedEval
    : makeNodePromisifiedClosure;

function promisifyAll(obj, suffix, filter, promisifier) {
    var suffixRegexp = new RegExp(escapeIdentRegex(suffix) + "$");
    var methods =
        promisifiableMethods(obj, suffix, suffixRegexp, filter);

    for (var i = 0, len = methods.length; i < len; i+= 2) {
        var key = methods[i];
        var fn = methods[i+1];
        var promisifiedKey = key + suffix;
        obj[promisifiedKey] = promisifier === makeNodePromisified
                ? makeNodePromisified(key, THIS, key, fn, suffix)
                : promisifier(fn);
    }
    util.toFastProperties(obj);
    return obj;
}

function promisify(callback, receiver) {
    return makeNodePromisified(callback, receiver, void 0, callback);
}

Promise.promisify = function Promise$Promisify(fn, receiver) {
    if (typeof fn !== "function") {
        throw new TypeError("fn must be a function");
    }
    if (isPromisified(fn)) {
        return fn;
    }
    return promisify(fn, arguments.length < 2 ? THIS : receiver);
};

Promise.promisifyAll = function Promise$PromisifyAll(target, options) {
    if (typeof target !== "function" && typeof target !== "object") {
        throw new TypeError("the target of promisifyAll must be an object or a function");
    }
    options = Object(options);
    var suffix = options.suffix;
    if (typeof suffix !== "string") suffix = defaultSuffix;
    var filter = options.filter;
    if (typeof filter !== "function") filter = defaultFilter;
    var promisifier = options.promisifier;
    if (typeof promisifier !== "function") promisifier = makeNodePromisified;

    if (!util.isIdentifier(suffix)) {
        throw new RangeError("suffix must be a valid identifier");
    }

    var keys = util.inheritedDataKeys(target, {includeHidden: true});
    for (var i = 0; i < keys.length; ++i) {
        var value = target[keys[i]];
        if (keys[i] !== "constructor" &&
            util.isClass(value)) {
            promisifyAll(value.prototype, suffix, filter, promisifier);
            promisifyAll(value, suffix, filter, promisifier);
        }
    }

    return promisifyAll(target, suffix, filter, promisifier);
};
};


},{"./errors":119,"./promise_resolver.js":131,"./util.js":144}],133:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray, cast) {
var util = _dereq_("./util.js");
var apiRejection = _dereq_("./errors_api_rejection")(Promise);
var isObject = util.isObject;
var es5 = _dereq_("./es5.js");

function PropertiesPromiseArray(obj) {
    var keys = es5.keys(obj);
    var len = keys.length;
    var values = new Array(len * 2);
    for (var i = 0; i < len; ++i) {
        var key = keys[i];
        values[i] = obj[key];
        values[i + len] = key;
    }
    this.constructor$(values);
}
util.inherits(PropertiesPromiseArray, PromiseArray);

PropertiesPromiseArray.prototype._init =
function PropertiesPromiseArray$_init() {
    this._init$(void 0, -3) ;
};

PropertiesPromiseArray.prototype._promiseFulfilled =
function PropertiesPromiseArray$_promiseFulfilled(value, index) {
    if (this._isResolved()) return;
    this._values[index] = value;
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= this._length) {
        var val = {};
        var keyOffset = this.length();
        for (var i = 0, len = this.length(); i < len; ++i) {
            val[this._values[i + keyOffset]] = this._values[i];
        }
        this._resolve(val);
    }
};

PropertiesPromiseArray.prototype._promiseProgressed =
function PropertiesPromiseArray$_promiseProgressed(value, index) {
    if (this._isResolved()) return;

    this._promise._progress({
        key: this._values[index + this.length()],
        value: value
    });
};

PropertiesPromiseArray.prototype.shouldCopyValues =
function PropertiesPromiseArray$_shouldCopyValues() {
    return false;
};

PropertiesPromiseArray.prototype.getActualLength =
function PropertiesPromiseArray$getActualLength(len) {
    return len >> 1;
};

function Promise$_Props(promises) {
    var ret;
    var castValue = cast(promises, void 0);

    if (!isObject(castValue)) {
        return apiRejection("cannot await properties of a non-object");
    } else if (castValue instanceof Promise) {
        ret = castValue._then(Promise.props, void 0, void 0, void 0, void 0);
    } else {
        ret = new PropertiesPromiseArray(castValue).promise();
    }

    if (castValue instanceof Promise) {
        ret._propagateFrom(castValue, 4);
    }
    return ret;
}

Promise.prototype.props = function Promise$props() {
    return Promise$_Props(this);
};

Promise.props = function Promise$Props(promises) {
    return Promise$_Props(promises);
};
};

},{"./errors_api_rejection":120,"./es5.js":121,"./util.js":144}],134:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
function arrayCopy(src, srcIndex, dst, dstIndex, len) {
    for (var j = 0; j < len; ++j) {
        dst[j + dstIndex] = src[j + srcIndex];
    }
}

function Queue(capacity) {
    this._capacity = capacity;
    this._length = 0;
    this._front = 0;
    this._makeCapacity();
}

Queue.prototype._willBeOverCapacity =
function Queue$_willBeOverCapacity(size) {
    return this._capacity < size;
};

Queue.prototype._pushOne = function Queue$_pushOne(arg) {
    var length = this.length();
    this._checkCapacity(length + 1);
    var i = (this._front + length) & (this._capacity - 1);
    this[i] = arg;
    this._length = length + 1;
};

Queue.prototype.push = function Queue$push(fn, receiver, arg) {
    var length = this.length() + 3;
    if (this._willBeOverCapacity(length)) {
        this._pushOne(fn);
        this._pushOne(receiver);
        this._pushOne(arg);
        return;
    }
    var j = this._front + length - 3;
    this._checkCapacity(length);
    var wrapMask = this._capacity - 1;
    this[(j + 0) & wrapMask] = fn;
    this[(j + 1) & wrapMask] = receiver;
    this[(j + 2) & wrapMask] = arg;
    this._length = length;
};

Queue.prototype.shift = function Queue$shift() {
    var front = this._front,
        ret = this[front];

    this[front] = void 0;
    this._front = (front + 1) & (this._capacity - 1);
    this._length--;
    return ret;
};

Queue.prototype.length = function Queue$length() {
    return this._length;
};

Queue.prototype._makeCapacity = function Queue$_makeCapacity() {
    var len = this._capacity;
    for (var i = 0; i < len; ++i) {
        this[i] = void 0;
    }
};

Queue.prototype._checkCapacity = function Queue$_checkCapacity(size) {
    if (this._capacity < size) {
        this._resizeTo(this._capacity << 3);
    }
};

Queue.prototype._resizeTo = function Queue$_resizeTo(capacity) {
    var oldFront = this._front;
    var oldCapacity = this._capacity;
    var oldQueue = new Array(oldCapacity);
    var length = this.length();

    arrayCopy(this, 0, oldQueue, 0, oldCapacity);
    this._capacity = capacity;
    this._makeCapacity();
    this._front = 0;
    if (oldFront + length <= oldCapacity) {
        arrayCopy(oldQueue, oldFront, this, 0, length);
    } else {        var lengthBeforeWrapping =
            length - ((oldFront + length) & (oldCapacity - 1));

        arrayCopy(oldQueue, oldFront, this, 0, lengthBeforeWrapping);
        arrayCopy(oldQueue, 0, this, lengthBeforeWrapping,
                    length - lengthBeforeWrapping);
    }
};

module.exports = Queue;

},{}],135:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL, cast) {
var apiRejection = _dereq_("./errors_api_rejection.js")(Promise);
var isArray = _dereq_("./util.js").isArray;

var raceLater = function Promise$_raceLater(promise) {
    return promise.then(function(array) {
        return Promise$_Race(array, promise);
    });
};

var hasOwn = {}.hasOwnProperty;
function Promise$_Race(promises, parent) {
    var maybePromise = cast(promises, void 0);

    if (maybePromise instanceof Promise) {
        return raceLater(maybePromise);
    } else if (!isArray(promises)) {
        return apiRejection("expecting an array, a promise or a thenable");
    }

    var ret = new Promise(INTERNAL);
    if (parent !== void 0) {
        ret._propagateFrom(parent, 7);
    } else {
        ret._setTrace(void 0);
    }
    var fulfill = ret._fulfill;
    var reject = ret._reject;
    for (var i = 0, len = promises.length; i < len; ++i) {
        var val = promises[i];

        if (val === void 0 && !(hasOwn.call(promises, i))) {
            continue;
        }

        Promise.cast(val)._then(fulfill, reject, void 0, ret, null);
    }
    return ret;
}

Promise.race = function Promise$Race(promises) {
    return Promise$_Race(promises, void 0);
};

Promise.prototype.race = function Promise$race() {
    return Promise$_Race(this, void 0);
};

};

},{"./errors_api_rejection.js":120,"./util.js":144}],136:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray, apiRejection, cast, INTERNAL) {
var util = _dereq_("./util.js");
var tryCatch4 = util.tryCatch4;
var tryCatch3 = util.tryCatch3;
var errorObj = util.errorObj;
function ReductionPromiseArray(promises, fn, accum, _each) {
    this.constructor$(promises);
    this._preservedValues = _each === INTERNAL ? [] : null;
    this._zerothIsAccum = (accum === void 0);
    this._gotAccum = false;
    this._reducingIndex = (this._zerothIsAccum ? 1 : 0);
    this._valuesPhase = undefined;

    var maybePromise = cast(accum, void 0);
    var rejected = false;
    var isPromise = maybePromise instanceof Promise;
    if (isPromise) {
        if (maybePromise.isPending()) {
            maybePromise._proxyPromiseArray(this, -1);
        } else if (maybePromise.isFulfilled()) {
            accum = maybePromise.value();
            this._gotAccum = true;
        } else {
            maybePromise._unsetRejectionIsUnhandled();
            this._reject(maybePromise.reason());
            rejected = true;
        }
    }
    if (!(isPromise || this._zerothIsAccum)) this._gotAccum = true;
    this._callback = fn;
    this._accum = accum;
    if (!rejected) this._init$(void 0, -5);
}
util.inherits(ReductionPromiseArray, PromiseArray);

ReductionPromiseArray.prototype._init =
function ReductionPromiseArray$_init() {};

ReductionPromiseArray.prototype._resolveEmptyArray =
function ReductionPromiseArray$_resolveEmptyArray() {
    if (this._gotAccum || this._zerothIsAccum) {
        this._resolve(this._preservedValues !== null
                        ? [] : this._accum);
    }
};

ReductionPromiseArray.prototype._promiseFulfilled =
function ReductionPromiseArray$_promiseFulfilled(value, index) {
    var values = this._values;
    if (values === null) return;
    var length = this.length();
    var preservedValues = this._preservedValues;
    var isEach = preservedValues !== null;
    var gotAccum = this._gotAccum;
    var valuesPhase = this._valuesPhase;
    var valuesPhaseIndex;
    if (!valuesPhase) {
        valuesPhase = this._valuesPhase = Array(length);
        for (valuesPhaseIndex=0; valuesPhaseIndex<length; ++valuesPhaseIndex) {
            valuesPhase[valuesPhaseIndex] = 0;
        }
    }
    valuesPhaseIndex = valuesPhase[index];

    if (index === 0 && this._zerothIsAccum) {
        if (!gotAccum) {
            this._accum = value;
            this._gotAccum = gotAccum = true;
        }
        valuesPhase[index] = ((valuesPhaseIndex === 0)
            ? 1 : 2);
    } else if (index === -1) {
        if (!gotAccum) {
            this._accum = value;
            this._gotAccum = gotAccum = true;
        }
    } else {
        if (valuesPhaseIndex === 0) {
            valuesPhase[index] = 1;
        }
        else {
            valuesPhase[index] = 2;
            if (gotAccum) {
                this._accum = value;
            }
        }
    }
    if (!gotAccum) return;

    var callback = this._callback;
    var receiver = this._promise._boundTo;
    var ret;

    for (var i = this._reducingIndex; i < length; ++i) {
        valuesPhaseIndex = valuesPhase[i];
        if (valuesPhaseIndex === 2) {
            this._reducingIndex = i + 1;
            continue;
        }
        if (valuesPhaseIndex !== 1) return;

        value = values[i];
        if (value instanceof Promise) {
            if (value.isFulfilled()) {
                value = value._settledValue;
            } else if (value.isPending()) {
                return;
            } else {
                value._unsetRejectionIsUnhandled();
                return this._reject(value.reason());
            }
        }

        if (isEach) {
            preservedValues.push(value);
            ret = tryCatch3(callback, receiver, value, i, length);
        }
        else {
            ret = tryCatch4(callback, receiver, this._accum, value, i, length);
        }

        if (ret === errorObj) return this._reject(ret.e);

        var maybePromise = cast(ret, void 0);
        if (maybePromise instanceof Promise) {
            if (maybePromise.isPending()) {
                valuesPhase[i] = 4;
                return maybePromise._proxyPromiseArray(this, i);
            } else if (maybePromise.isFulfilled()) {
                ret = maybePromise.value();
            } else {
                maybePromise._unsetRejectionIsUnhandled();
                return this._reject(maybePromise.reason());
            }
        }

        this._reducingIndex = i + 1;
        this._accum = ret;
    }

    if (this._reducingIndex < length) return;
    this._resolve(isEach ? preservedValues : this._accum);
};

function reduce(promises, fn, initialValue, _each) {
    if (typeof fn !== "function") return apiRejection("fn must be a function");
    var array = new ReductionPromiseArray(promises, fn, initialValue, _each);
    return array.promise();
}

Promise.prototype.reduce = function Promise$reduce(fn, initialValue) {
    return reduce(this, fn, initialValue, null);
};

Promise.reduce = function Promise$Reduce(promises, fn, initialValue, _each) {
    return reduce(promises, fn, initialValue, _each);
};
};

},{"./util.js":144}],137:[function(_dereq_,module,exports){
(function (process){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var schedule;
var _MutationObserver;
if (typeof process === "object" && typeof process.version === "string") {
    schedule = function Promise$_Scheduler(fn) {
        process.nextTick(fn);
    };
}
else if ((typeof MutationObserver !== "undefined" &&
         (_MutationObserver = MutationObserver)) ||
         (typeof WebKitMutationObserver !== "undefined" &&
         (_MutationObserver = WebKitMutationObserver))) {
    schedule = (function() {
        var div = document.createElement("div");
        var queuedFn = void 0;
        var observer = new _MutationObserver(
            function Promise$_Scheduler() {
                var fn = queuedFn;
                queuedFn = void 0;
                fn();
            }
       );
        observer.observe(div, {
            attributes: true
        });
        return function Promise$_Scheduler(fn) {
            queuedFn = fn;
            div.classList.toggle("foo");
        };

    })();
}
else if (typeof setTimeout !== "undefined") {
    schedule = function Promise$_Scheduler(fn) {
        setTimeout(fn, 0);
    };
}
else throw new Error("no async scheduler available");
module.exports = schedule;

}).call(this,_dereq_("FWaASH"))
},{"FWaASH":166}],138:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports =
    function(Promise, PromiseArray) {
var PromiseInspection = Promise.PromiseInspection;
var util = _dereq_("./util.js");

function SettledPromiseArray(values) {
    this.constructor$(values);
}
util.inherits(SettledPromiseArray, PromiseArray);

SettledPromiseArray.prototype._promiseResolved =
function SettledPromiseArray$_promiseResolved(index, inspection) {
    this._values[index] = inspection;
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= this._length) {
        this._resolve(this._values);
    }
};

SettledPromiseArray.prototype._promiseFulfilled =
function SettledPromiseArray$_promiseFulfilled(value, index) {
    if (this._isResolved()) return;
    var ret = new PromiseInspection();
    ret._bitField = 268435456;
    ret._settledValue = value;
    this._promiseResolved(index, ret);
};
SettledPromiseArray.prototype._promiseRejected =
function SettledPromiseArray$_promiseRejected(reason, index) {
    if (this._isResolved()) return;
    var ret = new PromiseInspection();
    ret._bitField = 134217728;
    ret._settledValue = reason;
    this._promiseResolved(index, ret);
};

Promise.settle = function Promise$Settle(promises) {
    return new SettledPromiseArray(promises).promise();
};

Promise.prototype.settle = function Promise$settle() {
    return new SettledPromiseArray(this).promise();
};
};

},{"./util.js":144}],139:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports =
function(Promise, PromiseArray, apiRejection) {
var util = _dereq_("./util.js");
var RangeError = _dereq_("./errors.js").RangeError;
var AggregateError = _dereq_("./errors.js").AggregateError;
var isArray = util.isArray;


function SomePromiseArray(values) {
    this.constructor$(values);
    this._howMany = 0;
    this._unwrap = false;
    this._initialized = false;
}
util.inherits(SomePromiseArray, PromiseArray);

SomePromiseArray.prototype._init = function SomePromiseArray$_init() {
    if (!this._initialized) {
        return;
    }
    if (this._howMany === 0) {
        this._resolve([]);
        return;
    }
    this._init$(void 0, -5);
    var isArrayResolved = isArray(this._values);
    if (!this._isResolved() &&
        isArrayResolved &&
        this._howMany > this._canPossiblyFulfill()) {
        this._reject(this._getRangeError(this.length()));
    }
};

SomePromiseArray.prototype.init = function SomePromiseArray$init() {
    this._initialized = true;
    this._init();
};

SomePromiseArray.prototype.setUnwrap = function SomePromiseArray$setUnwrap() {
    this._unwrap = true;
};

SomePromiseArray.prototype.howMany = function SomePromiseArray$howMany() {
    return this._howMany;
};

SomePromiseArray.prototype.setHowMany =
function SomePromiseArray$setHowMany(count) {
    if (this._isResolved()) return;
    this._howMany = count;
};

SomePromiseArray.prototype._promiseFulfilled =
function SomePromiseArray$_promiseFulfilled(value) {
    if (this._isResolved()) return;
    this._addFulfilled(value);
    if (this._fulfilled() === this.howMany()) {
        this._values.length = this.howMany();
        if (this.howMany() === 1 && this._unwrap) {
            this._resolve(this._values[0]);
        } else {
            this._resolve(this._values);
        }
    }

};
SomePromiseArray.prototype._promiseRejected =
function SomePromiseArray$_promiseRejected(reason) {
    if (this._isResolved()) return;
    this._addRejected(reason);
    if (this.howMany() > this._canPossiblyFulfill()) {
        var e = new AggregateError();
        for (var i = this.length(); i < this._values.length; ++i) {
            e.push(this._values[i]);
        }
        this._reject(e);
    }
};

SomePromiseArray.prototype._fulfilled = function SomePromiseArray$_fulfilled() {
    return this._totalResolved;
};

SomePromiseArray.prototype._rejected = function SomePromiseArray$_rejected() {
    return this._values.length - this.length();
};

SomePromiseArray.prototype._addRejected =
function SomePromiseArray$_addRejected(reason) {
    this._values.push(reason);
};

SomePromiseArray.prototype._addFulfilled =
function SomePromiseArray$_addFulfilled(value) {
    this._values[this._totalResolved++] = value;
};

SomePromiseArray.prototype._canPossiblyFulfill =
function SomePromiseArray$_canPossiblyFulfill() {
    return this.length() - this._rejected();
};

SomePromiseArray.prototype._getRangeError =
function SomePromiseArray$_getRangeError(count) {
    var message = "Input array must contain at least " +
            this._howMany + " items but contains only " + count + " items";
    return new RangeError(message);
};

SomePromiseArray.prototype._resolveEmptyArray =
function SomePromiseArray$_resolveEmptyArray() {
    this._reject(this._getRangeError(0));
};

function Promise$_Some(promises, howMany) {
    if ((howMany | 0) !== howMany || howMany < 0) {
        return apiRejection("expecting a positive integer");
    }
    var ret = new SomePromiseArray(promises);
    var promise = ret.promise();
    if (promise.isRejected()) {
        return promise;
    }
    ret.setHowMany(howMany);
    ret.init();
    return promise;
}

Promise.some = function Promise$Some(promises, howMany) {
    return Promise$_Some(promises, howMany);
};

Promise.prototype.some = function Promise$some(howMany) {
    return Promise$_Some(this, howMany);
};

Promise._SomePromiseArray = SomePromiseArray;
};

},{"./errors.js":119,"./util.js":144}],140:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
function PromiseInspection(promise) {
    if (promise !== void 0) {
        this._bitField = promise._bitField;
        this._settledValue = promise.isResolved()
            ? promise._settledValue
            : void 0;
    }
    else {
        this._bitField = 0;
        this._settledValue = void 0;
    }
}

PromiseInspection.prototype.isFulfilled =
Promise.prototype.isFulfilled = function Promise$isFulfilled() {
    return (this._bitField & 268435456) > 0;
};

PromiseInspection.prototype.isRejected =
Promise.prototype.isRejected = function Promise$isRejected() {
    return (this._bitField & 134217728) > 0;
};

PromiseInspection.prototype.isPending =
Promise.prototype.isPending = function Promise$isPending() {
    return (this._bitField & 402653184) === 0;
};

PromiseInspection.prototype.value =
Promise.prototype.value = function Promise$value() {
    if (!this.isFulfilled()) {
        throw new TypeError("cannot get fulfillment value of a non-fulfilled promise");
    }
    return this._settledValue;
};

PromiseInspection.prototype.error =
PromiseInspection.prototype.reason =
Promise.prototype.reason = function Promise$reason() {
    if (!this.isRejected()) {
        throw new TypeError("cannot get rejection reason of a non-rejected promise");
    }
    return this._settledValue;
};

PromiseInspection.prototype.isResolved =
Promise.prototype.isResolved = function Promise$isResolved() {
    return (this._bitField & 402653184) > 0;
};

Promise.PromiseInspection = PromiseInspection;
};

},{}],141:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var util = _dereq_("./util.js");
var canAttach = _dereq_("./errors.js").canAttach;
var errorObj = util.errorObj;
var isObject = util.isObject;

function getThen(obj) {
    try {
        return obj.then;
    }
    catch(e) {
        errorObj.e = e;
        return errorObj;
    }
}

function Promise$_Cast(obj, originalPromise) {
    if (isObject(obj)) {
        if (obj instanceof Promise) {
            return obj;
        }
        else if (isAnyBluebirdPromise(obj)) {
            var ret = new Promise(INTERNAL);
            ret._setTrace(void 0);
            obj._then(
                ret._fulfillUnchecked,
                ret._rejectUncheckedCheckError,
                ret._progressUnchecked,
                ret,
                null
            );
            ret._setFollowing();
            return ret;
        }
        var then = getThen(obj);
        if (then === errorObj) {
            if (originalPromise !== void 0 && canAttach(then.e)) {
                originalPromise._attachExtraTrace(then.e);
            }
            return Promise.reject(then.e);
        } else if (typeof then === "function") {
            return Promise$_doThenable(obj, then, originalPromise);
        }
    }
    return obj;
}

var hasProp = {}.hasOwnProperty;
function isAnyBluebirdPromise(obj) {
    return hasProp.call(obj, "_promise0");
}

function Promise$_doThenable(x, then, originalPromise) {
    var resolver = Promise.defer();
    var called = false;
    try {
        then.call(
            x,
            Promise$_resolveFromThenable,
            Promise$_rejectFromThenable,
            Promise$_progressFromThenable
        );
    } catch(e) {
        if (!called) {
            called = true;
            var trace = canAttach(e) ? e : new Error(e + "");
            if (originalPromise !== void 0) {
                originalPromise._attachExtraTrace(trace);
            }
            resolver.promise._reject(e, trace);
        }
    }
    return resolver.promise;

    function Promise$_resolveFromThenable(y) {
        if (called) return;
        called = true;

        if (x === y) {
            var e = Promise._makeSelfResolutionError();
            if (originalPromise !== void 0) {
                originalPromise._attachExtraTrace(e);
            }
            resolver.promise._reject(e, void 0);
            return;
        }
        resolver.resolve(y);
    }

    function Promise$_rejectFromThenable(r) {
        if (called) return;
        called = true;
        var trace = canAttach(r) ? r : new Error(r + "");
        if (originalPromise !== void 0) {
            originalPromise._attachExtraTrace(trace);
        }
        resolver.promise._reject(r, trace);
    }

    function Promise$_progressFromThenable(v) {
        if (called) return;
        var promise = resolver.promise;
        if (typeof promise._progress === "function") {
            promise._progress(v);
        }
    }
}

return Promise$_Cast;
};

},{"./errors.js":119,"./util.js":144}],142:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var _setTimeout = function(fn, ms) {
    var len = arguments.length;
    var arg0 = arguments[2];
    var arg1 = arguments[3];
    var arg2 = len >= 5 ? arguments[4] : void 0;
    setTimeout(function() {
        fn(arg0, arg1, arg2);
    }, ms|0);
};

module.exports = function(Promise, INTERNAL, cast) {
var util = _dereq_("./util.js");
var errors = _dereq_("./errors.js");
var apiRejection = _dereq_("./errors_api_rejection")(Promise);
var TimeoutError = Promise.TimeoutError;

var afterTimeout = function Promise$_afterTimeout(promise, message, ms) {
    if (!promise.isPending()) return;
    if (typeof message !== "string") {
        message = "operation timed out after" + " " + ms + " ms"
    }
    var err = new TimeoutError(message);
    errors.markAsOriginatingFromRejection(err);
    promise._attachExtraTrace(err);
    promise._cancel(err);
};

var afterDelay = function Promise$_afterDelay(value, promise) {
    promise._fulfill(value);
};

var delay = Promise.delay = function Promise$Delay(value, ms) {
    if (ms === void 0) {
        ms = value;
        value = void 0;
    }
    ms = +ms;
    var maybePromise = cast(value, void 0);
    var promise = new Promise(INTERNAL);

    if (maybePromise instanceof Promise) {
        promise._propagateFrom(maybePromise, 7);
        promise._follow(maybePromise);
        return promise.then(function(value) {
            return Promise.delay(value, ms);
        });
    } else {
        promise._setTrace(void 0);
        _setTimeout(afterDelay, ms, value, promise);
    }
    return promise;
};

Promise.prototype.delay = function Promise$delay(ms) {
    return delay(this, ms);
};

Promise.prototype.timeout = function Promise$timeout(ms, message) {
    ms = +ms;

    var ret = new Promise(INTERNAL);
    ret._propagateFrom(this, 7);
    ret._follow(this);
    _setTimeout(afterTimeout, ms, ret, message, ms);
    return ret.cancellable();
};

};

},{"./errors.js":119,"./errors_api_rejection":120,"./util.js":144}],143:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function (Promise, apiRejection, cast) {
    var TypeError = _dereq_("./errors.js").TypeError;
    var inherits = _dereq_("./util.js").inherits;
    var PromiseInspection = Promise.PromiseInspection;

    function inspectionMapper(inspections) {
        var len = inspections.length;
        for (var i = 0; i < len; ++i) {
            var inspection = inspections[i];
            if (inspection.isRejected()) {
                return Promise.reject(inspection.error());
            }
            inspections[i] = inspection.value();
        }
        return inspections;
    }

    function thrower(e) {
        setTimeout(function(){throw e;}, 0);
    }

    function castPreservingDisposable(thenable) {
        var maybePromise = cast(thenable, void 0);
        if (maybePromise !== thenable &&
            typeof thenable._isDisposable === "function" &&
            typeof thenable._getDisposer === "function" &&
            thenable._isDisposable()) {
            maybePromise._setDisposable(thenable._getDisposer());
        }
        return maybePromise;
    }
    function dispose(resources, inspection) {
        var i = 0;
        var len = resources.length;
        var ret = Promise.defer();
        function iterator() {
            if (i >= len) return ret.resolve();
            var maybePromise = castPreservingDisposable(resources[i++]);
            if (maybePromise instanceof Promise &&
                maybePromise._isDisposable()) {
                try {
                    maybePromise = cast(maybePromise._getDisposer()
                                        .tryDispose(inspection), void 0);
                } catch (e) {
                    return thrower(e);
                }
                if (maybePromise instanceof Promise) {
                    return maybePromise._then(iterator, thrower,
                                              null, null, null);
                }
            }
            iterator();
        }
        iterator();
        return ret.promise;
    }

    function disposerSuccess(value) {
        var inspection = new PromiseInspection();
        inspection._settledValue = value;
        inspection._bitField = 268435456;
        return dispose(this, inspection).thenReturn(value);
    }

    function disposerFail(reason) {
        var inspection = new PromiseInspection();
        inspection._settledValue = reason;
        inspection._bitField = 134217728;
        return dispose(this, inspection).thenThrow(reason);
    }

    function Disposer(data, promise) {
        this._data = data;
        this._promise = promise;
    }

    Disposer.prototype.data = function Disposer$data() {
        return this._data;
    };

    Disposer.prototype.promise = function Disposer$promise() {
        return this._promise;
    };

    Disposer.prototype.resource = function Disposer$resource() {
        if (this.promise().isFulfilled()) {
            return this.promise().value();
        }
        return null;
    };

    Disposer.prototype.tryDispose = function(inspection) {
        var resource = this.resource();
        var ret = resource !== null
            ? this.doDispose(resource, inspection) : null;
        this._promise._unsetDisposable();
        this._data = this._promise = null;
        return ret;
    };

    Disposer.isDisposer = function Disposer$isDisposer(d) {
        return (d != null &&
                typeof d.resource === "function" &&
                typeof d.tryDispose === "function");
    };

    function FunctionDisposer(fn, promise) {
        this.constructor$(fn, promise);
    }
    inherits(FunctionDisposer, Disposer);

    FunctionDisposer.prototype.doDispose = function (resource, inspection) {
        var fn = this.data();
        return fn.call(resource, resource, inspection);
    };

    Promise.using = function Promise$using() {
        var len = arguments.length;
        if (len < 2) return apiRejection(
                        "you must pass at least 2 arguments to Promise.using");
        var fn = arguments[len - 1];
        if (typeof fn !== "function") return apiRejection("fn must be a function");
        len--;
        var resources = new Array(len);
        for (var i = 0; i < len; ++i) {
            var resource = arguments[i];
            if (Disposer.isDisposer(resource)) {
                var disposer = resource;
                resource = resource.promise();
                resource._setDisposable(disposer);
            }
            resources[i] = resource;
        }

        return Promise.settle(resources)
            .then(inspectionMapper)
            .spread(fn)
            ._then(disposerSuccess, disposerFail, void 0, resources, void 0);
    };

    Promise.prototype._setDisposable =
    function Promise$_setDisposable(disposer) {
        this._bitField = this._bitField | 262144;
        this._disposer = disposer;
    };

    Promise.prototype._isDisposable = function Promise$_isDisposable() {
        return (this._bitField & 262144) > 0;
    };

    Promise.prototype._getDisposer = function Promise$_getDisposer() {
        return this._disposer;
    };

    Promise.prototype._unsetDisposable = function Promise$_unsetDisposable() {
        this._bitField = this._bitField & (~262144);
        this._disposer = void 0;
    };

    Promise.prototype.disposer = function Promise$disposer(fn) {
        if (typeof fn === "function") {
            return new FunctionDisposer(fn, this);
        }
        throw new TypeError();
    };

};

},{"./errors.js":119,"./util.js":144}],144:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var es5 = _dereq_("./es5.js");
var haveGetters = (function(){
    try {
        var o = {};
        es5.defineProperty(o, "f", {
            get: function () {
                return 3;
            }
        });
        return o.f === 3;
    }
    catch (e) {
        return false;
    }

})();
var canEvaluate = typeof navigator == "undefined";
var errorObj = {e: {}};
function tryCatch1(fn, receiver, arg) {
    try { return fn.call(receiver, arg); }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

function tryCatch2(fn, receiver, arg, arg2) {
    try { return fn.call(receiver, arg, arg2); }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

function tryCatch3(fn, receiver, arg, arg2, arg3) {
    try { return fn.call(receiver, arg, arg2, arg3); }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

function tryCatch4(fn, receiver, arg, arg2, arg3, arg4) {
    try { return fn.call(receiver, arg, arg2, arg3, arg4); }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

function tryCatchApply(fn, args, receiver) {
    try { return fn.apply(receiver, args); }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

var inherits = function(Child, Parent) {
    var hasProp = {}.hasOwnProperty;

    function T() {
        this.constructor = Child;
        this.constructor$ = Parent;
        for (var propertyName in Parent.prototype) {
            if (hasProp.call(Parent.prototype, propertyName) &&
                propertyName.charAt(propertyName.length-1) !== "$"
           ) {
                this[propertyName + "$"] = Parent.prototype[propertyName];
            }
        }
    }
    T.prototype = Parent.prototype;
    Child.prototype = new T();
    return Child.prototype;
};

function asString(val) {
    return typeof val === "string" ? val : ("" + val);
}

function isPrimitive(val) {
    return val == null || val === true || val === false ||
        typeof val === "string" || typeof val === "number";

}

function isObject(value) {
    return !isPrimitive(value);
}

function maybeWrapAsError(maybeError) {
    if (!isPrimitive(maybeError)) return maybeError;

    return new Error(asString(maybeError));
}

function withAppended(target, appendee) {
    var len = target.length;
    var ret = new Array(len + 1);
    var i;
    for (i = 0; i < len; ++i) {
        ret[i] = target[i];
    }
    ret[i] = appendee;
    return ret;
}

function getDataPropertyOrDefault(obj, key, defaultValue) {
    if (es5.isES5) {
        var desc = Object.getOwnPropertyDescriptor(obj, key);
        if (desc != null) {
            return desc.get == null && desc.set == null
                    ? desc.value
                    : defaultValue;
        }
    } else {
        return {}.hasOwnProperty.call(obj, key) ? obj[key] : void 0;
    }
}

function notEnumerableProp(obj, name, value) {
    if (isPrimitive(obj)) return obj;
    var descriptor = {
        value: value,
        configurable: true,
        enumerable: false,
        writable: true
    };
    es5.defineProperty(obj, name, descriptor);
    return obj;
}


var wrapsPrimitiveReceiver = (function() {
    return this !== "string";
}).call("string");

function thrower(r) {
    throw r;
}

var inheritedDataKeys = (function() {
    if (es5.isES5) {
        return function(obj, opts) {
            var ret = [];
            var visitedKeys = Object.create(null);
            var getKeys = Object(opts).includeHidden
                ? Object.getOwnPropertyNames
                : Object.keys;
            while (obj != null) {
                var keys;
                try {
                    keys = getKeys(obj);
                } catch (e) {
                    return ret;
                }
                for (var i = 0; i < keys.length; ++i) {
                    var key = keys[i];
                    if (visitedKeys[key]) continue;
                    visitedKeys[key] = true;
                    var desc = Object.getOwnPropertyDescriptor(obj, key);
                    if (desc != null && desc.get == null && desc.set == null) {
                        ret.push(key);
                    }
                }
                obj = es5.getPrototypeOf(obj);
            }
            return ret;
        };
    } else {
        return function(obj) {
            var ret = [];
            /*jshint forin:false */
            for (var key in obj) {
                ret.push(key);
            }
            return ret;
        };
    }

})();

function isClass(fn) {
    try {
        if (typeof fn === "function") {
            var keys = es5.keys(fn.prototype);
            return keys.length > 0 &&
                   !(keys.length === 1 && keys[0] === "constructor");
        }
        return false;
    } catch (e) {
        return false;
    }
}

function toFastProperties(obj) {
    /*jshint -W027*/
    function f() {}
    f.prototype = obj;
    return f;
    eval(obj);
}

var rident = /^[a-z$_][a-z$_0-9]*$/i;
function isIdentifier(str) {
    return rident.test(str);
}

function filledRange(count, prefix, suffix) {
    var ret = new Array(count);
    for(var i = 0; i < count; ++i) {
        ret[i] = prefix + i + suffix;
    }
    return ret;
}

var ret = {
    isClass: isClass,
    isIdentifier: isIdentifier,
    inheritedDataKeys: inheritedDataKeys,
    getDataPropertyOrDefault: getDataPropertyOrDefault,
    thrower: thrower,
    isArray: es5.isArray,
    haveGetters: haveGetters,
    notEnumerableProp: notEnumerableProp,
    isPrimitive: isPrimitive,
    isObject: isObject,
    canEvaluate: canEvaluate,
    errorObj: errorObj,
    tryCatch1: tryCatch1,
    tryCatch2: tryCatch2,
    tryCatch3: tryCatch3,
    tryCatch4: tryCatch4,
    tryCatchApply: tryCatchApply,
    inherits: inherits,
    withAppended: withAppended,
    asString: asString,
    maybeWrapAsError: maybeWrapAsError,
    wrapsPrimitiveReceiver: wrapsPrimitiveReceiver,
    toFastProperties: toFastProperties,
    filledRange: filledRange
};

module.exports = ret;

},{"./es5.js":121}],145:[function(_dereq_,module,exports){
// Browser Request
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var XHR = XMLHttpRequest
if (!XHR) throw new Error('missing XMLHttpRequest')
request.log = {
  'trace': noop, 'debug': noop, 'info': noop, 'warn': noop, 'error': noop
}

var DEFAULT_TIMEOUT = 3 * 60 * 1000 // 3 minutes

//
// request
//

function request(options, callback) {
  // The entry-point to the API: prep the options object and pass the real work to run_xhr.
  if(typeof callback !== 'function')
    throw new Error('Bad callback given: ' + callback)

  if(!options)
    throw new Error('No options given')

  var options_onResponse = options.onResponse; // Save this for later.

  if(typeof options === 'string')
    options = {'uri':options};
  else
    options = JSON.parse(JSON.stringify(options)); // Use a duplicate for mutating.

  options.onResponse = options_onResponse // And put it back.

  if (options.verbose) request.log = getLogger();

  if(options.url) {
    options.uri = options.url;
    delete options.url;
  }

  if(!options.uri && options.uri !== "")
    throw new Error("options.uri is a required argument");

  if(typeof options.uri != "string")
    throw new Error("options.uri must be a string");

  var unsupported_options = ['proxy', '_redirectsFollowed', 'maxRedirects', 'followRedirect']
  for (var i = 0; i < unsupported_options.length; i++)
    if(options[ unsupported_options[i] ])
      throw new Error("options." + unsupported_options[i] + " is not supported")

  options.callback = callback
  options.method = options.method || 'GET';
  options.headers = options.headers || {};
  options.body    = options.body || null
  options.timeout = options.timeout || request.DEFAULT_TIMEOUT

  if(options.headers.host)
    throw new Error("Options.headers.host is not supported");

  if(options.json) {
    options.headers.accept = options.headers.accept || 'application/json'
    if(options.method !== 'GET')
      options.headers['content-type'] = 'application/json'

    if(typeof options.json !== 'boolean')
      options.body = JSON.stringify(options.json)
    else if(typeof options.body !== 'string')
      options.body = JSON.stringify(options.body)
  }
  
  //BEGIN QS Hack
  var serialize = function(obj) {
    var str = [];
    for(var p in obj)
      if (obj.hasOwnProperty(p)) {
        str.push(encodeURIComponent(p) + "=" + encodeURIComponent(obj[p]));
      }
    return str.join("&");
  }
  
  if(options.qs){
    var qs = (typeof options.qs == 'string')? options.qs : serialize(options.qs);
    if(options.uri.indexOf('?') !== -1){ //no get params
        options.uri = options.uri+'&'+qs;
    }else{ //existing get params
        options.uri = options.uri+'?'+qs;
    }
  }
  //END QS Hack
  
  //BEGIN FORM Hack
  var multipart = function(obj) {
    //todo: support file type (useful?)
    var result = {};
    result.boundry = '-------------------------------'+Math.floor(Math.random()*1000000000);
    var lines = [];
    for(var p in obj){
        if (obj.hasOwnProperty(p)) {
            lines.push(
                '--'+result.boundry+"\n"+
                'Content-Disposition: form-data; name="'+p+'"'+"\n"+
                "\n"+
                obj[p]+"\n"
            );
        }
    }
    lines.push( '--'+result.boundry+'--' );
    result.body = lines.join('');
    result.length = result.body.length;
    result.type = 'multipart/form-data; boundary='+result.boundry;
    return result;
  }
  
  if(options.form){
    if(typeof options.form == 'string') throw('form name unsupported');
    if(options.method === 'POST'){
        var encoding = (options.encoding || 'application/x-www-form-urlencoded').toLowerCase();
        options.headers['content-type'] = encoding;
        switch(encoding){
            case 'application/x-www-form-urlencoded':
                options.body = serialize(options.form).replace(/%20/g, "+");
                break;
            case 'multipart/form-data':
                var multi = multipart(options.form);
                //options.headers['content-length'] = multi.length;
                options.body = multi.body;
                options.headers['content-type'] = multi.type;
                break;
            default : throw new Error('unsupported encoding:'+encoding);
        }
    }
  }
  //END FORM Hack

  // If onResponse is boolean true, call back immediately when the response is known,
  // not when the full request is complete.
  options.onResponse = options.onResponse || noop
  if(options.onResponse === true) {
    options.onResponse = callback
    options.callback = noop
  }

  // XXX Browsers do not like this.
  //if(options.body)
  //  options.headers['content-length'] = options.body.length;

  // HTTP basic authentication
  if(!options.headers.authorization && options.auth)
    options.headers.authorization = 'Basic ' + b64_enc(options.auth.username + ':' + options.auth.password);

  return run_xhr(options)
}

var req_seq = 0
function run_xhr(options) {
  var xhr = new XHR
    , timed_out = false
    , is_cors = is_crossDomain(options.uri)
    , supports_cors = ('withCredentials' in xhr)

  req_seq += 1
  xhr.seq_id = req_seq
  xhr.id = req_seq + ': ' + options.method + ' ' + options.uri
  xhr._id = xhr.id // I know I will type "_id" from habit all the time.

  if(is_cors && !supports_cors) {
    var cors_err = new Error('Browser does not support cross-origin request: ' + options.uri)
    cors_err.cors = 'unsupported'
    return options.callback(cors_err, xhr)
  }

  xhr.timeoutTimer = setTimeout(too_late, options.timeout)
  function too_late() {
    timed_out = true
    var er = new Error('ETIMEDOUT')
    er.code = 'ETIMEDOUT'
    er.duration = options.timeout

    request.log.error('Timeout', { 'id':xhr._id, 'milliseconds':options.timeout })
    return options.callback(er, xhr)
  }

  // Some states can be skipped over, so remember what is still incomplete.
  var did = {'response':false, 'loading':false, 'end':false}

  xhr.onreadystatechange = on_state_change
  xhr.open(options.method, options.uri, true) // asynchronous
  if(is_cors)
    xhr.withCredentials = !! options.withCredentials
  xhr.send(options.body)
  return xhr

  function on_state_change(event) {
    if(timed_out)
      return request.log.debug('Ignoring timed out state change', {'state':xhr.readyState, 'id':xhr.id})

    request.log.debug('State change', {'state':xhr.readyState, 'id':xhr.id, 'timed_out':timed_out})

    if(xhr.readyState === XHR.OPENED) {
      request.log.debug('Request started', {'id':xhr.id})
      for (var key in options.headers)
        xhr.setRequestHeader(key, options.headers[key])
    }

    else if(xhr.readyState === XHR.HEADERS_RECEIVED)
      on_response()

    else if(xhr.readyState === XHR.LOADING) {
      on_response()
      on_loading()
    }

    else if(xhr.readyState === XHR.DONE) {
      on_response()
      on_loading()
      on_end()
    }
  }

  function on_response() {
    if(did.response)
      return

    did.response = true
    request.log.debug('Got response', {'id':xhr.id, 'status':xhr.status})
    clearTimeout(xhr.timeoutTimer)
    xhr.statusCode = xhr.status // Node request compatibility

    // Detect failed CORS requests.
    if(is_cors && xhr.statusCode == 0) {
      var cors_err = new Error('CORS request rejected: ' + options.uri)
      cors_err.cors = 'rejected'

      // Do not process this request further.
      did.loading = true
      did.end = true

      return options.callback(cors_err, xhr)
    }

    options.onResponse(null, xhr)
  }

  function on_loading() {
    if(did.loading)
      return

    did.loading = true
    request.log.debug('Response body loading', {'id':xhr.id})
    // TODO: Maybe simulate "data" events by watching xhr.responseText
  }

  function on_end() {
    if(did.end)
      return

    did.end = true
    request.log.debug('Request done', {'id':xhr.id})

    xhr.body = xhr.responseText
    if(options.json) {
      try        { xhr.body = JSON.parse(xhr.responseText) }
      catch (er) { return options.callback(er, xhr)        }
    }

    options.callback(null, xhr, xhr.body)
  }

} // request

request.withCredentials = false;
request.DEFAULT_TIMEOUT = DEFAULT_TIMEOUT;

//
// defaults
//

request.defaults = function(options, requester) {
  var def = function (method) {
    var d = function (params, callback) {
      if(typeof params === 'string')
        params = {'uri': params};
      else {
        params = JSON.parse(JSON.stringify(params));
      }
      for (var i in options) {
        if (params[i] === undefined) params[i] = options[i]
      }
      return method(params, callback)
    }
    return d
  }
  var de = def(request)
  de.get = def(request.get)
  de.post = def(request.post)
  de.put = def(request.put)
  de.head = def(request.head)
  return de
}

//
// HTTP method shortcuts
//

var shortcuts = [ 'get', 'put', 'post', 'head' ];
shortcuts.forEach(function(shortcut) {
  var method = shortcut.toUpperCase();
  var func   = shortcut.toLowerCase();

  request[func] = function(opts) {
    if(typeof opts === 'string')
      opts = {'method':method, 'uri':opts};
    else {
      opts = JSON.parse(JSON.stringify(opts));
      opts.method = method;
    }

    var args = [opts].concat(Array.prototype.slice.apply(arguments, [1]));
    return request.apply(this, args);
  }
})

//
// CouchDB shortcut
//

request.couch = function(options, callback) {
  if(typeof options === 'string')
    options = {'uri':options}

  // Just use the request API to do JSON.
  options.json = true
  if(options.body)
    options.json = options.body
  delete options.body

  callback = callback || noop

  var xhr = request(options, couch_handler)
  return xhr

  function couch_handler(er, resp, body) {
    if(er)
      return callback(er, resp, body)

    if((resp.statusCode < 200 || resp.statusCode > 299) && body.error) {
      // The body is a Couch JSON object indicating the error.
      er = new Error('CouchDB error: ' + (body.error.reason || body.error.error))
      for (var key in body)
        er[key] = body[key]
      return callback(er, resp, body);
    }

    return callback(er, resp, body);
  }
}

//
// Utility
//

function noop() {}

function getLogger() {
  var logger = {}
    , levels = ['trace', 'debug', 'info', 'warn', 'error']
    , level, i

  for(i = 0; i < levels.length; i++) {
    level = levels[i]

    logger[level] = noop
    if(typeof console !== 'undefined' && console && console[level])
      logger[level] = formatted(console, level)
  }

  return logger
}

function formatted(obj, method) {
  return formatted_logger

  function formatted_logger(str, context) {
    if(typeof context === 'object')
      str += ' ' + JSON.stringify(context)

    return obj[method].call(obj, str)
  }
}

// Return whether a URL is a cross-domain request.
function is_crossDomain(url) {
  var rurl = /^([\w\+\.\-]+:)(?:\/\/([^\/?#:]*)(?::(\d+))?)?/

  // jQuery #8138, IE may throw an exception when accessing
  // a field from window.location if document.domain has been set
  var ajaxLocation
  try { ajaxLocation = location.href }
  catch (e) {
    // Use the href attribute of an A element since IE will modify it given document.location
    ajaxLocation = document.createElement( "a" );
    ajaxLocation.href = "";
    ajaxLocation = ajaxLocation.href;
  }

  var ajaxLocParts = rurl.exec(ajaxLocation.toLowerCase()) || []
    , parts = rurl.exec(url.toLowerCase() )

  var result = !!(
    parts &&
    (  parts[1] != ajaxLocParts[1]
    || parts[2] != ajaxLocParts[2]
    || (parts[3] || (parts[1] === "http:" ? 80 : 443)) != (ajaxLocParts[3] || (ajaxLocParts[1] === "http:" ? 80 : 443))
    )
  )

  //console.debug('is_crossDomain('+url+') -> ' + result)
  return result
}

// MIT License from http://phpjs.org/functions/base64_encode:358
function b64_enc (data) {
    // Encodes string using MIME base64 algorithm
    var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var o1, o2, o3, h1, h2, h3, h4, bits, i = 0, ac = 0, enc="", tmp_arr = [];

    if (!data) {
        return data;
    }

    // assume utf8 data
    // data = this.utf8_encode(data+'');

    do { // pack three octets into four hexets
        o1 = data.charCodeAt(i++);
        o2 = data.charCodeAt(i++);
        o3 = data.charCodeAt(i++);

        bits = o1<<16 | o2<<8 | o3;

        h1 = bits>>18 & 0x3f;
        h2 = bits>>12 & 0x3f;
        h3 = bits>>6 & 0x3f;
        h4 = bits & 0x3f;

        // use hexets to index into b64, and append result to encoded string
        tmp_arr[ac++] = b64.charAt(h1) + b64.charAt(h2) + b64.charAt(h3) + b64.charAt(h4);
    } while (i < data.length);

    enc = tmp_arr.join('');

    switch (data.length % 3) {
        case 1:
            enc = enc.slice(0, -2) + '==';
        break;
        case 2:
            enc = enc.slice(0, -1) + '=';
        break;
    }

    return enc;
}
module.exports = request;

},{}],146:[function(_dereq_,module,exports){

},{}],147:[function(_dereq_,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */

var base64 = _dereq_('base64-js')
var ieee754 = _dereq_('ieee754')
var isArray = _dereq_('is-array')

exports.Buffer = Buffer
exports.SlowBuffer = Buffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192 // not used by this implementation

var kMaxLength = 0x3fffffff

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Note:
 *
 * - Implementation must support adding new properties to `Uint8Array` instances.
 *   Firefox 4-29 lacked support, fixed in Firefox 30+.
 *   See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *  - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *  - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *    incorrect length in some situations.
 *
 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they will
 * get the Object implementation, which is slower but will work correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = (function () {
  try {
    var buf = new ArrayBuffer(0)
    var arr = new Uint8Array(buf)
    arr.foo = function () { return 42 }
    return 42 === arr.foo() && // typed array instances can be augmented
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        new Uint8Array(1).subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
})()

/**
 * Class: Buffer
 * =============
 *
 * The Buffer constructor returns instances of `Uint8Array` that are augmented
 * with function properties for all the node `Buffer` API functions. We use
 * `Uint8Array` so that square bracket notation works as expected -- it returns
 * a single octet.
 *
 * By augmenting the instances, we can avoid modifying the `Uint8Array`
 * prototype.
 */
function Buffer (subject, encoding, noZero) {
  if (!(this instanceof Buffer))
    return new Buffer(subject, encoding, noZero)

  var type = typeof subject

  // Find the length
  var length
  if (type === 'number')
    length = subject > 0 ? subject >>> 0 : 0
  else if (type === 'string') {
    if (encoding === 'base64')
      subject = base64clean(subject)
    length = Buffer.byteLength(subject, encoding)
  } else if (type === 'object' && subject !== null) { // assume object is array-like
    if (subject.type === 'Buffer' && isArray(subject.data))
      subject = subject.data
    length = +subject.length > 0 ? Math.floor(+subject.length) : 0
  } else
    throw new TypeError('must start with number, buffer, array or string')

  if (this.length > kMaxLength)
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
      'size: 0x' + kMaxLength.toString(16) + ' bytes')

  var buf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Preferred: Return an augmented `Uint8Array` instance for best performance
    buf = Buffer._augment(new Uint8Array(length))
  } else {
    // Fallback: Return THIS instance of Buffer (created by `new`)
    buf = this
    buf.length = length
    buf._isBuffer = true
  }

  var i
  if (Buffer.TYPED_ARRAY_SUPPORT && typeof subject.byteLength === 'number') {
    // Speed optimization -- use set if we're copying from a typed array
    buf._set(subject)
  } else if (isArrayish(subject)) {
    // Treat array-ish objects as a byte array
    if (Buffer.isBuffer(subject)) {
      for (i = 0; i < length; i++)
        buf[i] = subject.readUInt8(i)
    } else {
      for (i = 0; i < length; i++)
        buf[i] = ((subject[i] % 256) + 256) % 256
    }
  } else if (type === 'string') {
    buf.write(subject, 0, encoding)
  } else if (type === 'number' && !Buffer.TYPED_ARRAY_SUPPORT && !noZero) {
    for (i = 0; i < length; i++) {
      buf[i] = 0
    }
  }

  return buf
}

Buffer.isBuffer = function (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b))
    throw new TypeError('Arguments must be Buffers')

  var x = a.length
  var y = b.length
  for (var i = 0, len = Math.min(x, y); i < len && a[i] === b[i]; i++) {}
  if (i !== len) {
    x = a[i]
    y = b[i]
  }
  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function (list, totalLength) {
  if (!isArray(list)) throw new TypeError('Usage: Buffer.concat(list[, length])')

  if (list.length === 0) {
    return new Buffer(0)
  } else if (list.length === 1) {
    return list[0]
  }

  var i
  if (totalLength === undefined) {
    totalLength = 0
    for (i = 0; i < list.length; i++) {
      totalLength += list[i].length
    }
  }

  var buf = new Buffer(totalLength)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

Buffer.byteLength = function (str, encoding) {
  var ret
  str = str + ''
  switch (encoding || 'utf8') {
    case 'ascii':
    case 'binary':
    case 'raw':
      ret = str.length
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = str.length * 2
      break
    case 'hex':
      ret = str.length >>> 1
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8ToBytes(str).length
      break
    case 'base64':
      ret = base64ToBytes(str).length
      break
    default:
      ret = str.length
  }
  return ret
}

// pre-set for values that may exist in the future
Buffer.prototype.length = undefined
Buffer.prototype.parent = undefined

// toString(encoding, start=0, end=buffer.length)
Buffer.prototype.toString = function (encoding, start, end) {
  var loweredCase = false

  start = start >>> 0
  end = end === undefined || end === Infinity ? this.length : end >>> 0

  if (!encoding) encoding = 'utf8'
  if (start < 0) start = 0
  if (end > this.length) end = this.length
  if (end <= start) return ''

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'binary':
        return binarySlice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase)
          throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.equals = function (b) {
  if(!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max)
      str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  return Buffer.compare(this, b)
}

// `get` will be removed in Node 0.13+
Buffer.prototype.get = function (offset) {
  console.log('.get() is deprecated. Access using array indexes instead.')
  return this.readUInt8(offset)
}

// `set` will be removed in Node 0.13+
Buffer.prototype.set = function (v, offset) {
  console.log('.set() is deprecated. Access using array indexes instead.')
  return this.writeUInt8(v, offset)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new Error('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var byte = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(byte)) throw new Error('Invalid hex string')
    buf[offset + i] = byte
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf8ToBytes(string), buf, offset, length)
  return charsWritten
}

function asciiWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(asciiToBytes(string), buf, offset, length)
  return charsWritten
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(base64ToBytes(string), buf, offset, length)
  return charsWritten
}

function utf16leWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf16leToBytes(string), buf, offset, length)
  return charsWritten
}

Buffer.prototype.write = function (string, offset, length, encoding) {
  // Support both (string, offset, length, encoding)
  // and the legacy (string, encoding, offset, length)
  if (isFinite(offset)) {
    if (!isFinite(length)) {
      encoding = length
      length = undefined
    }
  } else {  // legacy
    var swap = encoding
    encoding = offset
    offset = length
    length = swap
  }

  offset = Number(offset) || 0
  var remaining = this.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }
  encoding = String(encoding || 'utf8').toLowerCase()

  var ret
  switch (encoding) {
    case 'hex':
      ret = hexWrite(this, string, offset, length)
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8Write(this, string, offset, length)
      break
    case 'ascii':
      ret = asciiWrite(this, string, offset, length)
      break
    case 'binary':
      ret = binaryWrite(this, string, offset, length)
      break
    case 'base64':
      ret = base64Write(this, string, offset, length)
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = utf16leWrite(this, string, offset, length)
      break
    default:
      throw new TypeError('Unknown encoding: ' + encoding)
  }
  return ret
}

Buffer.prototype.toJSON = function () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  var res = ''
  var tmp = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    if (buf[i] <= 0x7F) {
      res += decodeUtf8Char(tmp) + String.fromCharCode(buf[i])
      tmp = ''
    } else {
      tmp += '%' + buf[i].toString(16)
    }
  }

  return res + decodeUtf8Char(tmp)
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function binarySlice (buf, start, end) {
  return asciiSlice(buf, start, end)
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len;
    if (start < 0)
      start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0)
      end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start)
    end = start

  if (Buffer.TYPED_ARRAY_SUPPORT) {
    return Buffer._augment(this.subarray(start, end))
  } else {
    var sliceLen = end - start
    var newBuf = new Buffer(sliceLen, undefined, true)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
    return newBuf
  }
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0)
    throw new RangeError('offset is not uint')
  if (offset + ext > length)
    throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUInt8 = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
      ((this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      this[offset + 3])
}

Buffer.prototype.readInt8 = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80))
    return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return (this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16) |
      (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
      (this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      (this[offset + 3])
}

Buffer.prototype.readFloatLE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('buffer must be a Buffer instance')
  if (value > max || value < min) throw new TypeError('value is out of bounds')
  if (offset + ext > buf.length) throw new TypeError('index out of range')
}

Buffer.prototype.writeUInt8 = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = value
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
  } else objectWriteUInt16(this, value, offset, true)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = value
  } else objectWriteUInt16(this, value, offset, false)
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = value
  } else objectWriteUInt32(this, value, offset, true)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = value
  } else objectWriteUInt32(this, value, offset, false)
  return offset + 4
}

Buffer.prototype.writeInt8 = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = value
  return offset + 1
}

Buffer.prototype.writeInt16LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
  } else objectWriteUInt16(this, value, offset, true)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = value
  } else objectWriteUInt16(this, value, offset, false)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else objectWriteUInt32(this, value, offset, true)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = value
  } else objectWriteUInt32(this, value, offset, false)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (value > max || value < min) throw new TypeError('value is out of bounds')
  if (offset + ext > buf.length) throw new TypeError('index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert)
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert)
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function (target, target_start, start, end) {
  var source = this

  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (!target_start) target_start = 0

  // Copy 0 bytes; we're done
  if (end === start) return
  if (target.length === 0 || source.length === 0) return

  // Fatal error conditions
  if (end < start) throw new TypeError('sourceEnd < sourceStart')
  if (target_start < 0 || target_start >= target.length)
    throw new TypeError('targetStart out of bounds')
  if (start < 0 || start >= source.length) throw new TypeError('sourceStart out of bounds')
  if (end < 0 || end > source.length) throw new TypeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length)
    end = this.length
  if (target.length - target_start < end - start)
    end = target.length - target_start + start

  var len = end - start

  if (len < 100 || !Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < len; i++) {
      target[i + target_start] = this[i + start]
    }
  } else {
    target._set(this.subarray(start, start + len), target_start)
  }
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  if (end < start) throw new TypeError('end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  if (start < 0 || start >= this.length) throw new TypeError('start out of bounds')
  if (end < 0 || end > this.length) throw new TypeError('end out of bounds')

  var i
  if (typeof value === 'number') {
    for (i = start; i < end; i++) {
      this[i] = value
    }
  } else {
    var bytes = utf8ToBytes(value.toString())
    var len = bytes.length
    for (i = start; i < end; i++) {
      this[i] = bytes[i % len]
    }
  }

  return this
}

/**
 * Creates a new `ArrayBuffer` with the *copied* memory of the buffer instance.
 * Added in Node 0.12. Only available in browsers that support ArrayBuffer.
 */
Buffer.prototype.toArrayBuffer = function () {
  if (typeof Uint8Array !== 'undefined') {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      return (new Buffer(this)).buffer
    } else {
      var buf = new Uint8Array(this.length)
      for (var i = 0, len = buf.length; i < len; i += 1) {
        buf[i] = this[i]
      }
      return buf.buffer
    }
  } else {
    throw new TypeError('Buffer.toArrayBuffer not supported in this browser')
  }
}

// HELPER FUNCTIONS
// ================

var BP = Buffer.prototype

/**
 * Augment a Uint8Array *instance* (not the Uint8Array class!) with Buffer methods
 */
Buffer._augment = function (arr) {
  arr._isBuffer = true

  // save reference to original Uint8Array get/set methods before overwriting
  arr._get = arr.get
  arr._set = arr.set

  // deprecated, will be removed in node 0.13+
  arr.get = BP.get
  arr.set = BP.set

  arr.write = BP.write
  arr.toString = BP.toString
  arr.toLocaleString = BP.toString
  arr.toJSON = BP.toJSON
  arr.equals = BP.equals
  arr.compare = BP.compare
  arr.copy = BP.copy
  arr.slice = BP.slice
  arr.readUInt8 = BP.readUInt8
  arr.readUInt16LE = BP.readUInt16LE
  arr.readUInt16BE = BP.readUInt16BE
  arr.readUInt32LE = BP.readUInt32LE
  arr.readUInt32BE = BP.readUInt32BE
  arr.readInt8 = BP.readInt8
  arr.readInt16LE = BP.readInt16LE
  arr.readInt16BE = BP.readInt16BE
  arr.readInt32LE = BP.readInt32LE
  arr.readInt32BE = BP.readInt32BE
  arr.readFloatLE = BP.readFloatLE
  arr.readFloatBE = BP.readFloatBE
  arr.readDoubleLE = BP.readDoubleLE
  arr.readDoubleBE = BP.readDoubleBE
  arr.writeUInt8 = BP.writeUInt8
  arr.writeUInt16LE = BP.writeUInt16LE
  arr.writeUInt16BE = BP.writeUInt16BE
  arr.writeUInt32LE = BP.writeUInt32LE
  arr.writeUInt32BE = BP.writeUInt32BE
  arr.writeInt8 = BP.writeInt8
  arr.writeInt16LE = BP.writeInt16LE
  arr.writeInt16BE = BP.writeInt16BE
  arr.writeInt32LE = BP.writeInt32LE
  arr.writeInt32BE = BP.writeInt32BE
  arr.writeFloatLE = BP.writeFloatLE
  arr.writeFloatBE = BP.writeFloatBE
  arr.writeDoubleLE = BP.writeDoubleLE
  arr.writeDoubleBE = BP.writeDoubleBE
  arr.fill = BP.fill
  arr.inspect = BP.inspect
  arr.toArrayBuffer = BP.toArrayBuffer

  return arr
}

var INVALID_BASE64_RE = /[^+\/0-9A-z]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function isArrayish (subject) {
  return isArray(subject) || Buffer.isBuffer(subject) ||
      subject && typeof subject === 'object' &&
      typeof subject.length === 'number'
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    var b = str.charCodeAt(i)
    if (b <= 0x7F) {
      byteArray.push(b)
    } else {
      var start = i
      if (b >= 0xD800 && b <= 0xDFFF) i++
      var h = encodeURIComponent(str.slice(start, i+1)).substr(1).split('%')
      for (var j = 0; j < h.length; j++) {
        byteArray.push(parseInt(h[j], 16))
      }
    }
  }
  return byteArray
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(str)
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length))
      break
    dst[i + offset] = src[i]
  }
  return i
}

function decodeUtf8Char (str) {
  try {
    return decodeURIComponent(str)
  } catch (err) {
    return String.fromCharCode(0xFFFD) // UTF 8 invalid char
  }
}

},{"base64-js":148,"ieee754":149,"is-array":150}],148:[function(_dereq_,module,exports){
var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

;(function (exports) {
	'use strict';

  var Arr = (typeof Uint8Array !== 'undefined')
    ? Uint8Array
    : Array

	var PLUS   = '+'.charCodeAt(0)
	var SLASH  = '/'.charCodeAt(0)
	var NUMBER = '0'.charCodeAt(0)
	var LOWER  = 'a'.charCodeAt(0)
	var UPPER  = 'A'.charCodeAt(0)

	function decode (elt) {
		var code = elt.charCodeAt(0)
		if (code === PLUS)
			return 62 // '+'
		if (code === SLASH)
			return 63 // '/'
		if (code < NUMBER)
			return -1 //no match
		if (code < NUMBER + 10)
			return code - NUMBER + 26 + 26
		if (code < UPPER + 26)
			return code - UPPER
		if (code < LOWER + 26)
			return code - LOWER + 26
	}

	function b64ToByteArray (b64) {
		var i, j, l, tmp, placeHolders, arr

		if (b64.length % 4 > 0) {
			throw new Error('Invalid string. Length must be a multiple of 4')
		}

		// the number of equal signs (place holders)
		// if there are two placeholders, than the two characters before it
		// represent one byte
		// if there is only one, then the three characters before it represent 2 bytes
		// this is just a cheap hack to not do indexOf twice
		var len = b64.length
		placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0

		// base64 is 4/3 + up to two characters of the original data
		arr = new Arr(b64.length * 3 / 4 - placeHolders)

		// if there are placeholders, only get up to the last complete 4 chars
		l = placeHolders > 0 ? b64.length - 4 : b64.length

		var L = 0

		function push (v) {
			arr[L++] = v
		}

		for (i = 0, j = 0; i < l; i += 4, j += 3) {
			tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
			push((tmp & 0xFF0000) >> 16)
			push((tmp & 0xFF00) >> 8)
			push(tmp & 0xFF)
		}

		if (placeHolders === 2) {
			tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
			push(tmp & 0xFF)
		} else if (placeHolders === 1) {
			tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
			push((tmp >> 8) & 0xFF)
			push(tmp & 0xFF)
		}

		return arr
	}

	function uint8ToBase64 (uint8) {
		var i,
			extraBytes = uint8.length % 3, // if we have 1 byte left, pad 2 bytes
			output = "",
			temp, length

		function encode (num) {
			return lookup.charAt(num)
		}

		function tripletToBase64 (num) {
			return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
		}

		// go through the array every three bytes, we'll deal with trailing stuff later
		for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
			temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
			output += tripletToBase64(temp)
		}

		// pad the end with zeros, but make sure to not forget the extra bytes
		switch (extraBytes) {
			case 1:
				temp = uint8[uint8.length - 1]
				output += encode(temp >> 2)
				output += encode((temp << 4) & 0x3F)
				output += '=='
				break
			case 2:
				temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
				output += encode(temp >> 10)
				output += encode((temp >> 4) & 0x3F)
				output += encode((temp << 2) & 0x3F)
				output += '='
				break
		}

		return output
	}

	exports.toByteArray = b64ToByteArray
	exports.fromByteArray = uint8ToBase64
}(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

},{}],149:[function(_dereq_,module,exports){
exports.read = function(buffer, offset, isLE, mLen, nBytes) {
  var e, m,
      eLen = nBytes * 8 - mLen - 1,
      eMax = (1 << eLen) - 1,
      eBias = eMax >> 1,
      nBits = -7,
      i = isLE ? (nBytes - 1) : 0,
      d = isLE ? -1 : 1,
      s = buffer[offset + i];

  i += d;

  e = s & ((1 << (-nBits)) - 1);
  s >>= (-nBits);
  nBits += eLen;
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8);

  m = e & ((1 << (-nBits)) - 1);
  e >>= (-nBits);
  nBits += mLen;
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8);

  if (e === 0) {
    e = 1 - eBias;
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity);
  } else {
    m = m + Math.pow(2, mLen);
    e = e - eBias;
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
};

exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c,
      eLen = nBytes * 8 - mLen - 1,
      eMax = (1 << eLen) - 1,
      eBias = eMax >> 1,
      rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0),
      i = isLE ? 0 : (nBytes - 1),
      d = isLE ? 1 : -1,
      s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;

  value = Math.abs(value);

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0;
    e = eMax;
  } else {
    e = Math.floor(Math.log(value) / Math.LN2);
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--;
      c *= 2;
    }
    if (e + eBias >= 1) {
      value += rt / c;
    } else {
      value += rt * Math.pow(2, 1 - eBias);
    }
    if (value * c >= 2) {
      e++;
      c /= 2;
    }

    if (e + eBias >= eMax) {
      m = 0;
      e = eMax;
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen);
      e = e + eBias;
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
      e = 0;
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8);

  e = (e << mLen) | m;
  eLen += mLen;
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8);

  buffer[offset + i - d] |= s * 128;
};

},{}],150:[function(_dereq_,module,exports){

/**
 * isArray
 */

var isArray = Array.isArray;

/**
 * toString
 */

var str = Object.prototype.toString;

/**
 * Whether or not the given `val`
 * is an array.
 *
 * example:
 *
 *        isArray([]);
 *        // > true
 *        isArray(arguments);
 *        // > false
 *        isArray('');
 *        // > false
 *
 * @param {mixed} val
 * @return {bool}
 */

module.exports = isArray || function (val) {
  return !! val && '[object Array]' == str.call(val);
};

},{}],151:[function(_dereq_,module,exports){
(function (Buffer){
var createHash = _dereq_('sha.js')

var md5 = toConstructor(_dereq_('./md5'))
var rmd160 = toConstructor(_dereq_('ripemd160'))

function toConstructor (fn) {
  return function () {
    var buffers = []
    var m= {
      update: function (data, enc) {
        if(!Buffer.isBuffer(data)) data = new Buffer(data, enc)
        buffers.push(data)
        return this
      },
      digest: function (enc) {
        var buf = Buffer.concat(buffers)
        var r = fn(buf)
        buffers = null
        return enc ? r.toString(enc) : r
      }
    }
    return m
  }
}

module.exports = function (alg) {
  if('md5' === alg) return new md5()
  if('rmd160' === alg) return new rmd160()
  return createHash(alg)
}

}).call(this,_dereq_("buffer").Buffer)
},{"./md5":155,"buffer":147,"ripemd160":156,"sha.js":158}],152:[function(_dereq_,module,exports){
(function (Buffer){
var createHash = _dereq_('./create-hash')

var blocksize = 64
var zeroBuffer = new Buffer(blocksize); zeroBuffer.fill(0)

module.exports = Hmac

function Hmac (alg, key) {
  if(!(this instanceof Hmac)) return new Hmac(alg, key)
  this._opad = opad
  this._alg = alg

  key = this._key = !Buffer.isBuffer(key) ? new Buffer(key) : key

  if(key.length > blocksize) {
    key = createHash(alg).update(key).digest()
  } else if(key.length < blocksize) {
    key = Buffer.concat([key, zeroBuffer], blocksize)
  }

  var ipad = this._ipad = new Buffer(blocksize)
  var opad = this._opad = new Buffer(blocksize)

  for(var i = 0; i < blocksize; i++) {
    ipad[i] = key[i] ^ 0x36
    opad[i] = key[i] ^ 0x5C
  }

  this._hash = createHash(alg).update(ipad)
}

Hmac.prototype.update = function (data, enc) {
  this._hash.update(data, enc)
  return this
}

Hmac.prototype.digest = function (enc) {
  var h = this._hash.digest()
  return createHash(this._alg).update(this._opad).update(h).digest(enc)
}


}).call(this,_dereq_("buffer").Buffer)
},{"./create-hash":151,"buffer":147}],153:[function(_dereq_,module,exports){
(function (Buffer){
var intSize = 4;
var zeroBuffer = new Buffer(intSize); zeroBuffer.fill(0);
var chrsz = 8;

function toArray(buf, bigEndian) {
  if ((buf.length % intSize) !== 0) {
    var len = buf.length + (intSize - (buf.length % intSize));
    buf = Buffer.concat([buf, zeroBuffer], len);
  }

  var arr = [];
  var fn = bigEndian ? buf.readInt32BE : buf.readInt32LE;
  for (var i = 0; i < buf.length; i += intSize) {
    arr.push(fn.call(buf, i));
  }
  return arr;
}

function toBuffer(arr, size, bigEndian) {
  var buf = new Buffer(size);
  var fn = bigEndian ? buf.writeInt32BE : buf.writeInt32LE;
  for (var i = 0; i < arr.length; i++) {
    fn.call(buf, arr[i], i * 4, true);
  }
  return buf;
}

function hash(buf, fn, hashSize, bigEndian) {
  if (!Buffer.isBuffer(buf)) buf = new Buffer(buf);
  var arr = fn(toArray(buf, bigEndian), buf.length * chrsz);
  return toBuffer(arr, hashSize, bigEndian);
}

module.exports = { hash: hash };

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":147}],154:[function(_dereq_,module,exports){
(function (Buffer){
var rng = _dereq_('./rng')

function error () {
  var m = [].slice.call(arguments).join(' ')
  throw new Error([
    m,
    'we accept pull requests',
    'http://github.com/dominictarr/crypto-browserify'
    ].join('\n'))
}

exports.createHash = _dereq_('./create-hash')

exports.createHmac = _dereq_('./create-hmac')

exports.randomBytes = function(size, callback) {
  if (callback && callback.call) {
    try {
      callback.call(this, undefined, new Buffer(rng(size)))
    } catch (err) { callback(err) }
  } else {
    return new Buffer(rng(size))
  }
}

function each(a, f) {
  for(var i in a)
    f(a[i], i)
}

exports.getHashes = function () {
  return ['sha1', 'sha256', 'md5', 'rmd160']

}

var p = _dereq_('./pbkdf2')(exports.createHmac)
exports.pbkdf2 = p.pbkdf2
exports.pbkdf2Sync = p.pbkdf2Sync


// the least I can do is make error messages for the rest of the node.js/crypto api.
each(['createCredentials'
, 'createCipher'
, 'createCipheriv'
, 'createDecipher'
, 'createDecipheriv'
, 'createSign'
, 'createVerify'
, 'createDiffieHellman'
], function (name) {
  exports[name] = function () {
    error('sorry,', name, 'is not implemented yet')
  }
})

}).call(this,_dereq_("buffer").Buffer)
},{"./create-hash":151,"./create-hmac":152,"./pbkdf2":162,"./rng":163,"buffer":147}],155:[function(_dereq_,module,exports){
/*
 * A JavaScript implementation of the RSA Data Security, Inc. MD5 Message
 * Digest Algorithm, as defined in RFC 1321.
 * Version 2.1 Copyright (C) Paul Johnston 1999 - 2002.
 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
 * Distributed under the BSD License
 * See http://pajhome.org.uk/crypt/md5 for more info.
 */

var helpers = _dereq_('./helpers');

/*
 * Calculate the MD5 of an array of little-endian words, and a bit length
 */
function core_md5(x, len)
{
  /* append padding */
  x[len >> 5] |= 0x80 << ((len) % 32);
  x[(((len + 64) >>> 9) << 4) + 14] = len;

  var a =  1732584193;
  var b = -271733879;
  var c = -1732584194;
  var d =  271733878;

  for(var i = 0; i < x.length; i += 16)
  {
    var olda = a;
    var oldb = b;
    var oldc = c;
    var oldd = d;

    a = md5_ff(a, b, c, d, x[i+ 0], 7 , -680876936);
    d = md5_ff(d, a, b, c, x[i+ 1], 12, -389564586);
    c = md5_ff(c, d, a, b, x[i+ 2], 17,  606105819);
    b = md5_ff(b, c, d, a, x[i+ 3], 22, -1044525330);
    a = md5_ff(a, b, c, d, x[i+ 4], 7 , -176418897);
    d = md5_ff(d, a, b, c, x[i+ 5], 12,  1200080426);
    c = md5_ff(c, d, a, b, x[i+ 6], 17, -1473231341);
    b = md5_ff(b, c, d, a, x[i+ 7], 22, -45705983);
    a = md5_ff(a, b, c, d, x[i+ 8], 7 ,  1770035416);
    d = md5_ff(d, a, b, c, x[i+ 9], 12, -1958414417);
    c = md5_ff(c, d, a, b, x[i+10], 17, -42063);
    b = md5_ff(b, c, d, a, x[i+11], 22, -1990404162);
    a = md5_ff(a, b, c, d, x[i+12], 7 ,  1804603682);
    d = md5_ff(d, a, b, c, x[i+13], 12, -40341101);
    c = md5_ff(c, d, a, b, x[i+14], 17, -1502002290);
    b = md5_ff(b, c, d, a, x[i+15], 22,  1236535329);

    a = md5_gg(a, b, c, d, x[i+ 1], 5 , -165796510);
    d = md5_gg(d, a, b, c, x[i+ 6], 9 , -1069501632);
    c = md5_gg(c, d, a, b, x[i+11], 14,  643717713);
    b = md5_gg(b, c, d, a, x[i+ 0], 20, -373897302);
    a = md5_gg(a, b, c, d, x[i+ 5], 5 , -701558691);
    d = md5_gg(d, a, b, c, x[i+10], 9 ,  38016083);
    c = md5_gg(c, d, a, b, x[i+15], 14, -660478335);
    b = md5_gg(b, c, d, a, x[i+ 4], 20, -405537848);
    a = md5_gg(a, b, c, d, x[i+ 9], 5 ,  568446438);
    d = md5_gg(d, a, b, c, x[i+14], 9 , -1019803690);
    c = md5_gg(c, d, a, b, x[i+ 3], 14, -187363961);
    b = md5_gg(b, c, d, a, x[i+ 8], 20,  1163531501);
    a = md5_gg(a, b, c, d, x[i+13], 5 , -1444681467);
    d = md5_gg(d, a, b, c, x[i+ 2], 9 , -51403784);
    c = md5_gg(c, d, a, b, x[i+ 7], 14,  1735328473);
    b = md5_gg(b, c, d, a, x[i+12], 20, -1926607734);

    a = md5_hh(a, b, c, d, x[i+ 5], 4 , -378558);
    d = md5_hh(d, a, b, c, x[i+ 8], 11, -2022574463);
    c = md5_hh(c, d, a, b, x[i+11], 16,  1839030562);
    b = md5_hh(b, c, d, a, x[i+14], 23, -35309556);
    a = md5_hh(a, b, c, d, x[i+ 1], 4 , -1530992060);
    d = md5_hh(d, a, b, c, x[i+ 4], 11,  1272893353);
    c = md5_hh(c, d, a, b, x[i+ 7], 16, -155497632);
    b = md5_hh(b, c, d, a, x[i+10], 23, -1094730640);
    a = md5_hh(a, b, c, d, x[i+13], 4 ,  681279174);
    d = md5_hh(d, a, b, c, x[i+ 0], 11, -358537222);
    c = md5_hh(c, d, a, b, x[i+ 3], 16, -722521979);
    b = md5_hh(b, c, d, a, x[i+ 6], 23,  76029189);
    a = md5_hh(a, b, c, d, x[i+ 9], 4 , -640364487);
    d = md5_hh(d, a, b, c, x[i+12], 11, -421815835);
    c = md5_hh(c, d, a, b, x[i+15], 16,  530742520);
    b = md5_hh(b, c, d, a, x[i+ 2], 23, -995338651);

    a = md5_ii(a, b, c, d, x[i+ 0], 6 , -198630844);
    d = md5_ii(d, a, b, c, x[i+ 7], 10,  1126891415);
    c = md5_ii(c, d, a, b, x[i+14], 15, -1416354905);
    b = md5_ii(b, c, d, a, x[i+ 5], 21, -57434055);
    a = md5_ii(a, b, c, d, x[i+12], 6 ,  1700485571);
    d = md5_ii(d, a, b, c, x[i+ 3], 10, -1894986606);
    c = md5_ii(c, d, a, b, x[i+10], 15, -1051523);
    b = md5_ii(b, c, d, a, x[i+ 1], 21, -2054922799);
    a = md5_ii(a, b, c, d, x[i+ 8], 6 ,  1873313359);
    d = md5_ii(d, a, b, c, x[i+15], 10, -30611744);
    c = md5_ii(c, d, a, b, x[i+ 6], 15, -1560198380);
    b = md5_ii(b, c, d, a, x[i+13], 21,  1309151649);
    a = md5_ii(a, b, c, d, x[i+ 4], 6 , -145523070);
    d = md5_ii(d, a, b, c, x[i+11], 10, -1120210379);
    c = md5_ii(c, d, a, b, x[i+ 2], 15,  718787259);
    b = md5_ii(b, c, d, a, x[i+ 9], 21, -343485551);

    a = safe_add(a, olda);
    b = safe_add(b, oldb);
    c = safe_add(c, oldc);
    d = safe_add(d, oldd);
  }
  return Array(a, b, c, d);

}

/*
 * These functions implement the four basic operations the algorithm uses.
 */
function md5_cmn(q, a, b, x, s, t)
{
  return safe_add(bit_rol(safe_add(safe_add(a, q), safe_add(x, t)), s),b);
}
function md5_ff(a, b, c, d, x, s, t)
{
  return md5_cmn((b & c) | ((~b) & d), a, b, x, s, t);
}
function md5_gg(a, b, c, d, x, s, t)
{
  return md5_cmn((b & d) | (c & (~d)), a, b, x, s, t);
}
function md5_hh(a, b, c, d, x, s, t)
{
  return md5_cmn(b ^ c ^ d, a, b, x, s, t);
}
function md5_ii(a, b, c, d, x, s, t)
{
  return md5_cmn(c ^ (b | (~d)), a, b, x, s, t);
}

/*
 * Add integers, wrapping at 2^32. This uses 16-bit operations internally
 * to work around bugs in some JS interpreters.
 */
function safe_add(x, y)
{
  var lsw = (x & 0xFFFF) + (y & 0xFFFF);
  var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  return (msw << 16) | (lsw & 0xFFFF);
}

/*
 * Bitwise rotate a 32-bit number to the left.
 */
function bit_rol(num, cnt)
{
  return (num << cnt) | (num >>> (32 - cnt));
}

module.exports = function md5(buf) {
  return helpers.hash(buf, core_md5, 16);
};

},{"./helpers":153}],156:[function(_dereq_,module,exports){
(function (Buffer){

module.exports = ripemd160



/*
CryptoJS v3.1.2
code.google.com/p/crypto-js
(c) 2009-2013 by Jeff Mott. All rights reserved.
code.google.com/p/crypto-js/wiki/License
*/
/** @preserve
(c) 2012 by Cédric Mesnil. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

    - Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
    - Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

// Constants table
var zl = [
    0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15,
    7,  4, 13,  1, 10,  6, 15,  3, 12,  0,  9,  5,  2, 14, 11,  8,
    3, 10, 14,  4,  9, 15,  8,  1,  2,  7,  0,  6, 13, 11,  5, 12,
    1,  9, 11, 10,  0,  8, 12,  4, 13,  3,  7, 15, 14,  5,  6,  2,
    4,  0,  5,  9,  7, 12,  2, 10, 14,  1,  3,  8, 11,  6, 15, 13];
var zr = [
    5, 14,  7,  0,  9,  2, 11,  4, 13,  6, 15,  8,  1, 10,  3, 12,
    6, 11,  3,  7,  0, 13,  5, 10, 14, 15,  8, 12,  4,  9,  1,  2,
    15,  5,  1,  3,  7, 14,  6,  9, 11,  8, 12,  2, 10,  0,  4, 13,
    8,  6,  4,  1,  3, 11, 15,  0,  5, 12,  2, 13,  9,  7, 10, 14,
    12, 15, 10,  4,  1,  5,  8,  7,  6,  2, 13, 14,  0,  3,  9, 11];
var sl = [
     11, 14, 15, 12,  5,  8,  7,  9, 11, 13, 14, 15,  6,  7,  9,  8,
    7, 6,   8, 13, 11,  9,  7, 15,  7, 12, 15,  9, 11,  7, 13, 12,
    11, 13,  6,  7, 14,  9, 13, 15, 14,  8, 13,  6,  5, 12,  7,  5,
      11, 12, 14, 15, 14, 15,  9,  8,  9, 14,  5,  6,  8,  6,  5, 12,
    9, 15,  5, 11,  6,  8, 13, 12,  5, 12, 13, 14, 11,  8,  5,  6 ];
var sr = [
    8,  9,  9, 11, 13, 15, 15,  5,  7,  7,  8, 11, 14, 14, 12,  6,
    9, 13, 15,  7, 12,  8,  9, 11,  7,  7, 12,  7,  6, 15, 13, 11,
    9,  7, 15, 11,  8,  6,  6, 14, 12, 13,  5, 14, 13, 13,  7,  5,
    15,  5,  8, 11, 14, 14,  6, 14,  6,  9, 12,  9, 12,  5, 15,  8,
    8,  5, 12,  9, 12,  5, 14,  6,  8, 13,  6,  5, 15, 13, 11, 11 ];

var hl =  [ 0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E];
var hr =  [ 0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000];

var bytesToWords = function (bytes) {
  var words = [];
  for (var i = 0, b = 0; i < bytes.length; i++, b += 8) {
    words[b >>> 5] |= bytes[i] << (24 - b % 32);
  }
  return words;
};

var wordsToBytes = function (words) {
  var bytes = [];
  for (var b = 0; b < words.length * 32; b += 8) {
    bytes.push((words[b >>> 5] >>> (24 - b % 32)) & 0xFF);
  }
  return bytes;
};

var processBlock = function (H, M, offset) {

  // Swap endian
  for (var i = 0; i < 16; i++) {
    var offset_i = offset + i;
    var M_offset_i = M[offset_i];

    // Swap
    M[offset_i] = (
        (((M_offset_i << 8)  | (M_offset_i >>> 24)) & 0x00ff00ff) |
        (((M_offset_i << 24) | (M_offset_i >>> 8))  & 0xff00ff00)
    );
  }

  // Working variables
  var al, bl, cl, dl, el;
  var ar, br, cr, dr, er;

  ar = al = H[0];
  br = bl = H[1];
  cr = cl = H[2];
  dr = dl = H[3];
  er = el = H[4];
  // Computation
  var t;
  for (var i = 0; i < 80; i += 1) {
    t = (al +  M[offset+zl[i]])|0;
    if (i<16){
        t +=  f1(bl,cl,dl) + hl[0];
    } else if (i<32) {
        t +=  f2(bl,cl,dl) + hl[1];
    } else if (i<48) {
        t +=  f3(bl,cl,dl) + hl[2];
    } else if (i<64) {
        t +=  f4(bl,cl,dl) + hl[3];
    } else {// if (i<80) {
        t +=  f5(bl,cl,dl) + hl[4];
    }
    t = t|0;
    t =  rotl(t,sl[i]);
    t = (t+el)|0;
    al = el;
    el = dl;
    dl = rotl(cl, 10);
    cl = bl;
    bl = t;

    t = (ar + M[offset+zr[i]])|0;
    if (i<16){
        t +=  f5(br,cr,dr) + hr[0];
    } else if (i<32) {
        t +=  f4(br,cr,dr) + hr[1];
    } else if (i<48) {
        t +=  f3(br,cr,dr) + hr[2];
    } else if (i<64) {
        t +=  f2(br,cr,dr) + hr[3];
    } else {// if (i<80) {
        t +=  f1(br,cr,dr) + hr[4];
    }
    t = t|0;
    t =  rotl(t,sr[i]) ;
    t = (t+er)|0;
    ar = er;
    er = dr;
    dr = rotl(cr, 10);
    cr = br;
    br = t;
  }
  // Intermediate hash value
  t    = (H[1] + cl + dr)|0;
  H[1] = (H[2] + dl + er)|0;
  H[2] = (H[3] + el + ar)|0;
  H[3] = (H[4] + al + br)|0;
  H[4] = (H[0] + bl + cr)|0;
  H[0] =  t;
};

function f1(x, y, z) {
  return ((x) ^ (y) ^ (z));
}

function f2(x, y, z) {
  return (((x)&(y)) | ((~x)&(z)));
}

function f3(x, y, z) {
  return (((x) | (~(y))) ^ (z));
}

function f4(x, y, z) {
  return (((x) & (z)) | ((y)&(~(z))));
}

function f5(x, y, z) {
  return ((x) ^ ((y) |(~(z))));
}

function rotl(x,n) {
  return (x<<n) | (x>>>(32-n));
}

function ripemd160(message) {
  var H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];

  if (typeof message == 'string')
    message = new Buffer(message, 'utf8');

  var m = bytesToWords(message);

  var nBitsLeft = message.length * 8;
  var nBitsTotal = message.length * 8;

  // Add padding
  m[nBitsLeft >>> 5] |= 0x80 << (24 - nBitsLeft % 32);
  m[(((nBitsLeft + 64) >>> 9) << 4) + 14] = (
      (((nBitsTotal << 8)  | (nBitsTotal >>> 24)) & 0x00ff00ff) |
      (((nBitsTotal << 24) | (nBitsTotal >>> 8))  & 0xff00ff00)
  );

  for (var i=0 ; i<m.length; i += 16) {
    processBlock(H, m, i);
  }

  // Swap endian
  for (var i = 0; i < 5; i++) {
      // Shortcut
    var H_i = H[i];

    // Swap
    H[i] = (((H_i << 8)  | (H_i >>> 24)) & 0x00ff00ff) |
          (((H_i << 24) | (H_i >>> 8))  & 0xff00ff00);
  }

  var digestbytes = wordsToBytes(H);
  return new Buffer(digestbytes);
}



}).call(this,_dereq_("buffer").Buffer)
},{"buffer":147}],157:[function(_dereq_,module,exports){
var u = _dereq_('./util')
var write = u.write
var fill = u.zeroFill

module.exports = function (Buffer) {

  //prototype class for hash functions
  function Hash (blockSize, finalSize) {
    this._block = new Buffer(blockSize) //new Uint32Array(blockSize/4)
    this._finalSize = finalSize
    this._blockSize = blockSize
    this._len = 0
    this._s = 0
  }

  Hash.prototype.init = function () {
    this._s = 0
    this._len = 0
  }

  function lengthOf(data, enc) {
    if(enc == null)     return data.byteLength || data.length
    if(enc == 'ascii' || enc == 'binary')  return data.length
    if(enc == 'hex')    return data.length/2
    if(enc == 'base64') return data.length/3
  }

  Hash.prototype.update = function (data, enc) {
    var bl = this._blockSize

    //I'd rather do this with a streaming encoder, like the opposite of
    //http://nodejs.org/api/string_decoder.html
    var length
      if(!enc && 'string' === typeof data)
        enc = 'utf8'

    if(enc) {
      if(enc === 'utf-8')
        enc = 'utf8'

      if(enc === 'base64' || enc === 'utf8')
        data = new Buffer(data, enc), enc = null

      length = lengthOf(data, enc)
    } else
      length = data.byteLength || data.length

    var l = this._len += length
    var s = this._s = (this._s || 0)
    var f = 0
    var buffer = this._block
    while(s < l) {
      var t = Math.min(length, f + bl)
      write(buffer, data, enc, s%bl, f, t)
      var ch = (t - f);
      s += ch; f += ch

      if(!(s%bl))
        this._update(buffer)
    }
    this._s = s

    return this

  }

  Hash.prototype.digest = function (enc) {
    var bl = this._blockSize
    var fl = this._finalSize
    var len = this._len*8

    var x = this._block

    var bits = len % (bl*8)

    //add end marker, so that appending 0's creats a different hash.
    x[this._len % bl] = 0x80
    fill(this._block, this._len % bl + 1)

    if(bits >= fl*8) {
      this._update(this._block)
      u.zeroFill(this._block, 0)
    }

    //TODO: handle case where the bit length is > Math.pow(2, 29)
    x.writeInt32BE(len, fl + 4) //big endian

    var hash = this._update(this._block) || this._hash()
    if(enc == null) return hash
    return hash.toString(enc)
  }

  Hash.prototype._update = function () {
    throw new Error('_update must be implemented by subclass')
  }

  return Hash
}

},{"./util":161}],158:[function(_dereq_,module,exports){
var exports = module.exports = function (alg) {
  var Alg = exports[alg]
  if(!Alg) throw new Error(alg + ' is not supported (we accept pull requests)')
  return new Alg()
}

var Buffer = _dereq_('buffer').Buffer
var Hash   = _dereq_('./hash')(Buffer)

exports.sha =
exports.sha1 = _dereq_('./sha1')(Buffer, Hash)
exports.sha256 = _dereq_('./sha256')(Buffer, Hash)

},{"./hash":157,"./sha1":159,"./sha256":160,"buffer":147}],159:[function(_dereq_,module,exports){
/*
 * A JavaScript implementation of the Secure Hash Algorithm, SHA-1, as defined
 * in FIPS PUB 180-1
 * Version 2.1a Copyright Paul Johnston 2000 - 2002.
 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
 * Distributed under the BSD License
 * See http://pajhome.org.uk/crypt/md5 for details.
 */
module.exports = function (Buffer, Hash) {

  var inherits = _dereq_('util').inherits

  inherits(Sha1, Hash)

  var A = 0|0
  var B = 4|0
  var C = 8|0
  var D = 12|0
  var E = 16|0

  var BE = false
  var LE = true

  var W = new Int32Array(80)

  var POOL = []

  function Sha1 () {
    if(POOL.length)
      return POOL.pop().init()

    if(!(this instanceof Sha1)) return new Sha1()
    this._w = W
    Hash.call(this, 16*4, 14*4)
  
    this._h = null
    this.init()
  }

  Sha1.prototype.init = function () {
    this._a = 0x67452301
    this._b = 0xefcdab89
    this._c = 0x98badcfe
    this._d = 0x10325476
    this._e = 0xc3d2e1f0

    Hash.prototype.init.call(this)
    return this
  }

  Sha1.prototype._POOL = POOL

  // assume that array is a Uint32Array with length=16,
  // and that if it is the last block, it already has the length and the 1 bit appended.


  var isDV = new Buffer(1) instanceof DataView
  function readInt32BE (X, i) {
    return isDV
      ? X.getInt32(i, false)
      : X.readInt32BE(i)
  }

  Sha1.prototype._update = function (array) {

    var X = this._block
    var h = this._h
    var a, b, c, d, e, _a, _b, _c, _d, _e

    a = _a = this._a
    b = _b = this._b
    c = _c = this._c
    d = _d = this._d
    e = _e = this._e

    var w = this._w

    for(var j = 0; j < 80; j++) {
      var W = w[j]
        = j < 16
        //? X.getInt32(j*4, false)
        //? readInt32BE(X, j*4) //*/ X.readInt32BE(j*4) //*/
        ? X.readInt32BE(j*4)
        : rol(w[j - 3] ^ w[j -  8] ^ w[j - 14] ^ w[j - 16], 1)

      var t =
        add(
          add(rol(a, 5), sha1_ft(j, b, c, d)),
          add(add(e, W), sha1_kt(j))
        );

      e = d
      d = c
      c = rol(b, 30)
      b = a
      a = t
    }

    this._a = add(a, _a)
    this._b = add(b, _b)
    this._c = add(c, _c)
    this._d = add(d, _d)
    this._e = add(e, _e)
  }

  Sha1.prototype._hash = function () {
    if(POOL.length < 100) POOL.push(this)
    var H = new Buffer(20)
    //console.log(this._a|0, this._b|0, this._c|0, this._d|0, this._e|0)
    H.writeInt32BE(this._a|0, A)
    H.writeInt32BE(this._b|0, B)
    H.writeInt32BE(this._c|0, C)
    H.writeInt32BE(this._d|0, D)
    H.writeInt32BE(this._e|0, E)
    return H
  }

  /*
   * Perform the appropriate triplet combination function for the current
   * iteration
   */
  function sha1_ft(t, b, c, d) {
    if(t < 20) return (b & c) | ((~b) & d);
    if(t < 40) return b ^ c ^ d;
    if(t < 60) return (b & c) | (b & d) | (c & d);
    return b ^ c ^ d;
  }

  /*
   * Determine the appropriate additive constant for the current iteration
   */
  function sha1_kt(t) {
    return (t < 20) ?  1518500249 : (t < 40) ?  1859775393 :
           (t < 60) ? -1894007588 : -899497514;
  }

  /*
   * Add integers, wrapping at 2^32. This uses 16-bit operations internally
   * to work around bugs in some JS interpreters.
   * //dominictarr: this is 10 years old, so maybe this can be dropped?)
   *
   */
  function add(x, y) {
    return (x + y ) | 0
  //lets see how this goes on testling.
  //  var lsw = (x & 0xFFFF) + (y & 0xFFFF);
  //  var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  //  return (msw << 16) | (lsw & 0xFFFF);
  }

  /*
   * Bitwise rotate a 32-bit number to the left.
   */
  function rol(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }

  return Sha1
}

},{"util":169}],160:[function(_dereq_,module,exports){

/**
 * A JavaScript implementation of the Secure Hash Algorithm, SHA-256, as defined
 * in FIPS 180-2
 * Version 2.2-beta Copyright Angel Marin, Paul Johnston 2000 - 2009.
 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
 *
 */

var inherits = _dereq_('util').inherits
var BE       = false
var LE       = true
var u        = _dereq_('./util')

module.exports = function (Buffer, Hash) {

  var K = [
      0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
      0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
      0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
      0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
      0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC,
      0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
      0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
      0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
      0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
      0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
      0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3,
      0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
      0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5,
      0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
      0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
      0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
    ]

  inherits(Sha256, Hash)
  var W = new Array(64)
  var POOL = []
  function Sha256() {
    if(POOL.length) {
      //return POOL.shift().init()
    }
    //this._data = new Buffer(32)

    this.init()

    this._w = W //new Array(64)

    Hash.call(this, 16*4, 14*4)
  };

  Sha256.prototype.init = function () {

    this._a = 0x6a09e667|0
    this._b = 0xbb67ae85|0
    this._c = 0x3c6ef372|0
    this._d = 0xa54ff53a|0
    this._e = 0x510e527f|0
    this._f = 0x9b05688c|0
    this._g = 0x1f83d9ab|0
    this._h = 0x5be0cd19|0

    this._len = this._s = 0

    return this
  }

  var safe_add = function(x, y) {
    var lsw = (x & 0xFFFF) + (y & 0xFFFF);
    var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xFFFF);
  }

  function S (X, n) {
    return (X >>> n) | (X << (32 - n));
  }

  function R (X, n) {
    return (X >>> n);
  }

  function Ch (x, y, z) {
    return ((x & y) ^ ((~x) & z));
  }

  function Maj (x, y, z) {
    return ((x & y) ^ (x & z) ^ (y & z));
  }

  function Sigma0256 (x) {
    return (S(x, 2) ^ S(x, 13) ^ S(x, 22));
  }

  function Sigma1256 (x) {
    return (S(x, 6) ^ S(x, 11) ^ S(x, 25));
  }

  function Gamma0256 (x) {
    return (S(x, 7) ^ S(x, 18) ^ R(x, 3));
  }

  function Gamma1256 (x) {
    return (S(x, 17) ^ S(x, 19) ^ R(x, 10));
  }

  Sha256.prototype._update = function(m) {
    var M = this._block
    var W = this._w
    var a, b, c, d, e, f, g, h
    var T1, T2

    a = this._a | 0
    b = this._b | 0
    c = this._c | 0
    d = this._d | 0
    e = this._e | 0
    f = this._f | 0
    g = this._g | 0
    h = this._h | 0

    for (var j = 0; j < 64; j++) {
      var w = W[j] = j < 16
        ? M.readInt32BE(j * 4)
        : Gamma1256(W[j - 2]) + W[j - 7] + Gamma0256(W[j - 15]) + W[j - 16]

      T1 = h + Sigma1256(e) + Ch(e, f, g) + K[j] + w

      T2 = Sigma0256(a) + Maj(a, b, c);
      h = g; g = f; f = e; e = d + T1; d = c; c = b; b = a; a = T1 + T2;
    }

    this._a = (a + this._a) | 0
    this._b = (b + this._b) | 0
    this._c = (c + this._c) | 0
    this._d = (d + this._d) | 0
    this._e = (e + this._e) | 0
    this._f = (f + this._f) | 0
    this._g = (g + this._g) | 0
    this._h = (h + this._h) | 0

  };

  Sha256.prototype._hash = function () {
    if(POOL.length < 10)
      POOL.push(this)

    var H = new Buffer(32)

    H.writeInt32BE(this._a,  0)
    H.writeInt32BE(this._b,  4)
    H.writeInt32BE(this._c,  8)
    H.writeInt32BE(this._d, 12)
    H.writeInt32BE(this._e, 16)
    H.writeInt32BE(this._f, 20)
    H.writeInt32BE(this._g, 24)
    H.writeInt32BE(this._h, 28)

    return H
  }

  return Sha256

}

},{"./util":161,"util":169}],161:[function(_dereq_,module,exports){
exports.write = write
exports.zeroFill = zeroFill

exports.toString = toString

function write (buffer, string, enc, start, from, to, LE) {
  var l = (to - from)
  if(enc === 'ascii' || enc === 'binary') {
    for( var i = 0; i < l; i++) {
      buffer[start + i] = string.charCodeAt(i + from)
    }
  }
  else if(enc == null) {
    for( var i = 0; i < l; i++) {
      buffer[start + i] = string[i + from]
    }
  }
  else if(enc === 'hex') {
    for(var i = 0; i < l; i++) {
      var j = from + i
      buffer[start + i] = parseInt(string[j*2] + string[(j*2)+1], 16)
    }
  }
  else if(enc === 'base64') {
    throw new Error('base64 encoding not yet supported')
  }
  else
    throw new Error(enc +' encoding not yet supported')
}

//always fill to the end!
function zeroFill(buf, from) {
  for(var i = from; i < buf.length; i++)
    buf[i] = 0
}


},{}],162:[function(_dereq_,module,exports){
(function (Buffer){
// JavaScript PBKDF2 Implementation
// Based on http://git.io/qsv2zw
// Licensed under LGPL v3
// Copyright (c) 2013 jduncanator

var blocksize = 64
var zeroBuffer = new Buffer(blocksize); zeroBuffer.fill(0)

module.exports = function (createHmac, exports) {
  exports = exports || {}

  exports.pbkdf2 = function(password, salt, iterations, keylen, cb) {
    if('function' !== typeof cb)
      throw new Error('No callback provided to pbkdf2');
    setTimeout(function () {
      cb(null, exports.pbkdf2Sync(password, salt, iterations, keylen))
    })
  }

  exports.pbkdf2Sync = function(key, salt, iterations, keylen) {
    if('number' !== typeof iterations)
      throw new TypeError('Iterations not a number')
    if(iterations < 0)
      throw new TypeError('Bad iterations')
    if('number' !== typeof keylen)
      throw new TypeError('Key length not a number')
    if(keylen < 0)
      throw new TypeError('Bad key length')

    //stretch key to the correct length that hmac wants it,
    //otherwise this will happen every time hmac is called
    //twice per iteration.
    var key = !Buffer.isBuffer(key) ? new Buffer(key) : key

    if(key.length > blocksize) {
      key = createHash(alg).update(key).digest()
    } else if(key.length < blocksize) {
      key = Buffer.concat([key, zeroBuffer], blocksize)
    }

    var HMAC;
    var cplen, p = 0, i = 1, itmp = new Buffer(4), digtmp;
    var out = new Buffer(keylen);
    out.fill(0);
    while(keylen) {
      if(keylen > 20)
        cplen = 20;
      else
        cplen = keylen;

      /* We are unlikely to ever use more than 256 blocks (5120 bits!)
         * but just in case...
         */
        itmp[0] = (i >> 24) & 0xff;
        itmp[1] = (i >> 16) & 0xff;
          itmp[2] = (i >> 8) & 0xff;
          itmp[3] = i & 0xff;

          HMAC = createHmac('sha1', key);
          HMAC.update(salt)
          HMAC.update(itmp);
        digtmp = HMAC.digest();
        digtmp.copy(out, p, 0, cplen);

        for(var j = 1; j < iterations; j++) {
          HMAC = createHmac('sha1', key);
          HMAC.update(digtmp);
          digtmp = HMAC.digest();
          for(var k = 0; k < cplen; k++) {
            out[k] ^= digtmp[k];
          }
        }
      keylen -= cplen;
      i++;
      p += cplen;
    }

    return out;
  }

  return exports
}

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":147}],163:[function(_dereq_,module,exports){
(function (Buffer){
// Original code adapted from Robert Kieffer.
// details at https://github.com/broofa/node-uuid


(function() {
  var _global = this;

  var mathRNG, whatwgRNG;

  // NOTE: Math.random() does not guarantee "cryptographic quality"
  mathRNG = function(size) {
    var bytes = new Buffer(size);
    var r;

    for (var i = 0, r; i < size; i++) {
      if ((i & 0x03) == 0) r = Math.random() * 0x100000000;
      bytes[i] = r >>> ((i & 0x03) << 3) & 0xff;
    }

    return bytes;
  }

  if (_global.crypto && crypto.getRandomValues) {
    whatwgRNG = function(size) {
      var bytes = new Buffer(size); //in browserify, this is an extended Uint8Array
      crypto.getRandomValues(bytes);
      return bytes;
    }
  }

  module.exports = whatwgRNG || mathRNG;

}())

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":147}],164:[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      }
      throw TypeError('Uncaught, unspecified "error" event.');
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        len = arguments.length;
        args = new Array(len - 1);
        for (i = 1; i < len; i++)
          args[i - 1] = arguments[i];
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    len = arguments.length;
    args = new Array(len - 1);
    for (i = 1; i < len; i++)
      args[i - 1] = arguments[i];

    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    var m;
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.listenerCount = function(emitter, type) {
  var ret;
  if (!emitter._events || !emitter._events[type])
    ret = 0;
  else if (isFunction(emitter._events[type]))
    ret = 1;
  else
    ret = emitter._events[type].length;
  return ret;
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],165:[function(_dereq_,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],166:[function(_dereq_,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],167:[function(_dereq_,module,exports){
(function (global){
/*! http://mths.be/punycode v1.2.4 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports;
	var freeModule = typeof module == 'object' && module &&
		module.exports == freeExports && module;
	var freeGlobal = typeof global == 'object' && global;
	if (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^ -~]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /\x2E|\u3002|\uFF0E|\uFF61/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		while (length--) {
			array[length] = fn(array[length]);
		}
		return array;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings.
	 * @private
	 * @param {String} domain The domain name.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		return map(string.split(regexSeparators), fn).join('.');
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <http://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * http://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols to a Punycode string of ASCII-only
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name to Unicode. Only the
	 * Punycoded parts of the domain name will be converted, i.e. it doesn't
	 * matter if you call it on a string that has already been converted to
	 * Unicode.
	 * @memberOf punycode
	 * @param {String} domain The Punycode domain name to convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(domain) {
		return mapDomain(domain, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name to Punycode. Only the
	 * non-ASCII parts of the domain name will be converted, i.e. it doesn't
	 * matter if you call it with a domain that's already in ASCII.
	 * @memberOf punycode
	 * @param {String} domain The domain name to convert, as a Unicode string.
	 * @returns {String} The Punycode representation of the given domain name.
	 */
	function toASCII(domain) {
		return mapDomain(domain, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.2.4',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <http://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && !freeExports.nodeType) {
		if (freeModule) { // in Node.js or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else { // in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else { // in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],168:[function(_dereq_,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],169:[function(_dereq_,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = _dereq_('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = _dereq_('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,_dereq_("FWaASH"),typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":168,"FWaASH":166,"inherits":165}],170:[function(_dereq_,module,exports){
(function (Buffer){
(function () {
  "use strict";

  function btoa(str) {
    var buffer
      ;

    if (str instanceof Buffer) {
      buffer = str;
    } else {
      buffer = new Buffer(str.toString(), 'binary');
    }

    return buffer.toString('base64');
  }

  module.exports = btoa;
}());

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":147}],171:[function(_dereq_,module,exports){
'use strict';

var BPromise = _dereq_('bluebird');
var request = BPromise.promisify(_dereq_('request'));

var JXT = _dereq_('jxt').createRegistry();

JXT.use(_dereq_('./lib/xrd'));


module.exports = function (opts, cb) {
    if (typeof opts === 'string') {
        opts = {host: opts};
    }

    var config = {
        ssl: true,
        json: true,
        xrd: true
    };

    for (var prop in opts) {
        config[prop] = opts[prop];
    }

    var scheme = config.ssl ? 'https://' : 'http://';

    var getJSON = new BPromise(function (resolve, reject) {
        request(scheme + config.host + '/.well-known/host-meta.json').spread(function (req, body) {
            resolve(JSON.parse(body));
        }).catch(reject);
    });

    var getXRD = new BPromise(function (resolve, reject) {
        request(scheme + config.host + '/.well-known/host-meta').spread(function (req, body) {
            var xrd = JXT.parse(body);
            resolve(xrd.toJSON());
        }).catch(reject);
    });


    return new BPromise(function (resolve, reject) {
        BPromise.some([getJSON, getXRD], 1).spread(resolve).catch(function () {
            reject('no-host-meta');
        });
    }).nodeify(cb);
};

},{"./lib/xrd":172,"bluebird":112,"jxt":210,"request":173}],172:[function(_dereq_,module,exports){
'use strict';

var jxt = _dereq_('jxt');
var NS = 'http://docs.oasis-open.org/ns/xri/xrd-1.0';


module.exports = function (registry) {
    var Properties = {
        get: function () {
            var results = {};
            var props = jxt.find(this.xml, NS, 'Property');
    
            for (var i = 0, len = props.length; i < len; i++) {
                var property = props[i];
                var type = jxt.getAttribute(property, 'type');
                results[type] = property.textContent;
            }
    
            return results;
        }
    };
    
    var XRD = registry.define({
        name: 'xrd',
        namespace: NS,
        element: 'XRD',
        fields: {
            subject: jxt.subText(NS, 'Subject'),
            expires: jxt.dateSub(NS, 'Expires'),
            aliases: jxt.multiSubText(NS, 'Alias'),
            properties: Properties
        }
    });
    
    
    var Link = registry.define({
        name: '_xrdlink',
        namespace: NS,
        element: 'Link',
        fields: {
            rel: jxt.attribute('rel'),
            href: jxt.attribute('href'),
            type: jxt.attribute('type'),
            template: jxt.attribute('template'),
            titles: jxt.subLangText(NS, 'Title', 'default'),
            properties: Properties
        }
    });
    
    registry.extend(XRD, Link, 'links');

    return XRD;
};

},{"jxt":210}],173:[function(_dereq_,module,exports){
// Browser Request
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var XHR = XMLHttpRequest
if (!XHR) throw new Error('missing XMLHttpRequest')

module.exports = request
request.log = {
  'trace': noop, 'debug': noop, 'info': noop, 'warn': noop, 'error': noop
}

var DEFAULT_TIMEOUT = 3 * 60 * 1000 // 3 minutes

//
// request
//

function request(options, callback) {
  // The entry-point to the API: prep the options object and pass the real work to run_xhr.
  if(typeof callback !== 'function')
    throw new Error('Bad callback given: ' + callback)

  if(!options)
    throw new Error('No options given')

  var options_onResponse = options.onResponse; // Save this for later.

  if(typeof options === 'string')
    options = {'uri':options};
  else
    options = JSON.parse(JSON.stringify(options)); // Use a duplicate for mutating.

  options.onResponse = options_onResponse // And put it back.

  if (options.verbose) request.log = getLogger();

  if(options.url) {
    options.uri = options.url;
    delete options.url;
  }

  if(!options.uri && options.uri !== "")
    throw new Error("options.uri is a required argument");

  if(typeof options.uri != "string")
    throw new Error("options.uri must be a string");

  var unsupported_options = ['proxy', '_redirectsFollowed', 'maxRedirects', 'followRedirect']
  for (var i = 0; i < unsupported_options.length; i++)
    if(options[ unsupported_options[i] ])
      throw new Error("options." + unsupported_options[i] + " is not supported")

  options.callback = callback
  options.method = options.method || 'GET';
  options.headers = options.headers || {};
  options.body    = options.body || null
  options.timeout = options.timeout || request.DEFAULT_TIMEOUT

  if(options.headers.host)
    throw new Error("Options.headers.host is not supported");

  if(options.json) {
    options.headers.accept = options.headers.accept || 'application/json'
    if(options.method !== 'GET')
      options.headers['content-type'] = 'application/json'

    if(typeof options.json !== 'boolean')
      options.body = JSON.stringify(options.json)
    else if(typeof options.body !== 'string')
      options.body = JSON.stringify(options.body)
  }

  // If onResponse is boolean true, call back immediately when the response is known,
  // not when the full request is complete.
  options.onResponse = options.onResponse || noop
  if(options.onResponse === true) {
    options.onResponse = callback
    options.callback = noop
  }

  // XXX Browsers do not like this.
  //if(options.body)
  //  options.headers['content-length'] = options.body.length;

  // HTTP basic authentication
  if(!options.headers.authorization && options.auth)
    options.headers.authorization = 'Basic ' + b64_enc(options.auth.username + ':' + options.auth.password);

  return run_xhr(options)
}

var req_seq = 0
function run_xhr(options) {
  var xhr = new XHR
    , timed_out = false
    , is_cors = is_crossDomain(options.uri)
    , supports_cors = ('withCredentials' in xhr)

  req_seq += 1
  xhr.seq_id = req_seq
  xhr.id = req_seq + ': ' + options.method + ' ' + options.uri
  xhr._id = xhr.id // I know I will type "_id" from habit all the time.

  if(is_cors && !supports_cors) {
    var cors_err = new Error('Browser does not support cross-origin request: ' + options.uri)
    cors_err.cors = 'unsupported'
    return options.callback(cors_err, xhr)
  }

  xhr.timeoutTimer = setTimeout(too_late, options.timeout)
  function too_late() {
    timed_out = true
    var er = new Error('ETIMEDOUT')
    er.code = 'ETIMEDOUT'
    er.duration = options.timeout

    request.log.error('Timeout', { 'id':xhr._id, 'milliseconds':options.timeout })
    return options.callback(er, xhr)
  }

  // Some states can be skipped over, so remember what is still incomplete.
  var did = {'response':false, 'loading':false, 'end':false}

  xhr.onreadystatechange = on_state_change
  xhr.open(options.method, options.uri, true) // asynchronous
  if(is_cors)
    xhr.withCredentials = !! options.withCredentials
  xhr.send(options.body)
  return xhr

  function on_state_change(event) {
    if(timed_out)
      return request.log.debug('Ignoring timed out state change', {'state':xhr.readyState, 'id':xhr.id})

    request.log.debug('State change', {'state':xhr.readyState, 'id':xhr.id, 'timed_out':timed_out})

    if(xhr.readyState === XHR.OPENED) {
      request.log.debug('Request started', {'id':xhr.id})
      for (var key in options.headers)
        xhr.setRequestHeader(key, options.headers[key])
    }

    else if(xhr.readyState === XHR.HEADERS_RECEIVED)
      on_response()

    else if(xhr.readyState === XHR.LOADING) {
      on_response()
      on_loading()
    }

    else if(xhr.readyState === XHR.DONE) {
      on_response()
      on_loading()
      on_end()
    }
  }

  function on_response() {
    if(did.response)
      return

    did.response = true
    request.log.debug('Got response', {'id':xhr.id, 'status':xhr.status})
    clearTimeout(xhr.timeoutTimer)
    xhr.statusCode = xhr.status // Node request compatibility

    // Detect failed CORS requests.
    if(is_cors && xhr.statusCode == 0) {
      var cors_err = new Error('CORS request rejected: ' + options.uri)
      cors_err.cors = 'rejected'

      // Do not process this request further.
      did.loading = true
      did.end = true

      return options.callback(cors_err, xhr)
    }

    options.onResponse(null, xhr)
  }

  function on_loading() {
    if(did.loading)
      return

    did.loading = true
    request.log.debug('Response body loading', {'id':xhr.id})
    // TODO: Maybe simulate "data" events by watching xhr.responseText
  }

  function on_end() {
    if(did.end)
      return

    did.end = true
    request.log.debug('Request done', {'id':xhr.id})

    xhr.body = xhr.responseText
    if(options.json) {
      try        { xhr.body = JSON.parse(xhr.responseText) }
      catch (er) { return options.callback(er, xhr)        }
    }

    options.callback(null, xhr, xhr.body)
  }

} // request

request.withCredentials = false;
request.DEFAULT_TIMEOUT = DEFAULT_TIMEOUT;

//
// defaults
//

request.defaults = function(options, requester) {
  var def = function (method) {
    var d = function (params, callback) {
      if(typeof params === 'string')
        params = {'uri': params};
      else {
        params = JSON.parse(JSON.stringify(params));
      }
      for (var i in options) {
        if (params[i] === undefined) params[i] = options[i]
      }
      return method(params, callback)
    }
    return d
  }
  var de = def(request)
  de.get = def(request.get)
  de.post = def(request.post)
  de.put = def(request.put)
  de.head = def(request.head)
  return de
}

//
// HTTP method shortcuts
//

var shortcuts = [ 'get', 'put', 'post', 'head' ];
shortcuts.forEach(function(shortcut) {
  var method = shortcut.toUpperCase();
  var func   = shortcut.toLowerCase();

  request[func] = function(opts) {
    if(typeof opts === 'string')
      opts = {'method':method, 'uri':opts};
    else {
      opts = JSON.parse(JSON.stringify(opts));
      opts.method = method;
    }

    var args = [opts].concat(Array.prototype.slice.apply(arguments, [1]));
    return request.apply(this, args);
  }
})

//
// CouchDB shortcut
//

request.couch = function(options, callback) {
  if(typeof options === 'string')
    options = {'uri':options}

  // Just use the request API to do JSON.
  options.json = true
  if(options.body)
    options.json = options.body
  delete options.body

  callback = callback || noop

  var xhr = request(options, couch_handler)
  return xhr

  function couch_handler(er, resp, body) {
    if(er)
      return callback(er, resp, body)

    if((resp.statusCode < 200 || resp.statusCode > 299) && body.error) {
      // The body is a Couch JSON object indicating the error.
      er = new Error('CouchDB error: ' + (body.error.reason || body.error.error))
      for (var key in body)
        er[key] = body[key]
      return callback(er, resp, body);
    }

    return callback(er, resp, body);
  }
}

//
// Utility
//

function noop() {}

function getLogger() {
  var logger = {}
    , levels = ['trace', 'debug', 'info', 'warn', 'error']
    , level, i

  for(i = 0; i < levels.length; i++) {
    level = levels[i]

    logger[level] = noop
    if(typeof console !== 'undefined' && console && console[level])
      logger[level] = formatted(console, level)
  }

  return logger
}

function formatted(obj, method) {
  return formatted_logger

  function formatted_logger(str, context) {
    if(typeof context === 'object')
      str += ' ' + JSON.stringify(context)

    return obj[method].call(obj, str)
  }
}

// Return whether a URL is a cross-domain request.
function is_crossDomain(url) {
  var rurl = /^([\w\+\.\-]+:)(?:\/\/([^\/?#:]*)(?::(\d+))?)?/

  // jQuery #8138, IE may throw an exception when accessing
  // a field from window.location if document.domain has been set
  var ajaxLocation
  try { ajaxLocation = location.href }
  catch (e) {
    // Use the href attribute of an A element since IE will modify it given document.location
    ajaxLocation = document.createElement( "a" );
    ajaxLocation.href = "";
    ajaxLocation = ajaxLocation.href;
  }

  var ajaxLocParts = rurl.exec(ajaxLocation.toLowerCase()) || []
    , parts = rurl.exec(url.toLowerCase() )

  var result = !!(
    parts &&
    (  parts[1] != ajaxLocParts[1]
    || parts[2] != ajaxLocParts[2]
    || (parts[3] || (parts[1] === "http:" ? 80 : 443)) != (ajaxLocParts[3] || (ajaxLocParts[1] === "http:" ? 80 : 443))
    )
  )

  //console.debug('is_crossDomain('+url+') -> ' + result)
  return result
}

// MIT License from http://phpjs.org/functions/base64_encode:358
function b64_enc (data) {
    // Encodes string using MIME base64 algorithm
    var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var o1, o2, o3, h1, h2, h3, h4, bits, i = 0, ac = 0, enc="", tmp_arr = [];

    if (!data) {
        return data;
    }

    // assume utf8 data
    // data = this.utf8_encode(data+'');

    do { // pack three octets into four hexets
        o1 = data.charCodeAt(i++);
        o2 = data.charCodeAt(i++);
        o3 = data.charCodeAt(i++);

        bits = o1<<16 | o2<<8 | o3;

        h1 = bits>>18 & 0x3f;
        h2 = bits>>12 & 0x3f;
        h3 = bits>>6 & 0x3f;
        h4 = bits & 0x3f;

        // use hexets to index into b64, and append result to encoded string
        tmp_arr[ac++] = b64.charAt(h1) + b64.charAt(h2) + b64.charAt(h3) + b64.charAt(h4);
    } while (i < data.length);

    enc = tmp_arr.join('');

    switch (data.length % 3) {
        case 1:
            enc = enc.slice(0, -2) + '==';
        break;
        case 2:
            enc = enc.slice(0, -1) + '=';
        break;
    }

    return enc;
}

},{}],174:[function(_dereq_,module,exports){
var crypto = _dereq_('crypto');

var mapping = {
    md2: 'md2',
    md5: 'md5',
    'sha-1': 'sha1',
    'sha-224': 'sha224',
    'sha-256': 'sha256',
    'sha-384': 'sha384',
    'sha-512': 'sha512'
};

var names = Object.keys(mapping);


exports.getHashes = function () {
    var result = [];
    var available = crypto.getHashes();
    for (var i = 0, len = names.length; i < len; i++) {
        if (available.indexOf(mapping[names[i]]) >= 0) {
            result.push(names[i]);
        }
    }
    return result;
};

exports.createHash = function (algorithm) {
    algorithm = algorithm.toLowerCase();
    if (mapping[algorithm]) {
        algorithm = mapping[algorithm];
    }
    return crypto.createHash(algorithm);
};

exports.createHmac = function (algorithm, key) {
    algorithm = algorithm.toLowerCase();
    if (mapping[algorithm]) {
        algorithm = mapping[algorithm];
    }
    return crypto.createHmac(algorithm, key);
};

},{"crypto":178}],175:[function(_dereq_,module,exports){
arguments[4][151][0].apply(exports,arguments)
},{"./md5":179,"buffer":147,"ripemd160":182,"sha.js":184}],176:[function(_dereq_,module,exports){
(function (Buffer){
var createHash = _dereq_('./create-hash')

var zeroBuffer = new Buffer(128)
zeroBuffer.fill(0)

module.exports = Hmac

function Hmac (alg, key) {
  if(!(this instanceof Hmac)) return new Hmac(alg, key)
  this._opad = opad
  this._alg = alg

  var blocksize = (alg === 'sha512') ? 128 : 64

  key = this._key = !Buffer.isBuffer(key) ? new Buffer(key) : key

  if(key.length > blocksize) {
    key = createHash(alg).update(key).digest()
  } else if(key.length < blocksize) {
    key = Buffer.concat([key, zeroBuffer], blocksize)
  }

  var ipad = this._ipad = new Buffer(blocksize)
  var opad = this._opad = new Buffer(blocksize)

  for(var i = 0; i < blocksize; i++) {
    ipad[i] = key[i] ^ 0x36
    opad[i] = key[i] ^ 0x5C
  }

  this._hash = createHash(alg).update(ipad)
}

Hmac.prototype.update = function (data, enc) {
  this._hash.update(data, enc)
  return this
}

Hmac.prototype.digest = function (enc) {
  var h = this._hash.digest()
  return createHash(this._alg).update(this._opad).update(h).digest(enc)
}


}).call(this,_dereq_("buffer").Buffer)
},{"./create-hash":175,"buffer":147}],177:[function(_dereq_,module,exports){
module.exports=_dereq_(153)
},{"buffer":147}],178:[function(_dereq_,module,exports){
(function (Buffer){
var rng = _dereq_('./rng')

function error () {
  var m = [].slice.call(arguments).join(' ')
  throw new Error([
    m,
    'we accept pull requests',
    'http://github.com/dominictarr/crypto-browserify'
    ].join('\n'))
}

exports.createHash = _dereq_('./create-hash')

exports.createHmac = _dereq_('./create-hmac')

exports.randomBytes = function(size, callback) {
  if (callback && callback.call) {
    try {
      callback.call(this, undefined, new Buffer(rng(size)))
    } catch (err) { callback(err) }
  } else {
    return new Buffer(rng(size))
  }
}

function each(a, f) {
  for(var i in a)
    f(a[i], i)
}

exports.getHashes = function () {
  return ['sha1', 'sha256', 'sha512', 'md5', 'rmd160']
}

var p = _dereq_('./pbkdf2')(exports)
exports.pbkdf2 = p.pbkdf2
exports.pbkdf2Sync = p.pbkdf2Sync


// the least I can do is make error messages for the rest of the node.js/crypto api.
each(['createCredentials'
, 'createCipher'
, 'createCipheriv'
, 'createDecipher'
, 'createDecipheriv'
, 'createSign'
, 'createVerify'
, 'createDiffieHellman'
], function (name) {
  exports[name] = function () {
    error('sorry,', name, 'is not implemented yet')
  }
})

}).call(this,_dereq_("buffer").Buffer)
},{"./create-hash":175,"./create-hmac":176,"./pbkdf2":188,"./rng":189,"buffer":147}],179:[function(_dereq_,module,exports){
module.exports=_dereq_(155)
},{"./helpers":177}],180:[function(_dereq_,module,exports){
var crypto = _dereq_('crypto')

var exportFn = _dereq_('./pbkdf2')
var exported = exportFn(crypto)

module.exports = {
  pbkdf2: exported.pbkdf2,
  pbkdf2Sync: exported.pbkdf2Sync,

  // for crypto-browserify
  __pbkdf2Export: exportFn
}

},{"./pbkdf2":181,"crypto":154}],181:[function(_dereq_,module,exports){
(function (Buffer){
module.exports = function(crypto) {
  function pbkdf2(password, salt, iterations, keylen, digest, callback) {
    if ('function' === typeof digest) {
      callback = digest
      digest = undefined
    }

    if ('function' !== typeof callback)
      throw new Error('No callback provided to pbkdf2')

    setTimeout(function() {
      var result

      try {
        result = pbkdf2Sync(password, salt, iterations, keylen, digest)
      } catch (e) {
        return callback(e)
      }

      callback(undefined, result)
    })
  }

  function pbkdf2Sync(password, salt, iterations, keylen, digest) {
    if ('number' !== typeof iterations)
      throw new TypeError('Iterations not a number')

    if (iterations < 0)
      throw new TypeError('Bad iterations')

    if ('number' !== typeof keylen)
      throw new TypeError('Key length not a number')

    if (keylen < 0)
      throw new TypeError('Bad key length')

    digest = digest || 'sha1'

    if (!Buffer.isBuffer(password)) password = new Buffer(password)
    if (!Buffer.isBuffer(salt)) salt = new Buffer(salt)

    var hLen, l = 1, r, T
    var DK = new Buffer(keylen)
    var block1 = new Buffer(salt.length + 4)
    salt.copy(block1, 0, 0, salt.length)

    for (var i = 1; i <= l; i++) {
      block1.writeUInt32BE(i, salt.length)

      var U = crypto.createHmac(digest, password).update(block1).digest()

      if (!hLen) {
        hLen = U.length
        T = new Buffer(hLen)
        l = Math.ceil(keylen / hLen)
        r = keylen - (l - 1) * hLen

        if (keylen > (Math.pow(2, 32) - 1) * hLen)
          throw new TypeError('keylen exceeds maximum length')
      }

      U.copy(T, 0, 0, hLen)

      for (var j = 1; j < iterations; j++) {
        U = crypto.createHmac(digest, password).update(U).digest()

        for (var k = 0; k < hLen; k++) {
          T[k] ^= U[k]
        }
      }

      var destPos = (i - 1) * hLen
      var len = (i == l ? r : hLen)
      T.copy(DK, destPos, 0, len)
    }

    return DK
  }

  return {
    pbkdf2: pbkdf2,
    pbkdf2Sync: pbkdf2Sync
  }
}

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":147}],182:[function(_dereq_,module,exports){
module.exports=_dereq_(156)
},{"buffer":147}],183:[function(_dereq_,module,exports){
module.exports = function (Buffer) {

  //prototype class for hash functions
  function Hash (blockSize, finalSize) {
    this._block = new Buffer(blockSize) //new Uint32Array(blockSize/4)
    this._finalSize = finalSize
    this._blockSize = blockSize
    this._len = 0
    this._s = 0
  }

  Hash.prototype.init = function () {
    this._s = 0
    this._len = 0
  }

  Hash.prototype.update = function (data, enc) {
    if ("string" === typeof data) {
      enc = enc || "utf8"
      data = new Buffer(data, enc)
    }

    var l = this._len += data.length
    var s = this._s = (this._s || 0)
    var f = 0
    var buffer = this._block

    while (s < l) {
      var t = Math.min(data.length, f + this._blockSize - (s % this._blockSize))
      var ch = (t - f)

      for (var i = 0; i < ch; i++) {
        buffer[(s % this._blockSize) + i] = data[i + f]
      }

      s += ch
      f += ch

      if ((s % this._blockSize) === 0) {
        this._update(buffer)
      }
    }
    this._s = s

    return this
  }

  Hash.prototype.digest = function (enc) {
    // Suppose the length of the message M, in bits, is l
    var l = this._len * 8

    // Append the bit 1 to the end of the message
    this._block[this._len % this._blockSize] = 0x80

    // and then k zero bits, where k is the smallest non-negative solution to the equation (l + 1 + k) === finalSize mod blockSize
    this._block.fill(0, this._len % this._blockSize + 1)

    if (l % (this._blockSize * 8) >= this._finalSize * 8) {
      this._update(this._block)
      this._block.fill(0)
    }

    // to this append the block which is equal to the number l written in binary
    // TODO: handle case where l is > Math.pow(2, 29)
    this._block.writeInt32BE(l, this._blockSize - 4)

    var hash = this._update(this._block) || this._hash()

    return enc ? hash.toString(enc) : hash
  }

  Hash.prototype._update = function () {
    throw new Error('_update must be implemented by subclass')
  }

  return Hash
}

},{}],184:[function(_dereq_,module,exports){
var exports = module.exports = function (alg) {
  var Alg = exports[alg]
  if(!Alg) throw new Error(alg + ' is not supported (we accept pull requests)')
  return new Alg()
}

var Buffer = _dereq_('buffer').Buffer
var Hash   = _dereq_('./hash')(Buffer)

exports.sha1 = _dereq_('./sha1')(Buffer, Hash)
exports.sha256 = _dereq_('./sha256')(Buffer, Hash)
exports.sha512 = _dereq_('./sha512')(Buffer, Hash)

},{"./hash":183,"./sha1":185,"./sha256":186,"./sha512":187,"buffer":147}],185:[function(_dereq_,module,exports){
/*
 * A JavaScript implementation of the Secure Hash Algorithm, SHA-1, as defined
 * in FIPS PUB 180-1
 * Version 2.1a Copyright Paul Johnston 2000 - 2002.
 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
 * Distributed under the BSD License
 * See http://pajhome.org.uk/crypt/md5 for details.
 */

var inherits = _dereq_('util').inherits

module.exports = function (Buffer, Hash) {

  var A = 0|0
  var B = 4|0
  var C = 8|0
  var D = 12|0
  var E = 16|0

  var W = new (typeof Int32Array === 'undefined' ? Array : Int32Array)(80)

  var POOL = []

  function Sha1 () {
    if(POOL.length)
      return POOL.pop().init()

    if(!(this instanceof Sha1)) return new Sha1()
    this._w = W
    Hash.call(this, 16*4, 14*4)

    this._h = null
    this.init()
  }

  inherits(Sha1, Hash)

  Sha1.prototype.init = function () {
    this._a = 0x67452301
    this._b = 0xefcdab89
    this._c = 0x98badcfe
    this._d = 0x10325476
    this._e = 0xc3d2e1f0

    Hash.prototype.init.call(this)
    return this
  }

  Sha1.prototype._POOL = POOL
  Sha1.prototype._update = function (X) {

    var a, b, c, d, e, _a, _b, _c, _d, _e

    a = _a = this._a
    b = _b = this._b
    c = _c = this._c
    d = _d = this._d
    e = _e = this._e

    var w = this._w

    for(var j = 0; j < 80; j++) {
      var W = w[j] = j < 16 ? X.readInt32BE(j*4)
        : rol(w[j - 3] ^ w[j -  8] ^ w[j - 14] ^ w[j - 16], 1)

      var t = add(
        add(rol(a, 5), sha1_ft(j, b, c, d)),
        add(add(e, W), sha1_kt(j))
      )

      e = d
      d = c
      c = rol(b, 30)
      b = a
      a = t
    }

    this._a = add(a, _a)
    this._b = add(b, _b)
    this._c = add(c, _c)
    this._d = add(d, _d)
    this._e = add(e, _e)
  }

  Sha1.prototype._hash = function () {
    if(POOL.length < 100) POOL.push(this)
    var H = new Buffer(20)
    //console.log(this._a|0, this._b|0, this._c|0, this._d|0, this._e|0)
    H.writeInt32BE(this._a|0, A)
    H.writeInt32BE(this._b|0, B)
    H.writeInt32BE(this._c|0, C)
    H.writeInt32BE(this._d|0, D)
    H.writeInt32BE(this._e|0, E)
    return H
  }

  /*
   * Perform the appropriate triplet combination function for the current
   * iteration
   */
  function sha1_ft(t, b, c, d) {
    if(t < 20) return (b & c) | ((~b) & d);
    if(t < 40) return b ^ c ^ d;
    if(t < 60) return (b & c) | (b & d) | (c & d);
    return b ^ c ^ d;
  }

  /*
   * Determine the appropriate additive constant for the current iteration
   */
  function sha1_kt(t) {
    return (t < 20) ?  1518500249 : (t < 40) ?  1859775393 :
           (t < 60) ? -1894007588 : -899497514;
  }

  /*
   * Add integers, wrapping at 2^32. This uses 16-bit operations internally
   * to work around bugs in some JS interpreters.
   * //dominictarr: this is 10 years old, so maybe this can be dropped?)
   *
   */
  function add(x, y) {
    return (x + y ) | 0
  //lets see how this goes on testling.
  //  var lsw = (x & 0xFFFF) + (y & 0xFFFF);
  //  var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  //  return (msw << 16) | (lsw & 0xFFFF);
  }

  /*
   * Bitwise rotate a 32-bit number to the left.
   */
  function rol(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }

  return Sha1
}

},{"util":169}],186:[function(_dereq_,module,exports){

/**
 * A JavaScript implementation of the Secure Hash Algorithm, SHA-256, as defined
 * in FIPS 180-2
 * Version 2.2-beta Copyright Angel Marin, Paul Johnston 2000 - 2009.
 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
 *
 */

var inherits = _dereq_('util').inherits

module.exports = function (Buffer, Hash) {

  var K = [
      0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
      0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
      0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
      0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
      0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC,
      0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
      0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
      0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
      0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
      0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
      0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3,
      0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
      0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5,
      0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
      0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
      0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
    ]

  var W = new Array(64)

  function Sha256() {
    this.init()

    this._w = W //new Array(64)

    Hash.call(this, 16*4, 14*4)
  }

  inherits(Sha256, Hash)

  Sha256.prototype.init = function () {

    this._a = 0x6a09e667|0
    this._b = 0xbb67ae85|0
    this._c = 0x3c6ef372|0
    this._d = 0xa54ff53a|0
    this._e = 0x510e527f|0
    this._f = 0x9b05688c|0
    this._g = 0x1f83d9ab|0
    this._h = 0x5be0cd19|0

    this._len = this._s = 0

    return this
  }

  function S (X, n) {
    return (X >>> n) | (X << (32 - n));
  }

  function R (X, n) {
    return (X >>> n);
  }

  function Ch (x, y, z) {
    return ((x & y) ^ ((~x) & z));
  }

  function Maj (x, y, z) {
    return ((x & y) ^ (x & z) ^ (y & z));
  }

  function Sigma0256 (x) {
    return (S(x, 2) ^ S(x, 13) ^ S(x, 22));
  }

  function Sigma1256 (x) {
    return (S(x, 6) ^ S(x, 11) ^ S(x, 25));
  }

  function Gamma0256 (x) {
    return (S(x, 7) ^ S(x, 18) ^ R(x, 3));
  }

  function Gamma1256 (x) {
    return (S(x, 17) ^ S(x, 19) ^ R(x, 10));
  }

  Sha256.prototype._update = function(M) {

    var W = this._w
    var a, b, c, d, e, f, g, h
    var T1, T2

    a = this._a | 0
    b = this._b | 0
    c = this._c | 0
    d = this._d | 0
    e = this._e | 0
    f = this._f | 0
    g = this._g | 0
    h = this._h | 0

    for (var j = 0; j < 64; j++) {
      var w = W[j] = j < 16
        ? M.readInt32BE(j * 4)
        : Gamma1256(W[j - 2]) + W[j - 7] + Gamma0256(W[j - 15]) + W[j - 16]

      T1 = h + Sigma1256(e) + Ch(e, f, g) + K[j] + w

      T2 = Sigma0256(a) + Maj(a, b, c);
      h = g; g = f; f = e; e = d + T1; d = c; c = b; b = a; a = T1 + T2;
    }

    this._a = (a + this._a) | 0
    this._b = (b + this._b) | 0
    this._c = (c + this._c) | 0
    this._d = (d + this._d) | 0
    this._e = (e + this._e) | 0
    this._f = (f + this._f) | 0
    this._g = (g + this._g) | 0
    this._h = (h + this._h) | 0

  };

  Sha256.prototype._hash = function () {
    var H = new Buffer(32)

    H.writeInt32BE(this._a,  0)
    H.writeInt32BE(this._b,  4)
    H.writeInt32BE(this._c,  8)
    H.writeInt32BE(this._d, 12)
    H.writeInt32BE(this._e, 16)
    H.writeInt32BE(this._f, 20)
    H.writeInt32BE(this._g, 24)
    H.writeInt32BE(this._h, 28)

    return H
  }

  return Sha256

}

},{"util":169}],187:[function(_dereq_,module,exports){
var inherits = _dereq_('util').inherits

module.exports = function (Buffer, Hash) {
  var K = [
    0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd,
    0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
    0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019,
    0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
    0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe,
    0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
    0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1,
    0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
    0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3,
    0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
    0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483,
    0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
    0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210,
    0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
    0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725,
    0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
    0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926,
    0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
    0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8,
    0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
    0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001,
    0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
    0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910,
    0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
    0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53,
    0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
    0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb,
    0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
    0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60,
    0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
    0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9,
    0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
    0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207,
    0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
    0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
    0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
    0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493,
    0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
    0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a,
    0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817
  ]

  var W = new Array(160)

  function Sha512() {
    this.init()
    this._w = W

    Hash.call(this, 128, 112)
  }

  inherits(Sha512, Hash)

  Sha512.prototype.init = function () {

    this._a = 0x6a09e667|0
    this._b = 0xbb67ae85|0
    this._c = 0x3c6ef372|0
    this._d = 0xa54ff53a|0
    this._e = 0x510e527f|0
    this._f = 0x9b05688c|0
    this._g = 0x1f83d9ab|0
    this._h = 0x5be0cd19|0

    this._al = 0xf3bcc908|0
    this._bl = 0x84caa73b|0
    this._cl = 0xfe94f82b|0
    this._dl = 0x5f1d36f1|0
    this._el = 0xade682d1|0
    this._fl = 0x2b3e6c1f|0
    this._gl = 0xfb41bd6b|0
    this._hl = 0x137e2179|0

    this._len = this._s = 0

    return this
  }

  function S (X, Xl, n) {
    return (X >>> n) | (Xl << (32 - n))
  }

  function Ch (x, y, z) {
    return ((x & y) ^ ((~x) & z));
  }

  function Maj (x, y, z) {
    return ((x & y) ^ (x & z) ^ (y & z));
  }

  Sha512.prototype._update = function(M) {

    var W = this._w
    var a, b, c, d, e, f, g, h
    var al, bl, cl, dl, el, fl, gl, hl

    a = this._a | 0
    b = this._b | 0
    c = this._c | 0
    d = this._d | 0
    e = this._e | 0
    f = this._f | 0
    g = this._g | 0
    h = this._h | 0

    al = this._al | 0
    bl = this._bl | 0
    cl = this._cl | 0
    dl = this._dl | 0
    el = this._el | 0
    fl = this._fl | 0
    gl = this._gl | 0
    hl = this._hl | 0

    for (var i = 0; i < 80; i++) {
      var j = i * 2

      var Wi, Wil

      if (i < 16) {
        Wi = W[j] = M.readInt32BE(j * 4)
        Wil = W[j + 1] = M.readInt32BE(j * 4 + 4)

      } else {
        var x  = W[j - 15*2]
        var xl = W[j - 15*2 + 1]
        var gamma0  = S(x, xl, 1) ^ S(x, xl, 8) ^ (x >>> 7)
        var gamma0l = S(xl, x, 1) ^ S(xl, x, 8) ^ S(xl, x, 7)

        x  = W[j - 2*2]
        xl = W[j - 2*2 + 1]
        var gamma1  = S(x, xl, 19) ^ S(xl, x, 29) ^ (x >>> 6)
        var gamma1l = S(xl, x, 19) ^ S(x, xl, 29) ^ S(xl, x, 6)

        // W[i] = gamma0 + W[i - 7] + gamma1 + W[i - 16]
        var Wi7  = W[j - 7*2]
        var Wi7l = W[j - 7*2 + 1]

        var Wi16  = W[j - 16*2]
        var Wi16l = W[j - 16*2 + 1]

        Wil = gamma0l + Wi7l
        Wi  = gamma0  + Wi7 + ((Wil >>> 0) < (gamma0l >>> 0) ? 1 : 0)
        Wil = Wil + gamma1l
        Wi  = Wi  + gamma1  + ((Wil >>> 0) < (gamma1l >>> 0) ? 1 : 0)
        Wil = Wil + Wi16l
        Wi  = Wi  + Wi16 + ((Wil >>> 0) < (Wi16l >>> 0) ? 1 : 0)

        W[j] = Wi
        W[j + 1] = Wil
      }

      var maj = Maj(a, b, c)
      var majl = Maj(al, bl, cl)

      var sigma0h = S(a, al, 28) ^ S(al, a, 2) ^ S(al, a, 7)
      var sigma0l = S(al, a, 28) ^ S(a, al, 2) ^ S(a, al, 7)
      var sigma1h = S(e, el, 14) ^ S(e, el, 18) ^ S(el, e, 9)
      var sigma1l = S(el, e, 14) ^ S(el, e, 18) ^ S(e, el, 9)

      // t1 = h + sigma1 + ch + K[i] + W[i]
      var Ki = K[j]
      var Kil = K[j + 1]

      var ch = Ch(e, f, g)
      var chl = Ch(el, fl, gl)

      var t1l = hl + sigma1l
      var t1 = h + sigma1h + ((t1l >>> 0) < (hl >>> 0) ? 1 : 0)
      t1l = t1l + chl
      t1 = t1 + ch + ((t1l >>> 0) < (chl >>> 0) ? 1 : 0)
      t1l = t1l + Kil
      t1 = t1 + Ki + ((t1l >>> 0) < (Kil >>> 0) ? 1 : 0)
      t1l = t1l + Wil
      t1 = t1 + Wi + ((t1l >>> 0) < (Wil >>> 0) ? 1 : 0)

      // t2 = sigma0 + maj
      var t2l = sigma0l + majl
      var t2 = sigma0h + maj + ((t2l >>> 0) < (sigma0l >>> 0) ? 1 : 0)

      h  = g
      hl = gl
      g  = f
      gl = fl
      f  = e
      fl = el
      el = (dl + t1l) | 0
      e  = (d + t1 + ((el >>> 0) < (dl >>> 0) ? 1 : 0)) | 0
      d  = c
      dl = cl
      c  = b
      cl = bl
      b  = a
      bl = al
      al = (t1l + t2l) | 0
      a  = (t1 + t2 + ((al >>> 0) < (t1l >>> 0) ? 1 : 0)) | 0
    }

    this._al = (this._al + al) | 0
    this._bl = (this._bl + bl) | 0
    this._cl = (this._cl + cl) | 0
    this._dl = (this._dl + dl) | 0
    this._el = (this._el + el) | 0
    this._fl = (this._fl + fl) | 0
    this._gl = (this._gl + gl) | 0
    this._hl = (this._hl + hl) | 0

    this._a = (this._a + a + ((this._al >>> 0) < (al >>> 0) ? 1 : 0)) | 0
    this._b = (this._b + b + ((this._bl >>> 0) < (bl >>> 0) ? 1 : 0)) | 0
    this._c = (this._c + c + ((this._cl >>> 0) < (cl >>> 0) ? 1 : 0)) | 0
    this._d = (this._d + d + ((this._dl >>> 0) < (dl >>> 0) ? 1 : 0)) | 0
    this._e = (this._e + e + ((this._el >>> 0) < (el >>> 0) ? 1 : 0)) | 0
    this._f = (this._f + f + ((this._fl >>> 0) < (fl >>> 0) ? 1 : 0)) | 0
    this._g = (this._g + g + ((this._gl >>> 0) < (gl >>> 0) ? 1 : 0)) | 0
    this._h = (this._h + h + ((this._hl >>> 0) < (hl >>> 0) ? 1 : 0)) | 0
  }

  Sha512.prototype._hash = function () {
    var H = new Buffer(64)

    function writeInt64BE(h, l, offset) {
      H.writeInt32BE(h, offset)
      H.writeInt32BE(l, offset + 4)
    }

    writeInt64BE(this._a, this._al, 0)
    writeInt64BE(this._b, this._bl, 8)
    writeInt64BE(this._c, this._cl, 16)
    writeInt64BE(this._d, this._dl, 24)
    writeInt64BE(this._e, this._el, 32)
    writeInt64BE(this._f, this._fl, 40)
    writeInt64BE(this._g, this._gl, 48)
    writeInt64BE(this._h, this._hl, 56)

    return H
  }

  return Sha512

}

},{"util":169}],188:[function(_dereq_,module,exports){
var pbkdf2Export = _dereq_('pbkdf2-compat').__pbkdf2Export

module.exports = function (crypto, exports) {
  exports = exports || {}

  var exported = pbkdf2Export(crypto)

  exports.pbkdf2 = exported.pbkdf2
  exports.pbkdf2Sync = exported.pbkdf2Sync

  return exports
}

},{"pbkdf2-compat":180}],189:[function(_dereq_,module,exports){
(function (global,Buffer){
(function() {
  var g = ('undefined' === typeof window ? global : window) || {}
  var foolBrowserify = _dereq_
  _crypto = (
    g.crypto || g.msCrypto || foolBrowserify('crypto')
  )
  module.exports = function(size) {
    // Modern Browsers
    if(_crypto.getRandomValues) {
      var bytes = new Buffer(size); //in browserify, this is an extended Uint8Array
      /* This will not work in older browsers.
       * See https://developer.mozilla.org/en-US/docs/Web/API/window.crypto.getRandomValues
       */
    
      _crypto.getRandomValues(bytes);
      return bytes;
    }
    else if (_crypto.randomBytes) {
      return _crypto.randomBytes(size)
    }
    else
      throw new Error(
        'secure random number generation not supported by this browser\n'+
        'use chrome, FireFox or Internet Explorer 11'
      )
  }
}())

}).call(this,typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},_dereq_("buffer").Buffer)
},{"buffer":147}],190:[function(_dereq_,module,exports){
module.exports = _dereq_('./lib/sessionManager');

},{"./lib/sessionManager":194}],191:[function(_dereq_,module,exports){
var _ = _dereq_('underscore');
var util = _dereq_('util');
var bows = _dereq_('bows');
var JingleSession = _dereq_('./genericSession');
var RTCPeerConnection = _dereq_('rtcpeerconnection');
var FileTransfer = _dereq_('filetransfer');


var log = bows('JingleFile');


function FileSession(opts) {
    JingleSession.call(this, opts);

    var self = this;

    var config = this.parent.config.peerConnectionConfig;
    var constraints = this.parent.config.peerConnectionConstraints;
    config.useJingle = true;

    this.pc = new RTCPeerConnection(config, constraints);
    this.pc.on('addChannel', this._onChannelAdded.bind(this));

    this.pc.on('ice', this._onIceCandidate.bind(this));
    this.pc.on('iceConnectionStateChange', function () {
        switch (self.pc.iceConnectionState) {
        case 'failed':
            // currently, in chrome only the initiator goes to failed
            // so we need to signal this to the peer
            if (self.pc.isInitiator) {
                self.parent.emit('iceFailed', self);
            }
            break;
        }
    });
    this.sender = new FileTransfer.Sender();
    this.sender.on('progress', function (sent, size) {
        log(self.sid + ': Send progress ' + sent + '/' + size);
    });
    this.sender.on('sentFile', function (metadata) {
        log(self.sid + ': Sent file ' + metadata.name);

        // send hash via description update
        var content = self.pc.localDescription.contents[0];
        delete content.transport;
        content.description = {
            descType: 'filetransfer',
            offer: {
                hash: {
                    algo: metadata.algo,
                    value: metadata.hash
                }
            }
        };
        self.send('description-info', { contents: [content] });
        self.parent.emit('sentFile', self, metadata);
    });

    this.receiver = new FileTransfer.Receiver();
    this.receiver.on('receivedFile', function (file) {
        self.receivedFile = file;
        self.maybeReceivedFile();
    });
    this.receiver.on('progress', function (received, size) {
        log(self.sid + ': Receive progress ' + received + '/' + size);
    });
}

util.inherits(FileSession, JingleSession);

FileSession.prototype._onChannelAdded = function (channel) {
    this.receiver.receive(null, channel);
};

FileSession.prototype = _.extend(FileSession.prototype, {
    start: function (file) {
        var self = this;
        this.state = 'pending';
        this.pc.isInitiator = true;
        var sendChannel = this.pc.createDataChannel('filetransfer');
        sendChannel.onopen = function () {
            self.sender.send(file, sendChannel);
        };

        var constraints = { mandatory: {
            OfferToReceiveAudio: false,
            OfferToReceiveVideo: false
        }};
        this.pc.offer(constraints, function (err, sessDesc) {
            // amend xep-0234 info
            sessDesc.jingle.contents[0].description = {
                descType: 'filetransfer',
                offer: {
                    date: file.lastModifiedDate,
                    //desc: '...',
                    name: file.name,
                    //range: null,
                    size: file.size,
                    hash: {
                        algo: 'sha-1',
                        value: ''
                    }
                }
            };
            self.send('session-initiate', sessDesc.jingle);
        });
    },
    end: function (reason, silence) {
        this.pc.close();
        JingleSession.prototype.end.call(this, reason, silence);
    },
    accept: function () {
        var self = this;

        log(this.sid + ': Accepted incoming session');

        this.state = 'active';
        this.pc.answer(function (err, answer) {
            if (err) {
                log(self.sid + ': Could not create WebRTC answer', err);
                return self.end('failed-application');
            }
            // FIXME: do we need to add the 0234 parts again? whyyyyyy...

            // work around firefox...
            answer.jingle.contents[0].name = 'data';

            self.send('session-accept', answer.jingle);
        });
    },
    onSessionInitiate: function (changes, cb) {
        var self = this;

        log(self.sid + ': Initiating incoming session');

        this.state = 'pending';
        this.pc.isInitiator = false;
        // strip XEP-0234 parts
        var desc = changes.contents[0].description;
        this.receiver.metadata = desc.offer.toJSON();

        // set hash used by peer
        if (this.receiver.metadata.hash) {
            this.receiver.config.hash = this.receiver.metadata.hash.algo;
        }
        // FIXME: checks on name, size and maxiumum allowed size

        // then feed to SJJ
        changes.contents[0].description = {
            descType: 'datachannel'
        };
        this.pc.handleOffer({type: 'offer', jingle: changes}, function (err) {
            if (err) {
                log(self.sid + ': Could not create WebRTC answer', err);
                return cb({condition: 'general-error'});
            }
            cb();
        });
    },
    onSessionAccept: function (changes, cb) {
        var self = this;

        log(this.sid + ': Activating accepted outbound session');

        this.state = 'active';
        changes.contents[0].description = {
            descType: 'datachannel'
        };
        this.pc.handleAnswer({type: 'answer', jingle: changes}, function (err) {
            if (err) {
                log(self.sid + ': Could not process WebRTC answer', err);
                return cb({condition: 'general-error'});
            }

            self.parent.emit('accepted', self);
            cb();
        });
    },
    onSessionTerminate: function (changes, cb) {
        log(this.sid + ': Terminating session');
        this.pc.close();
        JingleSession.prototype.end.call(this, changes.reason, true);
        cb();
    },
    onTransportInfo: function (changes, cb) {
        var self = this;

        log(this.sid + ': Adding ICE candidate');

        this.pc.processIce(changes, function (err) {
            if (err) {
                log(self.sid + ': Could not process ICE candidate', err);
            }
            cb();
        });
    },
    onDescriptionInfo: function (changes, cb) {
        // ignore anything but the value (which is the only thing that can change in a meaningful way)
        var hash = changes.contents[0].description.offer.hash;
        this.receiver.metadata.hash = hash;
        if (this.receiver.metadata.actualhash) {
            this.maybeReceivedFile();
        } else {
            // file is not yet complete
        }
        cb();
    },
    _onIceCandidate: function (candidateInfo) {
        log(this.sid + ': Discovered new ICE candidate', candidateInfo.jingle);
        candidateInfo.jingle.contents[0].name = 'data';
        this.send('transport-info', candidateInfo.jingle);
    },
    maybeReceivedFile: function () {
        if (!this.receiver.metadata.hash.value) {
            // hash not known yet
        } else if (this.receiver.metadata.hash.value === this.receiver.metadata.actualhash) {
            log(this.sid + ': Hash matches');
            this.parent.emit('receivedFile', this, this.receivedFile, this.receiver.metadata);
            this.end('success');
        } else {
            log(this.sid + ': Hash mismatch, terminating');
            this.end('media-error');
        }
    }
});

module.exports = FileSession;

},{"./genericSession":192,"bows":195,"filetransfer":197,"rtcpeerconnection":203,"underscore":234,"util":169}],192:[function(_dereq_,module,exports){
var bows = _dereq_('bows');
var async = _dereq_('async');
var WildEmitter = _dereq_('wildemitter');


var log = bows('JingleSession');


function actionToMethod(action) {
    var words = action.split('-');
    return 'on' + words[0][0].toUpperCase() + words[0].substr(1) + words[1][0].toUpperCase() + words[1].substr(1);
}

// actions defined in http://xmpp.org/extensions/xep-0166.html#def-action
var actions = [
    'content-accept', 'content-add', 'content-modify',
    'content-reject', 'content-remove', 'description-info',
    'session-accept', 'session-info', 'session-initiate',
    'session-terminate', 
    'source-add', 'source-remove', // unspecified actions, might go away anytime without notice
    'transport-accept', 'transport-info',
    'transport-reject', 'transport-replace'
];


function JingleSession(opts) {
    var self = this;
    this.sid = opts.sid || Date.now().toString();
    this.peer = opts.peer;
    this.isInitiator = opts.initiator || false;
    this.state = 'starting';
    this.parent = opts.parent;

    this.processingQueue = async.queue(function (task, next) {
        var action  = task.action;
        var changes = task.changes;
        var cb = task.cb;

        log(self.sid + ': ' + action);

        if (actions.indexOf(action) === -1) {
            log(this.sid + ': Invalid action ' + action);
            cb({condition: 'bad-request'});
            next();
            return;
        }

        var method = actionToMethod(action);
        self[method](changes, function (err) {
            cb(err);
            next();
        });
    });
}

JingleSession.prototype = Object.create(WildEmitter.prototype, {
    constructor: {
        value: JingleSession
    }
});


JingleSession.prototype.process = function (action, changes, cb) {
    this.processingQueue.push({
        action: action,
        changes: changes,
        cb: cb
    });
};

JingleSession.prototype.send = function (type, data) {
    data = data || {};
    data.sid = this.sid;
    data.action = type;
    this.parent.emit('send', {
        to: this.peer,
        type: 'set',
        jingle: data
    });
};

Object.defineProperty(JingleSession.prototype, 'state', {
    get: function () {
        return this._state;
    },
    set: function (value) {
        var validStates = {
            starting: true,
            pending: true,
            active: true,
            ended: true
        };

        if (!validStates[value]) {
            throw new Error('Invalid Jingle Session State: ' + value);
        }

        if (this._state !== value) {
            this._state = value;
            log(this.sid + ': State changed to ' + value);
        }
    }
});
Object.defineProperty(JingleSession.prototype, 'starting', {
    get: function () {
        return this._state === 'starting';
    }
});
Object.defineProperty(JingleSession.prototype, 'pending', {
    get: function () {
        return this._state === 'pending';
    }
});
Object.defineProperty(JingleSession.prototype, 'active', {
    get: function () {
        return this._state === 'active';
    }
});
Object.defineProperty(JingleSession.prototype, 'ended', {
    get: function () {
        return this._state === 'ended';
    }
});

JingleSession.prototype.start = function () {
    this.state = 'pending';
    log(this.sid + ': Can not start generic session');
};
JingleSession.prototype.end = function (reason, silence) {
    this.parent.peers[this.peer].splice(this.parent.peers[this.peer].indexOf(this), 1);
    delete this.parent.sessions[this.sid];

    this.state = 'ended';

    reason = reason || {};

    if (!silence) {
        this.send('session-terminate', {reason: reason});
    }

    this.parent.emit('terminated', this, reason);
};

actions.forEach(function (action) {
    var method = actionToMethod(action);
    JingleSession.prototype[method] = function (changes, cb) {
        log(this.sid + ': Unsupported action ' + action);
        cb();
    };
});

module.exports = JingleSession;

},{"async":108,"bows":195,"wildemitter":235}],193:[function(_dereq_,module,exports){
var _ = _dereq_('underscore');
var util = _dereq_('util');
var bows = _dereq_('bows');
var JingleSession = _dereq_('./genericSession');
var RTCPeerConnection = _dereq_('rtcpeerconnection');

var log = bows('JingleMedia');


function MediaSession(opts) {
    JingleSession.call(this, opts);

    var self = this;

    var config = this.parent.config.peerConnectionConfig;
    var constraints = this.parent.config.peerConnectionConstraints;
    config.useJingle = true;

    this.pc = new RTCPeerConnection(config, constraints);
    this.pc.on('ice', this._onIceCandidate.bind(this));
    this.pc.on('addStream', this._onStreamAdded.bind(this));
    this.pc.on('removeStream', this._onStreamRemoved.bind(this));
    this.pc.on('iceConnectionStateChange', function () {
        switch (self.pc.iceConnectionState) {
        case 'failed':
            // currently, in chrome only the initiator goes to failed
            // so we need to signal this to the peer
            if (self.pc.isInitiator) {
                self.parent.emit('iceFailed', self);
            }
            break;
        }
    });
}

util.inherits(MediaSession, JingleSession);


Object.defineProperty(MediaSession.prototype, 'streams', {
    get: function () {
        return this.pc.remoteStreams;
    }
});


MediaSession.prototype = _.extend(MediaSession.prototype, {
    start: function (constraints) {
        var self = this;
        this.state = 'pending';
        this.pc.isInitiator = true;
        this.pc.offer(constraints, function (err, sessDesc) {
            // a workaround for missing a=sendonly
            // https://code.google.com/p/webrtc/issues/detail?id=1553
            if (constraints && constraints.mandatory) {
                sessDesc.jingle.contents.forEach(function (content) {
                    if (!content.description || content.description.descType !== 'rtp') {
                        return;
                    }
                    if (!constraints.mandatory.OfferToReceiveAudio &&
                            content.description.media === 'audio') {
                        content.senders = 'initiator';
                    }
                    if (!constraints.mandatory.OfferToReceiveVideo &&
                            content.description.media === 'video') {
                        content.senders = 'initiator';
                    }
                });
            }
            self.send('session-initiate', sessDesc.jingle);
        });
    },
    end: function (reason, silence) {
        var self = this;
        this.pc.close();
        _.each(this.streams, function (stream) {
            self._onStreamRemoved({stream: stream});
        });
        JingleSession.prototype.end.call(this, reason, silence);
    },
    accept: function () {
        var self = this;

        log(this.sid + ': Accepted incoming session');

        this.state = 'active';
        this.pc.answer(function (err, answer) {
            if (err) {
                log(self.sid + ': Could not create WebRTC answer', err);
                return self.end('failed-application');
            }
            self.send('session-accept', answer.jingle);
        });
    },
    ring: function () {
        log(this.sid + ': Ringing on incoming session');
        this.send('session-info', {ringing: true});
    },
    mute: function (creator, name) {
        log(this.sid + ': Muting');
        this.send('session-info', {mute: {creator: creator, name: name}});
    },
    unmute: function (creator, name) {
        log(this.sid + ': Unmuting');
        this.send('session-info', {unmute: {creator: creator, name: name}});
    },
    hold: function () {
        log(this.sid + ': Placing on hold');
        this.send('session-info', {hold: true});
    },
    resume: function () {
        log(this.sid + ': Resuing from hold');
        this.send('session-info', {active: true});
    },
    addStream: function (stream) {
        this.pc.addStream(stream);
    },
    addStream2: function (stream) {
        // note that this method is highly experimental and may 
        // go away without notice
        // it is basically a renegotiation-capable version of addStream
        var self = this;
        this.pc.addStream(stream);
        this.pc.handleOffer({type: 'offer', jingle: this.pc.remoteDescription}, function (err) {
            console.log('handleOffer', err);
            self.pc.answer(function (err, answer) {
                console.log('answer', answer);
                answer.jingle.contents.forEach(function (content) {
                    //console.log('answer', content.name, 'msid', content.description.sources[0].parameters[1].value.split(' ')[0]);
                    delete content.transport;
                    delete content.description.payloads;
                    if (content.description.sources) {
                        content.description.sources = content.description.sources.filter(function (source) {
                            return stream.id === source.parameters[1].value.split(' ')[0];
                        });
                    }
                });
                self.send('source-add', answer.jingle);
            });
        });
    },
    removeStream: function (stream) {
        this.pc.removeStream(stream);
    },
    removeStream2: function (stream) {
        // note that this method is highly experimental and may 
        // go away without notice
        // it is basically a renegotiation-capable version of removeStream
        var self = this;
        var desc = this.pc.localDescription;
        console.log('remove stream id', stream.id);
        desc.contents.forEach(function (content) {
            delete content.transport;
            delete content.description.payloads;
            if (content.description.sources) {
                content.description.sources = content.description.sources.filter(function (source) {
                    return stream.id === source.parameters[1].value.split(' ')[0];
                });
            }
        });
        this.send('source-remove', desc);
        this.pc.removeStream(stream);

        this.pc.handleOffer({type: 'offer', jingle: this.pc.remoteDescription}, function (err) {
            console.log('handleOffer', err);
            self.pc.answer(function (err, answer) {
                console.log('answer', answer);
            });
        });
    },
    onSessionInitiate: function (changes, cb) {
        var self = this;

        log(self.sid + ': Initiating incoming session');

        this.state = 'pending';
        this.pc.isInitiator = false;
        this.pc.handleOffer({type: 'offer', jingle: changes}, function (err) {
            if (err) {
                log(self.sid + ': Could not create WebRTC answer', err);
                return cb({condition: 'general-error'});
            }
            cb();
        });
    },
    onSessionAccept: function (changes, cb) {
        var self = this;

        log(this.sid + ': Activating accepted outbound session');

        this.state = 'active';
        this.pc.handleAnswer({type: 'answer', jingle: changes}, function (err) {
            if (err) {
                log(self.sid + ': Could not process WebRTC answer', err);
                return cb({condition: 'general-error'});
            }

            self.parent.emit('accepted', self);
            cb();
        });
    },
    onSessionTerminate: function (changes, cb) {
        var self = this;
        log(this.sid + ': Terminating session');
        this.pc.close();
        _.each(this.streams, function (stream) {
            self._onStreamRemoved({stream: stream});
        });
        JingleSession.prototype.end.call(this, changes.reason, true);
        cb();
    },
    onTransportInfo: function (changes, cb) {
        var self = this;

        log(this.sid + ': Adding ICE candidate');

        this.pc.processIce(changes, function (err) {
            if (err) {
                log(self.sid + ': Could not process ICE candidate', err);
            }
            cb();
        });
    },
    onSessionInfo: function (info, cb) {
        log(info);
        if (info.ringing) {
            log(this.sid + ': Ringing on remote stream');
            this.parent.emit('ringing', this);
        }

        if (info.hold) {
            log(this.sid + ': On hold');
            this.parent.emit('hold', this);
        }

        if (info.active) {
            log(this.sid + ': Resumed from hold');
            this.parent.emit('resumed', this);
        }

        if (info.mute) {
            log(this.sid + ': Muted', info.mute);
            this.parent.emit('mute', this, info.mute);
        }

        if (info.unmute) {
            log(this.sid + ': Unmuted', info.unmute);
            this.parent.emit('unmute', this, info.unmute);
        }

        cb();
    },
    onSourceAdd: function (changes, cb) {
        // note that this method is highly experimental and may 
        // go away without notice
        var self = this;

        // icky stuff that is necessary until chrome 36
        // https://code.google.com/p/webrtc/issues/detail?id=2688
        if (!this.pc || this.pc.iceConnectionState === 'closed') {
            return;
        }
        if (this.pc.iceConnectionState !== 'connected') {
            this.waitForUpdate = true;
            window.setTimeout(function () {
                self.onSourceAdd(changes, cb);
            }, 250);
            return;
        }
        if (this.waitForUpdate) {
            delete this.waitForUpdate;
            window.setTimeout(function () {
                self.onSourceAdd(changes, cb);
            }, 500);
            return;
        }
        
        log(this.sid + ': source-add');

        var newDesc = this.pc.remoteDescription;
        this.pc.remoteDescription.contents.forEach(function (content, idx) {
            var desc = content.description;
            var ssrcs = desc.sources || [];

            changes.contents.forEach(function (newcontent) {
                if (content.name !== newcontent.name) {
                    return;
                }
                var newdesc = newcontent.description;
                var newssrcs = newdesc.sources || [];

                // for some reason a JSON-deepcopy is needed
                ssrcs = ssrcs.concat(newssrcs);
                newDesc.contents[idx].description.sources = JSON.parse(JSON.stringify(ssrcs));
            });
        });

        // FIXME: this block is pretty reusable, even though sometimes the 
        // order of setRemoteDescription/setLocalDescription should change
        this.pc.handleOffer({type: 'offer', jingle: newDesc}, function (err) {
            if (err) {
                // handle error
                log(this.sid + ': source-add offer error');
                return cb({condition: 'general-error'});
            }
            self.pc.answer(function (err/*, answer*/) {
                // answer is ignored here
                if (err) {
                    log(this.sid + ': source-add answer error');
                    return cb({condition: 'general-error'});
                }
                cb();
            });
        });
    },
    onSourceRemove: function (changes, cb) {
        // note that this method is highly experimental and may 
        // go away without notice
        var self = this;

        // icky stuff that is necessary until chrome 36
        // https://code.google.com/p/webrtc/issues/detail?id=2688
        if (!this.pc || this.pc.iceConnectionState === 'closed') {
            return;
        }
        if (this.pc.iceConnectionState !== 'connected') {
            this.waitForUpdate = true;
            window.setTimeout(function () {
                self.onSourceRemove(changes, cb);
            }, 250);
            return;
        }
        if (this.waitForUpdate) {
            delete this.waitForUpdate;
            window.setTimeout(function () {
                self.onSourceRemove(changes, cb);
            }, 500);
            return;
        }

        log(this.sid + ': source-remove');

        var newDesc = this.pc.remoteDescription;
        this.pc.remoteDescription.contents.forEach(function (content, idx) {
            var desc = content.description;
            var ssrcs = desc.sources || [];

            changes.contents.forEach(function (newcontent) {
                if (content.name !== newcontent.name) {
                    return;
                }
                var newdesc = newcontent.description;
                var newssrcs = newdesc.sources || [];

                // search the ssrc to be removed in ssrcs
                // FIXME: handle more than one newssrc
                var found = -1;
                for (var i = 0; i < newssrcs.length; i++) {
                    for (var j = 0; j < ssrcs.length; j++) {
                        if (newssrcs[i].ssrc === ssrcs[j].ssrc) {
                            found = j;
                            break;
                        }
                    }
                    if (found > -1) {
                        // for some reason a JSON-deepcopy is needed
                        ssrcs.splice(found, 1);
                        newDesc.contents[idx].description.sources = JSON.parse(JSON.stringify(ssrcs));
                    }
                }

            });
        });
        // FIXME: this block is pretty reusable, even though sometimes the 
        // order of setRemoteDescription/setLocalDescription should change
        this.pc.handleOffer({type: 'offer', jingle: newDesc}, function (err) {
            if (err) {
                // handle error
                log(this.sid + ': source-remove offer error');
                return cb({condition: 'general-error'});
            }
            self.pc.answer(function (err/*, answer*/) {
                // answer is ignored here
                if (err) {
                    log(this.sid + ': source-remove answer error');
                    return cb({condition: 'general-error'});
                }
                cb();
            });
        });
    },
    switchStream: function (oldStream, newStream) {
        var self = this;
        // pluck the <source/> to be removed
        // which is where oldstream.label == localDescription.contents[1].description.sources[0].parameters[1].value.split(" ")[0]
        // FIXME: generate instead of deleting
        var desc = this.pc.localDescription;
        desc.contents.forEach(function (content) {
            delete content.transport;
            delete content.description.payloads;
        });
        console.log(JSON.parse(JSON.stringify(desc)));
        this.pc.removeStream(oldStream);
        // FIXME: send a source-remove
        this.send('source-remove', desc);

        // FIXME: does this belong here? it's rather specific to cam->screenshare
        var audioTracks = oldStream.getAudioTracks();
        if (audioTracks.length) {
            newStream.addTrack(audioTracks[0]);
        }

        //console.log(newStream);
        this.pc.addStream(newStream);
        this.pc.handleOffer({type: 'offer', jingle: this.pc.remoteDescription}, function (err) {
            console.log('handleOffer', err);
            self.pc.answer(function (err, answer) {
                console.log('answer', answer);
                answer.jingle.contents.forEach(function (content) {
                    delete content.transport;
                    delete content.description.payloads;
                });
                console.log(JSON.parse(JSON.stringify(answer.jingle)));
                self.send('source-add', answer.jingle);
            });
        });
    },
    _onIceCandidate: function (candidateInfo) {
        log(this.sid + ': Discovered new ICE candidate', candidateInfo.jingle);
        this.send('transport-info', candidateInfo.jingle);
    },
    _onStreamAdded: function (event) {
        log(this.sid + ': Remote media stream added');

        // unfortunately, firefox does not support this yet
        /*
        event.stream.onended = function () {
            self._onStreamRemoved({stream: event.stream});
        };
        */

        this.parent.emit('peerStreamAdded', this, event.stream);
    },
    _onStreamRemoved: function (event) {
        log(this.sid + ': Remote media stream removed');
        this.parent.emit('peerStreamRemoved', this, event.stream);
    }
});


module.exports = MediaSession;

},{"./genericSession":192,"bows":195,"rtcpeerconnection":203,"underscore":234,"util":169}],194:[function(_dereq_,module,exports){
var _ = _dereq_('underscore');
var bows = _dereq_('bows');
var hark = _dereq_('hark');
var webrtc = _dereq_('webrtcsupport');
var WildEmitter = _dereq_('wildemitter');

var GenericSession = _dereq_('./genericSession');
var MediaSession = _dereq_('./mediaSession');
var FileSession = _dereq_('./fileSession');


var log = bows('Jingle');


function Jingle(opts) {
    opts = opts || {};
    var config = this.config = {
        debug: false,
        peerConnectionConfig: {
            iceServers: [{'url': 'stun:stun.l.google.com:19302'}]
        },
        peerConnectionConstraints: {
            optional: [
                {DtlsSrtpKeyAgreement: true},
                {RtpDataChannels: false}
            ]
        },
        autoAdjustMic: false,
        media: {
            audio: true,
            video: true
        }
    };

    this.MediaSession = MediaSession;
    this.jid = opts.jid;
    this.sessions = {};
    this.peers = {};

    this.screenSharingSupport = webrtc.screenSharing;

    for (var item in opts) {
        config[item] = opts[item];
    }

    this.capabilities = [
        'urn:xmpp:jingle:1'
    ];
    if (webrtc.support) {
        this.capabilities = [
            'urn:xmpp:jingle:1',
            'urn:xmpp:jingle:apps:rtp:1',
            'urn:xmpp:jingle:apps:rtp:audio',
            'urn:xmpp:jingle:apps:rtp:video',
            'urn:xmpp:jingle:apps:rtp:rtcb-fb:0',
            'urn:xmpp:jingle:apps:rtp:rtp-hdrext:0',
            'urn:xmpp:jingle:apps:rtp:ssma:0',
            'urn:xmpp:jingle:apps:dtls:0',
            'urn:xmpp:jingle:apps:grouping:0',
            'urn:xmpp:jingle:apps:file-transfer:3',
            'urn:xmpp:jingle:transports:ice-udp:1',
            'urn:xmpp:jingle:transports.dtls-sctp:1',
            'urn:ietf:rfc:3264',
            'urn:ietf:rfc:5576',
            'urn:ietf:rfc:5888'
        ];
    } else {
        log('WebRTC not supported');
    }

    WildEmitter.call(this);

    if (this.config.debug) {
        this.on('*', function (event, val1, val2) {
            log(event, val1, val2);
        });
    }
}

Jingle.prototype = Object.create(WildEmitter.prototype, {
    constructor: {
        value: Jingle
    }
});

Jingle.prototype.addICEServer = function (server) {
    this.config.peerConnectionConfig.iceServers.push(server);
};

Jingle.prototype.setupAudioMonitor = function (stream) {
    log('Setup audio');
    var audio = hark(stream);
    var self = this;
    var timeout;

    audio.on('speaking', function () {
        if (self.hardMuted) {
            return;
        }
        self.setMicIfEnabled(1);
        self.emit('speaking');
    });

    audio.on('stopped_speaking', function () {
        if (self.hardMuted) {
            return;
        }
        if (timeout) {
            clearTimeout(timeout);
        }

        timeout = setTimeout(function () {
            self.setMicIfEnabled(0.5);
            self.emit('stoppedSpeaking');
        }, 1000);
    });
};

Jingle.prototype.setMicIfEnabled = function (volume) {
    if (!this.config.autoAdjustMic) {
        return;
    }
    this.gainController.setGain(volume);
};

Jingle.prototype.sendError = function (to, id, data) {
    data.type = 'cancel';
    this.emit('send', {
        to: to,
        id: id,
        type: 'error',
        error: data
    });
};

Jingle.prototype.process = function (req) {
    var self = this;

    if (req.type === 'error') {
        return this.emit('error', req);
    }

    if (req.type === 'result') {
        return;
    }

    var sids, currsid, sess;
    var sid = req.jingle.sid;
    var action = req.jingle.action;
    var contents = req.jingle.contents || [];
    var contentTypes = _.map(contents, function (content) {
        return (content.description || {}).descType;
    });

    var session = this.sessions[sid] || null;

    var sender = req.from.full || req.from;
    var reqid = req.id;

    if (action !== 'session-initiate') {
        // Can't modify a session that we don't have.
        if (!session) {
            log('Unknown session', sid);
            return this.sendError(sender, reqid, {
                condition: 'item-not-found',
                jingleCondition: 'unknown-session'
            });
        }

        // Check if someone is trying to hijack a session.
        if (session.peer !== sender || session.ended) {
            log('Session has ended, or action has wrong sender');
            return this.sendError(sender, reqid, {
                condition: 'item-not-found',
                jingleCondition: 'unknown-session'
            });
        }

        // Can't accept a session twice
        if (action === 'session-accept' && !session.pending) {
            log('Tried to accept session twice', sid);
            return this.sendError(sender, reqid, {
                condition: 'unexpected-request',
                jingleCondition: 'out-of-order'
            });
        }

        // Can't process two requests at once, need to tie break
        if (action !== 'session-terminate' && session.pendingAction) {
            log('Tie break during pending request');
            if (session.isInitiator) {
                return this.sendError(sender, reqid, {
                    condition: 'conflict',
                    jingleCondition: 'tie-break'
                });
            }
        }
    } else if (session) {
        // Don't accept a new session if we already have one.
        if (session.peer !== sender) {
            log('Duplicate sid from new sender');
            return this.sendError(sender, reqid, {
                condition: 'service-unavailable'
            });
        }

        // Check if we need to have a tie breaker because both parties
        // happened to pick the same random sid.
        if (session.pending) {
            if (this.jid > session.peer) {
                log('Tie break new session because of duplicate sids');
                return this.sendError(sender, reqid, {
                    condition: 'conflict',
                    jingleCondition: 'tie-break'
                });
            }
        }

        // The other side is just doing it wrong.
        log('Someone is doing this wrong');
        return this.sendError(sender, reqid, {
            condition: 'unexpected-request',
            jingleCondition: 'out-of-order'
        });
    } else if (Object.keys(this.peers[sender] || {}).length) {
        // Check if we need to have a tie breaker because we already have
        // a different session that is using the requested content types.
        sids = Object.keys(this.peers[sender]);
        for (var i = 0; i < sids.length; i++) {
            currsid = sids[i];
            sess = this.sessions[currsid];
            if (sess && sess.pending) {
                if (_.intersection(contentTypes, sess.contentTypes).length) {
                    // We already have a pending session request for this content type.
                    if (currsid > sid) {
                        // We won the tie breaker
                        log('Tie break');
                        return this.sendError(sender, reqid, {
                            condition: 'conflict',
                            jingleCondition: 'tie-break'
                        });
                    }
                }
            }
        }
    }

    if (action === 'session-initiate') {
        var opts = {
            sid: sid,
            peer: sender,
            initiator: false,
            parent: this
        };
        if (contentTypes.indexOf('rtp') >= 0) {
            session = new MediaSession(opts);
        } else if (contentTypes.indexOf('filetransfer') >= 0) {
            session = new FileSession(opts);
        } else {
            session = new GenericSession(opts);
        }

        this.sessions[sid] = session;
        if (!this.peers[sender]) {
            this.peers[sender] = [];
        }
        this.peers[sender].push(session);
        this.emit('createdSession', session);
    }

    session.process(action, req.jingle, function (err) {
        if (err) {
            log('Could not process request', req, err);
            self.sendError(sender, reqid, err);
        } else {
            self.emit(
                'send',
                { to: sender, id: reqid, type: 'result', action: action }
            );
            if (action === 'session-initiate') {
                log('Incoming session request from ', sender, session);
                self.emit('incoming', session);
            }
        }
    });
};

Jingle.prototype.createMediaSession = function (peer, sid, stream) {
    var session = new MediaSession({
        sid: sid,
        peer: peer,
        initiator: true,
        stream: stream,
        parent: this
    });

    sid = session.sid;

    this.sessions[sid] = session;
    if (!this.peers[peer]) {
        this.peers[peer] = [];
    }
    this.peers[peer].push(session);
    this.emit('createdSession', session);

    log('Outgoing session', session.sid, session);
    this.emit('outgoing', session);
    return session;
};

Jingle.prototype.createFileTransferSession = function (peer, sid) {
    var session = new FileSession({
        sid: sid,
        peer: peer,
        initiator: true,
        parent: this
    });

    sid = session.sid;

    this.sessions[sid] = session;
    if (!this.peers[peer]) {
        this.peers[peer] = [];
    }
    this.peers[peer].push(session);
    this.emit('createdSession', session);

    log('Outgoing session', session.sid, session);
    this.emit('outgoing', session);
    return session;
};

Jingle.prototype.endPeerSessions = function (peer, silence) {
    log('Ending all sessions with', peer);
    var sessions = this.peers[peer] || [];
    sessions.forEach(function (session) {
        session.end('gone', silence);
    });
    delete this.peers[peer];
};

Jingle.prototype.endAllPeerSessions = function () {
    log('Ending all peer sessions');
    var self = this;
    Object.keys(this.peers).forEach(function (peer) {
        self.endPeerSessions(peer);
    });
};


module.exports = Jingle;

},{"./fileSession":191,"./genericSession":192,"./mediaSession":193,"bows":195,"hark":199,"underscore":234,"webrtcsupport":208,"wildemitter":235}],195:[function(_dereq_,module,exports){
(function() {
  function checkColorSupport() {
    var chrome = !!window.chrome,
        firefox = /firefox/i.test(navigator.userAgent),
        firebug = firefox && !!window.console.exception;

    return chrome || firebug;
  }

  var inNode = typeof window === 'undefined',
      ls = !inNode && window.localStorage,
      debug = ls.debug,
      logger = _dereq_('andlog'),
      hue = 0,
      padLength = 15,
      noop = function() {},
      colorsSupported = ls.debugColors || checkColorSupport(),
      yieldColor,
      bows,
      debugRegex;

  yieldColor = function() {
    var goldenRatio = 0.618033988749895;
    hue += goldenRatio;
    hue = hue % 1;
    return hue * 360;
  };

  debugRegex = debug && debug[0]==='/' && new RegExp(debug.substring(1,debug.length-1));

  bows = function(str) {
    var msg, colorString, logfn;
    msg = (str.slice(0, padLength));
    msg += Array(padLength + 3 - msg.length).join(' ') + '|';

    if (debugRegex && !str.match(debugRegex)) return noop;

    if (colorsSupported) {
      var color = yieldColor();
      msg = "%c" + msg;
      colorString = "color: hsl(" + (color) + ",99%,40%); font-weight: bold";

      logfn = logger.log.bind(logger, msg, colorString);
      ['log', 'debug', 'warn', 'error', 'info'].forEach(function (f) {
        logfn[f] = logger[f].bind(logger, msg, colorString);
      });
    } else {
      logfn = logger.log.bind(logger, msg);
      ['log', 'debug', 'warn', 'error', 'info'].forEach(function (f) {
        logfn[f] = logger[f].bind(logger, msg);
      });
    }

    return logfn;
  };

  bows.config = function(config) {
    if (config.padLength) {
      this.padLength = config.padLength;
    }
  };

  if (typeof module !== 'undefined') {
    module.exports = bows;
  } else {
    window.bows = bows;
  }
}).call();

},{"andlog":196}],196:[function(_dereq_,module,exports){
// follow @HenrikJoreteg and @andyet if you like this ;)
(function () {
    var inNode = typeof window === 'undefined',
        ls = !inNode && window.localStorage,
        out = {};

    if (inNode) {
        module.exports = console;
        return;
    }

    var andlogKey = ls.andlogKey || 'debug'
    if (ls && ls[andlogKey] && window.console) {
        out = window.console;
    } else {
        var methods = "assert,count,debug,dir,dirxml,error,exception,group,groupCollapsed,groupEnd,info,log,markTimeline,profile,profileEnd,time,timeEnd,trace,warn".split(","),
            l = methods.length,
            fn = function () {};

        while (l--) {
            out[methods[l]] = fn;
        }
    }
    if (typeof exports !== 'undefined') {
        module.exports = out;
    } else {
        window.console = out;
    }
})();

},{}],197:[function(_dereq_,module,exports){
var async = _dereq_('async');
//var webrtcsupport = require('webrtcsupport');
var WildEmitter = _dereq_('wildemitter');
var util = _dereq_('util');
var hashes = _dereq_('iana-hashes');

function Sender(opts) {
    WildEmitter.call(this);
    var self = this;
    var options = opts || {};
    this.config = {
        chunksize: 768,
        pacing: 10,
        hash: 'sha-1' // note: this uses iana hash names
    };
    // set our config from options
    var item;
    for (item in options) {
        this.config[item] = options[item];
    }

    this.file = null;
    this.channel = null;
    this.hash = null;

    // paced sender
    // TODO: do we have to do this?
    this.processingQueue = async.queue(function (task, next) {
        if (task.type == 'chunk') {
            var reader = new window.FileReader();
            reader.onload = (function() {
                return function(e) {
                    self.channel.send(e.target.result);

                    self.hash.update(new Uint8Array(e.target.result));

                    self.emit('progress', task.start, task.file.size);

                    window.setTimeout(next, self.config.pacing); // pacing
                };
            })(task.file);
            var slice = task.file.slice(task.start, task.start + task.size);
            reader.readAsArrayBuffer(slice);
        } else if (task.type == 'complete') {
            self.emit('sentFile', {hash: self.hash.digest('hex'), algo: self.config.hash });
            next();
        }
    });
}
util.inherits(Sender, WildEmitter);

Sender.prototype.send = function (file, channel) {
    this.file = file;
    this.hash = hashes.createHash(this.config.hash);

    this.channel = channel;
    // FIXME: hook to channel.onopen?
    for (var start = 0; start < this.file.size; start += this.config.chunksize) {
        this.processingQueue.push({
            type: 'chunk',
            file: file,
            start: start,
            size: this.config.chunksize
        });
    }
    this.processingQueue.push({
        type: 'complete'
    });
};

function Receiver(opts) {
    WildEmitter.call(this);

    var options = opts || {};
    this.config = {
        hash: 'sha-1'
    };
    // set our config from options
    var item;
    for (item in options) {
        this.config[item] = options[item];
    }
    this.receiveBuffer = [];
    this.received = 0;
    this.metadata = {};
    this.channel = null;
    this.hash = null;
}
util.inherits(Receiver, WildEmitter);

Receiver.prototype.receive = function (metadata, channel) {
    var self = this;

    if (metadata) {
        this.metadata = metadata;
    }
    this.hash = hashes.createHash(this.config.hash);

    this.channel = channel;
    // chrome only supports arraybuffers and those make it easier to calc the hash
    channel.binaryType = 'arraybuffer';
    this.channel.onmessage = function (event) {
        var len = event.data.byteLength;
        self.received += len;
        self.receiveBuffer.push(event.data);

        self.hash.update(new Uint8Array(event.data));

        self.emit('progress', self.received, self.metadata.size);
        if (self.received == self.metadata.size) {
            self.metadata.actualhash = self.hash.digest('hex');
            self.emit('receivedFile', new window.Blob(self.receiveBuffer), self.metadata);
            self.receiveBuffer = []; // discard receivebuffer
        } else if (self.received > self.metadata.size) {
            // FIXME
            console.error('received more than expected, discarding...');
            self.receiveBuffer = []; // just discard...

        }
    };
};

module.exports = {};
module.exports.support = window && window.File && window.FileReader && window.Blob;
module.exports.Sender = Sender;
module.exports.Receiver = Receiver;

},{"async":198,"iana-hashes":174,"util":169,"wildemitter":235}],198:[function(_dereq_,module,exports){
(function (process){
/*!
 * async
 * https://github.com/caolan/async
 *
 * Copyright 2010-2014 Caolan McMahon
 * Released under the MIT license
 */
/*jshint onevar: false, indent:4 */
/*global setImmediate: false, setTimeout: false, console: false */
(function () {

    var async = {};

    // global on the server, window in the browser
    var root, previous_async;

    root = this;
    if (root != null) {
      previous_async = root.async;
    }

    async.noConflict = function () {
        root.async = previous_async;
        return async;
    };

    function only_once(fn) {
        var called = false;
        return function() {
            if (called) throw new Error("Callback was already called.");
            called = true;
            fn.apply(root, arguments);
        }
    }

    //// cross-browser compatiblity functions ////

    var _toString = Object.prototype.toString;

    var _isArray = Array.isArray || function (obj) {
        return _toString.call(obj) === '[object Array]';
    };

    var _each = function (arr, iterator) {
        if (arr.forEach) {
            return arr.forEach(iterator);
        }
        for (var i = 0; i < arr.length; i += 1) {
            iterator(arr[i], i, arr);
        }
    };

    var _map = function (arr, iterator) {
        if (arr.map) {
            return arr.map(iterator);
        }
        var results = [];
        _each(arr, function (x, i, a) {
            results.push(iterator(x, i, a));
        });
        return results;
    };

    var _reduce = function (arr, iterator, memo) {
        if (arr.reduce) {
            return arr.reduce(iterator, memo);
        }
        _each(arr, function (x, i, a) {
            memo = iterator(memo, x, i, a);
        });
        return memo;
    };

    var _keys = function (obj) {
        if (Object.keys) {
            return Object.keys(obj);
        }
        var keys = [];
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) {
                keys.push(k);
            }
        }
        return keys;
    };

    //// exported async module functions ////

    //// nextTick implementation with browser-compatible fallback ////
    if (typeof process === 'undefined' || !(process.nextTick)) {
        if (typeof setImmediate === 'function') {
            async.nextTick = function (fn) {
                // not a direct alias for IE10 compatibility
                setImmediate(fn);
            };
            async.setImmediate = async.nextTick;
        }
        else {
            async.nextTick = function (fn) {
                setTimeout(fn, 0);
            };
            async.setImmediate = async.nextTick;
        }
    }
    else {
        async.nextTick = process.nextTick;
        if (typeof setImmediate !== 'undefined') {
            async.setImmediate = function (fn) {
              // not a direct alias for IE10 compatibility
              setImmediate(fn);
            };
        }
        else {
            async.setImmediate = async.nextTick;
        }
    }

    async.each = function (arr, iterator, callback) {
        callback = callback || function () {};
        if (!arr.length) {
            return callback();
        }
        var completed = 0;
        _each(arr, function (x) {
            iterator(x, only_once(done) );
        });
        function done(err) {
          if (err) {
              callback(err);
              callback = function () {};
          }
          else {
              completed += 1;
              if (completed >= arr.length) {
                  callback();
              }
          }
        }
    };
    async.forEach = async.each;

    async.eachSeries = function (arr, iterator, callback) {
        callback = callback || function () {};
        if (!arr.length) {
            return callback();
        }
        var completed = 0;
        var iterate = function () {
            iterator(arr[completed], function (err) {
                if (err) {
                    callback(err);
                    callback = function () {};
                }
                else {
                    completed += 1;
                    if (completed >= arr.length) {
                        callback();
                    }
                    else {
                        iterate();
                    }
                }
            });
        };
        iterate();
    };
    async.forEachSeries = async.eachSeries;

    async.eachLimit = function (arr, limit, iterator, callback) {
        var fn = _eachLimit(limit);
        fn.apply(null, [arr, iterator, callback]);
    };
    async.forEachLimit = async.eachLimit;

    var _eachLimit = function (limit) {

        return function (arr, iterator, callback) {
            callback = callback || function () {};
            if (!arr.length || limit <= 0) {
                return callback();
            }
            var completed = 0;
            var started = 0;
            var running = 0;

            (function replenish () {
                if (completed >= arr.length) {
                    return callback();
                }

                while (running < limit && started < arr.length) {
                    started += 1;
                    running += 1;
                    iterator(arr[started - 1], function (err) {
                        if (err) {
                            callback(err);
                            callback = function () {};
                        }
                        else {
                            completed += 1;
                            running -= 1;
                            if (completed >= arr.length) {
                                callback();
                            }
                            else {
                                replenish();
                            }
                        }
                    });
                }
            })();
        };
    };


    var doParallel = function (fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [async.each].concat(args));
        };
    };
    var doParallelLimit = function(limit, fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [_eachLimit(limit)].concat(args));
        };
    };
    var doSeries = function (fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [async.eachSeries].concat(args));
        };
    };


    var _asyncMap = function (eachfn, arr, iterator, callback) {
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        if (!callback) {
            eachfn(arr, function (x, callback) {
                iterator(x.value, function (err) {
                    callback(err);
                });
            });
        } else {
            var results = [];
            eachfn(arr, function (x, callback) {
                iterator(x.value, function (err, v) {
                    results[x.index] = v;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };
    async.map = doParallel(_asyncMap);
    async.mapSeries = doSeries(_asyncMap);
    async.mapLimit = function (arr, limit, iterator, callback) {
        return _mapLimit(limit)(arr, iterator, callback);
    };

    var _mapLimit = function(limit) {
        return doParallelLimit(limit, _asyncMap);
    };

    // reduce only has a series version, as doing reduce in parallel won't
    // work in many situations.
    async.reduce = function (arr, memo, iterator, callback) {
        async.eachSeries(arr, function (x, callback) {
            iterator(memo, x, function (err, v) {
                memo = v;
                callback(err);
            });
        }, function (err) {
            callback(err, memo);
        });
    };
    // inject alias
    async.inject = async.reduce;
    // foldl alias
    async.foldl = async.reduce;

    async.reduceRight = function (arr, memo, iterator, callback) {
        var reversed = _map(arr, function (x) {
            return x;
        }).reverse();
        async.reduce(reversed, memo, iterator, callback);
    };
    // foldr alias
    async.foldr = async.reduceRight;

    var _filter = function (eachfn, arr, iterator, callback) {
        var results = [];
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        eachfn(arr, function (x, callback) {
            iterator(x.value, function (v) {
                if (v) {
                    results.push(x);
                }
                callback();
            });
        }, function (err) {
            callback(_map(results.sort(function (a, b) {
                return a.index - b.index;
            }), function (x) {
                return x.value;
            }));
        });
    };
    async.filter = doParallel(_filter);
    async.filterSeries = doSeries(_filter);
    // select alias
    async.select = async.filter;
    async.selectSeries = async.filterSeries;

    var _reject = function (eachfn, arr, iterator, callback) {
        var results = [];
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        eachfn(arr, function (x, callback) {
            iterator(x.value, function (v) {
                if (!v) {
                    results.push(x);
                }
                callback();
            });
        }, function (err) {
            callback(_map(results.sort(function (a, b) {
                return a.index - b.index;
            }), function (x) {
                return x.value;
            }));
        });
    };
    async.reject = doParallel(_reject);
    async.rejectSeries = doSeries(_reject);

    var _detect = function (eachfn, arr, iterator, main_callback) {
        eachfn(arr, function (x, callback) {
            iterator(x, function (result) {
                if (result) {
                    main_callback(x);
                    main_callback = function () {};
                }
                else {
                    callback();
                }
            });
        }, function (err) {
            main_callback();
        });
    };
    async.detect = doParallel(_detect);
    async.detectSeries = doSeries(_detect);

    async.some = function (arr, iterator, main_callback) {
        async.each(arr, function (x, callback) {
            iterator(x, function (v) {
                if (v) {
                    main_callback(true);
                    main_callback = function () {};
                }
                callback();
            });
        }, function (err) {
            main_callback(false);
        });
    };
    // any alias
    async.any = async.some;

    async.every = function (arr, iterator, main_callback) {
        async.each(arr, function (x, callback) {
            iterator(x, function (v) {
                if (!v) {
                    main_callback(false);
                    main_callback = function () {};
                }
                callback();
            });
        }, function (err) {
            main_callback(true);
        });
    };
    // all alias
    async.all = async.every;

    async.sortBy = function (arr, iterator, callback) {
        async.map(arr, function (x, callback) {
            iterator(x, function (err, criteria) {
                if (err) {
                    callback(err);
                }
                else {
                    callback(null, {value: x, criteria: criteria});
                }
            });
        }, function (err, results) {
            if (err) {
                return callback(err);
            }
            else {
                var fn = function (left, right) {
                    var a = left.criteria, b = right.criteria;
                    return a < b ? -1 : a > b ? 1 : 0;
                };
                callback(null, _map(results.sort(fn), function (x) {
                    return x.value;
                }));
            }
        });
    };

    async.auto = function (tasks, callback) {
        callback = callback || function () {};
        var keys = _keys(tasks);
        var remainingTasks = keys.length
        if (!remainingTasks) {
            return callback();
        }

        var results = {};

        var listeners = [];
        var addListener = function (fn) {
            listeners.unshift(fn);
        };
        var removeListener = function (fn) {
            for (var i = 0; i < listeners.length; i += 1) {
                if (listeners[i] === fn) {
                    listeners.splice(i, 1);
                    return;
                }
            }
        };
        var taskComplete = function () {
            remainingTasks--
            _each(listeners.slice(0), function (fn) {
                fn();
            });
        };

        addListener(function () {
            if (!remainingTasks) {
                var theCallback = callback;
                // prevent final callback from calling itself if it errors
                callback = function () {};

                theCallback(null, results);
            }
        });

        _each(keys, function (k) {
            var task = _isArray(tasks[k]) ? tasks[k]: [tasks[k]];
            var taskCallback = function (err) {
                var args = Array.prototype.slice.call(arguments, 1);
                if (args.length <= 1) {
                    args = args[0];
                }
                if (err) {
                    var safeResults = {};
                    _each(_keys(results), function(rkey) {
                        safeResults[rkey] = results[rkey];
                    });
                    safeResults[k] = args;
                    callback(err, safeResults);
                    // stop subsequent errors hitting callback multiple times
                    callback = function () {};
                }
                else {
                    results[k] = args;
                    async.setImmediate(taskComplete);
                }
            };
            var requires = task.slice(0, Math.abs(task.length - 1)) || [];
            var ready = function () {
                return _reduce(requires, function (a, x) {
                    return (a && results.hasOwnProperty(x));
                }, true) && !results.hasOwnProperty(k);
            };
            if (ready()) {
                task[task.length - 1](taskCallback, results);
            }
            else {
                var listener = function () {
                    if (ready()) {
                        removeListener(listener);
                        task[task.length - 1](taskCallback, results);
                    }
                };
                addListener(listener);
            }
        });
    };

    async.retry = function(times, task, callback) {
        var DEFAULT_TIMES = 5;
        var attempts = [];
        // Use defaults if times not passed
        if (typeof times === 'function') {
            callback = task;
            task = times;
            times = DEFAULT_TIMES;
        }
        // Make sure times is a number
        times = parseInt(times, 10) || DEFAULT_TIMES;
        var wrappedTask = function(wrappedCallback, wrappedResults) {
            var retryAttempt = function(task, finalAttempt) {
                return function(seriesCallback) {
                    task(function(err, result){
                        seriesCallback(!err || finalAttempt, {err: err, result: result});
                    }, wrappedResults);
                };
            };
            while (times) {
                attempts.push(retryAttempt(task, !(times-=1)));
            }
            async.series(attempts, function(done, data){
                data = data[data.length - 1];
                (wrappedCallback || callback)(data.err, data.result);
            });
        }
        // If a callback is passed, run this as a controll flow
        return callback ? wrappedTask() : wrappedTask
    };

    async.waterfall = function (tasks, callback) {
        callback = callback || function () {};
        if (!_isArray(tasks)) {
          var err = new Error('First argument to waterfall must be an array of functions');
          return callback(err);
        }
        if (!tasks.length) {
            return callback();
        }
        var wrapIterator = function (iterator) {
            return function (err) {
                if (err) {
                    callback.apply(null, arguments);
                    callback = function () {};
                }
                else {
                    var args = Array.prototype.slice.call(arguments, 1);
                    var next = iterator.next();
                    if (next) {
                        args.push(wrapIterator(next));
                    }
                    else {
                        args.push(callback);
                    }
                    async.setImmediate(function () {
                        iterator.apply(null, args);
                    });
                }
            };
        };
        wrapIterator(async.iterator(tasks))();
    };

    var _parallel = function(eachfn, tasks, callback) {
        callback = callback || function () {};
        if (_isArray(tasks)) {
            eachfn.map(tasks, function (fn, callback) {
                if (fn) {
                    fn(function (err) {
                        var args = Array.prototype.slice.call(arguments, 1);
                        if (args.length <= 1) {
                            args = args[0];
                        }
                        callback.call(null, err, args);
                    });
                }
            }, callback);
        }
        else {
            var results = {};
            eachfn.each(_keys(tasks), function (k, callback) {
                tasks[k](function (err) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    if (args.length <= 1) {
                        args = args[0];
                    }
                    results[k] = args;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };

    async.parallel = function (tasks, callback) {
        _parallel({ map: async.map, each: async.each }, tasks, callback);
    };

    async.parallelLimit = function(tasks, limit, callback) {
        _parallel({ map: _mapLimit(limit), each: _eachLimit(limit) }, tasks, callback);
    };

    async.series = function (tasks, callback) {
        callback = callback || function () {};
        if (_isArray(tasks)) {
            async.mapSeries(tasks, function (fn, callback) {
                if (fn) {
                    fn(function (err) {
                        var args = Array.prototype.slice.call(arguments, 1);
                        if (args.length <= 1) {
                            args = args[0];
                        }
                        callback.call(null, err, args);
                    });
                }
            }, callback);
        }
        else {
            var results = {};
            async.eachSeries(_keys(tasks), function (k, callback) {
                tasks[k](function (err) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    if (args.length <= 1) {
                        args = args[0];
                    }
                    results[k] = args;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };

    async.iterator = function (tasks) {
        var makeCallback = function (index) {
            var fn = function () {
                if (tasks.length) {
                    tasks[index].apply(null, arguments);
                }
                return fn.next();
            };
            fn.next = function () {
                return (index < tasks.length - 1) ? makeCallback(index + 1): null;
            };
            return fn;
        };
        return makeCallback(0);
    };

    async.apply = function (fn) {
        var args = Array.prototype.slice.call(arguments, 1);
        return function () {
            return fn.apply(
                null, args.concat(Array.prototype.slice.call(arguments))
            );
        };
    };

    var _concat = function (eachfn, arr, fn, callback) {
        var r = [];
        eachfn(arr, function (x, cb) {
            fn(x, function (err, y) {
                r = r.concat(y || []);
                cb(err);
            });
        }, function (err) {
            callback(err, r);
        });
    };
    async.concat = doParallel(_concat);
    async.concatSeries = doSeries(_concat);

    async.whilst = function (test, iterator, callback) {
        if (test()) {
            iterator(function (err) {
                if (err) {
                    return callback(err);
                }
                async.whilst(test, iterator, callback);
            });
        }
        else {
            callback();
        }
    };

    async.doWhilst = function (iterator, test, callback) {
        iterator(function (err) {
            if (err) {
                return callback(err);
            }
            var args = Array.prototype.slice.call(arguments, 1);
            if (test.apply(null, args)) {
                async.doWhilst(iterator, test, callback);
            }
            else {
                callback();
            }
        });
    };

    async.until = function (test, iterator, callback) {
        if (!test()) {
            iterator(function (err) {
                if (err) {
                    return callback(err);
                }
                async.until(test, iterator, callback);
            });
        }
        else {
            callback();
        }
    };

    async.doUntil = function (iterator, test, callback) {
        iterator(function (err) {
            if (err) {
                return callback(err);
            }
            var args = Array.prototype.slice.call(arguments, 1);
            if (!test.apply(null, args)) {
                async.doUntil(iterator, test, callback);
            }
            else {
                callback();
            }
        });
    };

    async.queue = function (worker, concurrency) {
        if (concurrency === undefined) {
            concurrency = 1;
        }
        function _insert(q, data, pos, callback) {
          if (!q.started){
            q.started = true;
          }
          if (!_isArray(data)) {
              data = [data];
          }
          if(data.length == 0) {
             // call drain immediately if there are no tasks
             return async.setImmediate(function() {
                 if (q.drain) {
                     q.drain();
                 }
             });
          }
          _each(data, function(task) {
              var item = {
                  data: task,
                  callback: typeof callback === 'function' ? callback : null
              };

              if (pos) {
                q.tasks.unshift(item);
              } else {
                q.tasks.push(item);
              }

              if (q.saturated && q.tasks.length === q.concurrency) {
                  q.saturated();
              }
              async.setImmediate(q.process);
          });
        }

        var workers = 0;
        var q = {
            tasks: [],
            concurrency: concurrency,
            saturated: null,
            empty: null,
            drain: null,
            started: false,
            paused: false,
            push: function (data, callback) {
              _insert(q, data, false, callback);
            },
            kill: function () {
              q.drain = null;
              q.tasks = [];
            },
            unshift: function (data, callback) {
              _insert(q, data, true, callback);
            },
            process: function () {
                if (!q.paused && workers < q.concurrency && q.tasks.length) {
                    var task = q.tasks.shift();
                    if (q.empty && q.tasks.length === 0) {
                        q.empty();
                    }
                    workers += 1;
                    var next = function () {
                        workers -= 1;
                        if (task.callback) {
                            task.callback.apply(task, arguments);
                        }
                        if (q.drain && q.tasks.length + workers === 0) {
                            q.drain();
                        }
                        q.process();
                    };
                    var cb = only_once(next);
                    worker(task.data, cb);
                }
            },
            length: function () {
                return q.tasks.length;
            },
            running: function () {
                return workers;
            },
            idle: function() {
                return q.tasks.length + workers === 0;
            },
            pause: function () {
                if (q.paused === true) { return; }
                q.paused = true;
                q.process();
            },
            resume: function () {
                if (q.paused === false) { return; }
                q.paused = false;
                q.process();
            }
        };
        return q;
    };

    async.cargo = function (worker, payload) {
        var working     = false,
            tasks       = [];

        var cargo = {
            tasks: tasks,
            payload: payload,
            saturated: null,
            empty: null,
            drain: null,
            drained: true,
            push: function (data, callback) {
                if (!_isArray(data)) {
                    data = [data];
                }
                _each(data, function(task) {
                    tasks.push({
                        data: task,
                        callback: typeof callback === 'function' ? callback : null
                    });
                    cargo.drained = false;
                    if (cargo.saturated && tasks.length === payload) {
                        cargo.saturated();
                    }
                });
                async.setImmediate(cargo.process);
            },
            process: function process() {
                if (working) return;
                if (tasks.length === 0) {
                    if(cargo.drain && !cargo.drained) cargo.drain();
                    cargo.drained = true;
                    return;
                }

                var ts = typeof payload === 'number'
                            ? tasks.splice(0, payload)
                            : tasks.splice(0, tasks.length);

                var ds = _map(ts, function (task) {
                    return task.data;
                });

                if(cargo.empty) cargo.empty();
                working = true;
                worker(ds, function () {
                    working = false;

                    var args = arguments;
                    _each(ts, function (data) {
                        if (data.callback) {
                            data.callback.apply(null, args);
                        }
                    });

                    process();
                });
            },
            length: function () {
                return tasks.length;
            },
            running: function () {
                return working;
            }
        };
        return cargo;
    };

    var _console_fn = function (name) {
        return function (fn) {
            var args = Array.prototype.slice.call(arguments, 1);
            fn.apply(null, args.concat([function (err) {
                var args = Array.prototype.slice.call(arguments, 1);
                if (typeof console !== 'undefined') {
                    if (err) {
                        if (console.error) {
                            console.error(err);
                        }
                    }
                    else if (console[name]) {
                        _each(args, function (x) {
                            console[name](x);
                        });
                    }
                }
            }]));
        };
    };
    async.log = _console_fn('log');
    async.dir = _console_fn('dir');
    /*async.info = _console_fn('info');
    async.warn = _console_fn('warn');
    async.error = _console_fn('error');*/

    async.memoize = function (fn, hasher) {
        var memo = {};
        var queues = {};
        hasher = hasher || function (x) {
            return x;
        };
        var memoized = function () {
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            var key = hasher.apply(null, args);
            if (key in memo) {
                async.nextTick(function () {
                    callback.apply(null, memo[key]);
                });
            }
            else if (key in queues) {
                queues[key].push(callback);
            }
            else {
                queues[key] = [callback];
                fn.apply(null, args.concat([function () {
                    memo[key] = arguments;
                    var q = queues[key];
                    delete queues[key];
                    for (var i = 0, l = q.length; i < l; i++) {
                      q[i].apply(null, arguments);
                    }
                }]));
            }
        };
        memoized.memo = memo;
        memoized.unmemoized = fn;
        return memoized;
    };

    async.unmemoize = function (fn) {
      return function () {
        return (fn.unmemoized || fn).apply(null, arguments);
      };
    };

    async.times = function (count, iterator, callback) {
        var counter = [];
        for (var i = 0; i < count; i++) {
            counter.push(i);
        }
        return async.map(counter, iterator, callback);
    };

    async.timesSeries = function (count, iterator, callback) {
        var counter = [];
        for (var i = 0; i < count; i++) {
            counter.push(i);
        }
        return async.mapSeries(counter, iterator, callback);
    };

    async.seq = function (/* functions... */) {
        var fns = arguments;
        return function () {
            var that = this;
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            async.reduce(fns, args, function (newargs, fn, cb) {
                fn.apply(that, newargs.concat([function () {
                    var err = arguments[0];
                    var nextargs = Array.prototype.slice.call(arguments, 1);
                    cb(err, nextargs);
                }]))
            },
            function (err, results) {
                callback.apply(that, [err].concat(results));
            });
        };
    };

    async.compose = function (/* functions... */) {
      return async.seq.apply(null, Array.prototype.reverse.call(arguments));
    };

    var _applyEach = function (eachfn, fns /*args...*/) {
        var go = function () {
            var that = this;
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            return eachfn(fns, function (fn, cb) {
                fn.apply(that, args.concat([cb]));
            },
            callback);
        };
        if (arguments.length > 2) {
            var args = Array.prototype.slice.call(arguments, 2);
            return go.apply(this, args);
        }
        else {
            return go;
        }
    };
    async.applyEach = doParallel(_applyEach);
    async.applyEachSeries = doSeries(_applyEach);

    async.forever = function (fn, callback) {
        function next(err) {
            if (err) {
                if (callback) {
                    return callback(err);
                }
                throw err;
            }
            fn(next);
        }
        next();
    };

    // Node.js
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = async;
    }
    // AMD / RequireJS
    else if (typeof define !== 'undefined' && define.amd) {
        define([], function () {
            return async;
        });
    }
    // included directly via <script> tag
    else {
        root.async = async;
    }

}());

}).call(this,_dereq_("FWaASH"))
},{"FWaASH":166}],199:[function(_dereq_,module,exports){
var WildEmitter = _dereq_('wildemitter');

function getMaxVolume (analyser, fftBins) {
  var maxVolume = -Infinity;
  analyser.getFloatFrequencyData(fftBins);

  for(var i=4, ii=fftBins.length; i < ii; i++) {
    if (fftBins[i] > maxVolume && fftBins[i] < 0) {
      maxVolume = fftBins[i];
    }
  };

  return maxVolume;
}


var audioContextType = window.webkitAudioContext || window.AudioContext;
// use a single audio context due to hardware limits
var audioContext = null;
module.exports = function(stream, options) {
  var harker = new WildEmitter();


  // make it not break in non-supported browsers
  if (!audioContextType) return harker;

  //Config
  var options = options || {},
      smoothing = (options.smoothing || 0.1),
      interval = (options.interval || 50),
      threshold = options.threshold,
      play = options.play,
      history = options.history || 10,
      running = true;

  //Setup Audio Context
  if (!audioContext) {
    audioContext = new audioContextType();
  }
  var sourceNode, fftBins, analyser;

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = smoothing;
  fftBins = new Float32Array(analyser.fftSize);

  if (stream.jquery) stream = stream[0];
  if (stream instanceof HTMLAudioElement || stream instanceof HTMLVideoElement) {
    //Audio Tag
    sourceNode = audioContext.createMediaElementSource(stream);
    if (typeof play === 'undefined') play = true;
    threshold = threshold || -50;
  } else {
    //WebRTC Stream
    sourceNode = audioContext.createMediaStreamSource(stream);
    threshold = threshold || -50;
  }

  sourceNode.connect(analyser);
  if (play) analyser.connect(audioContext.destination);

  harker.speaking = false;

  harker.setThreshold = function(t) {
    threshold = t;
  };

  harker.setInterval = function(i) {
    interval = i;
  };
  
  harker.stop = function() {
    running = false;
    harker.emit('volume_change', -100, threshold);
    if (harker.speaking) {
      harker.speaking = false;
      harker.emit('stopped_speaking');
    }
  };
  harker.speakingHistory = [];
  for (var i = 0; i < history; i++) {
      harker.speakingHistory.push(0);
  }

  // Poll the analyser node to determine if speaking
  // and emit events if changed
  var looper = function() {
    setTimeout(function() {
    
      //check if stop has been called
      if(!running) {
        return;
      }
      
      var currentVolume = getMaxVolume(analyser, fftBins);

      harker.emit('volume_change', currentVolume, threshold);

      var history = 0;
      if (currentVolume > threshold && !harker.speaking) {
        // trigger quickly, short history
        for (var i = harker.speakingHistory.length - 3; i < harker.speakingHistory.length; i++) {
          history += harker.speakingHistory[i];
        }
        if (history >= 2) {
          harker.speaking = true;
          harker.emit('speaking');
        }
      } else if (currentVolume < threshold && harker.speaking) {
        for (var i = 0; i < harker.speakingHistory.length; i++) {
          history += harker.speakingHistory[i];
        }
        if (history == 0) {
          harker.speaking = false;
          harker.emit('stopped_speaking');
        }
      }
      harker.speakingHistory.shift();
      harker.speakingHistory.push(0 + (currentVolume > threshold));

      looper();
    }, interval);
  };
  looper();


  return harker;
}

},{"wildemitter":235}],200:[function(_dereq_,module,exports){
// based on https://github.com/ESTOS/strophe.jingle/
// adds wildemitter support
var util = _dereq_('util');
var webrtc = _dereq_('webrtcsupport');
var WildEmitter = _dereq_('wildemitter');

function dumpSDP(description) {
    return 'type: ' + description.type + '\r\n' + description.sdp;
}

function TraceablePeerConnection(config, constraints) {
    var self = this;
    WildEmitter.call(this);

    this.peerconnection = new webrtc.PeerConnection(config, constraints);

    this.trace = function (what, info) {
        self.emit('PeerConnectionTrace', {
            time: new Date(),
            type: what,
            value: info || ""
        });
    };

    this.onicecandidate = null;
    this.peerconnection.onicecandidate = function (event) {
        self.trace('onicecandidate', JSON.stringify(event.candidate, null, ' '));
        if (self.onicecandidate !== null) {
            self.onicecandidate(event);
        }
    };
    this.onaddstream = null;
    this.peerconnection.onaddstream = function (event) {
        self.trace('onaddstream', event.stream.id);
        if (self.onaddstream !== null) {
            self.onaddstream(event);
        }
    };
    this.onremovestream = null;
    this.peerconnection.onremovestream = function (event) {
        self.trace('onremovestream', event.stream.id);
        if (self.onremovestream !== null) {
            self.onremovestream(event);
        }
    };
    this.onsignalingstatechange = null;
    this.peerconnection.onsignalingstatechange = function (event) {
        self.trace('onsignalingstatechange', self.signalingState);
        if (self.onsignalingstatechange !== null) {
            self.onsignalingstatechange(event);
        }
    };
    this.oniceconnectionstatechange = null;
    this.peerconnection.oniceconnectionstatechange = function (event) {
        self.trace('oniceconnectionstatechange', self.iceConnectionState);
        if (self.oniceconnectionstatechange !== null) {
            self.oniceconnectionstatechange(event);
        }
    };
    this.onnegotiationneeded = null;
    this.peerconnection.onnegotiationneeded = function (event) {
        self.trace('onnegotiationneeded');
        if (self.onnegotiationneeded !== null) {
            self.onnegotiationneeded(event);
        }
    };
    self.ondatachannel = null;
    this.peerconnection.ondatachannel = function (event) {
        self.trace('ondatachannel', event);
        if (self.ondatachannel !== null) {
            self.ondatachannel(event);
        }
    };
    this.getLocalStreams = this.peerconnection.getLocalStreams.bind(this.peerconnection);
    this.getRemoteStreams = this.peerconnection.getRemoteStreams.bind(this.peerconnection);
}

util.inherits(TraceablePeerConnection, WildEmitter);

Object.defineProperty(TraceablePeerConnection.prototype, 'signalingState', {
    get: function () {
        return this.peerconnection.signalingState;
    }
});

Object.defineProperty(TraceablePeerConnection.prototype, 'iceConnectionState', {
    get: function () {
        return this.peerconnection.iceConnectionState;
    }
});

Object.defineProperty(TraceablePeerConnection.prototype, 'localDescription', {
    get: function () {
        return this.peerconnection.localDescription;
    }
});

Object.defineProperty(TraceablePeerConnection.prototype, 'remoteDescription', {
    get: function () {
        return this.peerconnection.remoteDescription;
    }
});

TraceablePeerConnection.prototype.addStream = function (stream) {
    this.trace('addStream', stream.id);
    this.peerconnection.addStream(stream);
};

TraceablePeerConnection.prototype.removeStream = function (stream) {
    this.trace('removeStream', stream.id);
    this.peerconnection.removeStream(stream);
};

TraceablePeerConnection.prototype.createDataChannel = function (label, opts) {
    this.trace('createDataChannel', label, opts);
    return this.peerconnection.createDataChannel(label, opts);
};

TraceablePeerConnection.prototype.setLocalDescription = function (description, successCallback, failureCallback) {
    var self = this;
    this.trace('setLocalDescription', dumpSDP(description));
    this.peerconnection.setLocalDescription(description,
        function () {
            self.trace('setLocalDescriptionOnSuccess');
            successCallback();
        },
        function (err) {
            self.trace('setLocalDescriptionOnFailure', err);
            failureCallback(err);
        }
    );
};

TraceablePeerConnection.prototype.setRemoteDescription = function (description, successCallback, failureCallback) {
    var self = this;
    this.trace('setRemoteDescription', dumpSDP(description));
    this.peerconnection.setRemoteDescription(description,
        function () {
            self.trace('setRemoteDescriptionOnSuccess');
            successCallback();
        },
        function (err) {
            self.trace('setRemoteDescriptionOnFailure', err);
            failureCallback(err);
        }
    );
};

TraceablePeerConnection.prototype.close = function () {
    this.trace('stop');
    if (this.statsinterval !== null) {
        window.clearInterval(this.statsinterval);
        this.statsinterval = null;
    }
    if (this.peerconnection.signalingState != 'closed') {
        this.peerconnection.close();
    }
};

TraceablePeerConnection.prototype.createOffer = function (successCallback, failureCallback, constraints) {
    var self = this;
    this.trace('createOffer', JSON.stringify(constraints, null, ' '));
    this.peerconnection.createOffer(
        function (offer) {
            self.trace('createOfferOnSuccess', dumpSDP(offer));
            successCallback(offer);
        },
        function (err) {
            self.trace('createOfferOnFailure', err);
            failureCallback(err);
        },
        constraints
    );
};

TraceablePeerConnection.prototype.createAnswer = function (successCallback, failureCallback, constraints) {
    var self = this;
    this.trace('createAnswer', JSON.stringify(constraints, null, ' '));
    this.peerconnection.createAnswer(
        function (answer) {
            self.trace('createAnswerOnSuccess', dumpSDP(answer));
            successCallback(answer);
        },
        function (err) {
            self.trace('createAnswerOnFailure', err);
            failureCallback(err);
        },
        constraints
    );
};

TraceablePeerConnection.prototype.addIceCandidate = function (candidate, successCallback, failureCallback) {
    var self = this;
    this.trace('addIceCandidate', JSON.stringify(candidate, null, ' '));
    this.peerconnection.addIceCandidate(candidate);
    /* maybe later
    this.peerconnection.addIceCandidate(candidate, 
        function () {                                
            self.trace('addIceCandidateOnSuccess');
            successCallback();
        },
        function (err) {
            self.trace('addIceCandidateOnFailure', err);
            failureCallback(err);
        }
    );
    */
};

TraceablePeerConnection.prototype.getStats = function (callback, errback) {
    if (navigator.mozGetUserMedia) {
        this.peerconnection.getStats(null, callback, errback);
    } else {
        this.peerconnection.getStats(callback);
    }
};

module.exports = TraceablePeerConnection;

},{"util":169,"webrtcsupport":201,"wildemitter":235}],201:[function(_dereq_,module,exports){
// created by @HenrikJoreteg
var prefix;
var isChrome = false;
var isFirefox = false;
var ua = window.navigator.userAgent.toLowerCase();

// basic sniffing
if (ua.indexOf('firefox') !== -1) {
    prefix = 'moz';
    isFirefox = true;
} else if (ua.indexOf('chrome') !== -1) {
    prefix = 'webkit';
    isChrome = true;
}

var PC = window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
var IceCandidate = window.mozRTCIceCandidate || window.RTCIceCandidate;
var SessionDescription = window.mozRTCSessionDescription || window.RTCSessionDescription;
var MediaStream = window.webkitMediaStream || window.MediaStream;
var screenSharing = window.location.protocol === 'https:' && window.navigator.userAgent.match('Chrome') && parseInt(window.navigator.userAgent.match(/Chrome\/(.*) /)[1], 10) >= 26;
var AudioContext = window.webkitAudioContext || window.AudioContext;


// export support flags and constructors.prototype && PC
module.exports = {
    support: !!PC,
    dataChannel: isChrome || isFirefox || (PC && PC.prototype && PC.prototype.createDataChannel),
    prefix: prefix,
    webAudio: !!(AudioContext && AudioContext.prototype.createMediaStreamSource),
    mediaStream: !!(MediaStream && MediaStream.prototype.removeTrack),
    screenSharing: !!screenSharing,
    AudioContext: AudioContext,
    PeerConnection: PC,
    SessionDescription: SessionDescription,
    IceCandidate: IceCandidate
};

},{}],202:[function(_dereq_,module,exports){
// created by @HenrikJoreteg
var prefix;
var isChrome = false;
var isFirefox = false;
var ua = window.navigator.userAgent.toLowerCase();

// basic sniffing
if (ua.indexOf('firefox') !== -1) {
    prefix = 'moz';
    isFirefox = true;
} else if (ua.indexOf('chrome') !== -1) {
    prefix = 'webkit';
    isChrome = true;
}

var PC = window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
var IceCandidate = window.mozRTCIceCandidate || window.RTCIceCandidate;
var SessionDescription = window.mozRTCSessionDescription || window.RTCSessionDescription;
var MediaStream = window.webkitMediaStream || window.MediaStream;
var screenSharing = window.location.protocol === 'https:' &&
    ((window.navigator.userAgent.match('Chrome') && parseInt(window.navigator.userAgent.match(/Chrome\/(.*) /)[1], 10) >= 26) ||
     (window.navigator.userAgent.match('Firefox') && parseInt(window.navigator.userAgent.match(/Firefox\/(.*)/)[1], 10) >= 33));
var AudioContext = window.webkitAudioContext || window.AudioContext;


// export support flags and constructors.prototype && PC
module.exports = {
    support: !!PC,
    dataChannel: isChrome || isFirefox || (PC && PC.prototype && PC.prototype.createDataChannel),
    prefix: prefix,
    webAudio: !!(AudioContext && AudioContext.prototype.createMediaStreamSource),
    mediaStream: !!(MediaStream && MediaStream.prototype.removeTrack),
    screenSharing: !!screenSharing,
    AudioContext: AudioContext,
    PeerConnection: PC,
    SessionDescription: SessionDescription,
    IceCandidate: IceCandidate,
    MediaStream: MediaStream
};

},{}],203:[function(_dereq_,module,exports){
var _ = _dereq_('underscore');
var util = _dereq_('util');
var webrtc = _dereq_('webrtcsupport');
var SJJ = _dereq_('sdp-jingle-json');
var WildEmitter = _dereq_('wildemitter');
var peerconn = _dereq_('traceablepeerconnection');

function PeerConnection(config, constraints) {
    var self = this;
    var item;
    WildEmitter.call(this);

    config = config || {};
    config.iceServers = config.iceServers || [];

    this.pc = new peerconn(config, constraints);

    this.getLocalStreams = this.pc.getLocalStreams.bind(this.pc);
    this.getRemoteStreams = this.pc.getRemoteStreams.bind(this.pc);
    this.addStream = this.pc.addStream.bind(this.pc);
    this.removeStream = this.pc.removeStream.bind(this.pc);

    // proxy events 
    this.pc.on('*', function () {
        self.emit.apply(self, arguments);
    });

    // proxy some events directly
    this.pc.onremovestream = this.emit.bind(this, 'removeStream');
    this.pc.onnegotiationneeded = this.emit.bind(this, 'negotiationNeeded');
    this.pc.oniceconnectionstatechange = this.emit.bind(this, 'iceConnectionStateChange');
    this.pc.onsignalingstatechange = this.emit.bind(this, 'signalingStateChange');

    // handle incoming ice and data channel events
    this.pc.onaddstream = this._onAddStream.bind(this);
    this.pc.onicecandidate = this._onIce.bind(this);
    this.pc.ondatachannel = this._onDataChannel.bind(this);

    this.localDescription = {
        contents: []
    };
    this.remoteDescription = {
        contents: []
    };

    this.localStream = null;
    this.remoteStreams = [];

    this.config = {
        debug: false,
        ice: {},
        sid: '',
        isInitiator: true,
        sdpSessionID: Date.now(),
        useJingle: false
    };

    // apply our config
    for (item in config) {
        this.config[item] = config[item];
    }

    if (this.config.debug) {
        this.on('*', function (eventName, event) {
            var logger = config.logger || console;
            logger.log('PeerConnection event:', arguments);
        });
    }
    this.hadLocalStunCandidate = false;
    this.hadRemoteStunCandidate = false;
    this.hadLocalRelayCandidate = false;
    this.hadRemoteRelayCandidate = false;

    this.hadLocalIPv6Candidate = false;
    this.hadRemoteIPv6Candidate = false;

    // keeping references for all our data channels
    // so they dont get garbage collected
    // can be removed once the following bugs have been fixed
    // https://crbug.com/405545 
    // https://bugzilla.mozilla.org/show_bug.cgi?id=964092
    // to be filed for opera
    this._remoteDataChannels = [];
    this._localDataChannels = [];
}

util.inherits(PeerConnection, WildEmitter);

Object.defineProperty(PeerConnection.prototype, 'signalingState', {
    get: function () {
        return this.pc.signalingState;
    }
});
Object.defineProperty(PeerConnection.prototype, 'iceConnectionState', {
    get: function () {
        return this.pc.iceConnectionState;
    }
});

// Add a stream to the peer connection object
PeerConnection.prototype.addStream = function (stream) {
    this.localStream = stream;
    this.pc.addStream(stream);
};


// Init and add ice candidate object with correct constructor
PeerConnection.prototype.processIce = function (update, cb) {
    cb = cb || function () {};
    var self = this;

    if (update.contents) {
        var contentNames = _.pluck(this.remoteDescription.contents, 'name');
        var contents = update.contents;

        contents.forEach(function (content) {
            var transport = content.transport || {};
            var candidates = transport.candidates || [];
            var mline = contentNames.indexOf(content.name);
            var mid = content.name;

            candidates.forEach(function (candidate) {
                var iceCandidate = SJJ.toCandidateSDP(candidate) + '\r\n';
                self.pc.addIceCandidate(new webrtc.IceCandidate({
                    candidate: iceCandidate,
                    sdpMLineIndex: mline,
                    sdpMid: mid
                })
                /* not yet, breaks Chrome M32 */
                /*
                , function () {
                    // well, this success callback is pretty meaningless
                },
                function (err) {
                    self.emit('error', err);
                }
                */
                );
                if (candidate.type === 'srflx') {
                    self.hadRemoteStunCandidate = true;
                } else if (candidate.type === 'relay') {
                    self.hadRemoteRelayCandidate = true;
                }
                if (candidate.ip.indexOf(':') != -1) {
                    self.hadRemoteIPv6Candidate = true;
                }
            });
        });
    } else {
        // working around https://code.google.com/p/webrtc/issues/detail?id=3669
        if (update.candidate.candidate.indexOf('a=') !== 0) {
            update.candidate.candidate = 'a=' + update.candidate.candidate;
        }

        self.pc.addIceCandidate(new webrtc.IceCandidate(update.candidate));
        var cand = SJJ.toCandidateJSON(update.candidate.candidate);
        if (cand.type == 'srflx') {
            self.hadRemoteStunCandidate = true;
        } else if (cand.type == 'relay') {
            self.hadRemoteRelayCandidate = true;
        }
        if (cand.ip.indexOf(':') != -1) {
            self.hadRemoteIPv6Candidate = true;
        }
    }
    cb();
};

// Generate and emit an offer with the given constraints
PeerConnection.prototype.offer = function (constraints, cb) {
    var self = this;
    var hasConstraints = arguments.length === 2;
    var mediaConstraints = hasConstraints ? constraints : {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            }
        };
    cb = hasConstraints ? cb : constraints;
    cb = cb || function () {};

    // Actually generate the offer
    this.pc.createOffer(
        function (offer) {
            self.pc.setLocalDescription(offer,
                function () {
                    var jingle;
                    var expandedOffer = {
                        type: 'offer',
                        sdp: offer.sdp
                    };
                    if (self.config.useJingle) {
                        jingle = SJJ.toSessionJSON(offer.sdp, self.config.isInitiator ? 'initiator' : 'responder');
                        jingle.sid = self.config.sid;
                        self.localDescription = jingle;

                        // Save ICE credentials
                        _.each(jingle.contents, function (content) {
                            var transport = content.transport || {};
                            if (transport.ufrag) {
                                self.config.ice[content.name] = {
                                    ufrag: transport.ufrag,
                                    pwd: transport.pwd
                                };
                            }
                        });

                        expandedOffer.jingle = jingle;
                    }

                    self.emit('offer', expandedOffer);
                    cb(null, expandedOffer);
                },
                function (err) {
                    self.emit('error', err);
                    cb(err);
                }
            );
        },
        function (err) {
            self.emit('error', err);
            cb(err);
        },
        mediaConstraints
    );
};


// Process an incoming offer so that ICE may proceed before deciding
// to answer the request.
PeerConnection.prototype.handleOffer = function (offer, cb) {
    cb = cb || function () {};
    var self = this;
    offer.type = 'offer';
    if (offer.jingle) {
        offer.sdp = SJJ.toSessionSDP(offer.jingle, self.config.sdpSessionID);
        self.remoteDescription = offer.jingle;
    }
    self.pc.setRemoteDescription(new webrtc.SessionDescription(offer), function () {
        cb();
    }, cb);
};

// Answer an offer with audio only
PeerConnection.prototype.answerAudioOnly = function (cb) {
    var mediaConstraints = {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: false
            }
        };
    this._answer(mediaConstraints, cb);
};

// Answer an offer without offering to recieve
PeerConnection.prototype.answerBroadcastOnly = function (cb) {
    var mediaConstraints = {
            mandatory: {
                OfferToReceiveAudio: false,
                OfferToReceiveVideo: false
            }
        };
    this._answer(mediaConstraints, cb);
};

// Answer an offer with given constraints default is audio/video
PeerConnection.prototype.answer = function (constraints, cb) {
    var self = this;
    var hasConstraints = arguments.length === 2;
    var callback = hasConstraints ? cb : constraints;
    var mediaConstraints = hasConstraints ? constraints : {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            }
        };

    this._answer(mediaConstraints, callback);
};

// Process an answer
PeerConnection.prototype.handleAnswer = function (answer, cb) {
    cb = cb || function () {};
    var self = this;
    if (answer.jingle) {
        answer.sdp = SJJ.toSessionSDP(answer.jingle, self.config.sdpSessionID);
        self.remoteDescription = answer.jingle;
    }
    self.pc.setRemoteDescription(
        new webrtc.SessionDescription(answer),
        function () {
            cb(null);
        },
        cb
    );
};

// Close the peer connection
PeerConnection.prototype.close = function () {
    this.pc.close();

    this._localDataChannels = [];
    this._remoteDataChannels = [];

    this.emit('close');
};

// Internal code sharing for various types of answer methods
PeerConnection.prototype._answer = function (constraints, cb) {
    cb = cb || function () {};
    var self = this;
    if (!this.pc.remoteDescription) {
        // the old API is used, call handleOffer
        throw new Error('remoteDescription not set');
    }
    self.pc.createAnswer(
        function (answer) {
            self.pc.setLocalDescription(answer,
                function () {
                    var expandedAnswer = {
                        type: 'answer',
                        sdp: answer.sdp
                    };
                    if (self.config.useJingle) {
                        var jingle = SJJ.toSessionJSON(answer.sdp);
                        jingle.sid = self.config.sid;
                        self.localDescription = jingle;
                        expandedAnswer.jingle = jingle;
                    }
                    self.emit('answer', expandedAnswer);
                    cb(null, expandedAnswer);
                },
                function (err) {
                    self.emit('error', err);
                    cb(err);
                }
            );
        },
        function (err) {
            self.emit('error', err);
            cb(err);
        },
        constraints
    );
};

// Internal method for emitting ice candidates on our peer object
PeerConnection.prototype._onIce = function (event) {
    var self = this;
    if (event.candidate) {
        var ice = event.candidate;

        var expandedCandidate = {
            candidate: event.candidate
        };

        var cand = SJJ.toCandidateJSON(ice.candidate);
        if (self.config.useJingle) {
            if (!ice.sdpMid) { // firefox doesn't set this
                ice.sdpMid = self.localDescription.contents[ice.sdpMLineIndex].name;
            }
            if (!self.config.ice[ice.sdpMid]) {
                var jingle = SJJ.toSessionJSON(self.pc.localDescription.sdp, self.config.isInitiator ? 'initiator' : 'responder');
                _.each(jingle.contents, function (content) {
                    var transport = content.transport || {};
                    if (transport.ufrag) {
                        self.config.ice[content.name] = {
                            ufrag: transport.ufrag,
                            pwd: transport.pwd
                        };
                    }
                });
            }
            expandedCandidate.jingle = {
                contents: [{
                    name: ice.sdpMid,
                    creator: self.config.isInitiator ? 'initiator' : 'responder',
                    transport: {
                        transType: 'iceUdp',
                        ufrag: self.config.ice[ice.sdpMid].ufrag,
                        pwd: self.config.ice[ice.sdpMid].pwd,
                        candidates: [
                            cand
                        ]
                    }
                }]
            };
        }
        if (cand.type === 'srflx') {
            this.hadLocalStunCandidate = true;
        } else if (cand.type == 'relay') {
            this.hadLocalRelayCandidate = true;
        }
        if (cand.ip.indexOf(':') != -1) {
            self.hadLocalIPv6Candidate = true;
        }

        this.emit('ice', expandedCandidate);
    } else {
        this.emit('endOfCandidates');
    }
};

// Internal method for processing a new data channel being added by the
// other peer.
PeerConnection.prototype._onDataChannel = function (event) {
    // make sure we keep a reference so this doesn't get garbage collected
    var channel = event.channel;
    this._remoteDataChannels.push(channel);

    this.emit('addChannel', channel);
};

// Internal handling of adding stream
PeerConnection.prototype._onAddStream = function (event) {
    this.remoteStreams.push(event.stream);
    this.emit('addStream', event);
};

// Create a data channel spec reference:
// http://dev.w3.org/2011/webrtc/editor/webrtc.html#idl-def-RTCDataChannelInit
PeerConnection.prototype.createDataChannel = function (name, opts) {
    var channel = this.pc.createDataChannel(name, opts);

    // make sure we keep a reference so this doesn't get garbage collected
    this._localDataChannels.push(channel);

    return channel;
};

// a wrapper around getStats which hides the differences (where possible)
PeerConnection.prototype.getStats = function (cb) {
    if (webrtc.prefix === 'moz') {
        this.pc.getStats(
            function (res) {
                var items = [];
                res.forEach(function (result) {
                    items.push(result);
                });
                cb(null, items);
            },
            cb
        );
    } else {
        this.pc.getStats(function (res) {
            var items = [];
            res.result().forEach(function (result) {
                var item = {};
                result.names().forEach(function (name) {
                    item[name] = result.stat(name);
                });
                item.id = result.id;
                item.type = result.type;
                item.timestamp = result.timestamp;
                items.push(item);
            });
            cb(null, items);
        });
    }
};

module.exports = PeerConnection;

},{"sdp-jingle-json":204,"traceablepeerconnection":200,"underscore":234,"util":169,"webrtcsupport":202,"wildemitter":235}],204:[function(_dereq_,module,exports){
var tosdp = _dereq_('./lib/tosdp');
var tojson = _dereq_('./lib/tojson');


exports.toSessionSDP = tosdp.toSessionSDP;
exports.toMediaSDP = tosdp.toMediaSDP;
exports.toCandidateSDP = tosdp.toCandidateSDP;

exports.toSessionJSON = tojson.toSessionJSON;
exports.toMediaJSON = tojson.toMediaJSON;
exports.toCandidateJSON = tojson.toCandidateJSON;

},{"./lib/tojson":206,"./lib/tosdp":207}],205:[function(_dereq_,module,exports){
exports.lines = function (sdp) {
    return sdp.split('\r\n').filter(function (line) {
        return line.length > 0;
    });
};

exports.findLine = function (prefix, mediaLines, sessionLines) {
    var prefixLength = prefix.length;
    for (var i = 0; i < mediaLines.length; i++) {
        if (mediaLines[i].substr(0, prefixLength) === prefix) {
            return mediaLines[i];
        }
    }
    // Continue searching in parent session section
    if (!sessionLines) {
        return false;
    }

    for (var j = 0; j < sessionLines.length; j++) {
        if (sessionLines[j].substr(0, prefixLength) === prefix) {
            return sessionLines[j];
        }
    }

    return false;
};

exports.findLines = function (prefix, mediaLines, sessionLines) {
    var results = [];
    var prefixLength = prefix.length;
    for (var i = 0; i < mediaLines.length; i++) {
        if (mediaLines[i].substr(0, prefixLength) === prefix) {
            results.push(mediaLines[i]);
        }
    }
    if (results.length || !sessionLines) {
        return results;
    }
    for (var j = 0; j < sessionLines.length; j++) {
        if (sessionLines[j].substr(0, prefixLength) === prefix) {
            results.push(sessionLines[j]);
        }
    }
    return results;
};

exports.mline = function (line) {
    var parts = line.substr(2).split(' ');
    var parsed = {
        media: parts[0],
        port: parts[1],
        proto: parts[2],
        formats: []
    };
    for (var i = 3; i < parts.length; i++) {
        if (parts[i]) {
            parsed.formats.push(parts[i]);
        }
    }
    return parsed;
};

exports.rtpmap = function (line) {
    var parts = line.substr(9).split(' ');
    var parsed = {
        id: parts.shift()
    };

    parts = parts[0].split('/');

    parsed.name = parts[0];
    parsed.clockrate = parts[1];
    parsed.channels = parts.length == 3 ? parts[2] : '1';
    return parsed;
};

exports.sctpmap = function (line) {
    // based on -05 draft
    var parts = line.substr(10).split(' ');
    var parsed = {
        number: parts.shift(),
        protocol: parts.shift(),
        streams: parts.shift()
    };
    return parsed;
};


exports.fmtp = function (line) {
    var kv, key, value;
    var parts = line.substr(line.indexOf(' ') + 1).split(';');
    var parsed = [];
    for (var i = 0; i < parts.length; i++) {
        kv = parts[i].split('=');
        key = kv[0].trim();
        value = kv[1];
        if (key && value) {
            parsed.push({key: key, value: value});
        } else if (key) {
            parsed.push({key: '', value: key});
        }
    }
    return parsed;
};

exports.crypto = function (line) {
    var parts = line.substr(9).split(' ');
    var parsed = {
        tag: parts[0],
        cipherSuite: parts[1],
        keyParams: parts[2],
        sessionParams: parts.slice(3).join(' ')
    };
    return parsed;
};

exports.fingerprint = function (line) {
    var parts = line.substr(14).split(' ');
    return {
        hash: parts[0],
        value: parts[1]
    };
};

exports.extmap = function (line) {
    var parts = line.substr(9).split(' ');
    var parsed = {};

    var idpart = parts.shift();
    var sp = idpart.indexOf('/');
    if (sp >= 0) {
        parsed.id = idpart.substr(0, sp);
        parsed.senders = idpart.substr(sp + 1);
    } else {
        parsed.id = idpart;
        parsed.senders = 'sendrecv';
    }

    parsed.uri = parts.shift() || '';

    return parsed;
};

exports.rtcpfb = function (line) {
    var parts = line.substr(10).split(' ');
    var parsed = {};
    parsed.id = parts.shift();
    parsed.type = parts.shift();
    if (parsed.type === 'trr-int') {
        parsed.value = parts.shift();
    } else {
        parsed.subtype = parts.shift() || '';
    }
    parsed.parameters = parts;
    return parsed;
};

exports.candidate = function (line) {
    var parts;
    if (line.indexOf('a=candidate:') === 0) {
        parts = line.substring(12).split(' ');
    } else { // no a=candidate
        parts = line.substring(10).split(' ');
    }

    var candidate = {
        foundation: parts[0],
        component: parts[1],
        protocol: parts[2].toLowerCase(),
        priority: parts[3],
        ip: parts[4],
        port: parts[5],
        // skip parts[6] == 'typ'
        type: parts[7],
        generation: '0'
    };

    for (var i = 8; i < parts.length; i += 2) {
        if (parts[i] === 'raddr') {
            candidate.relAddr = parts[i + 1];
        } else if (parts[i] === 'rport') {
            candidate.relPort = parts[i + 1];
        } else if (parts[i] === 'generation') {
            candidate.generation = parts[i + 1];
        } else if (parts[i] === 'tcptype') {
            candidate.tcpType = parts[i + 1];
        }
    }

    candidate.network = '1';

    return candidate;
};

exports.sourceGroups = function (lines) {
    var parsed = [];
    for (var i = 0; i < lines.length; i++) {
        var parts = lines[i].substr(13).split(' ');
        parsed.push({
            semantics: parts.shift(),
            sources: parts
        });
    }
    return parsed;
};

exports.sources = function (lines) {
    // http://tools.ietf.org/html/rfc5576
    var parsed = [];
    var sources = {};
    for (var i = 0; i < lines.length; i++) {
        var parts = lines[i].substr(7).split(' ');
        var ssrc = parts.shift();

        if (!sources[ssrc]) {
            var source = {
                ssrc: ssrc,
                parameters: []
            };
            parsed.push(source);

            // Keep an index
            sources[ssrc] = source;
        }

        parts = parts.join(' ').split(':');
        var attribute = parts.shift();
        var value = parts.join(':') || null;

        sources[ssrc].parameters.push({
            key: attribute,
            value: value
        });
    }

    return parsed;
};

exports.groups = function (lines) {
    // http://tools.ietf.org/html/rfc5888
    var parsed = [];
    var parts;
    for (var i = 0; i < lines.length; i++) {
        parts = lines[i].substr(8).split(' ');
        parsed.push({
            semantics: parts.shift(),
            contents: parts
        });
    }
    return parsed;
};

exports.bandwidth = function (line) {
    var parts = line.substr(2).split(':');
    var parsed = {};
    parsed.type = parts.shift();
    parsed.bandwidth = parts.shift();
    return parsed;
};

},{}],206:[function(_dereq_,module,exports){
var parsers = _dereq_('./parsers');
var idCounter = Math.random();

exports._setIdCounter = function (counter) {
    idCounter = counter;
};

exports.toSessionJSON = function (sdp, creator) {
    // Divide the SDP into session and media sections.
    var media = sdp.split('\r\nm=');
    for (var i = 1; i < media.length; i++) {
        media[i] = 'm=' + media[i];
        if (i !== media.length - 1) {
            media[i] += '\r\n';
        }
    }
    var session = media.shift() + '\r\n';
    var sessionLines = parsers.lines(session);
    var parsed = {};

    var contents = [];
    media.forEach(function (m) {
        contents.push(exports.toMediaJSON(m, session, creator));
    });
    parsed.contents = contents;

    var groupLines = parsers.findLines('a=group:', sessionLines);
    if (groupLines.length) {
        parsed.groups = parsers.groups(groupLines);
    }

    return parsed;
};

exports.toMediaJSON = function (media, session, creator) {
    var lines = parsers.lines(media);
    var sessionLines = parsers.lines(session);
    var mline = parsers.mline(lines[0]);

    var content = {
        creator: creator,
        name: mline.media,
        description: {
            descType: 'rtp',
            media: mline.media,
            payloads: [],
            encryption: [],
            feedback: [],
            headerExtensions: []
        },
        transport: {
            transType: 'iceUdp',
            candidates: [],
            fingerprints: [],
        }
    };
    if (mline.media == 'application') {
        // FIXME: the description is most likely to be independent
        // of the SDP and should be processed by other parts of the library
        content.description = {
            descType: 'datachannel'
        };
        content.transport.sctp = [];
    }
    var desc = content.description;
    var trans = content.transport;

    // If we have a mid, use that for the content name instead.
    var mid = parsers.findLine('a=mid:', lines);
    if (mid) {
        content.name = mid.substr(6);
    }

    if (parsers.findLine('a=sendrecv', lines, sessionLines)) {
        content.senders = 'both';
    } else if (parsers.findLine('a=sendonly', lines, sessionLines)) {
        content.senders = 'initiator';
    } else if (parsers.findLine('a=recvonly', lines, sessionLines)) {
        content.senders = 'responder';
    } else if (parsers.findLine('a=inactive', lines, sessionLines)) {
        content.senders = 'none';
    }

    if (desc.descType == 'rtp') {
        var bandwidth = parsers.findLine('b=', lines);
        if (bandwidth) {
            desc.bandwidth = parsers.bandwidth(bandwidth);
        }

        var ssrc = parsers.findLine('a=ssrc:', lines);
        if (ssrc) {
            desc.ssrc = ssrc.substr(7).split(' ')[0];
        }

        var rtpmapLines = parsers.findLines('a=rtpmap:', lines);
        rtpmapLines.forEach(function (line) {
            var payload = parsers.rtpmap(line);
            payload.feedback = [];

            var fmtpLines = parsers.findLines('a=fmtp:' + payload.id, lines);
            fmtpLines.forEach(function (line) {
                payload.parameters = parsers.fmtp(line);
            });

            var fbLines = parsers.findLines('a=rtcp-fb:' + payload.id, lines);
            fbLines.forEach(function (line) {
                payload.feedback.push(parsers.rtcpfb(line));
            });

            desc.payloads.push(payload);
        });

        var cryptoLines = parsers.findLines('a=crypto:', lines, sessionLines);
        cryptoLines.forEach(function (line) {
            desc.encryption.push(parsers.crypto(line));
        });

        if (parsers.findLine('a=rtcp-mux', lines)) {
            desc.mux = true;
        }

        var fbLines = parsers.findLines('a=rtcp-fb:*', lines);
        fbLines.forEach(function (line) {
            desc.feedback.push(parsers.rtcpfb(line));
        });

        var extLines = parsers.findLines('a=extmap:', lines);
        extLines.forEach(function (line) {
            var ext = parsers.extmap(line);

            var senders = {
                sendonly: 'responder',
                recvonly: 'initiator',
                sendrecv: 'both',
                inactive: 'none'
            };
            ext.senders = senders[ext.senders];

            desc.headerExtensions.push(ext);
        });

        var ssrcGroupLines = parsers.findLines('a=ssrc-group:', lines);
        desc.sourceGroups = parsers.sourceGroups(ssrcGroupLines || []);

        var ssrcLines = parsers.findLines('a=ssrc:', lines);
        desc.sources = parsers.sources(ssrcLines || []);
    }

    // transport specific attributes
    var fingerprintLines = parsers.findLines('a=fingerprint:', lines, sessionLines);
    var setup = parsers.findLine('a=setup:', lines, sessionLines);
    fingerprintLines.forEach(function (line) {
        var fp = parsers.fingerprint(line);
        if (setup) {
            fp.setup = setup.substr(8);
        }
        trans.fingerprints.push(fp);
    });

    var ufragLine = parsers.findLine('a=ice-ufrag:', lines, sessionLines);
    var pwdLine = parsers.findLine('a=ice-pwd:', lines, sessionLines);
    if (ufragLine && pwdLine) {
        trans.ufrag = ufragLine.substr(12);
        trans.pwd = pwdLine.substr(10);
        trans.candidates = [];

        var candidateLines = parsers.findLines('a=candidate:', lines, sessionLines);
        candidateLines.forEach(function (line) {
            trans.candidates.push(exports.toCandidateJSON(line));
        });
    }

    if (desc.descType == 'datachannel') {
        var sctpmapLines = parsers.findLines('a=sctpmap:', lines);
        sctpmapLines.forEach(function (line) {
            var sctp = parsers.sctpmap(line);
            trans.sctp.push(sctp);
        });
    }

    return content;
};

exports.toCandidateJSON = function (line) {
    var candidate = parsers.candidate(line.split('\r\n')[0]);
    candidate.id = (idCounter++).toString(36).substr(0, 12);
    return candidate;
};

},{"./parsers":205}],207:[function(_dereq_,module,exports){
var senders = {
    'initiator': 'sendonly',
    'responder': 'recvonly',
    'both': 'sendrecv',
    'none': 'inactive',
    'sendonly': 'initator',
    'recvonly': 'responder',
    'sendrecv': 'both',
    'inactive': 'none'
};


exports.toSessionSDP = function (session, sid, time) {
    var sdp = [
        'v=0',
        'o=- ' + (sid || session.sid || Date.now()) + ' ' + (time || Date.now()) + ' IN IP4 0.0.0.0',
        's=-',
        't=0 0'
    ];

    var groups = session.groups || [];
    groups.forEach(function (group) {
        sdp.push('a=group:' + group.semantics + ' ' + group.contents.join(' '));
    });

    var contents = session.contents || [];
    contents.forEach(function (content) {
        sdp.push(exports.toMediaSDP(content));
    });

    return sdp.join('\r\n') + '\r\n';
};

exports.toMediaSDP = function (content) {
    var sdp = [];

    var desc = content.description;
    var transport = content.transport;
    var payloads = desc.payloads || [];
    var fingerprints = (transport && transport.fingerprints) || [];

    var mline = [];
    if (desc.descType == 'datachannel') {
        mline.push('application');
        mline.push('1');
        mline.push('DTLS/SCTP');
        if (transport.sctp) {
            transport.sctp.forEach(function (map) {
                mline.push(map.number);
            });
        }
    } else {
        mline.push(desc.media);
        mline.push('1');
        if ((desc.encryption && desc.encryption.length > 0) || (fingerprints.length > 0)) {
            mline.push('RTP/SAVPF');
        } else {
            mline.push('RTP/AVPF');
        }
        payloads.forEach(function (payload) {
            mline.push(payload.id);
        });
    }


    sdp.push('m=' + mline.join(' '));

    sdp.push('c=IN IP4 0.0.0.0');
    if (desc.bandwidth && desc.bandwidth.type && desc.bandwidth.bandwidth) {
        sdp.push('b=' + desc.bandwidth.type + ':' + desc.bandwidth.bandwidth);
    }
    if (desc.descType == 'rtp') {
        sdp.push('a=rtcp:1 IN IP4 0.0.0.0');
    }

    if (transport) {
        if (transport.ufrag) {
            sdp.push('a=ice-ufrag:' + transport.ufrag);
        }
        if (transport.pwd) {
            sdp.push('a=ice-pwd:' + transport.pwd);
        }

        var pushedSetup = false;
        fingerprints.forEach(function (fingerprint) {
            sdp.push('a=fingerprint:' + fingerprint.hash + ' ' + fingerprint.value);
            if (fingerprint.setup && !pushedSetup) {
                sdp.push('a=setup:' + fingerprint.setup);
            }
        });

        if (transport.sctp) {
            transport.sctp.forEach(function (map) {
                sdp.push('a=sctpmap:' + map.number + ' ' + map.protocol + ' ' + map.streams);
            });
        }
    }

    if (desc.descType == 'rtp') {
        sdp.push('a=' + (senders[content.senders] || 'sendrecv'));
    }
    sdp.push('a=mid:' + content.name);

    if (desc.mux) {
        sdp.push('a=rtcp-mux');
    }

    var encryption = desc.encryption || [];
    encryption.forEach(function (crypto) {
        sdp.push('a=crypto:' + crypto.tag + ' ' + crypto.cipherSuite + ' ' + crypto.keyParams + (crypto.sessionParams ? ' ' + crypto.sessionParams : ''));
    });

    payloads.forEach(function (payload) {
        var rtpmap = 'a=rtpmap:' + payload.id + ' ' + payload.name + '/' + payload.clockrate;
        if (payload.channels && payload.channels != '1') {
            rtpmap += '/' + payload.channels;
        }
        sdp.push(rtpmap);

        if (payload.parameters && payload.parameters.length) {
            var fmtp = ['a=fmtp:' + payload.id];
            var parameters = [];
            payload.parameters.forEach(function (param) {
                parameters.push((param.key ? param.key + '=' : '') + param.value);
            });
            fmtp.push(parameters.join(';'));
            sdp.push(fmtp.join(' '));
        }

        if (payload.feedback) {
            payload.feedback.forEach(function (fb) {
                if (fb.type === 'trr-int') {
                    sdp.push('a=rtcp-fb:' + payload.id + ' trr-int ' + fb.value ? fb.value : '0');
                } else {
                    sdp.push('a=rtcp-fb:' + payload.id + ' ' + fb.type + (fb.subtype ? ' ' + fb.subtype : ''));
                }
            });
        }
    });

    if (desc.feedback) {
        desc.feedback.forEach(function (fb) {
            if (fb.type === 'trr-int') {
                sdp.push('a=rtcp-fb:* trr-int ' + fb.value ? fb.value : '0');
            } else {
                sdp.push('a=rtcp-fb:* ' + fb.type + (fb.subtype ? ' ' + fb.subtype : ''));
            }
        });
    }

    var hdrExts = desc.headerExtensions || [];
    hdrExts.forEach(function (hdr) {
        sdp.push('a=extmap:' + hdr.id + (hdr.senders ? '/' + senders[hdr.senders] : '') + ' ' + hdr.uri);
    });

    var ssrcGroups = desc.sourceGroups || [];
    ssrcGroups.forEach(function (ssrcGroup) {
        sdp.push('a=ssrc-group:' + ssrcGroup.semantics + ' ' + ssrcGroup.sources.join(' '));
    });

    var ssrcs = desc.sources || [];
    ssrcs.forEach(function (ssrc) {
        for (var i = 0; i < ssrc.parameters.length; i++) {
            var param = ssrc.parameters[i];
            sdp.push('a=ssrc:' + (ssrc.ssrc || desc.ssrc) + ' ' + param.key + (param.value ? (':' + param.value) : ''));
        }
    });

    var candidates = transport.candidates || [];
    candidates.forEach(function (candidate) {
        sdp.push(exports.toCandidateSDP(candidate));
    });

    return sdp.join('\r\n');
};

exports.toCandidateSDP = function (candidate) {
    var sdp = [];

    sdp.push(candidate.foundation);
    sdp.push(candidate.component);
    sdp.push(candidate.protocol.toUpperCase());
    sdp.push(candidate.priority);
    sdp.push(candidate.ip);
    sdp.push(candidate.port);

    var type = candidate.type;
    sdp.push('typ');
    sdp.push(type);
    if (type === 'srflx' || type === 'prflx' || type === 'relay') {
        if (candidate.relAddr && candidate.relPort) {
            sdp.push('raddr');
            sdp.push(candidate.relAddr);
            sdp.push('rport');
            sdp.push(candidate.relPort);
        }
    }
    if (candidate.tcpType) {
        sdp.push('tcptype');
        sdp.push(candidate.tcpType);
    }

    sdp.push('generation');
    sdp.push(candidate.generation || '0');

    // FIXME: apparently this is wrong per spec
    // but then, we need this when actually putting this into
    // SDP so it's going to stay.
    // decision needs to be revisited when browsers dont
    // accept this any longer
    return 'a=candidate:' + sdp.join(' ');
};

},{}],208:[function(_dereq_,module,exports){
module.exports=_dereq_(201)
},{}],209:[function(_dereq_,module,exports){
'use strict';

var jxt = _dereq_('jxt');
var JID = _dereq_('xmpp-jid').JID;


exports.jidAttribute = function (attr, prepped) {
    return {
        get: function () {
            var jid = new JID(jxt.getAttribute(this.xml, attr));
            if (prepped) {
                jid.prepped = true;
            }
            return jid;
        },
        set: function (value) {
            jxt.setAttribute(this.xml, attr, (value || '').toString());
        }
    };
};


exports.jidSub = function (NS, sub, prepped) {
    return {
        get: function () {
            var jid = new JID(jxt.getSubText(this.xml, NS, sub));
            if (prepped) {
                jid.prepped = true;
            }
            return jid;
        },
        set: function (value) {
            jxt.setSubText(this.xml, NS, sub, (value || '').toString());
        }
    };
};


exports.tzoSub = jxt.field(
    function (xml, NS, sub, defaultVal) {
        var split, hrs, min;
        var sign = -1;
        var formatted = jxt.getSubText(xml, NS, sub);

        if (!formatted) {
            return defaultVal;
        }

        if (formatted.charAt(0) === '-') {
            sign = 1;
            formatted = formatted.slice(1);
        }

        split = formatted.split(':');
        hrs = parseInt(split[0], 10);
        min = parseInt(split[1], 10);
        return (hrs * 60 + min) * sign;
    },
    function (xml, NS, sub, value) {
        var hrs, min;
        var formatted = '-';
        if (typeof value === 'number') {
            if (value < 0) {
                value = -value;
                formatted = '+';
            }
            hrs = value / 60;
            min = value % 60;
            formatted += (hrs < 10 ? '0' : '') + hrs + ':' + (min < 10 ? '0' : '') + min;
        } else {
            formatted = value;
        }
        jxt.setSubText(xml, NS, sub, formatted);
    }
);

},{"jxt":210,"xmpp-jid":236}],210:[function(_dereq_,module,exports){
'use strict';

var ltx = _dereq_('ltx');
var extend = _dereq_('extend-object');
var uuid = _dereq_('node-uuid');

var types = _dereq_('./lib/types');
var helpers = _dereq_('./lib/helpers');
var stanzaConstructor = _dereq_('./lib/stanza');


function JXT() {
    this._LOOKUP = {};
    this._LOOKUP_EXT = {};
    this._TAGS = {};
    this._CB_DEFINITION = {};
    this._CB_TAG = {};
    this._ID = uuid.v4();
    this.utils = extend({}, types, helpers);
}

JXT.prototype.use = function (init) {
    if (!init['__JXT_LOADED_' + this._ID]) {
        init(this);
    }
    init['__JXT_LOADED_' + this._ID] = true;
    return this;
};

JXT.prototype.getDefinition = function (el, ns, required) {
    var JXTClass = this._LOOKUP[ns + '|' + el];
    if (required && !JXTClass) {
        throw new Error('Could not find definition for <' + el + ' xmlns="' + ns + '" />');
    }
    return JXTClass;
};

JXT.prototype.getExtensions = function (el, ns) {
    return this._LOOKUP_EXT[ns + '|' + el] || {};
};

JXT.prototype.withDefinition = function (el, ns, cb) {
    var name = ns + '|' + el;
    if (!this._CB_DEFINITION[name]) {
        this._CB_DEFINITION[name] = [];
    }
    this._CB_DEFINITION[name].push(cb);

    if (this._LOOKUP[name]) {
        cb(this._LOOKUP[name]);
    }
};

JXT.prototype.withTag = function (tag, cb) {
    if (!this._CB_TAG[tag]) {
        this._CB_TAG[tag] = [];
    }
    this._CB_TAG[tag].push(cb);

    this.tagged(tag).forEach(function (stanza) {
        cb(stanza);
    });
};

JXT.prototype.tagged = function (tag) {
    return this._TAGS[tag] || [];
};

JXT.prototype.build = function (xml) {
    var JXTClass = this._LOOKUP[xml.namespaceURI + '|' + xml.localName];
    if (JXTClass) {
        return new JXTClass(null, xml);
    }
};

JXT.prototype.parse = function (str) {
    var xml= ltx.parse(str);
    if (xml.nodeType !== 1) {
        return;
    }

    var JXTClass = this.getDefinition(xml.localName, xml.namespaceURI);
    if (JXTClass) {
        return new JXTClass(null, xml);
    }
};

JXT.prototype.extend = function (ParentJXT, ChildJXT, multiName) {
    var parentName = ParentJXT.prototype._NS + '|' + ParentJXT.prototype._EL;
    var name = ChildJXT.prototype._name;
    var qName = ChildJXT.prototype._NS + '|' + ChildJXT.prototype._EL;

    this._LOOKUP[qName] = ChildJXT;
    if (!this._LOOKUP_EXT[qName]) {
        this._LOOKUP_EXT[qName] = {};
    }
    if (!this._LOOKUP_EXT[parentName]) {
        this._LOOKUP_EXT[parentName] = {};
    }
    this._LOOKUP_EXT[parentName][name] = ChildJXT;

    this.add(ParentJXT, name, types.extension(ChildJXT));
    if (multiName) {
        this.add(ParentJXT, multiName, types.multiExtension(ChildJXT));
    }
};

JXT.prototype.add = function (ParentJXT, fieldName, field) {
    field.enumerable = true;
    Object.defineProperty(ParentJXT.prototype, fieldName, field);
};

JXT.prototype.define = function (opts) {
    var self = this;

    var Stanza = stanzaConstructor(this, opts);

    var ns = Stanza.prototype._NS;
    var el = Stanza.prototype._EL;
    var tags = Stanza.prototype._TAGS;

    var name = ns + '|' + el;
    this._LOOKUP[name] = Stanza;

    tags.forEach(function (tag) {
        if (!self._TAGS[tag]) {
            self._TAGS[tag] = [];
        }
        self._TAGS[tag].push(Stanza);
    });

    var fieldNames = Object.keys(opts.fields || {});
    fieldNames.forEach(function (fieldName) {
        self.add(Stanza, fieldName, opts.fields[fieldName]);
    });

    if (this._CB_DEFINITION[name]) {
        this._CB_DEFINITION[name].forEach(function (handler) {
            handler(Stanza);
        });
    }

    tags.forEach(function (tag) {
        if (self._CB_TAG[tag]) {
            self._CB_TAG[tag].forEach(function (handler) {
                handler(Stanza);
            });
        }
    });

    return Stanza;
};


// Expose methods on the required module itself


JXT.createRegistry = function () {
    return new JXT();
};

extend(JXT, helpers);
extend(JXT, types);

// Compatibility shim for JXT 1.x

var globalJXT = new JXT();

JXT.define = globalJXT.define.bind(globalJXT);
JXT.extend = globalJXT.extend.bind(globalJXT);
JXT.add = globalJXT.add.bind(globalJXT);
JXT.parse = globalJXT.parse.bind(globalJXT);
JXT.build = globalJXT.build.bind(globalJXT);
JXT.getExtensions = globalJXT.getExtensions.bind(globalJXT);
JXT.getDefinition = globalJXT.getDefinition.bind(globalJXT);
JXT.withDefinition = globalJXT.withDefinition.bind(globalJXT);
JXT.withTag = globalJXT.withTag.bind(globalJXT);
JXT.tagged = globalJXT.tagged.bind(globalJXT);

JXT.getGlobalJXT = function () {
    return globalJXT;
};

module.exports = JXT;

},{"./lib/helpers":211,"./lib/stanza":212,"./lib/types":213,"extend-object":214,"ltx":217,"node-uuid":221}],211:[function(_dereq_,module,exports){
'use strict';

var ltx = _dereq_('ltx');

var XML_NS = exports.XML_NS = 'http://www.w3.org/XML/1998/namespace';


exports.createElement = function (NS, name, parentNS) {
    var el = new ltx.Element(name);
    if (!parentNS || parentNS !== NS) {
        exports.setAttribute(el, 'xmlns', NS);
    }
    return el;
};

var find = exports.find = function (xml, NS, selector) {
    var results = [];
    var children = xml.getElementsByTagName(selector);
    for (var i = 0, len = children.length; i < len; i++) {
        var child = children[i];
        if (child.namespaceURI === NS && child.parentNode === xml) {
            results.push(child);
        }
    }
    return results;
};

exports.findOrCreate = function (xml, NS, selector) {
    var existing = exports.find(xml, NS, selector);
    if (existing.length) {
        return existing[0];
    } else {
        var created = exports.createElement(NS, selector, xml.namespaceURI);
        xml.appendChild(created);
        return created;
    }
};

exports.getAttribute = function (xml, attr, defaultVal) {
    return xml.getAttribute(attr) || defaultVal || '';
};

exports.getAttributeNS = function (xml, NS, attr, defaultVal) {
    return xml.getAttributeNS(NS, attr) || defaultVal || '';
};

exports.setAttribute = function (xml, attr, value, force) {
    if (value || force) {
        xml.setAttribute(attr, value);
    } else {
        xml.removeAttribute(attr);
    }
};

exports.setAttributeNS = function (xml, NS, attr, value, force) {
    if (value || force) {
        xml.setAttributeNS(NS, attr, value);
    } else {
        xml.removeAttributeNS(NS, attr);
    }
};

exports.getBoolAttribute = function (xml, attr, defaultVal) {
    var val = xml.getAttribute(attr) || defaultVal || '';
    return val === 'true' || val === '1';
};

exports.setBoolAttribute = function (xml, attr, value) {
    if (value) {
        xml.setAttribute(attr, '1');
    } else {
        xml.removeAttribute(attr);
    }
};

exports.getSubAttribute = function (xml, NS, sub, attr, defaultVal) {
    var subs = find(xml, NS, sub);
    if (!subs) {
        return '';
    }

    for (var i = 0; i < subs.length; i++) {
        return subs[i].getAttribute(attr) || defaultVal || '';
    }

    return '';
};

exports.setSubAttribute = function (xml, NS, sub, attr, value) {
    var subs = find(xml, NS, sub);
    if (!subs.length) {
        if (value) {
            sub = exports.createElement(NS, sub, xml.namespaceURI);
            sub.setAttribute(attr, value);
            xml.appendChild(sub);
        }
    } else {
        for (var i = 0; i < subs.length; i++) {
            if (value) {
                subs[i].setAttribute(attr, value);
                return;
            } else {
                subs[i].removeAttribute(attr);
            }
        }
    }
};

exports.getBoolSubAttribute = function (xml, NS, sub, attr, defaultVal) {
    var val = xml.getSubAttribute(NS, sub, attr) || defaultVal || '';
    return val === 'true' || val === '1';
};

exports.setBoolSubAttribute = function (xml, NS, sub, attr, value) {
    value = value ? '1' : '';
    exports.setSubAttribute(xml, NS, sub, attr, value);
};

exports.getText = function (xml) {
    return xml.textContent;
};

exports.setText = function (xml, value) {
    xml.textContent = value;
};

exports.getSubText = exports.getTextSub = function (xml, NS, element, defaultVal) {
    var subs = find(xml, NS, element);

    defaultVal = defaultVal || '';

    if (!subs.length) {
        return defaultVal;
    }

    return subs[0].textContent || defaultVal;
};

exports.setSubText = exports.setTextSub = function (xml, NS, element, value) {
    var subs = find(xml, NS, element);
    if (subs.length) {
        for (var i = 0; i < subs.length; i++) {
            xml.removeChild(subs[i]);
        }
    }

    if (value) {
        var sub = exports.createElement(NS, element, xml.namespaceURI);
        if (value !== true) {
            sub.textContent = value;
        }
        xml.appendChild(sub);
    }
};

exports.getMultiSubText = function (xml, NS, element, extractor) {
    var subs = find(xml, NS, element);
    var results = [];

    extractor = extractor || function (sub) {
        return sub.textContent || '';
    };

    for (var i = 0; i < subs.length; i++) {
        results.push(extractor(subs[i]));
    }

    return results;
};

exports.setMultiSubText = function (xml, NS, element, value, builder) {
    var subs = find(xml, NS, element);
    var values = [];
    builder = builder || function (value) {
        var sub = exports.createElement(NS, element, xml.namespaceURI);
        sub.textContent = value;
        xml.appendChild(sub);
    };
    if (typeof value === 'string') {
        values = (value || '').split('\n');
    } else {
        values = value;
    }

    var i, len;
    for(i = 0, len = subs.length; i < len; i++) {
        xml.removeChild(subs[i]);
    }

    for(i = 0, len = values.length; i < len; i++) {
        if (values[i]) {
            builder(values[i]);
        }
    }
};

exports.getMultiSubAttribute = function (xml, NS, element, attr) {
    return exports.getMultiSubText(xml, NS, element, function (sub) {
        return exports.getAttribute(sub, attr);
    });
};

exports.setMultiSubAttribute = function (xml, NS, element, attr, value) {
    exports.setMultiSubText(xml, NS, element, value, function (val) {
        var sub = exports.createElement(NS, element, xml.namespaceURI);
        exports.setAttribute(sub, attr, val);
        xml.appendChild(sub);
    });
};

exports.getSubLangText = function (xml, NS, element, defaultLang) {
    var subs = find(xml, NS, element);
    if (!subs.length) {
        return {};
    }

    var lang, sub;
    var results = {};
    var langs = [];

    for (var i = 0; i < subs.length; i++) {
        sub = subs[i];
        lang = sub.getAttributeNS(XML_NS, 'lang') || defaultLang;
        langs.push(lang);
        results[lang] = sub.textContent || '';
    }

    return results;
};

exports.setSubLangText = function (xml, NS, element, value, defaultLang) {
    var sub, lang;
    var subs = find(xml, NS, element);
    if (subs.length) {
        for (var i = 0; i < subs.length; i++) {
            xml.removeChild(subs[i]);
        }
    }

    if (typeof value === 'string') {
        sub = exports.createElement(NS, element, xml.namespaceURI);
        sub.textContent = value;
        xml.appendChild(sub);
    } else if (typeof value === 'object') {
        for (lang in value) {
            if (value.hasOwnProperty(lang)) {
                sub = exports.createElement(NS, element, xml.namespaceURI);
                if (lang !== defaultLang) {
                    sub.setAttributeNS(XML_NS, 'lang', lang);
                }
                sub.textContent = value[lang];
                xml.appendChild(sub);
            }
        }
    }
};

exports.getBoolSub = function (xml, NS, element) {
    var subs = find(xml, NS, element);
    return !!subs.length;
};

exports.setBoolSub = function (xml, NS, element, value) {
    var subs = find(xml, NS, element);
    if (!subs.length) {
        if (value) {
            var sub = exports.createElement(NS, element, xml.namespaceURI);
            xml.appendChild(sub);
        }
    } else {
        for (var i = 0; i < subs.length; i++) {
            if (value) {
                return;
            } else {
                xml.removeChild(subs[i]);
            }
        }
    }
};

},{"ltx":217}],212:[function(_dereq_,module,exports){
'use strict';

var helpers = _dereq_('./helpers');
var extend = _dereq_('extend-object');


var EXCLUDE = {
    constructor: true,
    parent: true,
    prototype: true,
    toJSON: true,
    toString: true,
    xml: true
};


module.exports = function (JXT, opts) {
    function Stanza(data, xml, parent) {
        var self = this;

        var parentNode = (xml || {}).parentNode || (parent || {}).xml;
        var parentNS = (parentNode || {}).namespaceURI;

        self.xml = xml || helpers.createElement(self._NS, self._EL, parentNS);

        Object.keys(opts.prefixes || {}).forEach(function (prefix) {
            var namespace = opts.prefixes[prefix];
            self.xml.setAttribute('xmlns:' + prefix, namespace);
        });

        self._extensions = {};

        for (var i = 0, len = self.xml.childNodes.length; i < len; i++) {
            var child = self.xml.childNodes[i];
            var ChildJXT = JXT.getDefinition(child.localName, child.namespaceURI);
            if (ChildJXT !== undefined) {
                var name = ChildJXT.prototype._name;
                self._extensions[name] = new ChildJXT(null, child);
                self._extensions[name].parent = self;
            }
        }

        extend(self, data);

        if (opts.init) {
            opts.init.apply(self, [data]);
        }

        return self;
    }


    Stanza.prototype._name = opts.name;
    Stanza.prototype._eventname = opts.eventName;
    Stanza.prototype._NS = opts.namespace;
    Stanza.prototype._EL = opts.element || opts.name;
    Stanza.prototype._TAGS = opts.tags || [];

    Stanza.prototype.toString = function () {
        return this.xml.toString();
    };

    Stanza.prototype.toJSON = function () {
        var prop;
        var result = {};

        for (prop in this._extensions) {
            if (this._extensions[prop].toJSON && prop[0] !== '_') {
                result[prop] = this._extensions[prop].toJSON();
            }
        }

        for (prop in this) {
            var allowedName = !EXCLUDE[prop] && prop[0] !== '_';
            var isExtensionName = JXT.getExtensions(this._EL, this._NS)[prop];

            if (allowedName && !isExtensionName) {
                var val = this[prop];
                if (typeof val === 'function') {
                    continue;
                }
                var type = Object.prototype.toString.call(val);
                if (type.indexOf('Object') >= 0) {
                    if (Object.keys(val).length > 0) {
                        result[prop] = val;
                    }
                } else if (type.indexOf('Array') >= 0) {
                    if (val.length > 0) {
                        var vals = [];
                        for (var n in val) {
                            var nval = val[n];
                            if (nval.toJSON !== undefined) {
                                vals.push(nval.toJSON());
                            } else {
                                vals.push(nval);
                            }
                        }
                        result[prop] = vals;
                    }
                } else if (val !== undefined && val !== false && val !== '') {
                    result[prop] = val;
                }
            }
        }

        return result;
    };

    return Stanza;
};

},{"./helpers":211,"extend-object":214}],213:[function(_dereq_,module,exports){
'use strict';

var fromB64 = _dereq_('atob');
var toB64 = _dereq_('btoa');

var helpers = _dereq_('./helpers');
var extend = _dereq_('extend-object');

var find = helpers.find;
var createElement = helpers.createElement;


var field = exports.field = function (getter, setter) {
    return function () {
        var args = Array.prototype.slice.call(arguments);
        return {
            get: function () {
                return getter.apply(null, [this.xml].concat(args));
            },
            set: function (value) {
                setter.apply(null, ([this.xml].concat(args)).concat([value]));
            }
        };
    };
};

exports.boolAttribute = field(
    helpers.getBoolAttribute,
    helpers.setBoolAttribute);

exports.subAttribute = field(
    helpers.getSubAttribute,
    helpers.setSubAttribute);

exports.boolSubAttribute = field(
    helpers.getSubBoolAttribute,
    helpers.setSubBoolAttribute);

exports.text = field(
    helpers.getText,
    helpers.setText);

exports.subText = field(
    helpers.getSubText,
    helpers.setSubText);

exports.multiSubText = field(
    helpers.getMultiSubText,
    helpers.setMultiSubText);

exports.multiSubAttribute  = field(
    helpers.getMultiSubAttribute,
    helpers.setMultiSubAttribute);

exports.subLangText = field(
    helpers.getSubLangText,
    helpers.setSubLangText);

exports.boolSub = field(
    helpers.getBoolSub,
    helpers.setBoolSub);

exports.langAttribute = field(
    function (xml) {
        return xml.getAttributeNS(helpers.XML_NS, 'lang') || '';
    },
    function (xml, value) {
        xml.setAttributeNS(helpers.XML_NS, 'lang', value);
    }
);

exports.b64Text = field(
    function (xml) {
        if (xml.textContent && xml.textContent !== '=') {
            return fromB64(xml.textContent);
        }
        return '';
    },
    function (xml, value) {
        if (typeof value === 'string') {
            xml.textContent = toB64(value) || '=';
        } else {
            xml.textContent = '';
        }
    }
);

exports.dateAttribute = function (attr, now) {
    return {
        get: function () {
            var data = helpers.getAttribute(this.xml, attr);
            if (data) {
                return new Date(data);
            }
            if (now) {
                return new Date(Date.now());
            }
        },
        set: function (value) {
            if (!value) {
                return;
            }
            if (typeof value !== 'string') {
                value = value.toISOString();
            }
            helpers.setAttribute(this.xml, attr, value);
        }
    };
};

exports.dateSub = function (NS, sub, now) {
    return {
        get: function () {
            var data = helpers.getSubText(this.xml, NS, sub);
            if (data) {
                return new Date(data);
            }
            if (now) {
                return new Date(Date.now());
            }
        },
        set: function (value) {
            if (!value) {
                return;
            }
            if (typeof value !== 'string') {
                value = value.toISOString();
            }
            helpers.setSubText(this.xml, NS, sub, value);
        }
    };
};

exports.dateSubAttribute = function (NS, sub, attr, now) {
    return {
        get: function () {
            var data = helpers.getSubAttribute(this.xml, NS, sub, attr);
            if (data) {
                return new Date(data);
            }
            if (now) {
                return new Date(Date.now());
            }
        },
        set: function (value) {
            if (!value) {
                return;
            }
            if (typeof value !== 'string') {
                value = value.toISOString();
            }
            helpers.setSubAttribute(this.xml, NS, sub, attr, value);
        }
    };
};

exports.numberAttribute = function (attr, isFloat, defaultVal) {
    return {
        get: function () {
            var parse = isFloat ? parseFloat : parseInt;
            var data = helpers.getAttribute(this.xml, attr, '');
            if (!data) {
                return defaultVal;
            }
            var parsed = parse(data, 10);
            if (isNaN(parsed)) {
                return defaultVal;
            }

            return parsed;
        },
        set: function (value) {
            helpers.setAttribute(this.xml, attr, value.toString());
        }
    };
};

exports.numberSub = function (NS, sub, isFloat, defaultVal) {
    return {
        get: function () {
            var parse = isFloat ? parseFloat : parseInt;
            var data = helpers.getSubText(this.xml, NS, sub, '');
            if (!data) {
                return defaultVal;
            }

            var parsed = parse(data, 10);
            if (isNaN(parsed)) {
                return defaultVal;
            }

            return parsed;
        },
        set: function (value) {
            helpers.setSubText(this.xml, NS, sub, value.toString());
        }
    };
};

exports.attribute = function (name, defaultVal) {
    return {
        get: function () {
            return helpers.getAttribute(this.xml, name, defaultVal);
        },
        set: function (value) {
            helpers.setAttribute(this.xml, name, value);
        }
    };
};

exports.attributeNS = function (NS, name, defaultVal) {
    return {
        get: function () {
            return helpers.getAttributeNS(this.xml, NS, name, defaultVal);
        },
        set: function (value) {
            helpers.setAttributeNS(this.xml, NS, name, value);
        }
    };
};

exports.extension = function (ChildJXT) {
    return {
        get: function () {
            var self = this;
            var name = ChildJXT.prototype._name;
            if (!this._extensions[name]) {
                var existing = find(this.xml, ChildJXT.prototype._NS, ChildJXT.prototype._EL);
                if (!existing.length) {
                    this._extensions[name] = new ChildJXT({}, null, self);
                    this.xml.appendChild(this._extensions[name].xml);
                } else {
                    this._extensions[name] = new ChildJXT(null, existing[0], self);
                }
                this._extensions[name].parent = this;
            }
            return this._extensions[name];
        },
        set: function (value) {
            if (value) {
                var child = this[ChildJXT.prototype._name];
                if (value === true) {
                    value = {};
                }
                extend(child, value);
            }
        }
    };
};

exports.multiExtension = function (ChildJXT) {
    return {
        get: function () {
            var self = this;
            var data = find(this.xml, ChildJXT.prototype._NS, ChildJXT.prototype._EL);
            var results = [];

            for (var i = 0, len = data.length; i < len; i++) {
                results.push(new ChildJXT({}, data[i], self));
            }

            return results;
        },
        set: function (value) {
            value = value || [];

            var self = this;
            var existing = find(this.xml, ChildJXT.prototype._NS, ChildJXT.prototype._EL);

            var i, len;
            for (i = 0, len = existing.length; i < len; i++) {
                self.xml.removeChild(existing[i]);
            }

            for (i = 0, len = value.length; i < len; i++) {
                var content = new ChildJXT(value[i], null, self);
                self.xml.appendChild(content.xml);
            }
        }
    };
};

exports.enumSub = function (NS, enumValues) {
    return {
        get: function () {
            var self = this;
            var result = [];
            enumValues.forEach(function (enumVal) {
                var exists = find(self.xml, NS, enumVal);
                if (exists.length) {
                    result.push(exists[0].nodeName);
                }
            });
            return result[0] || '';
        },
        set: function (value) {
            var self = this;
            enumValues.forEach(function (enumVal) {
                var exists = find(self.xml, NS, enumVal);
                if (exists.length) {
                    self.xml.removeChild(exists[0]);
                }
            });

            if (value) {
                var condition = createElement(NS, value);
                this.xml.appendChild(condition);
            }
        }
    };
};

exports.subExtension = function (name, NS, sub, ChildJXT) {
    return {
        get: function () {
            if (!this._extensions[name]) {
                var wrapper = find(this.xml, NS, sub);
                if (!wrapper.length) {
                    wrapper= createElement(NS, sub, this._NS);
                    this.xml.appendChild(wrapper);
                } else {
                    wrapper = wrapper[0];
                }

                var existing = find(wrapper, ChildJXT.prototype._NS, ChildJXT.prototype._EL);
                if (!existing.length) {
                    this._extensions[name] = new ChildJXT({}, null, {xml: wrapper});
                    wrapper.appendChild(this._extensions[name].xml);
                } else {
                    this._extensions[name] = new ChildJXT(null, existing[0], {xml: wrapper});
                }
                this._extensions[name].parent = this;
            }
            return this._extensions[name];
        },
        set: function (value) {
            var wrapper = find(this.xml, NS, sub);
            if (wrapper.length && !value) {
                this.xml.removeChild(wrapper[0]);
            }

            if (value) {
                var child = this[name];
                if (value === true) {
                    value = {};
                }
                extend(child, value);
            }
        }
    };
};

exports.subMultiExtension = function (NS, sub, ChildJXT) {
    return {
        get: function () {
            var self = this;
            var results = [];
            var existing = find(this.xml, NS, sub);
            if (!existing.length) {
                return results;
            }
            existing = existing[0];
            var data = find(existing, ChildJXT.prototype._NS, ChildJXT.prototype._EL);

            data.forEach(function (xml) {
                results.push(new ChildJXT({}, xml, self));
            });
            return results;
        },
        set: function (values) {
            var self = this;
            var existing = find(this.xml, NS, sub);
            if (existing.length) {
                self.xml.removeChild(existing[0]);
            }

            if (!values.length) {
                return;
            }

            existing = createElement(NS, sub, this._NS);

            values.forEach(function (value) {
                var content = new ChildJXT(value, null, self);
                existing.appendChild(content.xml);
            });

            self.xml.appendChild(existing);
        }
    };
};

},{"./helpers":211,"atob":109,"btoa":170,"extend-object":214}],214:[function(_dereq_,module,exports){
var arr = [];
var each = arr.forEach;
var slice = arr.slice;


module.exports = function(obj) {
    each.call(slice.call(arguments, 1), function(source) {
        if (source) {
            for (var prop in source) {
                obj[prop] = source[prop];
            }
        }
    });
    return obj;
};

},{}],215:[function(_dereq_,module,exports){
'use strict';

var util = _dereq_('util')
  , Element = _dereq_('./element').Element

function DOMElement(name, attrs) {
    Element.call(this, name, attrs)

    this.nodeType = 1
    this.nodeName = this.localName
}

util.inherits(DOMElement, Element)

DOMElement.prototype._getElement = function(name, attrs) {
    var element = new DOMElement(name, attrs)
    return element
}

Object.defineProperty(DOMElement.prototype, 'localName', {
    get: function () {
        return this.getName()
    }
})

Object.defineProperty(DOMElement.prototype, 'namespaceURI', {
    get: function () {
        return this.getNS()
    }
})

Object.defineProperty(DOMElement.prototype, 'parentNode', {
    get: function () {
        return this.parent
    }
})

Object.defineProperty(DOMElement.prototype, 'childNodes', {
    get: function () {
        return this.children
    }
})

Object.defineProperty(DOMElement.prototype, 'textContent', {
    get: function () {
        return this.getText()
    },
    set: function (value) {
        this.children.push(value)
    }
})

DOMElement.prototype.getElementsByTagName = function (name) {
    return this.getChildren(name)
}

DOMElement.prototype.getAttribute = function (name) {
    return this.getAttr(name)
}

DOMElement.prototype.setAttribute = function (name, value) {
    this.attr(name, value)
}

DOMElement.prototype.getAttributeNS = function (ns, name) {
    if (ns === 'http://www.w3.org/XML/1998/namespace') {
        return this.getAttr(['xml', name].join(':'))
    }
    return this.getAttr(name, ns)
}

DOMElement.prototype.setAttributeNS = function (ns, name, value) {
    var prefix
    if (ns === 'http://www.w3.org/XML/1998/namespace') {
        prefix = 'xml'
    } else {
        var nss = this.getXmlns()
        prefix = nss[ns] || ''
    }
    if (prefix) {
        this.attr([prefix, name].join(':'), value)
    }
}

DOMElement.prototype.removeAttribute = function (name) {
    this.attr(name, null)
}

DOMElement.prototype.appendChild = function (el) {
    this.cnode(el)
}

DOMElement.prototype.removeChild = function (el) {
    this.remove(el)
}

module.exports = DOMElement

},{"./element":216,"util":169}],216:[function(_dereq_,module,exports){
'use strict';

/**
 * This cheap replica of DOM/Builder puts me to shame :-)
 *
 * Attributes are in the element.attrs object. Children is a list of
 * either other Elements or Strings for text content.
 **/
function Element(name, attrs) {
    this.name = name
    this.parent = null
    this.attrs = attrs || {}
    this.children = []
}

/*** Accessors ***/

/**
 * if (element.is('message', 'jabber:client')) ...
 **/
Element.prototype.is = function(name, xmlns) {
    return (this.getName() === name) &&
        (!xmlns || (this.getNS() === xmlns))
}

/* without prefix */
Element.prototype.getName = function() {
    if (this.name.indexOf(':') >= 0)
        return this.name.substr(this.name.indexOf(':') + 1)
    else
        return this.name
}

/**
 * retrieves the namespace of the current element, upwards recursively
 **/
Element.prototype.getNS = function() {
    if (this.name.indexOf(':') >= 0) {
        var prefix = this.name.substr(0, this.name.indexOf(':'))
        return this.findNS(prefix)
    } else {
        return this.findNS()
    }
}

/**
 * find the namespace to the given prefix, upwards recursively
 **/
Element.prototype.findNS = function(prefix) {
    if (!prefix) {
        /* default namespace */
        if (this.attrs.xmlns)
            return this.attrs.xmlns
        else if (this.parent)
            return this.parent.findNS()
    } else {
        /* prefixed namespace */
        var attr = 'xmlns:' + prefix
        if (this.attrs[attr])
            return this.attrs[attr]
        else if (this.parent)
            return this.parent.findNS(prefix)
    }
}

/**
 * Recursiverly gets all xmlns defined, in the form of {url:prefix}
 **/
Element.prototype.getXmlns = function() {
    var namespaces = {}

    if (this.parent)
        namespaces = this.parent.getXmlns()

    for (var attr in this.attrs) {
        var m = attr.match('xmlns:?(.*)')
        if (this.attrs.hasOwnProperty(attr) && m) {
            namespaces[this.attrs[attr]] = m[1]
        }
    }
    return namespaces
}


/**
 * xmlns can be null, returns the matching attribute.
 **/
Element.prototype.getAttr = function(name, xmlns) {
    if (!xmlns)
        return this.attrs[name]

    var namespaces = this.getXmlns()

    if (!namespaces[xmlns])
        return null

    return this.attrs[[namespaces[xmlns], name].join(':')]
}

/**
 * xmlns can be null
 **/
Element.prototype.getChild = function(name, xmlns) {
    return this.getChildren(name, xmlns)[0]
}

/**
 * xmlns can be null
 **/
Element.prototype.getChildren = function(name, xmlns) {
    var result = []
    for (var i = 0; i < this.children.length; i++) {
        var child = this.children[i]
        if (child.getName &&
            (child.getName() === name) &&
            (!xmlns || (child.getNS() === xmlns)))
            result.push(child)
    }
    return result
}

/**
 * xmlns and recursive can be null
 **/
Element.prototype.getChildByAttr = function(attr, val, xmlns, recursive) {
    return this.getChildrenByAttr(attr, val, xmlns, recursive)[0]
}

/**
 * xmlns and recursive can be null
 **/
Element.prototype.getChildrenByAttr = function(attr, val, xmlns, recursive) {
    var result = []
    for (var i = 0; i < this.children.length; i++) {
        var child = this.children[i]
        if (child.attrs &&
            (child.attrs[attr] === val) &&
            (!xmlns || (child.getNS() === xmlns)))
            result.push(child)
        if (recursive && child.getChildrenByAttr) {
            result.push(child.getChildrenByAttr(attr, val, xmlns, true))
        }
    }
    if (recursive) result = [].concat.apply([], result)
    return result
}

Element.prototype.getChildrenByFilter = function(filter, recursive) {
    var result = []
    for (var i = 0; i < this.children.length; i++) {
        var child = this.children[i]
        if (filter(child))
            result.push(child)
        if (recursive && child.getChildrenByFilter){
            result.push(child.getChildrenByFilter(filter, true))
        }
    }
    if (recursive) {
        result = [].concat.apply([], result)
    }
    return result
}

Element.prototype.getText = function() {
    var text = ''
    for (var i = 0; i < this.children.length; i++) {
        var child = this.children[i]
        if ((typeof child === 'string') || (typeof child === 'number')) {
            text += child
        }
    }
    return text
}

Element.prototype.getChildText = function(name, xmlns) {
    var child = this.getChild(name, xmlns)
    return child ? child.getText() : null
}

/**
 * Return all direct descendents that are Elements.
 * This differs from `getChildren` in that it will exclude text nodes,
 * processing instructions, etc.
 */
Element.prototype.getChildElements = function() {
    return this.getChildrenByFilter(function(child) {
        return child instanceof Element
    })
}

/*** Builder ***/

/** returns uppermost parent */
Element.prototype.root = function() {
    if (this.parent)
        return this.parent.root()
    else
        return this
}
Element.prototype.tree = Element.prototype.root

/** just parent or itself */
Element.prototype.up = function() {
    if (this.parent)
        return this.parent
    else
        return this
}

Element.prototype._getElement = function(name, attrs) {
    var element = new Element(name, attrs)
    return element
}

/** create child node and return it */
Element.prototype.c = function(name, attrs) {
    return this.cnode(this._getElement(name, attrs))
}

Element.prototype.cnode = function(child) {
    this.children.push(child)
    child.parent = this
    return child
}

/** add text node and return element */
Element.prototype.t = function(text) {
    this.children.push(text)
    return this
}

/*** Manipulation ***/

/**
 * Either:
 *   el.remove(childEl)
 *   el.remove('author', 'urn:...')
 */
Element.prototype.remove = function(el, xmlns) {
    var filter
    if (typeof el === 'string') {
        /* 1st parameter is tag name */
        filter = function(child) {
            return !(child.is &&
                 child.is(el, xmlns))
        }
    } else {
        /* 1st parameter is element */
        filter = function(child) {
            return child !== el
        }
    }

    this.children = this.children.filter(filter)

    return this
}

/**
 * To use in case you want the same XML data for separate uses.
 * Please refrain from this practise unless you know what you are
 * doing. Building XML with ltx is easy!
 */
Element.prototype.clone = function() {
    var clone = this._getElement(this.name, {})
    for (var k in this.attrs) {
        if (this.attrs.hasOwnProperty(k))
            clone.attrs[k] = this.attrs[k]
    }
    for (var i = 0; i < this.children.length; i++) {
        var child = this.children[i]
        clone.cnode(child.clone ? child.clone() : child)
    }
    return clone
}

Element.prototype.text = function(val) {
    if (val && this.children.length === 1) {
        this.children[0] = val
        return this
    }
    return this.getText()
}

Element.prototype.attr = function(attr, val) {
    if (((typeof val !== 'undefined') || (val === null))) {
        if (!this.attrs) {
            this.attrs = {}
        }
        this.attrs[attr] = val
        return this
    }
    return this.attrs[attr]
}

/*** Serialization ***/

Element.prototype.toString = function() {
    var s = ''
    this.write(function(c) {
        s += c
    })
    return s
}

Element.prototype._addChildren = function(writer) {
    writer('>')
    for (var i = 0; i < this.children.length; i++) {
        var child = this.children[i]
        /* Skip null/undefined */
        if (child || (child === 0)) {
            if (child.write) {
                child.write(writer)
            } else if (typeof child === 'string') {
                writer(escapeXmlText(child))
            } else if (child.toString) {
                writer(escapeXmlText(child.toString(10)))
            }
        }
    }
    writer('</')
    writer(this.name)
    writer('>')
}

Element.prototype.write = function(writer) {
    writer('<')
    writer(this.name)
    for (var k in this.attrs) {
        var v = this.attrs[k]
        if (v || (v === '') || (v === 0)) {
            writer(' ')
            writer(k)
            writer('="')
            if (typeof v !== 'string') {
                v = v.toString(10)
            }
            writer(escapeXml(v))
            writer('"')
        }
    }
    if (this.children.length === 0) {
        writer('/>')
    } else {
        this._addChildren(writer)
    }
}

function escapeXml(s) {
    return s.
        replace(/\&/g, '&amp;').
        replace(/</g, '&lt;').
        replace(/>/g, '&gt;').
        replace(/"/g, '&quot;').
        replace(/"/g, '&apos;')
}

function escapeXmlText(s) {
    return s.
        replace(/\&/g, '&amp;').
        replace(/</g, '&lt;').
        replace(/>/g, '&gt;')
}

exports.Element = Element
exports.escapeXml = escapeXml

},{}],217:[function(_dereq_,module,exports){
'use strict';

/* Cause browserify to bundle SAX parsers: */
var parse = _dereq_('./parse')

parse.availableSaxParsers.push(parse.bestSaxParser = _dereq_('./sax/sax_ltx'))

/* SHIM */
module.exports = _dereq_('./index')
},{"./index":218,"./parse":219,"./sax/sax_ltx":220}],218:[function(_dereq_,module,exports){
'use strict';

var parse = _dereq_('./parse')

/**
 * The only (relevant) data structure
 */
exports.Element = _dereq_('./dom-element')

/**
 * Helper
 */
exports.escapeXml = _dereq_('./element').escapeXml

/**
 * DOM parser interface
 */
exports.parse = parse.parse
exports.Parser = parse.Parser

/**
 * SAX parser interface
 */
exports.availableSaxParsers = parse.availableSaxParsers
exports.bestSaxParser = parse.bestSaxParser

},{"./dom-element":215,"./element":216,"./parse":219}],219:[function(_dereq_,module,exports){
'use strict';

var events = _dereq_('events')
  , util = _dereq_('util')
  , DOMElement = _dereq_('./dom-element')


exports.availableSaxParsers = []
exports.bestSaxParser = null

var saxParsers = [
    './sax/sax_expat.js',
    './sax/sax_ltx.js',
    /*'./sax_easysax.js', './sax_node-xml.js',*/
    './sax/sax_saxjs.js'
]

saxParsers.forEach(function(modName) {
    var mod
    try {
        mod = _dereq_(modName)
    } catch (e) {
        /* Silently missing libraries drop for debug:
        console.error(e.stack || e)
         */
    }
    if (mod) {
        exports.availableSaxParsers.push(mod)
        if (!exports.bestSaxParser) {
            exports.bestSaxParser = mod
        }
    }
})

exports.Parser = function(saxParser) {
    events.EventEmitter.call(this)
    var self = this

    var ParserMod = saxParser || exports.bestSaxParser
    if (!ParserMod) {
        throw new Error('No SAX parser available')
    }
    this.parser = new ParserMod()

    var el
    this.parser.addListener('startElement', function(name, attrs) {
        var child = new DOMElement(name, attrs)
        if (!el) {
            el = child
        } else {
            el = el.cnode(child)
        }
    })
    this.parser.addListener('endElement', function(name) {
        /* jshint -W035 */
        if (!el) {
            /* Err */
        } else if (name === el.name) {
            if (el.parent) {
                el = el.parent
            } else if (!self.tree) {
                self.tree = el
                el = undefined
            }
        }
        /* jshint +W035 */
    })
    this.parser.addListener('text', function(str) {
        if (el) {
            el.t(str)
        }
    })
    this.parser.addListener('error', function(e) {
        self.error = e
        self.emit('error', e)
    })
}

util.inherits(exports.Parser, events.EventEmitter)

exports.Parser.prototype.write = function(data) {
    this.parser.write(data)
}

exports.Parser.prototype.end = function(data) {
    this.parser.end(data)

    if (!this.error) {
        if (this.tree) {
            this.emit('tree', this.tree)
        } else {
            this.emit('error', new Error('Incomplete document'))
        }
    }
}

exports.parse = function(data, saxParser) {
    var p = new exports.Parser(saxParser)
    var result = null
      , error = null

    p.on('tree', function(tree) {
        result = tree
    })
    p.on('error', function(e) {
        error = e
    })

    p.write(data)
    p.end()

    if (error) {
        throw error
    } else {
        return result
    }
}

},{"./dom-element":215,"events":164,"util":169}],220:[function(_dereq_,module,exports){
'use strict';

var util = _dereq_('util')
  , events = _dereq_('events')

var STATE_TEXT = 0,
    STATE_IGNORE_TAG = 1,
    STATE_TAG_NAME = 2,
    STATE_TAG = 3,
    STATE_ATTR_NAME = 4,
    STATE_ATTR_EQ = 5,
    STATE_ATTR_QUOT = 6,
    STATE_ATTR_VALUE = 7

var SaxLtx = module.exports = function SaxLtx() {
    events.EventEmitter.call(this)

    var state = STATE_TEXT, remainder
    var tagName, attrs, endTag, selfClosing, attrQuote
    var recordStart = 0
    var attrName

    this._handleTagOpening = function(endTag, tagName, attrs) {
        if (!endTag) {
            this.emit('startElement', tagName, attrs)
            if (selfClosing) {
                this.emit('endElement', tagName)
            }
        } else {
            this.emit('endElement', tagName)
        }
    }

    this.write = function(data) {
        /* jshint -W071 */
        /* jshint -W074 */
        if (typeof data !== 'string') {
            data = data.toString()
        }
        var pos = 0

        /* Anything from previous write()? */
        if (remainder) {
            data = remainder + data
            pos += remainder.length
            remainder = null
        }

        function endRecording() {
            if (typeof recordStart === 'number') {
                var recorded = data.slice(recordStart, pos)
                recordStart = undefined
                return recorded
            }
        }

        for(; pos < data.length; pos++) {
            var c = data.charCodeAt(pos)
            //console.log("state", state, "c", c, data[pos])
            switch(state) {
            case STATE_TEXT:
                if (c === 60 /* < */) {
                    var text = endRecording()
                    if (text) {
                        this.emit('text', unescapeXml(text))
                    }
                    state = STATE_TAG_NAME
                    recordStart = pos + 1
                    attrs = {}
                }
                break
            case STATE_TAG_NAME:
                if (c === 47 /* / */ && recordStart === pos) {
                    recordStart = pos + 1
                    endTag = true
                } else if (c === 33 /* ! */ || c === 63 /* ? */) {
                    recordStart = undefined
                    state = STATE_IGNORE_TAG
                } else if (c <= 32 || c === 47 /* / */ || c === 62 /* > */) {
                    tagName = endRecording()
                    pos--
                    state = STATE_TAG
                }
                break
            case STATE_IGNORE_TAG:
                if (c === 62 /* > */) {
                    state = STATE_TEXT
                }
                break
            case STATE_TAG:
                if (c === 62 /* > */) {
                    this._handleTagOpening(endTag, tagName, attrs)
                    tagName = undefined
                    attrs = undefined
                    endTag = undefined
                    selfClosing = undefined
                    state = STATE_TEXT
                    recordStart = pos + 1
                } else if (c === 47 /* / */) {
                    selfClosing = true
                } else if (c > 32) {
                    recordStart = pos
                    state = STATE_ATTR_NAME
                }
                break
            case STATE_ATTR_NAME:
                if (c <= 32 || c === 61 /* = */) {
                    attrName = endRecording()
                    pos--
                    state = STATE_ATTR_EQ
                }
                break
            case STATE_ATTR_EQ:
                if (c === 61 /* = */) {
                    state = STATE_ATTR_QUOT
                }
                break
            case STATE_ATTR_QUOT:
                if (c === 34 /* " */ || c === 39 /* ' */) {
                    attrQuote = c
                    state = STATE_ATTR_VALUE
                    recordStart = pos + 1
                }
                break
            case STATE_ATTR_VALUE:
                if (c === attrQuote) {
                    var value = unescapeXml(endRecording())
                    attrs[attrName] = value
                    attrName = undefined
                    state = STATE_TAG
                }
                break
            }
        }

        if (typeof recordStart === 'number' &&
            recordStart <= data.length) {

            remainder = data.slice(recordStart)
            recordStart = 0
        }
    }

    /*var origEmit = this.emit
    this.emit = function() {
    console.log('ltx', arguments)
    origEmit.apply(this, arguments)
    }*/
}
util.inherits(SaxLtx, events.EventEmitter)


SaxLtx.prototype.end = function(data) {
    if (data) {
        this.write(data)
    }

    /* Uh, yeah */
    this.write = function() {}
}

function unescapeXml(s) {
    return s.
        replace(/\&amp;/g, '&').
        replace(/\&lt;/g, '<').
        replace(/\&gt;/g, '>').
        replace(/\&quot;/g, '"').
        replace(/\&apos;/g, '\'')
}

},{"events":164,"util":169}],221:[function(_dereq_,module,exports){
(function (Buffer){
//     uuid.js
//
//     Copyright (c) 2010-2012 Robert Kieffer
//     MIT License - http://opensource.org/licenses/mit-license.php

(function() {
  var _global = this;

  // Unique ID creation requires a high quality random # generator.  We feature
  // detect to determine the best RNG source, normalizing to a function that
  // returns 128-bits of randomness, since that's what's usually required
  var _rng;

  // Node.js crypto-based RNG - http://nodejs.org/docs/v0.6.2/api/crypto.html
  //
  // Moderately fast, high quality
  if (typeof(_dereq_) == 'function') {
    try {
      var _rb = _dereq_('crypto').randomBytes;
      _rng = _rb && function() {return _rb(16);};
    } catch(e) {}
  }

  if (!_rng && _global.crypto && crypto.getRandomValues) {
    // WHATWG crypto-based RNG - http://wiki.whatwg.org/wiki/Crypto
    //
    // Moderately fast, high quality
    var _rnds8 = new Uint8Array(16);
    _rng = function whatwgRNG() {
      crypto.getRandomValues(_rnds8);
      return _rnds8;
    };
  }

  if (!_rng) {
    // Math.random()-based (RNG)
    //
    // If all else fails, use Math.random().  It's fast, but is of unspecified
    // quality.
    var  _rnds = new Array(16);
    _rng = function() {
      for (var i = 0, r; i < 16; i++) {
        if ((i & 0x03) === 0) r = Math.random() * 0x100000000;
        _rnds[i] = r >>> ((i & 0x03) << 3) & 0xff;
      }

      return _rnds;
    };
  }

  // Buffer class to use
  var BufferClass = typeof(Buffer) == 'function' ? Buffer : Array;

  // Maps for number <-> hex string conversion
  var _byteToHex = [];
  var _hexToByte = {};
  for (var i = 0; i < 256; i++) {
    _byteToHex[i] = (i + 0x100).toString(16).substr(1);
    _hexToByte[_byteToHex[i]] = i;
  }

  // **`parse()` - Parse a UUID into it's component bytes**
  function parse(s, buf, offset) {
    var i = (buf && offset) || 0, ii = 0;

    buf = buf || [];
    s.toLowerCase().replace(/[0-9a-f]{2}/g, function(oct) {
      if (ii < 16) { // Don't overflow!
        buf[i + ii++] = _hexToByte[oct];
      }
    });

    // Zero out remaining bytes if string was short
    while (ii < 16) {
      buf[i + ii++] = 0;
    }

    return buf;
  }

  // **`unparse()` - Convert UUID byte array (ala parse()) into a string**
  function unparse(buf, offset) {
    var i = offset || 0, bth = _byteToHex;
    return  bth[buf[i++]] + bth[buf[i++]] +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] +
            bth[buf[i++]] + bth[buf[i++]] +
            bth[buf[i++]] + bth[buf[i++]];
  }

  // **`v1()` - Generate time-based UUID**
  //
  // Inspired by https://github.com/LiosK/UUID.js
  // and http://docs.python.org/library/uuid.html

  // random #'s we need to init node and clockseq
  var _seedBytes = _rng();

  // Per 4.5, create and 48-bit node id, (47 random bits + multicast bit = 1)
  var _nodeId = [
    _seedBytes[0] | 0x01,
    _seedBytes[1], _seedBytes[2], _seedBytes[3], _seedBytes[4], _seedBytes[5]
  ];

  // Per 4.2.2, randomize (14 bit) clockseq
  var _clockseq = (_seedBytes[6] << 8 | _seedBytes[7]) & 0x3fff;

  // Previous uuid creation time
  var _lastMSecs = 0, _lastNSecs = 0;

  // See https://github.com/broofa/node-uuid for API details
  function v1(options, buf, offset) {
    var i = buf && offset || 0;
    var b = buf || [];

    options = options || {};

    var clockseq = options.clockseq != null ? options.clockseq : _clockseq;

    // UUID timestamps are 100 nano-second units since the Gregorian epoch,
    // (1582-10-15 00:00).  JSNumbers aren't precise enough for this, so
    // time is handled internally as 'msecs' (integer milliseconds) and 'nsecs'
    // (100-nanoseconds offset from msecs) since unix epoch, 1970-01-01 00:00.
    var msecs = options.msecs != null ? options.msecs : new Date().getTime();

    // Per 4.2.1.2, use count of uuid's generated during the current clock
    // cycle to simulate higher resolution clock
    var nsecs = options.nsecs != null ? options.nsecs : _lastNSecs + 1;

    // Time since last uuid creation (in msecs)
    var dt = (msecs - _lastMSecs) + (nsecs - _lastNSecs)/10000;

    // Per 4.2.1.2, Bump clockseq on clock regression
    if (dt < 0 && options.clockseq == null) {
      clockseq = clockseq + 1 & 0x3fff;
    }

    // Reset nsecs if clock regresses (new clockseq) or we've moved onto a new
    // time interval
    if ((dt < 0 || msecs > _lastMSecs) && options.nsecs == null) {
      nsecs = 0;
    }

    // Per 4.2.1.2 Throw error if too many uuids are requested
    if (nsecs >= 10000) {
      throw new Error('uuid.v1(): Can\'t create more than 10M uuids/sec');
    }

    _lastMSecs = msecs;
    _lastNSecs = nsecs;
    _clockseq = clockseq;

    // Per 4.1.4 - Convert from unix epoch to Gregorian epoch
    msecs += 12219292800000;

    // `time_low`
    var tl = ((msecs & 0xfffffff) * 10000 + nsecs) % 0x100000000;
    b[i++] = tl >>> 24 & 0xff;
    b[i++] = tl >>> 16 & 0xff;
    b[i++] = tl >>> 8 & 0xff;
    b[i++] = tl & 0xff;

    // `time_mid`
    var tmh = (msecs / 0x100000000 * 10000) & 0xfffffff;
    b[i++] = tmh >>> 8 & 0xff;
    b[i++] = tmh & 0xff;

    // `time_high_and_version`
    b[i++] = tmh >>> 24 & 0xf | 0x10; // include version
    b[i++] = tmh >>> 16 & 0xff;

    // `clock_seq_hi_and_reserved` (Per 4.2.2 - include variant)
    b[i++] = clockseq >>> 8 | 0x80;

    // `clock_seq_low`
    b[i++] = clockseq & 0xff;

    // `node`
    var node = options.node || _nodeId;
    for (var n = 0; n < 6; n++) {
      b[i + n] = node[n];
    }

    return buf ? buf : unparse(b);
  }

  // **`v4()` - Generate random UUID**

  // See https://github.com/broofa/node-uuid for API details
  function v4(options, buf, offset) {
    // Deprecated - 'format' argument, as supported in v1.2
    var i = buf && offset || 0;

    if (typeof(options) == 'string') {
      buf = options == 'binary' ? new BufferClass(16) : null;
      options = null;
    }
    options = options || {};

    var rnds = options.random || (options.rng || _rng)();

    // Per 4.4, set bits for version and `clock_seq_hi_and_reserved`
    rnds[6] = (rnds[6] & 0x0f) | 0x40;
    rnds[8] = (rnds[8] & 0x3f) | 0x80;

    // Copy bytes to buffer, if provided
    if (buf) {
      for (var ii = 0; ii < 16; ii++) {
        buf[i + ii] = rnds[ii];
      }
    }

    return buf || unparse(rnds);
  }

  // Export public API
  var uuid = v4;
  uuid.v1 = v1;
  uuid.v4 = v4;
  uuid.parse = parse;
  uuid.unparse = unparse;
  uuid.BufferClass = BufferClass;

  if (typeof define === 'function' && define.amd) {
    // Publish as AMD module
    define(function() {return uuid;});
  } else if (typeof(module) != 'undefined' && module.exports) {
    // Publish as node.js module
    module.exports = uuid;
  } else {
    // Publish as global (in browsers)
    var _previousRoot = _global.uuid;

    // **`noConflict()` - (browser only) to reset global 'uuid' var**
    uuid.noConflict = function() {
      _global.uuid = _previousRoot;
      return uuid;
    };

    _global.uuid = uuid;
  }
}).call(this);

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":147,"crypto":154}],222:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports, module);
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports', 'module'], factory);
  }
}(this, function(exports, module) {

  /**
   * ANONYMOUS `Mechanism` constructor.
   *
   * This class implements the ANONYMOUS SASL mechanism.
   *
   * The ANONYMOUS SASL mechanism provides support for permitting anonymous
   * access to various services
   *
   * References:
   *  - [RFC 4505](http://tools.ietf.org/html/rfc4505)
   *
   * @api public
   */
  function Mechanism() {
  }
  
  Mechanism.prototype.name = 'ANONYMOUS';
  Mechanism.prototype.clientFirst = true;
  
  /**
   * Encode a response using optional trace information.
   *
   * Options:
   *  - `trace`  trace information (optional)
   *
   * @param {Object} cred
   * @api public
   */
  Mechanism.prototype.response = function(cred) {
    return cred.trace || '';
  };
  
  /**
   * Decode a challenge issued by the server.
   *
   * @param {String} chal
   * @api public
   */
  Mechanism.prototype.challenge = function(chal) {
  };

  exports = module.exports = Mechanism;
  
}));

},{}],223:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports,
            module,
            _dereq_('./lib/mechanism'));
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports',
            'module',
            './lib/mechanism'], factory);
  }
}(this, function(exports, module, Mechanism) {

  exports = module.exports = Mechanism;
  exports.Mechanism = Mechanism;
  
}));

},{"./lib/mechanism":222}],224:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports, module);
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports', 'module'], factory);
  }
}(this, function(exports, module) {

  /**
   * EXTERNAL `Mechanism` constructor.
   *
   * This class implements the EXTERNAL SASL mechanism.
   *
   * The EXTERNAL SASL mechanism provides support for authentication using
   * credentials established by external means. 
   *
   * References:
   *  - [RFC 4422](http://tools.ietf.org/html/rfc4422)
   *
   * @api public
   */
  function Mechanism() {
  }
  
  Mechanism.prototype.name = 'EXTERNAL';
  Mechanism.prototype.clientFirst = true;
  
  /**
   * Encode a response using given credential.
   *
   * Options:
   *  - `authzid`   authorization identity (optional)
   *
   * @param {Object} cred
   * @api public
   */
  Mechanism.prototype.response = function(cred) {
    return cred.authzid || '';
  };
  
  /**
   * Decode a challenge issued by the server.
   *
   * @param {String} chal
   * @api public
   */
  Mechanism.prototype.challenge = function(chal) {
  };

  exports = module.exports = Mechanism;
  
}));

},{}],225:[function(_dereq_,module,exports){
arguments[4][223][0].apply(exports,arguments)
},{"./lib/mechanism":224}],226:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports, module);
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports', 'module'], factory);
  }
}(this, function(exports, module) {

  /**
   * PLAIN `Mechanism` constructor.
   *
   * This class implements the PLAIN SASL mechanism.
   *
   * The PLAIN SASL mechanism provides support for exchanging a clear-text
   * username and password.  This mechanism should not be used without adequate
   * security provided by an underlying transport layer. 
   *
   * References:
   *  - [RFC 4616](http://tools.ietf.org/html/rfc4616)
   *
   * @api public
   */
  function Mechanism() {
  }
  
  Mechanism.prototype.name = 'PLAIN';
  Mechanism.prototype.clientFirst = true;
  
  /**
   * Encode a response using given credential.
   *
   * Options:
   *  - `username`
   *  - `password`
   *  - `authzid`   authorization identity (optional)
   *
   * @param {Object} cred
   * @api public
   */
  Mechanism.prototype.response = function(cred) {
    var str = '';
    str += cred.authzid || '';
    str += '\0';
    str += cred.username;
    str += '\0';
    str += cred.password;
    return str;
  };
  
  /**
   * Decode a challenge issued by the server.
   *
   * @param {String} chal
   * @return {Mechanism} for chaining
   * @api public
   */
  Mechanism.prototype.challenge = function(chal) {
    return this;
  };

  exports = module.exports = Mechanism;
  
}));

},{}],227:[function(_dereq_,module,exports){
arguments[4][223][0].apply(exports,arguments)
},{"./lib/mechanism":226}],228:[function(_dereq_,module,exports){
(function (Buffer){
var bitops = _dereq_('./lib/bitops');
var utils = _dereq_('./lib/utils');

var RESP = {};


function Mechanism(options) {
    options = options || {};
    this._genNonce = options.genNonce || utils.genNonce;
    this._stage = 'initial';
}

// Conform to the SASL lib's expectations
Mechanism.Mechanism = Mechanism;


Mechanism.prototype.name = 'SCRAM-SHA-1';
Mechanism.prototype.clientFirst = true;


Mechanism.prototype.response = function (cred) {
    return RESP[this._stage](this, cred);
};

Mechanism.prototype.challenge = function (chal) {
    var values = utils.parse(chal);

    this._salt = new Buffer(values.s || '', 'base64').toString('binary');
    this._iterationCount = parseInt(values.i, 10);
    this._nonce = values.r;
    this._verifier = values.v;
    this._error = values.e;
    this._challenge = chal;

    return this;
};


RESP.initial = function (mech, cred) {
    mech._cnonce = mech._genNonce();

    var authzid = '';
    if (cred.authzid) {
        authzid = 'a=' + utils.saslname(cred.authzid);
    }

    mech._gs2Header = 'n,' + authzid + ',';

    var nonce = 'r=' + mech._cnonce;
    var username = 'n=' + utils.saslname(cred.username);

    mech._clientFirstMessageBare = username + ',' + nonce;
    var result = mech._gs2Header + mech._clientFirstMessageBare;

    mech._stage = 'challenge';

    return result;
};


RESP.challenge = function (mech, cred) {
    var gs2Header = new Buffer(mech._gs2Header).toString('base64');

    mech._clientFinalMessageWithoutProof = 'c=' + gs2Header + ',r=' + mech._nonce;

    var saltedPassword, clientKey, serverKey;
    if (cred.clientKey && cred.serverKey) {
        clientKey = cred.clientKey;
        serverKey = cred.serverKey;
    } else {
        saltedPassword = cred.saltedPassword || bitops.Hi(cred.password, mech._salt, mech._iterationCount);
        clientKey = bitops.HMAC(saltedPassword, 'Client Key');
        serverKey = bitops.HMAC(saltedPassword, 'Server Key');
    }

    var storedKey = bitops.H(clientKey);
    var authMessage = mech._clientFirstMessageBare + ',' +
                      mech._challenge + ',' +
                      mech._clientFinalMessageWithoutProof;
    var clientSignature = bitops.HMAC(storedKey, authMessage);

    var xorstuff = bitops.XOR(clientKey, clientSignature);

    var clientProof = new Buffer(xorstuff, 'binary').toString('base64');

    mech._serverSignature = bitops.HMAC(serverKey, authMessage);

    var result = mech._clientFinalMessageWithoutProof + ',p=' + clientProof;

    mech._stage = 'final';

    mech.cache = {
        saltedPassword: saltedPassword,
        clientKey: clientKey,
        serverKey: serverKey
    };

    return result;
};

RESP.final = function () {
    // TODO: Signal errors
    return '';
};



module.exports = Mechanism;

}).call(this,_dereq_("buffer").Buffer)
},{"./lib/bitops":229,"./lib/utils":230,"buffer":147}],229:[function(_dereq_,module,exports){
(function (Buffer){
var crypto = _dereq_('crypto');
var xor = _dereq_('bitwise-xor');


exports.XOR = xor;

exports.H = function (text) {
    return crypto.createHash('sha1').update(text).digest();
};

exports.HMAC = function (key, msg) {
    return crypto.createHmac('sha1', key).update(msg).digest();
};

exports.Hi = function (text, salt, iterations) {
    var ui1 = exports.HMAC(text, salt + new Buffer([0, 0, 0, 1]).toString('binary'));
    var ui = ui1;
    for (var i = 0; i < iterations - 1; i++) {
        ui1 = exports.HMAC(text, ui1);
        ui = exports.XOR(ui, ui1);
    }

    return ui;
};


}).call(this,_dereq_("buffer").Buffer)
},{"bitwise-xor":231,"buffer":147,"crypto":154}],230:[function(_dereq_,module,exports){
var crypto = _dereq_('crypto');


exports.parse = function (chal) {
    var dtives = {};
    var tokens = chal.split(/,(?=(?:[^"]|"[^"]*")*$)/);
    for (var i = 0, len = tokens.length; i < len; i++) {
        var dtiv = /(\w+)=["]?([^"]+)["]?$/.exec(tokens[i]);
        if (dtiv) {
            dtives[dtiv[1]] = dtiv[2];
        }
    }
    return dtives;
};

exports.saslname = function (name) {
    var escaped = [];
    var curr = '';
    for (var i = 0; i < name.length; i++) {
        curr = name[i];
        if (curr === ',') {
            escaped.push('=2C');
        } else if (curr === '=') {
            escaped.push('=3D');
        } else {
            escaped.push(curr);
        }
    }
    return escaped.join('');
};

exports.genNonce = function (len) {
    return crypto.randomBytes((len || 32) / 2).toString('hex');
};

},{"crypto":154}],231:[function(_dereq_,module,exports){
(function (Buffer){
module.exports = xor

function xor(a, b) {
  if (!Buffer.isBuffer(a)) a = new Buffer(a)
  if (!Buffer.isBuffer(b)) b = new Buffer(b)
  var res = []
  if (a.length > b.length) {
    for (var i = 0; i < b.length; i++) {
      res.push(a[i] ^ b[i])
    }
  } else {
    for (var i = 0; i < a.length; i++) {
      res.push(a[i] ^ b[i])
    }
  }
  return new Buffer(res);
}

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":147}],232:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports, module);
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports', 'module'], factory);
  }
}(this, function(exports, module) {
  
  /**
   * `Factory` constructor.
   *
   * @api public
   */
  function Factory() {
    this._mechs = [];
  }
  
  /**
   * Utilize the given `mech` with optional `name`, overridding the mechanism's
   * default name.
   *
   * Examples:
   *
   *     factory.use(FooMechanism);
   *
   *     factory.use('XFOO', FooMechanism);
   *
   * @param {String|Mechanism} name
   * @param {Mechanism} mech
   * @return {Factory} for chaining
   * @api public
   */
  Factory.prototype.use = function(name, mech) {
    if (!mech) {
      mech = name;
      name = mech.prototype.name;
    }
    this._mechs.push({ name: name, mech: mech });
    return this;
  };
  
  /**
   * Create a new mechanism from supported list of `mechs`.
   *
   * If no mechanisms are supported, returns `null`.
   *
   * Examples:
   *
   *     var mech = factory.create(['FOO', 'BAR']);
   *
   * @param {Array} mechs
   * @return {Mechanism}
   * @api public
   */
  Factory.prototype.create = function(mechs) {
    for (var i = 0, len = this._mechs.length; i < len; i++) {
      for (var j = 0, jlen = mechs.length; j < jlen; j++) {
        var entry = this._mechs[i];
        if (entry.name == mechs[j]) {
          return new entry.mech();
        }
      }
    }
    return null;
  };

  exports = module.exports = Factory;
  
}));

},{}],233:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports,
            module,
            _dereq_('./lib/factory'));
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports',
            'module',
            './lib/factory'], factory);
  }
}(this, function(exports, module, Factory) {
  
  exports = module.exports = Factory;
  exports.Factory = Factory;
  
}));

},{"./lib/factory":232}],234:[function(_dereq_,module,exports){
//     Underscore.js 1.6.0
//     http://underscorejs.org
//     (c) 2009-2014 Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
//     Underscore may be freely distributed under the MIT license.

(function() {

  // Baseline setup
  // --------------

  // Establish the root object, `window` in the browser, or `exports` on the server.
  var root = this;

  // Save the previous value of the `_` variable.
  var previousUnderscore = root._;

  // Establish the object that gets returned to break out of a loop iteration.
  var breaker = {};

  // Save bytes in the minified (but not gzipped) version:
  var ArrayProto = Array.prototype, ObjProto = Object.prototype, FuncProto = Function.prototype;

  // Create quick reference variables for speed access to core prototypes.
  var
    push             = ArrayProto.push,
    slice            = ArrayProto.slice,
    concat           = ArrayProto.concat,
    toString         = ObjProto.toString,
    hasOwnProperty   = ObjProto.hasOwnProperty;

  // All **ECMAScript 5** native function implementations that we hope to use
  // are declared here.
  var
    nativeForEach      = ArrayProto.forEach,
    nativeMap          = ArrayProto.map,
    nativeReduce       = ArrayProto.reduce,
    nativeReduceRight  = ArrayProto.reduceRight,
    nativeFilter       = ArrayProto.filter,
    nativeEvery        = ArrayProto.every,
    nativeSome         = ArrayProto.some,
    nativeIndexOf      = ArrayProto.indexOf,
    nativeLastIndexOf  = ArrayProto.lastIndexOf,
    nativeIsArray      = Array.isArray,
    nativeKeys         = Object.keys,
    nativeBind         = FuncProto.bind;

  // Create a safe reference to the Underscore object for use below.
  var _ = function(obj) {
    if (obj instanceof _) return obj;
    if (!(this instanceof _)) return new _(obj);
    this._wrapped = obj;
  };

  // Export the Underscore object for **Node.js**, with
  // backwards-compatibility for the old `require()` API. If we're in
  // the browser, add `_` as a global object via a string identifier,
  // for Closure Compiler "advanced" mode.
  if (typeof exports !== 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      exports = module.exports = _;
    }
    exports._ = _;
  } else {
    root._ = _;
  }

  // Current version.
  _.VERSION = '1.6.0';

  // Collection Functions
  // --------------------

  // The cornerstone, an `each` implementation, aka `forEach`.
  // Handles objects with the built-in `forEach`, arrays, and raw objects.
  // Delegates to **ECMAScript 5**'s native `forEach` if available.
  var each = _.each = _.forEach = function(obj, iterator, context) {
    if (obj == null) return obj;
    if (nativeForEach && obj.forEach === nativeForEach) {
      obj.forEach(iterator, context);
    } else if (obj.length === +obj.length) {
      for (var i = 0, length = obj.length; i < length; i++) {
        if (iterator.call(context, obj[i], i, obj) === breaker) return;
      }
    } else {
      var keys = _.keys(obj);
      for (var i = 0, length = keys.length; i < length; i++) {
        if (iterator.call(context, obj[keys[i]], keys[i], obj) === breaker) return;
      }
    }
    return obj;
  };

  // Return the results of applying the iterator to each element.
  // Delegates to **ECMAScript 5**'s native `map` if available.
  _.map = _.collect = function(obj, iterator, context) {
    var results = [];
    if (obj == null) return results;
    if (nativeMap && obj.map === nativeMap) return obj.map(iterator, context);
    each(obj, function(value, index, list) {
      results.push(iterator.call(context, value, index, list));
    });
    return results;
  };

  var reduceError = 'Reduce of empty array with no initial value';

  // **Reduce** builds up a single result from a list of values, aka `inject`,
  // or `foldl`. Delegates to **ECMAScript 5**'s native `reduce` if available.
  _.reduce = _.foldl = _.inject = function(obj, iterator, memo, context) {
    var initial = arguments.length > 2;
    if (obj == null) obj = [];
    if (nativeReduce && obj.reduce === nativeReduce) {
      if (context) iterator = _.bind(iterator, context);
      return initial ? obj.reduce(iterator, memo) : obj.reduce(iterator);
    }
    each(obj, function(value, index, list) {
      if (!initial) {
        memo = value;
        initial = true;
      } else {
        memo = iterator.call(context, memo, value, index, list);
      }
    });
    if (!initial) throw new TypeError(reduceError);
    return memo;
  };

  // The right-associative version of reduce, also known as `foldr`.
  // Delegates to **ECMAScript 5**'s native `reduceRight` if available.
  _.reduceRight = _.foldr = function(obj, iterator, memo, context) {
    var initial = arguments.length > 2;
    if (obj == null) obj = [];
    if (nativeReduceRight && obj.reduceRight === nativeReduceRight) {
      if (context) iterator = _.bind(iterator, context);
      return initial ? obj.reduceRight(iterator, memo) : obj.reduceRight(iterator);
    }
    var length = obj.length;
    if (length !== +length) {
      var keys = _.keys(obj);
      length = keys.length;
    }
    each(obj, function(value, index, list) {
      index = keys ? keys[--length] : --length;
      if (!initial) {
        memo = obj[index];
        initial = true;
      } else {
        memo = iterator.call(context, memo, obj[index], index, list);
      }
    });
    if (!initial) throw new TypeError(reduceError);
    return memo;
  };

  // Return the first value which passes a truth test. Aliased as `detect`.
  _.find = _.detect = function(obj, predicate, context) {
    var result;
    any(obj, function(value, index, list) {
      if (predicate.call(context, value, index, list)) {
        result = value;
        return true;
      }
    });
    return result;
  };

  // Return all the elements that pass a truth test.
  // Delegates to **ECMAScript 5**'s native `filter` if available.
  // Aliased as `select`.
  _.filter = _.select = function(obj, predicate, context) {
    var results = [];
    if (obj == null) return results;
    if (nativeFilter && obj.filter === nativeFilter) return obj.filter(predicate, context);
    each(obj, function(value, index, list) {
      if (predicate.call(context, value, index, list)) results.push(value);
    });
    return results;
  };

  // Return all the elements for which a truth test fails.
  _.reject = function(obj, predicate, context) {
    return _.filter(obj, function(value, index, list) {
      return !predicate.call(context, value, index, list);
    }, context);
  };

  // Determine whether all of the elements match a truth test.
  // Delegates to **ECMAScript 5**'s native `every` if available.
  // Aliased as `all`.
  _.every = _.all = function(obj, predicate, context) {
    predicate || (predicate = _.identity);
    var result = true;
    if (obj == null) return result;
    if (nativeEvery && obj.every === nativeEvery) return obj.every(predicate, context);
    each(obj, function(value, index, list) {
      if (!(result = result && predicate.call(context, value, index, list))) return breaker;
    });
    return !!result;
  };

  // Determine if at least one element in the object matches a truth test.
  // Delegates to **ECMAScript 5**'s native `some` if available.
  // Aliased as `any`.
  var any = _.some = _.any = function(obj, predicate, context) {
    predicate || (predicate = _.identity);
    var result = false;
    if (obj == null) return result;
    if (nativeSome && obj.some === nativeSome) return obj.some(predicate, context);
    each(obj, function(value, index, list) {
      if (result || (result = predicate.call(context, value, index, list))) return breaker;
    });
    return !!result;
  };

  // Determine if the array or object contains a given value (using `===`).
  // Aliased as `include`.
  _.contains = _.include = function(obj, target) {
    if (obj == null) return false;
    if (nativeIndexOf && obj.indexOf === nativeIndexOf) return obj.indexOf(target) != -1;
    return any(obj, function(value) {
      return value === target;
    });
  };

  // Invoke a method (with arguments) on every item in a collection.
  _.invoke = function(obj, method) {
    var args = slice.call(arguments, 2);
    var isFunc = _.isFunction(method);
    return _.map(obj, function(value) {
      return (isFunc ? method : value[method]).apply(value, args);
    });
  };

  // Convenience version of a common use case of `map`: fetching a property.
  _.pluck = function(obj, key) {
    return _.map(obj, _.property(key));
  };

  // Convenience version of a common use case of `filter`: selecting only objects
  // containing specific `key:value` pairs.
  _.where = function(obj, attrs) {
    return _.filter(obj, _.matches(attrs));
  };

  // Convenience version of a common use case of `find`: getting the first object
  // containing specific `key:value` pairs.
  _.findWhere = function(obj, attrs) {
    return _.find(obj, _.matches(attrs));
  };

  // Return the maximum element or (element-based computation).
  // Can't optimize arrays of integers longer than 65,535 elements.
  // See [WebKit Bug 80797](https://bugs.webkit.org/show_bug.cgi?id=80797)
  _.max = function(obj, iterator, context) {
    if (!iterator && _.isArray(obj) && obj[0] === +obj[0] && obj.length < 65535) {
      return Math.max.apply(Math, obj);
    }
    var result = -Infinity, lastComputed = -Infinity;
    each(obj, function(value, index, list) {
      var computed = iterator ? iterator.call(context, value, index, list) : value;
      if (computed > lastComputed) {
        result = value;
        lastComputed = computed;
      }
    });
    return result;
  };

  // Return the minimum element (or element-based computation).
  _.min = function(obj, iterator, context) {
    if (!iterator && _.isArray(obj) && obj[0] === +obj[0] && obj.length < 65535) {
      return Math.min.apply(Math, obj);
    }
    var result = Infinity, lastComputed = Infinity;
    each(obj, function(value, index, list) {
      var computed = iterator ? iterator.call(context, value, index, list) : value;
      if (computed < lastComputed) {
        result = value;
        lastComputed = computed;
      }
    });
    return result;
  };

  // Shuffle an array, using the modern version of the
  // [Fisher-Yates shuffle](http://en.wikipedia.org/wiki/Fisher–Yates_shuffle).
  _.shuffle = function(obj) {
    var rand;
    var index = 0;
    var shuffled = [];
    each(obj, function(value) {
      rand = _.random(index++);
      shuffled[index - 1] = shuffled[rand];
      shuffled[rand] = value;
    });
    return shuffled;
  };

  // Sample **n** random values from a collection.
  // If **n** is not specified, returns a single random element.
  // The internal `guard` argument allows it to work with `map`.
  _.sample = function(obj, n, guard) {
    if (n == null || guard) {
      if (obj.length !== +obj.length) obj = _.values(obj);
      return obj[_.random(obj.length - 1)];
    }
    return _.shuffle(obj).slice(0, Math.max(0, n));
  };

  // An internal function to generate lookup iterators.
  var lookupIterator = function(value) {
    if (value == null) return _.identity;
    if (_.isFunction(value)) return value;
    return _.property(value);
  };

  // Sort the object's values by a criterion produced by an iterator.
  _.sortBy = function(obj, iterator, context) {
    iterator = lookupIterator(iterator);
    return _.pluck(_.map(obj, function(value, index, list) {
      return {
        value: value,
        index: index,
        criteria: iterator.call(context, value, index, list)
      };
    }).sort(function(left, right) {
      var a = left.criteria;
      var b = right.criteria;
      if (a !== b) {
        if (a > b || a === void 0) return 1;
        if (a < b || b === void 0) return -1;
      }
      return left.index - right.index;
    }), 'value');
  };

  // An internal function used for aggregate "group by" operations.
  var group = function(behavior) {
    return function(obj, iterator, context) {
      var result = {};
      iterator = lookupIterator(iterator);
      each(obj, function(value, index) {
        var key = iterator.call(context, value, index, obj);
        behavior(result, key, value);
      });
      return result;
    };
  };

  // Groups the object's values by a criterion. Pass either a string attribute
  // to group by, or a function that returns the criterion.
  _.groupBy = group(function(result, key, value) {
    _.has(result, key) ? result[key].push(value) : result[key] = [value];
  });

  // Indexes the object's values by a criterion, similar to `groupBy`, but for
  // when you know that your index values will be unique.
  _.indexBy = group(function(result, key, value) {
    result[key] = value;
  });

  // Counts instances of an object that group by a certain criterion. Pass
  // either a string attribute to count by, or a function that returns the
  // criterion.
  _.countBy = group(function(result, key) {
    _.has(result, key) ? result[key]++ : result[key] = 1;
  });

  // Use a comparator function to figure out the smallest index at which
  // an object should be inserted so as to maintain order. Uses binary search.
  _.sortedIndex = function(array, obj, iterator, context) {
    iterator = lookupIterator(iterator);
    var value = iterator.call(context, obj);
    var low = 0, high = array.length;
    while (low < high) {
      var mid = (low + high) >>> 1;
      iterator.call(context, array[mid]) < value ? low = mid + 1 : high = mid;
    }
    return low;
  };

  // Safely create a real, live array from anything iterable.
  _.toArray = function(obj) {
    if (!obj) return [];
    if (_.isArray(obj)) return slice.call(obj);
    if (obj.length === +obj.length) return _.map(obj, _.identity);
    return _.values(obj);
  };

  // Return the number of elements in an object.
  _.size = function(obj) {
    if (obj == null) return 0;
    return (obj.length === +obj.length) ? obj.length : _.keys(obj).length;
  };

  // Array Functions
  // ---------------

  // Get the first element of an array. Passing **n** will return the first N
  // values in the array. Aliased as `head` and `take`. The **guard** check
  // allows it to work with `_.map`.
  _.first = _.head = _.take = function(array, n, guard) {
    if (array == null) return void 0;
    if ((n == null) || guard) return array[0];
    if (n < 0) return [];
    return slice.call(array, 0, n);
  };

  // Returns everything but the last entry of the array. Especially useful on
  // the arguments object. Passing **n** will return all the values in
  // the array, excluding the last N. The **guard** check allows it to work with
  // `_.map`.
  _.initial = function(array, n, guard) {
    return slice.call(array, 0, array.length - ((n == null) || guard ? 1 : n));
  };

  // Get the last element of an array. Passing **n** will return the last N
  // values in the array. The **guard** check allows it to work with `_.map`.
  _.last = function(array, n, guard) {
    if (array == null) return void 0;
    if ((n == null) || guard) return array[array.length - 1];
    return slice.call(array, Math.max(array.length - n, 0));
  };

  // Returns everything but the first entry of the array. Aliased as `tail` and `drop`.
  // Especially useful on the arguments object. Passing an **n** will return
  // the rest N values in the array. The **guard**
  // check allows it to work with `_.map`.
  _.rest = _.tail = _.drop = function(array, n, guard) {
    return slice.call(array, (n == null) || guard ? 1 : n);
  };

  // Trim out all falsy values from an array.
  _.compact = function(array) {
    return _.filter(array, _.identity);
  };

  // Internal implementation of a recursive `flatten` function.
  var flatten = function(input, shallow, output) {
    if (shallow && _.every(input, _.isArray)) {
      return concat.apply(output, input);
    }
    each(input, function(value) {
      if (_.isArray(value) || _.isArguments(value)) {
        shallow ? push.apply(output, value) : flatten(value, shallow, output);
      } else {
        output.push(value);
      }
    });
    return output;
  };

  // Flatten out an array, either recursively (by default), or just one level.
  _.flatten = function(array, shallow) {
    return flatten(array, shallow, []);
  };

  // Return a version of the array that does not contain the specified value(s).
  _.without = function(array) {
    return _.difference(array, slice.call(arguments, 1));
  };

  // Split an array into two arrays: one whose elements all satisfy the given
  // predicate, and one whose elements all do not satisfy the predicate.
  _.partition = function(array, predicate) {
    var pass = [], fail = [];
    each(array, function(elem) {
      (predicate(elem) ? pass : fail).push(elem);
    });
    return [pass, fail];
  };

  // Produce a duplicate-free version of the array. If the array has already
  // been sorted, you have the option of using a faster algorithm.
  // Aliased as `unique`.
  _.uniq = _.unique = function(array, isSorted, iterator, context) {
    if (_.isFunction(isSorted)) {
      context = iterator;
      iterator = isSorted;
      isSorted = false;
    }
    var initial = iterator ? _.map(array, iterator, context) : array;
    var results = [];
    var seen = [];
    each(initial, function(value, index) {
      if (isSorted ? (!index || seen[seen.length - 1] !== value) : !_.contains(seen, value)) {
        seen.push(value);
        results.push(array[index]);
      }
    });
    return results;
  };

  // Produce an array that contains the union: each distinct element from all of
  // the passed-in arrays.
  _.union = function() {
    return _.uniq(_.flatten(arguments, true));
  };

  // Produce an array that contains every item shared between all the
  // passed-in arrays.
  _.intersection = function(array) {
    var rest = slice.call(arguments, 1);
    return _.filter(_.uniq(array), function(item) {
      return _.every(rest, function(other) {
        return _.contains(other, item);
      });
    });
  };

  // Take the difference between one array and a number of other arrays.
  // Only the elements present in just the first array will remain.
  _.difference = function(array) {
    var rest = concat.apply(ArrayProto, slice.call(arguments, 1));
    return _.filter(array, function(value){ return !_.contains(rest, value); });
  };

  // Zip together multiple lists into a single array -- elements that share
  // an index go together.
  _.zip = function() {
    var length = _.max(_.pluck(arguments, 'length').concat(0));
    var results = new Array(length);
    for (var i = 0; i < length; i++) {
      results[i] = _.pluck(arguments, '' + i);
    }
    return results;
  };

  // Converts lists into objects. Pass either a single array of `[key, value]`
  // pairs, or two parallel arrays of the same length -- one of keys, and one of
  // the corresponding values.
  _.object = function(list, values) {
    if (list == null) return {};
    var result = {};
    for (var i = 0, length = list.length; i < length; i++) {
      if (values) {
        result[list[i]] = values[i];
      } else {
        result[list[i][0]] = list[i][1];
      }
    }
    return result;
  };

  // If the browser doesn't supply us with indexOf (I'm looking at you, **MSIE**),
  // we need this function. Return the position of the first occurrence of an
  // item in an array, or -1 if the item is not included in the array.
  // Delegates to **ECMAScript 5**'s native `indexOf` if available.
  // If the array is large and already in sort order, pass `true`
  // for **isSorted** to use binary search.
  _.indexOf = function(array, item, isSorted) {
    if (array == null) return -1;
    var i = 0, length = array.length;
    if (isSorted) {
      if (typeof isSorted == 'number') {
        i = (isSorted < 0 ? Math.max(0, length + isSorted) : isSorted);
      } else {
        i = _.sortedIndex(array, item);
        return array[i] === item ? i : -1;
      }
    }
    if (nativeIndexOf && array.indexOf === nativeIndexOf) return array.indexOf(item, isSorted);
    for (; i < length; i++) if (array[i] === item) return i;
    return -1;
  };

  // Delegates to **ECMAScript 5**'s native `lastIndexOf` if available.
  _.lastIndexOf = function(array, item, from) {
    if (array == null) return -1;
    var hasIndex = from != null;
    if (nativeLastIndexOf && array.lastIndexOf === nativeLastIndexOf) {
      return hasIndex ? array.lastIndexOf(item, from) : array.lastIndexOf(item);
    }
    var i = (hasIndex ? from : array.length);
    while (i--) if (array[i] === item) return i;
    return -1;
  };

  // Generate an integer Array containing an arithmetic progression. A port of
  // the native Python `range()` function. See
  // [the Python documentation](http://docs.python.org/library/functions.html#range).
  _.range = function(start, stop, step) {
    if (arguments.length <= 1) {
      stop = start || 0;
      start = 0;
    }
    step = arguments[2] || 1;

    var length = Math.max(Math.ceil((stop - start) / step), 0);
    var idx = 0;
    var range = new Array(length);

    while(idx < length) {
      range[idx++] = start;
      start += step;
    }

    return range;
  };

  // Function (ahem) Functions
  // ------------------

  // Reusable constructor function for prototype setting.
  var ctor = function(){};

  // Create a function bound to a given object (assigning `this`, and arguments,
  // optionally). Delegates to **ECMAScript 5**'s native `Function.bind` if
  // available.
  _.bind = function(func, context) {
    var args, bound;
    if (nativeBind && func.bind === nativeBind) return nativeBind.apply(func, slice.call(arguments, 1));
    if (!_.isFunction(func)) throw new TypeError;
    args = slice.call(arguments, 2);
    return bound = function() {
      if (!(this instanceof bound)) return func.apply(context, args.concat(slice.call(arguments)));
      ctor.prototype = func.prototype;
      var self = new ctor;
      ctor.prototype = null;
      var result = func.apply(self, args.concat(slice.call(arguments)));
      if (Object(result) === result) return result;
      return self;
    };
  };

  // Partially apply a function by creating a version that has had some of its
  // arguments pre-filled, without changing its dynamic `this` context. _ acts
  // as a placeholder, allowing any combination of arguments to be pre-filled.
  _.partial = function(func) {
    var boundArgs = slice.call(arguments, 1);
    return function() {
      var position = 0;
      var args = boundArgs.slice();
      for (var i = 0, length = args.length; i < length; i++) {
        if (args[i] === _) args[i] = arguments[position++];
      }
      while (position < arguments.length) args.push(arguments[position++]);
      return func.apply(this, args);
    };
  };

  // Bind a number of an object's methods to that object. Remaining arguments
  // are the method names to be bound. Useful for ensuring that all callbacks
  // defined on an object belong to it.
  _.bindAll = function(obj) {
    var funcs = slice.call(arguments, 1);
    if (funcs.length === 0) throw new Error('bindAll must be passed function names');
    each(funcs, function(f) { obj[f] = _.bind(obj[f], obj); });
    return obj;
  };

  // Memoize an expensive function by storing its results.
  _.memoize = function(func, hasher) {
    var memo = {};
    hasher || (hasher = _.identity);
    return function() {
      var key = hasher.apply(this, arguments);
      return _.has(memo, key) ? memo[key] : (memo[key] = func.apply(this, arguments));
    };
  };

  // Delays a function for the given number of milliseconds, and then calls
  // it with the arguments supplied.
  _.delay = function(func, wait) {
    var args = slice.call(arguments, 2);
    return setTimeout(function(){ return func.apply(null, args); }, wait);
  };

  // Defers a function, scheduling it to run after the current call stack has
  // cleared.
  _.defer = function(func) {
    return _.delay.apply(_, [func, 1].concat(slice.call(arguments, 1)));
  };

  // Returns a function, that, when invoked, will only be triggered at most once
  // during a given window of time. Normally, the throttled function will run
  // as much as it can, without ever going more than once per `wait` duration;
  // but if you'd like to disable the execution on the leading edge, pass
  // `{leading: false}`. To disable execution on the trailing edge, ditto.
  _.throttle = function(func, wait, options) {
    var context, args, result;
    var timeout = null;
    var previous = 0;
    options || (options = {});
    var later = function() {
      previous = options.leading === false ? 0 : _.now();
      timeout = null;
      result = func.apply(context, args);
      context = args = null;
    };
    return function() {
      var now = _.now();
      if (!previous && options.leading === false) previous = now;
      var remaining = wait - (now - previous);
      context = this;
      args = arguments;
      if (remaining <= 0) {
        clearTimeout(timeout);
        timeout = null;
        previous = now;
        result = func.apply(context, args);
        context = args = null;
      } else if (!timeout && options.trailing !== false) {
        timeout = setTimeout(later, remaining);
      }
      return result;
    };
  };

  // Returns a function, that, as long as it continues to be invoked, will not
  // be triggered. The function will be called after it stops being called for
  // N milliseconds. If `immediate` is passed, trigger the function on the
  // leading edge, instead of the trailing.
  _.debounce = function(func, wait, immediate) {
    var timeout, args, context, timestamp, result;

    var later = function() {
      var last = _.now() - timestamp;
      if (last < wait) {
        timeout = setTimeout(later, wait - last);
      } else {
        timeout = null;
        if (!immediate) {
          result = func.apply(context, args);
          context = args = null;
        }
      }
    };

    return function() {
      context = this;
      args = arguments;
      timestamp = _.now();
      var callNow = immediate && !timeout;
      if (!timeout) {
        timeout = setTimeout(later, wait);
      }
      if (callNow) {
        result = func.apply(context, args);
        context = args = null;
      }

      return result;
    };
  };

  // Returns a function that will be executed at most one time, no matter how
  // often you call it. Useful for lazy initialization.
  _.once = function(func) {
    var ran = false, memo;
    return function() {
      if (ran) return memo;
      ran = true;
      memo = func.apply(this, arguments);
      func = null;
      return memo;
    };
  };

  // Returns the first function passed as an argument to the second,
  // allowing you to adjust arguments, run code before and after, and
  // conditionally execute the original function.
  _.wrap = function(func, wrapper) {
    return _.partial(wrapper, func);
  };

  // Returns a function that is the composition of a list of functions, each
  // consuming the return value of the function that follows.
  _.compose = function() {
    var funcs = arguments;
    return function() {
      var args = arguments;
      for (var i = funcs.length - 1; i >= 0; i--) {
        args = [funcs[i].apply(this, args)];
      }
      return args[0];
    };
  };

  // Returns a function that will only be executed after being called N times.
  _.after = function(times, func) {
    return function() {
      if (--times < 1) {
        return func.apply(this, arguments);
      }
    };
  };

  // Object Functions
  // ----------------

  // Retrieve the names of an object's properties.
  // Delegates to **ECMAScript 5**'s native `Object.keys`
  _.keys = function(obj) {
    if (!_.isObject(obj)) return [];
    if (nativeKeys) return nativeKeys(obj);
    var keys = [];
    for (var key in obj) if (_.has(obj, key)) keys.push(key);
    return keys;
  };

  // Retrieve the values of an object's properties.
  _.values = function(obj) {
    var keys = _.keys(obj);
    var length = keys.length;
    var values = new Array(length);
    for (var i = 0; i < length; i++) {
      values[i] = obj[keys[i]];
    }
    return values;
  };

  // Convert an object into a list of `[key, value]` pairs.
  _.pairs = function(obj) {
    var keys = _.keys(obj);
    var length = keys.length;
    var pairs = new Array(length);
    for (var i = 0; i < length; i++) {
      pairs[i] = [keys[i], obj[keys[i]]];
    }
    return pairs;
  };

  // Invert the keys and values of an object. The values must be serializable.
  _.invert = function(obj) {
    var result = {};
    var keys = _.keys(obj);
    for (var i = 0, length = keys.length; i < length; i++) {
      result[obj[keys[i]]] = keys[i];
    }
    return result;
  };

  // Return a sorted list of the function names available on the object.
  // Aliased as `methods`
  _.functions = _.methods = function(obj) {
    var names = [];
    for (var key in obj) {
      if (_.isFunction(obj[key])) names.push(key);
    }
    return names.sort();
  };

  // Extend a given object with all the properties in passed-in object(s).
  _.extend = function(obj) {
    each(slice.call(arguments, 1), function(source) {
      if (source) {
        for (var prop in source) {
          obj[prop] = source[prop];
        }
      }
    });
    return obj;
  };

  // Return a copy of the object only containing the whitelisted properties.
  _.pick = function(obj) {
    var copy = {};
    var keys = concat.apply(ArrayProto, slice.call(arguments, 1));
    each(keys, function(key) {
      if (key in obj) copy[key] = obj[key];
    });
    return copy;
  };

   // Return a copy of the object without the blacklisted properties.
  _.omit = function(obj) {
    var copy = {};
    var keys = concat.apply(ArrayProto, slice.call(arguments, 1));
    for (var key in obj) {
      if (!_.contains(keys, key)) copy[key] = obj[key];
    }
    return copy;
  };

  // Fill in a given object with default properties.
  _.defaults = function(obj) {
    each(slice.call(arguments, 1), function(source) {
      if (source) {
        for (var prop in source) {
          if (obj[prop] === void 0) obj[prop] = source[prop];
        }
      }
    });
    return obj;
  };

  // Create a (shallow-cloned) duplicate of an object.
  _.clone = function(obj) {
    if (!_.isObject(obj)) return obj;
    return _.isArray(obj) ? obj.slice() : _.extend({}, obj);
  };

  // Invokes interceptor with the obj, and then returns obj.
  // The primary purpose of this method is to "tap into" a method chain, in
  // order to perform operations on intermediate results within the chain.
  _.tap = function(obj, interceptor) {
    interceptor(obj);
    return obj;
  };

  // Internal recursive comparison function for `isEqual`.
  var eq = function(a, b, aStack, bStack) {
    // Identical objects are equal. `0 === -0`, but they aren't identical.
    // See the [Harmony `egal` proposal](http://wiki.ecmascript.org/doku.php?id=harmony:egal).
    if (a === b) return a !== 0 || 1 / a == 1 / b;
    // A strict comparison is necessary because `null == undefined`.
    if (a == null || b == null) return a === b;
    // Unwrap any wrapped objects.
    if (a instanceof _) a = a._wrapped;
    if (b instanceof _) b = b._wrapped;
    // Compare `[[Class]]` names.
    var className = toString.call(a);
    if (className != toString.call(b)) return false;
    switch (className) {
      // Strings, numbers, dates, and booleans are compared by value.
      case '[object String]':
        // Primitives and their corresponding object wrappers are equivalent; thus, `"5"` is
        // equivalent to `new String("5")`.
        return a == String(b);
      case '[object Number]':
        // `NaN`s are equivalent, but non-reflexive. An `egal` comparison is performed for
        // other numeric values.
        return a != +a ? b != +b : (a == 0 ? 1 / a == 1 / b : a == +b);
      case '[object Date]':
      case '[object Boolean]':
        // Coerce dates and booleans to numeric primitive values. Dates are compared by their
        // millisecond representations. Note that invalid dates with millisecond representations
        // of `NaN` are not equivalent.
        return +a == +b;
      // RegExps are compared by their source patterns and flags.
      case '[object RegExp]':
        return a.source == b.source &&
               a.global == b.global &&
               a.multiline == b.multiline &&
               a.ignoreCase == b.ignoreCase;
    }
    if (typeof a != 'object' || typeof b != 'object') return false;
    // Assume equality for cyclic structures. The algorithm for detecting cyclic
    // structures is adapted from ES 5.1 section 15.12.3, abstract operation `JO`.
    var length = aStack.length;
    while (length--) {
      // Linear search. Performance is inversely proportional to the number of
      // unique nested structures.
      if (aStack[length] == a) return bStack[length] == b;
    }
    // Objects with different constructors are not equivalent, but `Object`s
    // from different frames are.
    var aCtor = a.constructor, bCtor = b.constructor;
    if (aCtor !== bCtor && !(_.isFunction(aCtor) && (aCtor instanceof aCtor) &&
                             _.isFunction(bCtor) && (bCtor instanceof bCtor))
                        && ('constructor' in a && 'constructor' in b)) {
      return false;
    }
    // Add the first object to the stack of traversed objects.
    aStack.push(a);
    bStack.push(b);
    var size = 0, result = true;
    // Recursively compare objects and arrays.
    if (className == '[object Array]') {
      // Compare array lengths to determine if a deep comparison is necessary.
      size = a.length;
      result = size == b.length;
      if (result) {
        // Deep compare the contents, ignoring non-numeric properties.
        while (size--) {
          if (!(result = eq(a[size], b[size], aStack, bStack))) break;
        }
      }
    } else {
      // Deep compare objects.
      for (var key in a) {
        if (_.has(a, key)) {
          // Count the expected number of properties.
          size++;
          // Deep compare each member.
          if (!(result = _.has(b, key) && eq(a[key], b[key], aStack, bStack))) break;
        }
      }
      // Ensure that both objects contain the same number of properties.
      if (result) {
        for (key in b) {
          if (_.has(b, key) && !(size--)) break;
        }
        result = !size;
      }
    }
    // Remove the first object from the stack of traversed objects.
    aStack.pop();
    bStack.pop();
    return result;
  };

  // Perform a deep comparison to check if two objects are equal.
  _.isEqual = function(a, b) {
    return eq(a, b, [], []);
  };

  // Is a given array, string, or object empty?
  // An "empty" object has no enumerable own-properties.
  _.isEmpty = function(obj) {
    if (obj == null) return true;
    if (_.isArray(obj) || _.isString(obj)) return obj.length === 0;
    for (var key in obj) if (_.has(obj, key)) return false;
    return true;
  };

  // Is a given value a DOM element?
  _.isElement = function(obj) {
    return !!(obj && obj.nodeType === 1);
  };

  // Is a given value an array?
  // Delegates to ECMA5's native Array.isArray
  _.isArray = nativeIsArray || function(obj) {
    return toString.call(obj) == '[object Array]';
  };

  // Is a given variable an object?
  _.isObject = function(obj) {
    return obj === Object(obj);
  };

  // Add some isType methods: isArguments, isFunction, isString, isNumber, isDate, isRegExp.
  each(['Arguments', 'Function', 'String', 'Number', 'Date', 'RegExp'], function(name) {
    _['is' + name] = function(obj) {
      return toString.call(obj) == '[object ' + name + ']';
    };
  });

  // Define a fallback version of the method in browsers (ahem, IE), where
  // there isn't any inspectable "Arguments" type.
  if (!_.isArguments(arguments)) {
    _.isArguments = function(obj) {
      return !!(obj && _.has(obj, 'callee'));
    };
  }

  // Optimize `isFunction` if appropriate.
  if (typeof (/./) !== 'function') {
    _.isFunction = function(obj) {
      return typeof obj === 'function';
    };
  }

  // Is a given object a finite number?
  _.isFinite = function(obj) {
    return isFinite(obj) && !isNaN(parseFloat(obj));
  };

  // Is the given value `NaN`? (NaN is the only number which does not equal itself).
  _.isNaN = function(obj) {
    return _.isNumber(obj) && obj != +obj;
  };

  // Is a given value a boolean?
  _.isBoolean = function(obj) {
    return obj === true || obj === false || toString.call(obj) == '[object Boolean]';
  };

  // Is a given value equal to null?
  _.isNull = function(obj) {
    return obj === null;
  };

  // Is a given variable undefined?
  _.isUndefined = function(obj) {
    return obj === void 0;
  };

  // Shortcut function for checking if an object has a given property directly
  // on itself (in other words, not on a prototype).
  _.has = function(obj, key) {
    return hasOwnProperty.call(obj, key);
  };

  // Utility Functions
  // -----------------

  // Run Underscore.js in *noConflict* mode, returning the `_` variable to its
  // previous owner. Returns a reference to the Underscore object.
  _.noConflict = function() {
    root._ = previousUnderscore;
    return this;
  };

  // Keep the identity function around for default iterators.
  _.identity = function(value) {
    return value;
  };

  _.constant = function(value) {
    return function () {
      return value;
    };
  };

  _.property = function(key) {
    return function(obj) {
      return obj[key];
    };
  };

  // Returns a predicate for checking whether an object has a given set of `key:value` pairs.
  _.matches = function(attrs) {
    return function(obj) {
      if (obj === attrs) return true; //avoid comparing an object to itself.
      for (var key in attrs) {
        if (attrs[key] !== obj[key])
          return false;
      }
      return true;
    }
  };

  // Run a function **n** times.
  _.times = function(n, iterator, context) {
    var accum = Array(Math.max(0, n));
    for (var i = 0; i < n; i++) accum[i] = iterator.call(context, i);
    return accum;
  };

  // Return a random integer between min and max (inclusive).
  _.random = function(min, max) {
    if (max == null) {
      max = min;
      min = 0;
    }
    return min + Math.floor(Math.random() * (max - min + 1));
  };

  // A (possibly faster) way to get the current timestamp as an integer.
  _.now = Date.now || function() { return new Date().getTime(); };

  // List of HTML entities for escaping.
  var entityMap = {
    escape: {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;'
    }
  };
  entityMap.unescape = _.invert(entityMap.escape);

  // Regexes containing the keys and values listed immediately above.
  var entityRegexes = {
    escape:   new RegExp('[' + _.keys(entityMap.escape).join('') + ']', 'g'),
    unescape: new RegExp('(' + _.keys(entityMap.unescape).join('|') + ')', 'g')
  };

  // Functions for escaping and unescaping strings to/from HTML interpolation.
  _.each(['escape', 'unescape'], function(method) {
    _[method] = function(string) {
      if (string == null) return '';
      return ('' + string).replace(entityRegexes[method], function(match) {
        return entityMap[method][match];
      });
    };
  });

  // If the value of the named `property` is a function then invoke it with the
  // `object` as context; otherwise, return it.
  _.result = function(object, property) {
    if (object == null) return void 0;
    var value = object[property];
    return _.isFunction(value) ? value.call(object) : value;
  };

  // Add your own custom functions to the Underscore object.
  _.mixin = function(obj) {
    each(_.functions(obj), function(name) {
      var func = _[name] = obj[name];
      _.prototype[name] = function() {
        var args = [this._wrapped];
        push.apply(args, arguments);
        return result.call(this, func.apply(_, args));
      };
    });
  };

  // Generate a unique integer id (unique within the entire client session).
  // Useful for temporary DOM ids.
  var idCounter = 0;
  _.uniqueId = function(prefix) {
    var id = ++idCounter + '';
    return prefix ? prefix + id : id;
  };

  // By default, Underscore uses ERB-style template delimiters, change the
  // following template settings to use alternative delimiters.
  _.templateSettings = {
    evaluate    : /<%([\s\S]+?)%>/g,
    interpolate : /<%=([\s\S]+?)%>/g,
    escape      : /<%-([\s\S]+?)%>/g
  };

  // When customizing `templateSettings`, if you don't want to define an
  // interpolation, evaluation or escaping regex, we need one that is
  // guaranteed not to match.
  var noMatch = /(.)^/;

  // Certain characters need to be escaped so that they can be put into a
  // string literal.
  var escapes = {
    "'":      "'",
    '\\':     '\\',
    '\r':     'r',
    '\n':     'n',
    '\t':     't',
    '\u2028': 'u2028',
    '\u2029': 'u2029'
  };

  var escaper = /\\|'|\r|\n|\t|\u2028|\u2029/g;

  // JavaScript micro-templating, similar to John Resig's implementation.
  // Underscore templating handles arbitrary delimiters, preserves whitespace,
  // and correctly escapes quotes within interpolated code.
  _.template = function(text, data, settings) {
    var render;
    settings = _.defaults({}, settings, _.templateSettings);

    // Combine delimiters into one regular expression via alternation.
    var matcher = new RegExp([
      (settings.escape || noMatch).source,
      (settings.interpolate || noMatch).source,
      (settings.evaluate || noMatch).source
    ].join('|') + '|$', 'g');

    // Compile the template source, escaping string literals appropriately.
    var index = 0;
    var source = "__p+='";
    text.replace(matcher, function(match, escape, interpolate, evaluate, offset) {
      source += text.slice(index, offset)
        .replace(escaper, function(match) { return '\\' + escapes[match]; });

      if (escape) {
        source += "'+\n((__t=(" + escape + "))==null?'':_.escape(__t))+\n'";
      }
      if (interpolate) {
        source += "'+\n((__t=(" + interpolate + "))==null?'':__t)+\n'";
      }
      if (evaluate) {
        source += "';\n" + evaluate + "\n__p+='";
      }
      index = offset + match.length;
      return match;
    });
    source += "';\n";

    // If a variable is not specified, place data values in local scope.
    if (!settings.variable) source = 'with(obj||{}){\n' + source + '}\n';

    source = "var __t,__p='',__j=Array.prototype.join," +
      "print=function(){__p+=__j.call(arguments,'');};\n" +
      source + "return __p;\n";

    try {
      render = new Function(settings.variable || 'obj', '_', source);
    } catch (e) {
      e.source = source;
      throw e;
    }

    if (data) return render(data, _);
    var template = function(data) {
      return render.call(this, data, _);
    };

    // Provide the compiled function source as a convenience for precompilation.
    template.source = 'function(' + (settings.variable || 'obj') + '){\n' + source + '}';

    return template;
  };

  // Add a "chain" function, which will delegate to the wrapper.
  _.chain = function(obj) {
    return _(obj).chain();
  };

  // OOP
  // ---------------
  // If Underscore is called as a function, it returns a wrapped object that
  // can be used OO-style. This wrapper holds altered versions of all the
  // underscore functions. Wrapped objects may be chained.

  // Helper function to continue chaining intermediate results.
  var result = function(obj) {
    return this._chain ? _(obj).chain() : obj;
  };

  // Add all of the Underscore functions to the wrapper object.
  _.mixin(_);

  // Add all mutator Array functions to the wrapper.
  each(['pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'], function(name) {
    var method = ArrayProto[name];
    _.prototype[name] = function() {
      var obj = this._wrapped;
      method.apply(obj, arguments);
      if ((name == 'shift' || name == 'splice') && obj.length === 0) delete obj[0];
      return result.call(this, obj);
    };
  });

  // Add all accessor Array functions to the wrapper.
  each(['concat', 'join', 'slice'], function(name) {
    var method = ArrayProto[name];
    _.prototype[name] = function() {
      return result.call(this, method.apply(this._wrapped, arguments));
    };
  });

  _.extend(_.prototype, {

    // Start chaining a wrapped Underscore object.
    chain: function() {
      this._chain = true;
      return this;
    },

    // Extracts the result from a wrapped and chained object.
    value: function() {
      return this._wrapped;
    }

  });

  // AMD registration happens at the end for compatibility with AMD loaders
  // that may not enforce next-turn semantics on modules. Even though general
  // practice for AMD registration is to be anonymous, underscore registers
  // as a named module because, like jQuery, it is a base library that is
  // popular enough to be bundled in a third party lib, but not be part of
  // an AMD load request. Those cases could generate an error when an
  // anonymous define() is called outside of a loader request.
  if (typeof define === 'function' && define.amd) {
    define('underscore', [], function() {
      return _;
    });
  }
}).call(this);

},{}],235:[function(_dereq_,module,exports){
/*
WildEmitter.js is a slim little event emitter by @henrikjoreteg largely based 
on @visionmedia's Emitter from UI Kit.

Why? I wanted it standalone.

I also wanted support for wildcard emitters like this:

emitter.on('*', function (eventName, other, event, payloads) {
    
});

emitter.on('somenamespace*', function (eventName, payloads) {
    
});

Please note that callbacks triggered by wildcard registered events also get 
the event name as the first argument.
*/
module.exports = WildEmitter;

function WildEmitter() {
    this.callbacks = {};
}

// Listen on the given `event` with `fn`. Store a group name if present.
WildEmitter.prototype.on = function (event, groupName, fn) {
    var hasGroup = (arguments.length === 3),
        group = hasGroup ? arguments[1] : undefined,
        func = hasGroup ? arguments[2] : arguments[1];
    func._groupName = group;
    (this.callbacks[event] = this.callbacks[event] || []).push(func);
    return this;
};

// Adds an `event` listener that will be invoked a single
// time then automatically removed.
WildEmitter.prototype.once = function (event, groupName, fn) {
    var self = this,
        hasGroup = (arguments.length === 3),
        group = hasGroup ? arguments[1] : undefined,
        func = hasGroup ? arguments[2] : arguments[1];
    function on() {
        self.off(event, on);
        func.apply(this, arguments);
    }
    this.on(event, group, on);
    return this;
};

// Unbinds an entire group
WildEmitter.prototype.releaseGroup = function (groupName) {
    var item, i, len, handlers;
    for (item in this.callbacks) {
        handlers = this.callbacks[item];
        for (i = 0, len = handlers.length; i < len; i++) {
            if (handlers[i]._groupName === groupName) {
                //console.log('removing');
                // remove it and shorten the array we're looping through
                handlers.splice(i, 1);
                i--;
                len--;
            }
        }
    }
    return this;
};

// Remove the given callback for `event` or all
// registered callbacks.
WildEmitter.prototype.off = function (event, fn) {
    var callbacks = this.callbacks[event],
        i;

    if (!callbacks) return this;

    // remove all handlers
    if (arguments.length === 1) {
        delete this.callbacks[event];
        return this;
    }

    // remove specific handler
    i = callbacks.indexOf(fn);
    callbacks.splice(i, 1);
    return this;
};

/// Emit `event` with the given args.
// also calls any `*` handlers
WildEmitter.prototype.emit = function (event) {
    var args = [].slice.call(arguments, 1),
        callbacks = this.callbacks[event],
        specialCallbacks = this.getWildcardCallbacks(event),
        i,
        len,
        item,
        listeners;

    if (callbacks) {
        listeners = callbacks.slice();
        for (i = 0, len = listeners.length; i < len; ++i) {
            if (listeners[i]) {
                listeners[i].apply(this, args);
            } else {
                break;
            }
        }
    }

    if (specialCallbacks) {
        len = specialCallbacks.length;
        listeners = specialCallbacks.slice();
        for (i = 0, len = listeners.length; i < len; ++i) {
            if (listeners[i]) {
                listeners[i].apply(this, [event].concat(args));
            } else {
                break;
            }
        }
    }

    return this;
};

// Helper for for finding special wildcard event handlers that match the event
WildEmitter.prototype.getWildcardCallbacks = function (eventName) {
    var item,
        split,
        result = [];

    for (item in this.callbacks) {
        split = item.split('*');
        if (item === '*' || (split.length === 2 && eventName.slice(0, split[0].length) === split[0])) {
            result = result.concat(this.callbacks[item]);
        }
    }
    return result;
};

},{}],236:[function(_dereq_,module,exports){
'use strict';

var StringPrep = _dereq_('./lib/stringprep');


function bareJID(local, domain) {
    if (local) {
        return local + '@' + domain;
    }
    return domain;
}

function fullJID(local, domain, resource) {
    if (resource) {
        return bareJID(local, domain) + '/' + resource;
    }
    return bareJID(local, domain);
}


exports.prep = function (data) {
    var local = data.local;
    var domain = data.domain;
    var resource = data.resource;
    var unescapedLocal = local;

    if (local) {
        local = StringPrep.nodeprep(local);
        unescapedLocal = exports.unescape(local);
    }

    if (resource) {
        resource = StringPrep.resourceprep(resource);
    }

    if (domain[domain.length - 1] === '.') {
        domain = domain.slice(0, domain.length - 1);
    }

    domain = StringPrep.nameprep(domain.split('.').map(StringPrep.toUnicode).join('.'));

    return {
        prepped: data.prepped || StringPrep.available,
        local: local,
        domain: domain,
        resource: resource,
        bare: bareJID(local, domain),
        full: fullJID(local, domain, resource),
        unescapedLocal: unescapedLocal,
        unescapedBare: bareJID(unescapedLocal, domain),
        unescapedFull: fullJID(unescapedLocal, domain, resource)
    };
};

exports.parse = function (jid, trusted) {
    var local = '';
    var domain = '';
    var resource = '';

    // All of our StringPrep fallbacks work correctly
    // in the ASCII range, so we can reliably mark
    // ASCII-only JIDs as prepped.
    trusted = /^[\x00-\x7F]*$/.test(jid);

    var resourceStart = jid.indexOf('/');
    if (resourceStart > 0) {
        resource = jid.slice(resourceStart + 1);
        jid = jid.slice(0, resourceStart);
    }

    var localEnd = jid.indexOf('@');
    if (localEnd > 0) {
        local = jid.slice(0, localEnd);
        jid = jid.slice(localEnd + 1);
    }

    domain = jid;

    var preppedJID = exports.prep({
        local: local,
        domain: domain,
        resource: resource,
    });

    preppedJID.prepped = preppedJID.prepped || trusted;

    return preppedJID;
};

exports.equal = function (jid1, jid2, requirePrep) {
    jid1 = new exports.JID(jid1);
    jid2 = new exports.JID(jid2);
    if (arguments.length === 2) {
        requirePrep = true;
    }
    return jid1.local === jid2.local &&
           jid1.domain === jid2.domain &&
           jid1.resource === jid2.resource &&
           (requirePrep ? jid1.prepped && jid2.prepped : true);
};

exports.equalBare = function (jid1, jid2, requirePrep) {
    jid1 = new exports.JID(jid1);
    jid2 = new exports.JID(jid2);
    if (arguments.length === 2) {
        requirePrep = true;
    }
    return jid1.local === jid2.local &&
           jid1.domain === jid2.domain &&
           (requirePrep ? jid1.prepped && jid2.prepped : true);
};

exports.escape = function (val) {
    return val.replace(/^\s+|\s+$/g, '')
              .replace(/\\5c/g, '\\5c5c')
              .replace(/\\20/g, '\\5c20')
              .replace(/\\22/g, '\\5c22')
              .replace(/\\26/g, '\\5c26')
              .replace(/\\27/g, '\\5c27')
              .replace(/\\2f/g, '\\5c2f')
              .replace(/\\3a/g, '\\5c3a')
              .replace(/\\3c/g, '\\5c3c')
              .replace(/\\3e/g, '\\5c3e')
              .replace(/\\40/g, '\\5c40')
              .replace(/ /g, '\\20')
              .replace(/\"/g, '\\22')
              .replace(/\&/g, '\\26')
              .replace(/\'/g, '\\27')
              .replace(/\//g, '\\2f')
              .replace(/:/g, '\\3a')
              .replace(/</g, '\\3c')
              .replace(/>/g, '\\3e')
              .replace(/@/g, '\\40');
};

exports.unescape = function (val) {
    return val.replace(/\\20/g, ' ')
              .replace(/\\22/g, '"')
              .replace(/\\26/g, '&')
              .replace(/\\27/g, '\'')
              .replace(/\\2f/g, '/')
              .replace(/\\3a/g, ':')
              .replace(/\\3c/g, '<')
              .replace(/\\3e/g, '>')
              .replace(/\\40/g, '@')
              .replace(/\\5c/g, '\\');
};


exports.create = function (local, domain, resource) {
    return new exports.JID(local, domain, resource);
};

exports.JID = function JID(localOrJID, domain, resource) {
    var parsed = {};
    if (localOrJID && !domain && !resource) {
        if (typeof localOrJID === 'string') {
            parsed = exports.parse(localOrJID);
        } else if (localOrJID instanceof exports.JID) {
            parsed = localOrJID;
        } else {
            throw new Error('Invalid argument type');
        }
    } else if (domain) {
        parsed = exports.prep({
            local: exports.escape(localOrJID),
            domain: domain,
            resource: resource
        });
    } else {
        parsed = {};
    }

    this.local = parsed.local || '';
    this.domain = parsed.domain || '';
    this.resource = parsed.resource || '';
    this.bare = parsed.bare || '';
    this.full = parsed.full || '';

    this.unescapedLocal = parsed.unescapedLocal || '';
    this.unescapedBare = parsed.unescapedBare || '';
    this.unescapedFull = parsed.unescapedFull || '';

    this.prepped = parsed.prepped;
};

exports.JID.prototype.toString = function () {
    return this.full;
};

exports.JID.prototype.toJSON = function () {
    return this.full;
};

},{"./lib/stringprep":237}],237:[function(_dereq_,module,exports){
'use strict';

var punycode = _dereq_('punycode');


exports.available = false;

exports.toUnicode = punycode.toUnicode;

exports.nameprep = function (str) {
    return str.toLowerCase();
};

exports.nodeprep = function (str) {
    return str.toLowerCase();
};

exports.resourceprep = function (str) {
    return str;
};

},{"punycode":167}]},{},[1])
(1)
});