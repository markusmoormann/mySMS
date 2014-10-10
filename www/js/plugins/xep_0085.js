define(['app/client'], function (client) {
    "use strict";

    var NS = 'http://jabber.org/protocol/chatstates';

    var handleChatState = function (data) {
        var $data = $(data);
        var chatStateElement = $data.find('[xmlns="' + NS + '"]');
        var chatstate = chatStateElement.prop('tagName');
        console.log(chatstate);
        return true;
    };

    var handler = client.addHandler(handleChatState, NS, 'message', 'chat');

    return {
        NS: NS
    }
});