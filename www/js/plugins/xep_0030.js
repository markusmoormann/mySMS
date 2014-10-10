define(['app/client'], function (client) {
    "use strict";

    var NS = 'http://jabber.org/protocol/disco#info';

    var handleChatState = function (data) {
        var $data = $(data);
        console.log(data);
        return true;
    };

    var handler = client.addHandler(handleChatState, NS, 'iq', 'chat');

    return {
        NS: NS
    }
});