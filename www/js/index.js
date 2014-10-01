var app = {
    // Application Constructor
    initialize: function () {
        document.addEventListener('deviceready', this.onDeviceReady, false);
    },

    onDeviceReady: function () {
        var client = XMPP.createClient({
            jid: 'admin@markuss-macbook-pro.local',
            password: 'admin',
            boshURL: 'http://mysms.local/http-bind/',
            transports: ['bosh'],
            softwareVersion: {
                name: 'mySMS',
                version: '0.0.1',
                os: 'iOS'
            },
            lang: 'de'
        });

        client.on('connected', function () {
            console.log("connected");
        });

        client.on('session:started', function () {
            debugger;
            client.getRoster();
            client.sendPresence();
        });

        client.on('session:error', function (a) {
            console.log("error in session");
            console.log(a);
            client.disconnect();
        });
//
//        client.on('chat', function (msg) {
//            client.sendMessage({
//                to: msg.from,
//                body: 'You sent: ' + msg.body
//            });
//        });

        client.connect();
    }
};

app.initialize();

app.onDeviceReady();

