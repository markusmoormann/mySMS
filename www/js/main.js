require.config({
    paths: {
        jquery: 'lib/jquery.min',
        bootstrap: 'lib/bootstrap.min',
        strophe: 'lib/strophe.min',
        cryptico: 'lib/cryptico',
        xep_0030: 'plugins/xep_0030',
        xep_0085: 'plugins/xep_0085',
        xep_0092: 'plugins/xep_0092',
        chatHandler: 'plugins/chatHandler',
        rosterHandler: 'plugins/rosterHandler'
    }
});

require([
    'app/app',
    'app/client',
    'jquery',
    'xep_0030',
    'xep_0085',
    'xep_0092',
    'chatHandler',
    'rosterHandler'
], function (app, client, $) {
    app.initialize();
    client.initialize("http://mysms.local/http-bind/");
    client.on('connfail', function(evt) {

        alert("connfail");
    });
    client.on('error', function(evt) {
        alert("error");
    });

    $('.btn').click(function () {
        client.on('connected', function () {
            $('.login').hide();
            $('.chat').show();
            client.sendPresence();
            client.getRoster();
        });
        client.connect($('#username').val() + '@markuss-macbook-pro.local/test', $('#password').val());
    });

});