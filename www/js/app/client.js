define(['jquery', 'strophe'], function ($, strophe) {
    "use strict";

    var url = "http://mysms.local/http-bind/";
    var connection = new Strophe.Connection(url);

    var connect = function (jid, password) {

        connection.connect(jid, password, function (status) {
            switch (status) {
                case Strophe.Status.ATTACHED:
                    $(connection).trigger('attached');
                    break;
                case Strophe.Status.AUTHENTICATING:
                    $(connection).trigger('authenticating');
                    break;
                case Strophe.Status.AUTHFAIL:
                    $(connection).trigger('authfail');
                    break;
                case Strophe.Status.CONNECTED:
                    $(connection).trigger('connected');
                    break;
                case Strophe.Status.CONNECTING:
                    $(connection).trigger('connecting');
                    break;
                case Strophe.Status.CONNFAIL:
                    $(connection).trigger('connfail');
                    break;
                case Strophe.Status.DISCONNECTED:
                    connection = null;
                    $(connection).trigger('disconnected');
                    break;
                case Strophe.Status.DISCONNECTING:
                    $(connection).trigger('disconnecting');
                    break;
                case Strophe.Status.ERROR:
                    $(connection).trigger('error');
                    break;
            }
        });
    };

    var addHandler = function (handler, ns, name, type, id, from, options) {
        connection.addHandler(handler, ns, name, type, id, from, options)
    };

    var deleteHandler = function (ref) {
        connection.deleteHandler(ref);
    };

    var sendPresence = function () {
        send($pres().c('show').t('chat'));
    };

    var send = function (data) {
        connection.send(data);
    };

    var on = function (eventname, listener) {
        $(connection).bind(eventname, listener);
    };

    var getRoster = function () {
        this.send($iq({type: 'get'}).c('query', {xmlns: Strophe.NS.ROSTER}));
    };

    var initialize = function (newUrl) {
        url = newUrl;
    };

    return {
        connect: connect,
        initialize: initialize,
        addHandler: addHandler,
        deleteHandler: deleteHandler,
        on: on,
        send: send,
        sendPresence: sendPresence,
        getRoster: getRoster,
        jid: connection.jid
    }
});