define(['app/client', 'jquery'], function (client, $) {
    "use strict";


    var handleMsg = function (msg) {
        var $msg = $(msg);
        var from = $msg.attr('from');
        var body = $msg.find('body').html();
        if (body) {
            $('.chat').append(Strophe.getNodeFromJid(from) + ": " + body + "<br />");
        }
        return true;
    };

    var handleInput = function () {
        var $textarea = $(this).parent().find('textarea');
        console.log($textarea);
        client.send($msg({
            from: 'markus@markuss-macbook-pro.local/test',
            to: 'admin@markuss-macbook-pro.local/Markuss-MacBook-Pro',
            type: 'chat',
            id: 'mySMS' + new Date().getTime()
        })
            .c('body').t($textarea.val()));
        $textarea.val("");
    };

    client.addHandler(handleMsg, null, 'message', 'chat');

    $('.msg-input button').on('click', handleInput)
});