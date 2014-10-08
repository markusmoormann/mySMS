var app = {
    client: null,
    db: null,
    initialize: function () {
        this.client = new XmppClient('http://mysms.local/http-bind/');
        document.addEventListener('deviceready', this.onDeviceReady, false);
    },
    handleMsg: function (data) {
        var $data = $(data);
        var from = $data.attr('from');
        var msg = $data.find('body').html();
        if (msg) {
            console.log(Strophe.getNodeFromJid(from) + ": " + msg);
            $('.chat').append(Strophe.getNodeFromJid(from) + ": " + msg + "<br />");
        }
        return true;
    },
    handleRoster: function (data) {
        var $data = $(data);
        if ($data.attr('type') == 'result') {
            $data.find('query > item').each(function(key, value) {
                var $value = $(value);
            })
        } else {
            console.log("type is not result");
        }
        return true;
    },
    onDeviceReady: function () {
        var that = this;
        this.client.on('connected', function () {
            that.client.addHandler(app.handleMsg, null, 'message', 'chat');
            that.client.addHandler(app.handleRoster, Strophe.NS.ROSTER, 'iq');
            that.client.addHandler(XEP_0085.handleChatState, XEP_0085.NS, 'message', 'chat');
            that.client.getRoster();
            that.client.sendPresence();
        });

    }
};

app.initialize();
app.onDeviceReady();

$(function () {
    $('.btn').click(function () {
        app.client.on('connected', function () {
            $('.login').hide();
            $('.chat').show();
        });
        app.client.connect($('#username').val() + '@markuss-macbook-pro.local/test', $('#password').val());
    });
});
