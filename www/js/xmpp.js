//var Hello = {
//    connection: null,
//    start_time: null,
//    log: function (msg) {
//        console.log(msg);
//    },
//    send_ping: function (to) {
//        var ping = $iq({
//            to: to,
//            type: "get",
//            id: "ping1"}).c("ping", {xmlns: "urn:xmpp:ping"});
//        Hello.log("Sending ping to " + to + ".");
//        Hello.start_time = (new Date()).getTime();
//        Hello.connection.send(ping);
//    },
//    handle_pong: function (iq) {
//        var elapsed = (new Date()).getTime() - Hello.start_time;
//        Hello.log("Received pong from server in " + elapsed + "ms.");
//        Hello.connection.disconnect();
//        return false;
//    }
//};
//$(document).ready(function () {
//    $(document).trigger('connect', {
//        jid: "admin@markuss-macbook-pro.local",
//        password: "admin"
//    });
//
//});
//$(document).bind('connect', function (ev, data) {
//    var conn = new Strophe.Connection("/http-bind/");
//    conn.connect(data.jid, data.password, function (status) {
//        if (status === Strophe.Status.CONNECTED) {
//            $(document).trigger('connected');
//        } else if (status === Strophe.Status.DISCONNECTED) {
//            $(document).trigger('disconnected');
//        }
//    });
//    Hello.connection = conn;
//});
//$(document).bind('connected', function () {
//// inform the user
//    Hello.log("Connection established.");
//    Hello.connection.addHandler(Hello.handle_pong, null, "iq", null, "ping1");
//    var domain = Strophe.getDomainFromJid(Hello.connection.jid);
//    Hello.send_ping(domain);
//});
//$(document).bind('disconnected', function () {
//    Hello.log("Connection terminated.");
//// remove dead connection object
//    Hello.connection = null;
//});