function XmppClient(url) {
    this.url = url;
    this.connection = new Strophe.Connection(url);
}

XmppClient.prototype.disconnect = function () {
    this.connection.disconnect();
    this.connection = null;
};

XmppClient.prototype.connect = function (jid, password) {
    var client = this;
    this.connection.connect(jid, password, function (status) {
        switch (status) {
            case Strophe.Status.ATTACHED:
                $(client).trigger('attached');
                break;
            case Strophe.Status.AUTHENTICATING:
                $(client).trigger('authenticating');
                break;
            case Strophe.Status.AUTHFAIL:
                $(client).trigger('authfail');
                break;
            case Strophe.Status.CONNECTED:
                $(client).trigger('connected');
                break;
            case Strophe.Status.CONNECTING:
                $(client).trigger('connecting');
                break;
            case Strophe.Status.CONNFAIL:
                $(client).trigger('connfail');
                break;
            case Strophe.Status.DISCONNECTED:
                client.connection = null;
                $(client).trigger('disconnected');
                break;
            case Strophe.Status.DISCONNECTING:
                $(client).trigger('disconnecting');
                break;
            case Strophe.Status.ERROR:
                $(client).trigger('error');
                break;
        }
    });
};

XmppClient.prototype.send = function (data) {
    this.connection.send(data);
};

XmppClient.prototype.on = function (eventname, listener) {
    $(this).bind(eventname, listener);
};

XmppClient.prototype.addHandler = function (handler, ns, name, type, id, from, options) {
    this.connection.addHandler(handler, ns, name, type, id, from, options)
};

XmppClient.prototype.deleteHandler = function (ref) {
    this.connection.deleteHandler(ref);
};

XmppClient.prototype.sendPresence = function () {
    this.send($pres());
};