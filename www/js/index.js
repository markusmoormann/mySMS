var app = {
    client: null,
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
    onDeviceReady: function () {
        var that = this;
        this.client.on('connected', function () {
            that.client.sendPresence();
            that.client.addHandler(app.handleMsg, null, 'message', 'chat');
            that.client.addHandler(XEP_0085.handleChatState, XEP_0085.NS, 'message', 'chat');
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
